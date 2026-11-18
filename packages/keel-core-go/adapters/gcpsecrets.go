package adapters

// GcpSecretManagerSecretProvider is a production SecretProvider backend (ADR-0024): it reads
// one GCP Secret Manager secret version whose payload is a JSON object of fields, and serves
// those fields through the shared caching core (secretcache.go) with the same Get semantics,
// coercion, caching, fail-closed, and no-leak behavior as the OpenBao and AWS backends. Unlike
// OpenBao it carries no token-lease logic: the GCP SDK refreshes OAuth2 credentials internally
// and resolves Application Default Credentials (env, Workload Identity, metadata server), so the
// loader just calls AccessSecretVersion each TTL.

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	secretmanager "cloud.google.com/go/secretmanager/apiv1"
	"cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
	gax "github.com/googleapis/gax-go/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/ports"
)

const (
	// Config env vars (ADR-0024 Protocol table).
	envGCPSecret        = "KEEL_GCP_SECRET"         // gates the backend; projects/<p>/secrets/<name> or the full .../versions/<v>.
	envGCPSecretVersion = "KEEL_GCP_SECRET_VERSION" // optional; else "latest".

	defaultGCPSecretVersion = "latest"

	// gcpCallTimeout bounds a single AccessSecretVersion call. Together with the retry cap set on
	// the client (NewGcpSecretManagerSecretProvider), it guarantees a wedged or unreachable Secret
	// Manager, or a degraded ADC/metadata path, fails the eager startup load fast rather than
	// hanging it (ADR-0024 bounded-client rule; the AWS lesson). The gRPC transport bounds a stuck
	// connection even when the caller's ctx carries no deadline.
	gcpCallTimeout = 10 * time.Second
)

// secretManagerAPI is the subset of the Secret Manager client the loader uses, as an interface
// so a unit test can inject a stub with no network and no ADC/metadata-server lookup (ADR-0024
// testing). Close releases the underlying gRPC connections when the provider is closed.
type secretManagerAPI interface {
	AccessSecretVersion(ctx context.Context, req *secretmanagerpb.AccessSecretVersionRequest, opts ...gax.CallOption) (*secretmanagerpb.AccessSecretVersionResponse, error)
	Close() error
}

// GcpSecretManagerSecretProvider loads one Secret Manager secret version into the embedded
// caching core, which promotes Get. Close stops the refresh goroutine and closes the gRPC
// client. The zero value is not usable; construct with NewGcpSecretManagerSecretProvider.
type GcpSecretManagerSecretProvider struct {
	*cachingSecretProvider

	client       secretManagerAPI
	resourceName string
	callTimeout  time.Duration
}

var (
	_ ports.SecretProvider = (*GcpSecretManagerSecretProvider)(nil)
	_ io.Closer            = (*GcpSecretManagerSecretProvider)(nil)
	_ secretLoader         = (*GcpSecretManagerSecretProvider)(nil)
)

// NewGcpSecretManagerSecretProvider constructs the provider from the KEEL_GCP_* environment,
// builds a Secret Manager client from Application Default Credentials, caps the SDK's retries,
// and eagerly loads the field map. It fails loudly (ADR-0024 fail-closed) when KEEL_GCP_SECRET
// is unset, when the client cannot be built, or when the first load fails (auth, permissions, a
// non-object payload). On success it starts a background refresh goroutine stopped by Close().
func NewGcpSecretManagerSecretProvider(ctx context.Context) (*GcpSecretManagerSecretProvider, error) {
	secret := strings.TrimSpace(os.Getenv(envGCPSecret))
	if secret == "" {
		return nil, fmt.Errorf("%s is not set", envGCPSecret)
	}

	ttl, err := parseCacheTTL()
	if err != nil {
		return nil, err
	}

	// Default credential chain: no keel-managed GCP credentials. NewClient with no option
	// resolves Application Default Credentials (env, Workload Identity, metadata server).
	client, err := secretmanager.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("build GCP Secret Manager client: %w", err)
	}

	// Cap the SDK's retries so a wedged or unreachable endpoint cannot stretch the bounded call
	// timeout across many backed-off attempts. An empty retry set means AccessSecretVersion makes
	// exactly one attempt; the per-call context timeout in load bounds that attempt (ADR-0024).
	client.CallOptions.AccessSecretVersion = []gax.CallOption{
		gax.WithRetry(func() gax.Retryer { return gax.OnCodes(nil, gax.Backoff{}) }),
	}

	p, err := newGcpSecretManagerProvider(ctx, client, buildGCPResourceName(secret), gcpCallTimeout, ttl)
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	return p, nil
}

// newGcpSecretManagerProvider wires a provider over an already-built client. It is the seam the
// unit tests use to inject a stub client; production goes through NewGcpSecretManagerSecretProvider.
func newGcpSecretManagerProvider(ctx context.Context, client secretManagerAPI, resourceName string, callTimeout, ttl time.Duration) (*GcpSecretManagerSecretProvider, error) {
	p := &GcpSecretManagerSecretProvider{client: client, resourceName: resourceName, callTimeout: callTimeout}
	core, err := newCachingSecretProvider(ctx, p, ttl)
	if err != nil {
		return nil, err
	}
	p.cachingSecretProvider = core
	return p, nil
}

// buildGCPResourceName resolves KEEL_GCP_SECRET to a full version resource name. A value that
// already names a version (projects/<p>/secrets/<n>/versions/<v>) is used verbatim; otherwise
// KEEL_GCP_SECRET_VERSION (default "latest") is appended (ADR-0024 GCP loader config).
func buildGCPResourceName(secret string) string {
	if strings.Contains(secret, "/versions/") {
		return secret
	}
	version := getenvDefault(envGCPSecretVersion, defaultGCPSecretVersion)
	return fmt.Sprintf("%s/versions/%s", strings.TrimRight(secret, "/"), version)
}

// name identifies the backend in refresh-failure logs (secretLoader).
func (p *GcpSecretManagerSecretProvider) name() string { return "gcp-secret-manager" }

// load calls AccessSecretVersion and parses the payload as a JSON object of fields (ADR-0024). A
// NOT_FOUND yields an empty map (every field absent, mirroring Vault's 404). An empty payload or
// a non-object payload fails loudly - a secret meant to back Get(name) must be a JSON object of
// fields. The error wraps the resource name (which is not a secret value), never the payload, so
// a refresh-failure log cannot leak it (secretcache.go). The call is bounded by callTimeout.
func (p *GcpSecretManagerSecretProvider) load(ctx context.Context) (map[string]string, error) {
	callCtx, cancel := context.WithTimeout(ctx, p.callTimeout)
	defer cancel()

	resp, err := p.client.AccessSecretVersion(callCtx, &secretmanagerpb.AccessSecretVersionRequest{
		Name: p.resourceName,
	})
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("gcp secretmanager AccessSecretVersion %s: %w", p.resourceName, err)
	}

	if resp.GetPayload() == nil {
		return nil, fmt.Errorf("gcp secret %s has no payload data; store a JSON object of fields", p.resourceName)
	}

	fields, err := coerceObjectFields(resp.GetPayload().GetData())
	if err != nil {
		// Deliberately drop the decoder error: a malformed payload can embed the secret value, and
		// encoding/json echoes payload bytes into its messages, which would reach a refresh-failure
		// log. Report only the resource name, matching the other backends' no-leak contract
		// (ADR-0024).
		return nil, fmt.Errorf("gcp secret %s is not a JSON object of fields", p.resourceName)
	}
	return fields, nil
}

// Close stops the background refresh goroutine and then closes the gRPC client, releasing its
// connections. It is safe to call more than once: the embedded core's Close is guarded by a
// sync.Once, and a second client.Close only ever returns an error that is ignored here.
func (p *GcpSecretManagerSecretProvider) Close() error {
	err := p.cachingSecretProvider.Close()
	if cerr := p.client.Close(); cerr != nil && err == nil {
		err = cerr
	}
	return err
}
