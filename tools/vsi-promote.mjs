import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const origin = Object.freeze({
  repository: 'castlabs/c2pa-js', sourceSha: 'acfa8dd64f499e5f0c459e534b5b5d2437fb5197',
  sdkSha: '6021100cc5060b06061ca15b634281cfeb97c718', tag: 'v1.0.8', releaseId: 415628702,
  runId: 39009711529, attempt: 1, workflowId: 387394909,
  workflowPath: '.github/workflows/castlabs-vsi-bundle.yml', branch: 'feat/live-video-vsi'
});
export const anchors = Object.freeze({
  SHA256SUMS: { id: 649766904, sha256: '1ce63e2bcf18248d223376b3d13ab041538980f972561e6cb162a066e2de53d0' },
  'provenance.json': { id: 649766921, sha256: '8797734cbc857857355f01bc04c98df05857575f2ca9d758a9f77c0402d4cb36' }
});
export const packages = [
  ['c2pa-types', '0.7.5', 'af8f550c318c79e63a7b58ffe48c5437efe31906e867e4e3f6888979d564da1e'],
  ['c2pa-wasm', '0.13.2', '649460a4467fa9b8a0b16314619754ce5c006fe5ee3d6d13e0d9e068c6a2602b'],
  ['c2pa-utilities', '0.3.1', '68c5546e7f7fe808870302c965f33fadafce9863468a0222c5955fde2cef0e5a'],
  ['c2pa-web', '0.15.3', '68926494b8a6a6b691b078440eb25b159f91832d5364a95cef01ba7e4f2d692e']
].map(([directory, version, sha256]) => ({ name: `@stardustproof/${directory}`, version, file: `stardustproof-${directory}-${version}.tgz`, sha256 }));
// Reviewed asset identities. Checksums below pin their bytes as well as their names.
export const assetPins = [
  ['consumer-graph.json', 649766901, 4940], ['consumer-pnpm-lock.yaml', 649766905, 3758],
  ['consumer.json', 649766902, 4290], ['installed-offsets.json', 649766900, 26042],
  ['installed-vsi.json', 649766919, 38124], ['provenance.json', 649766921, 13564],
  ['queue.json', 649766926, 1654], ['SHA256SUMS', 649766904, 1421],
  ['source-chromium.json', 649766927, 27210], ['source-firefox.json', 649766931, 26158],
  ['source-vsi.json', 649766934, 48724], ['source-webkit.json', 649766937, 26407],
  ['stardustproof-c2pa-types-0.7.5.tgz', 649766942, 16252],
  ['stardustproof-c2pa-utilities-0.3.1.tgz', 649766943, 26435],
  ['stardustproof-c2pa-wasm-0.13.2.tgz', 649766951, 3550940],
  ['stardustproof-c2pa-web-0.15.3.tgz', 649766969, 8258107], ['tool-versions.json', 649766972, 686]
];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const publicUrl = pkg => `https://github.com/${origin.repository}/releases/download/${origin.tag}/${pkg.file}`;

export function verifyOrigin(run, jobs) {
  assert.equal(run.id, origin.runId);
  assert.equal(run.run_attempt, origin.attempt);
  assert.equal(run.repository.full_name, origin.repository);
  assert.equal(run.head_repository.full_name, origin.repository);
  assert.equal(run.workflow_id, origin.workflowId);
  assert.equal(run.path, origin.workflowPath);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_sha, origin.sourceSha);
  assert.equal(run.head_branch, origin.branch);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.deepEqual(jobs.map(job => job.name).sort(), ['build', 'publish']);
  for (const job of jobs) {
    assert.equal(job.run_id, origin.runId);
    assert.equal(job.run_attempt, origin.attempt);
    assert.equal(job.head_sha, origin.sourceSha);
    assert.equal(job.status, 'completed');
    assert.equal(job.conclusion, 'success');
  }
}

export function verifySnapshot(release, assets) {
  assert.equal(release.id, origin.releaseId);
  assert.equal(release.tag_name, origin.tag);
  assert.equal(release.target_commitish, origin.sourceSha);
  assert.equal(release.prerelease, false);
  assert.equal(typeof release.draft, 'boolean');
  if (release.draft) assert.equal(release.immutable, false);
  assert.deepEqual(assets.map(a => [a.name, a.id, a.size]).sort(), [...assetPins].sort());
  assert.equal(new Set(assets.map(a => a.id)).size, 17);
  for (const asset of assets) {
    assert.equal(asset.state, 'uploaded');
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  }
  for (const [name, anchor] of Object.entries(anchors)) {
    assert.equal(assets.find(a => a.name === name).digest, `sha256:${anchor.sha256}`);
  }
  return {
    id: release.id, tag: release.tag_name, target: release.target_commitish,
    prerelease: release.prerelease, draft: release.draft,
    assets: assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

export function verifyChecksums(text, read) {
  const expected = assetPins.map(([name]) => name).filter(name => name !== 'SHA256SUMS').sort();
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'Checksums need a final newline');
  const entries = lines.map(line => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    assert.ok(match, 'Unsafe or noncanonical checksum entry');
    return { sha256: match[1], name: match[2] };
  });
  assert.deepEqual(entries.map(e => e.name), expected, 'Exactly 16 unique sorted basenames required');
  for (const entry of entries) assert.equal(hash(read(entry.name)), entry.sha256, `Checksum mismatch: ${entry.name}`);
  return Object.fromEntries(entries.map(e => [e.name, e.sha256]));
}

// Read-only verification of the original seal, independent of this promotion run's environment.
export async function verifyPromotion(source, directory, run, jobs) {
  verifyOrigin(run, jobs);
  const read = name => readFileSync(join(directory, name));
  assert.deepEqual(readdirSync(directory).sort(), assetPins.map(([name]) => name).sort());
  for (const [name, anchor] of Object.entries(anchors)) assert.equal(hash(read(name)), anchor.sha256);
  const checksums = verifyChecksums(read('SHA256SUMS').toString('utf8'), read);
  const { verifySource, verifyEvidence, validateInputs } = await import(pathToFileURL(join(source, 'tools/vsi-release.mjs')));
  const bundle = json(join(directory, 'provenance.json'));
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.bundleVersion, '1.0.8');
  assert.deepEqual(bundle.identity, verifySource(source, origin.sourceSha, '1.0.8'));
  assert.equal(bundle.identity.sdkSha, origin.sdkSha);
  assert.deepEqual(bundle.inputs, json(join(source, 'release/castlabs-vsi-inputs.json')));
  validateInputs(bundle.inputs, true);
  assert.deepEqual(bundle.packages, packages);
  assert.deepEqual(bundle.workflow, { sha: origin.sourceSha, runId: String(origin.runId), attempt: String(origin.attempt) });
  const tools = json(join(directory, 'tool-versions.json'));
  assert.deepEqual(bundle.tools, tools);
  assert.equal(tools.wasmBindgen, 'wasm-bindgen 0.2.129');
  assert.match(tools.binaryen, /^wasm-opt version 124\b/);
  assert.equal(tools.pnpm, '10.15.0');
  assert.match(tools.node, /^v24\./);
  assert.match(tools.rustc, /^rustc 1\.96\.0 /);
  assert.match(tools.cargo, /^cargo 1\.96\.0 /);
  assert.deepEqual(Object.keys(tools.archiveSha256).sort(), ['binaryen', 'bindgen']);
  for (const digest of [tools.cargoWasmSha256, ...Object.values(tools.archiveSha256)]) assert.match(digest, /^[a-f0-9]{64}$/);
  const evidence = verifyEvidence(source, directory);
  assert.deepEqual(bundle.qualification, { passed: true, profile: 'vsi-browser-bundle-v1', evidence });
  const names = [...packages.map(p => p.file), 'provenance.json', 'tool-versions.json', ...Object.keys(evidence)].sort();
  assert.equal(read('SHA256SUMS').toString('utf8'), names.map(name => `${hash(read(name))}  ${name}\n`).join(''));
  return checksums;
}

function gh(args, binary = false) {
  const result = spawnSync('gh', args, { encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `gh failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
const api = path => JSON.parse(gh(['api', `repos/${origin.repository}/${path}`]));
const pages = path => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${origin.repository}/${path}`]));
function snapshot() {
  const release = api(`releases/${origin.releaseId}`);
  const releases = pages('releases?per_page=100').flat().filter(r => r.tag_name === origin.tag);
  assert.deepEqual(releases.map(r => r.id), [origin.releaseId], 'Ambiguous release tag');
  const assets = pages(`releases/${origin.releaseId}/assets?per_page=100`).flat();
  return verifySnapshot(release, assets);
}
function download(asset) {
  return gh(['api', '-H', 'Accept: application/octet-stream', `repos/${origin.repository}/releases/assets/${asset.id}`], true);
}
function verifyTag(draft) {
  const refs = pages(`git/matching-refs/tags/${origin.tag}?per_page=100`).flat().filter(r => r.ref === `refs/tags/${origin.tag}`);
  if (draft) return assert.deepEqual(refs, [], 'Draft promotion must not overwrite an existing tag');
  assert.equal(refs.length, 1);
  let object = refs[0].object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = api(`git/tags/${object.sha}`).object;
  assert.equal(object.type, 'commit');
  assert.equal(object.sha, origin.sourceSha);
}

export function verifyDispatch(env) {
  assert.equal(env.GITHUB_REPOSITORY, origin.repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${origin.repository}/.github/workflows/castlabs-vsi-publish-existing.yml@refs/heads/main`);
  assert.equal(env.CONFIRM_TAG, origin.tag);
  assert.equal(env.GITHUB_ACTIONS, 'true');
}

async function promote(source, output) {
  verifyDispatch(process.env);
  mkdirSync(output); // Never reuse a previous download or build product.
  const assetsDir = join(output, 'assets');
  mkdirSync(assetsDir);
  const run = api(`actions/runs/${origin.runId}/attempts/${origin.attempt}`);
  const jobs = pages(`actions/runs/${origin.runId}/attempts/${origin.attempt}/jobs?per_page=100`).flatMap(p => p.jobs);
  verifyOrigin(run, jobs);
  const before = snapshot();
  verifyTag(before.draft);
  for (const asset of before.assets) {
    const bytes = download(asset);
    assert.equal(bytes.length, asset.size);
    assert.equal(`sha256:${hash(bytes)}`, asset.digest);
    writeFileSync(join(assetsDir, asset.name), bytes, { flag: 'wx' });
  }
  const checksums = await verifyPromotion(source, assetsDir, run, jobs);
  // Metadata-only SDK proof: Git history and GitHub API, no Cargo/build invocation.
  const proof = spawnSync(process.execPath, [join(source, 'tools/vsi-release.mjs'), 'sdk-proof', source, join(output, 'sdk-identity'), origin.sourceSha, '1.0.8'], { stdio: 'inherit' });
  assert.equal(proof.status, 0);
  const nativeJobs = JSON.parse(gh(['api', '--paginate', '--slurp', 'repos/castlabs/c2pa-rs/actions/runs/39004446457/attempts/1/jobs?per_page=100'])).flatMap(p => p.jobs);
  for (const name of ['Qualify x86_64-unknown-linux-gnu', 'Qualify x86_64-pc-windows-msvc']) {
    const jobs = nativeJobs.filter(job => job.name === name);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].run_id, 39004446457);
    assert.equal(jobs[0].run_attempt, 1);
    assert.equal(jobs[0].head_sha, origin.sdkSha);
    assert.equal(jobs[0].status, 'completed');
    assert.equal(jobs[0].conclusion, 'success');
  }
  const final = snapshot();
  assert.deepEqual(final, before, 'Release changed while being verified');
  for (const asset of final.assets) assert.equal(asset.digest, `sha256:${asset.name === 'SHA256SUMS' ? anchors.SHA256SUMS.sha256 : checksums[asset.name]}`);
  for (const [name, anchor] of Object.entries(anchors)) assert.equal(hash(download({ id: anchor.id })), anchor.sha256, `Final anchor changed: ${name}`);
  verifyTag(final.draft);
  // The only remote mutation. No uploads, retags, target edits, or provenance rewrites.
  if (final.draft) gh(['release', 'edit', origin.tag, '--repo', origin.repository, '--draft=false']);
  const after = snapshot();
  assert.deepEqual(after, { ...before, draft: false });
  verifyTag(false);
  for (const asset of after.assets) assert.equal(hash(download(asset)), asset.digest.slice('sha256:'.length), `Published bytes changed: ${asset.name}`);
  writeFileSync(join(output, 'promotion.json'), `${JSON.stringify({ passed: true, mutated: final.draft, origin, before, after }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, directory, runFile, jobsFile] = process.argv.slice(2);
  if (command === 'verify') console.log(await verifyPromotion(resolve(source), resolve(directory), json(runFile), json(jobsFile)));
  else if (command === 'promote') await promote(resolve(source), resolve(directory));
  else throw new Error('Expected verify or promote');
}
