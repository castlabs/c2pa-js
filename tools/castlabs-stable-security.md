# Stable Bundle Security Assessment

Assessment date: 2026-10-17. **Publication remains blocked.** These dependency
checks and source regressions do not constitute source-wide or binary security
clearance, or qualify new immutable release tarballs.

## Current Candidate

The current candidate combines the initial JS dependency changes below with
stable SDK 0.80 parser backport
`castlabs/c2pa-rs@9b1bc268f3e254abcb942969a8bb991365067717`
([SDK PR #30](https://github.com/castlabs/c2pa-rs/pull/30)). Package versions,
the stable media API and the selected `pdf` feature are preserved. The JS-owned
Cargo.lock is regenerated with a targeted `cargo update -p c2pa`, not copied
from the SDK workspace: lopdf is now 0.42.0 and quick-xml is 0.41.0;
wasm-bindgen remains 0.2.114 to match the workflow CLI.

Hosted SDK run [38994019801](https://github.com/castlabs/c2pa-rs/actions/runs/38994019801)
is green at that exact SDK commit: native SDK tests (1033 passed), actual browser
feature WASM build, and WASM test compilation. It did not execute WASM tests or
browser qualification and does not qualify this JS-owned lock or final tarballs.
The consumer probe also includes the `ESNext.Disposable` correction from
`f3e2907f351ddedb9f2e6f5f43390801640115a5`, with its matching helper regression.
Source approval and its immutable JS SHA are pending review and commit.

Current local verification (2026-10-17):

- Targeted Cargo lock update only, using the existing external C: Cargo cache;
  no local Cargo build, check or test. Current Cargo.lock SHA-256:
  `d20f745802aa9a2e767a5b05784a53e3b0b6d0c9724774918c32e38c763b71c9`.
- `node --check` passes for the release helper, consumer smoke helper and helper
  tests. All seven Node helper tests pass with `CASTLABS_TEST_SOURCE` pointing
  at this worktree; they copy inputs to clean synthetic fixture commits, pack
  dummy output and install only those fixture tarballs, not SDK dependencies.
  They do not compile SDK code or execute real browsers.
- `actionlint .github/workflows/castlabs-stable-bundle.yml` passes. Checking the
  unchanged inherited `release.yml` separately reports the pre-existing missing
  `description` in `.github/actions/install-dependencies/action.yml`; this is
  not a clean inherited-workflow lint claim.
- `git diff --check` passes. No root node_modules reconstruction or fresh
  full-source test, browser, typecheck or scanner run was performed.

No current-candidate scanner rerun or general security clearance is claimed.
The original scan counts and dependency dispositions below are historical,
not findings automatically cleared or reclassified by the new lock. New parser
dependencies and remaining advisories require their own assessment. All local
candidate checks are lightweight; compilation and browsers are CI-only.
Stable manual build dispatch and publication remain blocked while the 1.0.8
release takes priority. This source change authorizes neither.

## Initial JS-Only Scope (Historical)

- Qualified baseline: `castlabs/c2pa-js@c9155528bfea2a61bf388c97e5ed809eeb660aaa`,
  the merge of PR #10 into `feat/stardustproof-c2pa-rs-fork`.
- Original build: [38907039067](https://github.com/castlabs/c2pa-js/actions/runs/38907039067).
- Initial JS-only SDK: `castlabs/c2pa-rs@0aee9d318289ba4a5e0fe9e0fc1ddc59b0632f91`.
- Initial JS-only Cargo.lock SHA-256 (superseded by the current candidate):
  `1b978b0599fa8eaeb6d31b48fd69da371fed7cc46bf2cb1c95c5e590a501405c`.
- Updated pnpm-lock.yaml SHA-256:
  `082a006b3ff547ebd37b87dbad71a243d325988368cee0ade75bc4dd478159e4`.

The JS runtime graph consists of the internal web/WASM/types packages,
`highgain` and `ts-deepmerge`. Vite externalizes the latter two. Nx, Vitest,
Vite and the downloader/extractor are tooling, but their execution can affect
build integrity. A whole-workspace scanner count is not a shipped-runtime count.

## Initial JS Changes And Verification (Historical)

| Component | Qualified baseline | Current lock | Purpose |
| --- | --- | --- | --- |
| ts-deepmerge | 7.0.3 | 8.0.0 | GHSA-87mf-gv2c-c62c, built-in method overrides |
| Vitest/browser/UI/coverage | 3.2.4 | 3.2.7 | Three critical browser/CDP/provider advisories |
| Vite | 6.4.1 | 6.4.4 | Four development-server advisories |
| node-tar | 7.5.7 | 7.5.22 | Nine archive extraction/parsing advisories |

The dependency floors exclude the older versions targeted by these updates.
Package versions and the then-selected SDK pin were unchanged. The Vite server and
browser API now explicitly bind to `127.0.0.1`; the default main Vitest API
remains middleware-only rather than enabling another listener.

The settings tests cover nine unsafe keys with object-valued payloads at the
root and inside builder and trust settings. They check the intermediate object
prototypes as well as the serialized settings; serialization alone could hide
a prototype assignment. Ordinary overrides and trust values are retained. Existing
tests retain URL fetching and trust-anchor-array coverage. A separate negative
control transpiles the unchanged settings implementation and uses each actual
dependency version: six method-override cases fail with 7.0.3, while all nine
pass with 8.0.0. The original three prototype-pollution keys pass with both.
This demonstrates the regression, not a media-file-to-exploit path.

Full source suites with the final dependency versions used Vitest 3.2.7,
Vite 6.4.4 and Playwright 1.58.2:

| Browser | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| Chromium | 48 | 0 | 0 |
| Firefox | 47 | 0 | 1 |
| WebKit | 48 | 0 | 0 |

Firefox's skip is the existing inline-entrypoint exclusion. These browser runs
precede a test-only review follow-up strengthening the unsafe-key payloads and
prototype assertions. That follow-up and its negative control pass in Node;
browser reruns are deferred while the shared host is under memory pressure.
These runs precede the current SDK repin; they do not qualify its production
source/dependencies or the changed WASM input.
The web build, settings-file ESLint and formatting checks, and
`git diff --check` pass.
ESLint's Nx module-boundary rule reports that it is skipped without a cached
project graph; this is not a claim that the full inherited lint CI passed.

Tests reuse the original qualified types and WASM, verified against the original
tarball hashes. WASM SHA-256 is
`a53ae0bf4deededcf41765aa758427bc9e81b5f89a431a9a7deaebc4a3bef885`.
No native/WASM rebuild was performed for that initial JS-only change. The
current SDK repin needs a new WASM build and actual packed-consumer browser
and strict-type checks on its final immutable candidate in CI, after approval.

On a shared build host, use `CARGO_BUILD_JOBS=1` for any subsequent Rust build
and do not overlap it with browser qualification. Check available memory, swap
activity and memory pressure first; defer browsers while other SDK builds are
active or the host is under pressure. Do not rerun completed browser checks
merely to refresh this evidence.

## Original Scanner Results (Not Rerun For The New SDK)

The initial `pnpm 10.15.0 audit --json` reported 171 findings for the baseline and
154 for the JS-only update: 5 critical, 86 high, 60 moderate and 3 low.
Both scanner exits are nonzero. The ts-deepmerge finding, the three critical
Vitest/browser findings, the four original Vite findings and all node-tar
findings are absent from the updated report. This is not a zero-alert result.

The original `cargo-audit 0.22.2` reported 20 vulnerabilities, two unmaintained warnings,
three unsound warnings and two yanked-package warnings for the old JS-owned
Cargo.lock, not the current repin. Its isolated RustSec database is
`f28da8c5d386e507fac79153655184056a20c054` (updated October 16).
Five vulnerability records concern compiled WASM packages; fifteen concern
inactive browser-target dependencies. Compilation alone does not demonstrate
that an advisory's affected operation is reachable.

## Original Runtime Findings And Current Follow-Up

| Package / advisory | Assessment | Required disposition |
| --- | --- | --- |
| lopdf 0.39.0 / RUSTSEC-2026-0187 | The selected `pdf` feature reaches `Document::load_from`; unbounded nesting can exhaust the stack. WASM may trap or lose a worker rather than produce native SIGABRT. | SDK parser fix; advisory lists >=0.42.0. |
| quick-xml 0.39.2 / RUSTSEC-2026-0194 | XMP processing iterates attributes with default duplicate checks, allowing quadratic CPU consumption. XMP can be embedded in BMFF and other media. | SDK parser fix; advisory lists >=0.41.0. |
| quick-xml 0.39.2 / RUSTSEC-2026-0195 | Requires namespace resolution through NsReader; reviewed SDK consumers use plain Reader. | No affected operation identified in reviewed consumers; preserve this scope when changing XML code. |
| crossbeam-epoch 0.9.18 / RUSTSEC-2026-0204 | Compiled through lopdf/rayon; affected invalid-pointer formatting was not demonstrated reachable. | Review/update selected transitive dependency; advisory lists >=0.9.20. |
| rsa 0.9.10 / RUSTSEC-2023-0071 | Timing-observable private-key operations are affected. WASM verification uses public keys; JS signing delegates to a caller callback. | Narrow architectural exception only; it does not clear external signers or private-key services. No patched version listed. |

The original PDF and XML findings blocked general untrusted-input release
clearance. The current SDK selects the listed patched minima for both parsers;
SDK CI covers PDF nesting rejection and XMP attribute regressions. This does not
clear all advisories, new transitive dependencies, the JS-owned graph, or final
browser artifacts. The crossbeam/rsa assessments still need release-owner review.
Disabling PDF changes the supported-format contract and does not fix XML.
A MIME allowlist cannot exclude embedded XMP. A same-worker Promise timeout
cannot interrupt synchronous parser work. External worker termination and
resource limits are containment, not parser fixes.

## Other Original Dependency Dispositions (Historical)

- Native-only `h2`, `rustls` and `rustls-webpki` belong to reqwest's non-WASM
  transport graph; they compile for type generation, not as a shipped native
  service. The browser uses fetch. They are not the C2PA content-certificate
  validator. The locked optional quinn/HTTP3 graph was absent from both builds.
- `proc-macro-error` is compile-time tooling. `ttf-parser` remains a selected
  maintenance risk. The anyhow warning concerns an inactive target-specific
  dependency. Both rand warnings require optional logging not selected by this
  lock. Selected spin 0.9.8 and zip 8.1.0 remain yanked-package warnings.
- The five remaining critical pnpm findings concern `@xhmikosr/decompress`,
  piscina and tinypool. The SWC downloader is not invoked by the direct
  cargo/Vite bundle build; worker-pool gadgets require an upstream pollution
  primitive and attacker-controlled options. No complete exploit chain was
  established. These conditional findings still need release-owner review.
- GHSA-82fw-gwwq-j7x9 remains in Vitest/mocker; the scanner lists >=4.1.11,
  beyond this compatible patch update. No standalone mocker plugin was found
  in SDK sources. Keep test/config inputs trusted and APIs unexposed.
- Nx 21.x advisories concern graph servers, self-hosted caches, hostile
  affected/import refs, shared sockets and migration planning. The stable
  workflow avoids these commands but imports `@nx/devkit` for workspaceRoot.
  Disable the Nx daemon and isolated plugin workers for these direct commands
  in a private environment; review the
  migration to a patched major separately rather than claiming Nx is absent.
- Remaining tooling alerts are retained with dependency paths in the raw
  reports; their function-level reachability was not exhaustively reviewed.
- The nested historical npm lock is not the root pnpm lock used for this build.
  Its older Playwright entries must not be attributed to these test runs.
- Downloaded wasm-bindgen/Binaryen tools and system tar are outside these
  lockfile scans. Recorded download hashes are not independent authentication
  or a binary audit. Existing provenance is unsigned.

## Evidence And Release Gates

Retained local evidence directory: `stable-security-20261017`, alongside the
original `qualified-stable-38907039067` bundle. Important files are
`pnpm-audit-original.json`, `pnpm-audit-candidate.json`,
`cargo-audit-original.json`, `assessment.json`, `assessment-stdout.txt`,
`candidate-verification.json`, `web-build-final.log`, and
`full-final-{chromium,firefox,webkit}.{json,log}`. Reports distinguish the original
qualified source from the initial JS-only patch and the earlier tooling test run;
they do not contain a scan or qualification of the subsequent SDK repin.

1. Review the selected SDK parser backport and the new JS-owned dependency graph,
   preserving stable media behavior. Exact SDK CI is green; JS-owned WASM inputs
   and final browser artifacts still require CI qualification after approval.
2. Resolve or explicitly accept remaining advisory-specific tooling risks;
   run trusted tests in a secret-free environment without port forwarding.
3. Commit an approved source candidate and qualify its exact final tarballs,
   installed bytes, strict consumer types and all three browsers.
4. Obtain explicit approval for the exact release target, assets and text.
   The current workflow builds before publishing a draft; it cannot promote
   an old run simply by toggling `publish`. Any artifact promotion must verify
   hashes and preserve the original source/run provenance.
5. After approved publication, test normal installation from actual release
   URLs without local dependency overrides before shipping the player bundle.

The original assessment made no commit, push, PR, workflow dispatch, tag, release
or npm publication. The current follow-up prepares a source commit and PR only;
it does not authorize merging, manual stable build dispatch or publication.
