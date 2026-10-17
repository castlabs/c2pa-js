// The stable bundle's nine fragment-offset assertions, run through installed exports.
// Serialized into the consumer page. No repository SDK imports are permitted here.
export async function offsetCases(layout, createC2pa, Reader, Context, wasmSrc, onlyName) {
  const sdk = await createC2pa({ wasmSrc });
  const cases = [];
  const noTrust = { verify: { verifyTrust: false } };
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const blob = async file => {
    const response = await fetch(`/fixtures/${encodeURIComponent(file)}`);
    require(response.ok, `Fixture ${file}: HTTP ${response.status}`);
    return response.blob();
  };
  async function verify(init, segment, offset, defaults = false) {
    const reader = await Reader.fromBlobFragment(sdk, 'video/mp4', await blob(init), await blob(segment), defaults ? undefined : new Context(noTrust), offset === undefined ? undefined : { fragmentBaseOffset: offset });
    require(reader !== null, 'Expected a reader');
    try {
      const store = await reader.manifestStore();
      const active = store.validation_results?.activeManifest;
      return { state: store.validation_state, success: (active?.success ?? []).map(s => s.code), failure: (active?.failure ?? []).map(s => s.code) };
    } finally { await reader.free(); }
  }
  const bound = v => require(['Valid', 'Trusted'].includes(v.state) && v.success.includes('assertion.bmffHash.match') && !v.failure.includes('assertion.bmffHash.mismatch'), `Expected binding match: ${JSON.stringify(v)}`);
  const rejected = v => require(v.state === 'Invalid' && v.failure.includes('assertion.bmffHash.mismatch'), `Expected binding mismatch: ${JSON.stringify(v)}`);
  async function check(name, test) {
    if (onlyName && name !== onlyName) return;
    try { await test(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: String(error.stack ?? error) }); }
  }
  const solo = layout['solo-360p'];
  const high = layout['ladder-360p'];
  const low = layout['ladder-180p'];
  try {
    await check('valid-solo-segments', async () => {
      require(solo.segments.length > 1, 'Expected multiple signed segments');
      for (const seg of solo.segments) bound(await verify(solo.init, seg.file, seg.offset));
    });
    await check('missing-and-zero-offset', async () => {
      for (const offset of [undefined, 0]) rejected(await verify(solo.init, solo.segments[1].file, offset));
    });
    await check('wrong-offset', async () => {
      const seg = solo.segments[1];
      for (const offset of [seg.offset + 1, seg.offset - 1]) rejected(await verify(solo.init, seg.file, offset));
    });
    await check('sidx-cut', async () => rejected(await verify(solo.init, 'solo-360p.sidxcut01.m4s', solo.sidxCutOfSegment1.offset)));
    await check('without-settings', async () => {
      const seg = solo.segments[3];
      const right = await verify(solo.init, seg.file, seg.offset, true);
      require(right.state === 'Valid' && right.success.includes('assertion.bmffHash.match') && JSON.stringify(right.failure) === JSON.stringify(['signingCredential.untrusted']), `Unexpected defaults: ${JSON.stringify(right)}`);
      rejected(await verify(solo.init, seg.file, seg.offset + 1, true));
    });
    await check('invalid-offsets', async () => {
      for (const offset of [-1, 1.5, NaN, Infinity, 2 ** 53]) {
        let rangeError = false;
        try {
          const reader = await Reader.fromBlobFragment(sdk, 'video/mp4', await blob(solo.init), await blob(solo.segments[0].file), new Context(noTrust), { fragmentBaseOffset: offset });
          await reader?.free();
        } catch (error) { if (!(error instanceof RangeError)) throw error; rangeError = true; }
        require(rangeError, `Expected RangeError for ${String(offset)}`);
      }
    });
    await check('valid-ladder-segments', async () => {
      for (const rendition of [high, low]) for (const seg of rendition.segments) bound(await verify(rendition.init, seg.file, seg.offset));
    });
    await check('cross-rendition', async () => {
      rejected(await verify(high.init, low.segments[2].file, low.segments[2].offset));
      rejected(await verify(low.init, high.segments[2].file, high.segments[2].offset));
    });
    await check('ladder-missing-offset', async () => rejected(await verify(low.init, low.segments[0].file)));
    return cases;
  } finally { sdk.dispose(); }
}

export const offsetNames = ['valid-solo-segments', 'missing-and-zero-offset', 'wrong-offset', 'sidx-cut', 'without-settings', 'invalid-offsets', 'valid-ladder-segments', 'cross-rendition', 'ladder-missing-offset'];
