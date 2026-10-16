import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packages, verifySource } from './castlabs-release.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
export const packagedBrowserScope = 'installed-tarballs/fragment-offset-v1';
export const packagedBrowserCases = [
  'valid-solo-segments', 'missing-and-zero-offset', 'wrong-offset', 'sidx-cut',
  'without-settings', 'invalid-offsets', 'valid-ladder-segments', 'cross-rendition',
  'ladder-missing-offset'
];
function run(command, args, cwd, inherit = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.error ?? result.stderr}`);
  return result.stdout?.trim();
}

export function consumerManifest(bundle, output) {
  assert.deepEqual(bundle.packages.map(pkg => [pkg.name, pkg.version]), packages.map(pkg => [`@stardustproof/${pkg.directory}`, pkg.version]));
  const dependencies = Object.fromEntries(bundle.packages.map(pkg => {
    const expected = `stardustproof-${pkg.name.split('/')[1]}-${pkg.version}.tgz`;
    assert.equal(pkg.file, expected);
    assert.equal(hash(readFileSync(join(output, pkg.file))), pkg.sha256, `Tarball hash mismatch: ${pkg.name}`);
    return [pkg.name, `file:${resolve(output, pkg.file)}`];
  }));
  // Only consumer resolution changes. The final tarballs and their URL dependencies stay intact.
  return { name: 'castlabs-packed-consumer', version: '0.0.0', private: true, type: 'module', packageManager: 'pnpm@10.15.0', dependencies, pnpm: { overrides: { ...dependencies } } };
}

export function installConsumer(bundle, output, consumer) {
  mkdirSync(consumer);
  save(join(consumer, 'package.json'), consumerManifest(bundle, output));
  run('pnpm', ['install', '--ignore-workspace', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', join(consumer, '.store')], consumer, true);
  const graph = JSON.parse(run('pnpm', ['list', '--json', '--depth', 'Infinity'], consumer));
  const roots = Object.fromEntries(bundle.packages.map(pkg => {
    const path = realpathSync(join(consumer, 'node_modules', pkg.name));
    assert.ok(path.startsWith(`${realpathSync(consumer)}${sep}node_modules${sep}`), 'Package escaped the isolated consumer');
    return [pkg.name, path];
  }));
  const seen = new Set();
  function checkGraph(node) {
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, dependency] of Object.entries(node[field] ?? {})) {
        const actualName = dependency.name ?? name;
        if (name.startsWith('@stardustproof/') || actualName.startsWith('@stardustproof/')) {
          assert.ok(roots[name], `Unexpected internal package: ${name}`);
          assert.equal(realpathSync(dependency.path), roots[name], `Duplicate or nonlocal internal package: ${name}`);
          assert.match(dependency.resolved, /^file:/, `Registry or release fallback: ${name}`);
          seen.add(name);
        }
        checkGraph(dependency);
      }
    }
  }
  graph.forEach(checkGraph);
  assert.equal(seen.size, packages.length);
  const installed = [];
  for (const pkg of bundle.packages) {
    const expected = join(consumer, `expected-${pkg.name.split('/')[1]}`);
    mkdirSync(expected);
    const tarball = join(output, pkg.file);
    const entries = run('tar', ['-tzf', tarball], consumer).split('\n');
    assert.ok(entries.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')), 'Unsafe archive path');
    run('tar', ['-xzf', tarball, '-C', expected], consumer);
    const files = entries.filter(entry => !entry.endsWith('/'));
    for (const entry of files) {
      assert.equal(hash(readFileSync(join(roots[pkg.name], entry.slice('package/'.length)))), hash(readFileSync(join(expected, entry))), `Installed bytes differ: ${pkg.name}/${entry}`);
    }
    installed.push({ name: pkg.name, tarballSha256: pkg.sha256, verifiedFiles: files.length });
    rmSync(expected, { recursive: true, force: true });
  }
  // Verify that neither install nor lifecycle processing changed the release inputs.
  consumerManifest(bundle, output);
  return { graph, installed };
}

// Serialized into the isolated page; all SDK calls use installed package exports.
export async function packagedCasesInBrowser(layout, createC2pa, wasmSrc) {
  const sdk = await createC2pa({ wasmSrc });
  const cases = [];
  const blobs = new Map();
  const noTrust = { verify: { verifyTrust: false } };
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  async function blob(file) {
    if (!blobs.has(file)) {
      const response = await fetch(`/fixtures/${encodeURIComponent(file)}`);
      require(response.ok, `Fixture ${file}: HTTP ${response.status}`);
      blobs.set(file, await response.blob());
    }
    return blobs.get(file);
  }
  async function verify(init, segment, offset, withoutSettings = false) {
    const reader = await sdk.reader.fromBlobFragment('video/mp4', await blob(init), await blob(segment),
      withoutSettings ? undefined : noTrust, offset === undefined ? undefined : { fragmentBaseOffset: offset });
    require(reader !== null, 'Expected a C2PA reader');
    try {
      const store = await reader.manifestStore();
      const active = store.validation_results?.activeManifest;
      return { state: store.validation_state, success: (active?.success ?? []).map(s => s.code), failure: (active?.failure ?? []).map(s => s.code) };
    } finally { await reader.free(); }
  }
  function bound(verdict) {
    require(['Valid', 'Trusted'].includes(verdict.state) && verdict.success.includes('assertion.bmffHash.match') && !verdict.failure.includes('assertion.bmffHash.mismatch'), `Expected binding match: ${JSON.stringify(verdict)}`);
  }
  function rejected(verdict) {
    require(verdict.state === 'Invalid' && verdict.failure.includes('assertion.bmffHash.mismatch'), `Expected binding mismatch: ${JSON.stringify(verdict)}`);
  }
  async function check(name, test) {
    try { await test(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: String(error.stack ?? error) }); }
  }
  const solo = layout['solo-360p'];
  const high = layout['ladder-360p'];
  const low = layout['ladder-180p'];
  try {
    await check('valid-solo-segments', async () => {
      require(solo.segments.length > 1, 'Expected multiple signed segments');
      for (const seg of solo.segments) bound(await verify(solo.init, seg.file, seg.offset));
    });
    await check('missing-and-zero-offset', async () => {
      for (const offset of [undefined, 0]) rejected(await verify(solo.init, solo.segments[1].file, offset));
    });
    await check('wrong-offset', async () => {
      const seg = solo.segments[1];
      for (const offset of [seg.offset + 1, seg.offset - 1]) rejected(await verify(solo.init, seg.file, offset));
    });
    await check('sidx-cut', async () => rejected(await verify(solo.init, 'solo-360p.sidxcut01.m4s', solo.sidxCutOfSegment1.offset)));
    await check('without-settings', async () => {
      const seg = solo.segments[3];
      const right = await verify(solo.init, seg.file, seg.offset, true);
      require(right.state === 'Valid' && right.success.includes('assertion.bmffHash.match') && JSON.stringify(right.failure) === JSON.stringify(['signingCredential.untrusted']), `Unexpected default settings verdict: ${JSON.stringify(right)}`);
      rejected(await verify(solo.init, seg.file, seg.offset + 1, true));
    });
    await check('invalid-offsets', async () => {
      for (const offset of [-1, 1.5, NaN, Infinity, 2 ** 53]) {
        let rangeError = false;
        try {
          const reader = await sdk.reader.fromBlobFragment('video/mp4', await blob(solo.init), await blob(solo.segments[0].file), noTrust, { fragmentBaseOffset: offset });
          await reader?.free();
        } catch (error) { if (!(error instanceof RangeError)) throw error; rangeError = true; }
        require(rangeError, `Expected RangeError for ${String(offset)}`);
      }
    });
    await check('valid-ladder-segments', async () => {
      for (const rendition of [high, low]) for (const seg of rendition.segments) bound(await verify(rendition.init, seg.file, seg.offset));
    });
    await check('cross-rendition', async () => {
      rejected(await verify(high.init, low.segments[2].file, low.segments[2].offset));
      rejected(await verify(low.init, high.segments[2].file, high.segments[2].offset));
    });
    await check('ladder-missing-offset', async () => rejected(await verify(low.init, low.segments[0].file)));
    return cases;
  } finally { sdk.dispose(); }
}

async function browserCommand(root, consumer, browserName, reportPath) {
  assert.ok(['chromium', 'firefox', 'webkit'].includes(browserName));
  const report = { browser: browserName, scope: packagedBrowserScope, passed: false, cases: [] };
  let server, browser, timer;
  try {
    const workspaceRequire = createRequire(join(root, 'package.json'));
    const webRequire = createRequire(join(root, 'packages/c2pa-web/package.json'));
    const vite = await import(pathToFileURL(workspaceRequire.resolve('vite')).href);
    const { createServer } = vite.default ?? vite;
    const playwright = webRequire('@playwright/test');
    server = await createServer({
      root: consumer, configFile: false, cacheDir: join(consumer, '.vite'),
      server: { host: '127.0.0.1', port: 0, fs: { strict: true, allow: [consumer] } },
      optimizeDeps: { exclude: ['@stardustproof/c2pa-web', '@stardustproof/c2pa-wasm'] }
    });
    await server.listen();
    browser = await playwright[browserName].launch({ headless: true });
    report.version = browser.version();
    const page = await browser.newPage();
    report.pageErrors = [];
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('console', message => console.log(`[${browserName}] ${message.type()}: ${message.text()}`));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { timeout: 60000 });
    await page.waitForFunction(() => typeof window.runPackagedCases === 'function', undefined, { timeout: 60000 });
    report.cases = await Promise.race([
      page.evaluate(() => window.runPackagedCases()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged cases timed out')), 120000); })
    ]);
    assert.deepEqual(report.cases.map(test => test.name), packagedBrowserCases);
    assert.ok(report.cases.every(test => test.passed === true), JSON.stringify(report.cases));
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) { report.error = String(error.stack ?? error); }
  finally {
    clearTimeout(timer);
    const cleanup = await Promise.allSettled([browser?.close(), server?.close()]);
    if (cleanup.some(result => result.status === 'rejected')) { report.passed = false; report.cleanupErrors = cleanup.filter(result => result.status === 'rejected').map(result => String(result.reason)); }
    save(reportPath, report);
  }
  assert.ok(report.passed, `Packaged ${browserName} qualification failed: ${JSON.stringify(report)}`);
}

export function qualifyPackagedBrowsers(root, output, consumer, bundle) {
  const fixtureSource = join(root, 'packages/c2pa-web/test/assets/single-file');
  const fixtureDestination = join(consumer, 'public/fixtures');
  mkdirSync(fixtureDestination, { recursive: true });
  const layoutText = readFileSync(join(fixtureSource, 'layout.ts'), 'utf8');
  const layout = JSON.parse(layoutText.match(/export const singleFileLayout = ([\s\S]*) as const;/)?.[1]);
  const fixtureHashes = { 'layout.ts': hash(layoutText) };
  for (const file of readdirSync(fixtureSource).filter(file => /\.(mp4|m4s)$/.test(file)).sort()) {
    cpSync(join(fixtureSource, file), join(fixtureDestination, file));
    fixtureHashes[file] = hash(readFileSync(join(fixtureDestination, file)));
  }
  writeFileSync(join(consumer, 'index.html'), '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><script type="module" src="/browser-probe.js"></script></body></html>');
  writeFileSync(join(consumer, 'browser-probe.js'), `import { createC2pa } from '@stardustproof/c2pa-web';\nimport wasmSrc from '@stardustproof/c2pa-web/resources/c2pa.wasm?url';\nwindow.runPackagedCases = () => (${packagedCasesInBrowser.toString()})(${JSON.stringify(layout)}, createC2pa, wasmSrc);\n`);
  const results = [];
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    const reportPath = join(output, 'diagnostics', `packaged-${browser}.json`);
    rmSync(reportPath, { force: true });
    const command = [process.execPath, fileURLToPath(import.meta.url), 'browser', root, consumer, browser, reportPath];
    console.log(`Running packaged browser command: ${command.join(' ')}`);
    const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', timeout: 240000 });
    let report = null, reportError;
    try { if (existsSync(reportPath)) report = json(reportPath); }
    catch (error) { reportError = String(error); }
    results.push({ browser, command, exitCode: result.status, signal: result.signal, error: result.error?.message ?? reportError, report });
  }
  const passed = results.every(result => result.exitCode === 0 && result.report?.passed === true && result.report.scope === packagedBrowserScope && JSON.stringify(result.report.cases.map(test => test.name)) === JSON.stringify(packagedBrowserCases) && result.report.cases.every(test => test.passed === true));
  return { passed, status: passed ? 'passed' : 'failed', scope: packagedBrowserScope, packageHashes: bundle.packages.map(pkg => ({ file: pkg.file, sha256: pkg.sha256 })), fixtureHashes, results };
}

function smoke(root, output, sourceSha, label) {
  const path = join(output, 'provenance.json');
  const bundle = json(path);
  assert.deepEqual(verifySource(root, sourceSha, label), bundle.sources);
  const temp = mkdtempSync(join(tmpdir(), 'castlabs-consumer-'));
  const consumer = join(temp, 'consumer');
  try {
    const evidence = installConsumer(bundle, output, consumer);
    save(join(output, 'diagnostics/consumer-package.json'), json(join(consumer, 'package.json')));
    writeFileSync(join(output, 'diagnostics/consumer-pnpm-lock.yaml'), readFileSync(join(consumer, 'pnpm-lock.yaml')));
    save(join(output, 'diagnostics/consumer-graph.json'), evidence.graph);
    writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createC2pa } from '@stardustproof/c2pa-web';
import { createC2pa as createInline } from '@stardustproof/c2pa-web/inline';
import init, { WASM_SRI } from '@stardustproof/c2pa-wasm';
assert.equal(typeof createC2pa, 'function');
assert.equal(typeof createInline, 'function');
assert.equal(typeof init, 'function');
const bytes = readFileSync(new URL(import.meta.resolve('@stardustproof/c2pa-wasm/c2pa.wasm')));
for (const name of ['@stardustproof/c2pa-web/resources/c2pa.wasm', '@stardustproof/c2pa-wasm/assets/c2pa_bg.wasm']) {
  assert.deepEqual(readFileSync(new URL(import.meta.resolve(name))), bytes);
}
readFileSync(new URL(import.meta.resolve('@stardustproof/c2pa-wasm/assets/c2pa_bg.wasm.d.ts')));
assert.equal(WASM_SRI, 'sha512-' + createHash('sha512').update(bytes).digest('base64'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), ${JSON.stringify(bundle.wasm.sha256)});
await WebAssembly.compile(bytes);
`);
    run(process.execPath, ['probe.mjs'], consumer, true);
    writeFileSync(join(consumer, 'probe.mts'), `
import { createC2pa } from '@stardustproof/c2pa-web';
import { createC2pa as createInline } from '@stardustproof/c2pa-web/inline';
import type { ManifestStore } from '@stardustproof/c2pa-types';
import init, { WASM_SRI } from '@stardustproof/c2pa-wasm';
const exports = [createC2pa, createInline, init, WASM_SRI];
const manifest: ManifestStore | undefined = undefined;
void exports; void manifest;
`);
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), 'probe.mts', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'ES2023', '--lib', 'ES2023,DOM,ESNext.Disposable'], consumer, true);
    assert.deepEqual(verifySource(root, sourceSha, label), bundle.sources);
    consumerManifest(bundle, output);
    bundle.consumerSmoke = { passed: true, status: 'passed', installed: evidence.installed, checks: ['isolated-pnpm-install', 'local-dependency-graph', 'installed-byte-hashes', 'module-exports', 'wasm-resource-aliases-and-compilation', 'typescript-consumer'] };
    bundle.packagedBrowserQualification = qualifyPackagedBrowsers(root, output, consumer, bundle);
    assert.deepEqual(verifySource(root, sourceSha, label), bundle.sources);
    consumerManifest(bundle, output);
    assert.ok(bundle.packagedBrowserQualification.passed, 'Packaged-browser qualification failed');
  } catch (error) {
    if (!bundle.consumerSmoke.passed) bundle.consumerSmoke = { passed: false, status: 'failed', error: String(error) };
    bundle.packagedBrowserQualification = { ...bundle.packagedBrowserQualification, passed: false, status: 'failed', error: String(error) };
    throw error;
  } finally {
    save(path, bundle);
    save(join(output, 'diagnostics/consumer-smoke.json'), bundle.consumerSmoke);
    save(join(output, 'diagnostics/packaged-browser-qualification.json'), bundle.packagedBrowserQualification);
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'browser') {
    const [, root, consumer, browser, report] = process.argv.slice(2);
    await browserCommand(resolve(root), resolve(consumer), browser, resolve(report));
  } else {
    const [source, destination, sourceSha, label] = process.argv.slice(2);
    smoke(resolve(source), resolve(destination), sourceSha, label);
  }
}
