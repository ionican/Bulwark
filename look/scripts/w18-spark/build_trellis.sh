set -x
git config --global --add safe.directory "*"
DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq libjpeg-dev libgl1 libglib2.0-0 >/dev/null
pip list --format=freeze | grep -E "^(torch|torchvision|triton|numpy)==" > /tmp/c.txt
pip install -c /tmp/c.txt imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja trimesh zstandard kornia timm "git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8"
for e in nvdiffrast nvdiffrec CuMesh FlexGEMM; do
  rm -rf /tmp/ext-$e; cp -r /work/ext/$e /tmp/ext-$e
  ( time pip install --no-build-isolation -c /tmp/c.txt /tmp/ext-$e ) > /work/logs/trellis-$e.log 2>&1; echo "$e rc=$?"
done
rm -rf /tmp/ext-o-voxel; cp -r /work/TRELLIS.2/o-voxel /tmp/ext-o-voxel
( time pip install --no-build-isolation -c /tmp/c.txt /tmp/ext-o-voxel ) > /work/logs/trellis-o-voxel.log 2>&1; echo "o-voxel rc=$?"
cd /work/TRELLIS.2 && python -c "import nvdiffrast.torch, cumesh, flex_gemm, o_voxel; from trellis2.pipelines import Trellis2ImageTo3DPipeline; print(\"TRELLIS.2 imports ok\")"
echo BUILD-DONE
