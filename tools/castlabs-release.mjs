import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sdkSha = '0aee9d318289ba4a5e0fe9e0fc1ddc59b0632f91';
export const packages = [
  { directory: 'c2pa-types', version: '0.4.3', output: 'dist', required: ['dist/index.d.ts'] },
  { directory: 'c2pa-wasm', version: '0.6.0', output: 'pkg', required: ['pkg/c2pa.js', 'pkg/c2pa.d.ts', 'pkg/c2pa_bg.wasm', 'pkg/c2pa_bg.wasm.d.ts'] },
  { directory: 'c2pa-web', version: '0.8.0', output: 'dist', required: ['dist/index.js', 'dist/index.d.ts', 'dist/inline.js', 'dist/inline.d.ts', 'dist/resources/c2pa_bg.wasm'] }
];
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const filename = pkg => `stardustproof-${pkg.directory}-${pkg.version}.tgz`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.error ?? result.stderr}`);
  return result.stdout.trim();
}

export function releaseTag(label) {
  assert.equal(label, '1.0.7', 'This workflow only prepares the stable 1.0.7 bundle');
  return `v${label}`;
}

export function stageManifest(original, label) {
  const tag = releaseTag(label);
  const pkg = packages.find(item => original.name === `@stardustproof/${item.directory}`);
  assert.ok(pkg, `Unexpected package: ${original.name}`);
  assert.equal(original.version, pkg.version);
  const manifest = structuredClone(original);
  // Pack a copy, never run source lifecycle hooks or publish to npm.
  delete manifest.scripts;
  delete manifest.devDependencies;
  if (manifest.publishConfig?.exports) manifest.exports = manifest.publishConfig.exports;
  delete manifest.publishConfig;
  manifest.repository = { type: 'git', url: 'git+https://github.com/castlabs/c2pa-js.git' };
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      const dependency = packages.find(item => name === `@stardustproof/${item.directory}`);
      if (dependency) {
        manifest[field][name] = `https://github.com/castlabs/c2pa-js/releases/download/${tag}/${filename(dependency)}`;
      } else {
        assert.ok(!/^(workspace:|file:|link:)/.test(version), `Unresolved dependency: ${name}`);
        assert.ok(!name.startsWith('@stardustproof/'), `Unknown internal dependency: ${name}`);
      }
    }
  }
  return manifest;
}

export function verifySource(root, sourceSha, label) {
  releaseTag(label);
  assert.match(sourceSha, /^[0-9a-f]{40}$/, 'source_sha must be a full lowercase commit SHA');
  assert.equal(sourceSha.length, 40);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root), sourceSha, 'Checkout differs from source_sha');
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], root), '', 'Tracked source changed');
  const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  assert.ok(cargo.includes(`c2pa = { git = "https://github.com/castlabs/c2pa-rs", rev = "${sdkSha}"`), 'Wrong SDK pin');
  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  assert.ok(lock.includes(`source = "git+https://github.com/castlabs/c2pa-rs?rev=${sdkSha}#${sdkSha}"`), 'Wrong locked SDK pin');
  assert.match(lock, /name = "wasm-bindgen"\nversion = "0\.2\.114"/);
  for (const pkg of packages) stageManifest(json(join(root, 'packages', pkg.directory, 'package.json')), label);
  return {
    js: { repository: 'https://github.com/castlabs/c2pa-js', sha: sourceSha },
    sdk: { repository: 'https://github.com/castlabs/c2pa-rs', sha: sdkSha },
    lockfiles: Object.fromEntries(['Cargo.lock', 'pnpm-lock.yaml'].map(file => [file, sha256(readFileSync(join(root, file)))]))
  };
}

export function appendSri(root) {
  const pkg = join(root, 'packages/c2pa-wasm/pkg');
  const integrity = `sha512-${createHash('sha512').update(readFileSync(join(pkg, 'c2pa_bg.wasm'))).digest('base64')}`;
  assert.ok(!readFileSync(join(pkg, 'c2pa.js'), 'utf8').includes('export const WASM_SRI'), 'SRI already appended');
  appendFileSync(join(pkg, 'c2pa.js'), `\nexport const WASM_SRI = ${JSON.stringify(integrity)};\n`);
  appendFileSync(join(pkg, 'c2pa.d.ts'), '\nexport declare const WASM_SRI: string;\n');
  return integrity;
}

export function pack(root, output, sourceSha, label) {
  const sources = verifySource(root, sourceSha, label);
  mkdirSync(output, { recursive: true });
  const wasm = readFileSync(join(root, 'packages/c2pa-wasm/pkg/c2pa_bg.wasm'));
  const sri = `sha512-${createHash('sha512').update(wasm).digest('base64')}`;
  assert.ok(readFileSync(join(root, 'packages/c2pa-wasm/pkg/c2pa.js'), 'utf8').includes(`export const WASM_SRI = ${JSON.stringify(sri)};`));
  assert.ok(readFileSync(join(root, 'packages/c2pa-wasm/pkg/c2pa.d.ts'), 'utf8').includes('export declare const WASM_SRI: string;'));
  assert.deepEqual(readFileSync(join(root, 'packages/c2pa-web/dist/resources/c2pa_bg.wasm')), wasm, 'Web and WASM assets differ');
  const staging = mkdtempSync(join(output, '.pack-'));
  const assets = [];
  try {
    for (const pkg of packages) {
      const source = join(root, 'packages', pkg.directory);
      const destination = join(staging, pkg.directory);
      mkdirSync(destination);
      cpSync(join(source, pkg.output), join(destination, pkg.output), { recursive: true });
      for (const file of ['README.md', 'LICENSE']) {
        const candidate = existsSync(join(source, file)) ? join(source, file) : join(root, file);
        if (existsSync(candidate)) cpSync(candidate, join(destination, file));
      }
      const manifest = stageManifest(json(join(source, 'package.json')), label);
      save(join(destination, 'package.json'), manifest);
      run('pnpm', ['pack', '--pack-destination', output], destination);
      const file = filename(pkg);
      const tarball = join(output, file);
      const entries = run('tar', ['-tzf', tarball], root).split('\n');
      for (const required of ['package.json', ...pkg.required]) {
        assert.ok(entries.includes(`package/${required}`), `${file} missing ${required}`);
      }
      const packed = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json'], root));
      assert.deepEqual(packed, manifest, 'pnpm changed staged manifest');
      assert.ok(!(JSON.stringify(packed.exports) ?? '').includes('"development"'), 'Source-only export in bundle');
      assets.push({ name: manifest.name, version: manifest.version, file, sha256: sha256(readFileSync(tarball)) });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  assert.deepEqual(verifySource(root, sourceSha, label), sources, 'Source or lockfiles changed while packing');
  save(join(output, 'provenance.json'), {
    schemaVersion: 1, bundleVersion: label, tag: releaseTag(label), sources,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}` : null,
    tools: json(join(output, 'diagnostics/tool-versions.json')),
    wasm: { sha256: sha256(wasm), sri }, packages: assets,
    qualification: { passed: false, status: 'not-run' },
    consumerSmoke: { passed: false, status: 'not-run' },
    packagedBrowserQualification: { passed: false, status: 'not-run' },
    limitations: [
      'Unsigned build provenance, not an attestation or a reproducible-build guarantee.',
      'GitHub release assets only; nothing is published to npm. Dependency URLs require the release to be made public after review.',
      'Qualification runs the complete web suites in Chromium, Firefox and WebKit; it does not replace the inherited Rust/WASM test and lint CI.',
      'Known baseline fixture failures are not waived and block draft release creation.',
      'Packaged-browser qualification covers the nine fragment-offset regression cases, not the entire source suite; both gates are required.'
    ]
  });
  return assets;
}

function qualify(root, output, sourceSha, label) {
  const manifestPath = join(output, 'provenance.json');
  const manifest = json(manifestPath);
  const results = [];
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    const args = ['exec', 'vitest', 'run', `--browser=${browser}`, '--testTimeout=60000', '--no-file-parallelism'];
    console.log(`Running full ${browser} suite: pnpm ${args.join(' ')}`);
    const result = spawnSync('pnpm', args, {
      cwd: join(root, 'packages/c2pa-web'), stdio: 'inherit', timeout: 20 * 60 * 1000
    });
    results.push({ browser, command: ['pnpm', ...args], exitCode: result.status, signal: result.signal, error: result.error?.message });
  }
  const sources = verifySource(root, sourceSha, label);
  assert.deepEqual(sources, manifest.sources, 'Source changed during qualification');
  const passed = results.every(result => result.exitCode === 0);
  manifest.qualification = { passed, status: passed ? 'passed' : 'failed', results };
  save(manifestPath, manifest);
  save(join(output, 'diagnostics/qualification.json'), manifest.qualification);
  assert.ok(passed, 'Qualification failed; artifacts are diagnostic only, no release permitted');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, destination, sourceSha, label] = process.argv.slice(2);
  const root = resolve(source ?? '.');
  const output = resolve(destination ?? '.');
  if (command === 'verify') console.log(JSON.stringify(verifySource(root, sourceSha, label), null, 2));
  else if (command === 'sri') console.log(appendSri(root));
  else if (command === 'pack') pack(root, output, sourceSha, label);
  else if (command === 'qualify') qualify(root, output, sourceSha, label);
  else throw new Error('Expected verify, sri, pack or qualify');
}
