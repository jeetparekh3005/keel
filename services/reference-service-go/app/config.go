package app

import "github.com/jeetparekh3005/keel/packages/keel-core-go/config"

// ReferenceConfig is the typed, KEEL_-prefixed service configuration. Secure by default:
// environment defaults to production.
type ReferenceConfig struct {
	ServiceName      string   `env:"SERVICE_NAME" envDefault:"reference-service"`
	Version          string   `env:"VERSION" envDefault:"0.0.0"`
	Environment      string   `env:"ENVIRONMENT" envDefault:"production"`
	LogLevel         string   `env:"LOG_LEVEL" envDefault:"info"`
	DatabaseURL      string   `env:"DATABASE_URL" envDefault:"postgres://localhost/keel"`
	OIDCIssuer       string   `env:"OIDC_ISSUER"`
	OIDCAudience     string   `env:"OIDC_AUDIENCE"`
	OIDCJwksURI      string   `env:"OIDC_JWKS_URI"`
	OTLPEndpoint     string   `env:"OTLP_ENDPOINT"`
	Port             int      `env:"PORT" envDefault:"8000"`
	CORSAllowOrigins []string `env:"CORS_ALLOW_ORIGINS" envSeparator:","`
}

// LoadConfig reads ReferenceConfig from the KEEL_-prefixed environment (fail-fast).
func LoadConfig() (ReferenceConfig, error) {
	return config.Load[ReferenceConfig]()
}
