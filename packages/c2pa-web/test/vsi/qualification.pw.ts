/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { test, expect } from '@playwright/test';

for (const mode of ['normal', 'inline', 'external']) {
  for (const algorithm of ['ed25519', 'es256']) {
    test(`${mode} ${algorithm}: trusted admission, continuity, refresh and lifecycle`, async ({
      page
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const response = await page.goto(
        `/tools/vsi.html${mode === 'external' ? '?external=1' : ''}`
      );
      if (mode === 'external')
        expect(response?.headers()['content-security-policy']).toContain(
          "worker-src 'self'"
        );
      await page.waitForFunction(() => (window as any).ready);
      const result = await page.evaluate(
        async ({ mode, algorithm }) => {
          const w = window as any;
          const api = mode === 'inline' ? w.inlineApi : w.api;
          const raw = await (
            await fetch('/tmp/vsi-fixtures/context.json')
          ).json();
          function camel(value: any): any {
            if (Array.isArray(value)) return value.map(camel);
            if (value && typeof value === 'object')
              return Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
                  camel(v)
                ])
              );
            return value;
          }
          const settings = camel(raw);
          const bytes = await (
            await fetch('/packages/c2pa-wasm/pkg/c2pa_bg.wasm')
          ).arrayBuffer();
          const wasm = await WebAssembly.compile(bytes);
          const runtime = await api.createC2pa({
            wasmSrc: wasm,
            ...(mode === 'external'
              ? {
                  workerSrc: new URL(
                    '/packages/c2pa-web/dist/c2pa_worker.js',
                    location.href
                  )
                }
              : {})
          });
          const fixture = async (suffix: string) =>
            (await fetch(`/tmp/vsi-fixtures/${algorithm}-${suffix}`)).blob();
          const init = await fixture('original-init.mp4');
          const one = await fixture('original-1.m4s');
          const two = await fixture('original-2.m4s');
          const four = await fixture('original-4.m4s');
          const context = new w.api.Context(settings);
          const rejected: string[] = [];
          async function reject(name: string, data: Blob, ctx = context) {
            try {
              const handle = await api.LiveVideoValidator.fromInit(
                runtime,
                'video/mp4',
                data,
                ctx
              );
              await handle.free();
            } catch {
              rejected.push(name);
            }
          }
          await reject('untrusted', init, new w.api.Context());
          for (const setting of [
            'verifyAfterReading',
            'verifyTrust',
            'verifyTimestampTrust'
          ]) {
            await reject(
              setting,
              init,
              new w.api.Context({
                ...settings,
                verify: { ...settings.verify, [setting]: false }
              })
            );
          }
          const tamperedInit = new Uint8Array(await init.arrayBuffer());
          tamperedInit[tamperedInit.length - 1] ^= 1;
          await reject('tampered', new Blob([tamperedInit]));
          for (const bad of [
            'wrong-leaf',
            'mixed-keys',
            'empty-keys',
            'missing-keys',
            'malformed-keys',
            'prefix-keys',
            'duplicate-keys'
          ])
            await reject(bad, await fixture(`${bad}-init.mp4`));

          const handle = await api.LiveVideoValidator.fromInit(
            runtime,
            'video/mp4',
            init,
            context
          );
          // Changes after construction must not weaken the validator's policy snapshot.
          settings.verify.verifyTrust = false;
          const first = await handle.validateSegment(one);
          const replay = await handle.validateSegment(one);
          const replayId = await handle.validateSegment(
            await fixture('replay-id.m4s')
          );
          const wrongTime = await handle.validateSegment(
            await fixture('wrong-time.m4s')
          );
          const wrongTrack = await handle.validateSegment(
            await fixture('wrong-track.m4s')
          );
          const corrupt = new Uint8Array(await two.arrayBuffer());
          corrupt[corrupt.length - 1] ^= 1;
          const tampered = await handle.validateSegment(new Blob([corrupt]));
          const second = await handle.validateSegment(two);
          const gap = await handle.validateSegment(four);
          const coverage = await handle.sequenceCoverage();
          const invalidRefresh = await handle.updateInit(
            'video/mp4',
            new Blob([tamperedInit])
          );
          const refreshPreservedReplay = await handle.validateSegment(four);
          const reset = await handle.resetContinuity();
          const afterReset = await handle.validateSegment(one);
          const refresh = await handle.updateInit(
            'video/mp4',
            await fixture('refresh-init.mp4')
          );
          const refreshPreservedSequence = await handle.validateSegment(
            await fixture('refresh-1.m4s')
          );
          const oldEpoch = await handle.validateSegment(two);
          const nextEpoch = await handle.validateSegment(
            await fixture('refresh-2.m4s')
          );
          const regression = await handle.validateSegment(
            await fixture('refresh-1.m4s')
          );
          const queued = handle.validateSegment(await fixture('refresh-4.m4s'));
          const free = handle.free();
          const duplicateFree = handle.free() === free;
          const drained = await queued;
          await free;
          let stale = false;
          try {
            await handle.sequenceCoverage();
          } catch {
            stale = true;
          }
          runtime.dispose();
          let disposed = false;
          try {
            await api.LiveVideoValidator.fromInit(
              runtime,
              'video/mp4',
              init,
              context
            );
          } catch {
            disposed = true;
          }
          return {
            rejected,
            first,
            replay,
            replayId,
            wrongTime,
            wrongTrack,
            tampered,
            second,
            gap,
            coverage,
            invalidRefresh,
            refreshPreservedReplay,
            reset,
            afterReset,
            refresh,
            refreshPreservedSequence,
            oldEpoch,
            nextEpoch,
            regression,
            drained,
            duplicateFree,
            stale,
            disposed
          };
        },
        { mode, algorithm }
      );
      expect(result.rejected.sort()).toEqual(
        [
          'untrusted',
          'verifyAfterReading',
          'verifyTrust',
          'verifyTimestampTrust',
          'tampered',
          'wrong-leaf',
          'mixed-keys',
          'empty-keys',
          'missing-keys',
          'malformed-keys',
          'prefix-keys',
          'duplicate-keys'
        ].sort()
      );
      for (const key of [
        'first',
        'second',
        'gap',
        'reset',
        'afterReset',
        'refresh',
        'nextEpoch',
        'drained'
      ] as const)
        expect(result[key].valid, key).toBe(true);
      for (const key of [
        'replay',
        'replayId',
        'wrongTime',
        'wrongTrack',
        'tampered',
        'invalidRefresh',
        'refreshPreservedReplay',
        'refreshPreservedSequence',
        'oldEpoch',
        'regression'
      ] as const)
        expect(result[key].valid, key).toBe(false);
      expect(result.second.hadFailures).toBe(true);
      expect(
        result.second.statuses.every((s: any) => s.kind !== 'failure')
      ).toBe(true);
      expect(
        result.gap.statuses.some(
          (s: any) =>
            s.code === 'com.castlabs.livevideo.segment.gap' &&
            s.kind === 'informational'
        )
      ).toBe(true);
      expect(result.coverage).toEqual({
        missingRanges: [['3', '3']],
        totalMissing: '1',
        rangesTruncated: false
      });
      expect(result.reset.sequenceCoverage).toEqual(result.coverage);
      expect(result.duplicateFree && result.stale && result.disposed).toBe(
        true
      );
      expect(errors).toEqual([]);
    });
  }
}

for (const algorithm of ['ed25519', 'es256']) {
  test(`byte-only WASM core ${algorithm}`, async ({ page }) => {
    await page.goto('/tools/vsi.html');
    await page.waitForFunction(() => (window as any).ready);
    const results = await page.evaluate(async (algorithm) => {
      const w = window as any;
      const load = async (suffix: string) =>
        new Uint8Array(
          await (
            await fetch(`/tmp/vsi-fixtures/${algorithm}-${suffix}`)
          ).arrayBuffer()
        );
      await w.initWasm({
        module_or_path: await WebAssembly.compile(
          await (
            await fetch('/packages/c2pa-wasm/pkg/c2pa_bg.wasm')
          ).arrayBuffer()
        )
      });
      const json = await (await fetch('/tmp/vsi-fixtures/context.json')).text();
      const validator = await w.wasmApi.WasmLiveVideoValidator.fromInitBytes(
        'video/mp4',
        await load('original-init.mp4'),
        json
      );
      const late = await w.wasmApi.WasmLiveVideoValidator.fromInitBytes(
        'video/mp4',
        await load('original-init.mp4'),
        json
      );
      try {
        return [
          validator.validateSegmentBytes(await load('original-1.m4s')),
          validator.validateSegmentBytes(await load('original-4.m4s')),
          late.validateSegmentBytes(await load('original-4.m4s'))
        ];
      } finally {
        validator.free();
        late.free();
      }
    }, algorithm);
    expect(results.every((r: any) => r.valid)).toBe(true);
    expect(results[1].sequenceCoverage).toEqual({
      missingRanges: [['2', '3']],
      totalMissing: '2',
      rangesTruncated: false
    });
    expect(
      results[2].statuses.some(
        (s: any) =>
          s.code === 'com.castlabs.livevideo.segment.leadingGap' &&
          s.kind === 'informational'
      )
    ).toBe(true);
  });
}
