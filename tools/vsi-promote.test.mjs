import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { anchors, assetPins, hash, origin, packages, publicUrl, verifyChecksums, verifyDispatch, verifyOrigin, verifySnapshot } from './vsi-promote.mjs';
import { publicManifest, verifyAnonymousEnvironment, verifyPublicGraph } from './vsi-public-consumer.mjs';

const originalRun = () => ({
  id: origin.runId, run_attempt: 1, repository: { full_name: origin.repository },
  head_repository: { full_name: origin.repository }, workflow_id: origin.workflowId,
  path: origin.workflowPath, event: 'workflow_dispatch', head_sha: origin.sourceSha,
  head_branch: origin.branch, status: 'completed', conclusion: 'success'
});
const originalJobs = () => ['build', 'publish'].map(name => ({ name, run_id: origin.runId, run_attempt: 1, head_sha: origin.sourceSha, status: 'completed', conclusion: 'success' }));
const release = () => ({ id: origin.releaseId, tag_name: origin.tag, target_commitish: origin.sourceSha, prerelease: false, draft: true, immutable: false });
const assets = () => assetPins.map(([name, id, size]) => ({ name, id, size, state: 'uploaded', digest: `sha256:${anchors[name]?.sha256 ?? 'a'.repeat(64)}` }));
const dispatch = () => ({
  GITHUB_REPOSITORY: origin.repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: `${origin.repository}/.github/workflows/castlabs-vsi-publish-existing.yml@refs/heads/main`,
  CONFIRM_TAG: origin.tag, GITHUB_ACTIONS: 'true'
});

test('explicit original attempt identity, not current promotion environment', () => {
  verifyOrigin(originalRun(), originalJobs());
  for (const field of Object.keys(originalRun())) {
    const run = originalRun();
    run[field] = typeof run[field] === 'object' ? { full_name: 'attacker/fork' } : 'wrong';
    assert.throws(() => verifyOrigin(run, originalJobs()), field);
  }
  for (const field of Object.keys(originalJobs()[0])) {
    const jobs = originalJobs();
    jobs[0][field] = 'wrong';
    assert.throws(() => verifyOrigin(originalRun(), jobs), field);
  }
  assert.throws(() => verifyOrigin(originalRun(), originalJobs().slice(0, 1)));
  assert.throws(() => verifyOrigin(originalRun(), [...originalJobs(), originalJobs()[0]]));
});

test('release snapshot pins all 17 IDs, sizes, names and anchor digests', () => {
  const before = verifySnapshot(release(), assets());
  assert.equal(before.assets.length, 17);
  assert.deepEqual(verifySnapshot({ ...release(), draft: false, immutable: true }, assets()), { ...before, draft: false });
  for (const [field, value] of Object.entries({ id: 1, tag_name: 'v1.0.7', target_commitish: 'b'.repeat(40), prerelease: true, draft: null, immutable: true })) {
    assert.throws(() => verifySnapshot({ ...release(), [field]: value }, assets()), field);
  }
  for (const [field, value] of Object.entries({ name: '../escape', id: 1, size: 0, state: 'new', digest: 'sha256:wrong' })) {
    const changed = assets();
    changed[0][field] = value;
    assert.throws(() => verifySnapshot(release(), changed), field);
  }
  assert.throws(() => verifySnapshot(release(), assets().slice(1)));
  assert.throws(() => verifySnapshot(release(), [...assets(), assets()[0]]));
  const replaced = assets();
  replaced.find(a => a.name === 'provenance.json').digest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => verifySnapshot(release(), replaced));
  const changed = verifySnapshot(release(), assets().map(a => a.name === 'queue.json' ? { ...a, digest: `sha256:${'b'.repeat(64)}` } : a));
  assert.notDeepEqual(changed, before, 'Final snapshot comparison must detect any digest change');
});

test('canonical checksums require exactly 16 safe unique sorted entries and matching bytes', () => {
  const files = Object.fromEntries(assetPins.filter(([name]) => name !== 'SHA256SUMS').map(([name]) => [name, Buffer.from(`synthetic ${name}`)]));
  const text = Object.keys(files).sort().map(name => `${hash(files[name])}  ${name}\n`).join('');
  const read = name => files[name];
  assert.equal(Object.keys(verifyChecksums(text, read)).length, 16);
  for (const bad of [
    text.trimEnd(), text + text.split('\n')[0] + '\n', text.replace('consumer-graph.json', '../escape'),
    text.replace('consumer-graph.json', '/absolute'), text.replace('consumer-graph.json', 'dir/file'),
    text.replace('consumer-graph.json', 'dir\\file'), text.replace('consumer-graph.json', 'consumer.json'),
    text.replace(/^[a-f0-9]/, 'F'), text.replace('  ', ' '), text.split('\n').reverse().join('\n'),
    text.replace(/^[^\n]+\n/, ''), text.replace(/^[a-f0-9]{64}/, '0'.repeat(64))
  ]) assert.throws(() => verifyChecksums(bad, read));
});

test('promotion dispatch rejects every wrong or absent execution guard', () => {
  verifyDispatch(dispatch());
  for (const key of Object.keys(dispatch())) {
    assert.throws(() => verifyDispatch({ ...dispatch(), [key]: 'wrong' }), key);
    const env = dispatch();
    delete env[key];
    assert.throws(() => verifyDispatch(env), key);
  }
  const result = spawnSync(process.execPath, [new URL('./vsi-promote.mjs', import.meta.url).pathname, 'promote', '.', '/must-not-create'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AssertionError/);
});

test('anonymous public manifest has four final URL roots, no overrides or local products', () => {
  const manifest = publicManifest();
  assert.equal(manifest.pnpm, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.packageManager, 'pnpm@10.15.0');
  assert.deepEqual(manifest.dependencies, Object.fromEntries(packages.map(p => [p.name, publicUrl(p)])));
  assert.ok(!/file:|workspace:|link:|overrides/.test(JSON.stringify(manifest)));
  verifyAnonymousEnvironment({ PATH: '/usr/bin' });
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_CONFIG__AUTH', 'npm_config_password', 'NODE_OPTIONS', 'NODE_PATH']) {
    assert.throws(() => verifyAnonymousEnvironment({ [key]: 'secret' }), key);
  }
  const result = spawnSync(process.execPath, [new URL('./vsi-public-consumer.mjs', import.meta.url).pathname, '/must-not-create'], { env: { PATH: process.env.PATH, GH_TOKEN: 'synthetic' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Credential present: GH_TOKEN/);
});

test('public graph rejects registry/local fallbacks, duplicate SDKs, missing and unknown products', () => {
  const temp = mkdtempSync(join(tmpdir(), 'vsi-public-graph-'));
  try {
    const roots = Object.fromEntries(packages.map(p => {
      const path = join(temp, p.name.split('/')[1]);
      mkdirSync(path);
      return [p.name, path];
    }));
    const dependencies = Object.fromEntries(packages.map(p => [p.name, { version: p.version, resolved: publicUrl(p), path: roots[p.name] }]));
    const graph = [{ dependencies, devDependencies: { typescript: { version: '5.8.2' } } }];
    graph[0].dependencies[packages[3].name].dependencies = { [packages[0].name]: { ...dependencies[packages[0].name] } };
    verifyPublicGraph(graph, roots);
    for (const resolved of ['file:local.tgz', 'workspace:*', 'https://registry.npmjs.org/product.tgz', publicUrl(packages[0]).replace('v1.0.8', 'v1.0.7')]) {
      const bad = structuredClone(graph);
      bad[0].dependencies[packages[3].name].dependencies[packages[0].name].resolved = resolved;
      assert.throws(() => verifyPublicGraph(bad, roots));
    }
    for (const [field, value] of Object.entries({ path: temp, name: '@stardustproof/other', version: '0.0.0' })) {
      const bad = structuredClone(graph);
      bad[0].dependencies[packages[0].name][field] = value;
      assert.throws(() => verifyPublicGraph(bad, roots));
    }
    const missing = structuredClone(graph);
    delete missing[0].dependencies[packages[0].name];
    assert.throws(() => verifyPublicGraph(missing, roots));
    const unknown = structuredClone(graph);
    unknown[0].dependencies['@stardustproof/unknown'] = dependencies[packages[0].name];
    assert.throws(() => verifyPublicGraph(unknown, roots));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('script and workflow safety boundaries stay explicit', () => {
  const script = readFileSync(new URL('./vsi-promote.mjs', import.meta.url), 'utf8');
  assert.ok(!/\bseal\s*\(|['"]guard['"]|GITHUB_RUN_\w+\s*=|gh\(\['release', '(create|upload|delete)'/.test(script));
  assert.equal((script.match(/gh\(\['release', 'edit'/g) ?? []).length, 1);
  assert.match(script, /if \(final.draft\) gh\(\['release', 'edit', origin.tag, '--repo', origin.repository, '--draft=false'\]\)/);
  const workflow = readFileSync(new URL('../.github/workflows/castlabs-vsi-publish-existing.yml', import.meta.url), 'utf8');
  assert.ok(!/^  (push|pull_request|schedule|workflow_run):/m.test(workflow));
  assert.match(workflow, /ref: acfa8dd64f499e5f0c459e534b5b5d2437fb5197/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(workflow, /actions: read/);
  const publicJob = workflow.split('  public-smoke:')[1];
  assert.ok(!/GH_TOKEN|GITHUB_TOKEN|secrets\.|cache:|contents: write|actions: write/.test(publicJob));
  assert.ok(!/cargo |wasm-pack|pnpm pack|npm publish|release upload/.test(workflow));
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
});
