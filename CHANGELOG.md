# Changelog

## [0.5.3](https://github.com/jeetparekh3005/keel/compare/v0.5.2...v0.5.3) (2026-11-12)


### Bug Fixes

* redact RegExp own-props and handle BigInt in the logger (clean-proof gate) ([#415](https://github.com/jeetparekh3005/keel/issues/415)) ([c052c9b](https://github.com/jeetparekh3005/keel/commit/c052c9bc281f0ae028b1be2f1d02451f4548baa2))


### Miscellaneous Chores

* release v0.5.3 (dev to main) ([57356bc](https://github.com/jeetparekh3005/keel/commit/57356bc86bb5dd1aeda82e07de817ebd35bd181e))

## [0.5.2](https://github.com/jeetparekh3005/keel/compare/v0.5.1...v0.5.2) (2026-11-12)


### Bug Fixes

* bound logger redaction depth and sanitize merge objects (proof MEDIUM crashes) ([#410](https://github.com/jeetparekh3005/keel/issues/410)) ([aa2a289](https://github.com/jeetparekh3005/keel/commit/aa2a28911edd0622c9367946654251d657946ad8))
* close exhaustive-proof logger leaks (bare-error message, function props, proxy crash) ([#409](https://github.com/jeetparekh3005/keel/issues/409)) ([d71326b](https://github.com/jeetparekh3005/keel/commit/d71326bc35586b08f07d5107e9d2da49f26a3fd0))
* close fourth-review findings (merge-path error leak, tokenizer offsets, getter crash) ([#408](https://github.com/jeetparekh3005/keel/issues/408)) ([4abbd45](https://github.com/jeetparekh3005/keel/commit/4abbd457c24d3fce5f5ffb8da7b20617dcab9740))
* close third-review regressions (logger secret leak, conformance strip, gofmt task) ([#407](https://github.com/jeetparekh3005/keel/issues/407)) ([a8d0c12](https://github.com/jeetparekh3005/keel/commit/a8d0c12b4eeee4f9659a7eb648fb77181707c5c9))
* redact object Map keys in the logger (final-proof HIGH leak) ([#411](https://github.com/jeetparekh3005/keel/issues/411)) ([3a6ac09](https://github.com/jeetparekh3005/keel/commit/3a6ac094e54e61f028833df770cce8e37d767925))


### Miscellaneous Chores

* release v0.5.2 (dev to main) ([9ac8172](https://github.com/jeetparekh3005/keel/commit/9ac81729cedb82116360fa9fc40cf1198439e91b))

## [0.5.1](https://github.com/jeetparekh3005/keel/compare/v0.5.0...v0.5.1) (2026-11-12)


### Bug Fixes

* remediate independent-review findings (logger, body-limit, conformance, CI lane) ([#403](https://github.com/jeetparekh3005/keel/issues/403)) ([2db9f51](https://github.com/jeetparekh3005/keel/commit/2db9f51c8862894066f2444c3cd6f8b3e1aa3ca2))


### Miscellaneous Chores

* integrate v0.5.1 (dev to main) ([0895023](https://github.com/jeetparekh3005/keel/commit/0895023f5a93974ce07add4b96f8604480d7cecb))

## [0.5.0](https://github.com/jeetparekh3005/keel/compare/v0.4.0...v0.5.0) (2026-11-11)


### Features

* **ci:** keel-service-base Helm library chart; service charts depend on it ([#385](https://github.com/jeetparekh3005/keel/issues/385)) ([0f9fdaa](https://github.com/jeetparekh3005/keel/commit/0f9fdaa932af3d07be8e1aa0b40638df94a2ada3))
* **ci:** reusable workflow_call CI workflows per language; templates ship ci.yml ([#386](https://github.com/jeetparekh3005/keel/issues/386)) ([372c96b](https://github.com/jeetparekh3005/keel/commit/372c96baba5e8d6f488e6d5ab091af9237a9bdef))
* **go:** Copier template for the Go vertical + byte-identical dogfood ([#380](https://github.com/jeetparekh3005/keel/issues/380)) ([c371ea7](https://github.com/jeetparekh3005/keel/commit/c371ea70803a59fe3104648da6c92c399ae14487))
* **java:** Copier template for the Java vertical + byte-identical dogfood ([#382](https://github.com/jeetparekh3005/keel/issues/382)) ([d00de41](https://github.com/jeetparekh3005/keel/commit/d00de411595329e5ad3c33f971d5051265368af7))
* **platform:** Copier template for the Python service (keel new service) ([#373](https://github.com/jeetparekh3005/keel/issues/373)) ([de4361e](https://github.com/jeetparekh3005/keel/commit/de4361ed4a94ddabb1b05632fda7a5a09482c260)), closes [#369](https://github.com/jeetparekh3005/keel/issues/369)
* **platform:** keel CLI - thin Copier wrapper + platform.yaml conformance check ([#377](https://github.com/jeetparekh3005/keel/issues/377)) ([763f1e3](https://github.com/jeetparekh3005/keel/commit/763f1e36ac939341c42921a2c7d7d8f6aa190b7c)), closes [#371](https://github.com/jeetparekh3005/keel/issues/371)
* **platform:** prove the keel update round-trip (Tier-2 propagation) ([#378](https://github.com/jeetparekh3005/keel/issues/378)) ([7863a67](https://github.com/jeetparekh3005/keel/commit/7863a67c4b12b9386eb3a17501fc0d5056e2936b)), closes [#372](https://github.com/jeetparekh3005/keel/issues/372)
* **rust:** Copier template for the Rust vertical + byte-identical dogfood ([#381](https://github.com/jeetparekh3005/keel/issues/381)) ([7691413](https://github.com/jeetparekh3005/keel/commit/7691413c40be5d1f28c0b642b500d97e69a76bb9))
* **ts:** Copier template for the TypeScript/NestJS vertical + byte-identical dogfood ([#383](https://github.com/jeetparekh3005/keel/issues/383)) ([8a8d553](https://github.com/jeetparekh3005/keel/commit/8a8d55305924192ed4ef3961dfa700cc93bdc329))


### Bug Fixes

* **cli:** harden keel check - strip comments, parse manifests, tighten markers ([#398](https://github.com/jeetparekh3005/keel/issues/398)) ([98291f8](https://github.com/jeetparekh3005/keel/commit/98291f8b1be520d579390c634d90047759a1267a))
* **go:** gofmt the rendered service so a non-item aggregate stays CI-clean ([#396](https://github.com/jeetparekh3005/keel/issues/396)) ([4ab25a6](https://github.com/jeetparekh3005/keel/commit/4ab25a6a6b2d3149b4253a8dc7c04ec88b2b91fd))
* **ts:** key-redact object log args + streaming body cap for chunked requests ([#397](https://github.com/jeetparekh3005/keel/issues/397)) ([ed8e249](https://github.com/jeetparekh3005/keel/commit/ed8e249ef47342408d3fd6a9802847e5b197b40a))
* **ts:** scrub post-interpolation log messages + content-type-agnostic body limit ([#390](https://github.com/jeetparekh3005/keel/issues/390)) ([194d6ba](https://github.com/jeetparekh3005/keel/commit/194d6ba986b9a3ab8a503846b7054a220e6bb643))


### Miscellaneous Chores

* integrate dev for the v0.5.0 release ([9d2517e](https://github.com/jeetparekh3005/keel/commit/9d2517eb018cb7dbaef32b1d0284acc0166b7ff8))

## [0.4.0](https://github.com/jeetparekh3005/keel/compare/v0.3.2...v0.4.0) (2026-11-11)


### Features

* **go:** config loader + RFC 9457 error taxonomy + domain errors ([#328](https://github.com/jeetparekh3005/keel/issues/328)) ([9b0e2fb](https://github.com/jeetparekh3005/keel/commit/9b0e2fb7a8223202787da5e2e84a4da173f3cf35)), closes [#309](https://github.com/jeetparekh3005/keel/issues/309)
* **go:** container image + Helm chart + supply-chain CI ([#342](https://github.com/jeetparekh3005/keel/issues/342)) ([8be1700](https://github.com/jeetparekh3005/keel/commit/8be1700c28a10ac0a5fae3bd84b540f14bf1e109))
* **go:** driven ports + test-kit fakes + behavioral conformance suite ([#340](https://github.com/jeetparekh3005/keel/issues/340)) ([facd39a](https://github.com/jeetparekh3005/keel/commit/facd39adb4c7b42da3bca1bb659b23c5b4f6cc02)), closes [#321](https://github.com/jeetparekh3005/keel/issues/321)
* **go:** HTTP edge middleware (chi) + health probes + problem+json ([#331](https://github.com/jeetparekh3005/keel/issues/331)) ([4b1bf81](https://github.com/jeetparekh3005/keel/commit/4b1bf81b39ecef86424b6c556de2d8cc8d7849bb)), closes [#315](https://github.com/jeetparekh3005/keel/issues/315)
* **go:** OIDC/JWT authenticator (go-oidc) + deny-by-default authz ([#332](https://github.com/jeetparekh3005/keel/issues/332)) ([29bac78](https://github.com/jeetparekh3005/keel/commit/29bac786966a710371f1a2dc52579521dec7bf0b)), closes [#317](https://github.com/jeetparekh3005/keel/issues/317)
* **go:** OpenTelemetry setup with log-to-trace correlation ([#330](https://github.com/jeetparekh3005/keel/issues/330)) ([1f1d54d](https://github.com/jeetparekh3005/keel/commit/1f1d54d502bd99b432e3231460b54aa8eafa59b9)), closes [#313](https://github.com/jeetparekh3005/keel/issues/313)
* **go:** persistence (pgx Database + unit of work) ([#339](https://github.com/jeetparekh3005/keel/issues/339)) ([c2fd65b](https://github.com/jeetparekh3005/keel/commit/c2fd65b5c2671b115bf11f7baa2f4c648166ea64)), closes [#319](https://github.com/jeetparekh3005/keel/issues/319)
* **go:** reference-service-go (items aggregate) + composition root ([#341](https://github.com/jeetparekh3005/keel/issues/341)) ([fef1309](https://github.com/jeetparekh3005/keel/commit/fef1309eb483cd0566d14ac39fa93ec1bc9494a7)), closes [#323](https://github.com/jeetparekh3005/keel/issues/323)
* **go:** scaffold keel-core-go workspace + Go CI lane (govulncheck gate) ([#327](https://github.com/jeetparekh3005/keel/issues/327)) ([c9b4aca](https://github.com/jeetparekh3005/keel/commit/c9b4aca5f103a720539700deca55694f7f8ab523)), closes [#307](https://github.com/jeetparekh3005/keel/issues/307)
* **go:** structured slog logging with secret redaction ([#329](https://github.com/jeetparekh3005/keel/issues/329)) ([371ac62](https://github.com/jeetparekh3005/keel/commit/371ac625c85d7214530ebc0d5b9dfd5ba5a38639))
* **java:** Java/Spring Boot backend vertical (keel-core-java + reference-service-java) ([#356](https://github.com/jeetparekh3005/keel/issues/356)) ([cf8adc7](https://github.com/jeetparekh3005/keel/commit/cf8adc7830fb0bc4de7da8368e88da2193685f1a)), closes [#30](https://github.com/jeetparekh3005/keel/issues/30)
* **ts:** TypeScript/NestJS backend vertical (keel-core-ts + reference-service-nest) ([#355](https://github.com/jeetparekh3005/keel/issues/355)) ([363a763](https://github.com/jeetparekh3005/keel/commit/363a763d70279c6dfc3db016343b492fe5fdaee1)), closes [#344](https://github.com/jeetparekh3005/keel/issues/344) [#345](https://github.com/jeetparekh3005/keel/issues/345) [#346](https://github.com/jeetparekh3005/keel/issues/346) [#347](https://github.com/jeetparekh3005/keel/issues/347) [#348](https://github.com/jeetparekh3005/keel/issues/348) [#349](https://github.com/jeetparekh3005/keel/issues/349) [#350](https://github.com/jeetparekh3005/keel/issues/350) [#351](https://github.com/jeetparekh3005/keel/issues/351) [#352](https://github.com/jeetparekh3005/keel/issues/352) [#353](https://github.com/jeetparekh3005/keel/issues/353)


### Bug Fixes

* **java:** remediate v0.4 review findings in the Spring Boot vertical ([#358](https://github.com/jeetparekh3005/keel/issues/358)) ([f6b4664](https://github.com/jeetparekh3005/keel/commit/f6b46641ce350f5f31bfc8fc26ee1152acff7e8d))
* **security:** clear frontend dev-tooling CVEs (turbo, minimatch) ([#326](https://github.com/jeetparekh3005/keel/issues/326)) ([6601f51](https://github.com/jeetparekh3005/keel/commit/6601f51e8da961fa78c5d270f51bd454efdfa2c0))
* **ts:** remediate v0.4 review findings (NestJS vertical) ([#357](https://github.com/jeetparekh3005/keel/issues/357)) ([822206e](https://github.com/jeetparekh3005/keel/commit/822206edb53aaaff6e63fc09d71b51264579b663))
* **v0.4:** remediate the remediation-review findings (telemetry correctness + non-vacuous tests) ([#363](https://github.com/jeetparekh3005/keel/issues/363)) ([2f4ba5e](https://github.com/jeetparekh3005/keel/commit/2f4ba5e8fd2c49f4ce0c0a619b99248bea48f2ef))


### Miscellaneous Chores

* integrate dev for the v0.4.0 release ([#364](https://github.com/jeetparekh3005/keel/issues/364)) ([3d89b5a](https://github.com/jeetparekh3005/keel/commit/3d89b5ad51610c61a2b0b8993c37cdf1ab4b66f3))

## [0.3.2](https://github.com/jeetparekh3005/keel/compare/v0.3.1...v0.3.2) (2026-11-10)


### Features

* **rust:** structured-log secret redaction (parity with the Python vertical) ([#278](https://github.com/jeetparekh3005/keel/issues/278)) ([a40cdcf](https://github.com/jeetparekh3005/keel/commit/a40cdcff707d5e827f194f1f819b0a50edf368b8))


### Bug Fixes

* **python:** audit follow-ups (XFF trust, bytes redaction, forwarded-ips, drift, contract) ([#274](https://github.com/jeetparekh3005/keel/issues/274)) ([a50ee2b](https://github.com/jeetparekh3005/keel/commit/a50ee2b504474b11c6f61153cb5055642a9c2485)), closes [#239](https://github.com/jeetparekh3005/keel/issues/239) [#241](https://github.com/jeetparekh3005/keel/issues/241) [#243](https://github.com/jeetparekh3005/keel/issues/243) [#244](https://github.com/jeetparekh3005/keel/issues/244) [#240](https://github.com/jeetparekh3005/keel/issues/240)
* third-audit follow-ups (reserved-key namespacing, sign-before-tag, drift, docs) ([#302](https://github.com/jeetparekh3005/keel/issues/302)) ([0b97377](https://github.com/jeetparekh3005/keel/commit/0b97377fa4894d5d955e3092c83d2896d42481de))


### Miscellaneous Chores

* integrate dev for the v0.3.2 release ([362bf3c](https://github.com/jeetparekh3005/keel/commit/362bf3cdbddb3e58040addfd494e92b2e66280c5))

## [0.3.1](https://github.com/jeetparekh3005/keel/compare/v0.3.0...v0.3.1) (2026-11-10)


### Bug Fixes

* **rust:** second-audit hardening (Entra scp, port wiring, CORS, JWKS edges) ([#270](https://github.com/jeetparekh3005/keel/issues/270)) ([2043f1a](https://github.com/jeetparekh3005/keel/commit/2043f1a2cf83ca206fb8459d2606cd0a61a72f25)), closes [#263](https://github.com/jeetparekh3005/keel/issues/263) [#267](https://github.com/jeetparekh3005/keel/issues/267) [#266](https://github.com/jeetparekh3005/keel/issues/266) [#262](https://github.com/jeetparekh3005/keel/issues/262) [#264](https://github.com/jeetparekh3005/keel/issues/264) [#265](https://github.com/jeetparekh3005/keel/issues/265) [#268](https://github.com/jeetparekh3005/keel/issues/268) [#269](https://github.com/jeetparekh3005/keel/issues/269)


### Miscellaneous Chores

* integrate dev for the v0.3.1 release ([f83b849](https://github.com/jeetparekh3005/keel/commit/f83b84951abab1c485abd04b448f53198e53c823))

## [0.3.0](https://github.com/jeetparekh3005/keel/compare/v0.2.2...v0.3.0) (2026-11-10)


### Features

* **rust:** axum app factory + health endpoints ([#218](https://github.com/jeetparekh3005/keel/issues/218)) ([3471552](https://github.com/jeetparekh3005/keel/commit/3471552031b29540784dde4edc52817ecfdd56f1))
* **rust:** axum auth extractor + scope enforcement + problem+json ([#223](https://github.com/jeetparekh3005/keel/issues/223)) ([2eaeb1c](https://github.com/jeetparekh3005/keel/commit/2eaeb1ceb23215c893002dc93187c4a95747d27e))
* **rust:** config loader + RFC 9457 error model + domain taxonomy ([#216](https://github.com/jeetparekh3005/keel/issues/216)) ([2da694e](https://github.com/jeetparekh3005/keel/commit/2da694e9dfcb7cf6ac82319133583ef75f8888ce))
* **rust:** container image, Helm chart, and supply-chain CI for the Rust service ([#227](https://github.com/jeetparekh3005/keel/issues/227)) ([b4d0248](https://github.com/jeetparekh3005/keel/commit/b4d0248c88e43ac4487dd4fe8087aea2806adfdf)), closes [#214](https://github.com/jeetparekh3005/keel/issues/214)
* **rust:** driven-port traits, test-kit fakes, and the conformance suite ([#222](https://github.com/jeetparekh3005/keel/issues/222)) ([004a009](https://github.com/jeetparekh3005/keel/commit/004a0093ddb558d42dec45069493b7e5c2db88ed))
* **rust:** edge middleware stack (headers, body limit, request-id, CORS) ([#219](https://github.com/jeetparekh3005/keel/issues/219)) ([68d88f2](https://github.com/jeetparekh3005/keel/commit/68d88f230fd8e907848739f92f6a1c680d8c9c84)), closes [#208](https://github.com/jeetparekh3005/keel/issues/208) [#36](https://github.com/jeetparekh3005/keel/issues/36)
* **rust:** JWKS-over-HTTPS signing-key cache and resolver ([#224](https://github.com/jeetparekh3005/keel/issues/224)) ([965265c](https://github.com/jeetparekh3005/keel/commit/965265c3556e99efa4237d148e91475862ee0fa5)), closes [#209](https://github.com/jeetparekh3005/keel/issues/209) [#36](https://github.com/jeetparekh3005/keel/issues/36)
* **rust:** OIDC/JWT authenticator with full verification matrix ([#220](https://github.com/jeetparekh3005/keel/issues/220)) ([b5689e3](https://github.com/jeetparekh3005/keel/commit/b5689e35eee3b9b4e8dcc11055966c042a224277)), closes [#209](https://github.com/jeetparekh3005/keel/issues/209) [#36](https://github.com/jeetparekh3005/keel/issues/36)
* **rust:** OpenTelemetry setup (traces + resource + log correlation) ([#226](https://github.com/jeetparekh3005/keel/issues/226)) ([e538d96](https://github.com/jeetparekh3005/keel/commit/e538d9655bbef878c1de8e13d995e38d781921c6)), closes [#207](https://github.com/jeetparekh3005/keel/issues/207) [#36](https://github.com/jeetparekh3005/keel/issues/36)
* **rust:** reference-service-rust (items aggregate) + composition root ([#225](https://github.com/jeetparekh3005/keel/issues/225)) ([a07f8f9](https://github.com/jeetparekh3005/keel/commit/a07f8f9de01ce81da6321fc4bd1ba6d50fea75c9)), closes [#212](https://github.com/jeetparekh3005/keel/issues/212) [#36](https://github.com/jeetparekh3005/keel/issues/36)
* **rust:** scaffold keel-core-rust workspace + CI lane ([#215](https://github.com/jeetparekh3005/keel/issues/215)) ([41e6342](https://github.com/jeetparekh3005/keel/commit/41e63424ace8d0cf3d6cbabb50368114ea14d167))
* **rust:** sqlx persistence plumbing (Database + UnitOfWork) ([#221](https://github.com/jeetparekh3005/keel/issues/221)) ([29b7bb8](https://github.com/jeetparekh3005/keel/commit/29b7bb898b90313c53f7c97f2cb174233ac2f6f5))
* **rust:** structured JSON logging adapter ([#217](https://github.com/jeetparekh3005/keel/issues/217)) ([ce44503](https://github.com/jeetparekh3005/keel/commit/ce44503ebd3fdc5ea3246b026cc639e8c8b8ad3c))


### Bug Fixes

* **rust:** harden JWKS, error handling, edge, and auth-parity from the audit ([#255](https://github.com/jeetparekh3005/keel/issues/255)) ([313cde1](https://github.com/jeetparekh3005/keel/commit/313cde10029dea5c7861891d3cf7104dae62cd99)), closes [#245](https://github.com/jeetparekh3005/keel/issues/245) [#233](https://github.com/jeetparekh3005/keel/issues/233) [#235](https://github.com/jeetparekh3005/keel/issues/235) [#231](https://github.com/jeetparekh3005/keel/issues/231) [#232](https://github.com/jeetparekh3005/keel/issues/232) [#234](https://github.com/jeetparekh3005/keel/issues/234) [#236](https://github.com/jeetparekh3005/keel/issues/236) [#246](https://github.com/jeetparekh3005/keel/issues/246) [#238](https://github.com/jeetparekh3005/keel/issues/238) [#254](https://github.com/jeetparekh3005/keel/issues/254) [#250](https://github.com/jeetparekh3005/keel/issues/250) [#237](https://github.com/jeetparekh3005/keel/issues/237)


### Miscellaneous Chores

* integrate dev for the v0.3.0 release ([8c8ddb4](https://github.com/jeetparekh3005/keel/commit/8c8ddb42993f4e73023a8863725f5cc5d5fedeff))

## [0.2.2](https://github.com/jeetparekh3005/keel/compare/v0.2.1...v0.2.2) (2026-11-05)


### Features

* **platform:** expand the behavioral contract-conformance suite ([#197](https://github.com/jeetparekh3005/keel/issues/197)) ([39a2e64](https://github.com/jeetparekh3005/keel/commit/39a2e64f871af825c79e49cb52dddc123edc60b8)), closes [#158](https://github.com/jeetparekh3005/keel/issues/158) [#174](https://github.com/jeetparekh3005/keel/issues/174)


### Bug Fixes

* **auth:** map OIDC key-resolution failures to 401/503, not 500 ([#175](https://github.com/jeetparekh3005/keel/issues/175)) ([1158dcf](https://github.com/jeetparekh3005/keel/commit/1158dcf043e904d1de01ccc7e03ead1b82f0ec22)), closes [#160](https://github.com/jeetparekh3005/keel/issues/160) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **ci:** close two signed-image supply-chain holes ([#178](https://github.com/jeetparekh3005/keel/issues/178)) ([afe9d08](https://github.com/jeetparekh3005/keel/commit/afe9d0823ef961720ed62804daf49c678d0135a5)), closes [#162](https://github.com/jeetparekh3005/keel/issues/162) [#163](https://github.com/jeetparekh3005/keel/issues/163) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **ci:** drop the branch scope from the release PR title ([#200](https://github.com/jeetparekh3005/keel/issues/200)) ([218e598](https://github.com/jeetparekh3005/keel/commit/218e598e950d7733937979c033d8d1b33b5a032b))
* **ci:** gate signing on unfixed CVEs; correct image SBOM format to SPDX ([#191](https://github.com/jeetparekh3005/keel/issues/191)) ([aa01816](https://github.com/jeetparekh3005/keel/commit/aa01816346068b85b9af7725264ff59544f0919f)), closes [#186](https://github.com/jeetparekh3005/keel/issues/186) [#187](https://github.com/jeetparekh3005/keel/issues/187) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **platform:** real default-deny NetworkPolicy, availability, CI policy gate ([#195](https://github.com/jeetparekh3005/keel/issues/195)) ([e366bbe](https://github.com/jeetparekh3005/keel/commit/e366bbe02e0d0115c4241e93687d73772390a300))
* **platform:** reconcile the http contract with reality ([#180](https://github.com/jeetparekh3005/keel/issues/180)) ([063399f](https://github.com/jeetparekh3005/keel/commit/063399f308687a80692da5f9a8bd82911a1d8c3a)), closes [#166](https://github.com/jeetparekh3005/keel/issues/166) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **python:** commit UnitOfWork unconditionally on clean exit (data-loss regression) ([#198](https://github.com/jeetparekh3005/keel/issues/198)) ([a673e52](https://github.com/jeetparekh3005/keel/commit/a673e5267209874ea6618daff22ffd341ef06a4d))
* **python:** correct DB pool saturation gauge (idle, denominator, semconv) ([#192](https://github.com/jeetparekh3005/keel/issues/192)) ([7352e4c](https://github.com/jeetparekh3005/keel/commit/7352e4cf376d8b7ad1094d4d90f533ee3e17d02d)), closes [#167](https://github.com/jeetparekh3005/keel/issues/167) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **python:** drop the duplicate HTTP duration histogram ([#176](https://github.com/jeetparekh3005/keel/issues/176)) ([93ebbb5](https://github.com/jeetparekh3005/keel/commit/93ebbb5ac0ea0b6d18a7d00f8c474c5dca3c6637)), closes [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **python:** guard the ports package with import-linter ([#177](https://github.com/jeetparekh3005/keel/issues/177)) ([91817a1](https://github.com/jeetparekh3005/keel/commit/91817a15cad0034c679077c88c26020c2d2c6233)), closes [#165](https://github.com/jeetparekh3005/keel/issues/165) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **python:** keep the log writer alive on sink errors; never hang shutdown ([#189](https://github.com/jeetparekh3005/keel/issues/189)) ([32d44db](https://github.com/jeetparekh3005/keel/commit/32d44db2e9eb1ec811da5679f83e4adc7f15433f)), closes [#184](https://github.com/jeetparekh3005/keel/issues/184) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **python:** never drop a poison NATS message silently ([#179](https://github.com/jeetparekh3005/keel/issues/179)) ([e41e1a8](https://github.com/jeetparekh3005/keel/commit/e41e1a819b2d9de6b43777a772c0eefddb7cd73b))
* **python:** reliability robustness (streaming contextvar, lifespan, read-only UoW) ([#193](https://github.com/jeetparekh3005/keel/issues/193)) ([ae9b2bf](https://github.com/jeetparekh3005/keel/commit/ae9b2bf7402a6c01ef56e998f58fda1e77b6bf11)), closes [#171](https://github.com/jeetparekh3005/keel/issues/171) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **security:** default environment to production (fail closed) ([#190](https://github.com/jeetparekh3005/keel/issues/190)) ([a1b9b32](https://github.com/jeetparekh3005/keel/commit/a1b9b3277f204af75539aceda86d8876aaa72690)), closes [#185](https://github.com/jeetparekh3005/keel/issues/185) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **security:** defense-in-depth defaults (XFF key, request-id, WS conformance) ([#194](https://github.com/jeetparekh3005/keel/issues/194)) ([51d7643](https://github.com/jeetparekh3005/keel/commit/51d7643d73e1eb2fd45b2ee92f97d078a553176c)), closes [#173](https://github.com/jeetparekh3005/keel/issues/173) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **ts:** add security headers and a deny-by-default CSP to the web app ([#181](https://github.com/jeetparekh3005/keel/issues/181)) ([36b1b41](https://github.com/jeetparekh3005/keel/commit/36b1b419fb5f1e926d5183651d1b7746f3dabc19)), closes [#168](https://github.com/jeetparekh3005/keel/issues/168) [#174](https://github.com/jeetparekh3005/keel/issues/174)
* **ts:** nonce-based CSP so the strict policy does not block Next hydration ([#188](https://github.com/jeetparekh3005/keel/issues/188)) ([623dfa5](https://github.com/jeetparekh3005/keel/commit/623dfa509f28056927721d4f7c4f49853b5df730)), closes [#183](https://github.com/jeetparekh3005/keel/issues/183) [#174](https://github.com/jeetparekh3005/keel/issues/174)

## [0.2.1](https://github.com/jeetparekh3005/keel/compare/v0.2.0...v0.2.1) (2026-11-04)


### Features

* **auth:** gRPC scope authorization, principal propagation, streaming-safe reject ([#139](https://github.com/jeetparekh3005/keel/issues/139)) ([3c4bd55](https://github.com/jeetparekh3005/keel/commit/3c4bd5526d04274b12adb91ad51bcb5af79c08f6)), closes [#121](https://github.com/jeetparekh3005/keel/issues/121) [#132](https://github.com/jeetparekh3005/keel/issues/132)
* **platform:** add http edge-security to the contract; bump contractVersion ([#151](https://github.com/jeetparekh3005/keel/issues/151)) ([ab735af](https://github.com/jeetparekh3005/keel/commit/ab735af663801c381f8ea976a385917d0cd53a22)), closes [#130](https://github.com/jeetparekh3005/keel/issues/130) [#132](https://github.com/jeetparekh3005/keel/issues/132)


### Bug Fixes

* **ci:** gate image publish on non-PR event (reusable-workflow fix) ([#113](https://github.com/jeetparekh3005/keel/issues/113)) ([cb267f3](https://github.com/jeetparekh3005/keel/commit/cb267f3ef5b70f69bd3dbaa91e5d8f6901efa9ff)), closes [#24](https://github.com/jeetparekh3005/keel/issues/24)
* **ci:** trace greenlet/thread execution in coverage ([#136](https://github.com/jeetparekh3005/keel/issues/136)) ([fb9ea88](https://github.com/jeetparekh3005/keel/commit/fb9ea886fecfd623fa99156d5d361e622eda5311)), closes [#123](https://github.com/jeetparekh3005/keel/issues/123) [#132](https://github.com/jeetparekh3005/keel/issues/132)
* **ci:** Trivy-scan the release image before cosign sign ([#135](https://github.com/jeetparekh3005/keel/issues/135)) ([a51fc6e](https://github.com/jeetparekh3005/keel/commit/a51fc6ea600bb1ba2b37fe54649dd31baa7b8df9)), closes [#117](https://github.com/jeetparekh3005/keel/issues/117) [#132](https://github.com/jeetparekh3005/keel/issues/132)
* **platform:** make the Helm chart deployable and tighten NetworkPolicy ([#133](https://github.com/jeetparekh3005/keel/issues/133)) ([aafec7c](https://github.com/jeetparekh3005/keel/commit/aafec7cd1e85966cb8a1f8a8995423db30cb1894)), closes [#115](https://github.com/jeetparekh3005/keel/issues/115) [#116](https://github.com/jeetparekh3005/keel/issues/116) [#132](https://github.com/jeetparekh3005/keel/issues/132)
* **python:** durable NATS consumer with correct ack/nak/DLQ handling ([#138](https://github.com/jeetparekh3005/keel/issues/138)) ([8bcbef4](https://github.com/jeetparekh3005/keel/commit/8bcbef46fd221ca44008ca9beb1993e9053e04bf)), closes [#120](https://github.com/jeetparekh3005/keel/issues/120) [#132](https://github.com/jeetparekh3005/keel/issues/132)
* **python:** order middleware so metrics/request-id wrap rejections ([#147](https://github.com/jeetparekh3005/keel/issues/147)) ([e9cb71c](https://github.com/jeetparekh3005/keel/commit/e9cb71c8f246b726cfd9d7d168073f4eed43df3c)), closes [#126](https://github.com/jeetparekh3005/keel/issues/126) [#132](https://github.com/jeetparekh3005/keel/issues/132)
* **python:** rate limiter XFF-aware key + LRU-bounded state ([#137](https://github.com/jeetparekh3005/keel/issues/137)) ([3042431](https://github.com/jeetparekh3005/keel/commit/304243117378adfa47f99a063c8dc58faff46412)), closes [#122](https://github.com/jeetparekh3005/keel/issues/122) [#132](https://github.com/jeetparekh3005/keel/issues/132)
* **security:** honor forwarded headers (HSTS behind proxy) + TrustedHost ([#148](https://github.com/jeetparekh3005/keel/issues/148)) ([b910d4b](https://github.com/jeetparekh3005/keel/commit/b910d4b4058e7095ea21a9ae94bc14b395eb2d61)), closes [#127](https://github.com/jeetparekh3005/keel/issues/127) [#132](https://github.com/jeetparekh3005/keel/issues/132)

## [0.2.0](https://github.com/jeetparekh3005/keel/compare/v0.1.3...v0.2.0) (2026-11-04)


### Features

* **auth:** api_key and mTLS credential types ([#101](https://github.com/jeetparekh3005/keel/issues/101)) ([f8a9fd8](https://github.com/jeetparekh3005/keel/commit/f8a9fd837cc498b9d562ed5a5b008fd8abbab3a5)), closes [#25](https://github.com/jeetparekh3005/keel/issues/25) [#35](https://github.com/jeetparekh3005/keel/issues/35)
* **platform:** hardened Helm chart for the reference service ([#105](https://github.com/jeetparekh3005/keel/issues/105)) ([1f547f3](https://github.com/jeetparekh3005/keel/commit/1f547f3a9d1a452c51015d8c4d31e4b120966009)), closes [#23](https://github.com/jeetparekh3005/keel/issues/23) [#35](https://github.com/jeetparekh3005/keel/issues/35)
* **platform:** NATS JetStream MessageBus adapter ([#103](https://github.com/jeetparekh3005/keel/issues/103)) ([670532a](https://github.com/jeetparekh3005/keel/commit/670532a4013c3ac59ecd9b39b30317662ec8c71c)), closes [#26](https://github.com/jeetparekh3005/keel/issues/26) [#35](https://github.com/jeetparekh3005/keel/issues/35)
* **security:** default-deny CORS policy ([#102](https://github.com/jeetparekh3005/keel/issues/102)) ([3b5c002](https://github.com/jeetparekh3005/keel/commit/3b5c002858f93d37c3dd169fb2edf90e1e05b709)), closes [#33](https://github.com/jeetparekh3005/keel/issues/33) [#35](https://github.com/jeetparekh3005/keel/issues/35)
* **ts:** Next.js frontend in a Turborepo monorepo ([#107](https://github.com/jeetparekh3005/keel/issues/107)) ([4e8f6cc](https://github.com/jeetparekh3005/keel/commit/4e8f6cce264960aae5e43f5bc9adcecc50fd52b5)), closes [#22](https://github.com/jeetparekh3005/keel/issues/22) [#35](https://github.com/jeetparekh3005/keel/issues/35)


### Bug Fixes

* **ci:** publish image from release-please run, not an on:release trigger ([#100](https://github.com/jeetparekh3005/keel/issues/100)) ([93a60eb](https://github.com/jeetparekh3005/keel/commit/93a60ebea14e75275e6809c995db1f75601c50a9)), closes [#24](https://github.com/jeetparekh3005/keel/issues/24)


### Documentation

* point ROADMAP v0.1 at v0.1.3 ([#111](https://github.com/jeetparekh3005/keel/issues/111)) ([34fc32c](https://github.com/jeetparekh3005/keel/commit/34fc32c65e795de3ca75d190864439ff33fe4fa9))

## [0.1.3](https://github.com/jeetparekh3005/keel/compare/v0.1.2...v0.1.3) (2026-11-04)


### Features

* **ci:** image publish pipeline - build, Trivy scan, GHCR push, keyless cosign + attest ([#97](https://github.com/jeetparekh3005/keel/issues/97)) ([2c34fc6](https://github.com/jeetparekh3005/keel/commit/2c34fc62644faf236ca24f11a1ca4ed6af909d89)), closes [#24](https://github.com/jeetparekh3005/keel/issues/24) [#35](https://github.com/jeetparekh3005/keel/issues/35)


### Miscellaneous Chores

* release v0.1.3 (dev to main) ([#98](https://github.com/jeetparekh3005/keel/issues/98)) ([acb937b](https://github.com/jeetparekh3005/keel/commit/acb937b546eebc000d967178802db6dce89d5f9d))

## [0.1.2](https://github.com/jeetparekh3005/keel/compare/v0.1.1...v0.1.2) (2026-11-04)


### Features

* **python:** add saturation signals (DB pool gauge, dropped-log counter) ([#86](https://github.com/jeetparekh3005/keel/issues/86)) ([806f55f](https://github.com/jeetparekh3005/keel/commit/806f55fe9879b4a5d3edac11a96be7e16a5a4fb8)), closes [#67](https://github.com/jeetparekh3005/keel/issues/67) [#73](https://github.com/jeetparekh3005/keel/issues/73)
* **python:** API maturity - invalid-params, versioning, list envelope, Location ([#88](https://github.com/jeetparekh3005/keel/issues/88)) ([d854ecb](https://github.com/jeetparekh3005/keel/commit/d854ecbb3340d28bde62ad182a50d4653ed9166c)), closes [#69](https://github.com/jeetparekh3005/keel/issues/69) [#73](https://github.com/jeetparekh3005/keel/issues/73)
* **security:** opt-in per-instance request rate limiting ([#90](https://github.com/jeetparekh3005/keel/issues/90)) ([0cfdaaa](https://github.com/jeetparekh3005/keel/commit/0cfdaaa6d987804271c0eec1a1b8ebed6f1333df)), closes [#71](https://github.com/jeetparekh3005/keel/issues/71) [#73](https://github.com/jeetparekh3005/keel/issues/73)


### Bug Fixes

* **python:** align HTTP metrics with OpenTelemetry semantic conventions ([#85](https://github.com/jeetparekh3005/keel/issues/85)) ([4f38e4a](https://github.com/jeetparekh3005/keel/commit/4f38e4a73afbb31108631aa59e92df0bbddc8ed9)), closes [#66](https://github.com/jeetparekh3005/keel/issues/66) [#73](https://github.com/jeetparekh3005/keel/issues/73)
* **security:** env-gate insecure transports; add CSP/Permissions-Policy; conditional HSTS ([#89](https://github.com/jeetparekh3005/keel/issues/89)) ([049cd35](https://github.com/jeetparekh3005/keel/commit/049cd352e9223f0791c4869b800ea16855bb4139)), closes [#70](https://github.com/jeetparekh3005/keel/issues/70) [#73](https://github.com/jeetparekh3005/keel/issues/73)


### Miscellaneous Chores

* release v0.1.2 (dev to main) ([#92](https://github.com/jeetparekh3005/keel/issues/92)) ([954e53d](https://github.com/jeetparekh3005/keel/commit/954e53db9f012fe5d234897c74fc7adf503158cb))

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
* **python:** complete slice 6 - contract suite, migrations, image, compose ([#16](https://github.com/jeetparekh3005/keel/issues/16)) ([b01223c](https://github.com/jeetparekh3005/keel/commit/b01223c85cff81d4a8f6474906d1c848c8c2a265))
* **python:** complete Track B - authz, edge hardening, metrics, security gates, integration ([#19](https://github.com/jeetparekh3005/keel/issues/19)) ([5f5b1af](https://github.com/jeetparekh3005/keel/commit/5f5b1af13f1d540fb02a3bc2a5e240a83f232719))
* **python:** FastAPI app factory with problem+json, health, deny-by-default auth ([#11](https://github.com/jeetparekh3005/keel/issues/11)) ([64ec947](https://github.com/jeetparekh3005/keel/commit/64ec947ae606c7d41510a3187b9bc006a974a316))
* **python:** graceful shutdown, non-blocking app logger, batch spans, DB pool tuning ([#18](https://github.com/jeetparekh3005/keel/issues/18)) ([b673ff3](https://github.com/jeetparekh3005/keel/commit/b673ff3837793d252d9520510e44ef5bc00b7ea8))
* **python:** hardening round 2 - enforce deny-by-default, cardinality, async auth, redaction ([#20](https://github.com/jeetparekh3005/keel/issues/20)) ([f8f666d](https://github.com/jeetparekh3005/keel/commit/f8f666df9e75e512686ee567cf96306a1a6bccc7))
* **python:** keel-core ports, cross-cutting adapters, config, and test kit ([#10](https://github.com/jeetparekh3005/keel/issues/10)) ([2c5057b](https://github.com/jeetparekh3005/keel/commit/2c5057b3a3235b0ed031afcc5d9baf764bf4f918))
* **python:** OIDC JWT authenticator and SecretProvider (env adapter) ([#13](https://github.com/jeetparekh3005/keel/issues/13)) ([cd9ff73](https://github.com/jeetparekh3005/keel/commit/cd9ff73012860a9a2333e3ef70f641b4bbce8df7))
* **python:** reference service on keel-core (proves the contract) ([#15](https://github.com/jeetparekh3005/keel/issues/15)) ([a12f885](https://github.com/jeetparekh3005/keel/commit/a12f88575642758d8de8cee7b02f0dc75171b966))
* **python:** scaffold uv workspace and enforcement tooling ([#9](https://github.com/jeetparekh3005/keel/issues/9)) ([343efe9](https://github.com/jeetparekh3005/keel/commit/343efe9fd6e31fd82d3a24a1634f26d61f1f8fbf))
* **python:** slice 5 - distributed tracing, gRPC, and MessageBus ([#14](https://github.com/jeetparekh3005/keel/issues/14)) ([cd53de7](https://github.com/jeetparekh3005/keel/commit/cd53de7984cbd685c38ce31bb3c81349ded1e8f8))

## Changelog

All notable changes to this project are documented in this file.

This file is maintained automatically by [release-please](https://github.com/googleapis/release-please) based on [Conventional Commits](https://www.conventionalcommits.org/). Do not edit it by hand.

## 0.1.0 (2026-11-03)


### Features

* **platform:** define platform.yaml contract and port interfaces ([#7](https://github.com/jeetparekh3005/keel/issues/7)) ([cd6135a](https://github.com/jeetparekh3005/keel/commit/cd6135a04537c8aa4ab98a4ab14e69f871209f39))
* **python:** async SQLAlchemy persistence (Repository port, Database, UoW) ([#12](https://github.com/jeetparekh3005/keel/issues/12)) ([c001f91](https://github.com/jeetparekh3005/keel/commit/c001f915366dc94f5a73b38d017e42947e0f05e2))
* **python:** complete slice 6 - contract suite, migrations, image, compose ([#16](https://github.com/jeetparekh3005/keel/issues/16)) ([b01223c](https://github.com/jeetparekh3005/keel/commit/b01223c85cff81d4a8f6474906d1c848c8c2a265))
* **python:** complete Track B - authz, edge hardening, metrics, security gates, integration ([#19](https://github.com/jeetparekh3005/keel/issues/19)) ([5f5b1af](https://github.com/jeetparekh3005/keel/commit/5f5b1af13f1d540fb02a3bc2a5e240a83f232719))
* **python:** FastAPI app factory with problem+json, health, deny-by-default auth ([#11](https://github.com/jeetparekh3005/keel/issues/11)) ([64ec947](https://github.com/jeetparekh3005/keel/commit/64ec947ae606c7d41510a3187b9bc006a974a316))
* **python:** graceful shutdown, non-blocking app logger, batch spans, DB pool tuning ([#18](https://github.com/jeetparekh3005/keel/issues/18)) ([b673ff3](https://github.com/jeetparekh3005/keel/commit/b673ff3837793d252d9520510e44ef5bc00b7ea8))
* **python:** hardening round 2 - enforce deny-by-default, cardinality, async auth, redaction ([#20](https://github.com/jeetparekh3005/keel/issues/20)) ([f8f666d](https://github.com/jeetparekh3005/keel/commit/f8f666df9e75e512686ee567cf96306a1a6bccc7))
* **python:** keel-core ports, cross-cutting adapters, config, and test kit ([#10](https://github.com/jeetparekh3005/keel/issues/10)) ([2c5057b](https://github.com/jeetparekh3005/keel/commit/2c5057b3a3235b0ed031afcc5d9baf764bf4f918))
* **python:** OIDC JWT authenticator and SecretProvider (env adapter) ([#13](https://github.com/jeetparekh3005/keel/issues/13)) ([cd9ff73](https://github.com/jeetparekh3005/keel/commit/cd9ff73012860a9a2333e3ef70f641b4bbce8df7))
* **python:** reference service on keel-core (proves the contract) ([#15](https://github.com/jeetparekh3005/keel/issues/15)) ([a12f885](https://github.com/jeetparekh3005/keel/commit/a12f88575642758d8de8cee7b02f0dc75171b966))
* **python:** scaffold uv workspace and enforcement tooling ([#9](https://github.com/jeetparekh3005/keel/issues/9)) ([343efe9](https://github.com/jeetparekh3005/keel/commit/343efe9fd6e31fd82d3a24a1634f26d61f1f8fbf))
* **python:** slice 5 - distributed tracing, gRPC, and MessageBus ([#14](https://github.com/jeetparekh3005/keel/issues/14)) ([cd53de7](https://github.com/jeetparekh3005/keel/commit/cd53de7984cbd685c38ce31bb3c81349ded1e8f8))
