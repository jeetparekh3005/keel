# Changelog

## [0.1.1](https://github.com/jeetparekh3005/keel/compare/v0.1.0...v0.1.1) (2026-11-04)


### Features

* **auth:** authenticate the gRPC plane (deny-by-default) + extend to RPC ([#80](https://github.com/jeetparekh3005/keel/issues/80)) ([4d65570](https://github.com/jeetparekh3005/keel/commit/4d65570e7e0cabff498c321a1547c2cfa4b0a516)), closes [#64](https://github.com/jeetparekh3005/keel/issues/64) [#73](https://github.com/jeetparekh3005/keel/issues/73)


### Bug Fixes

* **python:** bound DB with timeouts and a bounded readiness ping ([#77](https://github.com/jeetparekh3005/keel/issues/77)) ([8c297c3](https://github.com/jeetparekh3005/keel/commit/8c297c316e9d4d219a631dbe10831227449b7882)), closes [#63](https://github.com/jeetparekh3005/keel/issues/63) [#73](https://github.com/jeetparekh3005/keel/issues/73)
* **python:** gate OpenAPI schema and docs UIs by environment ([#75](https://github.com/jeetparekh3005/keel/issues/75)) ([d70a3ce](https://github.com/jeetparekh3005/keel/commit/d70a3cea8a7b979fc26084600f05351ee314de0f)), closes [#60](https://github.com/jeetparekh3005/keel/issues/60) [#73](https://github.com/jeetparekh3005/keel/issues/73)
* **python:** remove leaky generic repository; keep Database + UnitOfWork plumbing ([#79](https://github.com/jeetparekh3005/keel/issues/79)) ([c23301c](https://github.com/jeetparekh3005/keel/commit/c23301c9ab0176cf8c60c5d9c444b2eaf2e94b67)), closes [#62](https://github.com/jeetparekh3005/keel/issues/62) [#73](https://github.com/jeetparekh3005/keel/issues/73)


### Miscellaneous Chores

* release v0.1.1 (dev to main) ([#82](https://github.com/jeetparekh3005/keel/issues/82)) ([ba56fa5](https://github.com/jeetparekh3005/keel/commit/ba56fa522980210e4a1b5823c186a6993fafd7da))

## 0.1.0 (2026-11-03)


### Features

* **platform:** define platform.yaml contract and port interfaces ([#7](https://github.com/jeetparekh3005/keel/issues/7)) ([cd6135a](https://github.com/jeetparekh3005/keel/commit/cd6135a04537c8aa4ab98a4ab14e69f871209f39))
* **python:** async SQLAlchemy persistence (Repository port, Database, UoW) ([#12](https://github.com/jeetparekh3005/keel/issues/12)) ([c001f91](https://github.com/jeetparekh3005/keel/commit/c001f915366dc94f5a73b38d017e42947e0f05e2))
* **python:** complete slice 6 — contract suite, migrations, image, compose ([#16](https://github.com/jeetparekh3005/keel/issues/16)) ([b01223c](https://github.com/jeetparekh3005/keel/commit/b01223c85cff81d4a8f6474906d1c848c8c2a265))
* **python:** complete Track B — authz, edge hardening, metrics, security gates, integration ([#19](https://github.com/jeetparekh3005/keel/issues/19)) ([5f5b1af](https://github.com/jeetparekh3005/keel/commit/5f5b1af13f1d540fb02a3bc2a5e240a83f232719))
* **python:** FastAPI app factory with problem+json, health, deny-by-default auth ([#11](https://github.com/jeetparekh3005/keel/issues/11)) ([64ec947](https://github.com/jeetparekh3005/keel/commit/64ec947ae606c7d41510a3187b9bc006a974a316))
* **python:** graceful shutdown, non-blocking app logger, batch spans, DB pool tuning ([#18](https://github.com/jeetparekh3005/keel/issues/18)) ([b673ff3](https://github.com/jeetparekh3005/keel/commit/b673ff3837793d252d9520510e44ef5bc00b7ea8))
* **python:** hardening round 2 — enforce deny-by-default, cardinality, async auth, redaction ([#20](https://github.com/jeetparekh3005/keel/issues/20)) ([f8f666d](https://github.com/jeetparekh3005/keel/commit/f8f666df9e75e512686ee567cf96306a1a6bccc7))
* **python:** keel-core ports, cross-cutting adapters, config, and test kit ([#10](https://github.com/jeetparekh3005/keel/issues/10)) ([2c5057b](https://github.com/jeetparekh3005/keel/commit/2c5057b3a3235b0ed031afcc5d9baf764bf4f918))
* **python:** OIDC JWT authenticator and SecretProvider (env adapter) ([#13](https://github.com/jeetparekh3005/keel/issues/13)) ([cd9ff73](https://github.com/jeetparekh3005/keel/commit/cd9ff73012860a9a2333e3ef70f641b4bbce8df7))
* **python:** reference service on keel-core (proves the contract) ([#15](https://github.com/jeetparekh3005/keel/issues/15)) ([a12f885](https://github.com/jeetparekh3005/keel/commit/a12f88575642758d8de8cee7b02f0dc75171b966))
* **python:** scaffold uv workspace and enforcement tooling ([#9](https://github.com/jeetparekh3005/keel/issues/9)) ([343efe9](https://github.com/jeetparekh3005/keel/commit/343efe9fd6e31fd82d3a24a1634f26d61f1f8fbf))
* **python:** slice 5 — distributed tracing, gRPC, and MessageBus ([#14](https://github.com/jeetparekh3005/keel/issues/14)) ([cd53de7](https://github.com/jeetparekh3005/keel/commit/cd53de7984cbd685c38ce31bb3c81349ded1e8f8))

## Changelog

All notable changes to this project are documented in this file.

This file is maintained automatically by [release-please](https://github.com/googleapis/release-please) based on [Conventional Commits](https://www.conventionalcommits.org/). Do not edit it by hand.

## 0.1.0 (2026-11-03)


### Features

* **platform:** define platform.yaml contract and port interfaces ([#7](https://github.com/jeetparekh3005/keel/issues/7)) ([cd6135a](https://github.com/jeetparekh3005/keel/commit/cd6135a04537c8aa4ab98a4ab14e69f871209f39))
* **python:** async SQLAlchemy persistence (Repository port, Database, UoW) ([#12](https://github.com/jeetparekh3005/keel/issues/12)) ([c001f91](https://github.com/jeetparekh3005/keel/commit/c001f915366dc94f5a73b38d017e42947e0f05e2))
* **python:** complete slice 6 — contract suite, migrations, image, compose ([#16](https://github.com/jeetparekh3005/keel/issues/16)) ([b01223c](https://github.com/jeetparekh3005/keel/commit/b01223c85cff81d4a8f6474906d1c848c8c2a265))
* **python:** complete Track B — authz, edge hardening, metrics, security gates, integration ([#19](https://github.com/jeetparekh3005/keel/issues/19)) ([5f5b1af](https://github.com/jeetparekh3005/keel/commit/5f5b1af13f1d540fb02a3bc2a5e240a83f232719))
* **python:** FastAPI app factory with problem+json, health, deny-by-default auth ([#11](https://github.com/jeetparekh3005/keel/issues/11)) ([64ec947](https://github.com/jeetparekh3005/keel/commit/64ec947ae606c7d41510a3187b9bc006a974a316))
* **python:** graceful shutdown, non-blocking app logger, batch spans, DB pool tuning ([#18](https://github.com/jeetparekh3005/keel/issues/18)) ([b673ff3](https://github.com/jeetparekh3005/keel/commit/b673ff3837793d252d9520510e44ef5bc00b7ea8))
* **python:** hardening round 2 — enforce deny-by-default, cardinality, async auth, redaction ([#20](https://github.com/jeetparekh3005/keel/issues/20)) ([f8f666d](https://github.com/jeetparekh3005/keel/commit/f8f666df9e75e512686ee567cf96306a1a6bccc7))
* **python:** keel-core ports, cross-cutting adapters, config, and test kit ([#10](https://github.com/jeetparekh3005/keel/issues/10)) ([2c5057b](https://github.com/jeetparekh3005/keel/commit/2c5057b3a3235b0ed031afcc5d9baf764bf4f918))
* **python:** OIDC JWT authenticator and SecretProvider (env adapter) ([#13](https://github.com/jeetparekh3005/keel/issues/13)) ([cd9ff73](https://github.com/jeetparekh3005/keel/commit/cd9ff73012860a9a2333e3ef70f641b4bbce8df7))
* **python:** reference service on keel-core (proves the contract) ([#15](https://github.com/jeetparekh3005/keel/issues/15)) ([a12f885](https://github.com/jeetparekh3005/keel/commit/a12f88575642758d8de8cee7b02f0dc75171b966))
* **python:** scaffold uv workspace and enforcement tooling ([#9](https://github.com/jeetparekh3005/keel/issues/9)) ([343efe9](https://github.com/jeetparekh3005/keel/commit/343efe9fd6e31fd82d3a24a1634f26d61f1f8fbf))
* **python:** slice 5 — distributed tracing, gRPC, and MessageBus ([#14](https://github.com/jeetparekh3005/keel/issues/14)) ([cd53de7](https://github.com/jeetparekh3005/keel/commit/cd53de7984cbd685c38ce31bb3c81349ded1e8f8))
