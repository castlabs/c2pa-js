import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offsetNames } from './vsi-installed-offsets.mjs';

export const directories = ['c2pa-types', 'c2pa-wasm', 'c2pa-utilities', 'c2pa-web'];
export const browsers = ['chromium', 'firefox', 'webkit'];
export const vsiNames = ['normal', 'inline', 'external'].flatMap(mode => ['ed25519', 'es256'].map(algorithm => `${mode} ${algorithm}: trusted admission, continuity, refresh and lifecycle`))
  .concat(['byte-only WASM core ed25519', 'byte-only WASM core es256'])
  .concat(['normal', 'external'].flatMap(mode => ['ed25519', 'es256'].map(algorithm => `${mode} ${algorithm}: real Reader await queues, drains and aborts`)));
export const firefoxInlineSkip = { file: 'packages/c2pa-web/src/inline.spec.ts', fullName: 'inline entrypoint should work' };
export const hash = data => createHash('sha256').update(data).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const save = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
export const filename = (directory, version) => `stardustproof-${directory}-${version}.tgz`;
export function run(command, args, cwd, inherit = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} failed: ${result.error ?? result.stderr ?? result.signal}`);
  return result.stdout?.trim();
}

export function validateInputs(inputs, publish = false) {
  assert.equal(inputs.schemaVersion, 1);
  assert.equal(inputs.bundleVersion, '1.0.9');
  assert.match(inputs.sdkSha, /^[a-f0-9]{40}$/);
  assert.equal(typeof inputs.releaseReady, 'boolean');
  assert.deepEqual(Object.keys(inputs.packages), directories);
  assert.deepEqual(inputs.packages, { 'c2pa-types': '0.7.5', 'c2pa-wasm': '0.13.2', 'c2pa-utilities': '0.3.2', 'c2pa-web': '0.15.4' });
  assert.deepEqual(inputs.tools, { wasmBindgen: '0.2.129', binaryen: '124' });
  assert.equal(inputs.sdkIntegration.repository, 'castlabs/c2pa-rs');
  assert.equal(inputs.sdkIntegration.targetRef, 'feat/trusted-vsi-functional');
  assert.deepEqual(inputs.sdkIntegration.requiredPRs, [27, 28, 29]);
  assert.deepEqual(Object.keys(inputs.sdkIntegration.mergeCommits).sort(), ['27', '28', '29']);
  // Producer identity is the published immutable wheel, never a local native build.
  assert.deepEqual(inputs.interopFixture, {
    pythonSha: '98ccd6de63d89eca9c23f27658f6b29fe99daffc',
    sdkSha: '6021100cc5060b06061ca15b634281cfeb97c718',
    wheelVersion: '0.37.13+signer.1.0.9',
    wheelSha256: '62eb9eeb3778a1d2e46e66a5c579a6d2886fe378c71f505f957363f4516d229f',
    lockSha256: 'ebc3ba31b9ef056b51e3c52e5c200d65157239a3cda3bd577f6ba81e155d2370',
    evidenceSha256: 'd18a91bda040c6897e6ca8f8e3f55ebcfbd7957de59cdf935e069b5b8bc819c5',
    nativeSha256: 'd356a7afe705381d3a4f7d2f7fbdb70aab2325ad7617cefd29d035a301ff7c99'
  });
  if (inputs.releaseReady || publish) {
    assert.equal(inputs.releaseReady, true, 'Publication blocked: release inputs are pre-integration');
    assert.equal(inputs.sdkStatus, 'qualified-functional');
    assert.equal(inputs.sdkSha, '6021100cc5060b06061ca15b634281cfeb97c718', 'Candidate SDK pin must remain SDK602; advanced native work needs separate approval');
    assert.equal(inputs.qualifiedSdkSha, inputs.sdkSha);
    for (const sha of Object.values(inputs.sdkIntegration.mergeCommits)) assert.match(sha, /^[a-f0-9]{40}$/);
    const native = inputs.sdkIntegration.nativeQualification;
    assert.match(native.runId, /^[1-9][0-9]*$/);
    assert.equal(native.headSha, inputs.sdkSha);
    assert.match(native.workflowPath, /^\.github\/workflows\/[^/]+\.ya?ml$/);
    assert.ok(inputs.qualificationEvidence.includes(`https://github.com/castlabs/c2pa-rs/actions/runs/${native.runId}`), 'Exact native qualification run required');
    for (const url of inputs.qualificationEvidence) assert.match(url, /^https:\/\/github\.com\/castlabs\//);
    assert.equal(inputs.publicationBlocker, null);
  } else {
    assert.equal(inputs.sdkStatus, 'pre-integration');
    assert.equal(inputs.qualifiedSdkSha, null);
    assert.ok(inputs.publicationBlocker);
  }
  return inputs;
}

export function checkSdkIntegration(inputs, pulls, nativeRun, targetSha, isAncestor) {
  validateInputs(inputs, true);
  const integration = inputs.sdkIntegration;
  assert.match(targetSha, /^[a-f0-9]{40}$/);
  assert.equal(isAncestor(inputs.sdkSha, targetSha), true, 'SDK pin is not on the functional target history');
  assert.deepEqual(pulls.map(pr => pr.number), integration.requiredPRs);
  for (const pr of pulls) {
    assert.equal(pr.merged, true, `SDK PR ${pr.number} is not merged`);
    assert.equal(pr.base.repo.full_name, integration.repository);
    assert.equal(pr.base.ref, integration.targetRef);
    assert.equal(pr.merge_commit_sha, integration.mergeCommits[pr.number], 'SDK merge identity differs from reviewed inputs');
    assert.equal(isAncestor(pr.merge_commit_sha, inputs.sdkSha), true, `SDK pin excludes merged PR ${pr.number}`);
  }
  assert.equal(String(nativeRun.id), integration.nativeQualification.runId);
  assert.equal(nativeRun.repository.full_name, integration.repository);
  assert.equal(nativeRun.path, integration.nativeQualification.workflowPath);
  assert.equal(nativeRun.head_sha, inputs.sdkSha);
  assert.equal(nativeRun.head_branch, integration.targetRef);
  assert.equal(nativeRun.status, 'completed');
  assert.equal(nativeRun.conclusion, 'success');
}

function proveSdkIntegration(root, sdkGit, sourceSha, version) {
  verifySource(root, sourceSha, version);
  const inputs = validateInputs(json(join(root, 'release/castlabs-vsi-inputs.json')), true);
  const integration = inputs.sdkIntegration;
  const pulls = integration.requiredPRs.map(number => JSON.parse(run('gh', ['api', `repos/${integration.repository}/pulls/${number}`], root)));
  const nativeRun = JSON.parse(run('gh', ['api', `repos/${integration.repository}/actions/runs/${integration.nativeQualification.runId}`], root));
  run('git', ['init', sdkGit], root);
  run('git', ['fetch', '--quiet', '--filter=blob:none', '--no-tags', `https://github.com/${integration.repository}`, `refs/heads/${integration.targetRef}`], sdkGit);
  const targetSha = run('git', ['rev-parse', 'FETCH_HEAD'], sdkGit);
  checkSdkIntegration(inputs, pulls, nativeRun, targetSha, (ancestor, descendant) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: sdkGit, encoding: 'utf8' });
    assert.ok(result.status === 0 || result.status === 1, result.error?.message ?? result.stderr);
    return result.status === 0;
  });
  console.log(JSON.stringify({ sdkSha: inputs.sdkSha, targetRef: integration.targetRef, targetSha, mergeCommits: integration.mergeCommits, nativeQualification: integration.nativeQualification }));
}

export function stageManifest(original, inputs) {
  const directory = original.name?.replace('@stardustproof/', '');
  assert.ok(directories.includes(directory), `Excluded package ${original.name}`);
  assert.equal(original.version, inputs.packages[directory]);
  assert.notEqual(original.private, true);
  const manifest = structuredClone(original);
  for (const key of ['scripts', 'devDependencies', 'nx']) delete manifest[key];
  if (manifest.publishConfig?.exports) manifest.exports = manifest.publishConfig.exports;
  delete manifest.publishConfig;
  // Types has no runtime entry, but needs an explicit installed type export.
  if (directory === 'c2pa-types') manifest.exports = { '.': { types: './dist/index.d.ts' }, './package.json': './package.json' };
  assert.ok(!JSON.stringify(manifest.exports).includes('development'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith('@stardustproof/')) {
        const dependency = name.slice('@stardustproof/'.length);
        assert.ok(directories.includes(dependency), `Excluded dependency ${name}`);
        manifest[field][name] = `https://github.com/castlabs/c2pa-js/releases/download/v${inputs.bundleVersion}/${filename(dependency, inputs.packages[dependency])}`;
      } else assert.ok(!/^(workspace:|file:|link:)/.test(version), `Local dependency ${name}`);
    }
  }
  return manifest;
}

export function verifySource(root, sourceSha, version) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/, 'source_sha must be a full lowercase SHA');
  assert.equal(version, '1.0.9');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root), sourceSha);
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], root), '', 'Tracked source changed');
  const inputs = validateInputs(json(join(root, 'release/castlabs-vsi-inputs.json')));
  const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  assert.ok(cargo.includes(`c2pa = { git = "https://github.com/castlabs/c2pa-rs", rev = "${inputs.sdkSha}"`), 'SDK source does not match inputs');
  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  const sdkSources = [...lock.matchAll(/^source = "git\+https:\/\/github.com\/castlabs\/c2pa-rs[^"\n]*"$/gm)].map(m => m[0]);
  assert.ok(sdkSources.length > 0);
  assert.ok(sdkSources.every(line => line === `source = "git+https://github.com/castlabs/c2pa-rs?rev=${inputs.sdkSha}#${inputs.sdkSha}"`), 'Locked SDK identity mismatch');
  assert.match(lock, /name = "wasm-bindgen"\nversion = "0\.2\.129"/);
  for (const directory of directories) stageManifest(json(join(root, 'packages', directory, 'package.json')), inputs);
  assert.equal(json(join(root, 'packages/c2pa-node/package.json')).private, true);
  return {
    sourceSha, sdkSha: inputs.sdkSha,
    hashes: Object.fromEntries(['release/castlabs-vsi-inputs.json', 'Cargo.toml', 'Cargo.lock', 'pnpm-lock.yaml', ...directories.map(d => `packages/${d}/package.json`)].map(file => [file, hash(readFileSync(join(root, file)))]))
  };
}

export function pack(root, output, sourceSha, version) {
  const identity = verifySource(root, sourceSha, version);
  const inputs = json(join(root, 'release/castlabs-vsi-inputs.json'));
  mkdirSync(output, { recursive: true });
  assert.ok(!existsSync(join(output, 'provenance.json')), 'Refusing to replace an existing bundle');
  const wasm = readFileSync(join(root, 'packages/c2pa-wasm/pkg/c2pa_bg.wasm'));
  const sri = `sha256-${createHash('sha256').update(wasm).digest('base64')}`;
  assert.ok(readFileSync(join(root, 'packages/c2pa-wasm/pkg/c2pa.js'), 'utf8').includes(`export const WASM_SRI = ${JSON.stringify(sri)};`));
  assert.deepEqual(readFileSync(join(root, 'packages/c2pa-web/dist/resources/c2pa_bg.wasm')), wasm);
  const staging = mkdtempSync(join(output, '.pack-'));
  const packages = [];
  try {
    for (const directory of directories) {
      const source = join(root, 'packages', directory);
      const destination = join(staging, directory);
      mkdirSync(destination);
      const tree = directory === 'c2pa-wasm' ? 'pkg' : 'dist';
      cpSync(join(source, tree), join(destination, tree), { recursive: true });
      for (const file of ['README.md', 'LICENSE']) {
        const path = existsSync(join(source, file)) ? join(source, file) : join(root, file);
        if (existsSync(path)) cpSync(path, join(destination, file));
      }
      const manifest = stageManifest(json(join(source, 'package.json')), inputs);
      save(join(destination, 'package.json'), manifest);
      run('pnpm', ['pack', '--pack-destination', output], destination);
      const file = filename(directory, manifest.version);
      const entries = run('tar', ['-tzf', join(output, file)], root).split('\n');
      assert.ok(entries.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')));
      const required = directory === 'c2pa-types' ? ['dist/index.d.ts'] : directory === 'c2pa-wasm' ? ['pkg/c2pa.js', 'pkg/c2pa.d.ts', 'pkg/c2pa_bg.wasm', 'pkg/c2pa_bg.wasm.d.ts'] : directory === 'c2pa-web' ? ['dist/index.js', 'dist/index.d.ts', 'dist/inline.js', 'dist/inline.d.ts', 'dist/c2pa_worker.js', 'dist/resources/c2pa_bg.wasm'] : ['dist/index.js', 'dist/index.d.ts'];
      for (const requiredFile of required) assert.ok(entries.includes(`package/${requiredFile}`), `${file} missing ${requiredFile}`);
      assert.deepEqual(JSON.parse(run('tar', ['-xOzf', join(output, file), 'package/package.json'], root)), manifest);
      packages.push({ name: manifest.name, version: manifest.version, file, sha256: hash(readFileSync(join(output, file))) });
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  assert.deepEqual(verifySource(root, sourceSha, version), identity);
  const fixture = json(join(root, 'tmp/vsi-fixtures/provenance.json'));
  assert.equal(fixture.sdk, inputs.interopFixture.sdkSha);
  assert.equal(fixture.python, inputs.interopFixture.pythonSha);
  assert.equal(fixture.wheelSha256, inputs.interopFixture.wheelSha256);
  assert.equal(fixture.releaseInputLockSha256, inputs.interopFixture.lockSha256);
  assert.equal(fixture.wheelEvidenceSha256, inputs.interopFixture.evidenceSha256);
  assert.equal(fixture.nativeSha256, inputs.interopFixture.nativeSha256);
  save(join(output, 'provenance.json'), {
    schemaVersion: 1, bundleVersion: version, identity, inputs, packages,
    wasm: { sha256: hash(wasm), sri }, interopFixture: fixture,
    tools: json(join(output, 'tool-versions.json')),
    workflow: { sha: process.env.GITHUB_WORKFLOW_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    qualification: { passed: false },
    limitations: ['Unsigned provenance, not an attestation or reproducible-build guarantee.', 'Fixtures use the published Python 0.37.13+signer.1.0.9 wheel on SDK602; generation does not create a new native release.', 'GitHub draft assets only; no npm publication. Absolute dependency URLs become usable only after reviewed publication.', 'Advanced native descriptor/range resolution and sparse APIs are outside this release and require separate approval.']
  });
}

export function checkVitest(report, expected, browser) {
  assert.ok(report.numTotalTests > 0);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(report.numPendingTestSuites, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  const assertions = report.testResults.flatMap(result => result.assertionResults.map(test => ({ file: result.name, ...test })));
  assert.equal(assertions.length, report.numTotalTests);
  const skipped = assertions.filter(test => test.status !== 'passed');
  if (browser === 'firefox') {
    assert.equal(skipped.length, 1, 'Only the existing Firefox inline testcase may be skipped');
    assert.ok(skipped[0].file.endsWith(`/${firefoxInlineSkip.file}`) || skipped[0].file === firefoxInlineSkip.file);
    assert.equal(skipped[0].fullName, firefoxInlineSkip.fullName);
    assert.equal(skipped[0].status, 'skipped');
    assert.deepEqual(skipped[0].failureMessages, []);
  } else assert.deepEqual(skipped, []);
  assert.equal(report.numPendingTests, skipped.length);
  assert.equal(report.numPassedTests, report.numTotalTests - skipped.length);
  if (expected !== undefined) assert.equal(report.numTotalTests, expected);
}

export function checkPlaywright(report, expectedPerBrowser, expectedNames) {
  assert.deepEqual(report.errors, []);
  const tests = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      assert.equal(spec.ok, true);
      tests.push(...spec.tests.map(test => ({ ...test, title: spec.title })));
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  assert.equal(tests.length, browsers.length * expectedPerBrowser);
  for (const browser of browsers) {
    const group = tests.filter(test => test.projectName === browser);
    assert.equal(group.length, expectedPerBrowser);
    if (expectedNames) assert.deepEqual(group.map(test => test.title).sort(), [...expectedNames].sort());
    for (const test of group) {
      assert.equal(test.expectedStatus, 'passed');
      assert.equal(test.status, 'expected');
      assert.equal(test.results.length, 1, 'Retries cannot qualify a release');
      assert.equal(test.results[0].status, 'passed');
      assert.deepEqual(test.results[0].errors, []);
    }
  }
}

export function verifyEvidence(root, output) {
  const files = ['queue.json', 'utilities.json', ...browsers.map(b => `source-${b}.json`), 'source-vsi.json', 'installed-vsi.json', 'installed-offsets.json', 'consumer.json', 'consumer-graph.json', 'consumer-pnpm-lock.yaml'];
  checkVitest(json(join(output, 'queue.json')), 3);
  checkVitest(json(join(output, 'utilities.json')), 105);
  const sourceTests = run('git', ['ls-files', 'packages/c2pa-web/src', 'packages/c2pa-web/test'], root).split('\n').filter(file => /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/.test(file));
  assert.ok(sourceTests.length > 0);
  for (const browser of browsers) {
    const report = json(join(output, `source-${browser}.json`));
    checkVitest(report, undefined, browser);
    for (const file of sourceTests) assert.ok(report.testResults.some(result => result.name.includes(file)), `Missing ${browser} source suite ${file}`);
    const offsets = report.testResults.filter(result => result.name.includes('/reader.singleFile.spec.ts')).flatMap(result => result.assertionResults);
    assert.equal(offsets.length, 9, `Expected all nine ${browser} fragment-offset cases`);
    assert.ok(offsets.every(test => test.status === 'passed'));
  }
  checkPlaywright(json(join(output, 'source-vsi.json')), vsiNames.length, vsiNames);
  checkPlaywright(json(join(output, 'installed-vsi.json')), vsiNames.length, vsiNames);
  checkPlaywright(json(join(output, 'installed-offsets.json')), 9, offsetNames);
  const consumer = json(join(output, 'consumer.json'));
  assert.equal(consumer.passed, true);
  assert.equal(consumer.scope, 'isolated-installed-four-tarballs-v1');
  assert.equal(consumer.assertionHash, hash(readFileSync(join(root, 'packages/c2pa-web/test/vsi/qualification.pw.ts'))));
  const bundle = json(join(output, 'provenance.json'));
  assert.deepEqual(consumer.packages, bundle.packages);
  const generic = json(join(output, 'bmff/qualification.json'));
  assert.equal(generic.schemaVersion, 1);
  assert.equal(generic.passed, true);
  assert.equal(generic.profile, 'bmff-exclusion-candidate-consumer-v1');
  assert.equal(generic.bundleVersion, bundle.bundleVersion);
  assert.equal(generic.browserSourceSha, bundle.identity.sourceSha);
  assert.equal(generic.sdkSha, bundle.identity.sdkSha);
  assert.equal(generic.wasmSha256, bundle.wasm.sha256);
  assert.deepEqual(generic.packages, bundle.packages);
  assert.deepEqual(generic.browsers, browsers);
  assert.equal(generic.workers, 1);
  assert.equal(generic.retries, 0);
  assert.equal(generic.expectedTests, 288);
  assert.equal(generic.actualTests, 288);
  const lock = json(join(root, 'release/bmff-exclusion-inputs.json'));
  assert.deepEqual(generic.producerInputs, lock.python);
  assert.equal(generic.lockSha256, hash(readFileSync(join(root, 'release/bmff-exclusion-inputs.json'))));
  const snapshot = json(join(output, 'bmff/published-provenance.json'));
  assert.deepEqual(snapshot, { ...bundle, qualification: { passed: false } }, 'Generic evidence must qualify this exact unsealed bundle');
  assert.equal(generic.provenanceSha256, hash(readFileSync(join(output, 'bmff/published-provenance.json'))));
  const manifest = json(join(output, 'bmff/fixtures/manifest.json'));
  assert.equal(generic.manifestSha256, hash(readFileSync(join(output, 'bmff/fixtures/manifest.json'))));
  assert.deepEqual(generic.producer, manifest.producer);
  assert.equal(manifest.producer.pythonVersion, lock.python.version);
  assert.equal(manifest.producer.pythonSourceSha, lock.python.sourceSha);
  assert.equal(manifest.producer.sdkSha, bundle.identity.sdkSha);
  assert.equal(manifest.producer.nativeLibrarySha256, lock.python.nativeSha256);
  assert.equal(manifest.producer.generatorSha256, hash(readFileSync(join(root, 'tools/bmff-exclusion-fixtures.py'))));
  assert.deepEqual(generic.cases, manifest.cases);
  assert.equal(manifest.cases.length, 96);
  const names = manifest.cases.map(entry => entry.name);
  assert.equal(new Set(names).size, 96);
  const native = json(join(output, 'bmff/fixtures/native-verdicts.json'));
  assert.equal(native.schemaVersion, 1);
  assert.equal(native.generationComplete, true);
  assert.equal(native.qualified, true);
  assert.equal(native.generationFailure, null);
  assert.deepEqual(native.errors, []);
  assert.deepEqual(native.producer, manifest.producer);
  assert.deepEqual(native.cases.map(entry => entry.name).sort(), [...names].sort());
  for (const verdict of native.cases) {
    const entry = manifest.cases.find(entry => entry.name === verdict.name);
    assert.equal(verdict.qualified, true);
    assert.equal(verdict.exception, undefined);
    assert.deepEqual(verdict.differences ?? [], []);
    assert.equal(verdict.mode, entry.mode);
    assert.equal(verdict.state, entry.expect.state);
  }
  const report = json(join(output, 'bmff/browser.json'));
  checkPlaywright(report, 96, names);
  assert.equal(report.stats.expected, 288);
  for (const field of ['unexpected', 'flaky', 'skipped']) assert.equal(report.stats[field], 0);
  for (const required of ['browser.json', 'consumer-graph.json', 'consumer-pnpm-lock.yaml', 'inputs.json', 'published-provenance.json']) assert.ok(Object.hasOwn(generic.reportHashes, required));
  for (const required of ['manifest.json', 'native-verdicts.json', ...Object.keys(manifest.files)]) assert.ok(Object.hasOwn(generic.fixtureHashes, required));
  for (const required of ['tools/bmff-exclusion-consumer.mjs', 'tools/bmff-exclusion-fixtures.py', 'tools/bmff-exclusion-inputs.mjs', 'tools/vsi-consumer.mjs', 'tools/vsi-release.mjs', 'tools/vsi-installed-offsets.mjs', '.github/workflows/castlabs-vsi-bundle.yml']) assert.ok(Object.hasOwn(generic.sourceHashes, required));
  for (const [base, hashes, source] of [['bmff', generic.reportHashes, false], ['bmff/fixtures', generic.fixtureHashes, false], ['', generic.sourceHashes, true]]) {
    for (const [file, digest] of Object.entries(hashes)) {
      assert.match(file, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/);
      assert.ok(!file.split('/').some(part => part === '.' || part === '..'));
      assert.equal(hash(readFileSync(join(source ? root : output, base, file))), digest, `Generic evidence hash: ${file}`);
      if (!source) files.push(`${base}/${file}`);
    }
  }
  assert.equal(hash(readFileSync(join(output, 'bmff/inputs.json'))), generic.lockSha256);
  files.push('bmff/qualification.json');
  return Object.fromEntries(files.map(file => [file, hash(readFileSync(join(output, file)))]));
}

export function seal(root, output, sourceSha, version, publish = false) {
  const bundle = json(join(output, 'provenance.json'));
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.bundleVersion, version);
  assert.deepEqual(bundle.identity, verifySource(root, sourceSha, version));
  assert.deepEqual(bundle.inputs, json(join(root, 'release/castlabs-vsi-inputs.json')));
  validateInputs(bundle.inputs, publish);
  assert.deepEqual(bundle.packages.map(p => [p.name, p.version, p.file]), directories.map(d => [`@stardustproof/${d}`, bundle.inputs.packages[d], filename(d, bundle.inputs.packages[d])]));
  for (const pkg of bundle.packages) assert.equal(hash(readFileSync(join(output, pkg.file))), pkg.sha256);
  const tools = json(join(output, 'tool-versions.json'));
  assert.deepEqual(bundle.tools, tools);
  assert.equal(tools.wasmBindgen, 'wasm-bindgen 0.2.129');
  assert.match(tools.binaryen, /^wasm-opt version 124\b/);
  assert.equal(tools.pnpm, '10.15.0');
  assert.match(tools.node, /^v24\./);
  assert.match(tools.rustc, /^rustc 1\.96\.0 /);
  assert.match(tools.cargo, /^cargo 1\.96\.0 /);
  assert.deepEqual(Object.keys(tools.archiveSha256).sort(), ['binaryen', 'bindgen']);
  for (const digest of [tools.cargoWasmSha256, ...Object.values(tools.archiveSha256)]) assert.match(digest, /^[a-f0-9]{64}$/);
  const evidence = verifyEvidence(root, output);
  const genericFiles = Object.keys(evidence).filter(file => file.startsWith('bmff/')).sort();
  const archive = join(output, 'bmff-evidence.tar.gz');
  if (!publish) run('tar', ['-czf', archive, '-C', output, ...genericFiles], root);
  assert.deepEqual(run('tar', ['-tzf', archive], root).split('\n').sort(), genericFiles);
  for (const file of genericFiles) {
    const member = spawnSync('tar', ['-xOzf', archive, file], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(member.status, 0);
    assert.equal(hash(member.stdout), evidence[file], `Archived evidence differs: ${file}`);
  }
  evidence['bmff-evidence.tar.gz'] = hash(readFileSync(archive));
  if (publish) {
    assert.deepEqual(bundle.workflow, { sha: process.env.GITHUB_WORKFLOW_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT }, 'Evidence belongs to another workflow run');
    assert.deepEqual(bundle.qualification, { passed: true, profile: 'vsi-browser-bundle-v1', evidence });
    const checksums = [...bundle.packages.map(p => p.file), 'provenance.json', 'tool-versions.json', ...Object.keys(evidence)].sort().map(file => `${hash(readFileSync(join(output, file)))}  ${file}\n`).join('');
    assert.equal(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), checksums);
  } else {
    bundle.qualification = { passed: true, profile: 'vsi-browser-bundle-v1', evidence };
    save(join(output, 'provenance.json'), bundle);
    const files = [...bundle.packages.map(p => p.file), 'provenance.json', 'tool-versions.json', ...Object.keys(evidence)].sort();
    writeFileSync(join(output, 'SHA256SUMS'), files.map(file => `${hash(readFileSync(join(output, file)))}  ${file}\n`).join(''));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, output, sha, version] = process.argv.slice(2);
  if (command === 'verify') console.log(JSON.stringify(verifySource(resolve(root), sha, version), null, 2));
  else if (command === 'sdk-proof') proveSdkIntegration(resolve(root), resolve(output), sha, version);
  else if (command === 'pack') pack(resolve(root), resolve(output), sha, version);
  else if (command === 'seal' || command === 'guard') seal(resolve(root), resolve(output), sha, version, command === 'guard');
  else throw new Error('Expected verify, pack, seal, guard or sdk-proof');
}
