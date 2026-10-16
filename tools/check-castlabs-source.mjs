import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean);
const manifests = new Map();
const packages = new Map();

for (const file of files.filter((file) => /(^|\/)package\.json$/.test(file))) {
  const manifest = JSON.parse(
    readFileSync(new URL(file, `file://${root}`), 'utf8')
  );
  const directory = dirname(file);
  manifests.set(directory, manifest);
  assert(!packages.has(manifest.name), `Duplicate package: ${manifest.name}`);
  packages.set(manifest.name, directory);
  if (directory.startsWith('packages/')) {
    assert.equal(manifest.name, `@stardustproof/${posix.basename(directory)}`);
  }
}

assert.equal(manifests.get('.').private, true);
assert.equal(manifests.get('packages/c2pa-node').private, true);
for (const name of ['web', 'wasm', 'types', 'utilities']) {
  assert.notEqual(manifests.get(`packages/c2pa-${name}`).private, true);
}

const lock = readFileSync(
  new URL('../pnpm-lock.yaml', import.meta.url),
  'utf8'
);
for (const [directory, manifest] of manifests) {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies
  };
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (!specifier.startsWith('workspace:')) continue;
    assert(packages.has(name), `Unknown workspace dependency: ${name}`);
    const importer = lock.match(
      new RegExp(`^  ${directory}:\\n([\\s\\S]*?)(?=^  \\S|^\\S)`, 'm')
    )?.[1];
    const relative = posix.relative(directory, packages.get(name));
    const link = relative.startsWith('.') ? relative : `./${relative}`;
    assert(
      importer?.includes(
        `      '${name}':\n        specifier: ${specifier}\n        version: link:${link}\n`
      ),
      `Missing or stale lockfile workspace link: ${directory} -> ${name}`
    );
  }
}

for (const file of files) {
  if (!/\.(?:ts|mjs|cjs|json|ya?ml|toml|md)$/.test(file)) continue;
  if (posix.basename(file) === 'CHANGELOG.md') continue;
  const text = readFileSync(new URL(file, `file://${root}`), 'utf8');
  assert(!/@contentauth\//.test(text), `Old product namespace in ${file}`);
  if (!/\.(?:ts|mjs|cjs)$/.test(file)) continue;
  for (const match of text.matchAll(
    /(?:from\s+|import\s*)['"](@stardustproof\/[^'"]+)/g
  )) {
    const name = match[1].split('/').slice(0, 2).join('/');
    assert(packages.has(name), `Unknown product import in ${file}: ${name}`);
    const directory = [...manifests.keys()]
      .filter((directory) => file.startsWith(`${directory}/`))
      .sort((a, b) => b.length - a.length)[0];
    const manifest = manifests.get(directory);
    assert(manifest, `No package for ${file}`);
    assert(
      manifest.name === name ||
        name in (manifest.dependencies ?? {}) ||
        name in (manifest.devDependencies ?? {}) ||
        name in (manifest.peerDependencies ?? {}),
      `Undeclared product import in ${file}: ${name}`
    );
  }
}

console.log(
  'Castlabs package namespaces, imports and workspace lock links passed.'
);
