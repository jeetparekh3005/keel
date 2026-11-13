package io.keel.core.adapters.outbound.rpc;

import java.io.StringWriter;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.util.io.pem.PemObject;
import org.bouncycastle.util.io.pem.PemWriter;

/**
 * Generates a throwaway PKI in-process for the mTLS tests. Nothing is written to disk or committed,
 * matching the runtime cert-generation the other verticals use (Go/Rust rcgen, TS node-forge,
 * Python self-signed at test time) so no key material ever lands in the repo.
 */
public final class TestPki {

  /** A PEM certificate + its PEM PKCS#8 private key, both as UTF-8 bytes. */
  public record Pem(byte[] cert, byte[] key) {
    public String certString() {
      return new String(cert, StandardCharsets.UTF_8);
    }

    public String keyString() {
      return new String(key, StandardCharsets.UTF_8);
    }
  }

  public final byte[] caCertPem;
  public final Pem server; // CA-signed, SAN localhost + 127.0.0.1
  public final Pem client; // CA-signed (trusted)
  public final Pem untrustedClient; // signed by a DIFFERENT CA (rejected at the TLS layer)

  private TestPki(byte[] caCertPem, Pem server, Pem client, Pem untrustedClient) {
    this.caCertPem = caCertPem;
    this.server = server;
    this.client = client;
    this.untrustedClient = untrustedClient;
  }

  public static TestPki generate() {
    try {
      KeyPair caKp = rsa();
      X509Certificate caCert =
          cert(
              caKp.getPublic(),
              caKp.getPrivate(),
              "CN=keel-test-ca",
              "CN=keel-test-ca",
              true,
              null);

      KeyPair serverKp = rsa();
      X509Certificate serverCert =
          cert(
              serverKp.getPublic(),
              caKp.getPrivate(),
              "CN=localhost",
              "CN=keel-test-ca",
              false,
              new GeneralNames(
                  new GeneralName[] {
                    new GeneralName(GeneralName.dNSName, "localhost"),
                    new GeneralName(GeneralName.iPAddress, "127.0.0.1")
                  }));

      KeyPair clientKp = rsa();
      X509Certificate clientCert =
          cert(
              clientKp.getPublic(),
              caKp.getPrivate(),
              "CN=keel-test-client",
              "CN=keel-test-ca",
              false,
              null);

      KeyPair uCaKp = rsa();
      X509Certificate uCaCert =
          cert(
              uCaKp.getPublic(),
              uCaKp.getPrivate(),
              "CN=keel-untrusted-ca",
              "CN=keel-untrusted-ca",
              true,
              null);
      KeyPair uClientKp = rsa();
      X509Certificate uClientCert =
          cert(
              uClientKp.getPublic(),
              uCaKp.getPrivate(),
              "CN=keel-untrusted-client",
              "CN=keel-untrusted-ca",
              false,
              null);

      return new TestPki(
          pem("CERTIFICATE", caCert.getEncoded()),
          new Pem(
              pem("CERTIFICATE", serverCert.getEncoded()),
              pem("PRIVATE KEY", serverKp.getPrivate().getEncoded())),
          new Pem(
              pem("CERTIFICATE", clientCert.getEncoded()),
              pem("PRIVATE KEY", clientKp.getPrivate().getEncoded())),
          new Pem(
              pem("CERTIFICATE", uClientCert.getEncoded()),
              pem("PRIVATE KEY", uClientKp.getPrivate().getEncoded())));
    } catch (Exception e) {
      throw new IllegalStateException("failed to generate test PKI", e);
    }
  }

  private static KeyPair rsa() throws Exception {
    KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
    g.initialize(2048);
    return g.generateKeyPair();
  }

  private static X509Certificate cert(
      PublicKey subjectKey,
      PrivateKey issuerKey,
      String subjectDn,
      String issuerDn,
      boolean ca,
      GeneralNames sans)
      throws Exception {
    Instant now = Instant.now();
    JcaX509v3CertificateBuilder b =
        new JcaX509v3CertificateBuilder(
            new X500Name(issuerDn),
            BigInteger.valueOf(System.nanoTime()),
            Date.from(now.minus(1, ChronoUnit.HOURS)),
            Date.from(now.plus(1, ChronoUnit.DAYS)),
            new X500Name(subjectDn),
            subjectKey);
    b.addExtension(Extension.basicConstraints, true, new BasicConstraints(ca));
    if (sans != null) {
      b.addExtension(Extension.subjectAlternativeName, false, sans);
    }
    ContentSigner signer = new JcaContentSignerBuilder("SHA256withRSA").build(issuerKey);
    X509CertificateHolder holder = b.build(signer);
    return new JcaX509CertificateConverter().getCertificate(holder);
  }

  private static byte[] pem(String type, byte[] der) throws Exception {
    StringWriter sw = new StringWriter();
    try (PemWriter w = new PemWriter(sw)) {
      w.writeObject(new PemObject(type, der));
    }
    return sw.toString().getBytes(StandardCharsets.UTF_8);
  }
}
