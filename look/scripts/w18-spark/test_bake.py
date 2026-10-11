# Self-test for bake.py: colour a mesh by world position, render the six Step1X views with the
# same cameras, bake them back to UV, and compare the baked texel colours with the true ones.
import sys, types
sys.path.insert(0, "/work/scripts"); sys.path.insert(0, "/work/Step1X-3D")
import numpy as np, torch, trimesh
from PIL import Image
from step1x3d_texture.utils import get_orthogonal_camera
from step1x3d_texture.utils.render import load_mesh, render, NVDiffRastContextWrapper
import nvdiffrast.torch as dr
from bake import bake
m = trimesh.creation.annulus(r_min=0.15, r_max=0.4, height=0.5, sections=48)
m = trimesh.util.concatenate([m, trimesh.creation.box((0.8, 0.12, 0.12))])
tm, bp = load_mesh(m, rescale=True, device="cuda")
cams = get_orthogonal_camera(elevation_deg=[0, 0, 0, 0, 89.99, -89.99], distance=[1.8]*6, left=-0.55, right=0.55, bottom=-0.55, top=0.55, azimuth_deg=[x - 90 for x in [0, 90, 180, 270, 180, 180]], device="cuda")
ctx = NVDiffRastContextWrapper(device="cuda", context_type="cuda")
out = render(ctx, tm, cams, height=768, width=768, render_attr=False, normal_background=0.0)
col = (out.pos + 0.5).clamp(0, 1)
col[~out.mask] = 0.5
views = [Image.fromarray((c.cpu().numpy() * 255).astype(np.uint8)) for c in col]
tex, filled, st = bake(tm, cams, views, [1, 0.1, 0.5, 0.1, 0.05, 0.05], tex_size=1024)
# truth: rasterise UV, interpolate position
c2 = dr.RasterizeCudaContext()
uv = tm.v_tex
uvc = torch.cat([uv*2-1, torch.zeros_like(uv[:, :1]), torch.ones_like(uv[:, :1])], -1)[None].contiguous()
r, _ = dr.rasterize(c2, uvc, tm.t_tex_idx.int().contiguous(), (1024, 1024))
pos, _ = dr.interpolate(tm.v_pos[None].contiguous(), r, tm.t_pos_idx.int().contiguous())
truth = (pos[0] + 0.5).clamp(0, 1)
cov = r[0, ..., 3] > 0
err = (tex - truth).abs().max(-1).values[cov & filled]
print(st)
print("covered", int(cov.sum()), "filled", int((cov & filled).sum()), "median err", float(err.median()), "p95 err", float(err.quantile(0.95)))
