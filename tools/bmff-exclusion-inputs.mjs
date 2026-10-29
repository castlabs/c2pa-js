// CI download/identity gate only. No installation, signing or native build.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './vsi-release.mjs';

async function download(lockPath, output) {
  const lockBytes = readFileSync(lockPath);
  const lock = JSON.parse(lockBytes);
  assert.equal(lock.schemaVersion, 1);
  mkdirSync(output, { recursive: true });
  async function asset(url, sha256, name) {
    assert.match(url, /^https:\/\/github\.com\/castlabs\/c2pa-(js|python)\/releases\/download\//);
    assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), sha256, `Published asset hash: ${name}`);
    writeFileSync(join(output, name), bytes, { flag: 'wx' });
    return bytes;
  }
  const provenance = JSON.parse(await asset(lock.browser.provenanceUrl, lock.browser.provenanceSha256, 'provenance.json'));
  assert.equal(provenance.identity.sourceSha, lock.browser.sourceSha);
  assert.equal(provenance.identity.sdkSha, lock.sdkSha);
  assert.equal(provenance.wasm.sha256, lock.browser.wasmSha256);
  for (const pkg of lock.browser.packages) await asset(pkg.url, pkg.sha256, pkg.file);
  const evidence = JSON.parse(await asset(lock.python.evidence.url, lock.python.evidence.sha256, 'python-wheel-evidence.json'));
  assert.equal(evidence.sources.c2paPython.commit, lock.python.sourceSha);
  assert.equal(evidence.sources.c2paRs.commit, lock.sdkSha);
  assert.equal(evidence.sources.c2paRs.version, lock.python.sdkVersion);
  assert.equal(evidence.artifact.version, lock.python.version);
  const wheel = evidence.artifact.members.find(member => member.file === lock.python.wheel.file);
  assert.ok(wheel, 'Pinned Linux wheel is missing from published evidence');
  assert.equal(wheel.sha256, lock.python.wheel.sha256);
  assert.equal(wheel.nativeSha256, lock.python.nativeSha256);
  assert.equal(wheel.target, 'x86_64-unknown-linux-gnu');
  await asset(lock.python.wheel.url, lock.python.wheel.sha256, lock.python.wheel.file);
  writeFileSync(join(output, 'qualification-inputs.json'), lockBytes, { flag: 'wx' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Usage: node tools/bmff-exclusion-inputs.mjs <lock-file> <output-dir>');
  await download(...process.argv.slice(2).map(path => resolve(path)));
}
