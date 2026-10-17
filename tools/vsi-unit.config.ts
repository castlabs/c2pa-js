/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/c2pa-web/src/lib/worker/liveValidatorMap.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false
  }
});
