package grpc_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"testing"
	"time"

	grpclib "google.golang.org/grpc"
	"google.golang.org/grpc/codes"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/auth"
	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
	referencev1 "github.com/jeetparekh3005/keel/packages/keel-core-go/genproto/keel/reference/v1"
	keelgrpc "github.com/jeetparekh3005/keel/packages/keel-core-go/grpc"
)

// certAuthority is a self-signed CA used to mint leaf certs in-test.
type certAuthority struct {
	cert    *x509.Certificate
	key     *ecdsa.PrivateKey
	certPEM []byte
}

func newCA(t *testing.T) *certAuthority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ca key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "keel-test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("ca cert: %v", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse ca: %v", err)
	}
	return &certAuthority{
		cert:    cert,
		key:     key,
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
}

// issue mints a leaf cert+key (PEM) signed by the CA. server toggles the extended key usage
// and adds a 127.0.0.1 IP SAN so loopback TLS verification succeeds against the dial authority.
func (ca *certAuthority) issue(t *testing.T, cn string, server bool) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("leaf key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	if server {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		tmpl.IPAddresses = []net.IP{net.IPv4(127, 0, 0, 1)}
		tmpl.DNSNames = []string{"localhost"}
	} else {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatalf("leaf cert: %v", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM
}

func TestServerTLS_InvalidPEM(t *testing.T) {
	if _, err := keelgrpc.ServerTLS([]byte("nope"), []byte("nope"), []byte("nope")); err == nil {
		t.Fatal("expected error for invalid server keypair")
	}
	ca := newCA(t)
	cert, key := ca.issue(t, "svc", true)
	// Valid keypair but a CA bundle with no certificates must still fail.
	if _, err := keelgrpc.ServerTLS(cert, key, []byte("not-a-cert")); err == nil {
		t.Fatal("expected error for empty client CA bundle")
	}
}

func TestClientTLS_InvalidPEM(t *testing.T) {
	if _, err := keelgrpc.ClientTLS([]byte("nope"), []byte("nope"), []byte("nope")); err == nil {
		t.Fatal("expected error for invalid client keypair")
	}
	ca := newCA(t)
	cert, key := ca.issue(t, "svc", false)
	if _, err := keelgrpc.ClientTLS(cert, key, []byte("not-a-cert")); err == nil {
		t.Fatal("expected error for empty server CA bundle")
	}
}

// serveMTLS starts the ItemService over a real loopback listener with server-side mTLS and
// returns the listener address plus a cleanup func.
func serveMTLS(t *testing.T, ca *certAuthority) (string, func()) {
	t.Helper()
	srvCert, srvKey := ca.issue(t, "reference-service", true)
	creds, err := keelgrpc.ServerTLS(srvCert, srvKey, ca.certPEM)
	if err != nil {
		t.Fatalf("ServerTLS: %v", err)
	}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := keelgrpc.NewServer(stubAuth(),
		keelgrpc.WithRequiredScopes(keelgrpc.ItemServiceScopes()),
		keelgrpc.WithServerOptions(grpclib.Creds(creds)),
	)
	referencev1.RegisterItemServiceServer(srv, keelgrpc.NewItemServer())
	go func() { _ = srv.Serve(lis) }()

	return lis.Addr().String(), func() {
		srv.Stop()
		_ = lis.Close()
	}
}

func dialMTLS(t *testing.T, addr string, clientCreds grpclib.DialOption) referencev1.ItemServiceClient {
	t.Helper()
	conn, err := grpclib.NewClient(addr, clientCreds)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return referencev1.NewItemServiceClient(conn)
}

// TestMTLS_TrustedClient_HandshakeAndCall proves a real mTLS handshake over loopback: a client
// cert signed by the server's trusted CA connects and the authenticated CreateItem succeeds.
func TestMTLS_TrustedClient_HandshakeAndCall(t *testing.T) {
	ca := newCA(t)
	addr, stop := serveMTLS(t, ca)
	defer stop()

	cliCert, cliKey := ca.issue(t, "caller", false)
	creds, err := keelgrpc.ClientTLS(cliCert, cliKey, ca.certPEM)
	if err != nil {
		t.Fatalf("ClientTLS: %v", err)
	}
	client := dialMTLS(t, addr, grpclib.WithTransportCredentials(creds))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := client.CreateItem(withToken(ctx, writerToken),
		&referencev1.CreateItemRequest{Name: "over-mtls"})
	if err != nil {
		t.Fatalf("CreateItem over mTLS: %v", err)
	}
	if resp.GetItem().GetName() != "over-mtls" {
		t.Fatalf("unexpected item: %+v", resp.GetItem())
	}
}

// TestMTLS_UntrustedClient_Rejected proves the server rejects a client whose cert is signed by
// a CA it does not trust: the handshake fails, so no RPC is served. The client still trusts the
// server's CA, isolating the failure to the client certificate.
func TestMTLS_UntrustedClient_Rejected(t *testing.T) {
	ca := newCA(t)
	addr, stop := serveMTLS(t, ca)
	defer stop()

	rogue := newCA(t)
	cliCert, cliKey := rogue.issue(t, "intruder", false)
	// Trust the real server CA (so server auth is fine) but present a cert from the rogue CA.
	creds, err := keelgrpc.ClientTLS(cliCert, cliKey, ca.certPEM)
	if err != nil {
		t.Fatalf("ClientTLS: %v", err)
	}
	client := dialMTLS(t, addr, grpclib.WithTransportCredentials(creds))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = client.GetItem(withToken(ctx, readerToken), &referencev1.GetItemRequest{Id: "x"})
	if err == nil {
		t.Fatal("expected the untrusted client to be rejected at the TLS layer")
	}
}

// unavailableAuth always reports the key source as unavailable, exercising the retryable
// branch of the auth error mapping (Unavailable, not Unauthenticated).
type unavailableAuth struct{}

func (unavailableAuth) Authenticate(context.Context, string) (*auth.Principal, error) {
	return nil, domain.New(domain.Unavailable, "jwks unreachable")
}

func TestAuth_KeySourceOutage_Unavailable(t *testing.T) {
	client, stop := bufItemClient(t, unavailableAuth{},
		keelgrpc.WithRequiredScopes(keelgrpc.ItemServiceScopes()))
	defer stop()

	_, err := client.GetItem(withToken(context.Background(), "any"),
		&referencev1.GetItemRequest{Id: "x"})
	requireCode(t, err, codes.Unavailable)
}
