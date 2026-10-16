# Castlabs VSI Source Preparation

Status: source preparation only, aligned with the planned signer **1.0.8** line.
No new npm release, WASM build, browser VSI validation or player integration is
attested here. Enabling a Rust feature does not export its APIs through WASM.

## Source Identity

| Input                           | Exact selection                            | Meaning                                                                                                              |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| JS base and initial branch HEAD | `e98075e3dd1fb2b14a7048b15bd6368f8beacb13` | Independent `feat/castlabs-live-video-vsi`; retains the fragment-offset work, not the older stable implementation    |
| SDK repository                  | `https://github.com/castlabs/c2pa-rs`      | Canonical Castlabs fork, not the earlier personal preparation fork                                                   |
| SDK revision                    | `afd6fffe5a066e0b5b1a14f3f8c7ac189e7f0c95` | Immutable source commit, SDK `0.92.0-dev`; planned 1.0.8 native source, not an approved immutable dependency release |
| Rust floor                      | `1.96.0`                                   | Existing JS workspace floor, matching the SDK                                                                        |
| Feature                         | `unstable_live_video`                      | Confirmed in this SDK's `sdk/Cargo.toml`; experimental API, not a browser capability claim                           |

Selection was checked on 2026-10-16 against the current preparation worktrees,
read-only:

- `stardustproof-c2pa-signer-release-108/docs/release-1.0.8-preparation.md`
  still identifies `afd6fffe...` as the planned native for pending Python
  `0.37.13.dev2` / `castlabs-v0.37.13.dev2`.
- `c2pa-python-release-dev2/release/castlabs-vsi-inputs.lock.json` names the same
  full native revision and SDK version. Its native feature list includes
  `unstable_live_video`.
- The signer's currently qualified older source remains Python `97c820ef...`
  with Rust `a6d4cdcc...`; its committed Python declaration is still
  `0.37.13.dev0`. These are not substituted for the planned source pin, and
  historical Python/native release facts do not qualify this JS branch.

There was no newer approved immutable dependency selection in those inputs.
The SDK manifest difference from the prior JS pin `5991ca1f...` adds the
live-video feature and optional `p256` dependency. `Cargo.lock` changes only the
SDK source identity and adds its edge to the already locked `p256 0.13.2`;
unrelated dependencies and package versions are not refreshed.

## Product Boundary

The maintained browser product names are `@stardustproof/c2pa-web`,
`@stardustproof/c2pa-wasm`, `@stardustproof/c2pa-types` and
`@stardustproof/c2pa-utilities`. Source imports, build externals, workspace links,
testbed and pending changesets use the same scope. Existing package version
numbers are retained, not selected as new release versions. Historical upstream
changelogs remain unchanged.

`@stardustproof/c2pa-node` stays in the workspace with consistent dependency
names but is `private: true`, excluded from npm publication. Its native binary
distribution is not qualified here. Inherited release workflow package-name
references are aligned only; no workflow is dispatched or publication approved.
Product release controls, version selection and artifact provenance need separate
review before any future publish.

The existing `Reader.fromBlobFragment` / worker / `WasmReader.fromBlobFragment`
offset path is unchanged except package imports. Keep its non-negative safe
integer check and `with_fragment_at_offset_async` SDK call. It validates the
existing fragmented hard-binding path, not stateful VSI continuity. Do not
reinterpret `fragmentBaseOffset` as a live-video capability.

## Required Validator

The next implementation must own a Rust `c2pa::live_video::LiveVideoValidator`
for each logical stream/rendition observation, not construct a new validator for
each media segment. An init Reader by itself is not a live validator.

These public SDK methods were inspected at the full pinned revision in
[`sdk/src/live_video/mod.rs`](https://github.com/castlabs/c2pa-rs/blob/afd6fffe5a066e0b5b1a14f3f8c7ac189e7f0c95/sdk/src/live_video/mod.rs):

| SDK method                         | Responsibility                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `new`                              | Fresh validation state                                                                                             |
| `validate_init_segment`            | Single-track init layout/timing checks; clears key/sequence/replay context, so not a same-stream refresh operation |
| `validate_session_keys`            | Verify session-key shapes and signer bindings using the trusted manifest's label and end-entity certificate        |
| `validate_verifiable_segment_info` | VSI COSE signature, manifest/key eligibility, BMFF hash, track/timing, sequence and EMSG replay checks             |
| `update_vsi_context`               | Atomic replacement of verified init/manifest/key context without losing accepted sequence, replay IDs or coverage  |
| `reset_continuity`                 | Explicit trusted playback observation reset; retains keys, minima, manifest/track binding and coverage             |
| `sequence_coverage`                | Report missing observed ranges separately from segment validity                                                    |

For initial scope, implement VSI (section 19.4), not a silent fallback to
section 19.3's `validate_media_segment`. Manifest-box validation has its own
trusted manifest/assertion prerequisite and predecessor semantics.

### Trust Before Keys

1. Resolve the caller's `Context` asynchronously, including trust material, as
   the current `Reader` does. Snapshot configuration for this validator.
2. Read and verify the complete signed init through
   `Reader::from_context(context).with_stream_async(format, stream).await`.
   Require an active manifest, cryptographic/assertion integrity, applicable init
   hard binding and trusted claim signer. A successfully parsed Reader or
   serialized manifest is not proof of trust. Do not allow disabled verification
   settings to bypass admission.
3. From that same verified Rust Reader, take its active label, typed
   `SessionKeys` assertion via `Manifest::find_assertion`, and end-entity
   certificate from `Manifest::signature_info().cert_chain()`. The chain is PEM;
   decode and select the actual signing leaf DER in Rust. It is deliberately
   skipped in serialized `SignatureInfo`, so JS manifest JSON is insufficient.
   Confirm leaf selection and trust policy with signed fixtures before exporting.
4. Only then call `validate_init_segment` and `validate_session_keys` on a
   candidate validator. Return no usable handle on any admission failure. Never
   accept caller-supplied raw keys, certificate or manifest ID as a substitute
   for verified init context.
5. Check both `Result` and `StatusTracker` failures. Several SDK validation calls
   can return `Ok(())` with failures recorded in aggregating mode; initial key
   setup can retain a valid subset. The browser wrapper must fail closed for
   incomplete/failed admission, rather than treating `Ok` as an all-keys verdict.

Refresh must reverify the replacement init/manifest through the same trust path
before `update_vsi_context`. That method rejects mismatching track/timing and
leaves old state intact on failure. Matching track fields do not establish
logical-stream identity or codec/sample-entry equivalence: the wrapper/player
must enforce that scope. Reinitializing every refresh would erase continuity.
The SDK retains only the new manifest/key context, not old DVR epochs; route old
media to its retained independently trusted context without claiming global
continuity across separately created validators.

### Proposed Public Surface

The names below are a design contract for the next implementation, **not exports
available in this branch**. Final signatures and generated types require compile
and browser tests.

| Layer      | Proposed method                                                                                                          | Implementation boundary                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| WASM       | `WasmLiveVideoValidator.fromInitBytes(format, bytes, contextJson)` and `fromInitBlob(...)`                               | Async verified-init admission above, returning an owned opaque validator          |
| WASM       | `validateSegmentBytes(bytes)` and `validateSegmentBlob(blob)`                                                            | Retain mutable Rust validator; return structured per-call statuses and validity   |
| WASM       | `updateInitBytes(format, bytes)` / `updateInitBlob(...)`                                                                 | Async trusted replacement admission, then `update_vsi_context` on existing state  |
| WASM       | `resetContinuity()`, `sequenceCoverage()`, generated `free()`                                                            | Explicit playback control, serializable coverage and lifecycle cleanup            |
| Worker RPC | `live_fromInit`, `live_validateSegment`, `live_updateInit`, `live_resetContinuity`, `live_sequenceCoverage`, `live_free` | Worker-owned object map with opaque IDs, mirroring Reader ownership               |
| Browser TS | `LiveVideoValidator.fromInit(c2pa, format, init, context)`                                                               | Async factory using `Context.toJson()` and the worker                             |
| Browser TS | `validateSegment(blob)`, `updateInit(format, init)`, `resetContinuity()`, `sequenceCoverage()`, `free()`                 | Promise-based worker operations; no Rust state or raw trusted-key injection in JS |

Use bytes as the shared Rust core and Blob as a worker-side adapter. Keep the
existing browser-independent `WasmReader.fromBytes` contract intact. Add the
wrapper module to `packages/c2pa-wasm/src/lib.rs`, generated bindings, worker
object map in `packages/c2pa-web/src/lib/worker.ts`, typed RPC in
`src/lib/worker/rpc.ts`, and TS exports through `src/common.ts`. Add result types
to the appropriate types/web boundary, not hand-written declarations pretending
that wasm-bindgen generated an API.

The SDK's live methods at this revision are synchronous; init Reader validation
is async. In `session_key_validation.rs`, Ed25519 verification uses
`ed25519-dalek` and other supported algorithms call
`c2pa_raw_crypto::validator_for_signing_alg(...).validate(...)`. Before adding
bindings, compile for `wasm32-unknown-unknown` and execute real Ed25519 and ES256
init/binding/media fixtures in a worker with the selected crypto features.
Do not invent an async SDK live method or infer WebCrypto/browser availability
from native tests. If a required backend is unavailable, that is an explicit
SDK/browser integration blocker, not permission to accept an unchecked signature.

### Continuity And Lifecycle

- Serialize all operations per validator, including async init refresh, reset
  and free; worker RPC handlers can otherwise overlap across awaits. Different
  renditions may validate independently. Reject stale IDs and use after free.
- Keep sequence equality/regression and EMSG replay as failures. Authenticated
  forward gaps are informational coverage, not automatic signature failure or
  proof of malicious removal. Preserve vendor gap/leading-gap status codes.
- Expose `SequenceCoverage` without precision loss: ranges are `u64` and total
  missing is `u128`; specify decimal strings for those fields across RPC/JSON.
  Preserve `ranges_truncated`. Bound result/status retention separately from
  native validator state and document session resource limits.
- Only caller-controlled seek/live-join logic may request `resetContinuity`.
  Never reset automatically on invalid media, network retry, untrusted playlist
  discontinuity or key refresh. Preserve previous failures and coverage.
- Keep a validator per representation and logical observation; do not mix audio,
  video, ABR renditions or unrelated streams. Explicitly define Period changes,
  seek/DVR context selection, cancellation, worker shutdown and obsolete in-flight
  response handling before player rollout. Free every object on teardown.

## Player Migration

The older stable factory API and the modern API are not drop-in equivalents.
Keep this branch independent of the shipped stable line and migrate the player
explicitly; do not change existing factory signatures in source preparation.

- Load JS, worker and WASM from the same reviewed `@stardustproof` artifact set.
  Keep `workerSrc` and strict-CSP `c2pa_worker` hosting aligned with those bytes.
- Replace factory-wide/per-call settings with `new Context(mergedSettings)` and
  await static `Reader` methods. `createC2pa` is the worker runtime, not a mutable
  trust-policy container. Context resolution is async and snapshotted.
- The stable factory accepts settings as argument four and offset options as
  argument five. The modern deprecated factory accepts only the settings argument;
  copying a stable five-argument call can lose the offset. Move the options to
  argument six of the modern static method instead. Do not pass offset options
  as settings or change either factory signature as part of this preparation.
- Continue using Reader for normal manifest/fragment inspection. Once implemented
  and qualified, use the separate stateful live validator for VSI media. Do not
  present an init Reader verdict or fragment Reader success as a VSI verdict.
- Add player tests for ABR isolation, ordered delivery, seeks, DVR, refresh,
  untrusted init, failure display and teardown before enabling the feature.

```ts
// Stable factory, including the optional offset-options argument:
await c2pa.reader.fromBlobFragment(format, init, fragment, settings, {
  fragmentBaseOffset
});

// Modern static Reader, with resolved settings supplied through a Context:
await Reader.fromBlobFragment(
  c2pa,
  format,
  init,
  fragment,
  new Context(settings),
  { fragmentBaseOffset }
);
```

## Verification Gates

Source-only checks, with no install or full build:

```sh
node tools/check-castlabs-source.mjs
cargo metadata --no-deps --locked --offline --format-version 1
git diff --check
```

The namespace check validates product package names, declared imports and pnpm
workspace link targets. Cargo metadata checks workspace manifests; `--no-deps`
does not fully resolve the graph or prove WASM compilation. The scoped lock edit
must still pass full locked dependency resolution on a provisioned machine.

Before calling this a functional VSI browser line, complete a locked WASM build,
bindings generation, targeted existing offset tests, and worker tests covering
trusted/untrusted/tampered init, missing/malformed keys, invalid signer binding,
wrong manifest/track/time, tampered media, sequence/replay/gaps, atomic refresh
failure and success, seek reset, concurrency and free. Include actual signer
1.0.8 candidate artifacts with honest provenance and the supported browser matrix.
Release and player qualification remain separate from this source preparation.
