// Shell-textured wool fuzz: the mesh geometry is drawn `layers` times (one instance per shell),
// each shell pushed further out along the normal. A cell-based fiber mask in the fragment shader
// keeps only thin strands, so the silhouette gets a hairy halo.
import * as THREE from 'three';

const VERT_DECL = /* glsl */ `
uniform float uFuzzLength;
uniform float uFuzzLayers;
uniform float uFuzzDroop;
varying float vFuzzShell;
varying vec2 vFuzzUv;
`;

const VERT_BODY = /* glsl */ `
float fzShell = float( gl_InstanceID + 1 ) / uFuzzLayers;
vFuzzShell = fzShell;
vFuzzUv = uv;
// world-space down expressed in object space (row vector * matrix = transpose, exact for rotations)
vec3 fzDown = normalize( ( vec4( 0.0, -1.0, 0.0, 0.0 ) * modelMatrix ).xyz );
// smooth positional wobble so fibers do not all point straight out
vec3 fzWobble = vec3(
  sin( dot( position, vec3( 31.0, 17.0, 23.0 ) ) ),
  sin( dot( position, vec3( 13.0, 41.0, 19.0 ) ) ),
  sin( dot( position, vec3( 29.0, 11.0, 37.0 ) ) )
);
transformed += normalize( normal ) * ( uFuzzLength * fzShell );
transformed += fzDown * ( uFuzzDroop * uFuzzLength * fzShell * fzShell );
transformed += fzWobble * ( 0.2 * uFuzzLength * fzShell );
`;

const FRAG_DECL = /* glsl */ `
uniform float uFuzzDensity;
uniform float uFuzzOpacity;
varying float vFuzzShell;
varying vec2 vFuzzUv;

float fzHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 fzHash2( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
`;

const FRAG_BODY = /* glsl */ `
{
  float s = vFuzzShell;
  vec2 g = vFuzzUv * uFuzzDensity;
  vec2 cell = floor( g );
  vec2 local = fract( g ) - 0.5;

  // each cell holds at most one fiber; opacity scales how many cells hold one
  float present = fzHash( cell + 3.7 );
  if ( present > 0.7 * uFuzzOpacity ) discard;

  float tall = fzHash( cell + 11.3 );
  float hgt = 0.2 + 0.85 * pow( tall, 1.5 );
  if ( s > hgt ) discard;

  // fibers thin toward the tip and lean away from their root with height
  float rad = 0.36 * ( 1.0 - 0.85 * ( s / hgt ) );
  vec2 center = ( fzHash2( cell + 5.1 ) - 0.5 ) * 0.16 + ( fzHash2( cell + 9.9 ) - 0.5 ) * 0.34 * s;
  if ( length( local - center ) > rad ) discard;

  // fake self-shadow: dark at the root, bright at the tip
  float fzShade = mix( 0.6, 1.06, pow( s, 0.7 ) ) * mix( 0.92, 1.08, fzHash( cell + 1.9 ) );
  diffuseColor.rgb *= fzShade;
}
`;

export function addFuzz(mesh, { color, length = 0.025, density = 300, layers = 12, opacity = 1 } = {}) {
  const geometry = mesh.geometry;
  if (!geometry.attributes.uv || !geometry.attributes.normal) {
    throw new Error('addFuzz: geometry needs uv and normal attributes');
  }
  layers = Math.max(1, Math.round(layers));

  const uniforms = {
    uFuzzLength: { value: length },
    uFuzzLayers: { value: layers },
    uFuzzDroop: { value: 0.5 },
    uFuzzDensity: { value: density },
    uFuzzOpacity: { value: opacity },
  };

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color ?? 0xffffff),
    roughness: 1,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_BODY}`);
  };
  material.customProgramCacheKey = () => 'yarnFuzz';

  const fuzz = new THREE.InstancedMesh(geometry, material, layers);
  // InstancedMesh starts with zeroed matrices; shells only differ by gl_InstanceID in the shader
  const identity = new THREE.Matrix4();
  for (let i = 0; i < layers; i++) fuzz.setMatrixAt(i, identity);
  fuzz.instanceMatrix.needsUpdate = true;
  fuzz.castShadow = false;
  fuzz.receiveShadow = true;
  fuzz.frustumCulled = false; // shells extend past the geometry's bounding sphere
  fuzz.name = 'fuzz';
  fuzz.userData.fuzzUniforms = uniforms; // live-tweakable: length, density, droop, opacity

  mesh.add(fuzz);
  return fuzz;
}
