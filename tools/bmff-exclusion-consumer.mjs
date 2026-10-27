import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installConsumer } from './vsi-consumer.mjs';
import { browsers, checkPlaywright, directories, filename, hash, json, save, verifySource } from './vsi-release.mjs';

async function qualify(root, downloads, fixtures, consumer, reports, candidate = false) {
  const lockFile = join(root, 'release/bmff-exclusion-inputs.json');
  const lockBytes = readFileSync(lockFile);
  const lock = JSON.parse(lockBytes);
  const provenanceBytes = readFileSync(join(downloads, 'provenance.json'));
  const bundle = JSON.parse(provenanceBytes);
  const manifestBytes = readFileSync(join(fixtures, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const digest = value => assert.match(value, /^[a-f0-9]{64}$/);
  const safeFile = value => {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0 && value.length <= 1024, 'Fixture path length is out of bounds');
    const components = value.split('/');
    assert.ok(components.length <= 16, 'Fixture path depth is out of bounds');
    for (const component of components) assert.match(component, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    return value;
  };

  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.sdkSha, '6021100cc5060b06061ca15b634281cfeb97c718');
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.identity.sdkSha, lock.sdkSha);
  assert.equal(bundle.inputs.sdkSha, lock.sdkSha);
  assert.equal(bundle.inputs.qualifiedSdkSha, lock.sdkSha);
  assert.equal(bundle.inputs.sdkIntegration.nativeQualification.headSha, lock.sdkSha);
  if (candidate) {
    assert.ok(!existsSync(consumer), 'Candidate consumer root must be separate and absent');
    assert.equal(bundle.bundleVersion, '1.0.9');
    assert.equal(bundle.qualification.passed, false, 'Candidate provenance must be unsealed');
    assert.deepEqual(bundle.identity, verifySource(root, bundle.identity.sourceSha, bundle.bundleVersion));
    assert.deepEqual(bundle.inputs, json(join(root, 'release/castlabs-vsi-inputs.json')));
    assert.equal(bundle.inputs.bundleVersion, bundle.bundleVersion);
    digest(bundle.wasm.sha256);
    assert.equal(hash(readFileSync(join(root, 'packages/c2pa-wasm/pkg/c2pa_bg.wasm'))), bundle.wasm.sha256);
    assert.equal(hash(readFileSync(join(root, 'packages/c2pa-web/dist/resources/c2pa_bg.wasm'))), bundle.wasm.sha256);
    digest(lock.python.evidence.sha256);
    digest(lock.python.wheel.sha256);
  } else {
    assert.match(lock.browser.sourceSha, /^[a-f0-9]{40}$/);
    digest(lock.browser.provenanceSha256);
    digest(lock.browser.wasmSha256);
    assert.equal(hash(provenanceBytes), lock.browser.provenanceSha256);
    assert.equal(bundle.bundleVersion, '1.0.8');
    // Published provenance uses identity/inputs, not top-level source/native IDs.
    assert.equal(bundle.identity.sourceSha, lock.browser.sourceSha);
    assert.equal(bundle.qualification.passed, true);
    assert.equal(bundle.wasm.sha256, lock.browser.wasmSha256);
  }
  assert.equal(bundle.wasm.sri, `sha256-${Buffer.from(bundle.wasm.sha256, 'hex').toString('base64')}`);
  const packageInputs = candidate ? bundle.packages : lock.browser.packages;
  assert.deepEqual(packageInputs.map(pkg => pkg.name), directories.map(name => `@stardustproof/${name}`));
  const packages = packageInputs.map(({ name, version, file, sha256, url }) => {
    safeFile(file);
    digest(sha256);
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(file, filename(name.split('/')[1], version));
    if (candidate) assert.equal(version, bundle.inputs.packages[name.split('/')[1]]);
    else assert.equal(url, `https://github.com/castlabs/c2pa-js/releases/download/v1.0.8/${file}`);
    assert.equal(hash(readFileSync(join(downloads, file))), sha256, `Tarball hash: ${file}`);
    return { name, version, file, sha256 };
  });
  assert.deepEqual(bundle.packages, packages);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.producer.sdkSha, lock.sdkSha);
  assert.equal(typeof lock.python.version, 'string');
  assert.ok(lock.python.version.length > 0);
  assert.match(lock.python.sourceSha, /^[a-f0-9]{40}$/);
  digest(lock.python.nativeSha256);
  assert.equal(manifest.producer.pythonVersion, lock.python.version);
  assert.equal(manifest.producer.pythonSourceSha, lock.python.sourceSha);
  assert.equal(manifest.producer.nativeLibrarySha256, lock.python.nativeSha256);
  assert.equal(typeof lock.python.sdkVersion, 'string');
  assert.equal(manifest.producer.sdkVersion, lock.python.sdkVersion);
  assert.ok(manifest.files && !Array.isArray(manifest.files));
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0);
  if (candidate) assert.equal(manifest.cases.length, 96, 'Candidate requires exactly 96 fixture cases');
  const names = new Set();
  for (const entry of manifest.cases) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.trim() && !names.has(entry.name), 'Case names must be nonempty and unique');
    names.add(entry.name);
    assert.ok(['whole', 'fragment'].includes(entry.mode));
    const files = entry.mode === 'whole' ? [entry.file] : [entry.init, entry.fragment];
    for (const file of files) assert.ok(Object.hasOwn(manifest.files, safeFile(file)), `Unlisted fixture: ${file}`);
    if (entry.fragmentBaseOffset !== undefined) {
      assert.equal(entry.mode, 'fragment');
      assert.ok(Number.isSafeInteger(entry.fragmentBaseOffset) && entry.fragmentBaseOffset >= 0);
    }
    assert.ok(['Valid', 'Invalid'].includes(entry.expect.state));
    for (const kind of ['success', 'failure', 'absentFailure']) {
      assert.ok(Array.isArray(entry.expect[kind]));
      assert.ok(entry.expect[kind].every(code => typeof code === 'string' && code.length > 0));
      assert.equal(new Set(entry.expect[kind]).size, entry.expect[kind].length);
    }
    assert.ok(entry.expect.failure.every(code => !entry.expect.absentFailure.includes(code)));
    if (entry.expect.state === 'Invalid') assert.ok(entry.expect.failure.length > 0, 'Invalid cases require explicit failure codes');
    else assert.equal(entry.expect.failure.length, 0);
  }
  for (const [file, metadata] of Object.entries(manifest.files)) {
    safeFile(file);
    digest(metadata.sha256);
    assert.ok(Number.isSafeInteger(metadata.bytes) && metadata.bytes > 0);
    const bytes = readFileSync(join(fixtures, file));
    assert.equal(bytes.length, metadata.bytes, `Fixture size: ${file}`);
    assert.equal(hash(bytes), metadata.sha256, `Fixture hash: ${file}`);
  }
  const nativeVerdictsFile = safeFile(manifest.provenance.nativeVerdicts);
  if (candidate) assert.equal(nativeVerdictsFile, 'native-verdicts.json');
  assert.ok(Object.hasOwn(manifest.files, nativeVerdictsFile), 'Native verdicts must be hash-listed');
  const nativeVerdicts = json(join(fixtures, nativeVerdictsFile));
  assert.equal(nativeVerdicts.schemaVersion, 1);
  assert.equal(nativeVerdicts.generationComplete, true);
  assert.equal(nativeVerdicts.qualified, true);
  assert.equal(nativeVerdicts.generationFailure, null);
  assert.deepEqual(nativeVerdicts.producer, manifest.producer);
  assert.deepEqual(nativeVerdicts.errors, []);
  assert.ok(Array.isArray(nativeVerdicts.cases));
  if (candidate) assert.equal(nativeVerdicts.cases.length, 96, 'Candidate requires exactly 96 native cases');
  assert.deepEqual(nativeVerdicts.cases.map(entry => entry.name).sort(), [...names].sort(), 'Native/browser case names differ');
  for (const verdict of nativeVerdicts.cases) {
    const entry = manifest.cases.find(entry => entry.name === verdict.name);
    assert.equal(verdict.qualified, true, `Native case not qualified: ${verdict.name}`);
    assert.equal(verdict.exception, undefined);
    assert.deepEqual(verdict.differences ?? [], []);
    assert.equal(verdict.mode, entry.mode);
    assert.equal(verdict.state, entry.expect.state);
  }

  // Preserve native results and mutation metadata verbatim, including files not served to the browser.
  const fixtureHashes = {};
  function recordFixtures(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) recordFixtures(join(directory, entry.name), `${relative}/`);
      else {
        assert.ok(entry.isFile(), `Nonregular fixture artifact: ${relative}`);
        fixtureHashes[relative] = hash(readFileSync(join(directory, entry.name)));
      }
    }
  }
  recordFixtures(fixtures);
  assert.equal(fixtureHashes['manifest.json'], hash(manifestBytes));
  mkdirSync(reports, { recursive: true });
  for (const file of ['qualification.json', 'browser.json', 'fixtures', 'consumer-graph.json', 'consumer-pnpm-lock.yaml']) {
    assert.ok(!existsSync(join(reports, file)), `Refusing stale report: ${file}`);
  }
  const sourceFiles = ['bmff-exclusion-consumer.mjs', 'bmff-exclusion-fixtures.py', 'bmff-exclusion-inputs.mjs', 'vsi-consumer.mjs', 'vsi-release.mjs', 'vsi-installed-offsets.mjs']
    .map(file => `tools/${file}`);
  if (process.env.GITHUB_WORKFLOW_REF) {
    const workflow = process.env.GITHUB_WORKFLOW_REF.match(/^[^/]+\/[^/]+\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@.+$/)?.[1];
    assert.ok(workflow, 'Cannot identify invoking workflow source');
    sourceFiles.push(workflow);
  }
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(join(root, file)))]));
  assert.equal(manifest.producer.generatorSha256, sourceHashes['tools/bmff-exclusion-fixtures.py']);
  cpSync(fixtures, join(reports, 'fixtures'), { recursive: true });
  writeFileSync(join(reports, 'inputs.json'), lockBytes);
  // In candidate mode this compatibility filename holds the unsealed, pre-seal snapshot.
  writeFileSync(join(reports, 'published-provenance.json'), provenanceBytes);
  const { roots, graph } = installConsumer({ packages }, downloads, consumer);
  save(join(reports, 'consumer-graph.json'), graph);
  cpSync(join(consumer, 'pnpm-lock.yaml'), join(reports, 'consumer-pnpm-lock.yaml'));
  const installedRequire = createRequire(join(consumer, 'package.json'));
  const wasmHash = hash(readFileSync(installedRequire.resolve('@stardustproof/c2pa-wasm/c2pa.wasm')));
  assert.equal(wasmHash, bundle.wasm.sha256);
  assert.equal(hash(readFileSync(installedRequire.resolve('@stardustproof/c2pa-web/resources/c2pa.wasm'))), wasmHash);

  mkdirSync(join(consumer, 'public/fixtures'), { recursive: true });
  for (const file of Object.keys(manifest.files)) {
    const target = join(consumer, 'public/fixtures', file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(fixtures, file), target);
  }
  writeFileSync(join(consumer, 'fixture-manifest.json'), manifestBytes);
  const workspaceRequire = createRequire(join(root, 'package.json'));
  const webRequire = createRequire(join(root, 'packages/c2pa-web/package.json'));
  const playwrightManifest = webRequire.resolve('@playwright/test/package.json');
  const playwrightImport = json(playwrightManifest).exports['.'].import;
  assert.equal(typeof playwrightImport, 'string');
  const playwrightEntry = pathToFileURL(resolve(dirname(playwrightManifest), playwrightImport)).href;
  writeFileSync(join(consumer, 'index.html'), '<!doctype html><html><head><title>Installed BMFF exclusion consumer</title></head><body><script type="module" src="/harness.js"></script></body></html>');
  writeFileSync(join(consumer, 'harness.js'), `
import { createC2pa, Reader, Context } from ${JSON.stringify('@stardustproof/c2pa-web')};
import wasmSrc from ${JSON.stringify('@stardustproof/c2pa-wasm/c2pa.wasm?url')};
import workerSrc from ${JSON.stringify('@stardustproof/c2pa-web/c2pa_worker?url')};
const files = ${JSON.stringify(manifest.files)};
const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
window.verifyCase = async entry => {
  const checked = {};
  async function fixture(file) {
    const response = await fetch('/fixtures/' + file.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' });
    if (!response.ok) throw new Error('Fixture fetch failed: ' + file + ': ' + response.status);
    const bytes = await response.arrayBuffer();
    const sha = await sha256(bytes);
    if (bytes.byteLength !== files[file].bytes || sha !== files[file].sha256) throw new Error('Browser fixture hash/size mismatch: ' + file);
    checked[file] = { sha256: sha, bytes: bytes.byteLength };
    return new Blob([bytes], { type: 'video/mp4' });
  }
  // All bytes are checked before Reader sees either blob, including negative cases.
  const blobs = entry.mode === 'whole' ? [await fixture(entry.file)] : [await fixture(entry.init), await fixture(entry.fragment)];
  const wasmResponse = await fetch(wasmSrc, { cache: 'no-store' });
  if (!wasmResponse.ok) throw new Error('WASM fetch failed: ' + wasmResponse.status);
  const wasmBytes = await wasmResponse.arrayBuffer();
  if (await sha256(wasmBytes) !== ${JSON.stringify(wasmHash)}) throw new Error('Browser WASM hash mismatch');
  const runtime = await createC2pa({ wasmSrc: await WebAssembly.compile(wasmBytes), workerSrc: new URL(workerSrc, location.href) });
  let reader;
  try {
    const context = new Context({ verify: { verifyTrust: false } });
    reader = entry.mode === 'whole'
      ? await Reader.fromBlob(runtime, 'video/mp4', blobs[0], context)
      : await Reader.fromBlobFragment(runtime, 'video/mp4', blobs[0], blobs[1], context,
          entry.fragmentBaseOffset === undefined ? undefined : { fragmentBaseOffset: entry.fragmentBaseOffset });
    if (!reader) throw new Error('Reader returned null, not a validation verdict');
    const store = await reader.manifestStore();
    const active = store.validation_results?.activeManifest;
    if (!active) throw new Error('Missing active manifest validation results');
    const codes = kind => (active[kind] ?? []).map(status => {
      if (typeof status.code !== 'string') throw new Error('Malformed validation status');
      return status.code;
    });
    return { state: store.validation_state, success: codes('success'), failure: codes('failure'),
      validationResults: store.validation_results, checked, wasmSha256: ${JSON.stringify(wasmHash)} };
  } finally {
    try { if (reader) await reader.free(); } finally { runtime.dispose(); }
  }
};
window.ready = true;
`);
  writeFileSync(join(consumer, 'qualification.pw.mjs'), `
import { readFileSync } from 'node:fs';
import { test, expect } from ${JSON.stringify(playwrightEntry)};
const manifest = JSON.parse(readFileSync(new URL('./fixture-manifest.json', import.meta.url), 'utf8'));
for (const entry of manifest.cases) {
  test(entry.name, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.waitForFunction(() => window.ready);
    // Exceptions and null readers fail the test, never stand in for Invalid.
    const result = await page.evaluate(entry => window.verifyCase(entry), entry);
    await testInfo.attach('verdict', { body: JSON.stringify({ case: entry, actual: result }, null, 2), contentType: 'application/json' });
    expect(result.state).not.toBe('Trusted');
    expect(result.state).toBe(entry.expect.state);
    for (const code of entry.expect.success) expect(result.success).toContain(code);
    // Assertion tampering can additionally invalidate the BMFF binding on native 602.
    const optionalBmffMismatch = entry.expect.failure.includes('assertion.hashedURI.mismatch')
      && !entry.expect.failure.includes('assertion.bmffHash.mismatch');
    expect([...new Set(result.failure)].filter(code => !optionalBmffMismatch || code !== 'assertion.bmffHash.mismatch').sort())
      .toEqual([...entry.expect.failure].sort());
    for (const code of entry.expect.absentFailure) expect(result.failure).not.toContain(code);
    if (entry.expect.state === 'Valid') {
      // A pass must not hide any active or ingredient hard-binding failure.
      expect(result.failure).toEqual([]);
      const failures = [];
      function visit(value) {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'failure' && Array.isArray(child)) failures.push(...child.map(status => status.code));
          else visit(child);
        }
      }
      visit(result.validationResults);
      expect(failures.filter(code => /^(assertion\\.(bmffHash|dataHash|boxesHash|collectionHash)|claim\\.hardBindings)\\./.test(code))).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}
`);
  writeFileSync(join(consumer, 'playwright.config.mjs'), `
import { defineConfig } from ${JSON.stringify(playwrightEntry)};
export default defineConfig({ testDir: '.', testMatch: '**/qualification.pw.mjs', timeout: 120000,
  forbidOnly: true, retries: 0, workers: 1, maxFailures: 0,
  outputDir: ${JSON.stringify(join(reports, 'test-results'))},
  use: { baseURL: process.env.BMFF_CONSUMER_URL, ignoreHTTPSErrors: true },
  projects: ${JSON.stringify(browsers)}.map(name => ({ name, use: { browserName: name } })),
  reporter: [['list'], ['json', { outputFile: ${JSON.stringify(join(reports, 'browser.json'))} }]] });
`);
  const harnessFiles = ['index.html', 'harness.js', 'fixture-manifest.json', 'qualification.pw.mjs', 'playwright.config.mjs'];
  const harnessHashes = Object.fromEntries(harnessFiles.map(file => [file, hash(readFileSync(join(consumer, file)))]));
  const viteModule = await import(pathToFileURL(workspaceRequire.resolve('vite')).href);
  const { createServer } = viteModule.default ?? viteModule;
  const server = await createServer({
    root: consumer, configFile: false, envFile: false, cacheDir: join(consumer, '.vite'),
    server: { host: '127.0.0.1', port: 0, fs: { strict: true, allow: [consumer] },
      https: { key: readFileSync(join(root, 'tmp/bmff-server.key')), cert: readFileSync(join(root, 'tmp/bmff-server.crt')) } },
    optimizeDeps: { exclude: directories.map(name => `@stardustproof/${name}`) }
  });
  let exitCode;
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address === 'object');
    exitCode = await new Promise((resolveChild, reject) => {
      const child = spawn(process.execPath, [webRequire.resolve('@playwright/test/cli'), 'test', '--config', join(consumer, 'playwright.config.mjs')], {
        cwd: consumer, stdio: 'inherit',
        env: { ...process.env, BMFF_CONSUMER_URL: `https://127.0.0.1:${address.port}`,
          PLAYWRIGHT_JSON_OUTPUT_NAME: join(reports, 'browser.json') }
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolveChild(signal ?? code));
    });
  } finally { await server.close(); }

  // Validate the report as well as the exit status: zero skips, retries, or missing cases.
  const browserReport = json(join(reports, 'browser.json'));
  checkPlaywright(browserReport, manifest.cases.length, [...names]);
  assert.equal(exitCode, 0, 'Installed browser qualification failed');
  assert.equal(browserReport.stats.expected, manifest.cases.length * browsers.length);
  for (const field of ['unexpected', 'flaky', 'skipped']) assert.equal(browserReport.stats[field], 0);
  assert.deepEqual(readFileSync(lockFile), lockBytes);
  assert.deepEqual(readFileSync(join(downloads, 'provenance.json')), provenanceBytes);
  if (candidate) assert.deepEqual(verifySource(root, bundle.identity.sourceSha, bundle.bundleVersion), bundle.identity);
  for (const pkg of packages) assert.equal(hash(readFileSync(join(downloads, pkg.file))), pkg.sha256);
  for (const [file, sha] of Object.entries(sourceHashes)) assert.equal(hash(readFileSync(join(root, file))), sha);
  for (const [file, sha] of Object.entries(harnessHashes)) assert.equal(hash(readFileSync(join(consumer, file))), sha);
  for (const [file, sha] of Object.entries(fixtureHashes)) {
    assert.equal(hash(readFileSync(join(fixtures, file))), sha);
    assert.equal(hash(readFileSync(join(reports, 'fixtures', file))), sha);
  }
  const reportHashes = Object.fromEntries(['browser.json', 'consumer-graph.json', 'consumer-pnpm-lock.yaml', 'inputs.json', 'published-provenance.json']
    .map(file => [file, hash(readFileSync(join(reports, file)))]));
  save(join(reports, 'qualification.json'), {
    schemaVersion: 1, passed: true, profile: candidate ? 'bmff-exclusion-candidate-consumer-v1' : 'bmff-exclusion-installed-consumer-v1',
    ...(candidate ? { bundleVersion: bundle.bundleVersion, producerInputs: lock.python } : {}),
    sdkSha: lock.sdkSha, browserSourceSha: bundle.identity.sourceSha, wasmSha256: wasmHash,
    packages: packageInputs, producer: manifest.producer,
    cases: manifest.cases, browsers, expectedTests: manifest.cases.length * browsers.length,
    actualTests: browserReport.stats.expected, workers: 1, retries: 0,
    packageRoots: roots, fixtureHashes, sourceHashes, harnessHashes, reportHashes,
    lockSha256: hash(lockBytes), provenanceSha256: hash(provenanceBytes), manifestSha256: hash(manifestBytes),
    limitations: [
      'Binding qualification only: signer credential trust is disabled; Valid is not publisher trust.',
      'Fixture expectations and mutation/native metadata are unsigned; hashes bind the recorded inputs, not their authority.',
      candidate
        ? 'Candidate provenance is an unsealed pre-seal snapshot, not an attestation or reproducible-build guarantee; the historical lock supplies producer pins only.'
        : 'Published provenance is byte-pinned, not an attestation or reproducible-build guarantee.'
    ]
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const candidate = args.at(-1) === '--candidate';
  if (candidate) args.pop();
  assert.ok(args.length === 5 && args.every(path => !path.startsWith('--')), 'Usage: node tools/bmff-exclusion-consumer.mjs <repo-root> <download-dir> <fixtures-dir> <consumer-dir> <reports-dir> [--candidate]');
  await qualify(...args.map(path => resolve(path)), candidate);
}
