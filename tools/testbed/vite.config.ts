/**
 * Copyright 2025 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/tools/testbed',
  server: {
    port: 4200,
    host: '127.0.0.1'
  },
  preview: {
    port: 4300,
    host: '127.0.0.1'
  },
  plugins: [mkcert()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true
    }
  }
}));
