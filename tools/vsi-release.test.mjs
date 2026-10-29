import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { browsers, checkPlaywright, checkSdkIntegration, checkVitest, directories, filename, firefoxInlineSkip, hash, json, run, save, seal, stageManifest, validateInputs, verifyEvidence, verifySource, vsiNames } from './vsi-release.mjs';
import { consumerManifest, prepareHarness } from './vsi-consumer.mjs';
import { offsetCases, offsetNames } from './vsi-installed-offsets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputs = json(join(root, 'release/castlabs-vsi-inputs.json'));
const preIntegration = { ...inputs, sdkSha: inputs.interopFixture.sdkSha, releaseReady: false, sdkStatus: 'pre-integration', qualifiedSdkSha: null, qualificationEvidence: [], publicationBlocker: 'Await qualified integrated SDK' };
const sha = run('git', ['rev-parse', 'HEAD'], root);
function fixture(t) {
  const path = mkdtempSync(join(process.env.VSI_TEST_TEMP ?? process.env.RUNNER_TEMP ?? tmpdir(), 'vsi-helper-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function playwrightReport(count = vsiNames.length, names = vsiNames) {
  return { errors: [], suites: [{ specs: browsers.flatMap(projectName => Array.from({ length: count }, (_, i) => ({ title: names[i], ok: true, tests: [{ projectName, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', errors: [] }] }] }))) }] };
}
function vitestReport(count = 1) {
  return { success: true, numTotalTests: count, numPassedTests: count, numFailedTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ name: 'synthetic.spec.ts', assertionResults: Array.from({ length: count }, () => ({ status: 'passed' })) }] };
}
function readyInputs() {
  const sdkSha = '6021100cc5060b06061ca15b634281cfeb97c718';
  return { ...preIntegration, sdkSha, releaseReady: true, sdkStatus: 'qualified-functional', qualifiedSdkSha: sdkSha, qualificationEvidence: ['https://github.com/castlabs/c2pa-rs/actions/runs/123'], publicationBlocker: null,
    sdkIntegration: { ...inputs.sdkIntegration, mergeCommits: { 27: '2'.repeat(40), 28: '3'.repeat(40), 29: '4'.repeat(40) }, nativeQualification: { runId: '123', headSha: sdkSha, workflowPath: '.github/workflows/native-qualification.yml' } } };
}

test('pre-integration inputs are never publishable', () => {
  validateInputs(inputs);
  validateInputs(preIntegration);
  assert.throws(() => validateInputs(preIntegration, true), /Publication blocked/);
  const oldSdk = 'afd6fffe5a066e0b5b1a14f3f8c7ac189e7f0c95';
  const falseReady = { ...readyInputs(), sdkSha: oldSdk, qualifiedSdkSha: oldSdk };
  assert.throws(() => validateInputs(falseReady, true), /Candidate SDK pin must remain SDK602/);
  assert.throws(() => validateInputs({ ...inputs, bundleVersion: '1.0.7' }));
  assert.throws(() => validateInputs({ ...inputs, sdkSha: 'PR27' }));
  assert.throws(() => validateInputs({ ...inputs, tools: { wasmBindgen: '0.2.114', binaryen: '124' } }));
});

test('ready profile requires SDK602 qualification and the immutable SDK602 fixture producer', () => {
  const ready = readyInputs();
  validateInputs(ready, true);
  assert.equal(ready.sdkSha, ready.interopFixture.sdkSha);
  assert.throws(() => validateInputs({ ...ready, qualifiedSdkSha: '2'.repeat(40) }, true));
  assert.throws(() => validateInputs({ ...ready, qualificationEvidence: [] }, true));
  for (const field of Object.keys(ready.interopFixture)) assert.throws(() => validateInputs({ ...ready, interopFixture: { ...ready.interopFixture, [field]: 'tampered' } }, true));
  assert.throws(() => validateInputs({ ...ready, sdkIntegration: { ...ready.sdkIntegration, nativeQualification: null } }, true));
});

test('SDK proof requires all three reviewed merges on the functional history and successful exact-source native qualification', () => {
  const ready = readyInputs();
  const integration = ready.sdkIntegration;
  const targetSha = '5'.repeat(40);
  const pulls = integration.requiredPRs.map(number => ({ number, merged: true, merge_commit_sha: integration.mergeCommits[number], base: { ref: integration.targetRef, repo: { full_name: integration.repository } } }));
  const native = { id: 123, repository: { full_name: integration.repository }, path: integration.nativeQualification.workflowPath, head_sha: ready.sdkSha, head_branch: integration.targetRef, status: 'completed', conclusion: 'success' };
  const ancestors = [[ready.sdkSha, targetSha], ...Object.values(integration.mergeCommits).map(sha => [sha, ready.sdkSha])];
  const isAncestor = (a, b) => ancestors.some(([from, to]) => a === from && b === to);
  checkSdkIntegration(ready, pulls, native, targetSha, isAncestor);
  for (const mutate of [prs => { prs[2].merged = false; }, prs => { prs[0].merge_commit_sha = '6'.repeat(40); }, prs => { prs[0].base.ref = 'main'; }, prs => { prs[0].base.repo.full_name = 'someone/c2pa-rs'; }, prs => prs.pop()]) {
    const changed = structuredClone(pulls);
    mutate(changed);
    assert.throws(() => checkSdkIntegration(ready, changed, native, targetSha, isAncestor));
  }
  assert.throws(() => checkSdkIntegration(ready, pulls, native, targetSha, (a, b) => a !== integration.mergeCommits[29] && isAncestor(a, b)), /excludes merged PR 29/);
  assert.throws(() => checkSdkIntegration(ready, pulls, native, '6'.repeat(40), isAncestor), /functional target/);
  for (const changed of [{ ...native, head_sha: targetSha }, { ...native, conclusion: 'failure' }, { ...native, status: 'in_progress' }, { ...native, head_branch: 'main' }, { ...native, id: 124 }]) assert.throws(() => checkSdkIntegration(ready, pulls, changed, targetSha, isAncestor));
});

test('offset assertions use installed static Reader with Context fifth and fragment options sixth, never the deprecated factory', async t => {
  const rendition = name => ({ init: `${name}.init`, segments: Array.from({ length: 4 }, (_, i) => ({ file: `${name}-${i}`, offset: 100 + i })), sidxCutOfSegment1: { offset: 99 } });
  const layout = { 'solo-360p': rendition('solo'), 'ladder-360p': rendition('high'), 'ladder-180p': rendition('low') };
  let disposed = 0;
  const calls = [];
  const sdk = { dispose: () => disposed++, reader: { fromBlobFragment() { assert.fail('Deprecated factory must never be used'); } } };
  class Context {
    constructor(settings) { assert.deepEqual(settings, { verify: { verifyTrust: false } }); }
  }
  const Reader = { async fromBlobFragment(...args) {
    assert.equal(args.length, 6);
    const [runtime, format, init, media, context, options] = args;
    assert.equal(runtime, sdk);
    assert.equal(format, 'video/mp4');
    assert.ok(init instanceof Blob && media instanceof Blob);
    assert.ok(context === undefined || context instanceof Context);
    assert.ok(options === undefined || Object.keys(options).join() === 'fragmentBaseOffset');
    calls.push(args);
    const offset = options?.fragmentBaseOffset;
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new RangeError('Invalid offset');
    const initName = await init.text();
    const mediaName = await media.text();
    const source = Object.values(layout).find(r => r.init === initName);
    const bound = source?.segments.some(seg => seg.file === mediaName && seg.offset === offset);
    return { free() {}, async manifestStore() { return {
      validation_state: bound ? 'Valid' : 'Invalid',
      validation_results: { activeManifest: { success: bound ? [{ code: 'assertion.bmffHash.match' }] : [], failure: bound ? (context ? [] : [{ code: 'signingCredential.untrusted' }]) : [{ code: 'assertion.bmffHash.mismatch' }] } }
    }; } };
  } };
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, blob: async () => new Blob([decodeURIComponent(url.split('/').at(-1))]) }));
  const create = async options => { assert.deepEqual(options, { wasmSrc: 'synthetic.wasm' }); return sdk; };
  const results = await offsetCases(layout, create, Reader, Context, 'synthetic.wasm');
  assert.deepEqual(results, offsetNames.map(name => ({ name, passed: true })));
  assert.ok(calls.some(args => args[4] === undefined && args[5]?.fragmentBaseOffset === 103));
  assert.ok(calls.some(args => args[4] instanceof Context && args[5]?.fragmentBaseOffset === 101));
  assert.equal(disposed, 1);
});

test('source identity checks full SHA, SDK source/lock and actual independent versions', () => {
  const identity = verifySource(root, sha, '1.0.9');
  assert.equal(identity.sdkSha, inputs.sdkSha);
  assert.equal(Object.keys(identity.hashes).length, 8);
  assert.throws(() => verifySource(root, sha.slice(0, 7), '1.0.9'));
  assert.throws(() => verifySource(root, '0'.repeat(40), '1.0.9'));
  assert.throws(() => verifySource(root, sha, '1.0.8'));
});

test('four independent versions, absolute URLs, no lifecycle/dev exports or private Node', () => {
  for (const directory of directories) {
    const source = json(join(root, 'packages', directory, 'package.json'));
    const manifest = stageManifest(source, inputs);
    assert.equal(manifest.version, inputs.packages[directory]);
    assert.notEqual(manifest.version, '1.0.9');
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.publishConfig, undefined);
    assert.ok(!JSON.stringify(manifest.exports).includes('development'));
    for (const [name, url] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith('@stardustproof/')) assert.equal(url, `https://github.com/castlabs/c2pa-js/releases/download/v1.0.9/${filename(name.split('/')[1], inputs.packages[name.split('/')[1]])}`);
    }
    assert.throws(() => stageManifest({ ...source, version: '1.0.9' }, inputs));
    assert.deepEqual(json(join(root, 'packages', directory, 'package.json')), source);
  }
  assert.throws(() => stageManifest(json(join(root, 'packages/c2pa-node/package.json')), inputs));
  const web = json(join(root, 'packages/c2pa-web/package.json'));
  assert.throws(() => stageManifest({ ...web, dependencies: { '@stardustproof/c2pa-node': 'workspace:*' } }, inputs));
  assert.throws(() => stageManifest({ ...web, dependencies: { external: 'file:../somewhere' } }, inputs));
});

test('synthetic pnpm packs preserve staged manifests, exports and release URLs without lifecycle execution', t => {
  const output = fixture(t);
  for (const directory of directories) {
    const destination = join(output, directory);
    mkdirSync(destination);
    const manifest = stageManifest({ ...json(join(root, 'packages', directory, 'package.json')), scripts: { prepack: 'exit 99', prepare: 'exit 99' } }, inputs);
    save(join(destination, 'package.json'), manifest);
    const tree = directory === 'c2pa-wasm' ? 'pkg' : 'dist';
    mkdirSync(join(destination, tree));
    writeFileSync(join(destination, tree, 'index.d.ts'), 'export {};\n');
    run('pnpm', ['pack', '--pack-destination', output], destination);
    const archive = join(output, filename(directory, manifest.version));
    assert.deepEqual(JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json'], destination)), manifest);
  }
});

test('consumer overrides are local only and leave tarball bytes unchanged', t => {
  const output = fixture(t);
  const packages = directories.map(directory => {
    const file = filename(directory, inputs.packages[directory]);
    writeFileSync(join(output, file), directory);
    return { name: `@stardustproof/${directory}`, version: inputs.packages[directory], file, sha256: hash(directory) };
  });
  const manifest = consumerManifest({ packages }, output);
  assert.deepEqual(manifest.pnpm.overrides, manifest.dependencies);
  assert.ok(Object.values(manifest.dependencies).every(url => url.startsWith('file:')));
  writeFileSync(join(output, packages[0].file), 'tampered');
  assert.throws(() => consumerManifest({ packages }, output));
});

test('installed harness preserves real assertions, uses package exports and isolates fixtures', t => {
  const base = fixture(t);
  const source = join(base, 'source');
  const consumer = join(base, 'consumer');
  mkdirSync(join(source, 'tmp/vsi-fixtures'), { recursive: true });
  mkdirSync(consumer);
  save(join(source, 'tmp/vsi-fixtures/context.json'), {});
  cpSync(join(root, 'packages/c2pa-web/test/assets/single-file'), join(source, 'packages/c2pa-web/test/assets/single-file'), { recursive: true });
  cpSync(join(root, 'packages/c2pa-web/test/vsi'), join(source, 'packages/c2pa-web/test/vsi'), { recursive: true });
  const sourceTest = join(source, 'packages/c2pa-web/test/vsi/qualification.pw.ts');
  const assertions = readFileSync(sourceTest, 'utf8') + '\nconst addedResource = "/packages/c2pa-wasm/pkg/c2pa_bg.wasm";\n';
  writeFileSync(sourceTest, assertions);
  const result = prepareHarness(source, consumer, 'file:///tools/playwright/index.mjs');
  assert.ok(result.fixtureHashes['layout.ts']);
  const tests = readFileSync(join(consumer, 'qualification.pw.ts'), 'utf8');
  assert.ok(!tests.includes('/packages/'));
  assert.equal(tests.split('(window as any).wasmSrc').length - 1, assertions.split('/packages/c2pa-wasm/pkg/c2pa_bg.wasm').length - 1);
  assert.equal(tests.split('(window as any).workerSrc').length - 1, assertions.split('/packages/c2pa-web/dist/c2pa_worker.js').length - 1);
  assert.ok(tests.includes('refreshPreservedSequence'));
  assert.ok(tests.includes('real Reader await queues, drains and aborts'));
  assert.ok(tests.includes('/__vsi_gate/'));
  const harness = readFileSync(join(consumer, 'harness.js'), 'utf8');
  assert.ok(harness.includes('@stardustproof/c2pa-web'));
  assert.ok(!harness.includes('../packages/'));
  assert.ok(harness.includes('api.createC2pa, api.Reader, api.Context, wasmSrc'));
  assert.ok(readFileSync(join(consumer, 'offsets.pw.ts'), 'utf8').includes('ladder-missing-offset'));
});

test('browser evidence requires all projects, exact cases, zero retries/skips/failures', () => {
  assert.equal(vsiNames.length, 12);
  checkPlaywright(playwrightReport(), vsiNames.length, vsiNames);
  checkPlaywright(playwrightReport(9), 9);
  assert.throws(() => checkPlaywright(playwrightReport(8), vsiNames.length, vsiNames));
  for (const mutate of [r => r.errors.push({ message: 'error' }), r => r.suites[0].specs.pop(), r => r.suites[0].specs[0].tests[0].results.push({ status: 'passed', errors: [] }), r => { r.suites[0].specs[0].tests[0].results[0].status = 'skipped'; }, r => { r.suites[0].specs[0].tests[0].projectName = 'other'; }]) {
    const report = playwrightReport();
    mutate(report);
    assert.throws(() => checkPlaywright(report, vsiNames.length, vsiNames));
  }
  checkVitest(vitestReport());
  assert.throws(() => checkVitest(vitestReport(0)));
  assert.throws(() => checkVitest({ ...vitestReport(), numPendingTests: 1 }));
  assert.throws(() => checkVitest({ ...vitestReport(), numFailedTestSuites: 1 }));
  assert.throws(() => checkVitest({ ...vitestReport(), success: false }));
});

test('only the exact pre-existing Firefox inline testcase can be skipped; counters must remain consistent', () => {
  const report = vitestReport(2);
  report.numPendingTests = 1;
  report.numPassedTests = 1;
  report.testResults = [{ name: `/source/${firefoxInlineSkip.file}`, assertionResults: [{ fullName: firefoxInlineSkip.fullName, status: 'skipped', failureMessages: [] }, { fullName: 'another test', status: 'passed' }] }];
  checkVitest(report, undefined, 'firefox');
  for (const browser of ['chromium', 'webkit', undefined]) assert.throws(() => checkVitest(report, undefined, browser));
  for (const mutate of [r => { r.testResults[0].name = '/source/other.spec.ts'; }, r => { r.testResults[0].assertionResults[0].fullName = 'inline entrypoint another test'; }, r => { r.testResults[0].assertionResults[0].status = 'pending'; }, r => { r.testResults[0].assertionResults[1].status = 'skipped'; }, r => { r.numPassedTests++; }, r => { r.numPendingTests = 0; }]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.throws(() => checkVitest(changed, undefined, 'firefox'));
  }
});

test('sealing and publication guard bind every report, BMFF archive and tarball to the qualified bundle', t => {
  const output = fixture(t);
  const sourceTests = run('git', ['ls-files', 'packages/c2pa-web/src', 'packages/c2pa-web/test'], root).split('\n').filter(file => /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/.test(file));
  for (const browser of browsers) {
    const report = { ...vitestReport(sourceTests.length + 8), testResults: sourceTests.map(name => ({ name, assertionResults: Array.from({ length: name.includes('reader.singleFile') ? 9 : 1 }, () => ({ status: 'passed' })) })) };
    if (browser === 'firefox') {
      report.numPendingTests = 1;
      report.numPassedTests--;
      report.testResults.find(result => result.name === firefoxInlineSkip.file).assertionResults = [{ fullName: firefoxInlineSkip.fullName, status: 'skipped', failureMessages: [] }];
    }
    save(join(output, `source-${browser}.json`), report);
  }
  save(join(output, 'queue.json'), vitestReport(3));
  save(join(output, 'utilities.json'), vitestReport(105));
  for (const file of ['source-vsi.json', 'installed-vsi.json']) save(join(output, file), playwrightReport());
  save(join(output, 'installed-offsets.json'), playwrightReport(9, offsetNames));
  const packages = directories.map(directory => {
    const file = filename(directory, inputs.packages[directory]);
    writeFileSync(join(output, file), directory);
    return { name: `@stardustproof/${directory}`, version: inputs.packages[directory], file, sha256: hash(directory) };
  });
  const tools = { node: 'v24.0.0', pnpm: '10.15.0', rustc: 'rustc 1.96.0 (synthetic)', cargo: 'cargo 1.96.0 (synthetic)', wasmBindgen: 'wasm-bindgen 0.2.129', binaryen: 'wasm-opt version 124', cargoWasmSha256: 'a'.repeat(64), archiveSha256: { bindgen: 'b'.repeat(64), binaryen: 'c'.repeat(64) } };
  save(join(output, 'tool-versions.json'), tools);
  save(join(output, 'consumer.json'), { passed: true, scope: 'isolated-installed-four-tarballs-v1', packages, assertionHash: hash(readFileSync(join(root, 'packages/c2pa-web/test/vsi/qualification.pw.ts'))) });
  save(join(output, 'consumer-graph.json'), []);
  writeFileSync(join(output, 'consumer-pnpm-lock.yaml'), '# synthetic lock\n');
  const bundle = { schemaVersion: 1, bundleVersion: '1.0.9', identity: verifySource(root, sha, '1.0.9'), inputs, packages, tools,
    wasm: { sha256: hash('synthetic wasm') }, workflow: { sha, runId: '123', attempt: '1' }, qualification: { passed: false } };
  save(join(output, 'provenance.json'), bundle);
  const bmff = join(output, 'bmff');
  const fixtures = join(bmff, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  const lock = json(join(root, 'release/bmff-exclusion-inputs.json'));
  const producer = { pythonVersion: lock.python.version, pythonSourceSha: lock.python.sourceSha, sdkSha: bundle.identity.sdkSha,
    nativeLibrarySha256: lock.python.nativeSha256, generatorSha256: hash(readFileSync(join(root, 'tools/bmff-exclusion-fixtures.py'))) };
  const cases = Array.from({ length: 96 }, (_, i) => ({ name: `synthetic-bmff-${i}`, mode: 'normal', expect: { state: 'Valid' } }));
  save(join(fixtures, 'native-verdicts.json'), { schemaVersion: 1, generationComplete: true, qualified: true, generationFailure: null, errors: [], producer,
    cases: cases.map(entry => ({ name: entry.name, mode: entry.mode, state: entry.expect.state, qualified: true, differences: [] })) });
  save(join(fixtures, 'manifest.json'), { schemaVersion: 1, producer, cases, files: { 'native-verdicts.json': hash(readFileSync(join(fixtures, 'native-verdicts.json'))) } });
  save(join(bmff, 'published-provenance.json'), bundle);
  cpSync(join(root, 'release/bmff-exclusion-inputs.json'), join(bmff, 'inputs.json'));
  save(join(bmff, 'consumer-graph.json'), []);
  writeFileSync(join(bmff, 'consumer-pnpm-lock.yaml'), '# synthetic BMFF lock\n');
  save(join(bmff, 'browser.json'), { ...playwrightReport(96, cases.map(entry => entry.name)), stats: { expected: 288, unexpected: 0, flaky: 0, skipped: 0 } });
  const reportFiles = ['browser.json', 'consumer-graph.json', 'consumer-pnpm-lock.yaml', 'inputs.json', 'published-provenance.json'];
  const sourceFiles = ['tools/bmff-exclusion-consumer.mjs', 'tools/bmff-exclusion-fixtures.py', 'tools/bmff-exclusion-inputs.mjs', 'tools/vsi-consumer.mjs', 'tools/vsi-release.mjs', 'tools/vsi-installed-offsets.mjs', '.github/workflows/castlabs-vsi-bundle.yml'];
  save(join(bmff, 'qualification.json'), {
    schemaVersion: 1, passed: true, profile: 'bmff-exclusion-candidate-consumer-v1', bundleVersion: bundle.bundleVersion,
    browserSourceSha: bundle.identity.sourceSha, sdkSha: bundle.identity.sdkSha, wasmSha256: bundle.wasm.sha256, packages,
    browsers, workers: 1, retries: 0, expectedTests: 288, actualTests: 288, producerInputs: lock.python, producer, cases,
    lockSha256: hash(readFileSync(join(bmff, 'inputs.json'))), provenanceSha256: hash(readFileSync(join(bmff, 'published-provenance.json'))),
    manifestSha256: hash(readFileSync(join(fixtures, 'manifest.json'))),
    reportHashes: Object.fromEntries(reportFiles.map(file => [file, hash(readFileSync(join(bmff, file)))])),
    fixtureHashes: Object.fromEntries(['manifest.json', 'native-verdicts.json'].map(file => [file, hash(readFileSync(join(fixtures, file)))])),
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(join(root, file)))]))
  });
  const evidence = verifyEvidence(root, output);
  assert.equal(evidence['utilities.json'], hash(readFileSync(join(output, 'utilities.json'))));
  assert.equal(evidence['bmff/qualification.json'], hash(readFileSync(join(bmff, 'qualification.json'))));
  for (const [file, mutate] of [
    ['utilities.json', report => { Object.assign(report, vitestReport(104)); }],
    ['bmff/qualification.json', report => { report.expectedTests = 287; }],
    ['bmff/qualification.json', report => { report.actualTests = 287; }],
    ['bmff/qualification.json', report => { report.browserSourceSha = '0'.repeat(40); }],
    ['bmff/qualification.json', report => { report.packages[0].sha256 = '0'.repeat(64); }],
    ['bmff/qualification.json', report => { delete report.sourceHashes['.github/workflows/castlabs-vsi-bundle.yml']; }],
    ['bmff/fixtures/native-verdicts.json', report => { report.qualified = false; }],
    ['bmff/fixtures/native-verdicts.json', report => { report.cases[0].qualified = false; }],
    ['bmff/browser.json', report => { report.suites[0].specs = report.suites[0].specs.filter(spec => spec.tests[0].projectName !== 'webkit'); }],
    ['bmff/published-provenance.json', report => { report.identity.sourceSha = '0'.repeat(40); }],
    ['bmff/consumer-graph.json', report => { report.push('tampered'); }]
  ]) {
    const path = join(output, file);
    const original = readFileSync(path);
    const changed = JSON.parse(original);
    mutate(changed);
    save(path, changed);
    try {
      assert.throws(() => verifyEvidence(root, output), undefined, `Rejected evidence: ${file}`);
    } finally {
      writeFileSync(path, original);
    }
  }
  seal(root, output, sha, '1.0.9');
  const sealed = json(join(output, 'provenance.json'));
  assert.deepEqual(sealed.qualification, { passed: true, profile: 'vsi-browser-bundle-v1', evidence: { ...evidence, 'bmff-evidence.tar.gz': hash(readFileSync(join(output, 'bmff-evidence.tar.gz'))) } });
  assert.deepEqual(run('tar', ['-tzf', join(output, 'bmff-evidence.tar.gz')], root).split('\n').sort(), Object.keys(evidence).filter(file => file.startsWith('bmff/')).sort());
  assert.ok(readFileSync(join(output, 'SHA256SUMS'), 'utf8').includes('provenance.json'));
  const workflowEnv = { GITHUB_WORKFLOW_SHA: bundle.workflow.sha, GITHUB_RUN_ID: bundle.workflow.runId, GITHUB_RUN_ATTEMPT: bundle.workflow.attempt };
  const previousEnv = Object.fromEntries(Object.keys(workflowEnv).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, workflowEnv);
  const sealedBytes = readFileSync(join(output, 'provenance.json'));
  const checksums = readFileSync(join(output, 'SHA256SUMS'));
  seal(root, output, sha, '1.0.9', true);
  assert.deepEqual(readFileSync(join(output, 'provenance.json')), sealedBytes);
  assert.deepEqual(readFileSync(join(output, 'SHA256SUMS')), checksums);
  process.env.GITHUB_RUN_ATTEMPT = '2';
  assert.throws(() => seal(root, output, sha, '1.0.9', true), /Evidence belongs to another workflow run/);
  process.env.GITHUB_RUN_ATTEMPT = bundle.workflow.attempt;
  writeFileSync(join(output, packages[0].file), 'tampered');
  assert.throws(() => seal(root, output, sha, '1.0.9'));
  writeFileSync(join(output, packages[0].file), directories[0]);
  save(join(output, 'installed-vsi.json'), playwrightReport(7));
  assert.throws(() => seal(root, output, sha, '1.0.9'));
});
