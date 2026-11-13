package grpc

import (
	"crypto/tls"
	"crypto/x509"

	"google.golang.org/grpc/credentials"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

// mtlsMinVersion pins the floor to TLS 1.3 for service-to-service mTLS (ADR-0022): both
// ends are keel-operated, so there is no reason to negotiate an older protocol.
const mtlsMinVersion = tls.VersionTLS13

// ServerTLS builds server-side mTLS transport credentials from PEM bytes (leaf cert + key +
// the CA bundle that signs legitimate clients). The server presents cert/key and requires and
// verifies a client certificate chaining to rootCAPEM (tls.RequireAndVerifyClientCert), so an
// untrusted or absent client certificate fails the handshake before any RPC is dispatched.
// The PEM bytes come from config/SecretProvider (PKI material, ADR-0007). Mirrors the Python
// mtls_server_credentials.
func ServerTLS(certPEM, keyPEM, rootCAPEM []byte) (credentials.TransportCredentials, error) {
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, domain.New(domain.Internal, "mtls: invalid server keypair: "+err.Error())
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(rootCAPEM) {
		return nil, domain.New(domain.Internal, "mtls: no valid certificates in client CA bundle")
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    clientCAs,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   mtlsMinVersion,
	}), nil
}

// ClientTLS builds client-side mTLS transport credentials from PEM bytes: present cert/key and
// verify the server certificate against rootCAPEM. Pass the result to grpc.NewClient /
// grpc.DialContext via grpc.WithTransportCredentials for a mutually authenticated channel.
// Mirrors the Python mtls_channel_credentials.
func ClientTLS(certPEM, keyPEM, rootCAPEM []byte) (credentials.TransportCredentials, error) {
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, domain.New(domain.Internal, "mtls: invalid client keypair: "+err.Error())
	}
	rootCAs := x509.NewCertPool()
	if !rootCAs.AppendCertsFromPEM(rootCAPEM) {
		return nil, domain.New(domain.Internal, "mtls: no valid certificates in server CA bundle")
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      rootCAs,
		MinVersion:   mtlsMinVersion,
	}), nil
}
