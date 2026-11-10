package config

import (
	"errors"
	"testing"

	"github.com/jeetparekh3005/keel/packages/keel-core-go/domain"
)

type testConfig struct {
	Name  string `env:"NAME"`
	Port  int    `env:"PORT" envDefault:"8000"`
	Debug bool   `env:"DEBUG"`
}

func TestLoadReadsKeelPrefixedEnvAndDefaults(t *testing.T) {
	t.Setenv("KEEL_NAME", "svc")
	t.Setenv("KEEL_DEBUG", "true")
	cfg, err := Load[testConfig]()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Name != "svc" || cfg.Port != 8000 || !cfg.Debug {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadFailsFastWithDomainErrorOnBadValue(t *testing.T) {
	t.Setenv("KEEL_PORT", "not-an-int")
	_, err := Load[testConfig]()
	if err == nil {
		t.Fatal("expected a parse error for an invalid int")
	}
	var de *domain.DomainError
	if !errors.As(err, &de) || de.Category != domain.Internal {
		t.Fatalf("expected an Internal DomainError, got %v", err)
	}
}
