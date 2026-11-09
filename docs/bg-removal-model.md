# Background-removal model — licence note (Problem 2)

This note is the mandatory licence check required before shipping the ML
segmentation engine.

## Runtime

| Item | Licence | Source |
|---|---|---|
| `onnxruntime-web` (inference runtime) | MIT | https://github.com/microsoft/onnxruntime |
| Worker + mask code (`src/lib/bg-removal/ml-*.ts`) | This repository's licence | `src/lib/bg-removal/` |

`onnxruntime-web` is commercially usable and runs fully client-side: no keys,
no hosted service, no per-image fees. It runs in a Web Worker with WebGPU
when available, otherwise single-thread WASM (no SharedArrayBuffer, so no
cross-origin isolation headers are required).

## Models (lazy download, never committed to git)

| Size | Model | Licence | Source | Approx size |
|---|---|---|---|---|
| Small (fast) | U2Netp | MIT | https://github.com/NathanUA/U-2-Net | ~4 MB |
| Large (accurate) | ISNet general-use (DIS) | Apache-2.0 | https://github.com/xaveroam/isnet | ~170 MB |

- **Chosen:** U2Netp (small) by default for speed; ISNet general-use (large)
  offered as the accurate option when the size allows.
- **Download host:** Hugging Face (`https://huggingface.co/...`), which is a
  free CORS-enabled host (`Access-Control-Allow-Origin: *`). Models are
  fetched lazily on first use, cached in Cache Storage
  (`listbulkly-ml-v1`), and reused. No large files live in this repository.
- **Explicitly NOT used:** `@imgly/background-removal` (AGPL) and BRIA RMBG
  1.4 / 2.0 (non-commercial) are prohibited for this commercially licensed
  app and are not dependencies.

## Fallback

If the model cannot load (offline, no WebGPU/WASM, download blocked), the
hybrid pipeline falls back to the existing local engines (flood-key and
border-model) and says so in a short message. Images up to 40 MB are handled
by downscaling only the *model input*; the output mask is refined at the
ORIGINAL resolution.

## Owner override note

`AGENTS.md` previously recorded “deliberately no AI engine”. This ML engine
was added only on explicit owner direction (ListBulkly fixes, Problem 2).
The two local engines remain the fallback and are not removed.
