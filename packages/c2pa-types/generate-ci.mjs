/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

// CI runs `cargo run --locked -p c2pa-types` first. Do not invoke an unlocked build.
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { compileFromFile } from 'json-schema-to-typescript';

await mkdir('types', { recursive: true });
for (const name of await readdir('schemas')) {
  const result = await compileFromFile(`schemas/${name}`);
  await writeFile(`types/${name.replace(/\.json$/, '.ts')}`, result);
}
