# Multi-view to UV texture baker for the Bulwark W18 look test.
#
# Written for this test to replace Step1X-3D's texture baker (step1x3d_texture/differentiable_renderer
# and custom_rasterizer), which is Hunyuan3D 2.0 code under the Tencent Hunyuan licence; that
# licence does not apply in the UK, so none of it is imported or run here.
#
# Method: rasterise the mesh in UV space to get a world position and normal per texel; for each
# generated view, project the texels with the same orthographic camera the views were generated
# with, keep texels that pass a depth test against the view's own depth buffer and lie inside its
# silhouette (eroded by a few pixels), and weight the sampled colour by view weight x cos^exp of the
# angle to the view direction. Texels no view sees are filled by push-pull from their neighbours.

import numpy as np
import torch
import torch.nn.functional as F
import nvdiffrast.torch as dr


def _homog(p):
    return torch.cat([p, torch.ones_like(p[..., :1])], -1)


def push_pull(img, known):
    """Fill unknown texels from a mip pyramid of known texels. img (H,W,C), known (H,W) bool."""
    x = (img * known[..., None]).permute(2, 0, 1)[None]
    w = known.float()[None, None]
    levels = []
    while x.shape[-1] > 1:
        levels.append((x, w))
        x = F.avg_pool2d(x, 2) * 4
        w = F.avg_pool2d(w, 2) * 4
        x = x / w.clamp(min=1e-8) * (w > 0)
        w = (w > 0).float()
    for xs, ws in reversed(levels):
        up = F.interpolate(x, size=xs.shape[-2:], mode='bilinear', align_corners=False)
        x = xs + up * (1 - ws)
        w = torch.ones_like(ws)
    return x[0].permute(1, 2, 0)


@torch.no_grad()
def bake(mesh, cameras, images, weights, tex_size=2048, exp=4.0, erode_px=3, device='cuda'):
    """mesh: Step1X TexturedMesh (v_pos, t_pos_idx, v_tex flipped, v_nrm). cameras: Step1X Camera batch.
    images: list of PIL views in camera order. Returns (texture HxWx3 float 0..1, filled mask, coverage stats)."""
    ctx = dr.RasterizeCudaContext(device=device)
    tri = mesh.t_pos_idx.int().contiguous()
    tri_n = mesh.stitched_t_pos_idx.int().contiguous()
    uv = mesh.v_tex
    uv_clip = torch.cat([uv * 2 - 1, torch.zeros_like(uv[:, :1]), torch.ones_like(uv[:, :1])], -1)[None].contiguous()
    rast_uv, _ = dr.rasterize(ctx, uv_clip, mesh.t_tex_idx.int().contiguous(), (tex_size, tex_size))
    covered = rast_uv[0, ..., 3] > 0
    pos, _ = dr.interpolate(mesh.v_pos[None].contiguous(), rast_uv, tri)
    nrm, _ = dr.interpolate(mesh.v_nrm[None].contiguous(), rast_uv, tri_n)
    pos = pos[0][covered]
    nrm = F.normalize(nrm[0][covered], dim=-1)
    n = pos.shape[0]
    acc = torch.zeros(n, 3, device=device)
    wsum = torch.zeros(n, device=device)
    clip_all = _homog(mesh.v_pos)
    stats = []
    for i, img in enumerate(images):
        mvp = cameras.mvp_mtx[i]
        arr = torch.tensor(np.asarray(img.convert('RGB')), dtype=torch.float32, device=device) / 255.0
        H, W = arr.shape[:2]
        clip = (clip_all @ mvp.T)[None].contiguous()
        rast, _ = dr.rasterize(ctx, clip, tri, (H, W))
        hit = rast[0, ..., 3] > 0
        zbuf = torch.where(hit, rast[0, ..., 2], torch.full_like(rast[0, ..., 2], 1e9))
        # silhouette erosion: texels near the view's outline get unreliable colours
        inner = -F.max_pool2d(-hit.float()[None, None], 2 * erode_px + 1, 1, erode_px)[0, 0]
        p = _homog(pos) @ mvp.T
        ndc = p[:, :3] / p[:, 3:]
        grid = ndc[:, :2].view(1, 1, n, 2)
        col = F.grid_sample(arr.permute(2, 0, 1)[None], grid, mode='bilinear', align_corners=False)[0, :, 0].T
        zs = F.grid_sample(zbuf[None, None], grid, mode='nearest', align_corners=False)[0, 0, 0]
        ins = F.grid_sample(inner[None, None], grid, mode='nearest', align_corners=False)[0, 0, 0] > 0.5
        in_frame = (ndc[:, 0].abs() < 1) & (ndc[:, 1].abs() < 1)
        visible = in_frame & ins & (ndc[:, 2] <= zs + 2e-4)
        view_dir = F.normalize(cameras.cam_pos[i], dim=-1)
        cos = (nrm * view_dir).sum(-1).clamp(min=0)
        w = weights[i] * cos.pow(exp) * visible.float()
        acc += col * w[:, None]
        wsum += w
        stats.append(int(visible.sum()))
    tex = torch.zeros(tex_size, tex_size, 3, device=device)
    filled = torch.zeros(tex_size, tex_size, dtype=torch.bool, device=device)
    ok = wsum > 1e-8
    vals = torch.zeros(n, 3, device=device)
    vals[ok] = acc[ok] / wsum[ok, None]
    tex[covered] = vals
    filled[covered] = ok
    tex = push_pull(tex, filled)
    return tex.clamp(0, 1), filled, {'texels_covered': int(covered.sum()), 'texels_seen': int(filled.sum()), 'visible_per_view': stats}
