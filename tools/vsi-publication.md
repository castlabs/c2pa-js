# Existing VSI Release Promotion

The only selectable tags are `v1.0.8` and `v1.0.9`, using the reviewed records
in `vsi-releases.json`. This automation-only change starts from castlabs/main
`65a8c873bc1767818a60993c50345c2257cae51a` on `ci/publish-vsi-1.0.9`.
It does not merge the SDK branch into main or change application products.
Independent review, commits, pushes, PRs, merge and dispatch belong to the parent.
No publication or other remote action is performed by implementing this change.

## Locked Releases

`v1.0.8` retains the original reviewed release ID `415628702`, source and workflow
SHA `acfa8dd64f499e5f0c459e534b5b5d2437fb5197`, run `39009711529`, attempt `1`,
all 17 original asset IDs/sizes, both trust anchors and four package hashes.
An already-public release is verified idempotently, never edited, retagged or
replaced. Its WASM SHA-256 is also recorded in the candidate's reviewed
`release/bmff-exclusion-inputs.json`; it is not a default for another release.

`v1.0.9` is **disabled and not publishable**. Its nineteen top-level filenames
and package versions are fixed, but all final draft identities and byte pins
are deliberately `null`. Merely changing `enabled` to `true` fails validation.
There are no arbitrary repository, version, run, source or descriptor-file inputs.
`confirm_tag` must exactly select an enabled record; no trimming or fallback occurs.

## Complete 1.0.9 Record

The parent must populate the existing `v1.0.9` record from the final successful
workflow-dispatch draft, then independently review the completed record and code:

- Keep `schemaVersion: 1`, tag `v1.0.9`, repository `castlabs/c2pa-js`, SDK
  `6021100cc5060b06061ca15b634281cfeb97c718`, workflow ID `387394909`, path
  `.github/workflows/castlabs-vsi-bundle.yml`, and branch `feat/live-video-vsi`.
- Set `origin.releaseId`, `origin.runId` and `origin.attempt` to positive safe
  JSON integers for the exact draft and original successful attempt, not this
  promotion run or a PR artifact run.
- Set `origin.sourceSha` to the full lowercase 40-hex qualified source and exact
  release target; set `origin.workflowSha` to the original provenance workflow
  SHA, also full lowercase 40-hex. Confirm both against the original build.
- Fill each of the nineteen `assetPins` tuples as
  `["exact-filename", assetId, sizeInBytes, "lowercase-64-hex-sha256"]`.
  Use GitHub asset IDs, positive byte sizes, and independently downloaded hashes
  matching the API's `sha256:<digest>`. Do not add/remove/rename files.
- Fill `anchors.SHA256SUMS` and `anchors["provenance.json"]` as
  `{ "id": assetId, "sha256": "lowercase-64-hex-sha256" }`, matching their
  tuples. These are externally reviewed byte anchors, not hashes learned at
  promotion time.
- Fill the four `packages[].sha256` values from the final draft tarballs,
  matching their asset pins. Versions stay types `0.7.5`, WASM `0.13.2`,
  utilities `0.3.2`, and web `0.15.4`, including exact filenames.
- Set `wasmSha256` from the actual final draft WASM, agreeing with provenance,
  all shipped WASM copies and SRI. Do not assume the 1.0.8 `d69...` hash.
- Only after all evidence and identities are final and independently reviewed,
  set `enabled: true` and merge the reviewed automation/descriptor to main.
  Leave the entire `v1.0.8` record untouched.

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
tests also work after the parent fills and enables the reviewed 1.0.9 record.

Local verification for this task is restricted to `node --check` on the changed
JavaScript modules and `git diff --check`. No local tests, application build,
dependency installation, typecheck, browser or Rust command is authorized.
