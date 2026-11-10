package adapters

import (
	"testing"
	"time"
)

func TestSystemClockReturnsRecentTime(t *testing.T) {
	now := SystemClock{}.Now()
	if time.Since(now) > time.Minute || now.IsZero() {
		t.Errorf("SystemClock.Now() = %v, not a current time", now)
	}
}

func TestEnvSecretProviderReadsEnv(t *testing.T) {
	t.Setenv("KEEL_TEST_SECRET", "s3cr3t")
	provider := EnvSecretProvider{}
	v, ok := provider.Get("KEEL_TEST_SECRET")
	if !ok || v != "s3cr3t" {
		t.Errorf("Get() = %q,%v; want s3cr3t,true", v, ok)
	}
	if _, ok := provider.Get("KEEL_DEFINITELY_ABSENT"); ok {
		t.Error("absent key should return ok=false")
	}
}
