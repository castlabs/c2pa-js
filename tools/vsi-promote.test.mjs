import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { hash, publicUrl, selectRelease, validateDescriptor, verifyArchive, verifyChecksums, verifyDispatch, verifyOrigin, verifyPromotion, verifySnapshot } from './vsi-promote.mjs';
import { publicManifest, verifyAnonymousEnvironment, verifyPublicGraph } from './vsi-public-consumer.mjs';

const locked = JSON.parse(readFileSync(new URL('./vsi-releases.json', import.meta.url), 'utf8'));

function synthetic109() {
  const descriptor = structuredClone(locked['v1.0.9']);
  descriptor.enabled = true;
  Object.assign(descriptor.origin, { sourceSha: 'b'.repeat(40), workflowSha: 'c'.repeat(40), releaseId: 900000001, runId: 900000002, attempt: 2 });
  descriptor.wasmSha256 = hash('synthetic wasm');
  descriptor.assetPins = descriptor.assetPins.map(([name], i) => [name, 910000000 + i, Buffer.byteLength(`synthetic ${name}`), hash(`synthetic ${name}`)]);
  for (const [name, anchor] of Object.entries(descriptor.anchors)) {
    const [, id, , sha256] = descriptor.assetPins.find(p => p[0] === name);
    Object.assign(anchor, { id, sha256 });
  }
  for (const pkg of descriptor.packages) pkg.sha256 = descriptor.assetPins.find(p => p[0] === pkg.file)[3];
  return descriptor;
}

const descriptors = [selectRelease('v1.0.8'), synthetic109()];
const originalRun = ({ origin }) => ({
  id: origin.runId, run_attempt: origin.attempt, repository: { full_name: origin.repository },
  head_repository: { full_name: origin.repository }, workflow_id: origin.workflowId,
  path: origin.workflowPath, event: 'workflow_dispatch', head_sha: origin.sourceSha,
  head_branch: origin.branch, status: 'completed', conclusion: 'success'
});
const originalJobs = ({ origin }) => ['build', 'publish'].map(name => ({ name, run_id: origin.runId, run_attempt: origin.attempt, head_sha: origin.sourceSha, status: 'completed', conclusion: 'success' }));
const release = ({ origin }) => ({ id: origin.releaseId, tag_name: origin.tag, target_commitish: origin.sourceSha, prerelease: false, draft: true, immutable: false });
const assets = ({ anchors, assetPins }) => assetPins.map(([name, id, size, digest]) => ({ name, id, size, state: 'uploaded', digest: `sha256:${digest ?? anchors[name]?.sha256 ?? 'a'.repeat(64)}` }));
const dispatch = ({ origin }) => ({
  GITHUB_REPOSITORY: origin.repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: `${origin.repository}/.github/workflows/castlabs-vsi-publish-existing.yml@refs/heads/main`,
  CONFIRM_TAG: origin.tag, GITHUB_ACTIONS: 'true'
});

test('final v1.0.9 descriptor selects the exact successful draft and bounded asset layout', () => {
  const descriptor = selectRelease('v1.0.9');
  assert.deepEqual(descriptor.origin, {
    repository: 'castlabs/c2pa-js', sourceSha: '62fad5306933e16633e6787c1bb1d608ce71b851',
    workflowSha: '62fad5306933e16633e6787c1bb1d608ce71b851', sdkSha: '6021100cc5060b06061ca15b634281cfeb97c718',
    tag: 'v1.0.9', releaseId: 427935520, runId: 40884394612, attempt: 1, workflowId: 387394909,
    workflowPath: '.github/workflows/castlabs-vsi-bundle.yml', branch: 'feat/live-video-vsi'
  });
  assert.deepEqual(descriptor.anchors, {
    SHA256SUMS: { id: 688733542, sha256: '1a5e3733c8cfacfa920ab6b02370bf126f07a07ab97c530ba4e43d21d4542ed7' },
    'provenance.json': { id: 688733608, sha256: 'd5a551f553a7b6c6f951c8a3a0a916014f9a94ab8367ba15ed7299e81d2c69a0' }
  });
  assert.equal(descriptor.wasmSha256, 'd69b9951b8d3b6aef990ae5b61dc75e5d883fbc103898dd8390c8cdcf6ca7094');
  assert.equal(descriptor.assetPins.length, 19);
  const archive = descriptor.assetPins.find(p => p[0] === 'bmff-evidence.tar.gz');
  assert.deepEqual(archive, ['bmff-evidence.tar.gz', 688733547, 42287134, '611f1db87ff03385f7c877b751358f4a9758fb1931f6bc96fec7d41b02ac1ae8']);
  assert.ok(archive[2] > 32 * 1024 * 1024);
  assert.ok(descriptor.assetPins.every(([, , size]) => size < 64 * 1024 * 1024));
  verifyOrigin(originalRun(descriptor), originalJobs(descriptor), descriptor);
  verifySnapshot(release(descriptor), assets(descriptor), descriptor);
  verifyDispatch(dispatch(descriptor), descriptor);
  assert.deepEqual(publicManifest(descriptor).dependencies, Object.fromEntries(descriptor.packages.map(p => [p.name, publicUrl(p, descriptor)])));
  assert.throws(() => verifyOrigin(originalRun(descriptors[1]), originalJobs(descriptors[1]), descriptor));
  assert.throws(() => verifySnapshot(release(descriptors[0]), assets(descriptors[0]), descriptor));
});

test('only locked enabled releases are selectable; synthetic descriptors never enable production', () => {
  const before = structuredClone(locked);
  const reviewed = locked['v1.0.9'];
  assert.deepEqual(selectRelease('v1.0.8'), locked['v1.0.8']);
  assert.equal(selectRelease('v1.0.8').origin.sourceSha, 'acfa8dd64f499e5f0c459e534b5b5d2437fb5197');
  if (reviewed.enabled === false) assert.throws(() => selectRelease('v1.0.9'), /disabled/);
  else assert.deepEqual(selectRelease('v1.0.9'), reviewed);
  for (const tag of [undefined, '', 'v1.0.7', 'v1.0.10', '1.0.9', '../v1.0.8', 'toString', '__proto__']) {
    assert.throws(() => selectRelease(tag), /Unreviewed release tag/);
    assert.throws(() => validateDescriptor(synthetic109(), tag), /Unreviewed release tag/);
  }
  assert.equal(validateDescriptor(descriptors[1], 'v1.0.9'), descriptors[1]);
  assert.equal(descriptors[1].assetPins.length, 19);
  const disabled = synthetic109(); disabled.enabled = false;
  assert.throws(() => validateDescriptor(disabled, 'v1.0.9'), /disabled/);
  if (reviewed.origin.sourceSha === null) {
    const incomplete = structuredClone(reviewed); incomplete.enabled = true;
    assert.throws(() => validateDescriptor(incomplete, 'v1.0.9'));
  }
  for (const field of ['schemaVersion', 'enabled', 'wasmSha256']) {
    const bad = synthetic109();
    bad[field] = null;
    assert.throws(() => validateDescriptor(bad, 'v1.0.9'), undefined, field);
  }
  for (const field of Object.keys(descriptors[1].origin)) {
    const bad = synthetic109();
    bad.origin[field] = null;
    assert.throws(() => validateDescriptor(bad, 'v1.0.9'), undefined, field);
  }
  for (const field of ['releaseId', 'runId', 'attempt']) for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = synthetic109();
    bad.origin[field] = value;
    assert.throws(() => validateDescriptor(bad, 'v1.0.9'), undefined, field);
  }
  for (let i = 0; i < 19; i++) for (const column of [0, 1, 2, 3]) {
    const bad = synthetic109();
    bad.assetPins[i][column] = column === 0 ? 'unexpected.json' : null;
    assert.throws(() => validateDescriptor(bad, 'v1.0.9'), undefined, `${i}:${column}`);
  }
  for (const change of [
    d => d.assetPins.pop(), d => d.assetPins.push(d.assetPins[0]),
    d => { d.assetPins[1][1] = d.assetPins[0][1]; },
    d => { d.assetPins[0][0] = '../bmff-evidence.tar.gz'; },
    d => { d.anchors.extra = d.anchors.SHA256SUMS; }, d => { delete d.anchors.SHA256SUMS; },
    d => { d.origin.tag = 'v1.0.8'; }, d => { d.packages = structuredClone(descriptors[0].packages); }
  ]) {
    const bad = synthetic109(); change(bad);
    assert.throws(() => validateDescriptor(bad, 'v1.0.9'));
  }
  for (const name of Object.keys(descriptors[1].anchors)) for (const field of ['id', 'sha256']) {
    const bad = synthetic109();
    bad.anchors[name][field] = field === 'id' ? 1 : hash('wrong anchor');
    assert.throws(() => validateDescriptor(bad, 'v1.0.9'), undefined, `${name}:${field}`);
  }
  for (let i = 0; i < 4; i++) for (const field of ['name', 'version', 'file', 'sha256']) {
    const bad = synthetic109();
    bad.packages[i][field] = field === 'sha256' ? hash('wrong package') : 'wrong';
    assert.throws(() => validateDescriptor(bad, 'v1.0.9'), undefined, `${i}:${field}`);
  }
  assert.deepEqual(locked, before, 'Synthetic filling and validation must not mutate locked descriptors');
});

for (const descriptor of descriptors) {
  const { origin, packages, assetPins } = descriptor;
  const other = descriptors.find(d => d !== descriptor);

  test(`${origin.tag}: explicit original attempt and every run/job identity`, () => {
    verifyOrigin(originalRun(descriptor), originalJobs(descriptor), descriptor);
    for (const field of Object.keys(originalRun(descriptor))) {
      const run = originalRun(descriptor);
      run[field] = typeof run[field] === 'object' ? { full_name: 'attacker/fork' } : 'wrong';
      assert.throws(() => verifyOrigin(run, originalJobs(descriptor), descriptor), undefined, field);
      delete run[field];
      assert.throws(() => verifyOrigin(run, originalJobs(descriptor), descriptor), undefined, `missing ${field}`);
    }
    for (let i = 0; i < 2; i++) for (const field of Object.keys(originalJobs(descriptor)[i])) {
      const jobs = originalJobs(descriptor);
      jobs[i][field] = 'wrong';
      assert.throws(() => verifyOrigin(originalRun(descriptor), jobs, descriptor), undefined, `${i}:${field}`);
      delete jobs[i][field];
      assert.throws(() => verifyOrigin(originalRun(descriptor), jobs, descriptor), undefined, `missing ${i}:${field}`);
    }
    assert.throws(() => verifyOrigin(originalRun(descriptor), originalJobs(descriptor).slice(0, 1), descriptor));
    assert.throws(() => verifyOrigin(originalRun(descriptor), [...originalJobs(descriptor), originalJobs(descriptor)[0]], descriptor));
    assert.throws(() => verifyOrigin(originalRun(other), originalJobs(descriptor), descriptor));
    assert.throws(() => verifyOrigin(originalRun(descriptor), originalJobs(other), descriptor));
  });

  test(`${origin.tag}: snapshot pins every asset identity and reviewed digest`, () => {
    const before = verifySnapshot(release(descriptor), assets(descriptor), descriptor);
    assert.equal(before.assets.length, origin.tag === 'v1.0.8' ? 17 : 19);
    assert.deepEqual(verifySnapshot({ ...release(descriptor), draft: false, immutable: true }, assets(descriptor), descriptor), { ...before, draft: false });
    for (const [field, value] of Object.entries({ id: 1, tag_name: other.origin.tag, target_commitish: other.origin.sourceSha, prerelease: true, draft: null, immutable: true })) {
      assert.throws(() => verifySnapshot({ ...release(descriptor), [field]: value }, assets(descriptor), descriptor), undefined, field);
    }
    for (let i = 0; i < assetPins.length; i++) for (const [field, value] of Object.entries({ name: '../escape', id: 1, size: 0, state: 'new', digest: 'sha256:wrong' })) {
      const changed = assets(descriptor);
      changed[i][field] = value;
      assert.throws(() => verifySnapshot(release(descriptor), changed, descriptor), undefined, `${i}:${field}`);
    }
    assert.throws(() => verifySnapshot(release(descriptor), assets(descriptor).slice(1), descriptor));
    assert.throws(() => verifySnapshot(release(descriptor), [...assets(descriptor), assets(descriptor)[0]], descriptor));
    assert.throws(() => verifySnapshot(release(other), assets(other), descriptor));
    for (let i = 0; i < assetPins.length; i++) {
      const changed = assets(descriptor);
      changed[i].digest = `sha256:${hash('replacement')}`;
      if (origin.tag === 'v1.0.9' || descriptor.anchors[changed[i].name]) {
        assert.throws(() => verifySnapshot(release(descriptor), changed, descriptor), changed[i].name);
      } else {
        assert.notDeepEqual(verifySnapshot(release(descriptor), changed, descriptor), before, 'Historical unpinned digests still change the final snapshot');
      }
    }
    const swapped = assets(descriptor);
    [swapped[0].digest, swapped[1].digest] = [swapped[1].digest, swapped[0].digest];
    if (origin.tag === 'v1.0.9') assert.throws(() => verifySnapshot(release(descriptor), swapped, descriptor));
  });

  test(`${origin.tag}: canonical checksum set, bytes and nested path policy`, () => {
    const files = Object.fromEntries(assetPins.filter(([name]) => name !== 'SHA256SUMS').map(([name]) => [name, Buffer.from(`synthetic ${name}`)]));
    const nested = origin.tag === 'v1.0.9' ? ['bmff/qualification.json', 'bmff/cases/accepted.json'] : [];
    for (const name of nested) files[name] = Buffer.from(name);
    const text = Object.keys(files).sort().map(name => `${hash(files[name])}  ${name}\n`).join('');
    const read = name => { assert.ok(Object.hasOwn(files, name)); return files[name]; };
    assert.equal(Object.keys(verifyChecksums(text, read, descriptor, nested)).length, assetPins.length - 1 + nested.length);
    for (const bad of [
      text.trimEnd(), text + text.split('\n')[0] + '\n', text.replace('consumer-graph.json', '../escape'),
      text.replace('consumer-graph.json', '/absolute'), text.replace('consumer-graph.json', 'dir/file'),
      text.replace('consumer-graph.json', 'dir\\file'), text.replace('consumer-graph.json', './consumer-graph.json'),
      text.replace('consumer-graph.json', 'consumer.json'), text.replace(/^[a-f0-9]/, 'F'),
      text.replace('  ', ' '), text.split('\n').reverse().join('\n'), text.replace(/^[^\n]+\n/, ''),
      text.replace(/^[a-f0-9]{64}/, '0'.repeat(64)), `${text}${hash('extra')}  z-extra.json\n`
    ]) assert.throws(() => verifyChecksums(bad, read, descriptor, nested));
    for (const name of ['../escape', '/bmff/file', 'bmff/../escape', 'bmff/./file', 'bmff//file', 'bmff\\file', 'other/file', 'bmff/']) {
      assert.throws(() => verifyChecksums(text, read, descriptor, [name]), undefined, name);
    }
    assert.throws(() => verifyChecksums(text, read, descriptor, ['bmff/qualification.json', 'bmff/qualification.json']));
    if (nested.length) {
      assert.throws(() => verifyChecksums(text, read, descriptor));
      assert.throws(() => verifyChecksums(text.replace(/^.*  bmff\/qualification.json\n/m, ''), read, descriptor, nested));
      assert.throws(() => verifyChecksums(text, read, descriptor, [...nested, 'bmff/missing.json']));
    } else assert.throws(() => verifyChecksums(text, read, descriptor, ['bmff/qualification.json']));
  });

  test(`${origin.tag}: dispatch rejects each absent/wrong guard and cross-release confirmation`, () => {
    verifyDispatch(dispatch(descriptor), descriptor);
    for (const key of Object.keys(dispatch(descriptor))) {
      assert.throws(() => verifyDispatch({ ...dispatch(descriptor), [key]: 'wrong' }, descriptor), key);
      const env = dispatch(descriptor); delete env[key];
      assert.throws(() => verifyDispatch(env, descriptor), key);
    }
    assert.throws(() => verifyDispatch(dispatch(other), descriptor));
  });

  test(`${origin.tag}: anonymous manifest uses only four matching final URL roots`, () => {
    const manifest = publicManifest(descriptor);
    assert.equal(manifest.pnpm, undefined);
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.packageManager, 'pnpm@10.15.0');
    assert.deepEqual(manifest.dependencies, Object.fromEntries(packages.map(p => [p.name, publicUrl(p, descriptor)])));
    for (const pkg of packages) assert.equal(publicUrl(pkg, descriptor), `https://github.com/${origin.repository}/releases/download/${origin.tag}/${pkg.file}`);
    assert.ok(!/file:|workspace:|link:|overrides/.test(JSON.stringify(manifest)));
    assert.deepEqual(packages.map(p => p.version), origin.tag === 'v1.0.8' ? ['0.7.5', '0.13.2', '0.3.1', '0.15.3'] : ['0.7.5', '0.13.2', '0.3.2', '0.15.4']);
  });

  test(`${origin.tag}: public graph rejects fallback, mixed tags/versions, duplicate SDKs and unknown products`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'vsi-public-graph-'));
    try {
      const roots = Object.fromEntries(packages.map(p => {
        const path = join(temp, p.name.split('/')[1]); mkdirSync(path);
        return [p.name, path];
      }));
      const dependencies = Object.fromEntries(packages.map(p => [p.name, { version: p.version, resolved: publicUrl(p, descriptor), path: roots[p.name] }]));
      const graph = [{ dependencies, devDependencies: { typescript: { version: '5.8.2' } } }];
      graph[0].dependencies[packages[3].name].dependencies = { [packages[0].name]: { ...dependencies[packages[0].name] } };
      verifyPublicGraph(graph, roots, descriptor);
      assert.throws(() => verifyPublicGraph(graph, roots, other));
      for (const pkg of packages) for (const resolved of ['file:local.tgz', 'workspace:*', 'link:local', 'https://registry.npmjs.org/product.tgz', publicUrl(pkg, other)]) {
        const bad = structuredClone(graph);
        bad[0].dependencies[pkg.name].resolved = resolved;
        assert.throws(() => verifyPublicGraph(bad, roots, descriptor), pkg.name);
      }
      for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) for (const resolved of ['file:local.tgz', publicUrl(packages[0], other)]) {
        const bad = structuredClone(graph);
        bad[0].dependencies[packages[3].name][field] = { [packages[0].name]: { ...dependencies[packages[0].name], resolved } };
        assert.throws(() => verifyPublicGraph(bad, roots, descriptor));
      }
      for (const pkg of packages) for (const [field, value] of Object.entries({ path: temp, name: '@stardustproof/other', version: '0.0.0' })) {
        const bad = structuredClone(graph); bad[0].dependencies[pkg.name][field] = value;
        assert.throws(() => verifyPublicGraph(bad, roots, descriptor));
      }
      const missing = structuredClone(graph); delete missing[0].dependencies[packages[0].name];
      assert.throws(() => verifyPublicGraph(missing, roots, descriptor));
      const unknown = structuredClone(graph); unknown[0].dependencies['@stardustproof/unknown'] = dependencies[packages[0].name];
      assert.throws(() => verifyPublicGraph(unknown, roots, descriptor));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

// Minimal regular ustar members, assembled in memory; never invoke or extract with tar.
function archive(entries, trailer = Buffer.alloc(1024)) {
  const blocks = [];
  for (const { name, bytes, type = '0', link = '', prefix = '' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'ascii');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = type.charCodeAt(0);
    header.write(link, 157, 100, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'ascii');
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, trailer]));
}

test('archive inspection requires exact regular evidence bytes and rejects unsafe headers and trailers', () => {
  const entries = [{ name: 'bmff/qualification.json', bytes: Buffer.from('{"passed":true}\n') }, { name: 'bmff/cases/accepted.json', bytes: Buffer.from('accepted\n') }];
  const evidence = Object.fromEntries(entries.map(({ name, bytes }) => [name, hash(bytes)]));
  const bytes = archive(entries);
  const sealed = { ...evidence, 'bmff-evidence.tar.gz': hash(bytes) };
  assert.deepEqual([...verifyArchive(bytes, sealed)], entries.map(({ name, bytes }) => [name, bytes]));
  const nulType = archive(entries.map(e => ({ ...e, type: '\0' })));
  assert.equal(verifyArchive(nulType, { ...evidence, 'bmff-evidence.tar.gz': hash(nulType) }).size, 2);
  assert.throws(() => verifyArchive(bytes, { ...sealed, [entries[0].name]: hash('wrong evidence') }), /Archived evidence differs/);
  const malformed = Buffer.from('not gzip');
  assert.throws(() => verifyArchive(malformed, sealed), /Archive pin must match before decompression/);
  assert.throws(() => verifyArchive(malformed, { ...sealed, 'bmff-evidence.tar.gz': hash(malformed) }), error => !/Archive pin/.test(error.message));
  for (const bad of [
    ...['../escape', '/bmff/qualification.json', 'bmff/../escape', 'bmff/./qualification.json', 'bmff\\qualification.json'].map(name => archive([{ ...entries[0], name }, entries[1]])),
    ...['1', '2', '3', '4', '5', '6', 'x', 'g', 'L'].map(type => archive([{ ...entries[0], type }, entries[1]])),
    archive([{ ...entries[0], link: 'target' }, entries[1]]), archive([{ ...entries[0], prefix: 'prefix' }, entries[1]]),
    archive([...entries, entries[0]]), archive([...entries, { name: 'bmff/extra.json', bytes: Buffer.from('extra') }]),
    archive(entries.slice(1)), archive(entries, Buffer.alloc(512)), archive(entries, Buffer.alloc(1024, 1)),
    archive(entries, Buffer.concat([Buffer.alloc(1024), Buffer.from([1])])), gzipSync(Buffer.alloc(511))
  ]) assert.throws(() => verifyArchive(bad, { ...evidence, 'bmff-evidence.tar.gz': hash(bad) }));
  for (const name of ['bmff/../escape', 'bmff/./file', 'bmff//file', 'bmff/']) {
    assert.throws(() => verifyArchive(bytes, { ...sealed, [name]: hash('unsafe') }), /Unsafe archive path/);
  }
  const noQualification = { ...sealed }; delete noQualification['bmff/qualification.json'];
  assert.throws(() => verifyArchive(bytes, noQualification));
});

function promotionFixture(base, alter = () => {}) {
  const temp = mkdtempSync(join(tmpdir(), 'vsi-promotion-'));
  try {
    const descriptor = structuredClone(base);
    const { origin, packages } = descriptor;
    const source = join(temp, 'source');
    const directory = join(temp, 'assets');
    for (const path of [join(source, 'tools'), join(source, 'release'), directory]) mkdirSync(path, { recursive: true });
    const files = Object.fromEntries(descriptor.assetPins.filter(([name]) => !['SHA256SUMS', 'provenance.json', 'bmff-evidence.tar.gz'].includes(name)).map(([name]) => [name, Buffer.from(`synthetic ${origin.tag} ${name}`)]));
    for (const pkg of packages) pkg.sha256 = hash(files[pkg.file]);
    const tools = {
      wasmBindgen: 'wasm-bindgen 0.2.129', binaryen: 'wasm-opt version 124', pnpm: '10.15.0', node: 'v24.0.0',
      rustc: 'rustc 1.96.0 synthetic', cargo: 'cargo 1.96.0 synthetic', cargoWasmSha256: hash('cargo wasm'),
      archiveSha256: { binaryen: hash('binaryen'), bindgen: hash('bindgen') }
    };
    files['tool-versions.json'] = Buffer.from(JSON.stringify(tools));
    descriptor.wasmSha256 = hash('fixture wasm');
    const identity = { sourceSha: origin.sourceSha, sdkSha: origin.sdkSha, bundleVersion: origin.tag.slice(1) };
    const inputs = { sdkIntegration: { nativeQualification: { runId: '39004446457', headSha: origin.sdkSha } } };
    writeFileSync(join(source, 'release/castlabs-vsi-inputs.json'), JSON.stringify(inputs));
    const evidence = Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'tool-versions.json' && !packages.some(p => p.file === name)).map(([name, bytes]) => [name, hash(bytes)]));
    const nested = origin.tag === 'v1.0.9' ? [{ name: 'bmff/qualification.json', bytes: Buffer.from('{"passed":true}\n') }, { name: 'bmff/cases/accepted.json', bytes: Buffer.from('accepted\n') }] : [];
    for (const { name, bytes } of nested) evidence[name] = hash(bytes);
    if (nested.length) files['bmff-evidence.tar.gz'] = archive(nested);
    // Strict independent expectations: resealing a bad bundle must not make the fake verifier accept it.
    writeFileSync(join(source, 'tools/vsi-release.mjs'), `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const calls = [];
export let returnedEvidence;
export let evidenceBeforeWrapper;
export function verifySource(root, sha, version) {
  calls.push('source');
  assert.equal(root, ${JSON.stringify(source)});
  assert.equal(sha, ${JSON.stringify(origin.sourceSha)});
  assert.equal(version, ${JSON.stringify(origin.tag.slice(1))});
  return ${JSON.stringify(identity)};
}
export function validateInputs(inputs, qualified) {
  calls.push('inputs');
  assert.equal(qualified, true);
  assert.deepEqual(inputs, ${JSON.stringify(inputs)});
}
export function verifyEvidence(root, directory) {
  calls.push('evidence');
  assert.equal(root, ${JSON.stringify(source)});
  const expected = ${JSON.stringify(evidence)};
  for (const [name, digest] of Object.entries(expected)) assert.equal(createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'), digest);
  evidenceBeforeWrapper = { ...expected };
  returnedEvidence = { ...expected };
  return returnedEvidence;
}
`);
    const qualificationEvidence = { ...evidence };
    if (nested.length) qualificationEvidence['bmff-evidence.tar.gz'] = hash(files['bmff-evidence.tar.gz']);
    const bundle = {
      schemaVersion: 1, bundleVersion: origin.tag.slice(1), identity, inputs, packages,
      wasm: { sha256: descriptor.wasmSha256 }, workflow: { sha: origin.workflowSha, runId: String(origin.runId), attempt: String(origin.attempt) },
      tools, qualification: { passed: true, profile: 'vsi-browser-bundle-v1', evidence: qualificationEvidence }
    };
    alter({ bundle, files, descriptor, source });
    files['provenance.json'] = Buffer.from(JSON.stringify(bundle));
    const checksumFiles = { ...files, ...Object.fromEntries(nested.map(e => [e.name, e.bytes])) };
    files.SHA256SUMS = Buffer.from(Object.keys(checksumFiles).sort().map(name => `${hash(checksumFiles[name])}  ${name}\n`).join(''));
    descriptor.assetPins = descriptor.assetPins.map(([name, id]) => [name, id, files[name].length, ...(origin.tag === 'v1.0.9' ? [hash(files[name])] : [])]);
    for (const [name, anchor] of Object.entries(descriptor.anchors)) Object.assign(anchor, { id: descriptor.assetPins.find(p => p[0] === name)[1], sha256: hash(files[name]) });
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
    return { temp, source, directory, descriptor, bundle, files, evidence };
  } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
}

for (const base of descriptors) {
  test(`${base.origin.tag}: complete synthetic promotion reuses source verifiers and exact evidence wrapper`, async () => {
    const fixture = promotionFixture(base);
    const { source, directory, descriptor, bundle, files, evidence } = fixture;
    try {
      validateDescriptor(descriptor, descriptor.origin.tag);
      verifySnapshot(release(descriptor), assets(descriptor), descriptor);
      const checksums = await verifyPromotion(source, directory, originalRun(descriptor), originalJobs(descriptor), descriptor);
      const verifier = await import(pathToFileURL(join(source, 'tools/vsi-release.mjs')));
      assert.deepEqual(verifier.calls, ['source', 'inputs', 'evidence']);
      assert.deepEqual(verifier.evidenceBeforeWrapper, evidence);
      assert.deepEqual(verifier.returnedEvidence, bundle.qualification.evidence);
      const expected = Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'SHA256SUMS').map(([name, bytes]) => [name, hash(bytes)]));
      for (const name of Object.keys(evidence).filter(name => name.startsWith('bmff/'))) expected[name] = hash(readFileSync(join(directory, name)));
      assert.deepEqual(checksums, expected);
      if (descriptor.origin.tag === 'v1.0.9') {
        assert.ok(Object.hasOwn(verifier.evidenceBeforeWrapper, 'bmff/qualification.json'));
        assert.equal(verifier.evidenceBeforeWrapper['bmff-evidence.tar.gz'], undefined);
        assert.equal(verifier.returnedEvidence['bmff-evidence.tar.gz'], hash(files['bmff-evidence.tar.gz']));
      } else assert.ok(!Object.keys(verifier.returnedEvidence).some(name => name.startsWith('bmff/')));
    } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
  });

  test(`${base.origin.tag}: resealed synthetic promotion rejects swapped source/workflow/package/qualification identities`, async () => {
    const other = descriptors.find(d => d !== base);
    const changes = [
      f => { f.bundle.schemaVersion = 2; }, f => { f.bundle.bundleVersion = other.origin.tag.slice(1); },
      f => { f.bundle.identity.sourceSha = other.origin.sourceSha; }, f => { f.bundle.identity.sdkSha = '0'.repeat(40); },
      f => { f.descriptor.origin.sourceSha = other.origin.sourceSha; },
      ...['sha', 'runId', 'attempt'].map(field => f => { f.bundle.workflow[field] = field === 'sha' ? other.origin.workflowSha : String(field === 'runId' ? other.origin.runId : other.origin.attempt); }),
      f => { f.bundle.packages = structuredClone(other.packages); },
      f => { f.bundle.packages = f.bundle.packages.slice(1); },
      f => { f.bundle.packages = [...f.bundle.packages, f.bundle.packages[0]]; },
      f => { f.bundle.packages = structuredClone(f.bundle.packages); f.bundle.packages[0].sha256 = hash('wrong package'); },
      f => { f.bundle.wasm.sha256 = hash('wrong wasm'); }, f => { f.bundle.inputs = {}; },
      f => { f.bundle.qualification.passed = false; }, f => { f.bundle.qualification.profile = 'generic'; },
      f => { delete f.bundle.qualification.evidence['queue.json']; },
      f => { f.bundle.qualification.evidence['extra.json'] = hash('extra'); },
      f => { f.bundle.qualification.evidence['queue.json'] = hash('wrong evidence'); },
      f => { f.files['queue.json'] = Buffer.from('replacement evidence'); },
      f => { f.files[f.descriptor.packages[0].file] = Buffer.from('replacement package'); },
      f => { f.bundle.tools = { ...f.bundle.tools, pnpm: '0.0.0' }; },
      f => { const tools = { ...f.bundle.tools, node: 'v22.0.0' }; f.bundle.tools = tools; f.files['tool-versions.json'] = Buffer.from(JSON.stringify(tools)); },
      f => { const inputs = structuredClone(f.bundle.inputs); inputs.sdkIntegration.nativeQualification.runId = '1'; f.bundle.inputs = inputs; writeFileSync(join(f.source, 'release/castlabs-vsi-inputs.json'), JSON.stringify(inputs)); }
    ];
    if (base.origin.tag === 'v1.0.9') changes.push(
      f => { delete f.bundle.qualification.evidence['bmff-evidence.tar.gz']; },
      f => { f.bundle.qualification.evidence['bmff-evidence.tar.gz'] = hash('wrong archive'); },
      f => { delete f.bundle.qualification.evidence['bmff/qualification.json']; },
      f => { f.bundle.qualification.evidence['bmff/cases/accepted.json'] = hash('wrong nested evidence'); }
    );
    for (const [i, change] of changes.entries()) {
      const fixture = promotionFixture(base, change);
      try {
        await assert.rejects(() => verifyPromotion(fixture.source, fixture.directory, originalRun(fixture.descriptor), originalJobs(fixture.descriptor), fixture.descriptor), `resealed mutation ${i}`);
      } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
    }
    for (const swap of ['run', 'jobs', 'descriptor', 'anchor', 'checksum', 'extra', 'missing']) {
      const fixture = promotionFixture(base);
      try {
        const { source, directory, descriptor } = fixture;
        if (swap === 'anchor') writeFileSync(join(directory, 'provenance.json'), '{}');
        if (swap === 'checksum') writeFileSync(join(directory, 'SHA256SUMS'), '');
        if (swap === 'extra') writeFileSync(join(directory, 'extra.json'), '{}');
        if (swap === 'missing') rmSync(join(directory, 'queue.json'));
        await assert.rejects(() => verifyPromotion(source, directory, originalRun(swap === 'run' ? other : descriptor), originalJobs(swap === 'jobs' ? other : descriptor), swap === 'descriptor' ? other : descriptor), swap);
      } finally { rmSync(fixture.temp, { recursive: true, force: true }); }
    }
  });
}

test('CLI descriptor selection remains locked despite injected test descriptor arguments/environment', () => {
  const temp = mkdtempSync(join(tmpdir(), 'vsi-select-'));
  try {
    const injected = join(temp, 'descriptor.json');
    const output = join(temp, 'output');
    writeFileSync(injected, JSON.stringify(synthetic109()));
    const script = new URL('./vsi-promote.mjs', import.meta.url).pathname;
    const env = { PATH: process.env.PATH, ...dispatch(descriptors[0]), GITHUB_OUTPUT: output, VSI_RELEASE_DESCRIPTOR: injected, VSI_RELEASES_FILE: injected };
    for (const tag of ['v1.0.8', 'v1.0.9', 'v1.0.10']) {
      const result = spawnSync(process.execPath, [script, 'select', injected], { env: { ...env, CONFIRM_TAG: tag }, encoding: 'utf8' });
      if (locked[tag]?.enabled) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), `source_sha=${locked[tag].origin.sourceSha}\n`);
        rmSync(output);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, locked[tag] ? /disabled/ : /Unreviewed release tag/);
      }
      assert.equal(existsSync(output), false);
    }
    const result = spawnSync(process.execPath, [script, 'promote', injected, join(temp, 'must-not-create')], { env: { PATH: process.env.PATH, CONFIRM_TAG: 'v1.0.8' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AssertionError/);
    assert.equal(existsSync(join(temp, 'must-not-create')), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('anonymous consumer refuses credentials before any public access or install', () => {
  verifyAnonymousEnvironment({ PATH: '/usr/bin' });
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN', 'NPM_CONFIG__AUTH', 'npm_config_password', 'pnpm_token', 'NODE_OPTIONS', 'NODE_PATH']) {
    assert.throws(() => verifyAnonymousEnvironment({ [key]: 'secret' }), key);
  }
  const result = spawnSync(process.execPath, [new URL('./vsi-public-consumer.mjs', import.meta.url).pathname, '/must-not-create', 'v1.0.8'], { env: { PATH: process.env.PATH, GH_TOKEN: 'synthetic' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Credential present: GH_TOKEN/);
});

test('script and workflow safety boundaries stay explicit', () => {
  const script = readFileSync(new URL('./vsi-promote.mjs', import.meta.url), 'utf8');
  assert.ok(!/\bseal\s*\(|['"]guard['"]|GITHUB_RUN_\w+\s*=|gh\(\['release', '(create|upload|delete)'/.test(script));
  assert.equal((script.match(/gh\(\['release', 'edit'/g) ?? []).length, 1);
  assert.match(script, /if \(final.draft\) gh\(\['release', 'edit', origin.tag, '--repo', origin.repository, '--draft=false'\]\)/);
  assert.match(script, /const descriptor = selectRelease\(process.env.CONFIRM_TAG\)/);
  assert.match(script, /source_sha=\$\{descriptor.origin.sourceSha\}/);
  assert.match(script, /maxBuffer: \(binary \? 64 : 32\) \* 1024 \* 1024/);
  assert.match(script, /maxOutputLength: 128 \* 1024 \* 1024/);
  const workflow = readFileSync(new URL('../.github/workflows/castlabs-vsi-publish-existing.yml', import.meta.url), 'utf8');
  assert.ok(!/^  (push|pull_request|schedule|workflow_run):/m.test(workflow));
  assert.match(workflow, /group:.*\$\{\{\s*inputs.confirm_tag\s*\}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  const promote = workflow.split('  promote:')[1].split('  public-smoke:')[0];
  const guard = promote.match(/^    if: (.*)$/m)?.[1] ?? '';
  assert.match(guard, /github.repository == 'castlabs\/c2pa-js'/);
  assert.match(guard, /github.ref == 'refs\/heads\/main'/);
  assert.match(guard, /inputs.confirm_tag/);
  assert.match(guard, /v1\.0\.8/);
  assert.match(guard, /v1\.0\.9/);
  const sourceRef = promote.match(/ref: \$\{\{\s*steps\.([\w-]+)\.outputs\.source_sha\s*\}\}/);
  assert.ok(sourceRef, 'Source checkout must use the locked selector output, never an input SHA');
  assert.ok(promote.includes(`id: ${sourceRef[1]}`));
  assert.match(promote, /node automation\/tools\/vsi-promote.mjs select/);
  assert.ok(promote.indexOf('vsi-promote.mjs select') < promote.indexOf(sourceRef[0]));
  assert.match(promote, /CONFIRM_TAG: \$\{\{\s*inputs.confirm_tag\s*\}\}/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(workflow, /actions: read/);
  const publicJob = workflow.split('  public-smoke:')[1];
  assert.ok(!/GH_TOKEN|GITHUB_TOKEN|secrets\.|cache:|contents: write|actions: write/.test(publicJob));
  assert.match(publicJob, /vsi-public-consumer.mjs[^\n]+\$\{\{\s*inputs.confirm_tag\s*\}\}/);
  assert.ok(!/cargo |wasm-pack|pnpm pack|npm publish|release upload/.test(workflow));
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const triggers = ci.split(/^jobs:/m)[0];
  assert.match(triggers, /^  pull_request:/m);
  const prGuard = ci.split('  publication-guards:')[1].split('  main:')[0];
  assert.match(prGuard, /node --test (?:automation\/)?tools\/vsi-promote.test.mjs/);
  assert.ok(!/contents: write|actions: write|secrets\.|cargo |wasm-pack|pnpm install|npm install/.test(prGuard));
  assert.match(prGuard, /persist-credentials: false/);
});
