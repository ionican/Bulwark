// Lighting: a low warm sun (directional light, PCF shadows), image-based light from the Poly Haven
// HDRI rotated so its sun agrees with the directional light, a weak hemisphere bounce, warm haze
// and a gradient sky dome matched to the haze colour.
//
// Shadows: ONE directional shadow map (not cascades), re-fitted every frame to the part of the
// view frustum within `reach` of the camera, in a fixed light-space frame with texel snapping so
// it does not shimmer as the camera moves. 4096² on high, 2048² on medium.

import {
  BackSide,
  Color,
  DataTexture,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Fog,
  HemisphereLight,
  Matrix4,
  Mesh,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { installFog } from './fog.ts';

export const SUN_DIR = new Vector3(-1, 0, -0.42).normalize().multiplyScalar(Math.cos((27 * Math.PI) / 180)).setY(Math.sin((27 * Math.PI) / 180)).normalize();
export const HAZE = new Color('#dcb894');
const ORIGIN = new Vector3(64, 0, 64);

export class Lighting {
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly fog: Fog;
  readonly sky: Mesh;
  envRT: WebGLRenderTarget | null = null;
  envSunAzimuth = 0;
  private lightView = new Matrix4();
  private corners = Array.from({ length: 8 }, () => new Vector3());

  constructor(
    private scene: Scene,
    private renderer: WebGLRenderer,
  ) {
    installFog();
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    this.sun = new DirectionalLight(new Color('#ffd2a0'), 3.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.12;
    this.sun.shadow.radius = 2.5;
    this.sun.position.copy(ORIGIN).addScaledVector(SUN_DIR, 400);
    this.sun.target.position.copy(ORIGIN);
    scene.add(this.sun, this.sun.target);
    this.hemi = new HemisphereLight(new Color('#ffe2c4'), new Color('#a0583a'), 0.15);
    scene.add(this.hemi);
    this.fog = new Fog(HAZE.clone(), 80, 160);
    scene.fog = this.fog;
    scene.background = HAZE.clone();
    this.sky = skyDome();
    scene.add(this.sky);
    // fixed light view (position on the sun direction, looking at the origin)
    this.lightView.lookAt(SUN_DIR, new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    this.lightView.setPosition(ORIGIN.clone().addScaledVector(SUN_DIR, 400));
    this.lightView.invert();
  }

  async loadEnvironment(url: string, intensity = 0.5): Promise<void> {
    const hdr = (await new HDRLoader().loadAsync(url)) as DataTexture;
    hdr.mapping = EquirectangularReflectionMapping;
    // find the HDRI's sun (brightest pixel) and rotate the environment to match SUN_DIR
    const { width, height, data } = hdr.image as { width: number; height: number; data: Uint16Array | Float32Array };
    const isHalf = data instanceof Uint16Array;
    const f16 = (h: number) => {
      const s = (h & 0x8000) >> 15;
      const e = (h & 0x7c00) >> 10;
      const f = h & 0x03ff;
      if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
      if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
      return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
    };
    let best = -1;
    let bx = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const v = isHalf ? f16(data[o]!) + f16(data[o + 1]!) + f16(data[o + 2]!) : data[o]! + data[o + 1]! + data[o + 2]!;
        if (v > best) {
          best = v;
          bx = x;
        }
      }
    const u = (bx + 0.5) / width;
    this.envSunAzimuth = (u - 0.5) * Math.PI * 2;
    const sunAz = Math.atan2(SUN_DIR.z, SUN_DIR.x);
    const pm = new PMREMGenerator(this.renderer);
    this.envRT = pm.fromEquirectangular(hdr);
    pm.dispose();
    hdr.dispose();
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = intensity;
    this.scene.environmentRotation.set(0, sunAz - this.envSunAzimuth, 0);
  }

  setShadowSize(size: number): void {
    if (this.sun.shadow.mapSize.x === size) return;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as unknown as { map: null }).map = null;
  }

  /**
   * Fit the shadow camera to the view frustum up to `reach` world units from the camera (default
   * 2.1 × the target distance + 30; W21 passes a shorter reach to keep shadows near the camera).
   */
  update(camera: PerspectiveCamera, targetDist: number, reachOverride?: number): void {
    // haze relative to the looked-at distance
    this.fog.near = targetDist * 0.75;
    this.fog.far = 50 + targetDist * 1.0;
    this.sky.position.copy(camera.position);

    const reach = Math.min(camera.far, reachOverride ?? targetDist * 2.1 + 30);
    const inv = camera.projectionMatrixInverse;
    let k = 0;
    for (const zN of [-1, 1]) {
      for (const x of [-1, 1])
        for (const y of [-1, 1]) {
          const v = this.corners[k++]!.set(x, y, zN).applyMatrix4(inv);
          if (zN === 1) v.multiplyScalar(reach / -v.z);
          v.applyMatrix4(camera.matrixWorld);
        }
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const c of this.corners) {
      // clamp the far corners to the ground band so the box does not chase the sky
      c.y = Math.max(-12, Math.min(c.y, 30));
      const p = c.clone().applyMatrix4(this.lightView);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const size = this.sun.shadow.mapSize.x;
    const span = Math.max(maxX - minX, maxY - minY);
    const texel = span / size;
    const cx = Math.round((minX + maxX) / 2 / texel) * texel;
    const cy = Math.round((minY + maxY) / 2 / texel) * texel;
    const half = Math.ceil(span / 2 / texel) * texel;
    const cam = this.sun.shadow.camera;
    cam.left = cx - half;
    cam.right = cx + half;
    cam.bottom = cy - half;
    cam.top = cy + half;
    cam.near = Math.max(1, -maxZ - 120);
    cam.far = -minZ + 20;
    cam.updateProjectionMatrix();
  }
}

function skyDome(): Mesh {
  const m = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uHorizon: { value: HAZE.clone() }, uZenith: { value: new Color('#b9b5ad') }, uSun: { value: SUN_DIR.clone() } },
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
    fragmentShader: /* glsl */ `uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uSun; varying vec3 vDir;
      void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(uHorizon, uZenith, pow(h, 0.55));
      float s = max(dot(normalize(vDir), uSun), 0.0); c += vec3(1.0,0.75,0.5) * pow(s, 18.0) * 0.6;
      gl_FragColor = vec4(c, 1.0); }`,
  });
  const mesh = new Mesh(new SphereGeometry(900, 32, 16), m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'sky';
  return mesh;
}
