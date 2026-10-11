// Geometry-only copy of a GLB: removes every texture and sets a neutral ivory base colour, then
// meshopt-compresses. Used for Step1X-3D, whose generated base-colour texture was noise.
// usage: node strip.mjs in.glb out.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const [, , input, output] = process.argv;
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(input);
for (const m of doc.getRoot().listMaterials()) {
  m.setBaseColorTexture(null).setMetallicRoughnessTexture(null).setNormalTexture(null).setOcclusionTexture(null).setEmissiveTexture(null);
  m.setBaseColorFactor([0.86, 0.82, 0.74, 1]).setMetallicFactor(0).setRoughnessFactor(0.75);
}
for (const t of doc.getRoot().listTextures()) t.dispose();
for (const mesh of doc.getRoot().listMeshes())
  for (const p of mesh.listPrimitives()) p.setAttribute('TEXCOORD_0', null);
await doc.transform(weld(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(output, doc);
