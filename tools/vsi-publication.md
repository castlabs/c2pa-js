# Existing VSI Release Promotion

The only selectable tags are `v1.0.8` and `v1.0.9`, using the reviewed records
in `vsi-releases.json`. This automation-only change starts from castlabs/main
`65a8c873bc1767818a60993c50345c2257cae51a` on `ci/publish-vsi-1.0.9`.
It does not merge the SDK branch into main or change application products.
Independent review, commits, pushes, PRs, merge and dispatch belong to the parent.
No publication or remote mutation is performed by implementing this change.

## Locked Releases

`v1.0.8` retains the original reviewed release ID `415628702`, source and workflow
SHA `acfa8dd64f499e5f0c459e534b5b5d2437fb5197`, run `39009711529`, attempt `1`,
all 17 original asset IDs/sizes, both trust anchors and four package hashes.
An already-public release is verified idempotently, never edited, retagged or
replaced. Its WASM SHA-256 is also recorded in the candidate's reviewed
`release/bmff-exclusion-inputs.json`; it is not a default for another release.

`v1.0.9` now has a complete enabled descriptor for the final qualified draft.
This is **not a public release yet**: publication still requires independent
review, merge to main and an explicit main-only promotion dispatch by the parent.
There are no arbitrary repository, version, run, source or descriptor-file inputs.
`confirm_tag` must exactly select an enabled record; no trimming or fallback occurs.

## Final 1.0.9 Draft

Read-only GitHub GETs confirmed the exact successful original workflow-dispatch
run and its `build` and `publish` jobs, plus the draft release metadata:

- Repository `castlabs/c2pa-js`; tag `v1.0.9`; release ID `427935520`.
- Source, release target and provenance workflow SHA:
  `62fad5306933e16633e6787c1bb1d608ce71b851`.
- Original run `40884394612`, attempt `1`, branch `feat/live-video-vsi`, workflow
  ID `387394909`, path `.github/workflows/castlabs-vsi-bundle.yml`.
- Release state at inspection: `draft: true`, `prerelease: false`,
  `immutable: false`. No promotion was dispatched.
- Qualified SDK remains
  `6021100cc5060b06061ca15b634281cfeb97c718`; native qualification remains run
  `39004446457`, attempt `1`.

All nineteen paginated asset API names/IDs/sizes/digests are pinned in
`vsi-releases.json` as `["filename", assetId, sizeInBytes, "64-hex-sha256"]`.
Every size and SHA-256 was compared with the parent's downloaded final draft
files. The provenance package hashes agree with the actual four tarballs:
types `0.7.5`, WASM `0.13.2`, utilities `0.3.2`, web `0.15.4`.
The complete historical `v1.0.8` record is unchanged.

The final byte anchors, also matching asset metadata and local hashes, are:

- `SHA256SUMS`: asset `688733542`, 12,157 bytes,
  SHA-256 `1a5e3733c8cfacfa920ab6b02370bf126f07a07ab97c530ba4e43d21d4542ed7`.
- `provenance.json`: asset `688733608`, 25,723 bytes,
  SHA-256 `d5a551f553a7b6c6f951c8a3a0a916014f9a94ab8367ba15ed7299e81d2c69a0`.
- Actual final provenance WASM SHA-256:
  `d69b9951b8d3b6aef990ae5b61dc75e5d883fbc103898dd8390c8cdcf6ca7094`;
  SRI `sha256-1puZUbjTtq75kK5bYdx15diD+8EDiY3YOQyM3PbKcJQ=`.

The approved `bmff-evidence.tar.gz` is asset `688733547`, 42,287,134 bytes,
SHA-256 `611f1db87ff03385f7c877b751358f4a9758fb1931f6bc96fec7d41b02ac1ae8`.
It exceeds the old 32 MiB `gh` output buffer. Binary downloads now have an
explicit 64 MiB limit; text API responses retain 32 MiB. The parent's measured
48,691,200-byte uncompressed archive fits the unchanged 128 MiB decompression
cap. No build budgets or workflow timeouts were increased. Read-only archive
listing showed only short regular `bmff/...` members, with no path/type anomaly;
the promotion verifier itself was not run locally.

The nineteen top-level files are the four tarballs, `SHA256SUMS`,
`provenance.json`, `tool-versions.json`, `consumer-graph.json`,
`consumer-pnpm-lock.yaml`, `consumer.json`, `installed-offsets.json`,
`installed-vsi.json`, `queue.json`, `source-chromium.json`, `source-firefox.json`,
`source-vsi.json`, `source-webkit.json`, `utilities.json`, and
`bmff-evidence.tar.gz`.

## Promotion Gates

Dispatch `castlabs-vsi-publish-existing.yml` only on main with the exact
`confirm_tag`. The automation checkout is the reviewed main workflow SHA.
The enabled locked descriptor emits `source_sha` via `GITHUB_OUTPUT` before
the separate source checkout. No source ref comes directly from user input,
and no `GITHUB_ENV` or `GITHUB_RUN_*` impersonation is used. Concurrency is per tag.

The verifier requires the exact original successful workflow-dispatch run attempt,
repository and head repository, workflow ID/path, source/branch, and exactly the
successful `build` and `publish` jobs. It imports `verifySource`, `verifyEvidence`
and `validateInputs(true)` from the locked SOURCE checkout, never from main.
It checks the qualified SDK602 metadata and Git ancestry, including native Linux
and Windows qualification run `39004446457`, attempt `1`, without Cargo.

The release is fetched by exact ID, with paginated assets and downloads by ID.
Names, sizes, digests, bytes, exact tag/target and `prerelease: false` are checked.
Both anchors, package hashes, tool versions, original workflow provenance,
source identity, all qualification evidence and canonical `SHA256SUMS` must agree.
The v1.0.8 checksum format remains exactly sixteen sorted top-level basenames.

For v1.0.9, the checksum list additionally includes the exact sealed `bmff/...`
regular files. Before materializing any member, the archive must match its locked
asset digest and sealed archive hash. Read-only inspection validates gzip/tar
headers, header checksums, exact sealed membership and every member's byte hash.
Absolute, traversal, dot/empty-component, duplicate, link, directory, device and
extension members are rejected, as are nonzero trailers. The current SDK producer
uses short regular paths; long-name/PAX extensions are deliberately unsupported.
Only validated regular file bytes are written to the fresh local evidence tree.
The locked source's original `verifyEvidence` assertions are reused, including the
BMFF qualification, reports, fixtures and source hashes. The archive hash is added
to its returned evidence exactly as in the original seal's read-only branch;
`seal`/`guard` are never invoked and provenance/checksums are never rewritten.

Immediately before mutation, release/asset metadata and both downloaded anchor
bytes are rechecked; a draft must still have no existing tag. The only remote
mutation is `gh release edit <selected-tag> --draft=false`. There are no uploads,
repacks, reseals, retags, target edits, provenance rewrites or npm publication.
Afterwards, exact metadata, every downloaded asset's size/bytes and the resolved
tag commit are checked again. A public release skips mutation only after the same
identity, asset, seal and tag verification.

GitHub has no atomic compare-and-publish API. Do not edit the draft concurrently.
A failure after publication does not retract a release; investigate rather than
deleting assets or replacing the tag.

## Anonymous Consumer

A separate read-only job uses the same locked descriptor, with no GitHub/npm
credentials or root user configuration. Its consumer, configuration home and pnpm
`10.15.0` store are fresh, outside the repository, without caches or overrides.
All four final public tarball URLs are roots; no local products, SDK registry
fallbacks or mixed-tag transitive dependencies are accepted. TypeScript `5.8.2`
is an ordinary registry development tool, not an SDK fallback.

It anonymously downloads the pinned provenance and four tarballs, compares the
installed files and dependency graph, and checks exports, resource aliases,
strict types, the actual release-specific WASM digest, SRI and WASM compilation.
The 1.0.9 type consumer also checks optional BMFF settings and rejects a malformed
descriptor. No browser or Rust build is used. New results are workflow artifacts,
never release assets. A failed smoke can be retried in a fresh job after diagnosis;
there is no rollback or clobber path.

## Verification

The existing `ci.yml` `publication-guards` job runs dependency-free automation
tests on PRs with read-only permissions and cannot publish. No duplicate guard
workflow is needed; the existing general CI is unchanged.
The dispatch workflow runs those same tests before selecting a source checkout.

CI runs `node --test tools/vsi-promote.test.mjs`: synthetic positive/negative
coverage for both descriptors, run/attempt/repository/job swaps, exact asset
identities/digests, nested checksum and archive paths/types/bytes, source verifier
reuse, unchanged qualification strictness, public URL graphs, credential rejection
and workflow safety boundaries. Synthetic records cannot enable production;
the enabled actual 1.0.9 descriptor and binary/text/decompression buffer bounds
are covered too. Existing Node 24 assertion diagnostic fixes are preserved.

Local verification uses read-only GitHub GET metadata, file sizes/SHA-256,
provenance/checksum reads and archive listing, plus `node --check` on changed
JavaScript modules and `git diff --check`. No local tests, application build,
dependency installation, typecheck, browser or Rust command is authorized.
