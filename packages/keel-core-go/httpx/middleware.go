package httpx

import (
	"context"
	"net/http"
	"slices"

	"github.com/google/uuid"
)

const requestIDHeader = "X-Request-Id"

type ctxKey int

const requestIDKey ctxKey = iota

// securityHeaders sets the always-on security headers (set only if a route has not already
// set them). Applied outermost, so even a short-circuited response (e.g. a body-limit 413)
// carries them. HSTS is emitted unconditionally: browsers ignore it over plaintext.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		setIfAbsent(h, "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		setIfAbsent(h, "X-Content-Type-Options", "nosniff")
		setIfAbsent(h, "X-Frame-Options", "DENY")
		setIfAbsent(h, "Referrer-Policy", "no-referrer")
		setIfAbsent(h, "Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()")
		setIfAbsent(h, "Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		next.ServeHTTP(w, r)
	})
}

func setIfAbsent(h http.Header, key, value string) {
	if h.Get(key) == "" {
		h.Set(key, value)
	}
}

// requestID propagates a client X-Request-Id or mints a fresh UUID, echoes it on the
// response, and stores it in the context so logs and handlers can correlate.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(requestIDHeader)
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set(requestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

// RequestID returns the request id stored on the context, or "" if none.
func RequestID(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey).(string); ok {
		return id
	}
	return ""
}

// bodyLimit rejects a request whose Content-Length exceeds max with a 413, and caps the
// streamed body so a chunked over-limit read is bounded too.
func bodyLimit(max int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > max {
				writePayloadTooLarge(w)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, max)
			next.ServeHTTP(w, r)
		})
	}
}

// cors is deny-by-default: it is only installed when origins are configured, and it never
// combines a wildcard with credentials. A "*" entry allows any origin.
func cors(origins []string) func(http.Handler) http.Handler {
	allowAny := slices.Contains(origins, "*")
	allowed := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		allowed[o] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				if allowAny {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				} else if _, ok := allowed[origin]; ok {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Add("Vary", "Origin")
				}
				if w.Header().Get("Access-Control-Allow-Origin") != "" {
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				}
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
