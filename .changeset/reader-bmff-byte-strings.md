---
'@stardustproof/c2pa-web': minor
'@stardustproof/c2pa-wasm': minor
---

The underlying Rust SDK update also affects manifest JSON returned by the web and Node readers: CBOR byte-string values in BMFF assertion data, including `initHash` and exclusion-match bytes, are represented as `b64'...'` strings instead of numeric arrays. Consumers interpreting those fields must handle the new representation.
