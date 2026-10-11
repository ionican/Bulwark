# Bulwark W18: Step1X-3D image-to-3D for the gun turret concept image.
# Stage 0: background removal with BiRefNet (the model Step1X-3D's texture stage uses).
# Stage 1: Step1X-3D-Geometry-1300m -> untextured mesh.
# Stage 2: Step1X-3D-Texture multi-view generation (SDXL + Step1X ig2mv adapter, texture sync).
# Stage 3: bake.py (written for this test) in place of the Hunyuan3D-derived baker.
import argparse, json, os, sys, time, types

import numpy as np
import torch
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--image', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--seed', type=int, default=2025)
ap.add_argument('--steps', type=int, default=50)
ap.add_argument('--guidance', type=float, default=7.5)
ap.add_argument('--octree', type=int, default=384)
ap.add_argument('--stage', default='all', choices=['all', 'geometry', 'texture'])
ap.add_argument('--fake-views', action='store_true', help='test the bake/export path with rendered normal views instead of the diffusion model')
args = ap.parse_args()

REPO = '/work/Step1X-3D'
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.makedirs(args.out, exist_ok=True)
log = {'args': vars(args)}
t_all = time.time()


def save_log():
    with open(os.path.join(args.out, 'run.json'), 'w') as f:
        json.dump(log, f, indent=2)


# Keep the Hunyuan3D-licensed baker out of the process: stub its package before the texture
# pipeline module imports MeshRender from it.
_stub_pkg = types.ModuleType('step1x3d_texture.differentiable_renderer')
_stub_pkg.__path__ = []
_stub = types.ModuleType('step1x3d_texture.differentiable_renderer.mesh_render')


class _ExcludedMeshRender:
    def __init__(self, *a, **k):
        raise RuntimeError('Hunyuan3D-derived MeshRender is excluded from this test')


_stub.MeshRender = _ExcludedMeshRender
sys.modules['step1x3d_texture.differentiable_renderer'] = _stub_pkg
sys.modules['step1x3d_texture.differentiable_renderer.mesh_render'] = _stub

rgba_path = os.path.join(args.out, 'input-rgba.png')
geo_path = os.path.join(args.out, 'geometry-raw.glb')

if args.stage in ('all', 'geometry'):
    # ---- stage 0: background removal
    from torchvision import transforms
    from transformers import AutoModelForImageSegmentation
    t = time.time()
    net = AutoModelForImageSegmentation.from_pretrained('/work/models/ZhengPeng7/BiRefNet', trust_remote_code=True).to('cuda').eval()
    img = Image.open(args.image).convert('RGB')
    tf = transforms.Compose([transforms.Resize((1024, 1024)), transforms.ToTensor(), transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    with torch.no_grad():
        pred = net(tf(img).unsqueeze(0).to('cuda'))[-1].sigmoid().cpu()[0].squeeze()
    mask = transforms.ToPILImage()(pred).resize(img.size)
    img.putalpha(mask)
    img.save(rgba_path)
    del net
    torch.cuda.empty_cache()
    log['rembg_s'] = time.time() - t

    # ---- stage 1: geometry
    from step1x3d_geometry.models.pipelines.pipeline import Step1X3DGeometryPipeline
    t = time.time()
    pipe = Step1X3DGeometryPipeline.from_pretrained('/work/models/stepfun-ai/Step1X-3D', subfolder='Step1X-3D-Geometry-1300m').to('cuda')
    log['geometry_load_s'] = time.time() - t
    torch.cuda.synchronize()
    t = time.time()
    gen = torch.Generator(device=pipe.device).manual_seed(args.seed)
    out = pipe(rgba_path, guidance_scale=args.guidance, num_inference_steps=args.steps, octree_resolution=args.octree, generator=gen)
    torch.cuda.synchronize()
    log['geometry_s'] = time.time() - t
    m = out.mesh[0]
    m.export(geo_path)
    log['geometry_faces'] = int(len(m.faces))
    log['geometry_peak_gb'] = torch.cuda.max_memory_allocated() / 1e9
    del pipe, out
    torch.cuda.empty_cache()
    save_log()
    print(json.dumps(log, indent=2), flush=True)

if args.stage in ('all', 'texture'):
    import trimesh
    from step1x3d_geometry.models.pipelines.pipeline_utils import reduce_face, remove_degenerate_face
    import step1x3d_texture.pipelines.step1x_3d_texture_synthesis_pipeline as tp
    from step1x3d_texture.utils import get_orthogonal_camera, make_image_grid
    from bake import bake

    # SDXL base from its fp16 variant files (the pipeline runs in fp16 either way)
    _orig = tp.IG2MVSDXLPipeline.from_pretrained.__func__
    tp.IG2MVSDXLPipeline.from_pretrained = classmethod(lambda cls, *a, **k: _orig(cls, *a, variant='fp16', **k))

    class Pipe(tp.Step1X3DTexturePipeline):
        def __init__(self, config):  # skips MeshRender
            self.config = config
            c = config
            self.ig2mv_pipe = self.prepare_ig2mv_pipeline(base_model=c.base_model, vae_model=c.vae_model, unet_model=c.unet_model, lora_model=c.lora_model, adapter_path=c.adapter_path, scheduler=c.scheduler, num_views=c.num_views, device=c.device, dtype=c.dtype)

    torch.cuda.reset_peak_memory_stats()
    t = time.time()
    cfg = tp.Step1X3DTextureConfig()
    if args.fake_views:
        Pipe.__init__ = lambda self, config: setattr(self, 'config', config)
    cfg.base_model = '/work/models/stabilityai/stable-diffusion-xl-base-1.0'
    cfg.vae_model = '/work/models/madebyollin/sdxl-vae-fp16-fix'
    cfg.adapter_path = '/work/models/stepfun-ai/Step1X-3D/Step1X-3D-Texture'
    tpipe = Pipe(cfg)
    log['texture_load_s'] = time.time() - t
    mesh = trimesh.load(geo_path)
    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.to_geometry()
    mesh = remove_degenerate_face(mesh)
    mesh = reduce_face(mesh)
    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.to_geometry()
    log['texture_input_faces'] = int(len(mesh.faces))
    mesh_orig = mesh.copy()  # run_ig2mv_pipeline rescales and reorients `mesh` in place
    torch.cuda.synchronize()
    t = time.time()
    c = tpipe.config
    if args.fake_views:
        from step1x3d_texture.utils.render import load_mesh as _lm, render as _render, NVDiffRastContextWrapper
        tmesh, mesh_bp = _lm(mesh, rescale=True, device='cuda')
        _cams = get_orthogonal_camera(elevation_deg=[0, 0, 0, 0, 89.99, -89.99], distance=[1.8] * 6, left=-0.55, right=0.55, bottom=-0.55, top=0.55, azimuth_deg=[x - 90 for x in [0, 90, 180, 270, 180, 180]], device='cuda')
        _o = _render(NVDiffRastContextWrapper(device='cuda', context_type='cuda'), tmesh, _cams, height=768, width=768, render_attr=False, normal_background=0.0)
        images = [Image.fromarray(((n / 2 + 0.5).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)) for n in _o.normal]
        normal_images = images
        ref = Image.open(rgba_path)
    else:
      images, pos_images, normal_images, ref, tmesh, mesh_bp = tpipe.run_ig2mv_pipeline(
        tpipe.ig2mv_pipe, mesh=mesh, num_views=c.num_views, text=c.text, image=Image.open(rgba_path), height=768, width=768,
        num_inference_steps=c.num_inference_steps, guidance_scale=c.guidance_scale, seed=args.seed, lora_scale=c.lora_scale,
        reference_conditioning_scale=c.reference_conditioning_scale, negative_prompt=c.negative_prompt, device=c.device, remove_bg_fn=None)
    torch.cuda.synchronize()
    log['multiview_s'] = time.time() - t
    make_image_grid(images, rows=1).save(os.path.join(args.out, 'views.png'))
    make_image_grid(normal_images, rows=1).save(os.path.join(args.out, 'views-normal.png'))
    ref.save(os.path.join(args.out, 'reference-preprocessed.png'))
    # bake with the cameras the views were generated with (same call as run_ig2mv_pipeline), once
    # per level of detail: Step1X's own quadric reduction (reduce_face), then a fresh xatlas
    # unwrap and bake per level, all in the normalisation the views were generated in
    from step1x3d_texture.utils.render import load_mesh
    cams = get_orthogonal_camera(elevation_deg=[0, 0, 0, 0, 89.99, -89.99], distance=[1.8] * c.num_views, left=-0.55, right=0.55, bottom=-0.55, top=0.55,
                                 azimuth_deg=[x - 90 for x in [0, 90, 180, 270, 180, 180]], device='cuda')
    max_scale = float(np.abs(mesh_orig.vertices).max())
    log['levels'] = {}
    for name, faces, size in [('raw', None, 2048), ('20k', 20000, 2048), ('5k', 5000, 1024)]:
        t = time.time()
        if faces is None:
            lm, lbp = tmesh, mesh_bp
        else:
            m = reduce_face(mesh_orig.copy(), faces)
            if isinstance(m, trimesh.Scene):
                m = m.to_geometry()
            m.vertices = m.vertices / max_scale * 0.5
            lm, lbp = load_mesh(m, rescale=False, device='cuda')
        tex, filled, st = bake(lm, cams, images, c.selected_view_weights, tex_size=size, exp=c.bake_exp)
        tex_img = Image.fromarray((tex.cpu().numpy() * 255).round().astype(np.uint8))
        tex_img.save(os.path.join(args.out, f'basecolor-{name}.png'))
        mat = trimesh.visual.material.PBRMaterial(baseColorTexture=tex_img, metallicFactor=0.0, roughnessFactor=0.8)
        # UVs: the xatlas layout the bake used (load_mesh stores it flipped in v_tex; mesh_bp keeps
        # vertex order but trimesh drops the uv attribute on copy)
        uv = lm.v_tex.detach().cpu().numpy().astype(np.float64).copy()
        uv[:, 1] = 1.0 - uv[:, 1]
        assert len(uv) == len(lbp.vertices)
        om = trimesh.Trimesh(vertices=lbp.vertices, faces=lbp.faces, visual=trimesh.visual.TextureVisuals(uv=uv, material=mat), process=False)
        # smooth normals across UV seams: average face normals per unique position, not per split vertex
        _, inv = np.unique(np.round(om.vertices, 6), axis=0, return_inverse=True)
        inv = inv.reshape(-1)
        acc = np.zeros((inv.max() + 1, 3))
        fn_w = np.cross(om.vertices[om.faces[:, 1]] - om.vertices[om.faces[:, 0]], om.vertices[om.faces[:, 2]] - om.vertices[om.faces[:, 0]])
        for k in range(3):
            np.add.at(acc, inv[om.faces[:, k]], fn_w)
        vn = acc[inv]
        vn /= np.linalg.norm(vn, axis=1, keepdims=True).clip(1e-12)
        om.vertex_normals = vn
        fn = 'step1x-raw.glb' if faces is None else f'step1x-{name}-{size}.glb'
        om.export(os.path.join(args.out, fn), include_normals=True)
        st.update(file=fn, faces=int(len(om.faces)), texture=size, seconds=time.time() - t)
        log['levels'][name] = st
        print(name, st, flush=True)
    log['texture_peak_gb'] = torch.cuda.max_memory_allocated() / 1e9

log['total_s'] = time.time() - t_all
save_log()
print(json.dumps(log, indent=2), flush=True)
