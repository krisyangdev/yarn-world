// River surface: patches the river's yarn material so the knit ribbon visibly flows without leaving the
// soft knitted look (the knit map stays, everything is low contrast).
//
// Coordinates: s = uv.x * 2 - 1 across the river (0 = centerline), along = uv.y * uRiverLen world units downstream.
//   1. swell      two sine bands advected downstream at different speeds, slower near the banks. The bank drag
//                 would shear the bands more every second, so each layer blends two phases that restart in turn
//                 (flow-map trick). Used as a small vertex lift and as a normal tilt plus crest brightness.
//   2. depth tint centerline multiplies toward a deeper blue, banks keep the base color
//   3. bank foam  off-white yarn edge whose inner border wobbles with noise scrolling downstream
//   4. gust ripples fine ripples travelling along the wind where windAt() exceeds the steady breeze, so a gust
//                 darkens and ruffles the water as the same band that bends the grass crosses it
// The swell gradient in world xz comes from the (s, along) gradient and the screen derivatives of both mappings.
import * as THREE from 'three';
import { WIND_GLSL, BREEZE_MAX } from './wind.js';

const SWELL_SPEED = [0.5, 0.32]; // u/s downstream, per layer
const SWELL_WAVE = [1.4, 0.9]; // wavelength along the river, per layer
const SWELL_SKEW = [2.2, -3.1]; // phase shift per unit s, tilts the bands diagonally
const SWELL_MIX = [0.6, 0.4];
const BANK_DRAG = 0.4; // speed * (1 - BANK_DRAG * s^2)
const SWELL_LIFT = 0.012; // vertex displacement
const SWELL_TILT = 0.05; // normal tilt per unit of swell slope
const SWELL_LIGHT = 0.09; // diffuse change at crests / troughs

const BASE = new THREE.Color('#8ec5df'); // river base color
const DEEP = new THREE.Color('#5fa3c7'); // centerline target
const DEPTH_MIX = 0.9;
const DEPTH_POW = 1.3;

const FOAM = new THREE.Color('#f4efe4');
const FOAM_EDGE = 0.86; // |s| where the foam starts
const FOAM_SOFT = 0.07;
const FOAM_STRENGTH = 0.75;
const FOAM_SPEED = 0.4; // wobble scroll speed, u/s

const RIPPLE_WAVE = [0.17, 0.12];
const RIPPLE_SPEED = 1.5; // u/s along uWindDir
const RIPPLE_ROT = 0.6; // rad, direction of the second ripple set relative to the wind
const RIPPLE_RANGE = 0.6; // windAt - BREEZE_MAX over which ripples fade in
const RIPPLE_TILT = 0.012;
const RIPPLE_DARK = 0.07;
const RIPPLE_FLICKER = 0.04;

const f = (n) => n.toFixed(4);
const v3 = (c) => `vec3( ${f(c.r)}, ${f(c.g)}, ${f(c.b)} )`;
const TAU = Math.PI * 2;
const deepRatio = new THREE.Color(DEEP.r / BASE.r, DEEP.g / BASE.g, DEEP.b / BASE.b);

// shared by both stages: swell(s, along, t, g) returns h, g = (dh/ds, dh/dalong)
const COMMON = /* glsl */ `
uniform float uRiverT;
uniform float uRiverLen;

float swellLayer( float s, float a, float t, float v, float lam, float skew, float ph, out vec2 g ) {
	float k = 1.0 - ${f(BANK_DRAG)} * s * s;
	float dk = -2.0 * ${f(BANK_DRAG)} * s;
	float T = 2.0 * lam / v;
	float K = ${f(TAU)} / lam;
	float f0 = fract( t / T );
	float w0 = 1.0 - abs( 2.0 * f0 - 1.0 );
	float f1 = fract( t / T + 0.5 );
	float p0 = ( a - v * k * f0 * T ) * K + skew * s + ph;
	float p1 = ( a - v * k * f1 * T ) * K + skew * s + ph;
	float c0 = cos( p0 ) * w0;
	float c1 = cos( p1 ) * ( 1.0 - w0 );
	g.x = skew * ( c0 + c1 ) - K * v * dk * T * ( c0 * f0 + c1 * f1 );
	g.y = K * ( c0 + c1 );
	return sin( p0 ) * w0 + sin( p1 ) * ( 1.0 - w0 );
}

float swell( float s, float a, float t, out vec2 g ) {
	vec2 g1;
	vec2 g2;
	float h1 = swellLayer( s, a, t, ${f(SWELL_SPEED[0])}, ${f(SWELL_WAVE[0])}, ${f(SWELL_SKEW[0])}, 0.0, g1 );
	float h2 = swellLayer( s, a, t, ${f(SWELL_SPEED[1])}, ${f(SWELL_WAVE[1])}, ${f(SWELL_SKEW[1])}, 1.7, g2 );
	g = ${f(SWELL_MIX[0])} * g1 + ${f(SWELL_MIX[1])} * g2;
	return ${f(SWELL_MIX[0])} * h1 + ${f(SWELL_MIX[1])} * h2;
}
`;

const VARYINGS = /* glsl */ `
varying vec2 vRiverUV;
varying vec2 vRiverXZ;
`;

const VERTEX_BODY = /* glsl */ `
vRiverUV = uv;
vRiverXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;
{
	float rvS = uv.x * 2.0 - 1.0;
	vec2 rvG;
	transformed.y += ${f(SWELL_LIFT)} * swell( rvS, uv.y * uRiverLen, uRiverT, rvG ) * ( 1.0 - rvS * rvS );
}
`;

// colors, then the slope that the normal stage applies
const FRAGMENT_COLOR = /* glsl */ `
float rvS = vRiverUV.x * 2.0 - 1.0;
float rvAlong = vRiverUV.y * uRiverLen;
vec2 rvSG;
float rvH = swell( rvS, rvAlong, uRiverT, rvSG );
vec2 rvJ = vec2( 2.0, uRiverLen );
vec2 rvDx = dFdx( vRiverUV ) * rvJ;
vec2 rvDy = dFdy( vRiverUV ) * rvJ;
vec2 rvScreenG = vec2( dot( rvSG, rvDx ), dot( rvSG, rvDy ) );
mat2 rvM = mat2( dFdx( vRiverXZ ), dFdy( vRiverXZ ) );
float rvDet = rvM[0].x * rvM[1].y - rvM[0].y * rvM[1].x;
vec2 rvSlope = abs( rvDet ) > 1e-12 ? transpose( inverse( rvM ) ) * rvScreenG : vec2( 0.0 );
rvSlope *= ${f(SWELL_TILT)};

float rvGust = smoothstep( 0.0, ${f(RIPPLE_RANGE)}, windAt( vRiverXZ ) - ${f(BREEZE_MAX)} );
vec2 rvD2 = vec2( uWindDir.x * ${f(Math.cos(RIPPLE_ROT))} - uWindDir.y * ${f(Math.sin(RIPPLE_ROT))}, uWindDir.x * ${f(Math.sin(RIPPLE_ROT))} + uWindDir.y * ${f(Math.cos(RIPPLE_ROT))} );
float rvK1 = ${f(TAU / RIPPLE_WAVE[0])};
float rvK2 = ${f(TAU / RIPPLE_WAVE[1])};
float rvQ1 = ( dot( vRiverXZ, uWindDir ) - ${f(RIPPLE_SPEED)} * uRiverT ) * rvK1;
float rvQ2 = ( dot( vRiverXZ, rvD2 ) - ${f(RIPPLE_SPEED)} * uRiverT ) * rvK2;
float rvRip = 0.6 * sin( rvQ1 ) + 0.4 * sin( rvQ2 );
vec2 rvRipG = 0.6 * cos( rvQ1 ) * rvK1 * uWindDir + 0.4 * cos( rvQ2 ) * rvK2 * rvD2;
rvSlope += rvRipG * ${f(RIPPLE_TILT)} * rvGust;

float rvDepth = pow( 1.0 - rvS * rvS, ${f(DEPTH_POW)} );
diffuseColor.rgb *= mix( vec3( 1.0 ), ${v3(deepRatio)}, ${f(DEPTH_MIX)} * rvDepth );
diffuseColor.rgb *= 1.0 + ${f(SWELL_LIGHT)} * rvH;

float rvFlow = rvAlong - ${f(FOAM_SPEED)} * uRiverT;
float rvSide = step( 0.0, rvS ) * 2.0 - 1.0;
float rvEdge = ${f(FOAM_EDGE)} + 0.045 * sin( rvFlow * 4.7 + rvSide * 2.0 ) + 0.025 * sin( rvFlow * 9.3 + rvSide + 1.0 );
float rvFoam = smoothstep( rvEdge, rvEdge + ${f(FOAM_SOFT)}, abs( rvS ) );
diffuseColor.rgb = mix( diffuseColor.rgb, ${v3(FOAM)}, ${f(FOAM_STRENGTH)} * rvFoam );

diffuseColor.rgb *= 1.0 - rvGust * ( ${f(RIPPLE_DARK)} - ${f(RIPPLE_FLICKER)} * rvRip );
`;

const FRAGMENT_NORMAL = /* glsl */ `
normal = normalize( normal + ( viewMatrix * vec4( -rvSlope.x, 0.0, -rvSlope.y, 0.0 ) ).xyz );
`;

// `len` is the river length in world units (riverCurve.getLength())
export function patchRiver(material, { wind, len }) {
	const uniforms = {
		uRiverT: { value: 0 },
		uRiverLen: { value: len },
	};
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, wind.uniforms, uniforms);
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', `#include <common>\n${VARYINGS}${COMMON}`)
			.replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\n${VARYINGS}${WIND_GLSL}${COMMON}`)
			.replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOR}`)
			.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAGMENT_NORMAL}`);
	};
	material.customProgramCacheKey = () => 'riverSurface';
	return {
		uniforms,
		update(t) {
			uniforms.uRiverT.value = t;
		},
	};
}
