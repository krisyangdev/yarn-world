// Cottage smoke and weathervane: the two things on the house that move because of the shared wind (wind.js).
//   1. chimney smoke  a steady stream of white yarn pompoms from the chimney top; each one is advected by the
//                     wind at its own position, so the column leans in the breeze and streams sideways when
//                     a gust band crosses it
//   2. weathervane    a felt arrow on a wooden post at the front end of the roof ridge; it turns to point
//                     downwind on a spring and wobbles more the harder the wind blows
// The integrator calls setupSmoke({ root, wind, kit, house }) once, update(t, dt) every frame and reset() on
// R / replay. The puffs live in world space under root (one InstancedMesh); the vane is a child of house.react,
// so it squashes with the house. `vane` is the vane group, for the knit-in intro.
import * as THREE from 'three';
import { Spring } from './spring.js';

const TAU = Math.PI * 2;

// --- feel knobs ------------------------------------------------------------
// smoke
const SMOKE_POOL = 14;
const SMOKE_EVERY = 0.45; // s between puffs
const SMOKE_LIFE = 3.5;
const SMOKE_R = [0.06, 0.2]; // radius at emission, fullest
const SMOKE_GROW = 0.6; // fraction of the life spent growing
const SMOKE_FADE = 0.7; // fraction of the life where it starts shrinking away
const SMOKE_RISE = 0.5; // units/s at emission; slows to 40% by the end of the life
const SMOKE_DRIFT = [0.05, 0.55]; // horizontal units/s along the wind: base, per unit of wind strength
const SMOKE_INERTIA = 2.5; // 1/s: how fast a puff's velocity follows the local wind
const SMOKE_CURL = [0.16, 2.2, 1.1]; // sideways speed, rate (rad/s) along the puff's age, rate along the clock
const SMOKE_SPIN = 0.7; // rad/s
const SMOKE_SIZE_VARY = [0.7, 1.15]; // per-puff size factor, so the column doesn't read as a row of equal beads
const SMOKE_GLOW = 0.35;
// weathervane
const VANE_POS = [0, 1.7, 0.6]; // react-local: front end of the ridge
const VANE_POST_H = 0.24;
const VANE_ARM = 0.075; // half length of the N/S/E/W cross bars
const VANE_SPRING = [20, 2.0]; // stiffness, damping (underdamped: it overshoots and settles)
const VANE_WOBBLE = [0.15, 3.1, 1.6]; // peak angle (rad) at VANE_WIND_MAX, rate (rad/s), wind strength that peaks it
const VANE_WIND_MAX = 1.6;

const noRaycast = () => {};
const sstep = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

export function setupSmoke({ root, wind, kit, house }) {
	const { P } = kit;
	const { anchor, react, chimneyTop } = house;
	const dirX = wind.dir.x;
	const dirZ = wind.dir.y;

	// ---------------------------------------------------------------------
	// 1. Chimney smoke
	// ---------------------------------------------------------------------
	// one unit-scale pompom geometry at the fullest radius; instances scale down from it
	// a touch of glow keeps the white puffs apart from the pale backdrop
	const smokeMat = kit.mat(P.white, 'boucle', kit.sphereRep(SMOKE_R[1])).clone();
	smokeMat.emissive = new THREE.Color(P.white);
	smokeMat.emissiveIntensity = SMOKE_GLOW;
	const smokeMesh = new THREE.InstancedMesh(
		kit.sphereGeo(SMOKE_R[1]),
		smokeMat,
		SMOKE_POOL,
	);
	smokeMesh.castShadow = false;
	smokeMesh.receiveShadow = false;
	smokeMesh.frustumCulled = false; // instances move far from the geometry's own bounds
	smokeMesh.raycast = noRaycast;
	root.add(smokeMesh);

	const m4 = new THREE.Matrix4();
	const zero = new THREE.Matrix4().makeScale(0, 0, 0);
	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scl = new THREE.Vector3();
	const eul = new THREE.Euler();
	const emit = new THREE.Vector3();
	const vanePos = new THREE.Vector3();

	const puffs = [];
	for (let i = 0; i < SMOKE_POOL; i++) {
		smokeMesh.setMatrixAt(i, zero);
		puffs.push({ active: false, age: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, phase: 0, spin: 0, tilt: 0, size: 1 });
	}
	smokeMesh.instanceMatrix.needsUpdate = true;
	let emitTimer = 0;
	let emitted = 0;

	function spawn(t) {
		const p = puffs.find((q) => !q.active);
		if (!p) return;
		const drift = SMOKE_DRIFT[0] + SMOKE_DRIFT[1] * wind.at(emit.x, emit.z);
		p.active = true;
		p.age = 0;
		p.x = emit.x;
		p.y = emit.y;
		p.z = emit.z;
		p.vx = dirX * drift;
		p.vz = dirZ * drift;
		// phase follows the clock, so neighbouring puffs wobble together and the column weaves as one
		p.phase = t * SMOKE_CURL[2];
		p.spin = (emitted++ % 2 ? 1 : -1) * SMOKE_SPIN;
		p.tilt = 0.25 * Math.sin(emitted * 2.4);
		p.size = SMOKE_SIZE_VARY[0] + (SMOKE_SIZE_VARY[1] - SMOKE_SIZE_VARY[0]) * (0.5 + 0.5 * Math.sin(emitted * 3.7));
	}

	function updateSmoke(t, dt) {
		emit.set(chimneyTop.x, chimneyTop.y, chimneyTop.z);
		react.localToWorld(emit);
		emitTimer += dt;
		while (emitTimer >= SMOKE_EVERY) {
			emitTimer -= SMOKE_EVERY;
			spawn(t);
		}
		const follow = Math.min(1, dt * SMOKE_INERTIA);
		for (let i = 0; i < SMOKE_POOL; i++) {
			const p = puffs[i];
			if (p.active) {
				p.age += dt;
				if (p.age >= SMOKE_LIFE) p.active = false;
			}
			if (!p.active) {
				smokeMesh.setMatrixAt(i, zero);
				continue;
			}
			const f = p.age / SMOKE_LIFE;
			// velocity follows the wind at the puff's own position, so a gust bends the column from the top down
			const drift = SMOKE_DRIFT[0] + SMOKE_DRIFT[1] * wind.at(p.x, p.z);
			p.vx += (dirX * drift - p.vx) * follow;
			p.vz += (dirZ * drift - p.vz) * follow;
			const curl = SMOKE_CURL[0] * f * Math.sin(p.age * SMOKE_CURL[1] + p.phase);
			p.x += (p.vx - dirZ * curl) * dt;
			p.z += (p.vz + dirX * curl) * dt;
			p.y += SMOKE_RISE * (1 - 0.6 * f) * dt;
			const grow = 1 - (1 - sstep(0, SMOKE_GROW, f)) ** 2;
			const r = (SMOKE_R[0] + (SMOKE_R[1] - SMOKE_R[0]) * grow) * (1 - sstep(SMOKE_FADE, 1, f));
			pos.set(p.x, p.y, p.z);
			eul.set(p.tilt, p.spin * p.age, 0);
			quat.setFromEuler(eul);
			scl.setScalar(Math.max(0.0001, (p.size * r) / SMOKE_R[1]));
			smokeMesh.setMatrixAt(i, m4.compose(pos, quat, scl));
		}
		smokeMesh.instanceMatrix.needsUpdate = true;
	}

	// ---------------------------------------------------------------------
	// 2. Weathervane
	// ---------------------------------------------------------------------
	const vane = new THREE.Group();
	vane.position.set(VANE_POS[0], VANE_POS[1], VANE_POS[2]);
	react.add(vane);

	const woodMat = kit.mat(P.wood, 'stockinette', [1, 4]);
	const barMat = kit.mat(P.charcoal, 'stockinette', [1, 3]);
	const postGeo = kit.cachedGeo('smokeVanePost', () => new THREE.CylinderGeometry(0.01, 0.014, VANE_POST_H, 8));
	const barGeo = kit.cachedGeo('smokeVaneBar', () => new THREE.CylinderGeometry(0.007, 0.007, VANE_ARM * 2, 6));
	kit.add(vane, new THREE.Mesh(postGeo, woodMat)).position.y = VANE_POST_H / 2;

	// N/S/E/W cross: two bars with a pompom on each end (fixed to the house, does not turn)
	const crossY = 0.1;
	kit.add(vane, new THREE.Mesh(barGeo, barMat)).rotation.z = Math.PI / 2;
	kit.add(vane, new THREE.Mesh(barGeo, barMat)).rotation.x = Math.PI / 2;
	for (const bar of vane.children.slice(-2)) bar.position.y = crossY;
	const tipMat = kit.mat(P.cream, 'boucle', kit.sphereRep(0.018));
	for (const [x, z] of [
		[VANE_ARM, 0],
		[-VANE_ARM, 0],
		[0, VANE_ARM],
		[0, -VANE_ARM],
	]) {
		kit.sphere(vane, 0.018, tipMat, x, crossY, z);
	}
	// arrow on a cream ball; the pivot turns about the post axis
	kit.sphere(vane, 0.024, kit.mat(P.cream, 'boucle', kit.sphereRep(0.024)), 0, VANE_POST_H + 0.005, 0);
	const pivot = new THREE.Group();
	pivot.position.y = VANE_POST_H + 0.03;
	vane.add(pivot);
	const arrowGeo = kit.cachedGeo('smokeVaneArrow', () => {
		// points along +x, flat in the xy plane, fish-tail fletching behind the pivot
		const pts = [
			[0.16, 0],
			[0.07, 0.05],
			[0.07, 0.015],
			[-0.11, 0.015],
			[-0.15, 0.055],
			[-0.125, 0],
			[-0.15, -0.055],
			[-0.11, -0.015],
			[0.07, -0.015],
			[0.07, -0.05],
		];
		const shape = new THREE.Shape();
		pts.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
		shape.closePath();
		const depth = 0.014;
		const g = new THREE.ExtrudeGeometry(shape, {
			depth,
			bevelEnabled: true,
			bevelThickness: 0.004,
			bevelSize: 0.004,
			bevelSegments: 2,
			curveSegments: 4,
		});
		g.translate(0, 0, -depth / 2);
		return g;
	});
	kit.add(pivot, new THREE.Mesh(arrowGeo, kit.mat(P.mustard, 'stockinette', [12, 12])));
	// small charcoal pompom on the arrow tip
	kit.sphere(pivot, 0.016, kit.mat(P.charcoal, 'boucle', kit.sphereRep(0.016)), 0.16, 0, 0);

	const yawSpring = new Spring(VANE_SPRING[0], VANE_SPRING[1], 0);
	// rotation.y that turns local +x onto the wind direction, relative to the house yaw
	const downwindYaw = () => Math.atan2(-dirZ, dirX) - anchor.rotation.y;

	function updateVane(t, dt) {
		vanePos.set(VANE_POS[0], VANE_POS[1], VANE_POS[2]);
		react.localToWorld(vanePos);
		const w = wind.at(vanePos.x, vanePos.z);
		const amp = VANE_WOBBLE[0] * Math.min(1, w / VANE_WIND_MAX);
		const wobble = amp * (0.7 * Math.sin(t * VANE_WOBBLE[1]) + 0.3 * Math.sin(t * VANE_WOBBLE[1] * 2.3 + 1.7));
		// aim at the nearest equivalent of the downwind angle so the spring never turns the long way round
		let d = downwindYaw() - yawSpring.value;
		d -= TAU * Math.round(d / TAU);
		yawSpring.target = yawSpring.value + d + wobble;
		pivot.rotation.y = yawSpring.update(dt);
	}

	// ---------------------------------------------------------------------
	// per frame
	// ---------------------------------------------------------------------
	function update(t, dt) {
		dt = Math.min(dt, 0.05);
		updateSmoke(t, dt);
		updateVane(t, dt);
	}

	function reset() {
		for (let i = 0; i < SMOKE_POOL; i++) {
			puffs[i].active = false;
			smokeMesh.setMatrixAt(i, zero);
		}
		smokeMesh.instanceMatrix.needsUpdate = true;
		emitTimer = 0;
		yawSpring.snap(downwindYaw());
		pivot.rotation.y = yawSpring.value;
	}
	reset();

	return { update, reset, vane };
}
