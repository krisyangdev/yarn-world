// Water life: the river flows, a mossy waterfall feeds it, a waterwheel turns in it, ducks and leaves float down it.
//
// Pieces (all added to the world root; world.js wires setupWater in):
//   flow      the river ribbon's knit texture scrolls toward the mouth (map / normalMap / roughnessMap together)
//   streaks   ~36 short pale yarn arcs lie on the water, grow in, drift downstream (fast mid-channel, slow at the
//             banks, denser below the waterfall, bending around the wheel) and shrink out: the main read of flow
//   waterfall rock ledge on the island top (instanced stones and moss), 12 yarn strands pour over its lip,
//             animated by texture scroll and a slight sway, busy foam pompoms bob at the base, ripple rings
//             spread from the landing
//   waterwheel wood wheel on a fork post at the bank away from the house, paddles in the water; each paddle
//             entry sends a ripple ring and a few droplets; poke = fast spin = lots of splash
//   floaters  felt mother duck + 2 ducklings in a line and 5 knit leaves drift down the river, shrink away
//             near the mouth and come back below the waterfall; swimming ducks leave V wakes of yarn arcs;
//             poke a duck = dive, pop up, ripple ring and foam drops
//   rings     one pool of thin yarn tori that expand and sink: waterfall landing, wheel entries, duck pop-ups
//
// Frames: u is the river's arclength fraction (same as the ribbon's uv.y, riverCurve.getPointAt).
// Waterfall and wheel live in groups whose local +z is the flow direction and local +x points right of the flow.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { playQuack, playSplash } from './sound.js';

// ---------------------------------------------------------------------------
// Feel knobs
// ---------------------------------------------------------------------------
const FLOW_SPEED = 0.5; // units/s the river knit scrolls toward the mouth
const FLOW_SWELL = 0.12; // slow +-12% speed breathing
const FLOW_SWAY = 0.3; // sideways texture sway, in tiles

const STREAK_N = 48;
const STREAK_LEN = [0.3, 0.6]; // arc length
const STREAK_THICK = [0.85, 1.15]; // radius factor on STREAK_R
const STREAK_LIFE = [1.6, 3];
const STREAK_LAT = 0.38; // max lateral offset from the centerline
const STREAK_HALF = 0.45; // half channel width for the speed profile
const STREAK_SPEED = 1.1; // x FLOW_SPEED mid-channel, half of that at the banks
const STREAK_MEANDER = 0.035; // gentle sideways wander
const STREAK_CHURN = 1.8; // spawn bias toward the waterfall (1 = uniform)
const STREAK_WHEEL = 0.55; // u distance (world units) over which streaks bend away from the wheel
const STREAK_R = 0.02; // yarn radius
const STREAK_ARC = 0.4; // nominal arc length of the shared geometry
const STREAK_BULGE = 0.045;
const STREAK_LIFT = 0.014;

const WAKE_N = 30;
const WAKE_EVERY = 0.35; // s between V pairs per swimming duck
const WAKE_LIFE = 1.4;
const WAKE_ANGLE = 0.46; // rad between each arm and the duck's track
const WAKE_DRIFT = 0.22; // units/s with the current (kept under DUCK_SPEED so the duck outswims its wake)
const WAKE_SPREAD = 0.07; // units/s outward from the track

const RING_N = 16;
const RING_LIFE = 1.2;
const RING_R = [0.04, 0.3];
const RING_TUBE = 0.05; // torus tube radius at unit ring radius; the instance y squash brings it to ~0.01
const RING_FALL_EVERY = [0.4, 0.6]; // s between rings at the waterfall landing
const RING_WHEEL_GAP = 0.15; // s min between wheel rings (fast spin)

const FALL_U = 0.12; // river param of the waterfall ledge
const FALL_FLOW = 0.8; // units/s the yarn scrolls down the curtain
const FALL_R = 0.033; // strand radius
const FALL_SWAY = 0.022; // rad
const FOAM_N = 8;
const FOAM_R = 0.085;
const FOAM_BOB = 0.021; // landing pompoms bob harder than the rest of the water
const FOAM_RATE = 3.1;

const WHEEL_U = [0.62, 0.72]; // search range along the river
const WHEEL_RIM = 0.3;
const WHEEL_HALF = 0.15; // rims sit at +-this along the axle
const WHEEL_HUB_Y = 0.33; // axle height above the water
const WHEEL_PADDLES = 10;
const WHEEL_OFFSET = 0.3; // wheel center lateral offset toward its bank
const WHEEL_SPIN = 0.8; // rad/s
const WHEEL_FAST = 9; // rad/s after a poke
const WHEEL_BOOST = 2; // s of fast spin and ease back
const WHEEL_ENTRY_Z = -0.23; // upstream of the axle where a paddle tip meets the water
const WHEEL_ENTRY_ANGLE = 0.6; // rad past straight down at that point
const WHEEL_SPLASH = 2; // droplets per paddle entry

const FLOAT_START = FALL_U + 0.035; // just below the waterfall foam
const FLOAT_END = 0.94;
const FLOAT_FADE = 0.035; // shrink zone before FLOAT_END
const FLOAT_GROW = 0.02; // grow zone after FLOAT_START
const FLOAT_WAIT = [1.5, 3.5]; // s hidden before coming back
const DUCK_SPEED = 0.34; // units/s
const DUCK_GAPS = [0, 0.34, 0.62]; // world units behind the mother
const LEAF_SPEED = 0.48;

const DIVE_SINK = 0.12;
const DIVE_PITCH = 1.2;
const DIVE_POP = 1; // s into the dive when it pops up
const DIVE_END = 1.6;
const DROP_N = 30;
const DROP_R = 0.026;
const DROP_LIFE = 0.8;

const PATH_N = 360;
const CAM_XZ = [0.63, 0.77]; // default camera direction on the ground plane
const TAU = Math.PI * 2;

// Rock ledge: [d upstream of the ledge origin, b right of the flow, radius, y squash, top height above the water, stacked]
// stacked stones sit on others; the rest are lowered onto the ground if they would float
const STONES = [
	[0.3, 0, 0.52, 0.8, 0.66, 0], // 0 front boulder under the lip
	[0.34, 0, 0.4, 0.72, 0.8, 1], // 1 lip
	[0.8, 0, 0.5, 0.85, 0.74, 0], // 2
	[0.85, 0, 0.4, 0.75, 0.84, 1], // 3
	[0.38, 0.7, 0.46, 0.85, 0.8, 0], // 4 flanks
	[0.38, -0.7, 0.46, 0.85, 0.78, 0], // 5
	[0.52, 0.5, 0.3, 0.8, 0.92, 1], // 6 flank caps, the tallest points
	[0.55, -0.5, 0.3, 0.8, 0.9, 1], // 7
	[-0.05, 1.0, 0.34, 0.8, 0.42, 0], // 8 low boulders at the toe
	[0.02, -0.98, 0.32, 0.8, 0.4, 0], // 9
	[0.85, 0.8, 0.42, 0.85, 0.7, 0], // 10
	[0.85, -0.8, 0.42, 0.85, 0.7, 0], // 11
	[1.2, 0.5, 0.46, 0.85, 0.74, 0], // 12 back mass that hides the river behind
	[1.2, -0.5, 0.46, 0.85, 0.7, 0], // 13
	[1.25, 0, 0.44, 0.85, 0.76, 0], // 14
	[1.0, 0, 0.3, 0.8, 0.82, 1], // 15 fillers under the water tongue
	[0.58, 0, 0.26, 0.8, 0.82, 1], // 16
];
// moss tufts: [stone index, offset x, offset z, radius, color 0 olive / 1 sage]
const MOSS = [
	[6, 0.05, 0.02, 0.1, 0],
	[7, -0.04, 0, 0.09, 1],
	[4, 0.18, 0.1, 0.09, 1],
	[5, -0.2, 0.05, 0.1, 0],
	[8, 0, 0, 0.1, 1],
	[9, 0, 0.05, 0.09, 0],
	[12, 0.1, 0.1, 0.11, 0],
	[13, -0.1, 0, 0.1, 1],
	[10, 0, 0.1, 0.09, 0],
];
// water path over the ledge: [d upstream of the origin, height above the water]
const FALL_PATH = [
	[1.25, 0.76],
	[1.0, 0.835],
	[0.85, 0.85],
	[0.58, 0.84],
	[0.34, 0.835],
	[0.12, 0.8],
	[-0.04, 0.74],
	[-0.13, 0.62],
	[-0.17, 0.48],
	[-0.22, 0.34],
	[-0.24, 0.18],
	[-0.22, 0.04],
];
const FALL_PIVOT = [0.12, 0.8]; // curtain sways about the lip
const FALL_WIDTH = 0.25; // half width of the curtain at the lip, fans out toward the pool
const FALL_STRANDS = 12;

const noRaycast = () => {};
const sstep = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const easeOutBack = (u) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2;

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// River centerline sampled by arclength: position and unit tangent in xz at any u
function makePath(curve, n) {
	const pts = curve.getSpacedPoints(n);
	const x = new Float32Array(n + 1);
	const z = new Float32Array(n + 1);
	const tx = new Float32Array(n + 1);
	const tz = new Float32Array(n + 1);
	for (let i = 0; i <= n; i++) {
		x[i] = pts[i].x;
		z[i] = pts[i].z;
		const a = pts[Math.max(0, i - 1)];
		const b = pts[Math.min(n, i + 1)];
		const dx = b.x - a.x;
		const dz = b.z - a.z;
		const l = Math.hypot(dx, dz) || 1;
		tx[i] = dx / l;
		tz[i] = dz / l;
	}
	return {
		len: curve.getLength(),
		at(s, out) {
			const f = Math.min(n - 1e-6, Math.max(0, s * n));
			const i = f | 0;
			const k = f - i;
			out.x = x[i] + (x[i + 1] - x[i]) * k;
			out.z = z[i] + (z[i + 1] - z[i]) * k;
			const ux = tx[i] + (tx[i + 1] - tx[i]) * k;
			const uz = tz[i] + (tz[i + 1] - tz[i]) * k;
			const l = Math.hypot(ux, uz) || 1;
			out.tx = ux / l;
			out.tz = uz / l;
			return out;
		},
	};
}

// clone of a kit material with its own texture objects, so offsets can be animated
function ownMat(base) {
	const m = base.clone();
	for (const k of ['map', 'normalMap', 'roughnessMap']) if (m[k]) m[k] = m[k].clone();
	return m;
}
const texOf = (m) => [m.map, m.normalMap, m.roughnessMap].filter(Boolean);

// uniform-scale instance matrix written straight into the instance array
function setSphere(mesh, i, x, y, z, s) {
	const a = mesh.instanceMatrix.array;
	const o = i * 16;
	a[o] = s;
	a[o + 1] = 0;
	a[o + 2] = 0;
	a[o + 3] = 0;
	a[o + 4] = 0;
	a[o + 5] = s;
	a[o + 6] = 0;
	a[o + 7] = 0;
	a[o + 8] = 0;
	a[o + 9] = 0;
	a[o + 10] = s;
	a[o + 11] = 0;
	a[o + 12] = x;
	a[o + 13] = y;
	a[o + 14] = z;
	a[o + 15] = 1;
}

export function setupWater({ root, river, wind, kit, terrain }) {
	const { P, mat, sphereRep, sphereGeo, strandRep, add } = kit;
	const { groundAt, riverCurve } = terrain;
	const path = makePath(riverCurve, PATH_N);
	const len = path.len;
	const unit = sphereGeo(1);
	const dummy = new THREE.Object3D();
	const q = { x: 0, z: 0, tx: 0, tz: 0 };
	const v = new THREE.Vector3();
	let rand = rng(4242);
	const rr = (a, b) => a + rand() * (b - a);

	const items = [];
	const floaters = []; // moving objects the intro hides until the world is complete

	// -----------------------------------------------------------------------
	// Flowing river: scroll the knit toward the mouth
	// -----------------------------------------------------------------------
	const riverTex = texOf(river.material);
	const riverOff = riverTex.map((t) => t.offset.clone());
	const repY = riverTex[0].repeat.y;
	let flowV = 0;

	function updateFlow(t, dt) {
		const speed = FLOW_SPEED * (1 + FLOW_SWELL * Math.sin(t * 0.37));
		flowV = (flowV + (speed * dt * repY) / len) % 1;
		const sway = FLOW_SWAY * Math.sin(t * 0.5);
		for (let i = 0; i < riverTex.length; i++) {
			riverTex[i].offset.set(riverOff[i].x + sway, riverOff[i].y - flowV);
		}
	}

	// -----------------------------------------------------------------------
	// Waterfall: rock ledge, yarn curtain, foam
	// -----------------------------------------------------------------------
	const fall = (() => {
		path.at(FALL_U, q);
		const ox = q.x;
		const oz = q.z;
		const tx = q.tx;
		const tz = q.tz;
		const g0 = groundAt(ox, oz);
		const group = new THREE.Group();
		group.position.set(ox, g0, oz);
		group.rotation.y = Math.atan2(tx, tz);
		root.add(group);
		items.push({ obj: group, stage: 'water' });

		// (d upstream, b right, h up) -> group-local, following the river bend upstream
		const loc = (d, b, h, out) => {
			path.at(FALL_U - d / len, q);
			const dx = q.x + q.tz * b - ox;
			const dz = q.z - q.tx * b - oz;
			return out.set(dx * tz - dz * tx, h, dx * tx + dz * tz);
		};
		const groundLocal = (lx, lz) => groundAt(ox + lx * tz + lz * tx, oz - lx * tx + lz * tz) - g0;

		// stones: two instanced meshes (stone / stone2), moss: two (olive / sage)
		const r = rng(7);
		const stoneLists = [[], []];
		const placed = [];
		STONES.forEach(([d, b, rad, sy, top, stack], i) => {
			loc(d, b, 0, v);
			let cy = top - rad * sy;
			if (!stack) cy = Math.min(cy, groundLocal(v.x, v.z) - 0.06 + rad * sy);
			placed.push({ x: v.x, z: v.z, cy, rad, sy });
			stoneLists[i % 2].push({ x: v.x, y: cy, z: v.z, sx: rad * (0.95 + r() * 0.12), sy: rad * sy, sz: rad * (1 + r() * 0.12), yaw: r() * TAU });
		});
		const mossLists = [[], []];
		for (const [idx, ox2, oz2, rm, col] of MOSS) {
			const p = placed[idx];
			const off = Math.hypot(ox2, oz2);
			const lift = p.sy * p.rad * Math.sqrt(Math.max(0, 1 - (off * off) / (p.rad * p.rad)));
			mossLists[col].push({ x: p.x + ox2, y: p.cy + lift - 0.4 * rm, z: p.z + oz2, sx: rm, sy: rm * 0.85, sz: rm, yaw: r() * TAU });
		}
		const stoneRep = sphereRep(0.4);
		const mossRep = sphereRep(0.09);
		const instanced = (material, list) => {
			const mesh = new THREE.InstancedMesh(unit, material, list.length);
			list.forEach((s, k) => {
				dummy.position.set(s.x, s.y, s.z);
				dummy.rotation.set(0, s.yaw, 0);
				dummy.scale.set(s.sx, s.sy, s.sz);
				dummy.updateMatrix();
				mesh.setMatrixAt(k, dummy.matrix);
			});
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.raycast = noRaycast;
			group.add(mesh);
			return mesh;
		};
		instanced(mat(P.stone, 'seed', stoneRep), stoneLists[0]);
		instanced(mat(P.stone2, 'seed', stoneRep), stoneLists[1]);
		instanced(mat(P.olive, 'boucle', mossRep), mossLists[0]);
		instanced(mat(P.sage, 'boucle', mossRep), mossLists[1]);

		// curtain: strands follow the water path, merged per color (sky / white), each color group sways about the lip
		const pivot = loc(FALL_PIVOT[0], 0, FALL_PIVOT[1], new THREE.Vector3());
		const geoLists = [[], []];
		let strandLen = 0;
		for (let i = 0; i < FALL_STRANDS; i++) {
			const b0 = (-1 + (2 * i) / (FALL_STRANDS - 1)) * FALL_WIDTH;
			const jit = 0.015 * Math.sin(i * 2.3);
			const pts = FALL_PATH.map(([d, h]) => {
				const fan = 1 + 0.35 * Math.min(1, Math.max(0, (0.8 - h) / 0.8));
				return loc(d + (d < 0.6 ? jit : 0), b0 * fan, h, new THREE.Vector3()).sub(pivot);
			});
			const curve = new THREE.CatmullRomCurve3(pts);
			strandLen = Math.max(strandLen, curve.getLength());
			geoLists[i % 2].push(new THREE.TubeGeometry(curve, 40, FALL_R, 6, false));
		}
		const strandMats = [P.sky, P.white].map((c) => ownMat(mat(c, 'strand', strandRep(strandLen, 4, 0.14))));
		const sways = geoLists.map((list, k) => {
			const g = new THREE.Group();
			g.position.copy(pivot);
			add(g, new THREE.Mesh(mergeGeometries(list), strandMats[k]));
			list.forEach((geo) => geo.dispose());
			group.add(g);
			return g;
		});
		const strandTex = strandMats.map(texOf);
		const strandRepX = strandTex[0][0].repeat.x;

		// foam pompoms around the landing, one instanced mesh
		const foam = new THREE.InstancedMesh(unit, mat(P.white, 'boucle', sphereRep(FOAM_R)), FOAM_N);
		foam.castShadow = true;
		foam.receiveShadow = true;
		foam.frustumCulled = false;
		foam.raycast = noRaycast;
		const foamPos = [];
		for (let k = 0; k < FOAM_N; k++) {
			const ang = (k / FOAM_N) * TAU;
			loc(-0.3 - 0.2 * Math.sin(ang), 0.42 * Math.cos(ang), 0.03, v);
			foamPos.push({ x: v.x, z: v.z, ph: k * 1.9 });
		}
		group.add(foam);

		// world frame of the landing point, for ripple rings
		path.at(FALL_U + 0.27 / len, q);
		const land = { x: q.x, z: q.z, tx: q.tx, tz: q.tz };

		return {
			group,
			land,
			update(t, dt) {
				const push = 0.6 + wind.at(ox, oz);
				sways[0].rotation.set(FALL_SWAY * push * Math.sin(t * 1.3), 0, FALL_SWAY * 0.7 * push * Math.sin(t * 1.1 + 1));
				sways[1].rotation.set(FALL_SWAY * push * Math.sin(t * 1.1 + 2), 0, FALL_SWAY * 0.7 * push * Math.sin(t * 1.5 + 4));
				const dv = (FALL_FLOW * dt * strandRepX) / strandLen;
				for (const set of strandTex) for (const tex of set) tex.offset.x = (tex.offset.x - dv) % 1;
				for (let k = 0; k < FOAM_N; k++) {
					const f = foamPos[k];
					const s = FOAM_R * (1 + 0.14 * Math.sin(t * 3.1 + f.ph * 1.7));
					setSphere(foam, k, f.x, 0.03 + 0.014 * Math.sin(t * 2.4 + f.ph), f.z, s);
				}
				foam.instanceMatrix.needsUpdate = true;
			},
			reset() {
				for (const set of strandTex) for (const tex of set) tex.offset.x = 0;
			},
		};
	})();

	// -----------------------------------------------------------------------
	// Waterwheel
	// -----------------------------------------------------------------------
	const wheel = (() => {
		// pick the spot: clear of blockers, wheel face turned toward the camera, on the bank away from the house (the garden sits on the house side)
		let best = null;
		for (let u = WHEEL_U[0]; u <= WHEEL_U[1] + 1e-6; u += 0.01) {
			path.at(u, q);
			const sd = (terrain.HOUSE.x - q.x) * q.tz - (terrain.HOUSE.z - q.z) * q.tx >= 0 ? -1 : 1;
			const wx = q.x + q.tz * sd * WHEEL_OFFSET;
			const wz = q.z - q.tx * sd * WHEEL_OFFSET;
			const px = q.x + q.tz * sd * 0.8;
			const pz = q.z - q.tx * sd * 0.8;
			let clear = Infinity;
			for (const [bx, bz, br] of terrain.blockers) {
				clear = Math.min(clear, Math.hypot(wx - bx, wz - bz) - br, Math.hypot(px - bx, pz - bz) - br);
			}
			const score = (clear > 0.35 ? 10 : clear) + Math.abs(CAM_XZ[0] * q.tz - CAM_XZ[1] * q.tx);
			if (!best || score > best.score) best = { score, u, sd, wx, wz, tx: q.tx, tz: q.tz };
		}
		const { sd, wx, wz, tx, tz } = best;
		const wheelU = best.u;
		const y0 = groundAt(wx, wz);
		const group = new THREE.Group();
		group.position.set(wx, y0, wz);
		group.rotation.y = Math.atan2(tx, tz);
		root.add(group);
		items.push({ obj: group, stage: 'water' });

		const rotor = new THREE.Group();
		rotor.position.y = WHEEL_HUB_Y;
		group.add(rotor);

		// rims: two rings around the axle (x), wood strand yarn
		const rimParts = [];
		for (const sx of [-1, 1]) {
			const g = new THREE.TorusGeometry(WHEEL_RIM, 0.022, 8, 48);
			g.rotateY(Math.PI / 2);
			g.translate(sx * WHEEL_HALF, 0, 0);
			rimParts.push(g);
		}
		add(rotor, new THREE.Mesh(mergeGeometries(rimParts), mat(P.wood, 'strand', strandRep(TAU * WHEEL_RIM, 4, 0.12))));
		rimParts.forEach((g) => g.dispose());

		// axle, hub drum and 8 spokes per rim
		const axleX0 = -sd * 0.2;
		const axleX1 = sd * 0.6;
		const frameParts = [];
		const axle = new THREE.CylinderGeometry(0.028, 0.028, Math.abs(axleX1 - axleX0), 8);
		axle.rotateZ(Math.PI / 2);
		axle.translate((axleX0 + axleX1) / 2, 0, 0);
		frameParts.push(axle);
		const hub = new THREE.CylinderGeometry(0.07, 0.07, 2 * WHEEL_HALF + 0.04, 12);
		hub.rotateZ(Math.PI / 2);
		frameParts.push(hub);
		for (const sx of [-1, 1]) {
			for (let k = 0; k < 8; k++) {
				const g = new THREE.CylinderGeometry(0.016, 0.016, WHEEL_RIM, 5);
				g.translate(0, WHEEL_RIM / 2, 0);
				g.rotateX((k * Math.PI) / 4);
				g.translate(sx * WHEEL_HALF, 0, 0);
				frameParts.push(g);
			}
		}
		add(rotor, new THREE.Mesh(mergeGeometries(frameParts), mat(P.wood, 'stockinette', [3, 2])));
		frameParts.forEach((g) => g.dispose());

		// paddles: boards from just inside the rim out past it, merged
		const padParts = [];
		for (let k = 0; k < WHEEL_PADDLES; k++) {
			const g = new THREE.BoxGeometry(2 * WHEEL_HALF + 0.04, 0.12, 0.03);
			g.translate(0, 0.34, 0);
			g.rotateX((k * TAU) / WHEEL_PADDLES);
			padParts.push(g);
		}
		add(rotor, new THREE.Mesh(mergeGeometries(padParts), mat(P.coral, 'garter', [0.85, 0.25])));
		padParts.forEach((g) => g.dispose());

		// fork post on the bank (two uprights with the axle between) and pompom caps on the axle ends
		const postMat = mat(P.wood, 'stockinette', [3, 4]);
		const top = WHEEL_HUB_Y + 0.08;
		for (const lz of [-0.075, 0.075]) {
			const lx = sd * 0.5;
			const gy = groundAt(wx + lx * tz + lz * tx, wz - lx * tx + lz * tz) - y0 - 0.08;
			const post = add(group, new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, top - gy, 8), postMat));
			post.position.set(lx, (top + gy) / 2, lz);
		}
		const capA = add(group, new THREE.Mesh(unit, mat(P.coral, 'boucle', sphereRep(0.055))));
		capA.scale.setScalar(0.055);
		capA.position.set(sd * 0.64, WHEEL_HUB_Y, 0);
		const capB = add(group, new THREE.Mesh(unit, mat(P.cream, 'boucle', sphereRep(0.045))));
		capB.scale.setScalar(0.045);
		capB.position.set(-sd * 0.23, WHEEL_HUB_Y, 0);

		const PAD_STEP = TAU / WHEEL_PADDLES;
		const padCount = (a) => Math.floor((a + WHEEL_ENTRY_ANGLE + Math.PI) / PAD_STEP);
		let angle = 0;
		let total = 0; // unwrapped angle, to count paddle entries
		let padN = padCount(0);
		let ringT = 99;
		let pokeT = 99;
		group.userData.onPoke = () => {
			pokeT = 0;
			playSplash();
		};

		return {
			group,
			u: wheelU,
			side: sd,
			update(dt) {
				pokeT += dt;
				ringT += dt;
				const env = sstep(0, 0.15, pokeT) * (1 - sstep(WHEEL_BOOST * 0.45, WHEEL_BOOST, pokeT));
				const da = (WHEEL_SPIN + (WHEEL_FAST - WHEEL_SPIN) * env) * dt;
				angle += da;
				if (angle > TAU) angle -= TAU;
				total += da;
				// each paddle tip meeting the water: a few droplets and a ripple ring
				const n = padCount(total);
				if (n > padN) {
					padN = n;
					const lx = (rand() * 2 - 1) * 0.11;
					const ex = wx + lx * tz + WHEEL_ENTRY_Z * tx;
					const ez = wz - lx * tx + WHEEL_ENTRY_Z * tz;
					spawnDrops(ex, groundAt(ex, ez) + 0.03, ez, WHEEL_SPLASH);
					if (ringT >= RING_WHEEL_GAP) {
						ringT = 0;
						spawnRing(ex, ez);
					}
				}
				// local +z is the flow: the lower paddles move downstream
				rotor.rotation.x = -angle;
			},
			reset() {
				angle = 0;
				total = 0;
				padN = padCount(0);
				ringT = 99;
				pokeT = 99;
				rotor.rotation.x = 0;
			},
		};
	})();

	// -----------------------------------------------------------------------
	// Floaters: ducks, leaves, foam drops
	// -----------------------------------------------------------------------
	const F = { x: 0, z: 0, y: 0, yaw: 0 };
	// position, water height and heading at river param u; lateral wander is a function of distance so a line of ducks follows one path
	function sample(u, ph, t) {
		path.at(u, q);
		const x = u * len;
		const a1 = x * 1.15 + ph + t * 0.12;
		const a2 = x * 2.3 + ph * 1.7 - t * 0.17;
		const lat = 0.15 * Math.sin(a1) + 0.08 * Math.sin(a2);
		const dl = 0.15 * 1.15 * Math.cos(a1) + 0.08 * 2.3 * Math.cos(a2);
		F.x = q.x + q.tz * lat;
		F.z = q.z - q.tx * lat;
		F.yaw = Math.atan2(q.tx + q.tz * dl, q.tz - q.tx * dl);
		F.y = groundAt(F.x, F.z);
	}
	const visibleScale = (u) => sstep(FLOAT_START, FLOAT_START + FLOAT_GROW, u) * (1 - sstep(FLOAT_END - FLOAT_FADE, FLOAT_END, u));

	// duck parts, merged per material: felt body, beak, eyes
	const sph = (sx, sy, sz, x, y, z) => {
		const g = new THREE.SphereGeometry(1, 14, 10);
		g.scale(sx, sy, sz);
		g.translate(x, y, z);
		return g;
	};
	const duckGeo = {
		felt: mergeGeometries([
			sph(0.075, 0.062, 0.115, 0, 0, 0), // body
			sph(0.03, 0.032, 0.055, 0, 0.05, -0.115), // tail
			sph(0.052, 0.052, 0.052, 0, 0.105, 0.07), // head
			sph(0.016, 0.04, 0.07, 0.07, 0.03, -0.01), // wings
			sph(0.016, 0.04, 0.07, -0.07, 0.03, -0.01),
		]),
		beak: sph(0.026, 0.011, 0.035, 0, 0.098, 0.12),
		eyes: mergeGeometries([sph(0.009, 0.009, 0.009, 0.038, 0.118, 0.103), sph(0.009, 0.009, 0.009, -0.038, 0.118, 0.103)]),
	};
	const felt = (color, sheen) =>
		new THREE.MeshPhysicalMaterial({ color, roughness: 0.95, metalness: 0, sheen: 1, sheenRoughness: 0.7, sheenColor: new THREE.Color(sheen) });
	const motherMat = felt(P.cream, '#fffaf0');
	const duckling = felt('#f2cf6a', '#fff0b8');
	const beakMat = felt('#ee8f3a', '#ffc58a');
	const eyeMat = new THREE.MeshStandardMaterial({ color: '#0d0b0b', roughness: 0.3, metalness: 0 });

	const drops = new THREE.InstancedMesh(unit, mat(P.white, 'boucle', sphereRep(0.03)), DROP_N);
	drops.frustumCulled = false;
	drops.raycast = noRaycast;
	drops.castShadow = true;
	root.add(drops);
	floaters.push(drops);
	const dr = {
		age: new Float32Array(DROP_N),
		x: new Float32Array(DROP_N),
		y: new Float32Array(DROP_N),
		z: new Float32Array(DROP_N),
		vx: new Float32Array(DROP_N),
		vy: new Float32Array(DROP_N),
		vz: new Float32Array(DROP_N),
	};
	let dropNext = 0;

	function clearDrops() {
		for (let i = 0; i < DROP_N; i++) {
			dr.age[i] = -1;
			setSphere(drops, i, 0, 0, 0, 0);
		}
		drops.instanceMatrix.needsUpdate = true;
	}

	function spawnDrops(x, y, z, count = 5) {
		for (let k = 0; k < count; k++) {
			const i = dropNext;
			dropNext = (dropNext + 1) % DROP_N;
			const a = rand() * TAU;
			const sp = rr(0.15, 0.35);
			dr.age[i] = 0;
			dr.x[i] = x;
			dr.y[i] = y;
			dr.z[i] = z;
			dr.vx[i] = Math.cos(a) * sp;
			dr.vz[i] = Math.sin(a) * sp;
			dr.vy[i] = rr(0.8, 1.3);
		}
	}

	function updateDrops(dt) {
		for (let i = 0; i < DROP_N; i++) {
			if (dr.age[i] < 0) continue;
			dr.age[i] += dt;
			const f = dr.age[i] / DROP_LIFE;
			if (f >= 1) {
				dr.age[i] = -1;
				setSphere(drops, i, 0, 0, 0, 0);
				continue;
			}
			dr.vy[i] -= 5.5 * dt;
			dr.x[i] += dr.vx[i] * dt;
			dr.y[i] += dr.vy[i] * dt;
			dr.z[i] += dr.vz[i] * dt;
			setSphere(drops, i, dr.x[i], dr.y[i], dr.z[i], DROP_R * (1 - f * f));
		}
		drops.instanceMatrix.needsUpdate = true;
	}

	// a line of ducks: mother leads, ducklings follow along the same path
	const line = { u: 0, wait: 0, ducks: [] };
	DUCK_GAPS.forEach((gap, i) => {
		const group = new THREE.Group();
		const rig = new THREE.Group();
		group.add(rig);
		add(rig, new THREE.Mesh(duckGeo.felt, i === 0 ? motherMat : duckling));
		add(rig, new THREE.Mesh(duckGeo.beak, beakMat));
		add(rig, new THREE.Mesh(duckGeo.eyes, eyeMat));
		root.add(group);
		floaters.push(group);
		const d = { group, rig, gap: gap / len, size: i === 0 ? 1 : 0.62, ph: 1.3, dive: -1, popped: false, wake: 0 };
		group.userData.onPoke = () => {
			if (d.dive >= 0) return;
			d.dive = 0;
			d.popped = false;
		};
		line.ducks.push(d);
	});

	// leaves: flat knit leaf, tip downstream
	const leafShape = new THREE.Shape();
	leafShape.moveTo(0, -0.1);
	leafShape.bezierCurveTo(0.09, -0.06, 0.09, 0.06, 0, 0.12);
	leafShape.bezierCurveTo(-0.09, 0.06, -0.09, -0.06, 0, -0.1);
	const leafGeo = new THREE.ExtrudeGeometry(leafShape, {
		depth: 0.018,
		curveSegments: 10,
		bevelEnabled: true,
		bevelThickness: 0.008,
		bevelSize: 0.008,
		bevelSegments: 2,
	});
	leafGeo.rotateX(-Math.PI / 2);
	leafGeo.rotateY(Math.PI);
	const leaves = [P.sage, P.mustard, P.coral, P.sage, P.mustard].map((color) => {
		const mesh = add(root, new THREE.Mesh(leafGeo, mat(color, 'stockinette', [2.5, 2.5])));
		mesh.raycast = noRaycast;
		mesh.rotation.order = 'YXZ';
		floaters.push(mesh);
		return { mesh, u: 0, speed: 0, ph: 0, size: 1, wait: 0 };
	});
	const LEAF_U0 = [0.18, 0.31, 0.5, 0.66, 0.82];

	function initFloaters() {
		line.u = 0.32;
		line.wait = 0;
		for (const d of line.ducks) {
			d.dive = -1;
			d.popped = false;
			d.rig.rotation.set(0, 0, 0);
		}
		leaves.forEach((L, i) => {
			L.u = LEAF_U0[i];
			L.speed = LEAF_SPEED * rr(0.9, 1.15);
			L.ph = rr(0, TAU);
			L.size = rr(0.9, 1.25);
			L.wait = 0;
		});
		clearDrops();
	}

	function updateDucks(t, dt) {
		const last = line.ducks[line.ducks.length - 1];
		if (line.wait > 0) {
			line.wait -= dt;
			if (line.wait <= 0) line.u = FLOAT_START;
		} else {
			line.u += (DUCK_SPEED * (1 + 0.1 * Math.sin(t * 0.5)) * dt) / len;
			if (line.u - last.gap >= FLOAT_END) line.wait = rr(FLOAT_WAIT[0], FLOAT_WAIT[1]);
		}
		for (const d of line.ducks) {
			const u = line.u - d.gap;
			const sc = line.wait > 0 ? 0 : visibleScale(u);
			sample(u, d.ph, t);
			const g = d.group;
			g.position.set(F.x, F.y, F.z);
			g.rotation.y = F.yaw + 0.08 * Math.sin(t * 1.6 + d.ph * 3);
			g.scale.setScalar(Math.max(1e-4, sc * d.size));
			const phs = d.gap * 40;
			let sink = 0;
			let pitch = 0;
			if (d.dive >= 0) {
				d.dive += dt;
				const s = d.dive;
				if (s < 0.45) {
					const e = sstep(0, 0.45, s);
					pitch = DIVE_PITCH * e;
					sink = DIVE_SINK * e;
				} else if (s < DIVE_POP) {
					pitch = DIVE_PITCH + 0.15 * sstep(0.45, DIVE_POP, s);
					sink = DIVE_SINK;
				} else {
					if (!d.popped) {
						d.popped = true;
						spawnDrops(F.x, F.y + 0.04, F.z);
						playQuack();
					}
					const e = easeOutBack(Math.min(1, (s - DIVE_POP) / (DIVE_END - DIVE_POP)));
					pitch = (DIVE_PITCH + 0.15) * (1 - e);
					sink = DIVE_SINK * (1 - e);
					if (s >= DIVE_END) d.dive = -1;
				}
			}
			// float with a little bob; tiny fast rhythm for the paddling feet
			d.rig.position.y = 0.035 + 0.004 * Math.sin(t * 1.9 + phs) + 0.0025 * Math.sin(t * 10 + phs * 3) - sink;
			d.rig.rotation.x = pitch + 0.03 * Math.sin(t * 1.3 + phs) + 0.02 * Math.sin(t * 10 + phs * 3);
			d.rig.rotation.z = 0.05 * Math.sin(t * 1.1 + phs);
		}
	}

	function updateLeaves(t, dt) {
		for (const L of leaves) {
			let sc = 0;
			if (L.wait > 0) {
				L.wait -= dt;
				if (L.wait <= 0) L.u = FLOAT_START;
			} else {
				L.u += (L.speed * dt) / len;
				if (L.u >= FLOAT_END) L.wait = rr(FLOAT_WAIT[0], FLOAT_WAIT[1]);
				else sc = visibleScale(L.u);
			}
			sample(L.u, L.ph, t);
			const m = L.mesh;
			m.position.set(F.x, F.y + 0.012 + 0.004 * Math.sin(t * 1.7 + L.ph), F.z);
			m.rotation.set(0.06 * Math.sin(t * 1.3 + L.ph), F.yaw + 0.6 * Math.sin(t * 0.5 + L.ph * 2), 0.08 * Math.sin(t * 1.1 + L.ph * 2));
			m.scale.setScalar(Math.max(1e-4, sc * L.size));
		}
	}

	// -----------------------------------------------------------------------
	// Yarn streaks: flow lines, duck wakes and ripple rings share one pale strand yarn
	// -----------------------------------------------------------------------
	const paleColor = new THREE.Color(P.sky).lerp(new THREE.Color(P.white), 0.75);
	const streakMat = mat('#' + paleColor.getHexString(), 'strand', strandRep(STREAK_ARC, 4, 0.12)).clone();
	streakMat.emissive = paleColor.clone();
	streakMat.emissiveIntensity = 0.3;

	// arc along local +z, bulging toward +x; instances scale z for length and x/y for thickness
	const arcGeo = new THREE.TubeGeometry(
		new THREE.CatmullRomCurve3(
			Array.from({ length: 9 }, (_, k) => {
				const z = (k / 8 - 0.5) * STREAK_ARC;
				const e = (2 * z) / STREAK_ARC;
				return new THREE.Vector3(STREAK_BULGE * (1 - e * e), 0, z);
			}),
		),
		14,
		STREAK_R,
		5,
		false,
	);
	const ringGeo = new THREE.TorusGeometry(1, RING_TUBE, 6, 36);
	ringGeo.rotateX(-Math.PI / 2);

	function pool(geo, n) {
		const mesh = new THREE.InstancedMesh(geo, streakMat, n);
		mesh.castShadow = false;
		mesh.receiveShadow = false;
		mesh.frustumCulled = false;
		mesh.raycast = noRaycast;
		root.add(mesh);
		floaters.push(mesh);
		return mesh;
	}

	// instance matrix: yaw about y, x/y scaled by sxy, z (the arc axis) by sz
	function setArc(mesh, i, x, y, z, yaw, sxy, sz) {
		const a = mesh.instanceMatrix.array;
		const o = i * 16;
		const c = Math.cos(yaw);
		const sn = Math.sin(yaw);
		a[o] = c * sxy;
		a[o + 1] = 0;
		a[o + 2] = -sn * sxy;
		a[o + 3] = 0;
		a[o + 4] = 0;
		a[o + 5] = sxy;
		a[o + 6] = 0;
		a[o + 7] = 0;
		a[o + 8] = sn * sz;
		a[o + 9] = 0;
		a[o + 10] = c * sz;
		a[o + 11] = 0;
		a[o + 12] = x;
		a[o + 13] = y;
		a[o + 14] = z;
		a[o + 15] = 1;
	}

	// flow lines
	const streaks = pool(arcGeo, STREAK_N);
	const st = {
		s: new Float32Array(STREAK_N),
		b: new Float32Array(STREAK_N),
		age: new Float32Array(STREAK_N),
		life: new Float32Array(STREAK_N),
		len: new Float32Array(STREAK_N),
		thick: new Float32Array(STREAK_N),
		ph: new Float32Array(STREAK_N),
		flip: new Float32Array(STREAK_N),
	};

	function spawnStreak(i, warm) {
		st.life[i] = rr(STREAK_LIFE[0], STREAK_LIFE[1]);
		st.s[i] = FLOAT_START + (FLOAT_END - FLOAT_START) * rand() ** STREAK_CHURN; // biased toward the churn below the fall
		st.b[i] = (rand() * 2 - 1) * STREAK_LAT;
		st.age[i] = warm ? rand() * st.life[i] : 0;
		st.len[i] = rr(STREAK_LEN[0], STREAK_LEN[1]);
		st.thick[i] = rr(STREAK_THICK[0], STREAK_THICK[1]);
		st.ph[i] = rr(0, TAU);
		st.flip[i] = rand() < 0.5 ? 0 : Math.PI; // mirrors the bulge
	}

	function updateStreaks(dt) {
		const wSide = wheel.side;
		for (let i = 0; i < STREAK_N; i++) {
			st.age[i] += dt;
			if (st.age[i] >= st.life[i] || st.s[i] >= FLOAT_END) spawnStreak(i, false);
			const b0 = st.b[i];
			const speed = FLOW_SPEED * STREAK_SPEED * (1 - 0.5 * (b0 / STREAK_HALF) ** 2);
			st.s[i] += (speed * dt) / len;
			path.at(st.s[i], q);
			// near the wheel the lines squeeze into the far half of the channel
			const w = 1 - sstep(STREAK_WHEEL * 0.45, STREAK_WHEEL, Math.abs(st.s[i] - wheel.u) * len);
			const side = b0 * wSide;
			const sideEff = side + (-STREAK_LAT + (side + STREAK_LAT) * 0.34 - side) * w;
			const ph = st.age[i] * 1.7 + st.ph[i];
			const b = sideEff * wSide + STREAK_MEANDER * Math.sin(ph);
			const px = q.x + q.tz * b;
			const pz = q.z - q.tx * b;
			const f = st.age[i] / st.life[i];
			const e = sstep(0, 0.25, f) * (1 - sstep(0.65, 1, f)) * (1 - sstep(FLOAT_END - FLOAT_FADE, FLOAT_END, st.s[i]));
			const yaw = Math.atan2(q.tx, q.tz) + (STREAK_MEANDER * 1.7 * Math.cos(ph)) / speed + st.flip[i];
			setArc(streaks, i, px, groundAt(px, pz) + STREAK_LIFT, pz, yaw, st.thick[i] * (0.5 + 0.5 * e), (st.len[i] / STREAK_ARC) * e);
		}
		streaks.instanceMatrix.needsUpdate = true;
	}

	function initStreaks() {
		for (let i = 0; i < STREAK_N; i++) spawnStreak(i, true);
	}

	// duck wakes: pairs of arcs left behind the duck, drifting with the current and spreading outward
	const wakes = pool(arcGeo, WAKE_N);
	const wk = {
		age: new Float32Array(WAKE_N),
		x: new Float32Array(WAKE_N),
		z: new Float32Array(WAKE_N),
		vx: new Float32Array(WAKE_N),
		vz: new Float32Array(WAKE_N),
		yaw: new Float32Array(WAKE_N),
		size: new Float32Array(WAKE_N),
	};
	let wakeNext = 0;

	function spawnWake(x, z, yaw, sc, tx, tz) {
		const fx = Math.sin(yaw);
		const fz = Math.cos(yaw);
		const rx = fz;
		const rz = -fx;
		for (const sgn of [1, -1]) {
			const i = wakeNext;
			wakeNext = (wakeNext + 1) % WAKE_N;
			// arm direction: backward and outward; the arc starts at the tail and its center sits half an arm out
			const dx = -fx * Math.cos(WAKE_ANGLE) + rx * sgn * Math.sin(WAKE_ANGLE);
			const dz = -fz * Math.cos(WAKE_ANGLE) + rz * sgn * Math.sin(WAKE_ANGLE);
			const half = 0.07 * sc;
			wk.age[i] = 0;
			wk.x[i] = x - fx * 0.12 * sc + dx * half;
			wk.z[i] = z - fz * 0.12 * sc + dz * half;
			wk.vx[i] = tx * WAKE_DRIFT + rx * sgn * WAKE_SPREAD * sc;
			wk.vz[i] = tz * WAKE_DRIFT + rz * sgn * WAKE_SPREAD * sc;
			wk.yaw[i] = Math.atan2(dx, dz) + (sgn > 0 ? 0 : Math.PI); // bulge toward the track
			wk.size[i] = sc;
		}
	}

	function updateWakes(dt) {
		for (let i = 0; i < WAKE_N; i++) {
			if (wk.age[i] < 0) continue;
			wk.age[i] += dt;
			const f = wk.age[i] / WAKE_LIFE;
			if (f >= 1) {
				wk.age[i] = -1;
				setArc(wakes, i, 0, 0, 0, 0, 0, 0);
				continue;
			}
			wk.x[i] += wk.vx[i] * dt;
			wk.z[i] += wk.vz[i] * dt;
			const e = sstep(0, 0.12, f) * (1 - sstep(0.3, 1, f));
			const sc = wk.size[i];
			setArc(wakes, i, wk.x[i], groundAt(wk.x[i], wk.z[i]) + STREAK_LIFT, wk.z[i], wk.yaw[i], (0.5 + 0.5 * e) * (0.55 + 0.45 * sc), sc * (0.6 + 0.4 * f) * e);
		}
		wakes.instanceMatrix.needsUpdate = true;
	}

	function clearWakes() {
		for (let i = 0; i < WAKE_N; i++) {
			wk.age[i] = -1;
			setArc(wakes, i, 0, 0, 0, 0, 0, 0);
		}
		wakes.instanceMatrix.needsUpdate = true;
	}

	// ripple rings: flat tori that expand, sink and flatten away
	const rings = pool(ringGeo, RING_N);
	const rg = {
		age: new Float32Array(RING_N),
		x: new Float32Array(RING_N),
		z: new Float32Array(RING_N),
		rmax: new Float32Array(RING_N),
	};
	let ringNext = 0;
	let fallRingT = 0;

	function setRing(i, x, y, z, r, sy) {
		const a = rings.instanceMatrix.array;
		const o = i * 16;
		a.fill(0, o, o + 16);
		a[o] = r;
		a[o + 5] = sy;
		a[o + 10] = r;
		a[o + 12] = x;
		a[o + 13] = y;
		a[o + 14] = z;
		a[o + 15] = 1;
	}

	function spawnRing(x, z) {
		const i = ringNext;
		ringNext = (ringNext + 1) % RING_N;
		rg.age[i] = 0;
		rg.x[i] = x;
		rg.z[i] = z;
		rg.rmax[i] = RING_R[1] * rr(0.85, 1.05);
	}

	function updateRings(dt) {
		fallRingT -= dt;
		if (fallRingT <= 0) {
			fallRingT = rr(RING_FALL_EVERY[0], RING_FALL_EVERY[1]);
			const { land } = fall;
			const jb = rr(-0.2, 0.2);
			const jd = rr(-0.08, 0.08);
			spawnRing(land.x + land.tz * jb + land.tx * jd, land.z - land.tx * jb + land.tz * jd);
		}
		for (let i = 0; i < RING_N; i++) {
			if (rg.age[i] < 0) continue;
			rg.age[i] += dt;
			const f = rg.age[i] / RING_LIFE;
			if (f >= 1) {
				rg.age[i] = -1;
				setRing(i, 0, 0, 0, 0, 0);
				continue;
			}
			const r = RING_R[0] + (rg.rmax[i] - RING_R[0]) * (1 - (1 - f) ** 2);
			const sy = 0.2 * (1 - f * f) * sstep(0, 0.08, f);
			setRing(i, rg.x[i], groundAt(rg.x[i], rg.z[i]) + 0.013 - 0.012 * f * f, rg.z[i], r, sy);
		}
		rings.instanceMatrix.needsUpdate = true;
	}

	function clearRings() {
		for (let i = 0; i < RING_N; i++) {
			rg.age[i] = -1;
			setRing(i, 0, 0, 0, 0, 0);
		}
		rings.instanceMatrix.needsUpdate = true;
		fallRingT = 0.3;
	}

	// -----------------------------------------------------------------------
	initStreaks();
	clearWakes();
	clearRings();
	initFloaters();
	// place everything once so nothing sits at the origin before the first frame
	updateStreaks(0);
	updateDucks(0, 0);
	updateLeaves(0, 0);
	fall.update(0, 0);

	return {
		items,
		floaters, // ducks, leaves, streaks, wakes, rings and foam drops: moving objects the intro hides until the world is complete
		update(t, dt) {
			updateFlow(t, dt);
			fall.update(t, dt);
			wheel.update(dt);
			updateDucks(t, dt);
			updateLeaves(t, dt);
			updateDrops(dt);
			updateStreaks(dt);
			updateWakes(dt);
			updateRings(dt);
		},
		reset() {
			rand = rng(4242);
			flowV = 0;
			riverTex.forEach((tex, i) => tex.offset.copy(riverOff[i]));
			fall.reset();
			wheel.reset();
			initStreaks();
			clearWakes();
			clearRings();
			initFloaters();
		},
	};
}
