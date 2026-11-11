package logging

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestSecretsAreRedactedInTheEmittedJSON(t *testing.T) {
	var buf bytes.Buffer
	log := New("info", &buf)
	log.Info("login attempt",
		"password", "hunter2",
		"user_id", 7,
		"note", "key AKIAIOSFODNN7EXAMPLE leaked",
	)

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("not valid JSON: %v\n%s", err, buf.String())
	}
	// Cross-vertical schema: timestamp / level / message, level lowercased.
	if rec["message"] != "login attempt" {
		t.Errorf("message = %v", rec["message"])
	}
	if rec["level"] != "info" {
		t.Errorf("level = %v, want info", rec["level"])
	}
	if _, ok := rec["timestamp"]; !ok {
		t.Errorf("missing timestamp: %s", buf.String())
	}
	// Redaction.
	if rec["password"] != redacted {
		t.Errorf("password not redacted: %v", rec["password"])
	}
	if rec["user_id"].(float64) != 7 {
		t.Errorf("user_id should pass through: %v", rec["user_id"])
	}
	if rec["note"] != "key [REDACTED] leaked" {
		t.Errorf("secret value not scrubbed: %v", rec["note"])
	}
}

func TestSecretsNestedInAGroupAreRedacted(t *testing.T) {
	var buf bytes.Buffer
	log := New("info", &buf)
	log.Info("call", "data", nil) // placeholder to force a line
	buf.Reset()
	log.With("req", "r1").Info("inbound",
		"headers_authorization", "Bearer abcdef1234567890",
	)
	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatal(err)
	}
	if rec["headers_authorization"] != redacted {
		t.Errorf("secret-family key not redacted: %v", rec["headers_authorization"])
	}
}

func TestLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	log := New("error", &buf)
	log.Info("quiet") // below error, dropped
	if buf.Len() != 0 {
		t.Errorf("info should be filtered at error level: %s", buf.String())
	}
	log.Error("loud")
	if buf.Len() == 0 {
		t.Error("error should be emitted")
	}
}
