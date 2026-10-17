/**
 * Copyright 2026 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 */

import { Context, validateAssetSize } from '@stardustproof/c2pa-utilities';
import type { C2pa } from './c2pa.js';
import type { WorkerManager } from './worker/workerManager.js';
import { MAX_SIZE_IN_BYTES } from './reader.js';

/** Report-only observation gaps. Decimal strings preserve u64/u128 precision. */
export interface SequenceCoverage {
  missingRanges: [string, string][];
  totalMissing: string;
  rangesTruncated: boolean;
}

/** A per-call SDK diagnostic, not a cumulative event log. */
export interface LiveVideoStatus {
  kind: 'success' | 'informational' | 'failure';
  code: string;
  label: string;
  description: string;
  error?: string;
  ingredientUri?: string;
  trustListUri?: string;
}

/** Validity is per call; hadFailures remains true after any failed operation. */
export interface LiveVideoResult {
  valid: boolean;
  statuses: LiveVideoStatus[];
  error?: string;
  sequenceCoverage: SequenceCoverage;
  hadFailures: boolean;
}

/**
 * Stateful section 19.4 VSI validation for one logical stream and rendition.
 * Refresh requires the same logical stream and equivalent codec/sample entries;
 * equal native track IDs alone do not establish that relationship.
 * Explicitly free on teardown. Worker disposal aborts all pending operations.
 */
export class LiveVideoValidator {
  #free?: Promise<void>;

  private constructor(private worker: WorkerManager, private id: number) {}

  /** Admit only a fully verified, trusted signed init using a Context snapshot. */
  static async fromInit(
    c2pa: C2pa,
    format: string,
    init: Blob,
    context: Context = new Context()
  ): Promise<LiveVideoValidator> {
    validateAssetSize(init.size, MAX_SIZE_IN_BYTES);
    const contextJson = await context.toJson();
    const id = await c2pa.worker.tx.live_fromInit(format, init, contextJson);
    return new LiveVideoValidator(c2pa.worker, id);
  }

  /** Validate media in invocation order. Invalid media never resets continuity. */
  async validateSegment(segment: Blob): Promise<LiveVideoResult> {
    if (this.#free) return Promise.reject(new Error('Live validator is freed'));
    validateAssetSize(segment.size, MAX_SIZE_IN_BYTES);
    return this.worker.tx.live_validateSegment(this.id, segment);
  }

  /** Reverify and atomically replace init/keys, retaining sequence/replay history. */
  async updateInit(format: string, init: Blob): Promise<LiveVideoResult> {
    if (this.#free) return Promise.reject(new Error('Live validator is freed'));
    validateAssetSize(init.size, MAX_SIZE_IN_BYTES);
    return this.worker.tx.live_updateInit(this.id, format, init);
  }

  /** Only trusted playback control (seek/live join) may request this reset. */
  resetContinuity(): Promise<LiveVideoResult> {
    if (this.#free) return Promise.reject(new Error('Live validator is freed'));
    return this.worker.tx.live_resetContinuity(this.id);
  }

  /** Return accumulated, report-only coverage, not proof of complete production. */
  sequenceCoverage(): Promise<SequenceCoverage> {
    if (this.#free) return Promise.reject(new Error('Live validator is freed'));
    return this.worker.tx.live_sequenceCoverage(this.id);
  }

  /** Drain already admitted operations, then release WASM state. Idempotent. */
  free(): Promise<void> {
    return (this.#free ??= this.worker.tx.live_free(this.id));
  }
}
