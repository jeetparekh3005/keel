package telemetry

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// TestCorrelatingHandlerWithAttrsAndGroup checks the correlation wrapper preserves slog's
// WithAttrs/WithGroup semantics: attrs attached via WithAttrs appear on every record, and
// WithGroup nests later attrs under the group key. Without delegating to the inner handler,
// a service's structured log fields would silently vanish.
func TestCorrelatingHandlerWithAttrsAndGroup(t *testing.T) {
	var buf bytes.Buffer
	h := correlatingHandler{inner: slog.NewJSONHandler(&buf, nil)}

	withAttr := slog.New(h.WithAttrs([]slog.Attr{slog.String("component", "db")}))
	withAttr.Info("ready")
	if !strings.Contains(buf.String(), `"component":"db"`) {
		t.Fatalf("WithAttrs did not stamp the attr: %s", buf.String())
	}

	buf.Reset()
	grouped := slog.New(h.WithGroup("req"))
	grouped.Info("served", slog.String("id", "42"))
	if !strings.Contains(buf.String(), `"req":{"id":"42"}`) {
		t.Fatalf("WithGroup did not nest the attr: %s", buf.String())
	}
}
