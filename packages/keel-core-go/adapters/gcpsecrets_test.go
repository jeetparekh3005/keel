package adapters

// Unit tests for the GCP Secret Manager SecretProvider adapter (ADR-0024), driven through a
// stub secretManagerAPI so there is no network and no ADC/metadata-server lookup. They cover the
// field-map round-trip and coercion, not-found-as-empty, the fail-closed cases (nil payload,
// non-object and binary payloads), the no-leak invariant (a failed load/refresh surfaces neither
// the secret value nor the raw decoder error), the bounded-call timeout, resource-name building,
// and Close releasing the gRPC client.

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
	gax "github.com/googleapis/gax-go/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// stubSecretManager is a secretManagerAPI whose behavior each test sets via access.
type stubSecretManager struct {
	access func(ctx context.Context, req *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error)
	closed atomic.Bool
}

func (s *stubSecretManager) AccessSecretVersion(ctx context.Context, req *secretmanagerpb.AccessSecretVersionRequest, _ ...gax.CallOption) (*secretmanagerpb.AccessSecretVersionResponse, error) {
	return s.access(ctx, req)
}

func (s *stubSecretManager) Close() error {
	s.closed.Store(true)
	return nil
}

// payloadResponse returns an AccessSecretVersion response carrying body as the payload data.
func payloadResponse(body string) *secretmanagerpb.AccessSecretVersionResponse {
	return &secretmanagerpb.AccessSecretVersionResponse{
		Payload: &secretmanagerpb.SecretPayload{Data: []byte(body)},
	}
}

const testGCPResource = "projects/keel/secrets/app/versions/latest"

func TestGcpFieldMapRoundTripAndCoercion(t *testing.T) {
	clearVaultEnv(t)

	var gotName string
	stub := &stubSecretManager{access: func(_ context.Context, req *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		gotName = req.GetName()
		// A string round-trips exactly, a number keeps its JSON text, booleans become
		// "true"/"false"; object/array/null are non-scalar and must be absent (ADR-0023).
		return payloadResponse(`{
			"api_key": "abc123",
			"db_password": "p@ss",
			"replicas": 3,
			"ratio": 1.5,
			"enabled": true,
			"disabled": false,
			"obj": {"nested": 1},
			"arr": [1, 2, 3],
			"empty": null
		}`), nil
	}}

	p, err := newGcpSecretManagerProvider(context.Background(), stub, testGCPResource, time.Second, time.Hour)
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	if gotName != testGCPResource {
		t.Errorf("AccessSecretVersion Name = %q; want %q", gotName, testGCPResource)
	}
	for _, tc := range []struct{ key, want string }{
		{"api_key", "abc123"},
		{"db_password", "p@ss"},
		{"replicas", "3"},
		{"ratio", "1.5"},
		{"enabled", "true"},
		{"disabled", "false"},
	} {
		if v, ok := p.Get(tc.key); !ok || v != tc.want {
			t.Errorf("Get(%s) = %q,%v; want %q,true", tc.key, v, ok, tc.want)
		}
	}
	for _, key := range []string{"obj", "arr", "empty", "absent"} {
		if v, ok := p.Get(key); ok {
			t.Errorf("Get(%s) = %q,%v; want absent (ok=false)", key, v, ok)
		}
	}
}

func TestGcpNotFoundIsEmptyNotError(t *testing.T) {
	clearVaultEnv(t)

	stub := &stubSecretManager{access: func(context.Context, *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		// Mirrors Vault's 404-as-empty: a missing secret is "every field absent", not an error.
		return nil, status.Error(codes.NotFound, "Secret Version [projects/keel/secrets/app/versions/latest] not found")
	}}

	p, err := newGcpSecretManagerProvider(context.Background(), stub, testGCPResource, time.Second, time.Hour)
	if err != nil {
		t.Fatalf("NOT_FOUND must construct (empty field map), got error: %v", err)
	}
	defer func() { _ = p.Close() }()

	if _, ok := p.Get("api_key"); ok {
		t.Error("every field must be absent when the secret is not found")
	}
}

func TestGcpNilPayloadFailsClosed(t *testing.T) {
	clearVaultEnv(t)

	stub := &stubSecretManager{access: func(context.Context, *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		// A response with no payload cannot back Get(name): fail loudly, do not fall through.
		return &secretmanagerpb.AccessSecretVersionResponse{}, nil
	}}

	if _, err := newGcpSecretManagerProvider(context.Background(), stub, testGCPResource, time.Second, time.Hour); err == nil {
		t.Error("a response with no payload must fail construction, not fall through to empty")
	}
}

func TestGcpNonObjectPayloadFailsClosed(t *testing.T) {
	clearVaultEnv(t)

	for name, body := range map[string]string{
		"bare string":  `"just-a-string"`,
		"array":        `["a", "b"]`,
		"number":       `42`,
		"null":         `null`,
		"malformed":    `{not json`,
		"binary bytes": "\x00\x01\x02\xff",
	} {
		t.Run(name, func(t *testing.T) {
			stub := &stubSecretManager{access: func(context.Context, *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
				return payloadResponse(body), nil
			}}
			if _, err := newGcpSecretManagerProvider(context.Background(), stub, testGCPResource, time.Second, time.Hour); err == nil {
				t.Errorf("a non-object payload (%s) must fail construction", name)
			}
		})
	}
}

func TestGcpRefreshFailureServesLastGoodWithoutLeaking(t *testing.T) {
	clearVaultEnv(t)

	const (
		secretValue = "sekret-value-must-not-be-logged"
		resource    = "projects/keel-prod/secrets/app-must-not-leak-a-value/versions/latest"
	)

	var fail atomic.Bool
	stub := &stubSecretManager{access: func(context.Context, *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		if fail.Load() {
			// A refresh-time failure that does NOT carry the secret value, as a real transport or
			// permission error would not. The no-leak invariant is that neither the cached value
			// nor a credential reaches the log.
			return nil, status.Error(codes.Unavailable, "service unavailable")
		}
		return payloadResponse(`{"api_key": "` + secretValue + `"}`), nil
	}}

	p, err := newGcpSecretManagerProvider(context.Background(), stub, resource, time.Second, time.Second)
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	// Capture slog only after a clean construction, so the buffer holds the refresh-failure
	// warning. It is read after Close, when the refresh goroutine has exited (no data race).
	var buf bytes.Buffer
	prev := slog.Default()
	defer slog.SetDefault(prev)
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	fail.Store(true)
	time.Sleep(1500 * time.Millisecond)
	_ = p.Close()

	logged := buf.String()
	if !strings.Contains(logged, "refresh failed") {
		t.Fatalf("expected a refresh-failure warning in the logs; got %q", logged)
	}
	if strings.Contains(logged, secretValue) {
		t.Errorf("the cached secret value leaked into the logs: %q", logged)
	}
	// The cache must still serve the last good value after the failed refresh.
	if v, ok := p.Get("api_key"); !ok || v != secretValue {
		t.Errorf("Get(api_key) = %q,%v after a failed refresh; want the last good value", v, ok)
	}
}

func TestGcpMissingSecretFailsConstruction(t *testing.T) {
	clearVaultEnv(t) // KEEL_GCP_SECRET blank
	if _, err := NewGcpSecretManagerSecretProvider(context.Background()); err == nil {
		t.Error("KEEL_GCP_SECRET unset must fail construction")
	}
}

// TestGcpMalformedPayloadDoesNotLeakOnConstruct feeds a payload that is not valid JSON but embeds
// a secret canary. Construction must fail closed, and the returned error must carry neither the
// canary nor the raw decoder error (the "decode JSON object" chain), since a construction error
// can surface in a startup log (ADR-0024 no-leak contract).
func TestGcpMalformedPayloadDoesNotLeakOnConstruct(t *testing.T) {
	clearVaultEnv(t)

	const canary = "sekret-canary-must-not-leak-98765"
	// Starts with '{' so it clears the object guard and reaches the JSON decoder, then breaks
	// mid-value so the decoder fails with the canary still in the payload.
	stub := &stubSecretManager{access: func(context.Context, *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		return payloadResponse(`{"api_key": "` + canary + `" BROKEN`), nil
	}}

	_, err := newGcpSecretManagerProvider(context.Background(), stub, "projects/keel-prod/secrets/app/versions/latest", time.Second, time.Hour)
	if err == nil {
		t.Fatal("a malformed payload must fail construction")
	}
	msg := err.Error()
	if strings.Contains(msg, canary) {
		t.Errorf("construction error leaked the secret payload: %q", msg)
	}
	if strings.Contains(msg, "decode JSON object") {
		t.Errorf("construction error leaked the raw JSON decoder error: %q", msg)
	}
}

// TestGcpMalformedRefreshDoesNotLeak constructs cleanly, then flips the backend to a malformed
// payload carrying a canary. The refresh-failure warning must mention the failure but leak
// neither the canary nor the raw decoder error into the captured slog output.
func TestGcpMalformedRefreshDoesNotLeak(t *testing.T) {
	clearVaultEnv(t)

	const (
		canary   = "sekret-canary-must-not-leak-13579"
		resource = "projects/keel-prod/secrets/app-must-not-leak-a-value/versions/latest"
	)

	var fail atomic.Bool
	stub := &stubSecretManager{access: func(context.Context, *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		if fail.Load() {
			// A malformed payload (not a generic transport error) that embeds the canary: the
			// decoder must not echo it into the refresh-failure log.
			return payloadResponse(`{"api_key": "` + canary + `" BROKEN`), nil
		}
		return payloadResponse(`{"api_key": "good-value"}`), nil
	}}

	p, err := newGcpSecretManagerProvider(context.Background(), stub, resource, time.Second, time.Second)
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	defer func() { _ = p.Close() }()

	var buf bytes.Buffer
	prev := slog.Default()
	defer slog.SetDefault(prev)
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	fail.Store(true)
	time.Sleep(1500 * time.Millisecond)
	_ = p.Close()

	logged := buf.String()
	if !strings.Contains(logged, "refresh failed") {
		t.Fatalf("expected a refresh-failure warning in the logs; got %q", logged)
	}
	if strings.Contains(logged, canary) {
		t.Errorf("the malformed payload leaked into the logs: %q", logged)
	}
	if strings.Contains(logged, "decode JSON object") {
		t.Errorf("the raw JSON decoder error leaked into the logs: %q", logged)
	}
	// The cache keeps serving the last good value after the failed refresh.
	if v, ok := p.Get("api_key"); !ok || v != "good-value" {
		t.Errorf("Get(api_key) = %q,%v after a failed refresh; want the last good value", v, ok)
	}
}

// TestGcpBoundedCallTimeout proves the eager load fails fast when AccessSecretVersion hangs: the
// stub blocks until its context is cancelled, and the loader's per-call timeout must cancel it so
// construction returns promptly instead of hanging indefinitely (ADR-0024 bounded-client rule).
func TestGcpBoundedCallTimeout(t *testing.T) {
	clearVaultEnv(t)

	var sawDeadline atomic.Bool
	stub := &stubSecretManager{access: func(ctx context.Context, _ *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		// Simulate a wedged Secret Manager / degraded ADC path: block until the loader's bounded
		// context fires, then surface its error, exactly as a gRPC call bound by ctx would.
		<-ctx.Done()
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			sawDeadline.Store(true)
		}
		return nil, status.FromContextError(ctx.Err()).Err()
	}}

	const callTimeout = 150 * time.Millisecond
	start := time.Now()
	_, err := newGcpSecretManagerProvider(context.Background(), stub, testGCPResource, callTimeout, time.Hour)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("a hung AccessSecretVersion must fail the eager load, not succeed")
	}
	if !sawDeadline.Load() {
		t.Error("the call must be bounded by a deadline (context timeout), not cancelled some other way")
	}
	// The bound must fire close to callTimeout; a generous 5s ceiling still proves it did not hang.
	if elapsed > 5*time.Second {
		t.Errorf("construction took %v; the bounded call timeout must fail it fast", elapsed)
	}
}

func TestGcpCloseClosesClient(t *testing.T) {
	clearVaultEnv(t)

	stub := &stubSecretManager{access: func(context.Context, *secretmanagerpb.AccessSecretVersionRequest) (*secretmanagerpb.AccessSecretVersionResponse, error) {
		return payloadResponse(`{"api_key": "x"}`), nil
	}}

	p, err := newGcpSecretManagerProvider(context.Background(), stub, testGCPResource, time.Second, time.Hour)
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	if !stub.closed.Load() {
		t.Error("Close must close the underlying gRPC client to release its connections")
	}
	// Close is idempotent (second call must not panic).
	if err := p.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}

func TestBuildGCPResourceName(t *testing.T) {
	t.Run("appends default latest version", func(t *testing.T) {
		clearVaultEnv(t)
		if got := buildGCPResourceName("projects/p/secrets/s"); got != "projects/p/secrets/s/versions/latest" {
			t.Errorf("got %q; want .../versions/latest", got)
		}
	})
	t.Run("appends configured version", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envGCPSecretVersion, "7")
		if got := buildGCPResourceName("projects/p/secrets/s"); got != "projects/p/secrets/s/versions/7" {
			t.Errorf("got %q; want .../versions/7", got)
		}
	})
	t.Run("trims a trailing slash before appending", func(t *testing.T) {
		clearVaultEnv(t)
		if got := buildGCPResourceName("projects/p/secrets/s/"); got != "projects/p/secrets/s/versions/latest" {
			t.Errorf("got %q; want a single /versions/latest suffix", got)
		}
	})
	t.Run("a fully versioned name is used verbatim", func(t *testing.T) {
		clearVaultEnv(t)
		t.Setenv(envGCPSecretVersion, "7") // ignored: the name already pins a version
		const full = "projects/p/secrets/s/versions/3"
		if got := buildGCPResourceName(full); got != full {
			t.Errorf("got %q; want the name unchanged %q", got, full)
		}
	})
}
