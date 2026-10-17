/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

export default defineConfig({
  root: process.cwd(),
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    https: {
      key: readFileSync('tmp/vsi-server.key'),
      cert: readFileSync('tmp/vsi-server.crt')
    },
    fs: { allow: [process.cwd()] }
  },
  plugins: [{
    name: 'vsi-strict-csp',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.includes('external=1')) {
          res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'");
        }
        next();
      });
    }
  }]
});
