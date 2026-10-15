---
'@contentauth/c2pa-web': minor
'@contentauth/c2pa-wasm': minor
---

`Reader.fromBlobFragment` accepts an optional sixth argument, `{ fragmentBaseOffset }`, for a fragment cut out of a single-file fragmented MP4 (byte-range HLS). Such an asset's hard binding covers absolute box offsets, so a segment can only be verified when the reader knows where it sat in the file. See `FragmentOptions`. Fragments stored as their own files work as before.
