// Shared wind for the whole island: a steady breeze plus gusts that sweep across as a band.
// Everything that sways (grass, trees, tassels, laundry, pinwheels, fluff, cloud shadows) reads the same
// field, so a gust visibly travels from one side of the island to the other.
//
// Field: s = x * DIR.x + z * DIR.y is the coordinate along the travel direction. Strength at (x, z):
//   breeze(s, t) + gustAmp * exp(-((s - gustS) / GUST_W)^2)        breeze 0.25 .. 0.55, with a gust up to ~1.6
// The lean / push direction is DIR (xz). JS reads it with at(x, z); shaders with the GLSL chunk below
// and the shared uniforms (add them to the material's uniforms in onBeforeCompile).
import * as THREE from 'three';
import { S } from './layout.js';

// travels left -> right as seen from the default camera
export const WIND_DIR = new THREE.Vector2(0.774, -0.633).normalize();

const BREEZE = 0.4;
const BREEZE_WAVE = 0.15;
// strongest the steady breeze gets; above this a gust is passing
export const BREEZE_MAX = BREEZE + BREEZE_WAVE;
const GUST_SPEED = 4.6; // units/s the gust band travels
const GUST_W = 1.8; // band half width
const GUST_FROM = S(-13); // band center starts / ends beyond the island
const GUST_TO = S(13);
const GUST_GAP = [2.5, 4.5]; // s between gusts

export const WIND_GLSL = /* glsl */ `
uniform float uWindT;
uniform float uGustS;
uniform float uGustAmp;
uniform vec2 uWindDir;
float windAt(vec2 xz) {
	float s = dot(xz, uWindDir);
	float breeze = ${BREEZE.toFixed(3)} + ${BREEZE_WAVE.toFixed(3)} * sin(uWindT * 0.9 - s * 0.6);
	float g = (s - uGustS) / ${GUST_W.toFixed(3)};
	return breeze + uGustAmp * exp(-g * g);
}
`;

export function createWind() {
	const uniforms = {
		uWindT: { value: 0 },
		uGustS: { value: GUST_FROM },
		uGustAmp: { value: 0 },
		uWindDir: { value: WIND_DIR },
	};
	let gustS = GUST_FROM;
	let gustAmp = 0;
	let nextGust = 3;
	let t = 0;

	function gust(amp = 0.75 + Math.random() * 0.25) {
		gustS = GUST_FROM;
		gustAmp = amp;
	}

	return {
		dir: WIND_DIR,
		uniforms,
		// strength at (x, z), same formula as windAt() in WIND_GLSL
		at(x, z) {
			const s = x * WIND_DIR.x + z * WIND_DIR.y;
			const g = (s - gustS) / GUST_W;
			return BREEZE + BREEZE_WAVE * Math.sin(t * 0.9 - s * 0.6) + gustAmp * Math.exp(-g * g);
		},
		// start a gust now (world.js fires one when the intro finishes)
		gust,
		update(dt) {
			t += dt;
			if (gustAmp > 0) {
				gustS += GUST_SPEED * dt;
				if (gustS > GUST_TO) gustAmp = 0;
			} else if ((nextGust -= dt) <= 0) {
				gust();
				nextGust = GUST_GAP[0] + Math.random() * (GUST_GAP[1] - GUST_GAP[0]);
			}
			uniforms.uWindT.value = t;
			uniforms.uGustS.value = gustS;
			uniforms.uGustAmp.value = gustAmp;
		},
	};
}
