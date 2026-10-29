# Generic BMFF Browser Qualification

This CI-only lane qualifies ordinary `Reader` and single-file fragment Merkle
binding with generic BMFF exclusions. It is stacked on typed-settings PR #19,
not a VSI producer configuration change. No native source, Cargo pin, release
input, package version, publication, or advanced resolver API is changed.

## Inputs And Scope

`bmff-exclusion-inputs.json` is a **qualification-only** lock. The existing
`castlabs-vsi-inputs.json` release lock remains untouched.

- Browser: four byte-pinned published `v1.0.8` tarballs, JS source `acfa8dd`, SDK
  `6021100cc5060b06061ca15b634281cfeb97c718`.
- Producer: published Linux binary wheel `0.37.13+signer.1.0.9`, wheel SHA-256
  `62eb9eeb3778a1d2e46e66a5c579a6d2886fe378c71f505f957363f4516d229f`,
  Python source `98ccd6de63d89eca9c23f27658f6b29fe99daffc`, same SDK602,
  actual SDK version `0.92.0-dev`.
- Public repository ES256 test credentials only. No TSA, network signing,
  production keys, media encoder, or native compilation. Keys are not copied to
  the generated corpus.
- Binding verification stays enabled. Only credential trust is disabled;
  successful fixtures must be `Valid`, never `Trusted`. This does not qualify
  publisher identity, trust policy, seeking, decoding, or presentation order.

The published browser WASM is unchanged by the new settings declarations. This
is evidence for its Reader behavior, **not qualification of a fresh JS 1.0.9
bundle** or of the typed candidate package. The typed facade has its separate
utilities gate; the final fresh 1.0.9 bundle still needs its release CI gate.

## Matrix

The generator signs ordinary MP4 and a pinned three-fragment synthetic fMP4
source through `Context.from_dict` and `Builder.sign`. Each emitted expectation
is checked first by the published Python Reader, then separately by installed
JS Reader in Chromium, Firefox, and WebKit. The browser rehashes every input
before validation. Tests require specific BMFF/assertion status codes, not any
exception or generic `Invalid` result. There are no retries or skips.

- XPath and repeated instances using custom `tst1`/`tst2` root boxes, not
  default-excluded `free`/`skip` boxes.
- Exact box length and nonmatching length controls.
- Bounded, disjoint, and to-end (`length: 0`) subsets with boundary-adjacent
  included mutations.
- Multiple data predicates, nonmatching instances, predicate changes, and
  changed predicates plus previously excluded payload to prohibit reused coverage.
- Resolver-known FullBox `mfhd` version and exact/masked flags; matching and
  nonmatching controls. Root `mfhd` placement/nonzero reserved flags are synthetic
  resolver probes, not playback-conformance fixtures.
- Every matching rule has excluded-byte edits that must pass and included-byte
  edits that must fail. Default/no-extra-exclusion controls must reject the same
  custom-box payload edits.
- Signed `/tst1` descriptor changed without resigning must fail
  `assertion.hashedURI.mismatch`, independent of the BMFF verdict.
- Complete single-file fMP4, UUID-delimited leaves, leading-`sidx` leaves,
  excluded index redelivery, covered media edits, wrong/missing/zero absolute
  offsets, init-side excluded `sidx` and included `mvhd` edits checked against
  every leaf, and misgrouped versus correctly regrouped candidates.

The complete file is passed contiguously to ordinary `Reader`. Separate fragment
Reader cases distinguish one complete leaf from a multi-leaf contiguous delivery.
SDK602 source inspection indicates the latter must be regrouped: the fragment
verifier hashes the entire supplied stream per selector rather than splitting it.
That expected limitation is checked in CI; it must not be advertised as a passing
multi-leaf player fast path. A leading excluded `sidx` followed by exactly one
complete leaf is the positive candidate. The default, included-`sidx` cut is the
negative control and succeeds only after correct UUID-boundary regrouping.
The `leading-head-valid-init` cases deliberately reuse the same already-validated
UUID init, isolating the candidate's leading box from missing-init coverage.
`merkle-default-included-head-regrouped` uses that identical init and succeeds.

## Running And Evidence

Run only in GitHub Actions using `Castlabs Generic BMFF Exclusions`. A PR targeting
`feat/js-109-builder-exclusions` runs it automatically for these paths. Dispatch
requires a full `source_sha` equal to the selected workflow ref. The workflow is
read-only and has no publish/release job. All signing, installs and browser work
run on CI, with one browser worker and a 35-minute job limit. This lane performs
no native or app build. Other inherited PR workflows are independent.

Artifact name: `bmff-exclusions-<full-head-sha>-attempt-<n>`. GitHub upload v4 makes
each upload immutable; retention is 30 days, so archive a passing artifact for
long-term evidence. Use the artifact ID/run ID and manifest SHA-256, not merely
the branch name. Presence of fixtures alone does not mean qualification passed:
require successful job conclusion and `bmff-reports/qualification.json` with
`passed: true`, all native cases qualified, and `cases * 3` passing browser tests.
The upload's shared path root may retain `bmff-fixtures`/`bmff-reports` prefixes.

`manifest.json` (schema 1) contains:

- `producer`: source/native/binding/generator hashes and signer settings.
- `files`: relative path to `{sha256, bytes}` for every generated asset, including
  `native-verdicts.json` (manifest cannot hash itself).
- `cases`: unique name; `mode: whole` with `file`, or `mode: fragment` with `init`,
  `fragment`, and optional `fragmentBaseOffset`; `expect` has exact state and
  required success/failure and forbidden-failure codes.
- `recipes`: exact native settings and signed descriptors, input hashes and cuts.
- `layout`: box offsets, lengths, headers, and ends; mutation records use
  file-relative offsets and before/after byte values. Fragment base offsets stay
  absolute in the signed whole file.
- `native-verdicts.json`: actual native status lists, per-case qualification, and
  partial failure diagnostics. Expectations are not replaced with observed data.

The browser report attaches actual status lists and checked-byte hashes per
case. The final qualification summary hashes source, harness, manifests, package
graph, installed lock and browser report. Published provenance/fixture metadata
are unsigned evidence, not attestations or proof of reproducible builds. Native
salts/signatures/labels mean rerunning a recipe need not yield the same bytes.

## Player Reuse

Download the exact successful run's artifact with GitHub API/CLI, for example:

```sh
gh run download RUN_ID -R castlabs/c2pa-js -n bmff-exclusions-HEAD_SHA-attempt-1 -D ARTIFACT_DIR
```

Use `bmff-fixtures/manifest.json` and verify its hash against the qualification
summary, then verify every listed file. Feed `init` and `fragment` with the exact
`fragmentBaseOffset` to `Reader.fromBlobFragment`; do not reset offsets after
cutting or excluding a root box. Use the named redelivery, misgrouping and
regrouping cases directly. Never infer exclusion authority from unauthenticated
player-side descriptor parsing or cache a match after a predicate/descriptor
change.

Alternatively, a player CI job can check out the frozen qualification commit and
the two pinned reference SHAs, install only the locked binary wheel, and invoke
`tools/bmff-exclusion-fixtures.py PYTHON_REFERENCE SDK_REFERENCE OUTPUT`. Record
the newly generated manifest hash: it is a new corpus, not byte-identical reuse
of a prior artifact. No production credentials or native build is required.

## Verification Status

At initial submission this is source/static review only. No local signing,
install, build, test, or browser execution was performed. CI results must be
recorded against the actual PR head; historical `v1.0.8` passing reports do not
count as results for this new matrix.
