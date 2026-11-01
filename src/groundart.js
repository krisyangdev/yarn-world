// Ground art: things that live on the quilt surface.
//
//   flowers   ~25 lazy-daisy embroidery flowers (petal loops of strand yarn + a French-knot bead),
//             merged per color, lying on the green patches. Added to `ground`, so the knit intro reveals them.
//   path      dotted cross-stitch path: cottage gap -> nearer bridge end, far bridge end -> meadow. In `ground`.
//   garden    knitted vegetable plot: seed-stitch soil bed, 3 furrow ridges, 3 cabbages, 6 carrots.
//             Poke a carrot: it pops out, spins, lands beside the bed, sinks back after a while and regrows.
//             Poke a cabbage: it wobbles. One intro item (stage 'garden').
//   shadows   3 soft cloud shadows drifting along the wind. Decal grids re-sampled on the terrain every frame.
//
// Everything in `ground` uses plain kit.mat materials: the intro clones and patches them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Spring } from './spring.js';
import { playPop, playRustle } from './sound.js';
import { L, S, FLOWER_CLUSTERS } from './layout.js';

// ---------------------------------------------------------------------------
// Feel knobs
// ---------------------------------------------------------------------------
// flowers
const FLOWER_COUNT = 25;
const FLOWER_GAP = 0.9; // min distance between flowers
const PETAL_LEN = [0.17, 0.23];
const PETAL_WIDTH = 0.11;
const PETAL_R = 0.016; // yarn radius
const KNOT_R = 0.038;
const LIE = 0.016; // strand centerline above the ground

// path
const X_STEP = 0.2; // distance between cross stitches
const X_HALF = 0.055; // half length of an X arm
const X_R = 0.014;
const GAP_DIST = 1.75; // fence gap, along the house facing (same as buildFence)
const STEP_DIST = 1.2; // path starts just past the door step
const MEADOW = L(-1.0, 2.0);

// garden
const GARDEN_WISH = L(1.9, 2.0);
const BED_YAW = 0.685; // long side faces the default camera
const BED_W = 1.2;
const BED_D = 0.8;
const SOIL_TOP = 0.1;
const ROW_Z = [-0.24, 0.02, 0.26]; // furrow rows (local z): cabbages, carrots, carrots
const RIDGE_TOP = 0.135;
const SOIL = '#8a6342';
const SOIL_LIGHT = '#9a7048';
const CARROT = '#f0903f';
const CABBAGE_CORE = '#c3d6a6';
const POP_PITCH = 1.2;
const FLY_T = 0.85; // s a poked carrot is in the air
const FLY_PEAK = 0.6; // extra height of the arc
const LIE_T = 5.2; // s a carrot lies beside the bed
const SINK_T = 0.45;
const WAIT_T = 0.35;
const LAND_KICK = 9; // squash velocity on landing
const HOVER_LIFT = 0.035;
const CAB_KICK = 3.2; // wobble velocity (rad/s) of a poked cabbage

// cloud shadows
const SHADOW_SPEED = 0.5; // units/s in a breeze, gusts push faster
const SHADOW_OPACITY = 0.24;
const SHADOW_GRID = 20;
const SHADOW_LIFT = 0.03;
const SHADOW_RANGE = S(9); // travel runs from -range to +range along the wind
const SHADOW_FADE = [0.88, 0.97]; // sE where the shadow fades out at the cushion edge
const SHADOW_COLOR = '#2c3a5a';
// spread evenly over the travel range so one is always crossing the island
const SHADOWS = [
	{ size: 4.0, depth: 3.0, s: S(-6.0), l: S(-2.0), rot: 0.3, seed: 11 },
	{ size: 3.4, depth: 2.6, s: S(0.0), l: S(1.6), rot: -0.5, seed: 23 },
	{ size: 4.4, depth: 3.2, s: S(6.0), l: S(-0.4), rot: 0.9, seed: 37 },
];

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const tmpV = new THREE.Vector3();

function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const smooth = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const lerp = THREE.MathUtils.lerp;

// distance from (px, pz) to the segment a-b in xz
function distSeg(px, pz, ax, az, bx, bz) {
	const dx = bx - ax;
	const dz = bz - az;
	const l2 = dx * dx + dz * dz;
	let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function setupGroundArt({ ground, root, kit, terrain, wind }) {
	const { P, mat } = kit;
	const { heightAt, groundAt, surf, riverQuery, isGreen, blockers, H, E0, sE, HOUSE, bridgeEnds } = terrain;
	const rand = mulberry32(777);

	const mergeAndDispose = (list) => {
		const g = mergeGeometries(list);
		list.forEach((x) => x.dispose());
		return g;
	};
	// flat embroidery: lies in `ground`, takes shadows but does not cast them
	const embroider = (geo, material) => {
		const m = new THREE.Mesh(geo, material);
		m.receiveShadow = true;
		ground.add(m);
		return m;
	};

	// -------------------------------------------------------------------------
	// Cross-stitch path
	// -------------------------------------------------------------------------
	const [houseTargetX, houseTargetZ] = L(0.9, 0.1);
	const yawHouse = Math.atan2(houseTargetX - HOUSE.x, houseTargetZ - HOUSE.z); // facing, as in buildHouse / buildFence
	const fx = Math.sin(yawHouse);
	const fz = Math.cos(yawHouse);
	const gapX = HOUSE.x + fx * GAP_DIST;
	const gapZ = HOUSE.z + fz * GAP_DIST;
	const [bNear, bFar] =
		Math.hypot(bridgeEnds[0].x - gapX, bridgeEnds[0].z - gapZ) <= Math.hypot(bridgeEnds[1].x - gapX, bridgeEnds[1].z - gapZ)
			? [bridgeEnds[0], bridgeEnds[1]]
			: [bridgeEnds[1], bridgeEnds[0]];
	// a point just beyond a bridge end, on the far side of the bridge
	const beyond = (end, other, d) => {
		const dx = end.x - other.x;
		const dz = end.z - other.z;
		const l = Math.hypot(dx, dz) || 1;
		return [end.x + (dx / l) * d, end.z + (dz / l) * d];
	};
	// midpoint of a-b pushed sideways by k * length
	const bent = (a, b, k) => {
		const dx = b[0] - a[0];
		const dz = b[1] - a[1];
		return [(a[0] + b[0]) / 2 - dz * k, (a[1] + b[1]) / 2 + dx * k];
	};

	const stitches = []; // [x, z] of every cross stitch: flowers and the garden stay clear of them
	const crossGeos = [];
	function stitchAlong(points) {
		const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)));
		const n = Math.max(2, Math.round(curve.getLength() / X_STEP));
		const pts = curve.getSpacedPoints(n);
		const tan = new THREE.Vector3();
		for (let i = 0; i <= n; i++) {
			const { x, z } = pts[i];
			if (riverQuery(x, z).d < 0.75 || sE(x / H, z / H) > 0.8) continue;
			if (blockers.some(([bx, bz, r]) => Math.hypot(x - bx, z - bz) < r * 0.7)) continue;
			curve.getTangentAt(i / n, tan);
			const base = Math.atan2(tan.z, tan.x);
			stitches.push([x, z]);
			for (const sign of [1, -1]) {
				const a = base + sign * (Math.PI / 4) + (rand() - 0.5) * 0.25;
				const dx = Math.cos(a) * X_HALF;
				const dz = Math.sin(a) * X_HALF;
				const p0 = new THREE.Vector3(x - dx, heightAt(x - dx, z - dz) + LIE, z - dz);
				const p1 = new THREE.Vector3(x + dx, heightAt(x + dx, z + dz) + LIE, z + dz);
				crossGeos.push(new THREE.TubeGeometry(new THREE.LineCurve3(p0, p1), 2, X_R, 5, false));
			}
		}
	}
	{
		const gap = [gapX, gapZ];
		const near = beyond(bNear, bFar, 0.3);
		stitchAlong([[HOUSE.x + fx * STEP_DIST, HOUSE.z + fz * STEP_DIST], gap, bent(gap, near, 0.12), near]);
		const far = beyond(bFar, bNear, 0.3);
		stitchAlong([far, bent(far, MEADOW, -0.14), MEADOW]);
	}
	if (crossGeos.length) embroider(mergeAndDispose(crossGeos), mat(P.cream, 'strand', [1, 1]));

	// -------------------------------------------------------------------------
	// Vegetable garden placement: nearest free green spot to the wish
	// -------------------------------------------------------------------------
	const bedWorld = (cx, cz, lx, lz) => {
		const cs = Math.cos(BED_YAW);
		const sn = Math.sin(BED_YAW);
		return [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
	};
	function gardenOk(cx, cz) {
		if (sE(cx / H, cz / H) > 0.72 || !isGreen(cx, cz)) return false;
		if (riverQuery(cx, cz).d < 1.3) return false;
		const h0 = heightAt(cx, cz);
		for (const [lx, lz] of [[-0.7, -0.5], [0.7, -0.5], [-0.7, 0.5], [0.7, 0.5]]) {
			const [x, z] = bedWorld(cx, cz, lx, lz);
			if (riverQuery(x, z).d < 1.0 || Math.abs(heightAt(x, z) - h0) > 0.14) return false;
		}
		if (blockers.some(([bx, bz, r]) => Math.hypot(cx - bx, cz - bz) < r + 0.95)) return false;
		if (distSeg(cx, cz, bridgeEnds[0].x, bridgeEnds[0].z, bridgeEnds[1].x, bridgeEnds[1].z) < 1.4) return false;
		if (stitches.some(([x, z]) => Math.hypot(cx - x, cz - z) < 1.0)) return false;
		if (FLOWER_CLUSTERS.some(([x, z]) => Math.hypot(cx - x, cz - z) < 1.65)) return false;
		return true;
	}
	function pickGarden() {
		for (let r = 0; r <= S(4.4); r += 0.2) {
			const steps = r === 0 ? 1 : Math.round(r * 10);
			for (let k = 0; k < steps; k++) {
				const a = (TAU * k) / steps;
				const x = GARDEN_WISH[0] + Math.cos(a) * r;
				const z = GARDEN_WISH[1] + Math.sin(a) * r;
				if (gardenOk(x, z)) return [x, z];
			}
		}
		return GARDEN_WISH;
	}
	const [gcx, gcz] = pickGarden();

	// -------------------------------------------------------------------------
	// Embroidered flowers
	// -------------------------------------------------------------------------
	{
		const colors = [P.coral, P.cream, P.lavender, P.mustard, P.sky];
		const petals = colors.map(() => []);
		const knots = { [P.mustard]: [], [P.coral]: [] };
		const placed = [];
		const flowerOk = (x, z) => {
			if (sE(x / H, z / H) > 0.78 || !isGreen(x, z) || riverQuery(x, z).d < 0.9) return false;
			if (blockers.some(([bx, bz, r]) => Math.hypot(x - bx, z - bz) < r + 0.25)) return false;
			if (Math.hypot(x - gcx, z - gcz) < 1.25) return false;
			if (distSeg(x, z, bridgeEnds[0].x, bridgeEnds[0].z, bridgeEnds[1].x, bridgeEnds[1].z) < 1.1) return false;
			if (stitches.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 0.4)) return false;
			return placed.every(([px, pz]) => Math.hypot(x - px, z - pz) > FLOWER_GAP);
		};
		for (let tries = 0; placed.length < FLOWER_COUNT && tries < 5000; tries++) {
			const x = (rand() * 2 - 1) * S(6);
			const z = (rand() * 2 - 1) * S(6);
			if (!flowerOk(x, z)) continue;
			const ci = placed.length % colors.length;
			placed.push([x, z]);
			const n = rand() < 0.5 ? 5 : 6;
			const a0 = rand() * TAU;
			const len = lerp(PETAL_LEN[0], PETAL_LEN[1], rand());
			for (let k = 0; k < n; k++) {
				const ang = a0 + (k / n) * TAU;
				const ca = Math.cos(ang);
				const sa = Math.sin(ang);
				// teardrop loop: pointed at the flower center, fat toward the tip
				const pts = [];
				for (let j = 0; j < 10; j++) {
					const th = (j / 10) * TAU;
					const along = (len / 2) * (1 - Math.cos(th));
					const side = (PETAL_WIDTH / 2) * Math.sin(th) * (0.5 + 0.5 * Math.sin(th / 2));
					const px = x + ca * along - sa * side;
					const pz = z + sa * along + ca * side;
					pts.push(new THREE.Vector3(px, heightAt(px, pz) + LIE, pz));
				}
				petals[ci].push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 24, PETAL_R, 5, true));
			}
			const knotColor = colors[ci] === P.mustard ? P.coral : P.mustard;
			const knot = new THREE.SphereGeometry(KNOT_R, 8, 6);
			knot.translate(x, heightAt(x, z) + 0.026, z);
			knots[knotColor].push(knot);
		}
		colors.forEach((color, i) => {
			if (petals[i].length) embroider(mergeAndDispose(petals[i]), mat(color, 'strand', [4, 1]));
		});
		for (const color of [P.mustard, P.coral]) {
			if (knots[color].length) embroider(mergeAndDispose(knots[color]), mat(color, 'boucle', kit.sphereRep(KNOT_R)));
		}
	}

	// -------------------------------------------------------------------------
	// Vegetable garden
	// -------------------------------------------------------------------------
	const garden = new THREE.Group();
	garden.rotation.order = 'YXZ';
	root.add(garden);
	{
		// stand on the slope, like the sheep
		const sn = Math.sin(BED_YAW);
		const cs = Math.cos(BED_YAW);
		const hF = heightAt(gcx + sn * 0.35, gcz + cs * 0.35);
		const hB = heightAt(gcx - sn * 0.35, gcz - cs * 0.35);
		const hR = heightAt(gcx + cs * 0.55, gcz - sn * 0.55);
		const hL = heightAt(gcx - cs * 0.55, gcz + sn * 0.55);
		garden.position.set(gcx, (hF + hB + hR + hL) / 4, gcz);
		garden.rotation.set(-Math.atan2(hF - hB, 0.7), BED_YAW, Math.atan2(hR - hL, 1.1));
		garden.updateWorldMatrix(true, false);
	}

	// soil bed, rope rim, furrow ridges
	{
		const bed = kit.add(garden, new THREE.Mesh(new RoundedBoxGeometry(BED_W, 0.16, BED_D, 3, 0.04), mat(SOIL, 'seed', [1.5, 1])));
		bed.position.y = SOIL_TOP - 0.08;

		const rim = [];
		for (let k = 0; k < 48; k++) {
			const a = (k / 48) * TAU;
			const c = Math.cos(a);
			const s = Math.sin(a);
			// superellipse = rounded rectangle
			rim.push(
				new THREE.Vector3(
					(BED_W / 2 - 0.01) * Math.sign(c) * Math.pow(Math.abs(c), 1 / 3),
					SOIL_TOP + 0.005,
					(BED_D / 2 - 0.01) * Math.sign(s) * Math.pow(Math.abs(s), 1 / 3),
				),
			);
		}
		const rimCurve = new THREE.CatmullRomCurve3(rim, true);
		const rimGeo = new THREE.TubeGeometry(rimCurve, 96, 0.03, 6, true);
		kit.add(garden, new THREE.Mesh(rimGeo, mat(P.wood, 'strand', kit.strandRep(rimCurve.getLength(), 8, 0.12))));

		const ridgeGeo = kit.cachedGeo('gardenRidge', () => new THREE.CapsuleGeometry(0.075, 0.95, 6, 12).rotateZ(HALF_PI));
		const ridgeMat = mat(SOIL_LIGHT, 'rib', [1, 2]);
		for (const z of ROW_Z) {
			const ridge = kit.add(garden, new THREE.Mesh(ridgeGeo, ridgeMat));
			ridge.scale.y = 0.55;
			ridge.position.set(0, RIDGE_TOP - 0.075 * 0.55, z);
		}
	}

	// ---- cabbages ----
	const cabbageParts = (() => {
		// shell of a sphere facing +x, wrapped around the core
		const leaf = (R, theta0, theta1) =>
			new THREE.SphereGeometry(R, 18, 10, 0.6 * Math.PI, 0.8 * Math.PI, theta0 * Math.PI, (theta1 - theta0) * Math.PI);
		const ring = (n, R, t0, t1, y, splay, yaw0) => {
			const list = [];
			const m4 = new THREE.Matrix4();
			const e = new THREE.Euler(0, 0, 0, 'YXZ');
			for (let k = 0; k < n; k++) {
				const g = leaf(R, t0, t1);
				e.set(0, yaw0 + (k / n) * TAU + (k % 2) * 0.12, -splay);
				m4.makeRotationFromEuler(e).setPosition(0, y, 0);
				g.applyMatrix4(m4);
				list.push(g);
			}
			return mergeAndDispose(list);
		};
		return {
			outer: ring(5, 0.19, 0.12, 0.72, 0.13, 0.28, 0),
			inner: ring(4, 0.155, 0.1, 0.68, 0.15, 0.1, 0.6),
		};
	})();
	const leafMat = (color) => {
		const m = mat(color, 'stockinette', [3, 3]).clone();
		m.side = THREE.DoubleSide;
		return m;
	};
	const cabOuterMat = leafMat(P.olive);
	const cabInnerMat = leafMat(P.sage);
	const cabCoreMat = mat(CABBAGE_CORE, 'stockinette', kit.sphereRep(0.11));
	const cabbages = [];
	for (let i = 0; i < 3; i++) {
		const x = [-0.36, 0, 0.36][i];
		const z = ROW_Z[0];
		const group = new THREE.Group();
		group.position.set(x, RIDGE_TOP - 0.02, z);
		group.rotation.y = rand() * TAU;
		group.scale.setScalar(0.85);
		garden.add(group);
		const wob = new THREE.Group();
		group.add(wob);
		kit.add(wob, new THREE.Mesh(cabbageParts.outer, cabOuterMat));
		kit.add(wob, new THREE.Mesh(cabbageParts.inner, cabInnerMat));
		kit.sphere(wob, 0.11, cabCoreMat, 0, 0.12, 0);
		const c = {
			group, wob, x, z,
			rx: new Spring(170, 6.5),
			rz: new Spring(170, 6.5),
			sq: new Spring(240, 9),
		};
		group.userData.onPoke = (hit) => {
			playRustle();
			let kx = rand() - 0.5;
			let kz = rand() - 0.5;
			if (hit?.point) {
				// lean away from the finger
				tmpV.copy(hit.point);
				garden.worldToLocal(tmpV);
				const dx = tmpV.x - c.x;
				const dz = tmpV.z - c.z;
				const l = Math.hypot(dx, dz) || 1;
				kx = -dz / l;
				kz = dx / l;
			}
			c.rx.kick(kx * CAB_KICK);
			c.rz.kick(kz * CAB_KICK);
			c.sq.kick(4);
		};
		cabbages.push(c);
	}
	function updateCabbage(c, dt) {
		if (c.rx.settled && c.rz.settled && c.sq.settled) return;
		const q = c.sq.update(dt);
		c.wob.rotation.set(c.rx.update(dt), 0, c.rz.update(dt));
		c.wob.scale.set(1 + 0.5 * q, Math.max(0.5, 1 - q), 1 + 0.5 * q);
	}

	// ---- carrots ----
	const carrotBodyGeo = kit.cachedGeo('carrotBody', () =>
		new THREE.LatheGeometry(
			[[0.003, 0], [0.02, 0.06], [0.036, 0.14], [0.046, 0.22], [0.05, 0.27], [0.04, 0.3], [0.0, 0.305]].map(
				([r, y]) => new THREE.Vector2(r, y),
			),
			14,
		),
	);
	const carrotLeavesGeo = kit.cachedGeo('carrotLeaves', () => {
		const r = mulberry32(5);
		const list = [];
		for (let i = 0; i < 8; i++) {
			const a = (i / 8) * TAU + (r() - 0.5) * 0.5;
			const s = 0.8 + 0.4 * r();
			const c = Math.cos(a);
			const sn = Math.sin(a);
			// [outward, up]: rises, then arches outward
			const pts = [
				[0, 0],
				[0.025, 0.07 * s],
				[0.07, 0.15 * s],
				[0.13 * s, 0.2 * s],
			].map(([o, y]) => new THREE.Vector3(c * o, y, sn * o));
			list.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.014, 5, false));
		}
		return mergeAndDispose(list);
	});
	const carrotBodyMat = mat(CARROT, 'rib', [1, 1]);
	const carrotLeafMat = mat(P.grass, 'strand', [2, 1]);
	const carrotBushMat = mat(P.olive, 'boucle', kit.sphereRep(0.045));

	// tip at -0.15 and shoulder cap at +0.155 in mover space; 0.06 of the cap shows above the ridge
	const CARROT_REST = RIDGE_TOP + 0.06 - 0.155;
	const LIE_R = 0.05; // lying carrot center above the ground
	const carrotSlots = [
		[-0.4, ROW_Z[1]], [-0.02, ROW_Z[1]], [0.36, ROW_Z[1]],
		[-0.22, ROW_Z[2]], [0.18, ROW_Z[2]], [0.54, ROW_Z[2]],
	];
	const carrots = carrotSlots.map(([hx, hz], i) => {
		const group = new THREE.Group();
		garden.add(group);
		const sq = new THREE.Group();
		group.add(sq);
		const mover = new THREE.Group();
		mover.rotation.order = 'YXZ';
		sq.add(mover);
		kit.add(mover, new THREE.Mesh(carrotBodyGeo, carrotBodyMat)).position.y = -0.15;
		kit.add(mover, new THREE.Mesh(carrotLeavesGeo, carrotLeafMat)).position.y = 0.15;
		kit.add(mover, new THREE.Mesh(kit.sphereGeo(0.045), carrotBushMat)).position.y = 0.2;

		// where it lands: in front of the bed, on the actual ground there
		const lx = hx * 1.25 + (rand() - 0.5) * 0.1;
		const lz = BED_D / 2 + 0.28 + 0.12 * (i % 3);
		const w = garden.localToWorld(tmpV.set(lx, 0, lz));
		const ly = garden.worldToLocal(tmpV.set(w.x, heightAt(w.x, w.z), w.z)).y;
		const c = {
			group, sq, mover, hx, hz, lx, lz, ly,
			restYaw: rand() * TAU,
			landYaw: rand() * Math.PI,
			spin: (rand() < 0.5 ? -1 : 1) * TAU * (1 + (rand() < 0.5 ? 1 : 0)),
			pitch: POP_PITCH * (1 + (i - 2.5) * 0.03),
			state: 'idle',
			t: 0,
			y0: CARROT_REST,
			squash: new Spring(260, 10),
			hover: new Spring(200, 16),
			grow: new Spring(110, 9),
		};
		group.userData.onPoke = () => {
			if (c.state !== 'idle') return;
			c.y0 = CARROT_REST + HOVER_LIFT * c.hover.value;
			c.hover.snap(0);
			c.squash.snap(0);
			c.state = 'fly';
			c.t = 0;
			playPop({ pitch: c.pitch });
		};
		group.userData.onHover = (on) => {
			c.hover.target = on && c.state === 'idle' ? 1 : 0;
		};
		poseCarrot(c, hx, CARROT_REST, hz, RIDGE_TOP, c.restYaw, 0, 1);
		return c;
	});

	// sq sits on the ground point under the carrot so the squash and the regrow scale about it
	function poseCarrot(c, px, py, pz, gy, yaw, tilt, scale) {
		const q = c.squash.value;
		c.sq.position.set(px, gy, pz);
		c.sq.scale.set(scale * (1 + 0.5 * q), Math.max(0.001, scale * (1 - q)), scale * (1 + 0.5 * q));
		c.mover.position.y = py - gy;
		c.mover.rotation.set(0, yaw, tilt);
	}
	function restCarrot(c) {
		c.state = 'idle';
		c.hover.snap(0);
		c.squash.snap(0);
		poseCarrot(c, c.hx, CARROT_REST, c.hz, RIDGE_TOP, c.restYaw, 0, 1);
	}
	function updateCarrot(c, dt) {
		if (c.state === 'idle') {
			if (c.hover.settled) return;
			poseCarrot(c, c.hx, CARROT_REST + HOVER_LIFT * c.hover.update(dt), c.hz, RIDGE_TOP, c.restYaw, 0, 1);
			return;
		}
		c.t += dt;
		const yLie = c.ly + LIE_R;
		if (c.state === 'fly') {
			const s = Math.min(1, c.t / FLY_T);
			const y = lerp(c.y0, yLie, s) + FLY_PEAK * 4 * s * (1 - s);
			const yaw = c.restYaw + (c.landYaw - c.restYaw) * s + c.spin * (1 - (1 - s) * (1 - s));
			poseCarrot(c, lerp(c.hx, c.lx, s), y, lerp(c.hz, c.lz, s), c.ly, yaw, HALF_PI * smooth(0.05, 0.9, s), 1);
			if (s >= 1) {
				c.state = 'lie';
				c.t = 0;
				c.squash.snap(0);
				c.squash.kick(LAND_KICK);
			}
		} else if (c.state === 'lie') {
			c.squash.update(dt);
			poseCarrot(c, c.lx, yLie, c.lz, c.ly, c.landYaw, HALF_PI, 1);
			if (c.t >= LIE_T) {
				c.state = 'sink';
				c.t = 0;
			}
		} else if (c.state === 'sink') {
			const s = Math.min(1, c.t / SINK_T);
			c.squash.update(dt);
			poseCarrot(c, c.lx, yLie - 0.12 * s, c.lz, c.ly, c.landYaw, HALF_PI, 1 - s * s);
			if (s >= 1) {
				c.state = 'wait';
				c.t = 0;
			}
		} else if (c.state === 'wait') {
			poseCarrot(c, c.hx, CARROT_REST, c.hz, RIDGE_TOP, c.restYaw, 0, 0.001);
			if (c.t >= WAIT_T) {
				c.state = 'grow';
				c.squash.snap(0);
				c.grow.snap(0);
				c.grow.target = 1;
			}
		} else if (c.state === 'grow') {
			poseCarrot(c, c.hx, CARROT_REST, c.hz, RIDGE_TOP, c.restYaw, 0, Math.max(0.001, c.grow.update(dt)));
			if (c.grow.settled) restCarrot(c);
		}
	}

	// -------------------------------------------------------------------------
	// Cloud shadows
	// -------------------------------------------------------------------------
	function cloudTexture(seed) {
		const S = 128;
		const cv = document.createElement('canvas');
		cv.width = cv.height = S;
		const c = cv.getContext('2d');
		const r = mulberry32(seed);
		// lumpy: overlapping soft blobs
		for (let i = 0; i < 8; i++) {
			const a = r() * TAU;
			const d = r() * 0.26 * S;
			const x = S / 2 + Math.cos(a) * d * 1.2;
			const y = S / 2 + Math.sin(a) * d * 0.8;
			const rad = S * (0.14 + r() * 0.12);
			const g = c.createRadialGradient(x, y, 0, x, y, rad);
			g.addColorStop(0, 'rgba(255,255,255,1)');
			g.addColorStop(0.55, 'rgba(255,255,255,0.8)');
			g.addColorStop(1, 'rgba(255,255,255,0)');
			c.fillStyle = g;
			c.fillRect(0, 0, S, S);
		}
		// zero alpha at the border of the canvas
		c.globalCompositeOperation = 'destination-in';
		const m = c.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.5);
		m.addColorStop(0, 'rgba(0,0,0,1)');
		m.addColorStop(1, 'rgba(0,0,0,0)');
		c.fillStyle = m;
		c.fillRect(0, 0, S, S);
		const tex = new THREE.CanvasTexture(cv);
		tex.colorSpace = THREE.SRGBColorSpace;
		return tex;
	}

	const shadowGroup = new THREE.Group();
	root.add(shadowGroup);
	const shadows = SHADOWS.map((spec) => {
		const geo = new THREE.PlaneGeometry(1, 1, SHADOW_GRID, SHADOW_GRID);
		geo.rotateX(-HALF_PI); // faces up; x, z are the footprint
		const n = geo.attributes.position.count;
		const lx = new Float32Array(n);
		const lz = new Float32Array(n);
		const cr = Math.cos(spec.rot);
		const sr = Math.sin(spec.rot);
		for (let i = 0; i < n; i++) {
			const px = geo.attributes.position.getX(i) * spec.size;
			const pz = geo.attributes.position.getZ(i) * spec.depth;
			lx[i] = px * cr - pz * sr;
			lz[i] = px * sr + pz * cr;
		}
		const color = new Float32Array(n * 4).fill(1); // rgb 1, alpha is the edge fade
		geo.setAttribute('color', new THREE.BufferAttribute(color, 4));
		const material = new THREE.MeshBasicMaterial({
			color: SHADOW_COLOR,
			map: cloudTexture(spec.seed),
			vertexColors: true,
			transparent: true,
			opacity: SHADOW_OPACITY,
			depthWrite: false,
			polygonOffset: true,
			polygonOffsetFactor: -2,
			polygonOffsetUnits: -2,
		});
		const mesh = new THREE.Mesh(geo, material);
		mesh.frustumCulled = false;
		mesh.raycast = () => {}; // clicks and autofocus ignore shadows
		shadowGroup.add(mesh);
		return { mesh, geo, color, lx, lz, n, s: spec.s, l: spec.l, phase: spec.seed, cx: 0, cz: 0 };
	});
	let shadowAmount = 1;

	function updateShadow(sh, t, dt) {
		const dir = wind.dir;
		const gust = wind.at ? wind.at(sh.cx, sh.cz) : 0.22;
		sh.s += SHADOW_SPEED * (0.85 + 0.6 * gust) * dt;
		if (sh.s > SHADOW_RANGE) sh.s -= 2 * SHADOW_RANGE;
		const l = sh.l + 0.5 * Math.sin(t * 0.07 + sh.phase);
		sh.cx = dir.x * sh.s - dir.y * l;
		sh.cz = dir.y * sh.s + dir.x * l;
		// well off the island: nothing to draw
		const off = Math.abs(sh.s) > SHADOW_RANGE - 0.3;
		sh.mesh.visible = !off && shadowAmount > 0;
		if (off) return;

		const pos = sh.geo.attributes.position;
		const arr = pos.array;
		const col = sh.color;
		for (let i = 0; i < sh.n; i++) {
			const x = sh.cx + sh.lx[i];
			const z = sh.cz + sh.lz[i];
			const e = sE(x / H, z / H);
			const j = i * 3;
			if (e <= E0) {
				arr[j] = x;
				arr[j + 1] = groundAt(x, z) + SHADOW_LIFT;
				arr[j + 2] = z;
			} else if (e <= 1.02) {
				surf(x, z, SHADOW_LIFT, tmpV); // follows the rolled cushion edge
				arr[j] = tmpV.x;
				arr[j + 1] = tmpV.y;
				arr[j + 2] = tmpV.z;
			} else {
				arr[j] = x;
				arr[j + 1] = -1;
				arr[j + 2] = z;
			}
			col[i * 4 + 3] = 1 - smooth(SHADOW_FADE[0], SHADOW_FADE[1], e);
		}
		pos.needsUpdate = true;
		sh.geo.attributes.color.needsUpdate = true;
	}

	// -------------------------------------------------------------------------
	function update(t, dt = 1 / 60) {
		for (const c of carrots) updateCarrot(c, dt);
		for (const c of cabbages) updateCabbage(c, dt);
		for (const sh of shadows) updateShadow(sh, t, dt);
	}

	function reset() {
		for (const c of carrots) restCarrot(c);
		for (const c of cabbages) {
			c.rx.snap(0);
			c.rz.snap(0);
			c.sq.snap(0);
			c.wob.rotation.set(0, 0, 0);
			c.wob.scale.set(1, 1, 1);
		}
	}

	// 0..1 multiplier of the shadow opacity (the integrator hides them while the quilt is being knitted)
	function setShadows(k) {
		shadowAmount = k;
		for (const sh of shadows) sh.mesh.material.opacity = SHADOW_OPACITY * k;
		shadowGroup.visible = k > 0;
	}

	const items = [{ obj: garden, stage: 'garden', base: new THREE.Vector3(gcx, garden.position.y, gcz) }];
	return { update, items, reset, setShadows, shadows: shadowGroup, garden: { x: gcx, z: gcz } };
}
