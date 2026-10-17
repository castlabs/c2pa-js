/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

// Called only after the locked CI Cargo build and wasm-bindgen generation.
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const base = 'packages/c2pa-wasm/pkg/c2pa';
const js = await readFile(`${base}.js`, 'utf8');
const dts = await readFile(`${base}.d.ts`, 'utf8');
for (const name of [
  'WasmLiveVideoValidator',
  'fromInitBytes',
  'fromInitBlob',
  'validateSegmentBytes',
  'validateSegmentBlob',
  'updateInitBytes',
  'updateInitBlob',
  'resetContinuity',
  'sequenceCoverage'
]) {
  if (!js.includes(name) || !dts.includes(name))
    throw new Error(`Missing generated export ${name}`);
}
const sri = `sha256-${createHash('sha256')
  .update(await readFile(`${base}_bg.wasm`))
  .digest('base64')}`;
await appendFile(
  `${base}.js`,
  `\nexport const WASM_SRI = ${JSON.stringify(sri)};\n`
);
await appendFile(`${base}.d.ts`, '\nexport declare const WASM_SRI: string;\n');
console.log('Verified generated VSI bindings and added WASM integrity');
