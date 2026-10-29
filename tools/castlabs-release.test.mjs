import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { appendSri, pack, packages, releaseTag, sdkSha, stageManifest, verifySource } from './castlabs-release.mjs';
import { consumerManifest, installConsumer, packagedBrowserCases, packagedBrowserScope, packagedCasesInBrowser } from './castlabs-consumer-smoke.mjs';

const source = process.env.CASTLABS_TEST_SOURCE;
assert.ok(source, 'Set CASTLABS_TEST_SOURCE to a separate approved stable source checkout (see README)');
const helper = fileURLToPath(new URL('./castlabs-release.mjs', import.meta.url));
const manifest = directory => JSON.parse(readFileSync(join(source, 'packages', directory, 'package.json')));

test('bundle label is independent of package versions and cannot inject a tag/path', () => {
  assert.equal(releaseTag('1.0.7'), 'v1.0.7');
  for (const label of ['v1.0.7', '1.0.8', '../1.0.7', '1.0.7\n']) assert.throws(() => releaseTag(label));
});

test('stage manifests use absolute release tarballs without changing original versions', () => {
  const original = manifest('c2pa-web');
  const before = structuredClone(original);
  const staged = stageManifest(original, '1.0.7');
  assert.deepEqual(original, before);
  assert.equal(staged.version, '0.8.0');
  assert.equal(staged.dependencies['@stardustproof/c2pa-types'], 'https://github.com/castlabs/c2pa-js/releases/download/v1.0.7/stardustproof-c2pa-types-0.4.3.tgz');
  assert.equal(staged.dependencies['@stardustproof/c2pa-wasm'], 'https://github.com/castlabs/c2pa-js/releases/download/v1.0.7/stardustproof-c2pa-wasm-0.6.0.tgz');
  assert.equal(staged.dependencies.highgain, original.dependencies.highgain);
  assert.equal(staged.exports['.'].development, undefined);
  assert.equal(staged.scripts, undefined);
  assert.equal(staged.devDependencies, undefined);
  assert.throws(() => stageManifest({ ...original, version: '1.0.7' }, '1.0.7'));
  assert.throws(() => stageManifest({ ...original, dependencies: { unknown: 'workspace:*' } }, '1.0.7'));
  assert.throws(() => stageManifest({ ...original, dependencies: { '@stardustproof/unknown': '1.0.0' } }, '1.0.7'));
});

test('consumer-only overrides pin every internal package to a verified tarball without modifying release metadata', () => {
  const output = mkdtempSync(join(tmpdir(), 'castlabs-consumer-manifest-'));
  try {
    const bundle = { packages: packages.map(pkg => {
      const file = `stardustproof-${pkg.directory}-${pkg.version}.tgz`;
      const bytes = Buffer.from(`synthetic ${pkg.directory}`);
      writeFileSync(join(output, file), bytes);
      return { name: `@stardustproof/${pkg.directory}`, version: pkg.version, file, sha256: createHash('sha256').update(bytes).digest('hex') };
    }) };
    const before = structuredClone(bundle);
    const staged = consumerManifest(bundle, output);
    assert.deepEqual(staged.dependencies, staged.pnpm.overrides);
    assert.equal(staged.packageManager, 'pnpm@10.15.0');
    for (const pkg of bundle.packages) assert.equal(staged.dependencies[pkg.name], `file:${join(output, pkg.file)}`);
    assert.deepEqual(bundle, before);
    assert.throws(() => consumerManifest({ packages: [...bundle.packages, bundle.packages[0]] }, output));
    assert.throws(() => consumerManifest({ packages: bundle.packages.map(pkg => ({ ...pkg, file: '../escape.tgz' })) }, output));
    writeFileSync(join(output, bundle.packages[0].file), 'tampered');
    assert.throws(() => consumerManifest(bundle, output));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('consumer probes select disposable declarations and cover all nine browser regression groups', () => {
  const smoke = readFileSync(new URL('./castlabs-consumer-smoke.mjs', import.meta.url), 'utf8');
  const command = smoke.split('\n').find(line => line.includes("'probe.mts', '--noEmit'"));
  assert.ok(command);
  let probe;
  new Function('run', 'process', 'join', 'root', 'consumer', command)((...args) => { probe = args; }, process, join, '/source', '/consumer');
  assert.deepEqual(probe, [process.execPath, [join('/source', 'node_modules/typescript/bin/tsc'), 'probe.mts', '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'ES2023', '--lib', 'ES2023,DOM,ESNext.Disposable'], '/consumer', true]);
  const pageFunction = packagedCasesInBrowser.toString();
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: `(${pageFunction});`, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of packagedBrowserCases) assert.ok(pageFunction.includes(`check('${name}'`));
  assert.equal(packagedBrowserCases.length, 9);
});

test('workflow artifacts survive failed-job retries and inherited release jobs are upstream-only', () => {
  const automation = fileURLToPath(new URL('../', import.meta.url));
  const workflow = readFileSync(join(automation, '.github/workflows/castlabs-stable-bundle.yml'), 'utf8');
  assert.equal(workflow.match(/name: castlabs-stable-bundle-\$\{\{ github.run_id \}\}/g)?.length, 2);
  assert.match(workflow, /overwrite: true/);
  assert.ok(!workflow.includes('github.run_attempt'));
  assert.ok(!workflow.includes('git -C source diff --exit-code'));
  const inherited = readFileSync(join(automation, '.github/workflows/release.yml'), 'utf8');
  assert.equal(inherited.match(/github.repository == 'contentauth\/c2pa-js'/g)?.length, 2);
  // Execute the actual pre-publication verifier with synthetic artifacts, never gh.
  const verifier = workflow.split("node --input-type=module <<'NODE'\n")[2]?.split('\n          NODE')[0];
  assert.ok(verifier);
  const temp = mkdtempSync(join(tmpdir(), 'castlabs-publish-verifier-'));
  try {
    mkdirSync(join(temp, 'bundle'));
    const bytes = Buffer.from('synthetic tarball');
    const manifest = {
      sources: { js: { sha: '1'.repeat(40), repository: 'https://github.com/castlabs/c2pa-js' }, sdk: { sha: sdkSha } },
      workflowSha: '2'.repeat(40), runId: '1234', bundleVersion: '1.0.7', tag: 'v1.0.7',
      qualification: { passed: true }, consumerSmoke: { passed: true }, packagedBrowserQualification: { passed: true },
      packages: packages.map(pkg => ({ name: `@stardustproof/${pkg.directory}`, version: pkg.version, file: `stardustproof-${pkg.directory}-${pkg.version}.tgz`, sha256: createHash('sha256').update(bytes).digest('hex') }))
    };
    // Synthetic command reports test the verifier only, never qualify an SDK build.
    manifest.packagedBrowserQualification = {
      passed: true, status: 'passed', scope: packagedBrowserScope,
      packageHashes: manifest.packages.map(({ file, sha256 }) => ({ file, sha256 })),
      results: ['chromium', 'firefox', 'webkit'].map(browser => ({
        browser, exitCode: 0, signal: null,
        command: [process.execPath, '/fixture/tools/castlabs-consumer-smoke.mjs', 'browser', '/fixture/source', '/fixture/consumer', browser, `/fixture/${browser}.json`],
        report: { browser, scope: packagedBrowserScope, version: 'synthetic-verifier-fixture', passed: true, pageErrors: [], cases: packagedBrowserCases.map(name => ({ name, passed: true })) }
      }))
    };
    for (const pkg of manifest.packages) writeFileSync(join(temp, 'bundle', pkg.file), bytes);
    const verify = () => {
      writeFileSync(join(temp, 'bundle/provenance.json'), JSON.stringify(manifest));
      return spawnSync(process.execPath, ['--input-type=module', '-e', verifier], { cwd: temp, encoding: 'utf8', env: {
        ...process.env, SOURCE_SHA: '1'.repeat(40), BUNDLE_VERSION: '1.0.7', GITHUB_WORKFLOW_SHA: '2'.repeat(40), GITHUB_RUN_ID: '1234'
      } }).status;
    };
    assert.equal(verify(), 0);
    manifest.sources.sdk.sha = '0aee9d318289ba4a5e0fe9e0fc1ddc59b0632f91';
    assert.equal(verify(), 1, 'The previous SDK must not pass publication verification');
    manifest.sources.sdk.sha = sdkSha;
    assert.equal(verify(), 0);
    manifest.packagedBrowserQualification.passed = false;
    assert.equal(verify(), 1);
    manifest.packagedBrowserQualification.passed = true;
    const qualified = structuredClone(manifest.packagedBrowserQualification);
    manifest.packagedBrowserQualification = { passed: true };
    assert.equal(verify(), 1, 'A boolean flag is not a browser execution report');
    manifest.packagedBrowserQualification = structuredClone(qualified);
    manifest.packagedBrowserQualification.results[1].exitCode = 1;
    assert.equal(verify(), 1);
    manifest.packagedBrowserQualification = structuredClone(qualified);
    manifest.packagedBrowserQualification.results[1].report.cases[0].passed = false;
    assert.equal(verify(), 1);
    manifest.packagedBrowserQualification = structuredClone(qualified);
    manifest.packagedBrowserQualification.results.pop();
    assert.equal(verify(), 1);
    manifest.packagedBrowserQualification = structuredClone(qualified);
    manifest.packagedBrowserQualification.results[0].command = ['true'];
    assert.equal(verify(), 1);
    manifest.packagedBrowserQualification = structuredClone(qualified);
    manifest.packagedBrowserQualification.packageHashes[0].sha256 = 'bad-hash';
    assert.equal(verify(), 1);
    manifest.packagedBrowserQualification = structuredClone(qualified);
    manifest.sources.js.sha = '3'.repeat(40);
    assert.equal(verify(), 1);
    manifest.sources.js.sha = '1'.repeat(40);
    manifest.workflowSha = '3'.repeat(40);
    assert.equal(verify(), 1);
    manifest.workflowSha = '2'.repeat(40);
    manifest.runId = '5678';
    assert.equal(verify(), 1);
    manifest.runId = '1234';
    writeFileSync(join(temp, 'bundle', manifest.packages[0].file), 'tampered');
    assert.equal(verify(), 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('workflow rejects only exact existing tags/releases and fails closed on API errors', () => {
  const workflow = readFileSync(new URL('../.github/workflows/castlabs-stable-bundle.yml', import.meta.url), 'utf8');
  const script = workflow.split('      - name: Create a new draft release only (never overwrite a tag or release)\n        shell: bash\n        run: |\n')[1];
  assert.ok(script);
  const temp = mkdtempSync(join(tmpdir(), 'castlabs-publish-guard-'));
  const refsCall = 'api --paginate repos/castlabs/c2pa-js/git/matching-refs/tags/v1.0.7';
  const releasesCall = 'api --paginate repos/castlabs/c2pa-js/releases?per_page=100';
  // A shell function intercepts every gh call; no credentials or GitHub access are used.
  const mock = `gh() {
    printf '%s %s %s\\n' "$1" "$2" "$3" >> "$GH_CALLS"
    case "$1:$2:$3" in
      api:--paginate:repos/castlabs/c2pa-js/git/matching-refs/tags/v1.0.7)
        printf '%s\\n' "$MOCK_REFS"; return "$MOCK_REFS_STATUS" ;;
      api:--paginate:repos/castlabs/c2pa-js/releases?per_page=100)
        printf '%s\\n' "$MOCK_RELEASES"; return "$MOCK_RELEASES_STATUS" ;;
      release:create:v1.0.7) return 0 ;;
      *) return 99 ;;
    esac
  }`;
  try {
    for (const scenario of [
      { name: 'no existing tags or releases', status: 0, calls: 3 },
      { name: 'prefix matches only', refs: 'refs/tags/v1.0.7-rc.1\nrefs/tags/v1.0.70', releases: 'v1.0.7-rc.1\nv1.0.70', status: 0, calls: 3 },
      { name: 'exact tag among prefix matches', refs: 'refs/tags/v1.0.7-rc.1\nrefs/tags/v1.0.7\nrefs/tags/v1.0.70', status: 1, calls: 1 },
      { name: 'existing release', releases: 'v1.0.7', status: 1, calls: 2 },
      { name: 'tag API error with no output', refsStatus: 42, status: 42, calls: 1 },
      { name: 'tag API error after partial prefix output', refs: 'refs/tags/v1.0.70', refsStatus: 42, status: 42, calls: 1 },
      { name: 'release API error', releasesStatus: 43, status: 43, calls: 2 }
    ]) {
      const callsFile = join(temp, 'gh-calls.txt');
      writeFileSync(callsFile, '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${mock}\n${script}`], {
        cwd: temp, encoding: 'utf8', env: {
          ...process.env, GH_CALLS: callsFile, GH_REPO: 'castlabs/c2pa-js', BUNDLE_VERSION: '1.0.7', SOURCE_SHA: '1'.repeat(40),
          MOCK_REFS: scenario.refs ?? '', MOCK_RELEASES: scenario.releases ?? '',
          MOCK_REFS_STATUS: String(scenario.refsStatus ?? 0), MOCK_RELEASES_STATUS: String(scenario.releasesStatus ?? 0)
        }
      });
      assert.equal(result.status, scenario.status, `${scenario.name}: ${result.stderr}`);
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n');
      assert.deepEqual(calls, [refsCall, releasesCall, 'release create v1.0.7'].slice(0, scenario.calls), scenario.name);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('real pnpm packs and installs synthetic output; source browsers cannot waive packaged-browser qualification', () => {
  // All generated files, git objects and package-manager state stay in TMPDIR.
  const temp = mkdtempSync(join(tmpdir(), 'castlabs-release-test-'));
  const root = join(temp, 'source');
  const output = join(temp, 'bundle');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
  } }).trim();
  try {
    for (const file of ['Cargo.toml', 'Cargo.lock', 'pnpm-lock.yaml', 'LICENSE']) cpSync(join(source, file), join(root, file));
    writeFileSync(join(root, '.gitignore'), 'packages/*/pkg/\npackages/*/dist/\n');
    for (const pkg of packages) {
      const directory = join(root, 'packages', pkg.directory);
      mkdirSync(directory, { recursive: true });
      cpSync(join(source, 'packages', pkg.directory, 'package.json'), join(directory, 'package.json'));
      if (pkg.directory === 'c2pa-web') {
        const path = join(directory, 'package.json');
        const fixture = JSON.parse(readFileSync(path));
        // The install fixture exercises internal URL overrides without registry access.
        delete fixture.dependencies.highgain;
        delete fixture.dependencies['ts-deepmerge'];
        writeFileSync(path, JSON.stringify(fixture));
      }
      for (const file of pkg.required) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), file.endsWith('.wasm') ? Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) : '// synthetic build output\n');
      }
    }
    // A synthetic commit object is needed to exercise SHA and dirty-tree verification.
    // No source-worktree refs or commits are changed.
    git('init', '--quiet');
    git('add', '.');
    const tree = git('write-tree');
    const sha = git('commit-tree', tree, '-m', 'Synthetic packaging fixture');
    git('update-ref', 'HEAD', sha);
    assert.equal(verifySource(root, sha, '1.0.7').sdk.sha, sdkSha);
    assert.throws(() => verifySource(root, '0'.repeat(40), '1.0.7'));
    assert.throws(() => verifySource(root, 'HEAD', '1.0.7'));
    mkdirSync(join(output, 'diagnostics'), { recursive: true });
    writeFileSync(join(output, 'diagnostics/tool-versions.json'), JSON.stringify({ fixture: true }));
    const sri = appendSri(root);
    assert.match(sri, /^sha512-/);
    assert.throws(() => appendSri(root));
    const assets = pack(root, output, sha, '1.0.7');
    assert.equal(assets.length, 3);
    const provenance = JSON.parse(readFileSync(join(output, 'provenance.json')));
    assert.equal(provenance.qualification.passed, false);
    assert.equal(provenance.wasm.sri, sri);
    assert.equal(provenance.sources.js.sha, sha);
    for (const asset of assets) {
      assert.equal(asset.sha256, createHash('sha256').update(readFileSync(join(output, asset.file))).digest('hex'));
    }
    const web = JSON.parse(execFileSync('tar', ['-xOzf', join(output, assets[2].file), 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(web.dependencies['@stardustproof/c2pa-wasm'], 'https://github.com/castlabs/c2pa-js/releases/download/v1.0.7/stardustproof-c2pa-wasm-0.6.0.tgz');
    assert.equal(provenance.consumerSmoke.passed, false);
    assert.equal(provenance.packagedBrowserQualification.passed, false);
    const evidence = installConsumer(provenance, output, join(temp, 'consumer'));
    assert.equal(evidence.installed.length, 3);
    assert.ok(evidence.installed.every(pkg => pkg.verifiedFiles > 0));
    for (const asset of assets) assert.equal(asset.sha256, createHash('sha256').update(readFileSync(join(output, asset.file))).digest('hex'));
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\ncase "$*" in *--browser=firefox*) exit 1;; *) exit 0;; esac\n', { mode: 0o755 });
    const qualify = () => spawnSync(process.execPath, [helper, 'qualify', root, output, sha, '1.0.7'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8'
    });
    const failed = qualify();
    assert.equal(failed.status, 1, failed.stderr);
    const qualification = JSON.parse(readFileSync(join(output, 'provenance.json'))).qualification;
    assert.equal(qualification.passed, false);
    assert.deepEqual(qualification.results.map(result => [result.browser, result.exitCode]), [['chromium', 0], ['firefox', 1], ['webkit', 0]]);
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
    const passed = qualify();
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(readFileSync(join(output, 'provenance.json'))).qualification.passed, true);
    assert.equal(JSON.parse(readFileSync(join(output, 'provenance.json'))).packagedBrowserQualification.passed, false, 'Source browser tests must never waive the packaged-browser gate');
    for (const [file, message] of [['Cargo.toml', 'Wrong SDK pin'], ['Cargo.lock', 'Wrong locked SDK pin']]) {
      const original = readFileSync(join(root, file), 'utf8');
      writeFileSync(join(root, file), original.replaceAll(sdkSha, '0aee9d318289ba4a5e0fe9e0fc1ddc59b0632f91'));
      git('add', file);
      const wrongSha = git('commit-tree', git('write-tree'), '-m', 'Wrong SDK fixture');
      git('update-ref', 'HEAD', wrongSha);
      assert.throws(() => verifySource(root, wrongSha, '1.0.7'), { message });
      writeFileSync(join(root, file), original);
      git('add', file);
      git('update-ref', 'HEAD', sha);
    }
    assert.equal(verifySource(root, sha, '1.0.7').sdk.sha, sdkSha);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
