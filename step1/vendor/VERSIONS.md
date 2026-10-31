# vendor/ provenance

Fetched 2026-10-31 by `fetch_vendor.sh` (dev tool only; the app never fetches off-origin).

| File | Package / source | Version | Upstream URL | sha256 (as vendored) |
|---|---|---|---|---|
| `tasks-vision/vision_bundle.mjs` | npm `@mediapipe/tasks-vision` (Apache-2.0) | 1.2.0 | https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs | `8fe377c4dc1f99a7aee4014d038bf3437e9da52b6247f7db9d63ab78599a74b9` **(patched, see below)** |
| `tasks-vision/wasm/vision_wasm_internal.js` | same | 1.2.0 | …@1.2.0/wasm/vision_wasm_internal.js | `85c1a342be70427987f900969a5f26e17557351111364e6585e97fb03e93e108` |
| `tasks-vision/wasm/vision_wasm_internal.wasm` | same | 1.2.0 | …@1.2.0/wasm/vision_wasm_internal.wasm | `bcc13df22d3d69ec8cbe8e280989356d844ae00f4523eb82072d2484f44134dc` |
| `tasks-vision/wasm/vision_wasm_nosimd_internal.js` | same | 1.2.0 | …@1.2.0/wasm/vision_wasm_nosimd_internal.js | `e9b2b799e0f1078f5538b300a57835b823742c37e2646308a03f0f25b39fdcdc` |
| `tasks-vision/wasm/vision_wasm_nosimd_internal.wasm` | same | 1.2.0 | …@1.2.0/wasm/vision_wasm_nosimd_internal.wasm | `ed5e5e5812490bd90d6a440290845ff9e4c516f696847a28a0c0e0573470d469` |
| `hand_landmarker.task` | MediaPipe Hand Landmarker model, float16 v1 | float16/1 (GCS generation 1682480004222387) | https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `pose_landmarker_lite.task` | MediaPipe Pose Landmarker **lite** model, float16 v1 (Apache-2.0) | float16/1 (GCS generation 1682624736756847) | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` (5,777,746 bytes, added 2026-10-31 for body tracking) |

Upstream (unpatched) `vision_bundle.mjs` sha256: `870da5cfc43bfcf2a8b0f14e8152dae8c7e701722e1191b0e592b94b81b4127a`.

## Telemetry patch (`patch_telemetry.py`)

Upstream tasks-vision ships a usage logger: it buffers per-task stats and every 60 s POSTs
protobuf to `https://odml.pa.googleapis.com/v1/log` with an API key read from the wasm
(`_mediapipeLoggerGetEncodedApiKey`). That is egress through no approved door. Three layers stop it:

1. **Patch** (`patch_telemetry.py`, idempotent, fails loudly if the upstream shape changes):
   the logger's `send()` returns immediately, and its 60 s `setInterval` flush timer is never started.
2. **CSP** in `index.html`: `default-src 'self'; connect-src 'self'` — even an unpatched bundle is blocked.
3. **No CDN fallback** in the app: bundle, wasm and both models load only from `./vendor/`.

The URL string itself remains inside the bundle (dead code); the grep in README §Egress lists it.

Evidence: `verify/egress-log.json` (patched build, ≥90 s of real hands + pose detection — 95 s soak, ~1800 hand + 1000 pose inferences — 0 non-local requests) and
`verify/egress-control.json` (positive control: the UNPATCHED bundle's POST is observed when CSP is
stripped and aborted in-browser, and is blocked by the shipped CSP).

Only the SIMD wasm is used by modern Chrome/Edge; the `nosimd` pair is kept for older CPUs/browsers.
