import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, publicUrl, selectRelease } from './vsi-promote.mjs';

export function publicManifest(descriptor) {
  return {
    name: 'vsi-public-url-consumer', version: '0.0.0', private: true, type: 'module',
    packageManager: 'pnpm@10.15.0',
    dependencies: Object.fromEntries(descriptor.packages.map(pkg => [pkg.name, publicUrl(pkg, descriptor)])),
    devDependencies: { typescript: '5.8.2' }
  };
}

export function verifyPublicGraph(graph, roots, descriptor) {
  const { packages } = descriptor;
  assert.equal(graph.length, 1);
  const seen = new Set();
  function visit(node) {
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, dep] of Object.entries(node[field] ?? {})) {
        if (name.startsWith('@stardustproof/') || dep.name?.startsWith('@stardustproof/')) {
          const pkg = packages.find(pkg => pkg.name === name);
          assert.ok(pkg, `Unexpected SDK package ${name}`);
          assert.ok(!dep.name || dep.name === name, 'SDK alias is not allowed');
          assert.equal(dep.version, pkg.version);
          assert.equal(dep.resolved, publicUrl(pkg, descriptor), `Nonpublic or registry fallback: ${name}`);
          assert.equal(realpathSync(dep.path), roots[name], `Duplicate or nonisolated SDK: ${name}`);
          seen.add(name);
        }
        visit(dep);
      }
    }
  }
  assert.deepEqual(Object.keys(graph[0].dependencies).sort(), packages.map(p => p.name).sort());
  visit(graph[0]);
  assert.equal(seen.size, 4);
}

export function verifyAnonymousEnvironment(env) {
  for (const [key, value] of Object.entries(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)$/i.test(key)
      || /^(npm_config_|pnpm_).*(_auth|token|password)/i.test(key)) assert.ok(!value, `Credential present: ${key}`);
  }
  assert.ok(!env.NODE_OPTIONS, 'Do not inject loaders or repository aliases');
  assert.ok(!env.NODE_PATH, 'Do not inject external module paths');
}

async function smoke(output, descriptor) {
  const { origin, anchors, packages, wasmSha256 } = descriptor;
  assert.match(wasmSha256, /^[a-f0-9]{64}$/, 'Reviewed WASM digest required');
  verifyAnonymousEnvironment(process.env);
  mkdirSync(output); // A rerun gets a new job and a fresh install/store, never cached products.
  const consumer = join(output, 'consumer');
  const home = join(output, 'home');
  mkdirSync(consumer);
  mkdirSync(home);
  const emptyConfig = join(home, 'empty.npmrc');
  writeFileSync(emptyConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_config_|pnpm_)/i.test(key)));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyConfig });
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: consumer, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, `${command} failed: ${result.error ?? result.stderr ?? result.stdout}`);
    return result.stdout.trim();
  };
  assert.equal(run('pnpm', ['--version']), '10.15.0');
  async function download(name, sha256) {
    const url = `https://github.com/${origin.repository}/releases/download/${origin.tag}/${name}`;
    const response = await fetch(url); // No GitHub client, authorization header, cookies or API asset URLs.
    assert.equal(response.status, 200, `Anonymous public URL failed: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), sha256, `Anonymous bytes differ: ${name}`);
    writeFileSync(join(output, name), bytes, { flag: 'wx' });
    return bytes;
  }
  const bundle = JSON.parse((await download('provenance.json', anchors['provenance.json'].sha256)).toString('utf8'));
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.bundleVersion, origin.tag.slice(1));
  assert.deepEqual(bundle.packages, packages);
  assert.equal(bundle.identity.sourceSha, origin.sourceSha);
  assert.equal(bundle.identity.sdkSha, origin.sdkSha);
  assert.equal(bundle.wasm.sha256, wasmSha256, 'Provenance WASM differs from reviewed digest');
  for (const pkg of packages) await download(pkg.file, pkg.sha256);
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(publicManifest(descriptor), null, 2)}\n`);
  run('pnpm', ['install', '--ignore-workspace', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', join(output, 'store')]);
  const roots = Object.fromEntries(packages.map(pkg => {
    const path = realpathSync(join(consumer, 'node_modules', pkg.name));
    assert.ok(path.startsWith(`${realpathSync(consumer)}${sep}node_modules${sep}`), 'SDK escaped isolated consumer');
    return [pkg.name, path];
  }));
  const graph = JSON.parse(run('pnpm', ['list', '--json', '--depth', 'Infinity']));
  verifyPublicGraph(graph, roots, descriptor);
  writeFileSync(join(output, 'public-consumer-graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
  writeFileSync(join(output, 'public-consumer-pnpm-lock.yaml'), readFileSync(join(consumer, 'pnpm-lock.yaml')));
  const installed = [];
  for (const pkg of packages) {
    const expected = join(output, `expected-${pkg.name.split('/')[1]}`);
    mkdirSync(expected);
    const tarball = join(output, pkg.file);
    const entries = run('tar', ['-tzf', tarball]).split('\n');
    assert.ok(entries.every(entry => entry.startsWith('package/') && !/[\\\x00-\x1f\x7f]/.test(entry)
      && entry.replace(/\/$/, '').split('/').every(part => part !== '' && part !== '.' && part !== '..')), 'Unsafe archive path');
    assert.equal(new Set(entries.map(entry => entry.replace(/\/$/, ''))).size, entries.length, 'Duplicate archive path');
    assert.ok(run('tar', ['-tvzf', tarball]).split('\n').every(line => /^[-d]/.test(line)), 'Only regular files and directories are allowed');
    run('tar', ['-xzf', tarball, '-C', expected]);
    for (const entry of entries.filter(e => !e.endsWith('/'))) {
      assert.equal(hash(readFileSync(join(roots[pkg.name], entry.slice('package/'.length)))), hash(readFileSync(join(expected, entry))), `Installed bytes differ: ${pkg.name}/${entry}`);
    }
    const manifest = JSON.parse(readFileSync(join(roots[pkg.name], 'package.json'), 'utf8'));
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.ok(!JSON.stringify(manifest.exports).includes('development'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith('@stardustproof/')) {
          const dependency = packages.find(pkg => pkg.name === name);
          assert.ok(dependency);
          assert.equal(version, publicUrl(dependency, descriptor));
        } else assert.ok(!/^(file:|workspace:|link:)/.test(version));
      }
    }
    installed.push({ name: pkg.name, sha256: pkg.sha256, verifiedFiles: entries.filter(e => !e.endsWith('/')).length });
  }
  // Reuse the qualified vsi-consumer.mjs SDK probe assertions, not its local override installer.
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createC2pa, LiveVideoValidator, Context } from '@stardustproof/c2pa-web';
import { createC2pa as inline } from '@stardustproof/c2pa-web/inline';
import init, { WASM_SRI, WasmLiveVideoValidator } from '@stardustproof/c2pa-wasm';
import { Context as UtilityContext } from '@stardustproof/c2pa-utilities';
for (const value of [createC2pa, inline, LiveVideoValidator, Context, init, WasmLiveVideoValidator, UtilityContext]) assert.equal(typeof value, 'function');
for (const [name, root] of Object.entries(${JSON.stringify(roots)})) assert.equal(realpathSync(new URL(import.meta.resolve(name + '/package.json'))), root + '/package.json');
readFileSync(new URL(import.meta.resolve('@stardustproof/c2pa-web/c2pa_worker')));
const bytes = readFileSync(new URL(import.meta.resolve('@stardustproof/c2pa-wasm/c2pa.wasm')));
for (const name of ['@stardustproof/c2pa-web/resources/c2pa.wasm', '@stardustproof/c2pa-wasm/assets/c2pa_bg.wasm']) assert.deepEqual(readFileSync(new URL(import.meta.resolve(name))), bytes);
readFileSync(new URL(import.meta.resolve('@stardustproof/c2pa-wasm/assets/c2pa_bg.wasm.d.ts')));
assert.equal(WASM_SRI, 'sha256-' + createHash('sha256').update(bytes).digest('base64'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), ${JSON.stringify(wasmSha256)});
await WebAssembly.compile(bytes);
`);
  run(process.execPath, ['probe.mjs']);
  writeFileSync(join(consumer, 'probe.mts'), `
import { createC2pa, LiveVideoValidator, Context } from '@stardustproof/c2pa-web';
import { createC2pa as inline } from '@stardustproof/c2pa-web/inline';
import { Context as UtilityContext } from '@stardustproof/c2pa-utilities';
import type { ManifestStore } from '@stardustproof/c2pa-types';
import init, { WASM_SRI, WasmLiveVideoValidator } from '@stardustproof/c2pa-wasm';
const exports = [createC2pa, inline, LiveVideoValidator, Context, UtilityContext, init, WASM_SRI, WasmLiveVideoValidator];
const store: ManifestStore | undefined = undefined;
void exports; void store;
${origin.tag === 'v1.0.9' ? `
const context = new UtilityContext({ builder: { generateC2paArchive: true, bmffHashExtraExclusions: [
  { xpath: '/sidx', length: 32, data: [{ offset: 8, value: [0] }], subset: [{ offset: 12, length: 0 }], version: 0, flags: [0, 0, 1], exact: false }
] } });
// @ts-expect-error the installed facade must reject malformed descriptors
new UtilityContext({ builder: { generateC2paArchive: true, bmffHashExtraExclusions: [{ xpath: 7 }] } });
void context;
` : ''}
`);
  run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), 'probe.mts', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'ES2023', '--lib', 'ES2023,DOM,ESNext.Disposable']);
  verifyPublicGraph(JSON.parse(run('pnpm', ['list', '--json', '--depth', 'Infinity'])), roots, descriptor);
  for (const pkg of packages) assert.equal(hash(readFileSync(join(output, pkg.file))), pkg.sha256);
  writeFileSync(join(output, 'public-consumer.json'), `${JSON.stringify({ passed: true, scope: 'anonymous-public-final-urls-v1', origin, installed, checks: ['anonymous-approved-tarballs', 'fresh-pnpm-10.15.0-store', 'four-url-roots-and-transitive-graph', 'installed-file-hashes', 'module-exports-and-aliases', 'strict-typescript', 'wasm-compile-and-sri'] }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Expected output directory and exact reviewed release tag');
  await smoke(resolve(process.argv[2]), selectRelease(process.argv[3]));
}
