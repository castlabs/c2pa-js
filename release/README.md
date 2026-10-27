# Castlabs VSI Bundle Preparation

`castlabs-vsi-bundle.yml` is separate from the stable release path. It prepares
candidate bundle **1.0.9**, not four packages versioned 1.0.9. The input manifest records
the actual types 0.7.5, WASM 0.13.2, utilities 0.3.2 and web 0.15.4 versions;
the private Node package is excluded. Tarball dependencies use absolute
`https://github.com/castlabs/c2pa-js/releases/download/v1.0.9/` URLs.
Bundle **1.0.8** is immutable published history. Its qualification evidence and
published package hashes are not evidence that candidate 1.0.9 has passed.
Qualification must be established by a successful exact-head candidate run, not
by this document or the historical readiness flag.

## Qualified SDK Inputs

The API source and release inputs pin the combined SDK candidate
`6021100cc5060b06061ca15b634281cfeb97c718`, inherited from API commit
`406ba20206eaa8db3dcfa9ea247d6dbb977963c4`. It contains merged SDK PRs
27/28/29, including the ZIP 9.0.4 security fix in PR 27. Exact-source native
qualification [39004446457](https://github.com/castlabs/c2pa-rs/actions/runs/39004446457)
passed on Linux and Windows. API qualification
[39006782520](https://github.com/castlabs/c2pa-js/actions/runs/39006782520)
and the first complete source/installed bundle qualification
[39006953532](https://github.com/castlabs/c2pa-js/actions/runs/39006953532)
also passed against this SDK for the historical 1.0.8 line. The inputs retain `releaseReady: true` and
`sdkStatus: "qualified-functional"`. The final source must still pass the full
workflow with this qualified input snapshot before a draft can be created.
Readiness does not authorize public publication or claim a source-wide security
audit. No individual SDK PR head is used as the release pin.

This release must not change the SDK pin. Advanced native descriptor/range
resolution and sparse APIs require separate approval and are out of scope.
For a separately approved later SDK change, update source/lock/inputs together,
resetting readiness until that exact source is qualified.
Readiness requires
`releaseReady: true`, `sdkStatus: "qualified-functional"`, `qualifiedSdkSha`
matching the new source pin, qualification evidence URLs, and a null publication
blocker. `sdkIntegration` fixes the target to `feat/trusted-vsi-functional` and
requires PRs 27/28/29. The owner must record each reviewed merge commit and the
successful native qualification run ID, head SHA and workflow path. The old API
SDK is explicitly rejected as a ready release pin.

Before draft creation, GitHub API responses must confirm that all three PRs
were merged into that exact repository/target and match the recorded merge
commits. Git ancestry must place all three merges in the selected SDK source
and that source in the functional target history. The recorded native run must
be successful and completed for exactly that source and target branch. API or
Git failures block publication. SDK `main` is not required; neither an arbitrary
functional branch tip nor an individual PR head establishes release readiness.

The published, immutable Python `0.37.13+signer.1.0.9` release is only an
interoperability fixture generator, from source
`98ccd6de63d89eca9c23f27658f6b29fe99daffc` on the same SDK602 source.
GitHub release metadata and schema-2 wheel evidence identify that source;
producer release run
[40427640583](https://github.com/castlabs/c2pa-python/actions/runs/40427640583)
completed successfully. The source lock remains schema 1, with `package` and
`rustSource` objects. The checked source retains `trust.anchors` entries with
`trust_kind`, `trust_uri` and `trust_anchors`, plus the trusted-VSI callback API.

`tools/bmff-exclusion-inputs.mjs --producer-only` authenticates the wheel and
evidence once against `release/bmff-exclusion-inputs.json`; it does not download
the historical 1.0.8 browser artifacts in candidate qualification. CI installs
that exact binary wheel with cbor2 6.1.5 and cryptography 50.0.2 for both VSI and
generic BMFF generation. No native Python/SDK build is used. The Python and
`tmp/bmff-sdk-reference` checkouts provide source/data only.

The VSI generator checks the exact source lock, published evidence, package
version, SDK version and loaded native-library hash. Fixture provenance retains
the six scalar keys `python`, `sdk`, `releaseInputLockSha256`,
`wheelEvidenceSha256`, `wheelSha256` and `nativeSha256`, plus `nativeSource`,
`generatorDependencies` and freshly computed `files` hashes. New signatures,
salts and OCSP times can change fixture bytes; no equality with old fixtures or
reproducible-build claim is assumed.

## CI Gates

- Full SHA source checkout, clean tracked source, exact SDK source/lock/inputs,
  package versions and input/lock/manifest hashes.
- One locked release Cargo WASM build, wasm-bindgen 0.2.129, Binaryen 124,
  generated VSI export checks and SRI via `tools/vsi-bindings.mjs`.
- Locked schema generation, utilities and web builds including the external
  worker. The inherited source test build plugin requires a web-only rebuild
  after Vitest; WASM is not rebuilt.
- Typed settings facade/regression typecheck using `tsconfig.settings.json`
  and the full 105-case utilities unit suite with one worker and no file
  parallelism. Its JSON report is `$RUNNER_TEMP/vsi-bundle/utilities.json`.
- Queue/lifecycle unit tests and full source browser suites in Chromium,
  Firefox and WebKit. Every source test file and all nine fragment cases per
  browser must appear in passing reports. The only permitted skip is the existing
  Firefox `packages/c2pa-web/src/inline.spec.ts` testcase
  `inline entrypoint should work`. Its exact identity/status and summary counters
  are checked. All other skips, pending/todo cases and failures block sealing.
- All 36 source real-crypto VSI cases, including Ed25519, ES256, byte-only core,
  real workers, inline mode, refresh, continuity, strict CSP external workers,
  and actual Reader-await/OCSP queue, drain and disposal gates.
- Exactly four staged tarballs with no lifecycle scripts, development exports,
  private Node package, or workspace dependency URLs.
- An isolated consumer outside the repository, local-only product overrides
  and `--ignore-scripts`. Installed file hashes, dependency graph, package
  exports, TypeScript, WASM compilation and SRI are checked.
- The same 36 real VSI cases and 27 fragment-offset cases run using installed
  package exports, not repository SDK aliases. Only assertions and fixture
  data are copied. The installed fragment tests use the static installed
  `Reader.fromBlobFragment` with an installed `Context` and sixth-argument offset
  options, not the deprecated factory. Source qualification CSP/OCSP middleware
  is reused, but not its repository root, filesystem permissions or resolution.
  Vite's filesystem boundary is the isolated consumer.
- Generic BMFF fixtures and native verdicts generated using the same authenticated
  Python wheel and SDK602 reference data; the consumer authenticates their
  identities against `release/bmff-exclusion-inputs.json`.
  After fresh packing and the VSI installed consumer, the generic consumer runs
  with `--candidate` against those fresh 1.0.9 tarballs, not published 1.0.8
  tarballs. Reports are retained under `$RUNNER_TEMP/vsi-bundle/bmff`; fixture,
  native-verdict and authenticated producer diagnostics are uploaded on failure
  as well as success. Sealing requires 96 native verdicts and 96 browser cases
  per engine (288 total), with no skips or retries. Producer, source, fixture,
  package and report hashes bind this evidence to the fresh candidate.
- Sealed evidence, package hashes and checksums are revalidated in the draft
  job along with exact source/profile/readiness. Provenance is unsigned, not
  a cryptographic attestation or reproducible-build claim.

PRs targeting `feat/live-video-vsi`, `feat/vsi-browser-api`, `ci/vsi-browser-bundle`
or `test-browser-bmff-exclusions` exercise build-only gates using the PR head, not GitHub's
synthetic merge commit.
Manual dispatch requires a full `source_sha` equal to the selected workflow
ref's SHA, `bundle_version: 1.0.9`, and defaults to `publish: false`.

Artifact names include `github.run_attempt`, and publication requires provenance
from that exact workflow run and attempt. For recovery, re-run **all jobs** or
start a fresh dispatch at the same reviewed source. Re-running only a failed
publish job cannot replay an earlier attempt's artifact and fails closed.
Source Vite runs as a direct Node CLI process; its PID is terminated and awaited
before the strict-port installed consumer starts on port 4173. Installed VSI and
generic BMFF consumers run sequentially; the latter uses a copy of the CI-only
localhost certificate, not production credentials.

Only the separate publish job has `contents: write`. It checks both existing
tags and existing releases (API errors fail closed), and creates a new draft
only. It never overwrites a tag/release, publishes npm, or makes a draft public.
Dependency URLs are not usable by public consumers until a later reviewed
publication. No release should be dispatched while inputs are pre-integration.

`bmff-evidence.tar.gz` carries the sealed nested generic reports, corpus and
native verdicts as one release asset. Extract it alongside the other assets
before running `sha256sum -c SHA256SUMS`. The draft upload includes top-level
files only; the archive is checked against each sealed member before upload.
The existing 1.0.8 public-promotion workflow is unchanged and must not be used
for 1.0.9. A fresh main-agent source review and separately reviewed 1.0.9
promotion anchors are required before any public promotion. No public release
is created by preparing or qualifying this candidate.

## Player Handoff

After reviewed public publication, use the following planned URLs (they are
not expected to resolve while the candidate is unpublished):

```text
https://github.com/castlabs/c2pa-js/releases/download/v1.0.9/stardustproof-c2pa-web-0.15.4.tgz
https://github.com/castlabs/c2pa-js/releases/download/v1.0.9/stardustproof-c2pa-utilities-0.3.2.tgz
https://github.com/castlabs/c2pa-js/releases/download/v1.0.9/stardustproof-c2pa-wasm-0.13.2.tgz
https://github.com/castlabs/c2pa-js/releases/download/v1.0.9/stardustproof-c2pa-types-0.7.5.tgz
```

Before publication, qualification uses local overrides for all four tarballs
only in isolated test consumers. Final tarballs retain the absolute 1.0.9 URLs.
The player should verify `SHA256SUMS` and `provenance.json` against the reviewed
source and retain SDK602; unchanged API package versions do not imply reused
WASM bytes. Generic `Valid` means binding validity, not publisher trust, and
multi-leaf deliveries still require per-leaf regrouping as documented in
`bmff-exclusion-qualification.md`.

## Lightweight Local Checks

No Rust build/check/test, dependency installation or browser qualification is
needed locally. Run `node --test tools/vsi-release.test.mjs` with `VSI_TEST_TEMP`
pointing to an existing scratch directory on a disk with space. These tests
only exercise Node helpers, synthetic reports, fixture copying and synthetic
`pnpm pack` operations; they do not claim actual build qualification.
