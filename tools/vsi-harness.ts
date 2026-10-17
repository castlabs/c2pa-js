/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import * as api from '../packages/c2pa-web/dist/index.js';
import initWasm, * as wasmApi from '../packages/c2pa-wasm/pkg/c2pa.js';

const inlineApi =
  new URLSearchParams(location.search).get('mode') === 'inline'
    ? await import('../packages/c2pa-web/dist/inline.js')
    : undefined;

Object.assign(window, { api, inlineApi, wasmApi, initWasm, ready: true });
