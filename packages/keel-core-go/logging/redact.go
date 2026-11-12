package logging

import (
	"regexp"
	"strings"
)

const redacted = "[REDACTED]"

// secretKeyFragments mark a field whose value is redacted wholesale. Matched against a
// normalized (lowercased, separator-stripped) key, mirroring the Python and Rust verticals.
var secretKeyFragments = []string{
	"password",
	"passwd",
	"secret",
	"token",
	"apikey",
	"cookie",
	"authorization",
	"credential",
	"privatekey",
	"pii",
}

// isSecretKey reports whether key belongs to a secret family (case/separator-insensitive).
func isSecretKey(key string) bool {
	normalized := strings.ToLower(key)
	normalized = strings.ReplaceAll(normalized, "-", "")
	normalized = strings.ReplaceAll(normalized, "_", "")
	for _, fragment := range secretKeyFragments {
		if strings.Contains(normalized, fragment) {
			return true
		}
	}
	return false
}

// High-precision secret patterns scrubbed from any string value. Go's regexp (RE2) runs in
// linear time, so these cannot cause catastrophic backtracking (ReDoS).
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), // JWT
	regexp.MustCompile(`AKIA[0-9A-Z]{16}`),                                           // AWS access key id
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._~+/-]{8,}=*`),                       // bearer token
	regexp.MustCompile(`-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----`),                   // PEM private key
}

// ccCandidate matches credit-card-like digit runs; only redacted when Luhn-valid.
var ccCandidate = regexp.MustCompile(`(?:\d[ -]?){13,19}`)

func luhnOK(digits string) bool {
	sum := 0
	double := false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if d < 0 || d > 9 {
			return false
		}
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		double = !double
	}
	return sum%10 == 0
}

// Redacted is the placeholder substituted for a secret value. Exported so other sinks
// (for example the OTLP span-export path) redact to the same marker as the log sink.
const Redacted = redacted

// IsSecretKey reports whether key belongs to a secret family (case/separator-insensitive),
// meaning its value is redacted wholesale. Exported so the span-export path reuses the same
// key classification as the log sink rather than duplicating the fragment list.
func IsSecretKey(key string) bool { return isSecretKey(key) }

// ScrubText replaces secret patterns and Luhn-valid card numbers in a string value with the
// redaction marker. Exported so the span-export path scrubs string values with the same
// patterns as the log sink rather than duplicating them.
func ScrubText(text string) string { return scrubText(text) }

// scrubText replaces secret patterns and Luhn-valid card numbers in a string value.
func scrubText(text string) string {
	for _, pattern := range secretPatterns {
		text = pattern.ReplaceAllString(text, redacted)
	}
	text = ccCandidate.ReplaceAllStringFunc(text, func(match string) string {
		var sb strings.Builder
		for _, r := range match {
			if r >= '0' && r <= '9' {
				sb.WriteRune(r)
			}
		}
		digits := sb.String()
		if len(digits) >= 13 && len(digits) <= 19 && luhnOK(digits) {
			return redacted
		}
		return match
	})
	return text
}
