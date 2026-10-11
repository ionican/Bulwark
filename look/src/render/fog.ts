// Haze: an exponential-squared fog that starts at a distance (fogNear) and scales with fogFar,
// both set every frame from the camera's distance to its target, so the reference view and the
// strategic zoom-out both get haze that grows with distance beyond the area being looked at.
// Installed by replacing three's fog_fragment chunk; uses THREE.Fog's near/far uniforms.

import { ShaderChunk } from 'three';

export const FOG_GLSL = /* glsl */ `
float lookFog(float depth, float fNear, float fScale) {
  float d = max(depth - fNear, 0.0) / fScale;
  return (1.0 - exp(-d * d)) * 0.96;
}
`;

let installed = false;
export function installFog(): void {
  if (installed) return;
  installed = true;
  ShaderChunk.fog_pars_fragment = ShaderChunk.fog_pars_fragment + '\n#ifdef USE_FOG\n' + FOG_GLSL + '\n#endif\n';
  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  float fogFactor = lookFog(vFogDepth, fogNear, fogFar);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
#endif
`;
}
