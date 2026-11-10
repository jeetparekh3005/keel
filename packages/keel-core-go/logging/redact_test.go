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
}

func TestLuhn(t *testing.T) {
	if !luhnOK("4111111111111111") {
		t.Error("valid Visa test number should pass Luhn")
	}
	if luhnOK("1234567890123456") {
		t.Error("random digits should fail Luhn")
	}
}
