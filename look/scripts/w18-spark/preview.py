# Normal-shaded preview of a mesh from six orthographic views (front, 3/4, side, back, top, 3/4 high).
import sys; sys.path.insert(0, "/work/Step1X-3D")
import numpy as np, torch, trimesh
from PIL import Image
from step1x3d_texture.utils import get_orthogonal_camera, make_image_grid
from step1x3d_texture.utils.render import load_mesh, render, NVDiffRastContextWrapper
m = trimesh.load(sys.argv[1])
if isinstance(m, trimesh.Scene): m = m.to_geometry()
tm, _ = load_mesh(m, rescale=True, device="cuda")
az = [0, 45, 90, 180, 270, 315]; el = [0, 20, 0, 0, 60, 20]
cams = get_orthogonal_camera(elevation_deg=el, distance=[1.8]*6, left=-0.55, right=0.55, bottom=-0.55, top=0.55, azimuth_deg=[a - 90 for a in az], device="cuda")
out = render(NVDiffRastContextWrapper(device="cuda", context_type="cuda"), tm, cams, height=512, width=512, render_attr=False, normal_background=1.0)
light = torch.nn.functional.normalize(torch.tensor([0.4, 0.5, 0.75], device="cuda"), dim=0)
imgs = []
for i in range(6):
    n = out.normal[i]
    v = cams.c2w[i, :3, :3]
    nv = n @ v  # camera-space normal
    s = (nv * light).sum(-1).clamp(0, 1) * 0.8 + 0.2
    s[~out.mask[i]] = 1.0
    imgs.append(Image.fromarray((s.cpu().numpy() * 255).astype(np.uint8)).convert("RGB"))
make_image_grid(imgs, rows=2).save(sys.argv[2])
print("faces", len(m.faces), "verts", len(m.vertices), "watertight", m.is_watertight, "bounds", m.bounds.tolist())
