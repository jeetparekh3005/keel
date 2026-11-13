// Package grpc is the gRPC server factory for the Go vertical (ADR-0022): deny-by-default
// authentication plus optional per-method scope authorization, installed by construction so
// a servicer cannot be registered unauthenticated. It mirrors the Python keel_core rpc.server
// factory: every call must carry a valid Bearer token, a method may additionally require
// scopes, and rejections use the correct gRPC status (Unauthenticated / PermissionDenied).
// The authenticated Principal is published on the context (auth.PrincipalFrom), and the OTel
// gRPC stats handler traces every call.
//
// The package is deliberately named grpc; it refers to the upstream google.golang.org/grpc
// package by its import identifier, which does not collide with the package clause.
package grpc

import (
	"context"
	"errors"
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

// bearerPrefix is matched case-insensitively per RFC 7235, so "bearer" is accepted as well
// as "Bearer".
const bearerPrefix = "bearer "

// MethodScopes maps a full gRPC method path (e.g. "/keel.reference.v1.ItemService/GetItem")
// to the scopes a caller must hold for that method. Authorization is deny-by-default: a method
// absent from the map is closed and rejected with PermissionDenied even for an authenticated
// caller. An explicit entry opts the method into the gate; an empty slice means "any
// authenticated caller may call this" (explicit open). A method that must run without
// authentication at all belongs on the exempt path (WithExemptMethods), not missing from here.
type MethodScopes map[string][]string

// serverConfig is the resolved factory configuration built from the functional options.
type serverConfig struct {
	exempt         map[string]struct{}
	requiredScopes MethodScopes
	grpcOpts       []grpc.ServerOption
}

// Option configures NewServer.
type Option func(*serverConfig)

// WithRequiredScopes sets the per-method scope map enforced after authentication.
func WithRequiredScopes(scopes MethodScopes) Option {
	return func(c *serverConfig) { c.requiredScopes = scopes }
}

// WithExemptMethods exempts full method paths from authentication (e.g. health/reflection).
// An exempt method bypasses both the token check and the scope check.
func WithExemptMethods(methods ...string) Option {
	return func(c *serverConfig) {
		for _, m := range methods {
			c.exempt[m] = struct{}{}
		}
	}
}

// WithServerOptions appends extra grpc.ServerOption values, e.g. the mTLS transport
// credentials from ServerTLS. The auth interceptors and OTel stats handler are always
// installed regardless; these options cannot remove them.
func WithServerOptions(opts ...grpc.ServerOption) Option {
	return func(c *serverConfig) { c.grpcOpts = append(c.grpcOpts, opts...) }
}

// NewServer builds a *grpc.Server whose unary and stream interceptors enforce deny-by-default
// authentication (and optional per-method authorization) by construction. authenticator is
// required and non-negotiable: because the interceptors are installed as server options, any
// service later registered on the returned server is covered, so a servicer cannot be exposed
// unauthenticated.
func NewServer(authenticator auth.Authenticator, opts ...Option) *grpc.Server {
	cfg := &serverConfig{exempt: map[string]struct{}{}}
	for _, o := range opts {
		o(cfg)
	}
	serverOpts := []grpc.ServerOption{
		grpc.ChainUnaryInterceptor(cfg.unaryInterceptor(authenticator)),
		grpc.ChainStreamInterceptor(cfg.streamInterceptor(authenticator)),
		grpc.StatsHandler(otelgrpc.NewServerHandler()),
	}
	serverOpts = append(serverOpts, cfg.grpcOpts...)
	return grpc.NewServer(serverOpts...)
}

// authorize authenticates the call and enforces the method's scopes. On success it returns a
// context carrying the Principal; on failure it returns a gRPC status error with the correct
// code. An exempt method short-circuits to the original context.
func (c *serverConfig) authorize(ctx context.Context, authenticator auth.Authenticator, fullMethod string) (context.Context, error) {
	if _, ok := c.exempt[fullMethod]; ok {
		return ctx, nil
	}
	token, ok := bearerFromContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "missing or malformed bearer token")
	}
	principal, err := authenticator.Authenticate(ctx, token)
	if err != nil {
		return nil, authError(err)
	}
	required, ok := c.requiredScopes[fullMethod]
	if !ok {
		// Deny-by-default authorization: a method absent from the scope map is closed, not
		// fail-open. An explicit entry (even an empty one) opts the method into the gate; an
		// empty entry means "any authenticated caller". A method that must run without auth
		// entirely belongs on the exempt path above, not missing from the map.
		return nil, status.Error(codes.PermissionDenied, "method not authorized")
	}
	if len(required) > 0 && !principal.HasScopes(required...) {
		return nil, status.Error(codes.PermissionDenied, "insufficient scope")
	}
	return auth.ContextWithPrincipal(ctx, principal), nil
}

// unaryInterceptor authenticates/authorizes, then invokes the handler with the principal on
// the context.
func (c *serverConfig) unaryInterceptor(authenticator auth.Authenticator) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		authed, err := c.authorize(ctx, authenticator, info.FullMethod)
		if err != nil {
			return nil, err
		}
		return handler(authed, req)
	}
}

// streamInterceptor authenticates/authorizes before the stream handler runs, wrapping the
// stream so the handler sees the principal-bearing context.
func (c *serverConfig) streamInterceptor(authenticator auth.Authenticator) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		authed, err := c.authorize(ss.Context(), authenticator, info.FullMethod)
		if err != nil {
			return err
		}
		return handler(srv, &principalStream{ServerStream: ss, ctx: authed})
	}
}

// principalStream overrides Context so the stream handler reads the authenticated principal.
type principalStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *principalStream) Context() context.Context { return s.ctx }

// bearerFromContext extracts the Bearer token from the incoming "authorization" metadata, or
// returns false when it is absent or malformed.
func bearerFromContext(ctx context.Context) (string, bool) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return "", false
	}
	for _, value := range md.Get("authorization") {
		if len(value) >= len(bearerPrefix) && strings.EqualFold(value[:len(bearerPrefix)], bearerPrefix) {
			if token := strings.TrimSpace(value[len(bearerPrefix):]); token != "" {
				return token, true
			}
		}
	}
	return "", false
}

// authError maps an Authenticator failure to the right gRPC status: a key-source outage
// (Unavailable) stays retryable; anything else is Unauthenticated. A caller that is
// authenticated but lacks scope never reaches here (that is PermissionDenied in authorize).
func authError(err error) error {
	var de *domain.DomainError
	if errors.As(err, &de) && de.Category == domain.Unavailable {
		return status.Error(codes.Unavailable, "auth dependency unavailable")
	}
	return status.Error(codes.Unauthenticated, "invalid token")
}
