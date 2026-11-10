# syntax=docker/dockerfile:1
# Hardened image per ADR-0008 for the Rust vertical. Build context is the repo root
# (Cargo workspace). Base images use rolling Chainguard tags by deliberate choice
# (scanned every build; see ADR-0008). Output is a shell-less, non-root, read-only-
# friendly image running a single static-ish release binary.

FROM cgr.dev/chainguard/rust:latest AS build
WORKDIR /app
# cargo-auditable embeds the exact dependency list into the binary, so Trivy (and
# `cargo audit bin`) can detect RUSTSEC advisories in the shipped distroless image, which
# otherwise carries no crate metadata. Source-level CVE gating still runs in rust.yml.
RUN cargo install cargo-auditable --locked
COPY Cargo.toml Cargo.lock ./
COPY packages ./packages
COPY services ./services
RUN cargo auditable build --release --locked \
    --package reference-service-rust --bin reference-service

FROM cgr.dev/chainguard/glibc-dynamic:latest
COPY --from=build /app/target/release/reference-service /usr/local/bin/reference-service
USER nonroot
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/reference-service"]
