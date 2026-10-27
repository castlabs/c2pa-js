import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { directories, filename, hash, json, run, save, verifySource } from './vsi-release.mjs';
import { offsetCases, offsetNames } from './vsi-installed-offsets.mjs';

export function consumerManifest(bundle, output) {
  assert.deepEqual(bundle.packages.map(p => p.name), directories.map(d => `@stardustproof/${d}`));
  const dependencies = Object.fromEntries(bundle.packages.map(pkg => {
    assert.equal(pkg.file, filename(pkg.name.split('/')[1], pkg.version));
    assert.equal(hash(readFileSync(join(output, pkg.file))), pkg.sha256);
    return [pkg.name, `file:${resolve(output, pkg.file)}`];
  }));
  return { name: 'vsi-installed-consumer', version: '0.0.0', private: true, type: 'module', packageManager: 'pnpm@10.15.0', dependencies, pnpm: { overrides: { ...dependencies } } };
}

export function installConsumer(bundle, output, consumer) {
  mkdirSync(consumer);
  save(join(consumer, 'package.json'), consumerManifest(bundle, output));
  run('pnpm', ['install', '--ignore-workspace', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', join(consumer, '.store')], consumer, true);
  const roots = Object.fromEntries(bundle.packages.map(pkg => {
    const path = realpathSync(join(consumer, 'node_modules', pkg.name));
    assert.ok(path.startsWith(`${realpathSync(consumer)}${sep}node_modules${sep}`));
    return [pkg.name, path];
  }));
  const graph = JSON.parse(run('pnpm', ['list', '--json', '--depth', 'Infinity'], consumer));
  const seen = new Set();
  function checkGraph(node) {
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, dependency] of Object.entries(node[field] ?? {})) {
        if (name.startsWith('@stardustproof/') || dependency.name?.startsWith('@stardustproof/')) {
          assert.ok(roots[name], `Unknown product dependency ${name}`);
          assert.equal(realpathSync(dependency.path), roots[name], `Nonlocal or duplicate product dependency ${name}`);
          assert.match(dependency.resolved, /^file:/, `Registry/release fallback ${name}`);
          seen.add(name);
        }
        checkGraph(dependency);
      }
    }
  }
  graph.forEach(checkGraph);
  assert.equal(seen.size, 4);
  for (const pkg of bundle.packages) {
    const expected = join(consumer, 'expected');
    mkdirSync(expected);
    const tarball = join(output, pkg.file);
    const entries = run('tar', ['-tzf', tarball], consumer).split('\n');
    assert.ok(entries.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')));
    run('tar', ['-xzf', tarball, '-C', expected], consumer);
    for (const entry of entries.filter(e => !e.endsWith('/'))) assert.equal(hash(readFileSync(join(roots[pkg.name], entry.slice('package/'.length)))), hash(readFileSync(join(expected, entry))), `Installed bytes differ: ${pkg.name}/${entry}`);
    const manifest = json(join(roots[pkg.name], 'package.json'));
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.ok(!JSON.stringify(manifest.exports).includes('development'));
    rmSync(expected, { recursive: true });
  }
  return { roots, graph };
}

// Copy only test assertions and fixture data, never repository SDK code or aliases.
export function prepareHarness(root, consumer, playwrightEntry) {
  const web = '@stardustproof/c2pa-web';
  const wasm = '@stardustproof/c2pa-wasm';
  const fixtureSource = join(root, 'packages/c2pa-web/test/assets/single-file');
  const layoutText = readFileSync(join(fixtureSource, 'layout.ts'), 'utf8');
  // The checked-in layout is a TS object literal, not JSON (unquoted keys).
  const expression = layoutText.match(/export const singleFileLayout = ([\s\S]*) as const;/)?.[1];
  assert.ok(expression);
  const layout = JSON.parse(JSON.stringify(runInNewContext(`(${expression})`, Object.create(null), { timeout: 1000 })));
  mkdirSync(join(consumer, 'public/fixtures'), { recursive: true });
  const fixtureHashes = { 'layout.ts': hash(layoutText) };
  for (const file of readdirSync(fixtureSource).filter(file => /\.(mp4|m4s)$/.test(file))) {
    cpSync(join(fixtureSource, file), join(consumer, 'public/fixtures', file));
    fixtureHashes[file] = hash(readFileSync(join(fixtureSource, file)));
  }
  cpSync(join(root, 'tmp/vsi-fixtures'), join(consumer, 'public/tmp/vsi-fixtures'), { recursive: true });
  mkdirSync(join(consumer, 'tools'));
  writeFileSync(join(consumer, 'tools/vsi.html'), '<!doctype html><html><head><title>Installed VSI consumer</title></head><body><script type="module" src="/harness.js"></script></body></html>');
  writeFileSync(join(consumer, 'harness.js'), `
import * as api from ${JSON.stringify(web)};
import initWasm, * as wasmApi from ${JSON.stringify(wasm)};
import wasmSrc from ${JSON.stringify(`${wasm}/c2pa.wasm?url`)};
import workerSrc from ${JSON.stringify(`${web}/c2pa_worker?url`)};
const inlineApi = new URLSearchParams(location.search).get('mode') === 'inline' ? await import(${JSON.stringify(`${web}/inline`)}) : undefined;
Object.assign(window, { api, inlineApi, wasmApi, initWasm, wasmSrc, workerSrc, ready: true });
window.runOffsetCases = name => (${offsetCases.toString()})(${JSON.stringify(layout)}, api.createC2pa, api.Reader, api.Context, wasmSrc, name);
`);
  let tests = readFileSync(join(root, 'packages/c2pa-web/test/vsi/qualification.pw.ts'), 'utf8');
  const assertionHash = hash(tests);
  const resources = new Map([
    ['@playwright/test', JSON.stringify(playwrightEntry)],
    ['/packages/c2pa-wasm/pkg/c2pa_bg.wasm', '(window as any).wasmSrc'],
    ['/packages/c2pa-web/dist/c2pa_worker.js', '(window as any).workerSrc']
  ]);
  const replaced = new Set();
  tests = tests.replace(/(['"])([^'"\n]+)\1/g, (literal, _quote, value) => {
    if (!resources.has(value)) return literal;
    replaced.add(value);
    return resources.get(value);
  });
  assert.equal(replaced.size, resources.size, 'Missing qualification runner or installed resource references');
  assert.ok(!tests.includes('/packages/'), 'Installed tests still refer to repository SDK paths');
  writeFileSync(join(consumer, 'qualification.pw.ts'), tests);
  writeFileSync(join(consumer, 'offsets.pw.ts'), `
import { test, expect } from ${JSON.stringify(playwrightEntry)};
for (const name of ${JSON.stringify(offsetNames)}) {
  test(name, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/tools/vsi.html');
    await page.waitForFunction(() => window.ready);
    const results = await page.evaluate(name => window.runOffsetCases(name), name);
    expect(results).toEqual([{ name, passed: true }]);
    expect(errors).toEqual([]);
  });
}
`);
  writeFileSync(join(consumer, 'playwright.config.mjs'), `
import { defineConfig } from ${JSON.stringify(playwrightEntry)};
export default defineConfig({ testDir: '.', testMatch: '**/*.pw.ts', timeout: 120000, retries: 0, workers: 1, use: { baseURL: 'https://127.0.0.1:4173', ignoreHTTPSErrors: true }, projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })), reporter: [['list'], ['json', { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME }]] });
`);
  return { fixtureHashes, assertionHash };
}

async function smoke(root, output, consumer, sha, version) {
  const bundle = json(join(output, 'provenance.json'));
  assert.deepEqual(verifySource(root, sha, version), bundle.identity);
  const { roots, graph } = installConsumer(bundle, output, consumer);
  save(join(output, 'consumer-graph.json'), graph);
  cpSync(join(consumer, 'pnpm-lock.yaml'), join(output, 'consumer-pnpm-lock.yaml'));
  const web = '@stardustproof/c2pa-web';
  const wasm = '@stardustproof/c2pa-wasm';
  const utilities = '@stardustproof/c2pa-utilities';
  const types = '@stardustproof/c2pa-types';
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createC2pa, LiveVideoValidator, Context } from ${JSON.stringify(web)};
import { createC2pa as inline } from ${JSON.stringify(`${web}/inline`)};
import init, { WASM_SRI, WasmLiveVideoValidator } from ${JSON.stringify(wasm)};
import { Context as UtilityContext } from ${JSON.stringify(utilities)};
for (const value of [createC2pa, inline, LiveVideoValidator, Context, init, WasmLiveVideoValidator, UtilityContext]) assert.equal(typeof value, 'function');
for (const [name, root] of Object.entries(${JSON.stringify(roots)})) assert.equal(realpathSync(new URL(import.meta.resolve(name + '/package.json'))), root + '/package.json');
readFileSync(new URL(import.meta.resolve(${JSON.stringify(`${web}/c2pa_worker`)})));
const bytes = readFileSync(new URL(import.meta.resolve(${JSON.stringify(`${wasm}/c2pa.wasm`)})));
for (const name of ${JSON.stringify([`${web}/resources/c2pa.wasm`, `${wasm}/assets/c2pa_bg.wasm`])}) assert.deepEqual(readFileSync(new URL(import.meta.resolve(name))), bytes);
readFileSync(new URL(import.meta.resolve(${JSON.stringify(`${wasm}/assets/c2pa_bg.wasm.d.ts`)})));
assert.equal(WASM_SRI, 'sha256-' + createHash('sha256').update(bytes).digest('base64'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), ${JSON.stringify(bundle.wasm.sha256)});
await WebAssembly.compile(bytes);
`);
  run(process.execPath, ['probe.mjs'], consumer, true);
  writeFileSync(join(consumer, 'probe.mts'), `
import { createC2pa, LiveVideoValidator, Context } from ${JSON.stringify(web)};
import { createC2pa as inline } from ${JSON.stringify(`${web}/inline`)};
import { Context as UtilityContext } from ${JSON.stringify(utilities)};
import type { ManifestStore } from ${JSON.stringify(types)};
import init, { WASM_SRI, WasmLiveVideoValidator } from ${JSON.stringify(wasm)};
const exports = [createC2pa, inline, LiveVideoValidator, Context, UtilityContext, init, WASM_SRI, WasmLiveVideoValidator];
const store: ManifestStore | undefined = undefined;
const context = new UtilityContext({ builder: { generateC2paArchive: true, bmffHashExtraExclusions: [
  { xpath: '/sidx', length: 32, data: [{ offset: 8, value: [0] }], subset: [{ offset: 12, length: 0 }], version: 0, flags: [0, 0, 1], exact: false }
] } });
// @ts-expect-error the installed facade must reject malformed descriptors
new UtilityContext({ builder: { generateC2paArchive: true, bmffHashExtraExclusions: [{ xpath: 7 }] } });
void exports; void store; void context;
`);
  const workspaceRequire = createRequire(join(root, 'package.json'));
  const webRequire = createRequire(join(root, 'packages/c2pa-web/package.json'));
  run(process.execPath, [workspaceRequire.resolve('typescript/bin/tsc'), 'probe.mts', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'ES2023', '--lib', 'ES2023,DOM,ESNext.Disposable'], consumer, true);
  const playwrightManifest = webRequire.resolve('@playwright/test/package.json');
  const playwrightImport = json(playwrightManifest).exports['.'].import;
  assert.equal(typeof playwrightImport, 'string');
  const harness = prepareHarness(root, consumer, pathToFileURL(resolve(dirname(playwrightManifest), playwrightImport)).href);
  const viteModule = await import(pathToFileURL(workspaceRequire.resolve('vite')).href);
  const { createServer, loadConfigFromFile } = viteModule.default ?? viteModule;
  // Reuse only the qualification middleware (CSP and OCSP receipt gates), never
  // its repository root, filesystem allow list, resolution or SDK imports.
  const qualificationConfig = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(root, 'tools/vsi-vite.config.ts'));
  assert.ok(qualificationConfig);
  const server = await createServer({
    root: consumer, configFile: false, cacheDir: join(consumer, '.vite'),
    server: { host: '127.0.0.1', port: 4173, strictPort: true, fs: { strict: true, allow: [consumer] }, https: { key: readFileSync(join(root, 'tmp/vsi-server.key')), cert: readFileSync(join(root, 'tmp/vsi-server.crt')) } },
    optimizeDeps: { exclude: [web, wasm, utilities] },
    plugins: qualificationConfig.config.plugins
  });
  try {
    await server.listen();
    // Asynchronous child processes let this process continue serving Vite requests.
    const { spawn } = await import('node:child_process');
    for (const [testFile, report] of [['qualification.pw.ts', 'installed-vsi.json'], ['offsets.pw.ts', 'installed-offsets.json']]) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [webRequire.resolve('@playwright/test/cli'), 'test', testFile, '--config', join(consumer, 'playwright.config.mjs')], { cwd: consumer, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: join(output, report) } });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Installed browser tests exited ${code}`)));
      });
    }
  } finally { await server.close(); }
  assert.deepEqual(verifySource(root, sha, version), bundle.identity);
  consumerManifest(bundle, output);
  save(join(output, 'consumer.json'), { passed: true, scope: 'isolated-installed-four-tarballs-v1', packages: bundle.packages, ...harness, checks: ['local-only-product-graph', 'installed-file-hashes', 'package-exports', 'typescript', 'wasm-compile-and-sri', 'real-worker-vsi', 'strict-csp-external-worker', 'fragment-offsets'] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, output, consumer, sha, version] = process.argv.slice(2);
  await smoke(resolve(root), resolve(output), resolve(consumer), sha, version);
}
