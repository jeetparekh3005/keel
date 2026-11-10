// Package logging provides structured JSON logging (platform.yaml logging: json, leveled,
// one line per event) via the standard library log/slog, with secret redaction matching
// the Python and Rust verticals.
//
// Redaction covers every logged attribute: a secret-family key is redacted wholesale, and
// a string value is scrubbed for secret patterns (JWT, AWS key id, bearer, PEM, Luhn-valid
// card numbers). Attributes nested under slog.Group are covered too. Scope note: a secret
// hidden inside a non-string composite value logged with slog.Any (a raw struct or map) is
// not descended into; prefer slog.Group / typed attrs so redaction applies.
package logging

import (
	"io"
	"log/slog"
	"os"
	"strings"
)

// New returns a slog.Logger that writes redacted JSON to w at the given level
// ("debug", "info", "warn", "error"; unknown falls back to info).
func New(level string, w io.Writer) *slog.Logger {
	opts := &slog.HandlerOptions{
		Level:       parseLevel(level),
		ReplaceAttr: redactAttr,
	}
	return slog.New(slog.NewJSONHandler(w, opts))
}

// Init installs a redacting JSON logger (to stdout) as the slog default. Call once at
// startup; the richer telemetry path (later slice) layers trace context on top.
func Init(level string) {
	slog.SetDefault(New(level, os.Stdout))
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// redactAttr is slog's per-attribute hook. It (1) normalizes the built-in keys to the
// cross-vertical log schema (timestamp/level/message, lowercased level), and (2) redacts a
// secret-keyed value wholesale and scrubs secret patterns from string values. slog calls
// it for every non-group attribute with the enclosing group names in groups, so nested
// attributes are covered without a bespoke handler.
func redactAttr(groups []string, a slog.Attr) slog.Attr {
	if len(groups) == 0 {
		switch a.Key {
		case slog.TimeKey:
			a.Key = "timestamp"
			return a
		case slog.LevelKey:
			if lvl, ok := a.Value.Any().(slog.Level); ok {
				return slog.String("level", strings.ToLower(lvl.String()))
			}
			return a
		case slog.MessageKey:
			if a.Value.Kind() == slog.KindString {
				return slog.String("message", scrubText(a.Value.String()))
			}
			a.Key = "message"
			return a
		}
	}
	if isSecretKey(a.Key) {
		return slog.String(a.Key, redacted)
	}
	if a.Value.Kind() == slog.KindString {
		return slog.String(a.Key, scrubText(a.Value.String()))
	}
	return a
}
