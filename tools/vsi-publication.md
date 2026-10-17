# Existing VSI Draft Publication

Public publication of the existing qualified `v1.0.8` bundle is authorized.
This change must receive fresh review and merge to `main` before dispatching
`castlabs-vsi-publish-existing.yml` on `main` with `confirm_tag=v1.0.8`.
Do not dispatch the build/draft workflow to repack or rebuild these products.

## Fixed Scope

- Repository: `castlabs/c2pa-js`; release ID `415628702`; tag `v1.0.8`.
- Qualified source: `acfa8dd64f499e5f0c459e534b5b5d2437fb5197`.
- SDK: `6021100cc5060b06061ca15b634281cfeb97c718`.
- Original bundle workflow: `.github/workflows/castlabs-vsi-bundle.yml`, ID
  `387394909`, run `39009711529`, attempt `1`, branch `feat/live-video-vsi`.
- Native Linux and Windows qualification: run `39004446457`, attempt `1`.
- Trusted checksum and provenance asset IDs/hashes and all 17 asset IDs/sizes
  are pinned in `vsi-promote.mjs`; all four tarball hashes are pinned there too.

## Gates

The automation checkout is the reviewed main workflow SHA. A separate checkout
is the exact qualified source. The read-only verifier imports that source's
`verifySource`, `verifyEvidence`, and `validateInputs(true)`. It validates the
original run API metadata explicitly, rather than impersonating the old run
through `GITHUB_RUN_*`, calling `guard`, or calling the provenance-writing seal.
The SDK proof uses only API metadata and Git history, never a Rust build.

The workflow fetches the release by ID, paginates assets, downloads by asset ID,
checks both trust anchors, verifies exactly 16 canonical checksum entries and
the qualification seal, and refetches the release, asset metadata and anchor
bytes immediately before publication. A draft must have no existing tag.
The only mutation is `gh release edit v1.0.8 --draft=false`; no uploads, target
changes, prerelease changes, tag writes, repacks, or npm publication are allowed.
After publication, the same release ID/target/assets/bytes must remain and the
tag must resolve to the qualified source commit.

GitHub does not expose an atomic compare-and-publish operation. Do not edit the
draft or assets concurrently with this workflow. Any detected change fails
closed, but a failure after publication does not retract an already public
release. Investigate failures rather than deleting or replacing release assets.

## Anonymous Consumer

A separate read-only job downloads approved bytes anonymously and installs all
four final public tarball URLs as roots with pnpm `10.15.0`. Its consumer,
configuration home and store are fresh and outside the repository. It has no
GitHub/npm credentials, local SDK dependencies, overrides, workspace SDK aliases,
or product caches. TypeScript is an ordinary pinned registry development tool;
SDK registry fallback is rejected throughout the installed graph.

The job checks actual installed files against the approved tarballs, all SDK
graph paths/URLs, module exports, resource aliases, strict TypeScript imports,
WASM SRI and `WebAssembly.compile`. It reuses the qualified consumer's SDK probe
assertions, not its local-override installer. No browser or Cargo is needed.
New evidence is uploaded only as workflow artifacts, not added to the sealed
release or its provenance.

If publication succeeds but the public smoke fails, rerun the workflow after
diagnosis. An already-public release is accepted only after all original
identity, asset, seal and tag checks pass, and mutation is skipped. The smoke
then retries in another clean job. There is no rollback or asset clobber path.

## Review And Tests

`node --test tools/vsi-promote.test.mjs` runs without network or dependencies
and is included in PR CI. It covers wrong original run/job identities, changed
release snapshots, unsafe/duplicate/incomplete checksums, dispatch guards,
public URL manifests, credential rejection, graph fallbacks and script guards.
Actual anonymous installation can run only after reviewed public promotion.

The publication worktree was created from main
`09bd27f5ef03c4f16cecb4d0b7465b5a1628c567`. Existing main SDK products and
stable release guards are intentionally unchanged. Independent review must
check this new promotion boundary and the public-consumer assertions before
merge and dispatch; implementation tests are not independent review.
