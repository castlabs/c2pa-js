/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) =>
    console.error(`[pageerror] ${error.message}`)
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.error(`[browser] ${message.text()}`);
  });
  page.on('requestfailed', (request) =>
    console.error(`[network] ${request.url()}: ${request.failure()?.errorText}`)
  );
});

for (const mode of ['normal', 'inline', 'external']) {
  for (const algorithm of ['ed25519', 'es256']) {
    test(`${mode} ${algorithm}: trusted admission, continuity, refresh and lifecycle`, async ({
      page
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const response = await page.goto(
        `/tools/vsi.html?mode=${mode}${
          mode === 'external' ? '&external=1' : ''
        }`
      );
      if (mode === 'external')
        expect(response?.headers()['content-security-policy']).toContain(
          "worker-src 'self'"
        );
      await page.waitForFunction(() => (window as any).ready, undefined, {
        timeout: 60_000
      });
      const result = await page.evaluate(
        async ({ mode, algorithm }) => {
          const w = window as any;
          const api = mode === 'inline' ? w.inlineApi : w.api;
          const raw = await (
            await fetch('/tmp/vsi-fixtures/context.json')
          ).json();
          // Context takes public web Settings, not the native trust.anchors wire shape.
          const settings = {
            trust: {
              trustAnchors: new URL(
                '/tmp/vsi-fixtures/manifest-roots.txt',
                location.href
              ).href,
              trustConfig: raw.trust.trust_config
            },
            verify: {
              verifyAfterReading: true,
              verifyTrust: true,
              verifyTimestampTrust: true
            }
          };
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
          const rejectionErrors: Record<string, string> = {};
          async function reject(name: string, data: Blob, ctx = context) {
            try {
              const handle = await api.LiveVideoValidator.fromInit(
                runtime,
                'video/mp4',
                data,
                ctx
              );
              await handle.free();
            } catch (error) {
              rejected.push(name);
              rejectionErrors[name] = error instanceof Error ? error.message : String(error);
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
          await reject('strictV1', init, new w.api.Context({
            ...settings,
            verify: { ...settings.verify, strictV1Validation: true }
          }));
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

          // Prove the first key in the mixed-key rejection fixture is valid by itself.
          const probe = await api.LiveVideoValidator.fromInit(
            runtime,
            'video/mp4',
            await fixture('good-keys-init.mp4'),
            context
          );
          await probe.free();
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
          const rejectedKeysRefresh = await handle.updateInit(
            'video/mp4',
            await fixture('mixed-keys-init.mp4')
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
          const replacement = await fixture('refresh-init.mp4');
          const replayAcrossRefresh = await fixture('refresh-2-replay-id.m4s');
          const freshEpoch = await api.LiveVideoValidator.fromInit(runtime, 'video/mp4', replacement, context);
          const freshReplayControl = await freshEpoch.validateSegment(replayAcrossRefresh);
          await freshEpoch.free();
          const refresh = await handle.updateInit('video/mp4', replacement);
          const refreshedReplay = await handle.validateSegment(replayAcrossRefresh);
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
            rejectionErrors,
            first,
            replay,
            replayId,
            wrongTime,
            wrongTrack,
            rejectedKeysRefresh,
            tampered,
            second,
            gap,
            coverage,
            invalidRefresh,
            refreshPreservedReplay,
            reset,
            afterReset,
            refresh,
            freshReplayControl,
            refreshedReplay,
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
          'strictV1',
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
      for (const [setting, path] of [
        ['verifyAfterReading', 'verify_after_reading'],
        ['verifyTrust', 'verify_trust'],
        ['verifyTimestampTrust', 'verify_timestamp_trust']
      ]) {
        expect(result.rejectionErrors[setting]).toBe(`live validation requires verify.${path}=true`);
      }
      expect(result.rejectionErrors.strictV1).toBe('live validation requires detailed validation results (strict_v1_validation=false)');
      for (const key of [
        'first',
        'second',
        'gap',
        'reset',
        'afterReset',
        'refresh',
        'freshReplayControl',
        'nextEpoch',
        'drained'
      ] as const)
        expect(
          result[key].valid,
          `${key}: ${JSON.stringify(result[key])}`
        ).toBe(true);
      for (const key of [
        'replay',
        'replayId',
        'wrongTime',
        'wrongTrack',
        'rejectedKeysRefresh',
        'tampered',
        'invalidRefresh',
        'refreshPreservedReplay',
        'refreshPreservedSequence',
        'refreshedReplay',
        'oldEpoch',
        'regression'
      ] as const)
        expect(result[key].valid, key).toBe(false);
      expect(result.second.hadFailures).toBe(true);
      expect(result.refreshedReplay.statuses.some((status: any) =>
        status.kind === 'failure' && status.code === 'livevideo.segment.invalid' &&
        status.description.includes('emsg id must be unique')
      )).toBe(true);
      expect(
        result.rejectedKeysRefresh.statuses.some(
          (s: any) => s.kind === 'failure'
        )
      ).toBe(true);
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
    await page.waitForFunction(() => (window as any).ready, undefined, {
      timeout: 60_000
    });
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
    expect(
      results.every((r: any) => r.valid),
      JSON.stringify(results)
    ).toBe(true);
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

for (const mode of ['normal', 'external']) {
  for (const algorithm of ['ed25519', 'es256']) {
    test(`${mode} ${algorithm}: real Reader await queues, drains and aborts`, async ({ page }) => {
      await page.goto(`/tools/vsi.html?mode=${mode}${mode === 'external' ? '&external=1' : ''}`);
      await page.waitForFunction(() => (window as any).ready, undefined, { timeout: 60_000 });
      const control = (action: string) => page.evaluate(async action => {
        const response = await fetch(`/__vsi_gate/${action}`, { method: action === 'state' ? 'GET' : 'POST' });
        if (!response.ok) throw new Error(`Gate ${action}: ${response.status}`);
        return response.json();
      }, action);
      try {
        await control('release');
        const setup = await page.evaluate(async ({ mode, algorithm }) => {
          const w = window as any;
          const raw = await (await fetch('/tmp/vsi-fixtures/context.json')).json();
          const roots = await (await fetch('/tmp/vsi-fixtures/gate-roots.txt')).text();
          const context = new w.api.Context({
            trust: { trustAnchors: roots, trustConfig: raw.trust.trust_config },
            verify: { verifyAfterReading: true, verifyTrust: true, verifyTimestampTrust: true, ocspFetch: true }
          });
          const resolved = JSON.parse(await context.toJson());
          resolved.core = { allowed_network_hosts: ['127.0.0.1:4173'] };
          const contextJson = JSON.stringify(resolved);
          const wasm = await WebAssembly.compile(await (await fetch('/packages/c2pa-wasm/pkg/c2pa_bg.wasm')).arrayBuffer());
          const create = () => w.api.createC2pa({ wasmSrc: wasm, ...(mode === 'external' ? {
            workerSrc: new URL('/packages/c2pa-web/dist/c2pa_worker.js', location.href)
          } : {}) });
          const load = async (suffix: string) => (await fetch(`/tmp/vsi-fixtures/${algorithm}-gate-${suffix}`)).blob();
          const [init, refresh, one, four, two] = await Promise.all([
            load('original-init.mp4'), load('refresh-init.mp4'), load('original-1.m4s'),
            load('original-4.m4s'), load('refresh-2.m4s')
          ]);
          const runtime = await create();
          const tx = runtime.worker.tx;
          const reader = await tx.reader_fromBlob('video/mp4', init, contextJson);
          const store = await tx.reader_manifestStore(reader);
          await tx.reader_free(reader);
          const codes = store.validation_results.activeManifest.success.map((status: any) => status.code);
          if (store.validation_state !== 'Trusted' || !codes.includes('signingCredential.ocsp.notRevoked')) {
            throw new Error(`Gate Reader did not verify the OCSP fixture: ${JSON.stringify(store.validation_results)}`);
          }
          const id = await tx.live_fromInit('video/mp4', init, contextJson);
          const first = await tx.live_validateSegment(id, one);
          const gap = await tx.live_validateSegment(id, four);
          w.gated = { runtime, create, contextJson, init, refresh, one, four, two, id, events: [] };
          return { first, gap, state: store.validation_state, codes };
        }, { mode, algorithm });
        expect(setup.state).toBe('Trusted');
        expect(setup.codes).toContain('signingCredential.ocsp.notRevoked');
        expect(setup.first.valid && setup.gap.valid).toBe(true);

        await control('arm');
        await page.evaluate(() => {
          const g = (window as any).gated;
          const tx = g.runtime.worker.tx;
          g.observe = (name: string, pending: Promise<any>) => pending.then(value => {
            g.events.push(name);
            return { name, value };
          }, error => {
            g.events.push(name);
            return { name, error: String(error.message ?? error) };
          });
          g.refreshPending = g.observe('refresh', tx.live_updateInit(g.id, 'video/mp4', g.refresh));
        });
        await expect.poll(async () => (await control('state')).held).toBeGreaterThan(0);
        await page.evaluate(() => {
          const g = (window as any).gated;
          const tx = g.runtime.worker.tx;
          g.pending = Promise.all([
            g.refreshPending,
            g.observe('coverage', tx.live_sequenceCoverage(g.id)),
            g.observe('reset', tx.live_resetContinuity(g.id)),
            g.observe('validation', tx.live_validateSegment(g.id, g.two)),
            g.observe('free', tx.live_free(g.id))
          ]);
          // This response is a receipt barrier: all earlier RPCs, including
          // closing free, reached the worker while the real Reader awaits OCSP.
          g.closed = tx.live_sequenceCoverage(g.id).then(() => 'unexpected success',
            (error: Error) => error.message);
        });
        expect(await page.evaluate(() => (window as any).gated.closed)).toContain('closing live validator');
        expect(await page.evaluate(() => (window as any).gated.events)).toEqual([]);
        await control('release');
        const drained = await page.evaluate(async () => {
          const g = (window as any).gated;
          const outcomes = await g.pending;
          await g.runtime.worker.tx.live_free(g.id);
          const stale = await g.runtime.worker.tx.live_sequenceCoverage(g.id).then(() => 'unexpected success',
            (error: Error) => error.message);
          g.runtime.dispose();
          return { outcomes, events: g.events, stale };
        });
        expect(drained.events).toEqual(['refresh', 'coverage', 'reset', 'validation', 'free']);
        expect(drained.outcomes.every((outcome: any) => outcome.error === undefined), JSON.stringify(drained)).toBe(true);
        for (const index of [0, 2, 3]) expect(drained.outcomes[index].value.valid).toBe(true);
        const coverage = { missingRanges: [['2', '3']], totalMissing: '2', rangesTruncated: false };
        expect(drained.outcomes[1].value).toEqual(coverage);
        expect(drained.outcomes[2].value.sequenceCoverage).toEqual(coverage);
        expect(drained.outcomes[3].value.sequenceCoverage).toEqual(coverage);
        expect(drained.stale).toContain('Unknown or closing live validator');

        // Dispose while an actual WASM admission is held inside Reader, not
        // while the JS Context is still resolving trust-anchor URLs.
        await page.evaluate(async () => {
          const g = (window as any).gated;
          g.runtime = await g.create();
          g.events = [];
        });
        await control('arm');
        await page.evaluate(() => {
          const g = (window as any).gated;
          g.admission = g.runtime.worker.tx.live_fromInit('video/mp4', g.init, g.contextJson)
            .then(() => 'unexpected success', (error: Error) => error.message);
        });
        await expect.poll(async () => (await control('state')).held).toBeGreaterThan(0);
        expect(await page.evaluate(async () => {
          const g = (window as any).gated;
          g.runtime.dispose();
          return g.admission;
        })).toBe('C2pa worker disposed');
        await control('release');

        await page.evaluate(async () => {
          const g = (window as any).gated;
          g.runtime = await g.create();
          g.id = await g.runtime.worker.tx.live_fromInit('video/mp4', g.init, g.contextJson);
        });
        await control('arm');
        await page.evaluate(() => {
          const g = (window as any).gated;
          const tx = g.runtime.worker.tx;
          g.refreshPending = tx.live_updateInit(g.id, 'video/mp4', g.refresh)
            .then(() => 'unexpected success', (error: Error) => error.message);
        });
        await expect.poll(async () => (await control('state')).held).toBeGreaterThan(0);
        await page.evaluate(() => {
          const g = (window as any).gated;
          const tx = g.runtime.worker.tx;
          const error = (reason: Error) => reason.message;
          g.aborted = Promise.all([
            g.refreshPending,
            tx.live_sequenceCoverage(g.id).then(() => 'unexpected success', error),
            tx.live_free(g.id).then(() => 'unexpected success', error)
          ]);
          g.closed = tx.live_sequenceCoverage(g.id).then(() => 'unexpected success', error);
        });
        expect(await page.evaluate(() => (window as any).gated.closed)).toContain('closing live validator');
        expect(await page.evaluate(async () => {
          const g = (window as any).gated;
          g.runtime.dispose();
          return g.aborted;
        })).toEqual(['C2pa worker disposed', 'C2pa worker disposed', 'C2pa worker disposed']);
      } finally {
        await control('release');
        await page.evaluate(() => (window as any).gated?.runtime.dispose());
      }
    });
  }
}
