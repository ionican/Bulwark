# Generated gun turret models (W18 look test B)

Input for every model: `look/reference/02-gun-turret.png` (910 × 512, three-quarter view). No other input images. Generated on the DGX Spark `gx10-1c6e` (NVIDIA GB10, compute capability 12.1, 128 GB unified memory, Ubuntu 24.04 aarch64, driver 580.173.02) inside a container from `nvcr.io/nvidia/vllm:26.05-py3` (PyTorch 2.12.0a0 nv26.05, CUDA 13.2, Python 3.12). Nothing was installed on the host. The scripts are in `look/scripts/w18-spark/`.

## Step1X-3D — `step1x/`

| | |
|---|---|
| Code | github.com/stepfun-ai/Step1X-3D, commit `cb5ac944709c6c913109070c7b90c3447f57f3d4` (9 Sep 2025), Apache 2.0 |
| Weights | `stepfun-ai/Step1X-3D` revision `bf7084495b3a72222f36549b7942948aa4d9daa7`: `Step1X-3D-Geometry-1300m` (Apache 2.0); config of `facebook/dinov2-with-registers-large` (Apache 2.0) |
| Background removal | `ZhengPeng7/BiRefNet` revision `e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4` (MIT), the model Step1X-3D's own texture stage uses. The geometry stage's default (`rembg` "bria" = RMBG-2.0, gated on Hugging Face, CC BY-NC) was not used. |
| Geometry settings | seed 2025, 50 steps, guidance 7.5, octree resolution 384, Step1X defaults otherwise (floater removal, 200,000-face cap) |
| Geometry time | 99 s on the GB10 (plus 46 s model load, 4 s background removal); peak GPU allocation 10.3 GB |

### Files

| File | Triangles | Bytes | Texture | Made by |
|---|---|---|---|---|
| `raw-geometry-200k.glb` | 200,000 | 5,006,652 | none | Step1X-3D geometry output as exported by the pipeline |
| `turret-20k.glb` | 20,000 | 131,600 | none | Step1X's own quadric reduction (`reduce_face`, pymeshlab) to 20,000 faces; textures and UVs removed, meshopt compression (glTF Transform 4.5.1) |
| `turret-5k.glb` | 5,000 | 35,356 | none | the same at 5,000 faces |
| `raw-geometry-preview.png` | | | | normal-shaded orthographic views of the raw geometry |
| `texture-stage-views-noise.png` | | | | the six views the texture stage generated (noise; see below) |

### Texture stage: failed, not used

Step1X-3D's texture stage (SDXL base 1.0 fp16 + `madebyollin/sdxl-vae-fp16-fix` + the Step1X ig2mv adapter, 6 views at 768², 50 steps, seed 2025) ran to completion in 124 s with a 41.5 GB peak allocation, but every generated view is multicoloured noise. The cause is upstream of the bake: plain SDXL text-to-image and a plain VAE encode/decode round trip produce the same structured noise in this container on the GB10 (round-trip mean absolute error 0.52 on the GPU against 0.027 for the same code on the CPU), while each layer run alone on the GPU matches the CPU. The downloaded weights match their Hugging Face SHA-256 values. Not resolved: the Spark stopped answering on Tailscale at about 21:05 BST, mid-investigation.

The game-ready files therefore carry geometry only, and the look test draws them with W17's ivory armour material (box-projected UVs in tile units, as the code-built models use). The noise-textured GLBs (`step1x-raw.glb` 50,000 triangles / 2048² PNG / 8,107,384 bytes, `step1x-20k-2048.glb` 7,061,056 bytes, `step1x-5k-1024.glb` 2,259,736 bytes) were not committed.

Step1X-3D's own texture baker (`step1x3d_texture/differentiable_renderer`, `custom_rasterizer`) is Hunyuan3D 2.0 code under the Tencent Hunyuan licence, which does not apply in the UK. It was stubbed out and never imported; `scripts/w18-spark/bake.py` was written for this test to replace it (nvdiffrast rasterisation, cos⁴-weighted projection of the six views, depth test, push-pull fill). nvdiffrast (NVIDIA Source Code Licence, non-commercial) is used by Step1X-3D's view rendering and by this baker; acceptable for this look test only. Its self-test (`test_bake.py`, position-coloured views of a synthetic mesh baked back to UV) gives a median texel error of 0.0029.

### "step1x-fake"

`~/bulwark-3d/out/step1x-fake/` on the Spark is a test of the bake and export path only: the six "views" were normal-map renders of the generated mesh, not diffusion output. It was used to check projection, UV, normals and GLB export before the SDXL weights had downloaded. None of its files are used here.

## TRELLIS.2 — not generated

github.com/microsoft/TRELLIS.2 commit `75fbf0183001ed9876c8dbb35de6b68552ee08bd`; weights `microsoft/TRELLIS.2-4B` (MIT, not gated). Every GPU extension built from source for sm_121 in a second container: nvdiffrast 0.4.0 (22 s), nvdiffrec renderutils (18 s), CuMesh (1 min 35 s), FlexGEMM (29 s), o-voxel (7 min 40 s); flash-attn 2.7.4 and xformers 0.0.33 came with the image. `from trellis2.pipelines import Trellis2ImageTo3DPipeline` imports. The pipeline cannot run: its image conditioner `facebook/dinov3-vitl16-pretrain-lvd1689m` is gated on Hugging Face (manual approval), and its default background remover `briaai/RMBG-2.0` is gated too. Per the brief, no token was looked for and the model was skipped. nvdiffrast is under the NVIDIA Source Code Licence (non-commercial); acceptable for this look test only.

Hunyuan3D was not used in any version.
