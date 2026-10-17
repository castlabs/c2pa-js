# VSI Browser Security Assessment

This assessment applies only to the Castlabs VSI source line based on
`0ccca75c68f3d50dcdbfe081b8d752d4edb63d65`. Stable browser qualification
does not qualify these sources or their future packaged artifacts.

## Selected Hardening

- Raise Vite's declared floor to `^6.4.3` (locked to 6.4.4) and the root
  Vitest, coverage and UI floors plus the web Vitest/browser and utilities
  Vitest floors to `^3.2.7`.
- Raise the build executor's tar floor to `^7.5.21` (locked to 7.5.22).
- Retain utilities' existing `ts-deepmerge` 8.0.0. Regressions exercise nine
  unsafe object-valued keys at root and nested levels through
  `withDefaultSettings` and `resolveSettings`, inspect actual merged object
  prototypes, and preserve ordinary verification, thumbnail and trust settings.
- Bind the web Vite server, Vitest browser API, and testbed dev/preview servers
  to `127.0.0.1`. Do not enable the separate, default-disabled Vitest main API.

The SDK remains pinned to `afd6fffe`; Cargo inputs, package versions and VSI API
exports are unchanged. The VSI lock already contains lopdf 0.45 and quick-xml
0.41; stable-line parser changes are not imported here.
The retained private Node package's separate development-tool versions are not
upgraded by this browser-only change.

## Verification And Limits

The existing pull-request CI route runs on PRs targeting `feat/live-video-vsi`.
Its dedicated Node job checks Castlabs source consistency and runs utilities
tests directly, without Nx build dependencies or native compilation. The
existing main CI job retains Rust/WASM builds and browser tests in Chromium,
Firefox and WebKit. This is a source-check route, not a publishing workflow.

Local work is limited to lockfile-only resolution with scripts disabled and
lightweight source/static checks or focused Node tests when dependencies are
already available. No local Rust builds/checks/tests or browser qualification
are part of this change. Hosted CI results must be evaluated for this PR's head;
this document does not assert a green run, complete vulnerability clearance,
packaged browser qualification or readiness to publish the VSI SDK. The separate
VSI API implementation and its player/packaged-browser qualification remain
release gates.
