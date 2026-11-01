// Knit-in intro and unravel outro for the diorama. The intro is the outro played backwards.
//
// Ground materials (terrain, rim, seams, river) get a shared patch: a fragment is kept while its rounded-square
// radius is inside the front value stored per angular bin (uKnit[]). Shadows use a matching
// customDepthMaterial, so the sun shadow follows the revealed ground exactly.
//
// Outro: a loose thread at the cushion's right edge (a Rope ending in a yarn pompom that tugs every few
// seconds) is grabbable; pulling it starts the unravel. The front shrinks toward the center, yarn streaks fly
// into a giant ball at the center that grows with the removed area, objects the front reaches squash and get
// sucked into the ball. The ball ends on a small felt mat.
//
// Intro: the same motion reversed. The ball lifts off its mat, the front grows out from the center while
// streaks fly from the ball to it and the ball shrinks with the area still to come. Each object flies out of
// the ball along its suck path backwards, lands squashed where the front has just passed and springs back to
// shape; clouds drop in from the sky. The ball vanishes when the front reaches the cushion.
//
// Page load starts in the 'ball' state: no world, the ball on its mat, and a loose pompom thread trailing
// from the ball toward the camera. Pulling that thread calls onStart (world.js resets the other modules
// and plays the intro; the thread reels into the ball while the ball shrinks away). The unravel ends in
// the same state, so the loop is: ball -> intro -> idle -> unravel -> ball.
//
// `hint` tells the DOM guide overlay where to point: { kind, point, dir } or null (see the return value).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rope } from './rope.js';
import { Spring } from './spring.js';
import { H, S } from './layout.js';
import { playBaa, playPop } from './sound.js';

// ---------------------------------------------------------------------------
// Feel knobs
// ---------------------------------------------------------------------------
const NB = 96; // angular bins of the front profile
const SCALLOP = 0.05; // stitch scallop amplitude of the edge
const EDGE_LINE = 0.08; // width of the bright live-stitch line along the edge

const LIFT_AT = 0.3; // s after the pull when the ball lifts off its mat
const INTRO_START = 1.0; // s of thread reel and ball lift before the front moves
const INTRO_T = 6.8; // s the front needs to grow from the center to the cushion
const LAUNCH_LEAD = 0.25; // objects leave the ball this much before the front reaches them
const LAND_T = 0.9; // s from touchdown until a landed object is settled
const POP_W = 15; // spring frequency (rad/s) of a landed object returning to shape
const POP_Z = 0.42; // spring damping ratio, 0.42 overshoots by ~23%
const CLOUD_LAND_T = 1.3; // s a cloud takes to drop in

const WARM_FRAMES = 2; // frames the hidden world renders at page load to compile its shaders

const PULL_TRIGGER = 0.3; // thread pull beyond its reach that starts the unravel / the intro

const THREAD_RADIUS = 0.06;
const POMPOM_R = 0.09; // yarn pompom at the free tip of both threads
const POMPOM_PICK_R = 0.2; // a ray this close to the pompom grabs the tip
const WIGGLE_EVERY = 5; // s between tugs while a thread is live and not held
const WIGGLE_FIRST = 1.5; // s after the thread appears until its first tug
const WIGGLE_T = 0.7; // s one tug lasts
const WIGGLE_SPEED = 3.2; // peak sideways speed of the tip during a tug
const WIGGLE_LIFT = 0.25; // peak upward speed of the tip during a tug
const WIGGLE_POINTS = 7; // rope particles at the tail that move
const COLLAPSE_HINT_T = 6; // s after the intro ends that hint reports 'collapse'
const BALL_THREAD_DIR = [0.55, 0.83]; // xz direction the ball thread trails (toward the default camera)
const BALL_THREAD_Y = -0.68; // anchor height on the unit ball, relative to its center
const BALL_REEL_T = 0.9; // s the ball thread takes to wind into the ball when the intro starts

const UNRAVEL_START = 0.8; // thread reels in and the ball pops before the front moves
const UNRAVEL_T = 6.8; // s the front needs to reach the center
const FINAL_T = 1.5; // s of settling (mat, drop) before the ball state
const RHO0 = H + 0.2; // radial front start / end (world units from the center)
const RHO1 = -0.3;
const NOTCH = 0.5; // how far the rotating notch cuts ahead of the radial front
const NOTCH_SIGMA = 0.16; // rad
const SCAN_SPEED = 2.6; // rad/s of the notch
const BALL_R0 = 0.3;
const BALL_RMAX = 1.2;
const BALL_SINK = 0.14; // fraction of the radius sunk into the ground / mat
const MAT_R = 1.9;
const MAT_TOP = 0.09;
const SUCK_MARGIN = 0.35; // objects trigger this much before the front reaches them
const SQUASH_T = 0.2;
const CLOUD_RHO = [S(4.6), S(3.4), S(2.4)];
const CLOUD_RISE = 13;
const STREAK_N = 44;
const STREAK_RATE = 24; // per second while the front moves

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => {
	const t = clamp01(x);
	return t * t * (3 - 2 * t);
};
// step response of a damped spring from 0 to 1
function springOut(t, w, z) {
	if (t <= 0) return 0;
	const wd = w * Math.sqrt(1 - z * z);
	return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}
const easeUnravel = (p) => p * 0.55 + smooth(p) * 0.45;
const sE = (gx, gz) => {
	const a = gx * gx;
	const b = gz * gz;
	return Math.pow(a * a * a * a + b * b * b * b, 0.125);
};
function rng(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// Ground patch (shared by every knitted-ground material and the depth material)
// ---------------------------------------------------------------------------
const f4 = (v) => v.toFixed(5);

function knitGlsl(H) {
	return /* glsl */ `
#define KNIT_NB ${NB}
#define KNIT_H ${f4(H)}
uniform float uKnit[ KNIT_NB ];
varying vec2 vKnitXZ;

// distance inside the front (negative = not visible); the front is a rounded-square radius per angle
float knitMargin( vec2 xz ) {
	vec2 q = xz / KNIT_H;
	vec2 q2 = q * q;
	vec2 q4 = q2 * q2;
	vec2 q8 = q4 * q4;
	float a = pow( q8.x + q8.y + 1e-12, 0.125 ) * KNIT_H;
	float ang = atan( xz.y, xz.x );
	float t = ( ang / 6.2831853 + 0.5 ) * float( KNIT_NB );
	float sc = ${f4(SCALLOP)} * abs( sin( ang * 52.0 ) );
	int i0 = min( int( floor( t ) ), KNIT_NB - 1 );
	float fr = t - float( i0 );
	int i1 = i0 + 1;
	if ( i1 >= KNIT_NB ) i1 = 0;
	return mix( uKnit[ i0 ], uKnit[ i1 ], fr ) + sc - a;
}
`;
}

// Patch the ground materials. `uniforms` is the single shared uniform set.
function makeGroundPatch(H, uniforms) {
	const common = knitGlsl(H);
	const colorPatch = (shader) => {
		shader.uniforms.uKnit = uniforms.uKnit;
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', `#include <common>\n${common}`)
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvKnitXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\n${common}`)
			.replace(
				'#include <color_fragment>',
				`#include <color_fragment>
{
	float knitD = knitMargin( vKnitXZ );
	if ( knitD < 0.0 ) discard;
	float knitEdge = 1.0 - smoothstep( 0.0, ${f4(EDGE_LINE)}, knitD );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.97, 0.9, 0.78 ), 0.5 * knitEdge );
}`,
			);
	};
	const depthPatch = (shader) => {
		shader.uniforms.uKnit = uniforms.uKnit;
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', `#include <common>\n${common}`)
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvKnitXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\n${common}`)
			.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif ( knitMargin( vKnitXZ ) < 0.0 ) discard;');
	};
	// items flagged `clip` (grass tufts): discard beyond the front, no edge tint; instance aware
	const clipPatch = (shader) => {
		shader.uniforms.uKnit = uniforms.uKnit;
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', `#include <common>\n${common}`)
			.replace(
				'#include <begin_vertex>',
				`#include <begin_vertex>
#ifdef USE_INSTANCING
vKnitXZ = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xz;
#else
vKnitXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;
#endif`,
			);
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\n${common}`)
			.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif ( knitMargin( vKnitXZ ) < 0.0 ) discard;');
	};
	const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
	depthMaterial.onBeforeCompile = depthPatch;
	return { colorPatch, clipPatch, depthMaterial };
}

// ---------------------------------------------------------------------------
// Big yarn ball (unit radius, scaled by the caller) and its mat
// ---------------------------------------------------------------------------
function buildBigBall(kit) {
	const { mat, sphereRep, P } = kit;
	const rand = rng(5150);
	const spin = new THREE.Group();
	const meshes = [];
	const add = (parent, mesh) => {
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		parent.add(mesh);
		meshes.push(mesh);
		return mesh;
	};

	add(spin, new THREE.Mesh(new THREE.SphereGeometry(0.97, 48, 32), mat(P.coralDeep, 'stockinette', sphereRep(0.97))));

	// wound strands: helical arcs hugging the sphere, merged per color
	const colors = [P.coral, P.pink, P.coralDeep];
	const lists = colors.map(() => []);
	for (let i = 0; i < 66; i++) {
		const a = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
		const ref = Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
		const bu = new THREE.Vector3().crossVectors(a, ref).normalize();
		const bv = new THREE.Vector3().crossVectors(a, bu);
		const r = 0.98 + (rand() - 0.5) * 0.05;
		const span = Math.PI * (1.5 + rand() * 0.4);
		const phi0 = rand() * TAU;
		const h0 = (rand() - 0.5) * 0.6 * r;
		const dh = (rand() - 0.5) * 0.7 * r;
		const pts = [];
		for (let k = 0; k <= 40; k++) {
			const f = k / 40;
			const phi = phi0 + f * span;
			const h = THREE.MathUtils.clamp(h0 + dh * f, -0.85 * r, 0.85 * r);
			const rr = Math.sqrt(r * r - h * h);
			pts.push(
				new THREE.Vector3()
					.addScaledVector(bu, Math.cos(phi) * rr)
					.addScaledVector(bv, Math.sin(phi) * rr)
					.addScaledVector(a, h),
			);
		}
		lists[i % 3].push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.058, 6, false));
	}
	lists.forEach((list, i) => {
		add(spin, new THREE.Mesh(mergeGeometries(list), mat(colors[i], 'strand', [16, 1])));
		list.forEach((g) => g.dispose());
	});

	return { spin, meshes };
}

// round felt mat under the finished ball; origin at the mat center on the blanket (floorY)
function buildMat(kit) {
	const { mat, P } = kit;
	const g = new THREE.Group();
	const top = new THREE.Mesh(new THREE.CylinderGeometry(MAT_R, MAT_R + 0.03, MAT_TOP, 72, 1), mat(P.sage, 'garter', [38, 38]));
	top.position.y = MAT_TOP / 2;
	top.castShadow = true;
	top.receiveShadow = true;
	g.add(top);
	const ring = new THREE.Mesh(new THREE.TorusGeometry(MAT_R + 0.01, 0.05, 8, 96), mat(P.coral, 'strand', [32, 1]));
	ring.rotation.x = Math.PI / 2;
	ring.position.y = MAT_TOP - 0.005;
	ring.castShadow = true;
	ring.receiveShadow = true;
	g.add(ring);
	top.raycast = () => {};
	ring.raycast = () => {};
	return g;
}

// ---------------------------------------------------------------------------
// setupWeave
//   root       scene group of the world
//   ground     group holding terrain, rim, seams and river (patched with the knit front)
//   items      [{ obj, stage, base?, follow?, drop?, clip? }] things that pop in / get sucked away. clip: also cut
//              pixel by pixel at the knit front, for items spread over a wide area (grass). obj is wrapped in a
//              group scaled about its base: base = given vector, or follow.position - (0, drop, 0), or obj.position,
//              or the bottom center of obj's bounds
//   floorY     top height of the blanket under the island; the felt mat and the finished ball rest on it
//   kit        { mat, sphereRep, P } from world.js
//   H          island half size
//   groundAt   ground height sampler
//   thread     { path: Vector3[] } polyline of the loose thread, first point is where it leaves the cushion
//   onStart    called when the ball's thread is pulled (world.js resets the other modules, then playIntro)
//
// Returns { update, playIntro, restore, grabbable, busy, hint }
//   hint  null, or { kind: 'start' | 'collapse', point, dir } (the same objects every call, do not keep them):
//         point = world position of the thread's pompom, dir = unit xz vector (y = 0) to drag toward to pull
//         the thread. 'start': state 'ball' with the ball thread live and not held. 'collapse': the first
//         COLLAPSE_HINT_T s after the intro ends while the edge thread is not held.
// ---------------------------------------------------------------------------
export function setupWeave({ root, ground, items: specs, kit, H, groundAt, thread, floorY, onStart }) {
	const { mat, sphereRep, P } = kit;
	let state = 'ball'; // intro | idle | unravel | ball
	let clock = 0;

	const group = new THREE.Group();
	group.name = 'weave';
	root.add(group);
	const claimed = new Set([group, ground]);

	// ---- shared front profile and ground patch ---------------------------------------------------
	const edge = new Float32Array(NB);
	const uniforms = { uKnit: { value: edge } };
	const binA = new Float32Array(NB);
	for (let i = 0; i < NB; i++) binA[i] = (i / NB - 0.5) * TAU;
	const { colorPatch, clipPatch, depthMaterial } = makeGroundPatch(H, uniforms);
	// swap every mesh material under obj for a clone that runs the material's own patch (river surface,
	// wind bend) first and `patch` on top
	const patchMaterials = (obj, patch, key) => {
		const clones = new Map();
		obj.traverse((o) => {
			if (!o.isMesh) return;
			let m = clones.get(o.material);
			if (!m) {
				const own = o.material.onBeforeCompile;
				const ownKey = o.material.customProgramCacheKey();
				const src = o.material;
				m = src.clone();
				m.onBeforeCompile = (shader, renderer) => {
					own.call(src, shader, renderer);
					patch(shader);
				};
				m.customProgramCacheKey = () => `${ownKey}|${key}`;
				clones.set(src, m);
			}
			o.material = m;
		});
	};
	patchMaterials(ground, colorPatch, 'knitFront');
	ground.traverse((o) => {
		if (o.isMesh) o.customDepthMaterial = depthMaterial;
	});

	// ---- items -----------------------------------------------------------------------------------
	const box = new THREE.Box3();
	const counts = {};
	const items = specs.map((spec) => {
		const w = new THREE.Group();
		root.add(w);
		w.add(spec.obj);
		claimed.add(w);
		if (spec.clip) patchMaterials(spec.obj, clipPatch, 'knitClip');
		const it = {
			w,
			obj: spec.obj,
			stage: spec.stage,
			k: (counts[spec.stage] = (counts[spec.stage] ?? -1) + 1),
			base: new THREE.Vector3(),
			follow: spec.follow ?? null,
			drop: spec.drop ?? 0,
			own: false,
			tPop: 0,
			popped: false,
			done: false,
			last: false,
			rho: 0,
			phase: 0,
			pt: 0,
			dur: 1,
			arc: 0.5,
		};
		if (spec.base) it.base.copy(spec.base);
		else if (!it.follow && spec.obj.position.lengthSq() > 1e-8) it.own = true;
		else if (!it.follow) {
			box.setFromObject(spec.obj);
			box.getCenter(it.base);
			it.base.y = box.min.y;
		}
		return it;
	});
	const refreshBase = (it) => {
		if (it.follow) {
			it.base.copy(it.follow.position);
			it.base.y -= it.drop;
		} else if (it.own) it.base.copy(it.obj.position);
	};
	// scale (sx, sy, sz) about the base while the base point sits at (ax, ay, az)
	const place = (it, sx, sy, sz, ax, ay, az) => {
		it.w.scale.set(sx, sy, sz);
		it.w.position.set(ax - sx * it.base.x, ay - sy * it.base.y, az - sz * it.base.z);
	};
	const hideItem = (it) => {
		it.w.visible = false;
		it.w.scale.setScalar(1e-4);
		it.w.position.set(0, 0, 0);
	};
	const resetItem = (it) => {
		it.w.visible = true;
		it.w.scale.setScalar(1);
		it.w.position.set(0, 0, 0);
	};

	// ---- unknown root children (ropes, balls, fruit, ...) hidden while the world is not there --------
	const unknownHidden = []; // intro
	const unknownVis = [];
	const outroHidden = []; // outro
	const outroRho = [];
	const hideUnknown = () => {
		// children an earlier intro or the outro already hid keep their saved visibility
		const oldHidden = unknownHidden.slice();
		const oldVis = unknownVis.slice();
		unknownHidden.length = 0;
		unknownVis.length = 0;
		for (const c of root.children) {
			if (claimed.has(c)) continue;
			const old = oldHidden.indexOf(c);
			unknownHidden.push(c);
			unknownVis.push(old >= 0 ? oldVis[old] : outroHidden.includes(c) ? true : c.visible);
			c.visible = false;
		}
		outroHidden.length = 0;
	};
	const showUnknown = () => {
		for (let i = 0; i < unknownHidden.length; i++) unknownHidden[i].visible = unknownVis[i];
		unknownHidden.length = 0;
		unknownVis.length = 0;
	};
	// undo whatever the intro or outro hid; world.js calls this before it resets the other modules
	const restore = () => {
		showUnknown();
		for (const c of outroHidden) c.visible = true;
		outroHidden.length = 0;
	};

	// ---- big ball, mat, streaks ----------------------------------------------------------------------
	const BC_X = 0;
	const BC_Z = 0;
	const BASE_Y = groundAt(BC_X, BC_Z);
	const bigBall = buildBigBall(kit);
	const bigRoot = new THREE.Group(); // position + world-vertical squash
	bigRoot.add(bigBall.spin);
	bigRoot.visible = false;
	group.add(bigRoot);
	const matG = buildMat(kit);
	matG.visible = false;
	group.add(matG);
	matG.position.set(BC_X, floorY, BC_Z); // the mat lies on the blanket
	const ballR = new Spring(140, 12, 0);
	const kick = new Spring(260, 10, 0);
	const drop = new Spring(110, 9, 0);
	const matSpring = new Spring(160, 13, 0);
	const ballPos = new THREE.Vector3(BC_X, BASE_Y, BC_Z);
	const spinAxis = new THREE.Vector3(0.35, 0.8, 0.45).normalize();
	let influx = 0;
	for (const m of bigBall.meshes) m.raycast = () => {};

	// area table: fraction of the island inside radius rho
	const AREA_N = 64;
	const areaCum = new Float32Array(AREA_N + 1);
	{
		const g = 120;
		for (let j = 0; j < g; j++) {
			for (let i = 0; i < g; i++) {
				const m = sE(((i + 0.5) / g) * 2 - 1, ((j + 0.5) / g) * 2 - 1);
				if (m < 1) areaCum[Math.floor(m * AREA_N) + 1]++;
			}
		}
		for (let k = 1; k <= AREA_N; k++) areaCum[k] += areaCum[k - 1];
		const total = areaCum[AREA_N];
		for (let k = 0; k <= AREA_N; k++) areaCum[k] /= total;
	}
	const removedFrac = (rho) => {
		const m = clamp01(rho / H) * AREA_N;
		const i = Math.min(AREA_N - 1, Math.floor(m));
		return 1 - lerp(areaCum[i], areaCum[i + 1], m - i);
	};
	const radiusFor = (frac) => Math.cbrt(BALL_R0 ** 3 + (BALL_RMAX ** 3 - BALL_R0 ** 3) * frac);
	const rhoOf = (x, z) => sE(x / H, z / H) * H;

	const streakGeo = new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(0, 0, -0.25), new THREE.Vector3(0, 0, 0.25)), 4, 0.03, 6, false);
	const streakMesh = new THREE.InstancedMesh(streakGeo, mat('#ffffff', 'strand', [1, 1]), STREAK_N);
	streakMesh.frustumCulled = false;
	streakMesh.castShadow = false;
	streakMesh.raycast = () => {};
	const palette = [P.coral, P.pink, P.cream, P.mustard, P.sage].map((c) => new THREE.Color(c));
	const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
	const streaks = [];
	for (let i = 0; i < STREAK_N; i++) {
		streaks.push({ on: false, out: false, t: 0, dur: 1, p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3() });
		streakMesh.setMatrixAt(i, zeroM);
		streakMesh.setColorAt(i, palette[i % palette.length]);
	}
	group.add(streakMesh);
	let streakDirty = false;
	let streakActive = 0;
	const sPos = new THREE.Vector3();
	const sTan = new THREE.Vector3();
	const sScale = new THREE.Vector3();
	const sQuat = new THREE.Quaternion();
	const sMat = new THREE.Matrix4();
	const sRot = new THREE.Matrix4();
	const ZERO = new THREE.Vector3();
	const UP = new THREE.Vector3(0, 1, 0);

	// a streak between the ground at (theta, rho) and the ball; out: from the ball to the ground (intro)
	function spawnStreak(theta, rho, out = false) {
		const s = streaks.find((q) => !q.on);
		if (!s) return;
		const x = Math.cos(theta) * rho;
		const z = Math.sin(theta) * rho;
		s.on = true;
		s.t = 0;
		s.dur = 0.55 + Math.random() * 0.35;
		s.p0.set(x, groundAt(x, z) + 0.06, z);
		const r = ballR.value * 0.85;
		const dx = ballPos.x - x;
		const dz = ballPos.z - z;
		const dl = Math.hypot(dx, dz) || 1;
		s.p2.set(ballPos.x - (dx / dl) * r, ballPos.y + 0.1, ballPos.z - (dz / dl) * r);
		s.p1.lerpVectors(s.p0, s.p2, 0.5);
		s.p1.y += 0.7 + 0.12 * dl;
		s.out = out;
		if (out) {
			sPos.copy(s.p0);
			s.p0.copy(s.p2);
			s.p2.copy(sPos);
			influx = Math.min(2, influx + 0.2);
			kick.kick(0.5);
		}
		streakActive++;
		streakDirty = true;
	}
	function stepStreaks(dt) {
		if (!streakActive && !streakDirty) return;
		for (let i = 0; i < STREAK_N; i++) {
			const s = streaks[i];
			if (!s.on) continue;
			s.t += dt;
			const a = s.t / s.dur;
			if (a >= 1) {
				s.on = false;
				streakActive--;
				streakMesh.setMatrixAt(i, zeroM);
				if (!s.out) {
					influx = Math.min(2, influx + 0.2);
					kick.kick(0.5);
				}
				continue;
			}
			const b = 1 - a;
			sPos.set(0, 0, 0).addScaledVector(s.p0, b * b).addScaledVector(s.p1, 2 * b * a).addScaledVector(s.p2, a * a);
			sTan.set(0, 0, 0).addScaledVector(s.p0, -2 * b).addScaledVector(s.p1, 2 * (b - a)).addScaledVector(s.p2, 2 * a);
			sRot.lookAt(ZERO, sTan, UP);
			sQuat.setFromRotationMatrix(sRot);
			const fade = smooth(Math.min(a, 1 - a) * 6);
			sScale.set(fade, fade, 0.6 + 0.8 * fade);
			sMat.compose(sPos, sQuat, sScale);
			streakMesh.setMatrixAt(i, sMat);
		}
		streakMesh.instanceMatrix.needsUpdate = true;
		streakDirty = false;
	}
	const clearStreaks = () => {
		for (let i = 0; i < STREAK_N; i++) {
			streaks[i].on = false;
			streakMesh.setMatrixAt(i, zeroM);
		}
		streakActive = 0;
		streakMesh.instanceMatrix.needsUpdate = true;
	};

	function updateBall(dt) {
		ballR.update(dt);
		kick.update(dt);
		drop.update(dt);
		matSpring.update(dt);
		influx *= Math.exp(-3 * dt);
		const r = Math.max(1e-3, ballR.value);
		const q = kick.value;
		bigRoot.scale.set(1 + 0.1 * q, 1 - 0.16 * q, 1 + 0.1 * q);
		bigBall.spin.scale.setScalar(r);
		bigBall.spin.rotateOnAxis(spinAxis, (state === 'ball' ? 0.2 : 1.5 + 5 * influx) * dt);
		const bottom = lerp(BASE_Y, floorY + MAT_TOP, drop.value);
		bigRoot.position.set(BC_X, bottom + r * bigRoot.scale.y * (1 - BALL_SINK), BC_Z);
		ballPos.copy(bigRoot.position);
		const ms = Math.max(1e-3, matSpring.value);
		matG.scale.setScalar(ms);
		matG.visible = matSpring.value > 0.01;
		ballCollider.radius = r * 0.97;
		if (ballR.target === 0 && ballR.value < 0.02) {
			bigRoot.visible = false;
			matG.visible = false;
		}
	}

	// ---- threads: the edge thread (outro handle) and the ball thread (intro handle) ----------------------
	// each is a Rope ending in a pompom that follows the last particle and tugs now and then
	const BDL = Math.hypot(BALL_THREAD_DIR[0], BALL_THREAD_DIR[1]);
	const BDX = BALL_THREAD_DIR[0] / BDL;
	const BDZ = BALL_THREAD_DIR[1] / BDL;
	const BEH = Math.sqrt(1 - BALL_THREAD_Y * BALL_THREAD_Y); // anchor distance from the ball axis on the unit ball
	const ballCollider = { center: ballPos, radius: BALL_RMAX };
	const matTop = (x, z) => (Math.hypot(x - BC_X, z - BC_Z) < MAT_R + 0.02 ? floorY + MAT_TOP : -40);
	const pomGeo = new THREE.SphereGeometry(POMPOM_R, 20, 14);
	const pomMat = mat(P.mustard, 'boucle', sphereRep(POMPOM_R));
	const threadMat = mat(P.mustard, 'strand', [1, 1]);

	function makeHandle(groundFn, anchor, colliders) {
		const rope = new Rope({ groundAt: groundFn, material: threadMat, maxPoints: 120, radius: THREAD_RADIUS, colliders });
		rope.mesh.visible = false;
		group.add(rope.mesh);
		const pom = new THREE.Mesh(pomGeo, pomMat);
		pom.castShadow = true;
		pom.receiveShadow = true;
		pom.raycast = () => {};
		pom.visible = false;
		group.add(pom);
		return { rope, pom, anchor, live: false, held: false, reel: false, idleT: 0, wiggleT: -1, wiggleSign: 1 };
	}
	const edgeH = makeHandle(groundAt, thread.path[0].clone(), []);
	const ballH = makeHandle(matTop, new THREE.Vector3(), [ballCollider]);
	const pullDir = new THREE.Vector3();
	const pickSphere = new THREE.Sphere();
	const pickPt = new THREE.Vector3();
	let pickHandle = edgeH;
	let pickIndex = 3;

	const syncPom = (h) => {
		const n = h.rope.count;
		if (n < 1) return;
		h.rope.positionOf(n - 1, h.pom.position);
		h.pom.position.y += POMPOM_R - THREAD_RADIUS;
	};
	function showHandle(h, path) {
		h.rope.mesh.visible = true;
		h.rope.setPath(path);
		h.rope.setAnchor(h.anchor);
		h.rope.settle(3);
		h.live = true;
		h.held = false;
		h.reel = false;
		h.idleT = WIGGLE_EVERY - WIGGLE_FIRST;
		h.wiggleT = -1;
		syncPom(h);
		h.pom.visible = true;
	}
	function hideHandle(h) {
		h.live = false;
		h.held = false;
		h.reel = false;
		h.wiggleT = -1;
		h.rope.releaseAll();
		h.rope.mesh.visible = false;
		h.pom.visible = false;
	}
	// stop grabbing and wind the thread into its anchor
	function startReel(h) {
		h.rope.releaseAll();
		h.live = false;
		h.held = false;
		h.wiggleT = -1;
		h.reel = true;
	}
	function stepReel(h, dt, until) {
		let ok = true;
		for (let i = 0; i < 3 && ok; i++) ok = h.rope.reel();
		if (!ok || clock > until) {
			hideHandle(h);
			return;
		}
		h.rope.setAnchor(h.anchor);
		h.rope.update(dt);
		syncPom(h);
	}
	// tug: the last particles swing sideways and hop (moved together with their previous positions, so no velocity is injected)
	function wiggle(h, dt) {
		h.wiggleT += dt;
		if (h.wiggleT >= WIGGLE_T) {
			h.wiggleT = -1;
			return;
		}
		const { rope } = h;
		const { pos, prev } = rope;
		const n = rope.count;
		const a = h.wiggleT / WIGGLE_T;
		const env = Math.sin(Math.PI * a);
		const side = WIGGLE_SPEED * dt * env * Math.sin(a * TAU * 2.5) * h.wiggleSign;
		const lift = WIGGLE_LIFT * dt * env;
		const k1 = (n - 1) * 3;
		const k0 = Math.max(0, n - 1 - WIGGLE_POINTS) * 3;
		const tx = pos[k1] - pos[k0];
		const tz = pos[k1 + 2] - pos[k0 + 2];
		const tl = Math.hypot(tx, tz) || 1;
		const px = (-tz / tl) * side;
		const pz = (tx / tl) * side;
		for (let j = 1; j <= WIGGLE_POINTS; j++) {
			const i = n - j;
			if (i < 3) break;
			const w = 1 - (j - 1) / WIGGLE_POINTS;
			const k = i * 3;
			pos[k] += px * w;
			prev[k] += px * w;
			pos[k + 1] += lift * w;
			prev[k + 1] += lift * w;
			pos[k + 2] += pz * w;
			prev[k + 2] += pz * w;
		}
		rope.wake();
	}
	function stepHandle(h, dt) {
		if (h.held) h.wiggleT = -1;
		else if (h.wiggleT < 0 && (h.idleT += dt) >= WIGGLE_EVERY) {
			h.idleT = 0;
			h.wiggleT = 0;
			h.wiggleSign = -h.wiggleSign;
		}
		if (h.wiggleT >= 0) wiggle(h, dt);
		h.rope.setAnchor(h.anchor);
		h.rope.update(dt);
		syncPom(h);
	}

	// pick covers whichever thread is live in the current state; a ray near the pompom grabs the tip
	const grabbable = {
		pick(ray, camera) {
			const h = state === 'idle' ? edgeH : state === 'ball' ? ballH : null;
			if (!h || !h.live) return null;
			pickHandle = h;
			pickSphere.center.copy(h.pom.position);
			pickSphere.radius = POMPOM_PICK_R;
			if (ray.intersectSphere(pickSphere, pickPt)) {
				pickIndex = h.rope.count - 1;
				return { distance: pickPt.distanceTo(ray.origin) };
			}
			const hit = h.rope.pick(ray, camera);
			if (!hit) return null;
			pickIndex = hit.index;
			return { distance: hit.distance };
		},
		grab() {
			const h = pickHandle;
			const g = h.rope.grab(pickIndex);
			if (!g) return { move() {}, release() {} };
			h.held = true;
			h.idleT = 0;
			return {
				move: (target) => g.move(target),
				release: () => {
					g.release();
					h.held = false;
					h.idleT = 0;
				},
			};
		},
	};

	// ---- ball state: the ball thread leaves low on the camera side and trails over the mat -----------------
	const ballPath = Array.from({ length: 6 }, () => new THREE.Vector3());
	// fixed point on the ball surface (follows the ball's center and radius)
	const ballAnchor = (out) => {
		const r = Math.max(1e-3, ballR.value) * 0.99;
		return out.set(ballPos.x + BDX * BEH * r, ballPos.y + BALL_THREAD_Y * r, ballPos.z + BDZ * BEH * r);
	};
	function layBallThread() {
		ballAnchor(ballH.anchor);
		const y = floorY + MAT_TOP + 0.05;
		// [distance from the ball axis along the trail direction, sideways offset, height]; curls along the mat, inside MAT_R
		const spec = [
			[BEH * BALL_RMAX * 0.99, 0, ballH.anchor.y],
			[1.12, 0.04, floorY + 0.2],
			[1.42, 0.12, y],
			[1.6, 0.42, y],
			[1.6, 0.8, y],
			[1.4, 1.1, y],
		];
		spec.forEach(([s, l, py], i) => ballPath[i].set(BC_X + BDX * s - BDZ * l, py, BC_Z + BDZ * s + BDX * l));
		showHandle(ballH, ballPath);
	}
	// page load: the finished ball on its mat on the blanket, no world
	function showBall() {
		state = 'ball';
		clock = 0;
		edge.fill(-99);
		ground.visible = false;
		ground.scale.setScalar(1e-4);
		for (const it of items) hideItem(it);
		hideUnknown();
		clearStreaks();
		hideHandle(edgeH);
		bigRoot.visible = true;
		matG.visible = true;
		ballR.snap(BALL_RMAX);
		kick.snap(0);
		drop.snap(1);
		matSpring.snap(1);
		influx = 0;
		updateBall(0);
		layBallThread();
	}
	// page load: the hidden ground and items render for WARM_FRAMES frames at 1e-4 scale (ground fully
	// discarded by the front), so their color and shadow programs compile before the intro needs them
	let warm = WARM_FRAMES;
	const endWarm = () => {
		if (state !== 'ball') return;
		ground.visible = false;
		for (const it of items) hideItem(it);
	};
	function stepBall(dt) {
		stepHandle(ballH, dt);
		if (ballH.rope.pullExcess(pullDir) > PULL_TRIGGER) onStart?.();
	}

	// ---- intro: the outro played backwards ----------------------------------------------------------------
	let popCount = 0;
	let lastSheep = null;
	let ballGone = false;
	const introRho = []; // per unknownHidden child: radius where the front gives it back

	function playIntro() {
		state = 'intro';
		clock = 0;
		popCount = 0;
		thS = 0;
		spawnAcc = 0;
		ballGone = false;
		edge.fill(RHO1 - 0.4);
		ground.visible = true;
		ground.scale.setScalar(1);

		// world objects wait hidden inside the ball until the front nears them
		lastSheep = null;
		for (const it of items) {
			refreshBase(it);
			hideItem(it);
			it.phase = 0;
			it.pt = 0;
			it.rho = it.stage === 'cloud' ? CLOUD_RHO[it.k % CLOUD_RHO.length] : rhoOf(it.base.x, it.base.z);
			if (it.stage === 'sheep' && (!lastSheep || it.rho > lastSheep.rho)) lastSheep = it;
		}
		hideUnknown();
		introRho.length = 0;
		for (const c of unknownHidden) introRho.push(c.position.lengthSq() < 1e-6 ? H * 0.5 : rhoOf(c.position.x, c.position.z));

		clearStreaks();
		hideHandle(edgeH);
		if (ballH.live) startReel(ballH);
		else if (!ballH.reel) hideHandle(ballH);

		// start from the finished ball on its mat (a no-op when coming from the ball state)
		bigRoot.visible = true;
		ballR.snap(BALL_RMAX);
		kick.snap(0);
		drop.snap(1);
		matSpring.snap(1);
		influx = 0;
	}

	function startLaunch(it) {
		refreshBase(it);
		it.phase = 1;
		it.pt = 0;
		it.w.visible = true;
		if (it.stage === 'cloud') {
			it.dur = CLOUD_LAND_T;
			return;
		}
		const dist = Math.hypot(it.base.x - ballPos.x, it.base.z - ballPos.z);
		it.dur = THREE.MathUtils.clamp(0.42 + 0.06 * dist, 0.5, 0.95);
		it.arc = 0.5 + 0.1 * dist;
		kick.kick(4);
		influx = Math.min(2, influx + 1);
		playPop({ pitch: Math.min(1.9, 0.8 + 0.035 * popCount++) });
	}

	// phase 1: flight out of the ball (the suck path backwards), phase 2: squashed touchdown springing back
	function stepLaunch(it, dt) {
		it.pt += dt;
		refreshBase(it);
		const b = it.base;
		if (it.stage === 'cloud') {
			const s = springOut(it.pt, 6.5, 0.78);
			it.w.position.set(0, CLOUD_RISE * (1 - s), 0);
			it.w.scale.setScalar(1);
			if (it.pt >= it.dur) {
				it.phase = 3;
				resetItem(it);
			}
			return;
		}
		if (it.phase === 1) {
			const a = clamp01(it.pt / it.dur);
			const ea = (1 - a) * (1 - a);
			const sx = Math.max(1e-3, lerp(1.14, 0.02, ea));
			const sy = Math.max(1e-3, lerp(0.62, 0.02, ea));
			place(
				it,
				sx,
				sy,
				sx,
				lerp(b.x, ballPos.x, ea),
				lerp(b.y, ballPos.y, ea) + it.arc * Math.sin(Math.PI * a),
				lerp(b.z, ballPos.z, ea),
			);
			if (a >= 1) {
				it.phase = 2;
				it.pt = 0;
				if (it === lastSheep) playBaa();
			}
			return;
		}
		const s = springOut(it.pt, POP_W, POP_Z);
		const sxz = lerp(1.14, 1, s);
		place(it, sxz, lerp(0.62, 1, s), sxz, b.x, b.y, b.z);
		if (it.pt >= LAND_T) {
			it.phase = 3;
			resetItem(it);
		}
	}

	function stepIntro(dt) {
		if (clock >= LIFT_AT && drop.target !== 0) {
			// the ball lifts off its mat to the island's center height
			drop.target = 0;
			matSpring.target = 0;
			kick.kick(5);
			playPop({ pitch: 1.2 });
		}

		const moving = clock >= INTRO_START;
		const p = clamp01((clock - INTRO_START) / INTRO_T);
		const rhoF = lerp(RHO1, RHO0, 1 - easeUnravel(1 - p));
		if (moving && p < 1) {
			// front: steady radius plus a notch that circles and leads; only ever grows
			thS += dt * SCAN_SPEED;
			for (let i = 0; i < NB; i++) {
				let d = binA[i] - thS;
				d -= TAU * Math.round(d / TAU);
				d /= NOTCH_SIGMA;
				const v = rhoF + NOTCH * Math.exp(-d * d);
				if (v > edge[i]) edge[i] = v;
			}
			// yarn streaks from the ball to where the notch will be when they land
			spawnAcc += dt * STREAK_RATE;
			while (spawnAcc >= 1) {
				spawnAcc -= 1;
				spawnStreak(thS + 1.2 + (Math.random() - 0.5) * 1.6, Math.max(0.5, rhoF + 0.5), true);
			}
		}
		if (moving) {
			if (p < 1) ballR.target = radiusFor(removedFrac(Math.max(0, rhoF)));
			else if (!ballGone) {
				ballGone = true;
				edge.fill(99);
				ballR.target = 0;
				kick.kick(4);
				playPop({ pitch: 0.7 });
			}
		}

		let allDone = true;
		for (const it of items) {
			if (it.phase === 0 && moving && rhoF > it.rho - LAUNCH_LEAD) startLaunch(it);
			if (it.phase === 1 || it.phase === 2) stepLaunch(it, dt);
			if (it.phase !== 3) allDone = false;
		}
		// unknown children (ropes, fruit, critters) come back once the ground under them is there
		for (let i = unknownHidden.length - 1; i >= 0; i--) {
			if (rhoF < introRho[i] + SUCK_MARGIN) continue;
			unknownHidden[i].visible = unknownVis[i];
			unknownHidden.splice(i, 1);
			unknownVis.splice(i, 1);
			introRho.splice(i, 1);
		}

		if (ballGone && allDone && streakActive === 0) finishIntro();
	}

	function finishIntro() {
		state = 'idle';
		clock = 0;
		for (const it of items) resetItem(it);
		showUnknown();
		edge.fill(99);
		// the loose thread appears at the cushion corner
		showHandle(edgeH, thread.path);
		playPop({ pitch: 1.9 });
	}

	// ---- idle / outro ------------------------------------------------------------------------------------
	function stepIdle(dt) {
		stepHandle(edgeH, dt);
		if (edgeH.rope.pullExcess(pullDir) > PULL_TRIGGER) startUnravel();
	}

	let thS = 0;
	let spawnAcc = 0;
	let finalAt = -1;
	let baaed = false;
	function startUnravel() {
		state = 'unravel';
		clock = 0;
		thS = 0;
		spawnAcc = 0;
		finalAt = -1;
		baaed = false;
		startReel(edgeH);
		edge.fill(RHO0 + 0.4);
		for (const it of items) {
			refreshBase(it);
			it.phase = 0;
			it.pt = 0;
			it.rho = it.stage === 'cloud' ? CLOUD_RHO[it.k % CLOUD_RHO.length] : rhoOf(it.base.x, it.base.z);
		}
		// unknown visible children vanish when the front passes their position
		outroHidden.length = 0;
		outroRho.length = 0;
		for (const c of root.children) {
			if (claimed.has(c) || !c.visible) continue;
			outroHidden.push(c);
			outroRho.push(c.position.lengthSq() < 1e-6 ? H * 0.5 : rhoOf(c.position.x, c.position.z));
		}
		clearStreaks();
		bigRoot.visible = true;
		ballR.snap(0);
		ballR.target = BALL_R0;
		kick.snap(0);
		drop.snap(0);
		matSpring.snap(0);
		matG.visible = false;
		influx = 0;
		playPop({ pitch: 0.7 });
	}

	function startSuck(it) {
		refreshBase(it);
		it.phase = it.stage === 'cloud' ? 2 : 1;
		it.pt = 0;
		const dist = Math.hypot(it.base.x - ballPos.x, it.base.z - ballPos.z);
		it.dur = it.stage === 'cloud' ? 1.1 : THREE.MathUtils.clamp(0.42 + 0.06 * dist, 0.5, 0.95);
		it.arc = 0.5 + 0.1 * dist;
		if (it.stage === 'sheep' && !baaed) {
			baaed = true;
			playBaa();
		}
	}

	function stepSuck(it, dt) {
		it.pt += dt;
		const b = it.base;
		if (it.phase === 1) {
			const q = smooth(it.pt / SQUASH_T);
			place(it, 1 + 0.14 * q, 1 - 0.38 * q, 1 + 0.14 * q, b.x, b.y, b.z);
			if (it.pt >= SQUASH_T) {
				it.phase = 2;
				it.pt = 0;
			}
			return;
		}
		const a = clamp01(it.pt / it.dur);
		const ea = a * a;
		if (it.stage === 'cloud') {
			it.w.position.set(0, CLOUD_RISE * ea, 0);
		} else {
			const sx = Math.max(1e-3, lerp(1.14, 0.02, ea));
			const sy = Math.max(1e-3, lerp(0.62, 0.02, ea));
			place(
				it,
				sx,
				sy,
				sx,
				lerp(b.x, ballPos.x, ea),
				lerp(b.y, ballPos.y, ea) + it.arc * Math.sin(Math.PI * a),
				lerp(b.z, ballPos.z, ea),
			);
		}
		if (a >= 1) {
			it.phase = 3;
			hideItem(it);
			if (it.stage !== 'cloud') {
				kick.kick(4);
				influx = Math.min(2, influx + 1);
				playPop({ pitch: 0.7 + 0.7 * removedFrac(Math.max(0, lastRho)) });
			}
		}
	}

	let lastRho = RHO0;
	function stepUnravel(dt) {
		// thread winds into the cushion, ball pops in
		if (edgeH.reel) stepReel(edgeH, dt, UNRAVEL_START + 0.4);

		const p = clamp01((clock - UNRAVEL_START) / UNRAVEL_T);
		const moving = clock >= UNRAVEL_START && finalAt < 0;
		const rhoF = lerp(RHO0, RHO1, easeUnravel(p));
		lastRho = rhoF;
		if (moving) {
			// front: steady radius plus a notch that circles and cuts ahead; only ever shrinks
			thS += dt * SCAN_SPEED;
			for (let i = 0; i < NB; i++) {
				let d = binA[i] - thS;
				d -= TAU * Math.round(d / TAU);
				d /= NOTCH_SIGMA;
				const v = rhoF - NOTCH * Math.exp(-d * d);
				if (v < edge[i]) edge[i] = v;
			}
			// yarn streaks from the notch to the ball
			if (p < 1) spawnAcc += dt * STREAK_RATE;
			while (spawnAcc >= 1) {
				spawnAcc -= 1;
				spawnStreak(thS + (Math.random() - 0.5) * 1.6, Math.max(0.5, rhoF));
			}
		}
		ballR.target = radiusFor(removedFrac(Math.max(0, rhoF)));

		let allGone = true;
		for (const it of items) {
			if (it.phase === 0 && moving && rhoF < it.rho + SUCK_MARGIN) startSuck(it);
			if (it.phase === 1 || it.phase === 2) stepSuck(it, dt);
			if (it.phase !== 3) allGone = false;
		}
		for (let i = 0; i < outroHidden.length; i++) {
			if (outroHidden[i].visible && rhoF < outroRho[i] + SUCK_MARGIN) outroHidden[i].visible = false;
		}

		if (p >= 1 && finalAt < 0 && allGone && streakActive === 0) {
			finalAt = clock;
			ground.visible = false;
			ground.scale.setScalar(1e-4);
			edge.fill(-99);
			matSpring.target = 1;
			drop.target = 1;
			kick.kick(5);
			playPop({ pitch: 1.2 });
		}
		if (finalAt >= 0 && clock - finalAt > FINAL_T) {
			state = 'ball';
			clock = 0;
			layBallThread();
			playPop({ pitch: 1.9 });
		}
	}

	function update(t, dt = 1 / 60) {
		dt = Math.min(dt, 0.05);
		if (dt <= 0) return;
		clock += dt;
		if (warm > 0 && --warm === 0) endWarm();
		// critters respawn by setting visible themselves; keep them out until the world is there
		if (state === 'ball' || state === 'intro') {
			for (const c of unknownHidden) c.visible = false;
			for (const c of outroHidden) c.visible = false;
		}
		if (state === 'intro') stepIntro(dt);
		else if (state === 'idle') stepIdle(dt);
		else if (state === 'unravel') stepUnravel(dt);
		stepStreaks(dt);
		if (bigRoot.visible) updateBall(dt);
		// the ball thread follows the ball surface (after updateBall)
		if (ballH.live || ballH.reel) {
			ballAnchor(ballH.anchor);
			if (ballH.reel) stepReel(ballH, dt, BALL_REEL_T);
			else if (state === 'ball') stepBall(dt);
		}
	}

	const hintOut = { kind: 'start', point: new THREE.Vector3(), dir: new THREE.Vector3() };
	function fillHint(kind, h) {
		hintOut.kind = kind;
		hintOut.point.copy(h.pom.position);
		hintOut.dir.set(h.pom.position.x - h.anchor.x, 0, h.pom.position.z - h.anchor.z);
		if (hintOut.dir.lengthSq() < 1e-8) hintOut.dir.set(0, 0, 1);
		hintOut.dir.normalize();
		return hintOut;
	}

	showBall();
	ground.visible = true;
	for (const it of items) it.w.visible = true;
	return {
		update,
		playIntro,
		restore,
		grabbable,
		get busy() {
			return state !== 'idle';
		},
		get hint() {
			if (state === 'ball' && ballH.live && !ballH.held) return fillHint('start', ballH);
			if (state === 'idle' && edgeH.live && !edgeH.held && clock < COLLAPSE_HINT_T) return fillHint('collapse', edgeH);
			return null;
		},
	};
}
