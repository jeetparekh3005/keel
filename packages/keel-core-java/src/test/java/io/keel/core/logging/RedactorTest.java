package io.keel.core.logging;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RedactorTest {

  @Test
  void matchesSecretFamiliesCaseAndSeparatorInsensitively() {
    for (String key :
        List.of("password", "API_KEY", "x-api-key", "Authorization", "client_secret", "Cookie")) {
      assertTrue(Redactor.isSecretKey(key), key);
    }
    for (String key : List.of("name", "id", "limit", "offset")) {
      assertFalse(Redactor.isSecretKey(key), key);
    }
  }

  @Test
  void scrubsJwtAwsBearerAndPem() {
    String jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX2hlcmU";
    assertEquals("token=" + Redactor.REDACTED, Redactor.scrubText("token=" + jwt));
    assertEquals(
        "key " + Redactor.REDACTED + " here", Redactor.scrubText("key AKIAIOSFODNN7EXAMPLE here"));
    assertTrue(
        Redactor.scrubText("Authorization: Bearer abcdef0123456789").contains(Redactor.REDACTED));
    // Parity with Go (\s+): a bearer token separated by more than one space still redacts.
    assertTrue(
        Redactor.scrubText("Authorization: Bearer  abcdef0123456789").contains(Redactor.REDACTED));
    assertEquals(Redactor.REDACTED, Redactor.scrubText("-----BEGIN RSA PRIVATE KEY-----"));
  }

  @Test
  void redactsLuhnValidCardsOnly() {
    assertEquals(
        "card " + Redactor.REDACTED + " end", Redactor.scrubText("card 4242 4242 4242 4242 end"));
    assertTrue(Redactor.scrubText("order 1234567890123456 ref").contains("1234567890123456"));
  }

  @Test
  void redactsNestedSecretKeysAndValues() {
    Object redacted =
        Redactor.redactValue(
            Map.of(
                "user", "alice",
                "password", "hunter2",
                "note", "4242 4242 4242 4242"));
    @SuppressWarnings("unchecked")
    Map<String, Object> result = (Map<String, Object>) redacted;
    assertEquals("alice", result.get("user"));
    assertEquals(Redactor.REDACTED, result.get("password"));
    assertEquals(Redactor.REDACTED, result.get("note"));
  }

  @Test
  void isLinearTimeOnAdversarialInput() {
    String adversarial = "Bearer " + "a".repeat(100_000);
    long start = System.nanoTime();
    Redactor.scrubText(adversarial);
    long millis = (System.nanoTime() - start) / 1_000_000;
    assertTrue(millis < 1000, "scrubText took " + millis + "ms");
  }
}
