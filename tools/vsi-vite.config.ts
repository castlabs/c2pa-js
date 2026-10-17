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
  plugins: [
    {
      name: 'vsi-strict-csp',
      configureServer(server) {
        const ocsp = readFileSync('tmp/vsi-fixtures/gate-ocsp.der');
        const held = new Set<() => void>();
        let armed = false;
        let arrivals = 0;
        server.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? '/', 'https://127.0.0.1:4173').pathname;
          if (path.startsWith('/__vsi_gate/ocsp/')) {
            arrivals++;
            const finish = () => {
              held.delete(finish);
              if (!res.destroyed) {
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Content-Type', 'application/ocsp-response');
                res.end(ocsp);
              }
            };
            if (armed) {
              held.add(finish);
              res.once('close', () => held.delete(finish));
            } else finish();
            return;
          }
          if (['/__vsi_gate/arm', '/__vsi_gate/state', '/__vsi_gate/release'].includes(path)) {
            if (path !== '/__vsi_gate/state' && req.method !== 'POST') {
              res.statusCode = 405;
              res.end();
              return;
            }
            if (path === '/__vsi_gate/arm') {
              if (held.size) {
                res.statusCode = 409;
                res.end('Previous OCSP request has not drained');
                return;
              }
              armed = true;
              arrivals = 0;
            } else if (path === '/__vsi_gate/release') {
              armed = false;
              for (const finish of [...held]) finish();
            }
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ armed, arrivals, held: held.size }));
            return;
          }
          if (req.url?.includes('external=1')) {
            res.setHeader(
              'Content-Security-Policy',
              "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'"
            );
          }
          next();
        });
      }
    }
  ]
});
