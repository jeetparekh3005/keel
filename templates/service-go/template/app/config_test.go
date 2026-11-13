package app

import (
	"strings"
	"testing"
)

// TestLoadConfigAppliesSecureDefaults checks the KEEL_-prefixed config loads with the
// secure-by-default values from the struct tags when the environment does not override them:
// environment defaults to production, not a permissive dev mode.
func TestLoadConfigAppliesSecureDefaults(t *testing.T) {
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	checks := map[string]struct{ got, want string }{
		"ServiceName": {cfg.ServiceName, "<< service_name >>"},
		"Version":     {cfg.Version, "0.0.0"},
		"Environment": {cfg.Environment, "production"},
		"LogLevel":    {cfg.LogLevel, "info"},
		"DatabaseURL": {cfg.DatabaseURL, "postgres://localhost/keel"},
	}
	for field, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", field, c.got, c.want)
		}
	}
	if cfg.Port != 8000 {
		t.Errorf("Port = %d, want 8000", cfg.Port)
	}
}

// TestLoadConfigReadsEnvironment checks KEEL_-prefixed overrides are parsed, including the
// comma-separated CORS origins list (envSeparator) and the integer port.
func TestLoadConfigReadsEnvironment(t *testing.T) {
	t.Setenv("KEEL_ENVIRONMENT", "staging")
	t.Setenv("KEEL_PORT", "9090")
	t.Setenv("KEEL_CORS_ALLOW_ORIGINS", "https://a.example,https://b.example")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Environment != "staging" {
		t.Errorf("Environment = %q, want staging", cfg.Environment)
	}
	if cfg.Port != 9090 {
		t.Errorf("Port = %d, want 9090", cfg.Port)
	}
	if len(cfg.CORSAllowOrigins) != 2 ||
		cfg.CORSAllowOrigins[0] != "https://a.example" ||
		cfg.CORSAllowOrigins[1] != "https://b.example" {
		t.Errorf("CORSAllowOrigins = %v, want two origins", cfg.CORSAllowOrigins)
	}
}

// TestLoadConfigFailsFastOnInvalidValue checks config is fail-fast: a non-integer port is a
// load error (an Internal DomainError), not a silently-zeroed field, so a misconfigured
// deploy crashes at boot instead of serving on an unexpected port.
func TestLoadConfigFailsFastOnInvalidValue(t *testing.T) {
	t.Setenv("KEEL_PORT", "not-a-number")
	_, err := LoadConfig()
	if err == nil {
		t.Fatal("LoadConfig accepted a non-integer port, want an error")
	}
	if !strings.HasPrefix(err.Error(), "internal:") {
		t.Errorf("error = %q, want an internal-category DomainError", err.Error())
	}
}
