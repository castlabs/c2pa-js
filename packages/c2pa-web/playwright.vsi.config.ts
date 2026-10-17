/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/vsi',
  testMatch: '**/*.pw.ts',
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'https://127.0.0.1:4173', ignoreHTTPSErrors: true },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } }
  ],
  reporter: [['list'], ['html', { outputFolder: '../../tmp/vsi-playwright-report', open: 'never' }]]
});
