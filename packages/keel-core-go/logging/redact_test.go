package logging

import "testing"

func TestIsSecretKeyAcrossSeparatorsAndCase(t *testing.T) {
	secret := []string{"password", "X-Api-Key", "access_token", "Set-Cookie", "client_secret", "Authorization"}
	for _, k := range secret {
		if !isSecretKey(k) {
			t.Errorf("%q should be secret", k)
		}
	}
	for _, k := range []string{"user_id", "name", "count", "status", "message"} {
		if isSecretKey(k) {
			t.Errorf("%q should not be secret", k)
		}
	}
}

func TestScrubTextPatterns(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NXgL0n3I9"
	cases := map[string]string{
		jwt:                    redacted,
		"AKIAIOSFODNN7EXAMPLE": redacted,
		"4111 1111 1111 1111":  redacted,           // Luhn-valid card
		"1234567890123456":     "1234567890123456", // not Luhn-valid, left alone
		"nothing to see here":  "nothing to see here",
	}
	for in, want := range cases {
		if got := scrubText(in); got != want {
			t.Errorf("scrubText(%q) = %q, want %q", in, got, want)
		}
	}
	if got := scrubText("Bearer abcdef1234567890"); got != redacted {
		t.Errorf("bearer not scrubbed: %q", got)
	}
	// The bearer pattern uses \s+, so a token separated from the scheme by more than one space
	// is still redacted (the two-space vector the TS/Java v0.4 review flagged; #359 parity).
	if got := scrubText("Bearer  abcdef1234567890"); got != redacted {
		t.Errorf("two-space bearer not scrubbed: %q", got)
	}
}

// TestExportedRedactionAPI covers the exported wrappers other sinks (the OTLP span-export
// path) reuse, confirming they delegate to the same classification, scrubbing, and marker.
func TestExportedRedactionAPI(t *testing.T) {
	if Redacted != redacted {
		t.Errorf("Redacted = %q, want %q", Redacted, redacted)
	}
	if !IsSecretKey("Authorization") {
		t.Error("IsSecretKey should classify Authorization as secret")
	}
	if IsSecretKey("user_id") {
		t.Error("IsSecretKey should not classify user_id as secret")
	}
	if got := ScrubText("Bearer abcdef1234567890"); got != Redacted {
		t.Errorf("ScrubText bearer not scrubbed: %q", got)
	}
	if got := ScrubText("plain"); got != "plain" {
		t.Errorf("ScrubText altered a clean value: %q", got)
	}
}

// TestScrubTextForName asserts the name-specific scrubber runs every secret-pattern matcher
// except the credit-card/PAN/Luhn one: a Luhn-valid id in a low-cardinality operation name is a
// route parameter and must survive, while bearer/JWT/AWS-key secrets are still scrubbed. The
// matching ScrubText call proves the PAN carve-out is name-only and does not touch value scrubbing.
func TestScrubTextForName(t *testing.T) {
	const luhnName = "GET /v1/accounts/4532015112830366/balance"
	if got := ScrubTextForName(luhnName); got != luhnName {
		t.Errorf("ScrubTextForName redacted a Luhn-valid id in a name: %q", got)
	}
	// Control: ScrubText (the value scrubber) does redact the same Luhn id.
	if got := ScrubText(luhnName); got == luhnName {
		t.Errorf("ScrubText should redact the Luhn id in a value, left unchanged: %q", got)
	}
	if got := ScrubTextForName("job Bearer abcdef1234567890 ran"); got != "job [REDACTED] ran" {
		t.Errorf("ScrubTextForName did not scrub bearer: %q", got)
	}
	if got := ScrubTextForName("key AKIAIOSFODNN7EXAMPLE used"); got != "key [REDACTED] used" {
		t.Errorf("ScrubTextForName did not scrub AWS key: %q", got)
	}
}

func TestLuhn(t *testing.T) {
	if !luhnOK("4111111111111111") {
		t.Error("valid Visa test number should pass Luhn")
	}
	if luhnOK("1234567890123456") {
		t.Error("random digits should fail Luhn")
	}
}
