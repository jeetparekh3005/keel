package grpc_test

import (
	"context"
	"io"
	"net"
	"testing"

	grpclib "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	referencev1 "github.com/jeetparekh3005/keel/packages/keel-core-go/genproto/keel/reference/v1"
	keelgrpc "github.com/jeetparekh3005/keel/packages/keel-core-go/grpc"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/testkit"
)

// tokens recognised by the stub authenticator: a read-only caller and a read+write caller.
const (
	readerToken = "reader-tok"
	writerToken = "writer-tok"
)

func stubAuth() auth.Authenticator {
	return testkit.StubAuthenticator{Principals: map[string]*auth.Principal{
		readerToken: testkit.Principal("reader", keelgrpc.ScopeItemsRead),
		writerToken: testkit.Principal("writer", keelgrpc.ScopeItemsRead, keelgrpc.ScopeItemsWrite),
	}}
}

// bufItemClient starts an in-process ItemService behind the deny-by-default factory with the
// given authenticator and options, returning a connected client plus a cleanup func.
func bufItemClient(t *testing.T, authenticator auth.Authenticator, opts ...keelgrpc.Option) (referencev1.ItemServiceClient, func()) {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := keelgrpc.NewServer(authenticator, opts...)
	referencev1.RegisterItemServiceServer(srv, keelgrpc.NewItemServer())

	go func() { _ = srv.Serve(lis) }()

	conn, err := grpclib.NewClient("passthrough:///bufnet",
		grpclib.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpclib.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return referencev1.NewItemServiceClient(conn), func() {
		_ = conn.Close()
		srv.Stop()
		_ = lis.Close()
	}
}

// serveItems is bufItemClient wired to the stub authenticator with the ItemService scope map,
// the common case for the auth/authZ posture tests. Extra options are threaded through.
func serveItems(t *testing.T, opts ...keelgrpc.Option) (referencev1.ItemServiceClient, func()) {
	t.Helper()
	return bufItemClient(t, stubAuth(), append([]keelgrpc.Option{
		keelgrpc.WithRequiredScopes(keelgrpc.ItemServiceScopes()),
	}, opts...)...)
}

// withToken returns a context carrying a Bearer authorization header.
func withToken(ctx context.Context, token string) context.Context {
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
}

func requireCode(t *testing.T, err error, want codes.Code) {
	t.Helper()
	if status.Code(err) != want {
		t.Fatalf("want code %v, got %v (err=%v)", want, status.Code(err), err)
	}
}

func TestGetItem_NoToken_Unauthenticated(t *testing.T) {
	client, stop := serveItems(t)
	defer stop()

	_, err := client.GetItem(context.Background(), &referencev1.GetItemRequest{Id: "nope"})
	requireCode(t, err, codes.Unauthenticated)
}

func TestCreateItem_WrongScope_PermissionDenied(t *testing.T) {
	client, stop := serveItems(t)
	defer stop()

	// The reader holds items:read but CreateItem requires items:write.
	_, err := client.CreateItem(withToken(context.Background(), readerToken),
		&referencev1.CreateItemRequest{Name: "widget"})
	requireCode(t, err, codes.PermissionDenied)
}

func TestCreateThenGet_ValidTokenAndScope_OK(t *testing.T) {
	client, stop := serveItems(t)
	defer stop()

	created, err := client.CreateItem(withToken(context.Background(), writerToken),
		&referencev1.CreateItemRequest{Name: "widget"})
	if err != nil {
		t.Fatalf("CreateItem: %v", err)
	}
	if created.GetItem().GetId() == "" || created.GetItem().GetName() != "widget" {
		t.Fatalf("unexpected created item: %+v", created.GetItem())
	}

	// A different caller holding only items:read can read it back.
	got, err := client.GetItem(withToken(context.Background(), readerToken),
		&referencev1.GetItemRequest{Id: created.GetItem().GetId()})
	if err != nil {
		t.Fatalf("GetItem: %v", err)
	}
	if got.GetItem().GetId() != created.GetItem().GetId() || got.GetItem().GetName() != "widget" {
		t.Fatalf("round-trip mismatch: got %+v", got.GetItem())
	}
}

func TestListItems_ValidReadScope_OK(t *testing.T) {
	client, stop := serveItems(t)
	defer stop()

	writeCtx := withToken(context.Background(), writerToken)
	for _, name := range []string{"a", "b", "c"} {
		if _, err := client.CreateItem(writeCtx, &referencev1.CreateItemRequest{Name: name}); err != nil {
			t.Fatalf("seed CreateItem(%q): %v", name, err)
		}
	}

	resp, err := client.ListItems(withToken(context.Background(), readerToken),
		&referencev1.ListItemsRequest{Limit: 2, Offset: 1})
	if err != nil {
		t.Fatalf("ListItems: %v", err)
	}
	if len(resp.GetItems()) != 2 {
		t.Fatalf("want 2 items on the page, got %d", len(resp.GetItems()))
	}
	// Insertion order is deterministic: offset 1, limit 2 -> b, c.
	if resp.GetItems()[0].GetName() != "b" || resp.GetItems()[1].GetName() != "c" {
		t.Fatalf("unexpected page order: %q, %q", resp.GetItems()[0].GetName(), resp.GetItems()[1].GetName())
	}
}

func TestGetItem_BadToken_Unauthenticated(t *testing.T) {
	client, stop := serveItems(t)
	defer stop()

	_, err := client.GetItem(withToken(context.Background(), "garbage"),
		&referencev1.GetItemRequest{Id: "x"})
	requireCode(t, err, codes.Unauthenticated)
}

func TestGetItem_NotFound(t *testing.T) {
	client, stop := serveItems(t)
	defer stop()

	_, err := client.GetItem(withToken(context.Background(), readerToken),
		&referencev1.GetItemRequest{Id: "missing"})
	requireCode(t, err, codes.NotFound)
}

func TestCreateItem_EmptyName_InvalidArgument(t *testing.T) {
	client, stop := serveItems(t)
	defer stop()

	_, err := client.CreateItem(withToken(context.Background(), writerToken),
		&referencev1.CreateItemRequest{Name: "   "})
	requireCode(t, err, codes.InvalidArgument)
}

// TestExemptMethod_BypassesAuth proves WithExemptMethods lets a method through without a
// token. GetItem then runs unauthenticated and returns NotFound (not Unauthenticated).
func TestExemptMethod_BypassesAuth(t *testing.T) {
	client, stop := serveItems(t,
		keelgrpc.WithExemptMethods(referencev1.ItemService_GetItem_FullMethodName))
	defer stop()

	_, err := client.GetItem(context.Background(), &referencev1.GetItemRequest{Id: "missing"})
	requireCode(t, err, codes.NotFound)
}

// --- streaming: the stream interceptor enforces the same deny-by-default posture ---

const streamMethod = "/keel.test.Echo/PingStream"

var echoStreamDesc = grpclib.ServiceDesc{
	ServiceName: "keel.test.Echo",
	HandlerType: (*any)(nil),
	Streams: []grpclib.StreamDesc{{
		StreamName:    "PingStream",
		ServerStreams: true,
		Handler: func(_ any, stream grpclib.ServerStream) error {
			// Reaching here means auth passed; the principal is on the context.
			if _, ok := auth.PrincipalFrom(stream.Context()); !ok {
				return status.Error(codes.Internal, "principal missing on stream context")
			}
			for i := 0; i < 2; i++ {
				if err := stream.SendMsg(&referencev1.Item{Id: "x", Name: "n"}); err != nil {
					return err
				}
			}
			return nil
		},
	}},
}

func serveStream(t *testing.T) (*grpclib.ClientConn, func()) {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := keelgrpc.NewServer(stubAuth())
	srv.RegisterService(&echoStreamDesc, struct{}{})
	go func() { _ = srv.Serve(lis) }()

	conn, err := grpclib.NewClient("passthrough:///bufnet",
		grpclib.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpclib.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn, func() {
		_ = conn.Close()
		srv.Stop()
		_ = lis.Close()
	}
}

func TestStream_NoToken_Unauthenticated(t *testing.T) {
	conn, stop := serveStream(t)
	defer stop()

	cs, err := conn.NewStream(context.Background(), &echoStreamDesc.Streams[0], streamMethod)
	if err != nil {
		t.Fatalf("NewStream: %v", err)
	}
	err = cs.RecvMsg(&referencev1.Item{})
	requireCode(t, err, codes.Unauthenticated)
}

func TestStream_ValidToken_StreamsMessages(t *testing.T) {
	conn, stop := serveStream(t)
	defer stop()

	cs, err := conn.NewStream(withToken(context.Background(), readerToken),
		&echoStreamDesc.Streams[0], streamMethod)
	if err != nil {
		t.Fatalf("NewStream: %v", err)
	}
	count := 0
	for {
		var item referencev1.Item
		recvErr := cs.RecvMsg(&item)
		if recvErr == io.EOF {
			break
		}
		if recvErr != nil {
			t.Fatalf("RecvMsg: %v", recvErr)
		}
		count++
	}
	if count != 2 {
		t.Fatalf("want 2 streamed messages, got %d", count)
	}
}
