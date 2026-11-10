package io.keel.core.conformance;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.time.Duration;

/**
 * The behavioral contract suite: assertions a service runs against its composed, running HTTP
 * server to prove it honors platform.yaml, so an over-claim or broken wiring fails a test rather
 * than shipping. The Java mirror of the Go conformance package and the TypeScript/Rust suites.
 * Framework-neutral: it drives the real server over the JDK HttpClient and raises AssertionError,
 * so it works under any test runner.
 */
public final class Conformance {

  private final String baseUri;
  private final HttpClient client;

  public Conformance(String baseUri) {
    this.baseUri = baseUri.endsWith("/") ? baseUri.substring(0, baseUri.length() - 1) : baseUri;
    this.client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
  }

  /** platform.yaml health: /healthz is 200 and /readyz is 200 or 503. */
  public void assertHealth() {
    HttpResponse<String> health = send("GET", "/healthz", null, null);
    expect(health.statusCode() == 200, "/healthz = " + health.statusCode() + ", want 200");
    HttpResponse<String> ready = send("GET", "/readyz", null, null);
    expect(
        ready.statusCode() == 200 || ready.statusCode() == 503,
        "/readyz = " + ready.statusCode() + ", want 200 or 503");
  }

  /** The always-on edge security headers are present, with the expected nosniff value. */
  public void assertSecurityHeaders() {
    HttpResponse<String> res = send("GET", "/healthz", null, null);
    for (String header :
        new String[] {
          "content-security-policy",
          "x-content-type-options",
          "x-frame-options",
          "referrer-policy",
          "permissions-policy"
        }) {
      expect(res.headers().firstValue(header).isPresent(), "missing security header " + header);
    }
    expect(
        "nosniff".equals(res.headers().firstValue("x-content-type-options").orElse("")),
        "x-content-type-options must be nosniff");
  }

  /** No Access-Control-Allow-Origin is returned for a cross-origin request when none configured. */
  public void assertCorsDenyByDefault() {
    HttpResponse<String> res = send("GET", "/healthz", "https://evil.example", null);
    expect(
        res.headers().firstValue("access-control-allow-origin").isEmpty(),
        "CORS must be deny-by-default");
  }

  /** A protected route rejects an unauthenticated caller with 401. */
  public void assertDeniesAnonymous(String method, String path) {
    HttpResponse<String> res = send(method, path, null, null);
    expect(
        res.statusCode() == 401,
        method + " " + path + " anonymous = " + res.statusCode() + ", want 401");
  }

  /**
   * An authenticated caller lacking the route's scope gets 403. {@code bearer} is a token the app's
   * decoder accepts but whose principal lacks the scope.
   */
  public void assertRequiresScope(String method, String path, String bearer, String body) {
    HttpRequest.Builder builder =
        HttpRequest.newBuilder(URI.create(baseUri + path))
            .header("Authorization", "Bearer " + bearer);
    if (body != null) {
      builder
          .header("Content-Type", "application/json")
          .method(method, BodyPublishers.ofString(body));
    } else {
      builder.method(method, BodyPublishers.noBody());
    }
    HttpResponse<String> res = sendRequest(builder.build());
    expect(
        res.statusCode() == 403,
        method + " " + path + " insufficient scope = " + res.statusCode() + ", want 403");
  }

  /** A response is RFC 9457 problem+json with the expected status and required members. */
  public void assertProblemResponse(HttpResponse<String> res, int status) {
    expect(res.statusCode() == status, "status = " + res.statusCode() + ", want " + status);
    String contentType = res.headers().firstValue("content-type").orElse("");
    expect(contentType.startsWith("application/problem+json"), "content-type = " + contentType);
    String body = res.body() == null ? "" : res.body();
    for (String member : new String[] {"\"type\"", "\"title\"", "\"status\""}) {
      expect(body.contains(member), "problem+json missing " + member);
    }
  }

  /** Send a request and return the response, for assertions the caller composes. */
  public HttpResponse<String> send(String method, String path, String origin, String body) {
    HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUri + path));
    if (origin != null) {
      builder.header("Origin", origin);
    }
    if (body != null) {
      builder
          .header("Content-Type", "application/json")
          .method(method, BodyPublishers.ofString(body));
    } else {
      builder.method(method, BodyPublishers.noBody());
    }
    return sendRequest(builder.build());
  }

  public HttpResponse<String> authorized(String method, String path, String bearer, String body) {
    HttpRequest.Builder builder =
        HttpRequest.newBuilder(URI.create(baseUri + path))
            .header("Authorization", "Bearer " + bearer);
    if (body != null) {
      builder
          .header("Content-Type", "application/json")
          .method(method, BodyPublishers.ofString(body));
    } else {
      builder.method(method, BodyPublishers.noBody());
    }
    return sendRequest(builder.build());
  }

  private HttpResponse<String> sendRequest(HttpRequest request) {
    try {
      return client.send(request, BodyHandlers.ofString());
    } catch (Exception e) {
      throw new AssertionError("request failed: " + e.getMessage(), e);
    }
  }

  private static void expect(boolean condition, String message) {
    if (!condition) {
      throw new AssertionError(message);
    }
  }
}
