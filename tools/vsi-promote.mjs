import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import releases from './vsi-releases.json' with { type: 'json' };

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const publicUrl = (pkg, { origin }) => `https://github.com/${origin.repository}/releases/download/${origin.tag}/${pkg.file}`;

export function validateDescriptor(descriptor, tag) {
  assert.ok(['v1.0.8', 'v1.0.9'].includes(tag), 'Unreviewed release tag');
  const { origin, anchors, packages, assetPins } = descriptor;
  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.enabled, true, 'Release descriptor disabled: final reviewed anchors required');
  assert.equal(origin.tag, tag);
  assert.equal(origin.repository, 'castlabs/c2pa-js');
  assert.equal(origin.sdkSha, '6021100cc5060b06061ca15b634281cfeb97c718');
  assert.equal(origin.workflowId, 387394909);
  assert.equal(origin.workflowPath, '.github/workflows/castlabs-vsi-bundle.yml');
  assert.equal(origin.branch, 'feat/live-video-vsi');
  for (const field of ['sourceSha', 'workflowSha']) assert.match(origin[field], /^[a-f0-9]{40}$/);
  for (const field of ['releaseId', 'runId', 'attempt']) assert.ok(Number.isSafeInteger(origin[field]) && origin[field] > 0, field);
  assert.match(descriptor.wasmSha256, /^[a-f0-9]{64}$/);
  const versions = tag === 'v1.0.8' ? ['0.7.5', '0.13.2', '0.3.1', '0.15.3'] : ['0.7.5', '0.13.2', '0.3.2', '0.15.4'];
  assert.deepEqual(packages.map(p => [p.name, p.version, p.file]), ['types', 'wasm', 'utilities', 'web'].map((name, i) => [`@stardustproof/c2pa-${name}`, versions[i], `stardustproof-c2pa-${name}-${versions[i]}.tgz`]));
  for (const pkg of packages) assert.match(pkg.sha256, /^[a-f0-9]{64}$/);
  const names = ['consumer-graph.json', 'consumer-pnpm-lock.yaml', 'consumer.json', 'installed-offsets.json', 'installed-vsi.json', 'provenance.json', 'queue.json', 'SHA256SUMS', 'source-chromium.json', 'source-firefox.json', 'source-vsi.json', 'source-webkit.json', 'tool-versions.json', ...packages.map(p => p.file)];
  if (tag === 'v1.0.9') names.push('bmff-evidence.tar.gz', 'utilities.json');
  assert.deepEqual(assetPins.map(p => p[0]).sort(), names.sort());
  assert.equal(new Set(assetPins.map(p => p[1])).size, names.length);
  for (const [, id, size, digest] of assetPins) {
    assert.ok(Number.isSafeInteger(id) && id > 0);
    assert.ok(Number.isSafeInteger(size) && size > 0);
    if (tag === 'v1.0.9') assert.match(digest, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(Object.keys(anchors).sort(), ['SHA256SUMS', 'provenance.json']);
  for (const [name, anchor] of Object.entries(anchors)) {
    assert.match(anchor.sha256, /^[a-f0-9]{64}$/);
    const pin = assetPins.find(p => p[0] === name);
    assert.equal(anchor.id, pin[1]);
    if (tag === 'v1.0.9') assert.equal(anchor.sha256, pin[3]);
  }
  if (tag === 'v1.0.9') for (const pkg of packages) assert.equal(pkg.sha256, assetPins.find(p => p[0] === pkg.file)[3]);
  return descriptor;
}

export function selectRelease(tag) {
  assert.ok(['v1.0.8', 'v1.0.9'].includes(tag), 'Unreviewed release tag');
  return validateDescriptor(structuredClone(releases[tag]), tag);
}

export function verifyOrigin(run, jobs, { origin }) {
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

export function verifySnapshot(release, assets, { origin, anchors, assetPins }) {
  assert.equal(release.id, origin.releaseId);
  assert.equal(release.tag_name, origin.tag);
  assert.equal(release.target_commitish, origin.sourceSha);
  assert.equal(release.prerelease, false);
  assert.equal(typeof release.draft, 'boolean');
  if (release.draft) assert.equal(release.immutable, false);
  assert.deepEqual(assets.map(a => [a.name, a.id, a.size]).sort(), assetPins.map(p => p.slice(0, 3)).sort());
  assert.equal(new Set(assets.map(a => a.id)).size, assetPins.length);
  for (const asset of assets) {
    assert.equal(asset.state, 'uploaded');
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
    const pin = assetPins.find(p => p[0] === asset.name);
    if (pin[3]) assert.equal(asset.digest, `sha256:${pin[3]}`);
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

export function verifyChecksums(text, read, { origin, assetPins }, nested = []) {
  assert.ok(origin.tag === 'v1.0.9' || nested.length === 0);
  for (const name of nested) assert.ok(/^bmff\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name) && !name.split('/').some(p => p === '.' || p === '..'), 'Unsafe nested checksum path');
  const expected = [...assetPins.map(([name]) => name).filter(name => name !== 'SHA256SUMS'), ...nested].sort();
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'Checksums need a final newline');
  const entries = lines.map(line => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(line);
    assert.ok(match, 'Unsafe or noncanonical checksum entry');
    return { sha256: match[1], name: match[2] };
  });
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(entries.map(e => e.name), expected, 'Exactly the sealed unique sorted paths required');
  for (const entry of entries) assert.equal(hash(read(entry.name)), entry.sha256, `Checksum mismatch: ${entry.name}`);
  return Object.fromEntries(entries.map(e => [e.name, e.sha256]));
}

// The source verifier streams and hashes these same members. Inspect headers first
// so no tar implementation can interpret links, extensions or unsafe paths on disk.
export function verifyArchive(bytes, evidence) {
  assert.equal(hash(bytes), evidence['bmff-evidence.tar.gz'], 'Archive pin must match before decompression');
  const expected = Object.keys(evidence).filter(name => name.startsWith('bmff/')).sort();
  assert.ok(expected.includes('bmff/qualification.json'));
  for (const name of expected) assert.ok(/^bmff\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name) && !name.split('/').some(p => p === '.' || p === '..'), 'Unsafe archive path');
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const members = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, length) => header.subarray(start, start + length).toString('ascii').replace(/\0.*$/s, '');
    const name = field(0, 100);
    assert.ok(header[156] === 0 || header[156] === 48, 'Only regular archive members allowed');
    assert.equal(field(157, 100), '', 'Archive links forbidden');
    assert.equal(field(345, 155), '', 'Archive prefixes/extensions forbidden');
    assert.ok(expected.includes(name), `Unsealed archive member: ${name}`);
    assert.ok(!members.has(name), 'Duplicate archive member');
    assert.match(field(124, 12), /^[0-7]+\0? *$/);
    const size = Number.parseInt(field(124, 12).trim(), 8);
    assert.match(field(148, 8), /^ *[0-7]+ *$/);
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(checksum, Number.parseInt(field(148, 8).trim(), 8), 'Invalid tar header checksum');
    offset += 512;
    assert.ok(offset + size <= tar.length);
    const content = tar.subarray(offset, offset + size);
    assert.equal(hash(content), evidence[name], `Archived evidence differs: ${name}`);
    members.set(name, content);
    offset += Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.length % 512 === 0 && tar.length - offset >= 1024 && tar.subarray(offset).every(byte => byte === 0), 'Noncanonical tar end');
  assert.deepEqual([...members.keys()].sort(), expected);
  return members;
}

// Read-only verification of the original seal, independent of this promotion run's environment.
export async function verifyPromotion(source, directory, run, jobs, descriptor) {
  const { origin, anchors, packages, assetPins } = descriptor;
  verifyOrigin(run, jobs, descriptor);
  const read = name => readFileSync(join(directory, name));
  assert.deepEqual(readdirSync(directory).sort(), assetPins.map(([name]) => name).sort());
  for (const [name, anchor] of Object.entries(anchors)) assert.equal(hash(read(name)), anchor.sha256);
  const bundle = json(join(directory, 'provenance.json'));
  assert.equal(bundle.wasm.sha256, descriptor.wasmSha256);
  let members = new Map();
  if (origin.tag === 'v1.0.9') {
    const archive = read('bmff-evidence.tar.gz');
    assert.equal(hash(archive), assetPins.find(p => p[0] === 'bmff-evidence.tar.gz')[3]);
    members = verifyArchive(archive, bundle.qualification.evidence);
  }
  const checksums = verifyChecksums(read('SHA256SUMS').toString('utf8'), name => members.get(name) ?? read(name), descriptor, [...members.keys()]);
  for (const [name, bytes] of members) {
    mkdirSync(join(directory, name, '..'), { recursive: true });
    writeFileSync(join(directory, name), bytes, { flag: 'wx' });
  }
  const { verifySource, verifyEvidence, validateInputs } = await import(pathToFileURL(join(source, 'tools/vsi-release.mjs')));
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.bundleVersion, origin.tag.slice(1));
  assert.deepEqual(bundle.identity, verifySource(source, origin.sourceSha, origin.tag.slice(1)));
  assert.equal(bundle.identity.sdkSha, origin.sdkSha);
  assert.deepEqual(bundle.inputs, json(join(source, 'release/castlabs-vsi-inputs.json')));
  validateInputs(bundle.inputs, true);
  assert.deepEqual(bundle.packages, packages);
  for (const pkg of packages) assert.equal(hash(read(pkg.file)), pkg.sha256, `Package bytes differ: ${pkg.file}`);
  assert.deepEqual(bundle.workflow, { sha: origin.workflowSha, runId: String(origin.runId), attempt: String(origin.attempt) });
  assert.equal(bundle.inputs.sdkIntegration.nativeQualification.runId, '39004446457');
  assert.equal(bundle.inputs.sdkIntegration.nativeQualification.headSha, origin.sdkSha);
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
  if (origin.tag === 'v1.0.9') evidence['bmff-evidence.tar.gz'] = hash(read('bmff-evidence.tar.gz'));
  assert.deepEqual(bundle.qualification, { passed: true, profile: 'vsi-browser-bundle-v1', evidence });
  const names = [...packages.map(p => p.file), 'provenance.json', 'tool-versions.json', ...Object.keys(evidence)].sort();
  assert.equal(read('SHA256SUMS').toString('utf8'), names.map(name => `${hash(read(name))}  ${name}\n`).join(''));
  return checksums;
}

function gh(args, binary = false) {
  // The reviewed 1.0.9 BMFF archive is 42,287,134 bytes; keep downloads bounded.
  const result = spawnSync('gh', args, { encoding: binary ? undefined : 'utf8', maxBuffer: (binary ? 64 : 32) * 1024 * 1024 });
  assert.equal(result.status, 0, `gh failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
const api = (path, { origin }) => JSON.parse(gh(['api', `repos/${origin.repository}/${path}`]));
const pages = (path, { origin }) => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${origin.repository}/${path}`]));
function snapshot(descriptor) {
  const { origin } = descriptor;
  const release = api(`releases/${origin.releaseId}`, descriptor);
  const releases = pages('releases?per_page=100', descriptor).flat().filter(r => r.tag_name === origin.tag);
  assert.deepEqual(releases.map(r => r.id), [origin.releaseId], 'Ambiguous release tag');
  const assets = pages(`releases/${origin.releaseId}/assets?per_page=100`, descriptor).flat();
  return verifySnapshot(release, assets, descriptor);
}
function download(asset, { origin }) {
  return gh(['api', '-H', 'Accept: application/octet-stream', `repos/${origin.repository}/releases/assets/${asset.id}`], true);
}
function verifyTag(draft, descriptor) {
  const { origin } = descriptor;
  const refs = pages(`git/matching-refs/tags/${origin.tag}?per_page=100`, descriptor).flat().filter(r => r.ref === `refs/tags/${origin.tag}`);
  if (draft) return assert.deepEqual(refs, [], 'Draft promotion must not overwrite an existing tag');
  assert.equal(refs.length, 1);
  let object = refs[0].object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = api(`git/tags/${object.sha}`, descriptor).object;
  assert.equal(object.type, 'commit');
  assert.equal(object.sha, origin.sourceSha);
}

export function verifyDispatch(env, { origin }) {
  assert.equal(env.GITHUB_REPOSITORY, origin.repository);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${origin.repository}/.github/workflows/castlabs-vsi-publish-existing.yml@refs/heads/main`);
  assert.equal(env.CONFIRM_TAG, origin.tag);
  assert.equal(env.GITHUB_ACTIONS, 'true');
}

async function promote(source, output, descriptor) {
  const { origin, anchors } = descriptor;
  verifyDispatch(process.env, descriptor);
  mkdirSync(output); // Never reuse a previous download or build product.
  const assetsDir = join(output, 'assets');
  mkdirSync(assetsDir);
  const run = api(`actions/runs/${origin.runId}/attempts/${origin.attempt}`, descriptor);
  const jobs = pages(`actions/runs/${origin.runId}/attempts/${origin.attempt}/jobs?per_page=100`, descriptor).flatMap(p => p.jobs);
  verifyOrigin(run, jobs, descriptor);
  const before = snapshot(descriptor);
  verifyTag(before.draft, descriptor);
  for (const asset of before.assets) {
    const bytes = download(asset, descriptor);
    assert.equal(bytes.length, asset.size);
    assert.equal(`sha256:${hash(bytes)}`, asset.digest);
    writeFileSync(join(assetsDir, asset.name), bytes, { flag: 'wx' });
  }
  const checksums = await verifyPromotion(source, assetsDir, run, jobs, descriptor);
  // Metadata-only SDK proof: Git history and GitHub API, no Cargo/build invocation.
  const proof = spawnSync(process.execPath, [join(source, 'tools/vsi-release.mjs'), 'sdk-proof', source, join(output, 'sdk-identity'), origin.sourceSha, origin.tag.slice(1)], { stdio: 'inherit' });
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
  const final = snapshot(descriptor);
  assert.deepEqual(final, before, 'Release changed while being verified');
  for (const asset of final.assets) assert.equal(asset.digest, `sha256:${asset.name === 'SHA256SUMS' ? anchors.SHA256SUMS.sha256 : checksums[asset.name]}`);
  for (const [name, anchor] of Object.entries(anchors)) assert.equal(hash(download({ id: anchor.id }, descriptor)), anchor.sha256, `Final anchor changed: ${name}`);
  verifyTag(final.draft, descriptor);
  // The only remote mutation. No uploads, retags, target edits, or provenance rewrites.
  if (final.draft) gh(['release', 'edit', origin.tag, '--repo', origin.repository, '--draft=false']);
  const after = snapshot(descriptor);
  assert.deepEqual(after, { ...before, draft: false });
  verifyTag(false, descriptor);
  for (const asset of after.assets) {
    const bytes = download(asset, descriptor);
    assert.equal(bytes.length, asset.size);
    assert.equal(hash(bytes), asset.digest.slice('sha256:'.length), `Published bytes changed: ${asset.name}`);
  }
  writeFileSync(join(output, 'promotion.json'), `${JSON.stringify({ passed: true, mutated: final.draft, origin, before, after }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, directory, runFile, jobsFile] = process.argv.slice(2);
  const descriptor = selectRelease(process.env.CONFIRM_TAG);
  if (command === 'select') {
    verifyDispatch(process.env, descriptor);
    writeFileSync(process.env.GITHUB_OUTPUT, `source_sha=${descriptor.origin.sourceSha}\n`, { flag: 'a' });
  } else if (command === 'verify') console.log(await verifyPromotion(resolve(source), resolve(directory), json(runFile), json(jobsFile), descriptor));
  else if (command === 'promote') await promote(resolve(source), resolve(directory), descriptor);
  else throw new Error('Expected select, verify or promote');
}
