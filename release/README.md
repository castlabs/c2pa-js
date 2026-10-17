# Castlabs VSI Bundle Preparation

`castlabs-vsi-bundle.yml` is separate from the stable release path. It prepares
bundle **1.0.8**, not four packages versioned 1.0.8. The input manifest records
the actual types 0.7.5, WASM 0.13.2, utilities 0.3.1 and web 0.15.3 versions;
the private Node package is excluded. Tarball dependencies use absolute
`https://github.com/castlabs/c2pa-js/releases/download/v1.0.8/` URLs.

## Publication Is Blocked

The API source still pins SDK `afd6fffe5a066e0b5b1a14f3f8c7ac189e7f0c95`.
It is **pre-integration**, not the final 1.0.8 release SDK. SDK PRs 27/28/29,
including the additional ZIP 9.0.4 security fix in PR 27, are being integrated
and qualified separately. This change does not select any SDK PR head, edit SDK
dependencies, merge SDK work, or authorize release execution.

After the merged SDK functional integration is qualified, the main integration owner must update the
source pin, Cargo lock and this input manifest together. Readiness requires
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

The published Python `0.37.13.dev2` wheel is only an interoperability fixture
generator. Its SHA-256 is checked before a binary-only install. Its fixed SDK
provenance remains `afd6fffe...`, even after the JS SDK pin changes. No native
Python/SDK build is used to generate fixtures.

## CI Gates

- Full SHA source checkout, clean tracked source, exact SDK source/lock/inputs,
  package versions and input/lock/manifest hashes.
- One locked release Cargo WASM build, wasm-bindgen 0.2.129, Binaryen 124,
  generated VSI export checks and SRI via `tools/vsi-bindings.mjs`.
- Locked schema generation, utilities and web builds including the external
  worker. The inherited source test build plugin requires a web-only rebuild
  after Vitest; WASM is not rebuilt.
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
- Sealed evidence, package hashes and checksums are revalidated in the draft
  job along with exact source/profile/readiness. Provenance is unsigned, not
  a cryptographic attestation or reproducible-build claim.

PRs targeting `feat/vsi-browser-api` or the release preparation branch exercise
build-only gates using the PR head, not GitHub's synthetic merge commit.
Manual dispatch requires a full `source_sha` equal to the selected workflow
ref's SHA, `bundle_version: 1.0.8`, and defaults to `publish: false`.

Artifact names include `github.run_attempt`, and publication requires provenance
from that exact workflow run and attempt. For recovery, re-run **all jobs** or
start a fresh dispatch at the same reviewed source. Re-running only a failed
publish job cannot replay an earlier attempt's artifact and fails closed.
Source Vite runs as a direct Node CLI process; its PID is terminated and awaited
before the strict-port installed consumer starts on port 4173.

Only the separate publish job has `contents: write`. It checks both existing
tags and existing releases (API errors fail closed), and creates a new draft
only. It never overwrites a tag/release, publishes npm, or makes a draft public.
Dependency URLs are not usable by public consumers until a later reviewed
publication. No release should be dispatched while inputs are pre-integration.

## Lightweight Local Checks

No Rust build/check/test, dependency installation or browser qualification is
needed locally. Run `node --test tools/vsi-release.test.mjs` with `VSI_TEST_TEMP`
pointing to an existing scratch directory on a disk with space. These tests
only exercise Node helpers, synthetic reports, fixture copying and synthetic
`pnpm pack` operations; they do not claim actual build qualification.
