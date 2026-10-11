# Parallel ranged downloader for public Hugging Face files (no token). Writes /work/models/<repo>/<path>.
import os, sys, time, threading, requests
from concurrent.futures import ThreadPoolExecutor
CHUNK = 16 << 20
def fetch(repo, rev, path, workers=12):
    dst = f"/work/models/{repo}/{path}"
    if os.path.exists(dst): return dst
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    url = f"https://huggingface.co/{repo}/resolve/{rev}/{path}"
    r0 = requests.head(url, allow_redirects=False, timeout=60)
    if "x-linked-size" not in {k.lower() for k in r0.headers}:
        rr = requests.get(url, timeout=120); rr.raise_for_status()
        open(dst, "wb").write(rr.content); return dst
    r = requests.head(url, allow_redirects=True, timeout=60)
    r.raise_for_status()
    size = int(r0.headers["x-linked-size"]); final = r.url
    part = dst + ".part"; donef = dst + ".done"
    done = set(int(x) for x in open(donef).read().split()) if os.path.exists(donef) and os.path.exists(part) else set()
    seed = SEEDS.get(path)
    if not os.path.exists(part):
        if seed and os.path.exists(seed):
            import shutil; shutil.copyfile(seed, part)
            have = os.path.getsize(part)
            done = set(o for o in range(0, size, CHUNK) if o + CHUNK <= have)
        with open(part, "ab") as f: f.truncate(size)
    lock = threading.Lock(); dlog = open(donef, "a")
    for o in done: dlog.write(f"{o}\n")
    dlog.flush()
    fd = os.open(part, os.O_WRONLY)
    def get(off):
        end = min(off + CHUNK, size) - 1
        for attempt in range(30):
            try:
                rr = requests.get(final, headers={"Range": f"bytes={off}-{end}"}, timeout=60)
                if rr.status_code == 403:  # signed URL expired: re-resolve
                    rr = requests.get(url, headers={"Range": f"bytes={off}-{end}"}, timeout=60, allow_redirects=True)
                rr.raise_for_status()
                if len(rr.content) != end - off + 1: raise IOError("short read")
                os.pwrite(fd, rr.content, off)
                with lock: dlog.write(f"{off}\n"); dlog.flush()
                return
            except Exception as e:
                time.sleep(3)
        raise RuntimeError(f"{path} chunk {off} failed")
    t = time.time()
    with ThreadPoolExecutor(workers) as ex: list(ex.map(get, [o for o in range(0, size, CHUNK) if o not in done]))
    os.close(fd); dlog.close(); os.rename(part, dst); os.remove(donef)
    print(f"{repo}/{path} {size/1e6:.0f} MB in {time.time()-t:.0f}s ({size/1e6/(time.time()-t):.1f} MB/s)", flush=True)
    return dst
SEEDS = {"Step1X-3D-Geometry-1300m/transformer/diffusion_pytorch_model.safetensors": "/work/hf/hub/models--stepfun-ai--Step1X-3D/blobs/a8cfc27716009acc60035f2489a9b61de81790625b70aa27a682efc99a5137a9.incomplete"}
jobs = [
 ("stepfun-ai/Step1X-3D", "bf7084495b3a72222f36549b7942948aa4d9daa7", ["Step1X-3D-Geometry-1300m/transformer/diffusion_pytorch_model.safetensors"]),
 ("ZhengPeng7/BiRefNet", "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4", ["config.json", "BiRefNet_config.py", "birefnet.py", "handler.py", "model.safetensors"]),
 ("stepfun-ai/Step1X-3D", "bf7084495b3a72222f36549b7942948aa4d9daa7", ["Step1X-3D-Texture/step1x-3d-ig2v.safetensors"]),
 ("madebyollin/sdxl-vae-fp16-fix", "207b116dae70ace3637169f1ddd2434b91b3a8cd", ["config.json", "diffusion_pytorch_model.safetensors"]),
 ("stabilityai/stable-diffusion-xl-base-1.0", "462165984030d82259a11f4367a4eed129e94a7b", ["model_index.json", "scheduler/scheduler_config.json", "text_encoder/config.json", "text_encoder/model.fp16.safetensors", "text_encoder_2/config.json", "text_encoder_2/model.fp16.safetensors", "tokenizer/merges.txt", "tokenizer/special_tokens_map.json", "tokenizer/tokenizer_config.json", "tokenizer/vocab.json", "tokenizer_2/merges.txt", "tokenizer_2/special_tokens_map.json", "tokenizer_2/tokenizer_config.json", "tokenizer_2/vocab.json", "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors", "vae/config.json"]),
]
for repo, rev, paths in jobs:
    for p in paths: fetch(repo, rev, p)
print("PDL-DONE", flush=True)
