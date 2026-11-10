# syntax=docker/dockerfile:1
# Hardened image per ADR-0008 for the Go vertical. Build context is the repo root (go.work).
# Base images use rolling Chainguard tags by deliberate choice (scanned every build; ADR-0008).
# Go embeds its module list in the compiled binary, so Trivy scans the shipped image's Go
# dependencies directly: no extra step is needed (unlike the Rust cargo-auditable stage).

FROM cgr.dev/chainguard/go:latest AS build
WORKDIR /app
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
COPY go.work go.work.sum ./
COPY packages/keel-core-go ./packages/keel-core-go
COPY services/reference-service-go ./services/reference-service-go
RUN go build -trimpath -ldflags="-s -w" -buildvcs=false \
    -o /reference-service ./services/reference-service-go/cmd/reference-service

FROM cgr.dev/chainguard/static:latest
COPY --from=build /reference-service /usr/local/bin/reference-service
USER nonroot
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/reference-service"]
