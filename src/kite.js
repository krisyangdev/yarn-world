// Kite: a felt diamond kite on a yarn string, flown from a small wooden stake on the upwind side of the island.
//   1. stake      wooden post with a yarn spool; the string leaves the top of the spool
//   2. kite       four felt panels (coral / mustard checker), wooden cross spars, a two-leg bridle
//   3. string     thin yarn tube from the spool to the bridle knot: sags in the breeze, nearly straight in a gust
//   4. tail       chained points (6 felt bows on a strand) that trail downwind with a travelling wave
// Motion is driven by wind.at() sampled at the kite: the string elevation climbs from ~35-45 deg in the
// breeze to ~58 deg in a gust (spring inertia), the kite flies on the same wind direction as everything else,
// a gust band passing the kite kicks it into one lateral swoop (the side alternates per gust), and the
// kite leans / pitches with those motions. Poking the kite makes it do one loop-the-loop.
// The integrator calls setupKite({ root, wind, kit, terrain }) once, update(t, dt) every frame and reset()
// on R / replay. Everything lives in one group (`items`, one 'prop' popping in from the stake), so the kite
// grows out of the stake during the knit-in. Add `pokeTargets` to the poke target list.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BREEZE_MAX } from './wind.js';
import { Spring } from './spring.js';
import { playWhoosh } from './sound.js';
import { L, S } from './layout.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// --- feel knobs ------------------------------------------------------------
// stake (the nearest walkable spot to this point is used)
export const KITE_ANCHOR = L(-4.0, -0.3);
const STAKE_H = 0.5;
const SPOOL_X = 0.13; // spool sits beside the post, across the wind
const SPOOL_Y = 0.26;
const SPOOL_R = 0.05; // wound yarn radius
// string and flight
const STRING_LEN = 3.4;
const EL_BREEZE = [30 * DEG, 38 * DEG]; // string elevation at wind 0.25 .. 0.55
const EL_GUST = 12 * DEG; // added at the top of a gust
const GUST_FULL = 1.4; // wind strength where the gust response is complete
const SPINE_DEG = [52, 40]; // kite plane angle above horizontal: breeze, gust (flatter in a gust)
const SLACK = [0.035, 0.003]; // fraction of the string that is slack: breeze, gust
const SAG_MAX = 1.0;
const EL_SPRING = [12, 3.6]; // stiffness, damping (the climb follows a gust within ~0.3 s)
const PSI_SPRING = [9, 1.0]; // lateral swoop: underdamped, it overshoots and settles
const PSI_BIAS = -0.5; // rad: the kite rides off to the side of the wind window, so its face turns toward the default camera
const TAUT_FOLLOW = 6; // 1/s, how fast the string tension follows the wind
// drift and swoops
const FIG8 = [0.1, 0.05, 0.45]; // lateral amplitude (rad), elevation amplitude (rad), rad/s; elevation runs at twice the rate
const GUST_ON = BREEZE_MAX + 0.25; // wind at the kite above this counts as a gust passing
const GUST_OFF = BREEZE_MAX + 0.1;
const GUST_KICK = 0.9; // swoop velocity kick (rad/s)
// attitude
const LEAN_GAIN = 0.5; // rad of lean per rad/s of lateral swoop velocity
const TWIST_GAIN = 0.25;
const PITCH_GAIN = 0.6; // rad of nose pitch per rad/s of elevation velocity
// loop on poke
const LOOP_TIME = 1.2;
const LOOP_R = 0.5;
// tail
const TAIL_N = 6;
const TAIL_SEG = 0.2;
const TAIL_GRAVITY = 3.5;
const TAIL_PUSH = 7; // acceleration along the wind per unit of wind strength
const TAIL_DAMP = 2.2; // 1/s
const TAIL_WAVE_A = [1.5, 5]; // sideways acceleration: base, per unit of wind strength
const TAIL_WAVE_SPEED = [3.5, 6]; // rad/s of the travelling wave: base, per unit of wind strength
const TAIL_WAVE_K = 0.9; // rad of wave phase per tail point
const TAIL_ANCHOR_Y = -0.29; // below the kite's bottom tip

const sstep = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const noRaycast = () => {};

// Tube with an in-place mesh: `pos` (xyz per point) is written by the owner, update() rebuilds the rings.
// uv: u = arc length / (2 * twist) like rope.js, v around.
function makeTube(pos, sides, radius, material, twist) {
	const n = pos.length / 3;
	const R1 = sides + 1;
	const posA = new THREE.BufferAttribute(new Float32Array(n * R1 * 3), 3).setUsage(THREE.DynamicDrawUsage);
	const norA = new THREE.BufferAttribute(new Float32Array(n * R1 * 3), 3).setUsage(THREE.DynamicDrawUsage);
	const uvA = new THREE.BufferAttribute(new Float32Array(n * R1 * 2), 2).setUsage(THREE.DynamicDrawUsage);
	const index = new Uint16Array((n - 1) * sides * 6);
	let w = 0;
	for (let r = 0; r < n - 1; r++) {
		for (let j = 0; j < sides; j++) {
			const a = r * R1 + j;
			const c = a + R1;
			index[w++] = a;
			index[w++] = a + 1;
			index[w++] = c;
			index[w++] = a + 1;
			index[w++] = c + 1;
			index[w++] = c;
		}
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', posA);
	geo.setAttribute('normal', norA);
	geo.setAttribute('uv', uvA);
	geo.setIndex(new THREE.BufferAttribute(index, 1));
	const mesh = new THREE.Mesh(geo, material);
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.raycast = noRaycast;
	const cs = new Float32Array(R1);
	const sn = new Float32Array(R1);
	for (let j = 0; j < R1; j++) {
		cs[j] = Math.cos((j / sides) * TAU);
		sn[j] = Math.sin((j / sides) * TAU);
	}
	const invTile = 1 / (2 * twist);

	function update() {
		const p = posA.array;
		const q = norA.array;
		const uv = uvA.array;
		let tx = 0;
		let ty = 0;
		let tz = 1;
		let nx = 0;
		let ny = 1;
		let nz = 0;
		let u = 0;
		for (let i = 0; i < n; i++) {
			const k = i * 3;
			const a = Math.max(0, i - 1) * 3;
			const e = Math.min(n - 1, i + 1) * 3;
			const dx = pos[e] - pos[a];
			const dy = pos[e + 1] - pos[a + 1];
			const dz = pos[e + 2] - pos[a + 2];
			const l = Math.hypot(dx, dy, dz);
			if (l > 1e-7) {
				tx = dx / l;
				ty = dy / l;
				tz = dz / l;
			}
			let rx;
			let ry;
			let rz;
			if (i === 0) {
				rx = Math.abs(ty) < 0.9 ? 0 : 1;
				ry = Math.abs(ty) < 0.9 ? 1 : 0;
				rz = 0;
			} else {
				rx = nx;
				ry = ny;
				rz = nz;
				u += Math.hypot(pos[k] - pos[k - 3], pos[k + 1] - pos[k - 2], pos[k + 2] - pos[k - 1]);
			}
			const d = rx * tx + ry * ty + rz * tz;
			nx = rx - tx * d;
			ny = ry - ty * d;
			nz = rz - tz * d;
			let nl = Math.hypot(nx, ny, nz);
			if (nl < 1e-5) {
				nx = ty;
				ny = -tx;
				nz = 0;
				nl = Math.hypot(nx, ny, nz) || 1;
			}
			nx /= nl;
			ny /= nl;
			nz /= nl;
			const bx = ty * nz - tz * ny;
			const by = tz * nx - tx * nz;
			const bz = tx * ny - ty * nx;
			let vp = i * R1 * 3;
			let vu = i * R1 * 2;
			for (let j = 0; j < R1; j++) {
				const ox = nx * cs[j] + bx * sn[j];
				const oy = ny * cs[j] + by * sn[j];
				const oz = nz * cs[j] + bz * sn[j];
				p[vp] = pos[k] + ox * radius;
				p[vp + 1] = pos[k + 1] + oy * radius;
				p[vp + 2] = pos[k + 2] + oz * radius;
				q[vp] = ox;
				q[vp + 1] = oy;
				q[vp + 2] = oz;
				vp += 3;
				uv[vu] = u * invTile;
				uv[vu + 1] = j / sides;
				vu += 2;
			}
		}
		posA.needsUpdate = true;
		norA.needsUpdate = true;
		uvA.needsUpdate = true;
	}

	return { mesh, update };
}

// straight thin tube between two points (static)
function rod(a, b, r) {
	return new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, r, 5, false);
}

export function setupKite({ root, wind, kit, terrain }) {
	const { P } = kit;
	const H = terrain.H;
	const dirX = wind.dir.x;
	const dirZ = wind.dir.y;
	const group = new THREE.Group();
	root.add(group);

	// ---------------------------------------------------------------------
	// 1. Stake and spool
	// ---------------------------------------------------------------------
	const stakeAt = (() => {
		const ok = (x, z) => terrain.walkable(x, z) && terrain.sE(x / H, z / H) < 0.8;
		const [ax, az] = KITE_ANCHOR;
		if (ok(ax, az)) return [ax, az];
		for (let r = 0.2; r <= S(4); r += 0.2) {
			const steps = Math.ceil((r * TAU) / 0.2);
			for (let k = 0; k < steps; k++) {
				const a = (k / steps) * TAU;
				const x = ax + Math.cos(a) * r;
				const z = az + Math.sin(a) * r;
				if (ok(x, z)) return [x, z];
			}
		}
		return [ax, az];
	})();
	const baseY = terrain.heightAt(stakeAt[0], stakeAt[1]);

	const stake = new THREE.Group();
	stake.position.set(stakeAt[0], baseY, stakeAt[1]);
	stake.rotation.y = Math.atan2(dirX, dirZ); // local +z is the wind direction, +x across it
	group.add(stake);

	const woodMat = kit.mat(P.wood, 'stockinette', [3, 8]);
	const postGeo = kit.cachedGeo('kitePost', () => new THREE.CylinderGeometry(0.026, 0.034, STAKE_H, 8));
	kit.add(stake, new THREE.Mesh(postGeo, woodMat)).position.y = STAKE_H / 2 - 0.03;
	kit.sphere(stake, 0.04, kit.mat(P.cream, 'boucle', kit.sphereRep(0.04)), 0, STAKE_H - 0.02, 0);
	const pegGeo = kit.cachedGeo('kitePeg', () => new THREE.CylinderGeometry(0.012, 0.012, SPOOL_X + 0.03, 6).rotateZ(Math.PI / 2));
	kit.add(stake, new THREE.Mesh(pegGeo, woodMat)).position.set((SPOOL_X + 0.03) / 2 - 0.015, SPOOL_Y, 0);
	const coreGeo = kit.cachedGeo('kiteSpoolCore', () => new THREE.CylinderGeometry(SPOOL_R, SPOOL_R, 0.09, 16).rotateZ(Math.PI / 2));
	kit.add(stake, new THREE.Mesh(coreGeo, kit.mat(P.cream, 'stockinette', [10, 3]))).position.set(SPOOL_X, SPOOL_Y, 0);
	const flangeGeo = kit.cachedGeo('kiteSpoolFlange', () => new THREE.CylinderGeometry(0.085, 0.085, 0.014, 16).rotateZ(Math.PI / 2));
	for (const s of [-1, 1]) {
		kit.add(stake, new THREE.Mesh(flangeGeo, woodMat)).position.set(SPOOL_X + s * 0.052, SPOOL_Y, 0);
	}
	// string start: top of the wound yarn
	const sx = stakeAt[0] + dirZ * SPOOL_X;
	const sz = stakeAt[1] - dirX * SPOOL_X;
	const sy = baseY + SPOOL_Y + SPOOL_R;

	// ---------------------------------------------------------------------
	// 2. Kite
	// ---------------------------------------------------------------------
	const kite = new THREE.Group();
	group.add(kite);
	const TOP = 0.275;
	const SIDE_X = 0.2;
	const CROSS_Y = 0.06;
	const tri = (a, b, c) => {
		const shape = new THREE.Shape();
		shape.moveTo(a[0], a[1]);
		shape.lineTo(b[0], b[1]);
		shape.lineTo(c[0], c[1]);
		shape.closePath();
		const g = new THREE.ExtrudeGeometry(shape, {
			depth: 0.012,
			bevelEnabled: true,
			bevelThickness: 0.007,
			bevelSize: 0.007,
			bevelSegments: 2,
			curveSegments: 1,
		});
		g.translate(0, 0, -0.006);
		return g;
	};
	const C = [0, CROSS_Y];
	const quad = {
		tl: tri([0, TOP], [-SIDE_X, CROSS_Y], C),
		tr: tri([0, TOP], [SIDE_X, CROSS_Y], C),
		bl: tri([-SIDE_X, CROSS_Y], [0, -TOP], C),
		br: tri([SIDE_X, CROSS_Y], [0, -TOP], C),
	};
	const panels = [];
	[
		[P.coral, [quad.tl, quad.br]],
		[P.mustard, [quad.tr, quad.bl]],
	].forEach(([color, parts]) => {
		const g = mergeGeometries(parts);
		parts.forEach((p) => p.dispose());
		panels.push(kit.add(kite, new THREE.Mesh(g, kit.mat(color, 'stockinette', [14, 14]))));
	});
	const sparGeo = (() => {
		const v = new THREE.CylinderGeometry(0.009, 0.009, TOP * 2 + 0.03, 6).translate(0, 0, 0.02);
		const h = new THREE.CylinderGeometry(0.009, 0.009, SIDE_X * 2 + 0.03, 6).rotateZ(Math.PI / 2).translate(0, CROSS_Y, 0.02);
		const g = mergeGeometries([v, h]);
		v.dispose();
		h.dispose();
		return g;
	})();
	const spars = kit.add(kite, new THREE.Mesh(sparGeo, woodMat));
	// bridle: two legs from the spine to a tow knot in front of the face
	const BRIDLE = new THREE.Vector3(0, 0.03, 0.17);
	const legs = [rod(new THREE.Vector3(0, 0.19, 0.02), BRIDLE, 0.005), rod(new THREE.Vector3(0, -0.18, 0.02), BRIDLE, 0.005)];
	const legGeo = mergeGeometries(legs);
	legs.forEach((l) => l.dispose());
	const strandMat = kit.mat(P.cream, 'strand', [1, 1]);
	const bridleMesh = kit.add(kite, new THREE.Mesh(legGeo, strandMat));
	bridleMesh.raycast = noRaycast;
	kit.sphere(kite, 0.016, kit.mat(P.cream, 'boucle', kit.sphereRep(0.016)), BRIDLE.x, BRIDLE.y, BRIDLE.z).raycast = noRaycast;

	// ---------------------------------------------------------------------
	// 3. String
	// ---------------------------------------------------------------------
	const STRING_PTS = 14;
	const stringPos = new Float32Array(STRING_PTS * 3);
	const stringTube = makeTube(stringPos, 6, 0.011, strandMat, 0.12);
	group.add(stringTube.mesh);

	// ---------------------------------------------------------------------
	// 4. Tail
	// ---------------------------------------------------------------------
	const tailG = new THREE.Group();
	group.add(tailG);
	const tailPos = new Float32Array((TAIL_N + 1) * 3);
	const tailPrev = new Float32Array((TAIL_N + 1) * 3);
	const tailTube = makeTube(tailPos, 5, 0.009, strandMat, 0.12);
	tailG.add(tailTube.mesh);
	const bowGeo = kit.cachedGeo('kiteBow', () => {
		const h = 0.1;
		const left = new THREE.ConeGeometry(0.05, h, 8).rotateZ(-Math.PI / 2).translate(-h / 2, 0, 0);
		const right = new THREE.ConeGeometry(0.05, h, 8).rotateZ(Math.PI / 2).translate(h / 2, 0, 0);
		const knot = new THREE.SphereGeometry(0.02, 10, 8);
		const g = mergeGeometries([left, right, knot]);
		[left, right, knot].forEach((p) => p.dispose());
		g.scale(1, 1, 0.45);
		return g;
	});
	const bowColors = [P.coral, P.mustard, P.sky, P.lavender, P.pink, P.mustard];
	const bows = bowColors.slice(0, TAIL_N).map((color, i) => {
		const mesh = kit.add(tailG, new THREE.Mesh(bowGeo, kit.mat(color, 'stockinette', [8, 8])));
		mesh.scale.setScalar(1 - i * 0.04);
		return mesh;
	});

	// ---------------------------------------------------------------------
	// state
	// ---------------------------------------------------------------------
	const elSpring = new Spring(EL_SPRING[0], EL_SPRING[1], EL_BREEZE[0]);
	const psiSpring = new Spring(PSI_SPRING[0], PSI_SPRING[1], 0);
	let taut = 0;
	let swoopSign = 1;
	let gustLatch = false;
	let loopT = -1;
	let waveT = 0;
	let lastT = 0;

	const _qBase = new THREE.Quaternion();
	const _qLocal = new THREE.Quaternion();
	const _qLoop = new THREE.Quaternion();
	const _eul = new THREE.Euler();
	const _m = new THREE.Matrix4();
	const _l = new THREE.Vector3();
	const _u = new THREE.Vector3();
	const _n = new THREE.Vector3();
	const _e = new THREE.Vector3();
	const _t = new THREE.Vector3();
	const Y = new THREE.Vector3(0, 1, 0);
	const tailAnchor = new THREE.Vector3(0, TAIL_ANCHOR_Y, 0);

	// elevation target for the wind strength w (no figure-eight)
	const elevationFor = (w) =>
		EL_BREEZE[0] + (EL_BREEZE[1] - EL_BREEZE[0]) * clamp((w - 0.25) / 0.3, 0, 1) + EL_GUST * sstep(BREEZE_MAX, GUST_FULL, w);
	const tautFor = (w) => clamp(0.3 * clamp((w - 0.25) / 0.3, 0, 1) + sstep(BREEZE_MAX, GUST_FULL, w), 0, 1);

	function stepTail(h, w, ax, ay, az, dhx, dhz) {
		if (h <= 0) return;
		const damp = Math.exp(-TAIL_DAMP * h);
		const push = TAIL_PUSH * w;
		const waveA = TAIL_WAVE_A[0] + TAIL_WAVE_A[1] * w;
		const latX = -dhz;
		const latZ = dhx;
		const hh = h * h;
		for (let i = 1; i <= TAIL_N; i++) {
			const k = i * 3;
			const wave = Math.sin(waveT - i * TAIL_WAVE_K) * waveA * (i / TAIL_N);
			const x = tailPos[k];
			const y = tailPos[k + 1];
			const z = tailPos[k + 2];
			tailPos[k] = x + (x - tailPrev[k]) * damp + (dhx * push + latX * wave) * hh;
			tailPos[k + 1] = y + (y - tailPrev[k + 1]) * damp - TAIL_GRAVITY * hh;
			tailPos[k + 2] = z + (z - tailPrev[k + 2]) * damp + (dhz * push + latZ * wave) * hh;
			tailPrev[k] = x;
			tailPrev[k + 1] = y;
			tailPrev[k + 2] = z;
		}
		tailPos[0] = tailPrev[0] = ax;
		tailPos[1] = tailPrev[1] = ay;
		tailPos[2] = tailPrev[2] = az;
		for (let it = 0; it < 3; it++) {
			for (let i = 1; i <= TAIL_N; i++) {
				const k = i * 3;
				const dx = tailPos[k] - tailPos[k - 3];
				const dy = tailPos[k + 1] - tailPos[k - 2];
				const dz = tailPos[k + 2] - tailPos[k - 1];
				const l = Math.hypot(dx, dy, dz) || 1e-6;
				const f = (l - TAIL_SEG) / l;
				const free = i > 1 ? 0.5 : 0; // point 0 stays on the kite
				tailPos[k] -= dx * f * (1 - free);
				tailPos[k + 1] -= dy * f * (1 - free);
				tailPos[k + 2] -= dz * f * (1 - free);
				if (i > 1) {
					tailPos[k - 3] += dx * f * free;
					tailPos[k - 2] += dy * f * free;
					tailPos[k - 1] += dz * f * free;
				}
			}
		}
	}

	function frame(t, dt) {
		const px0 = kite.position.x;
		const pz0 = kite.position.z;
		const w = wind.at(px0, pz0);

		// gust passing the kite: one swoop, side alternates per gust
		if (w > GUST_ON && !gustLatch) {
			gustLatch = true;
			swoopSign = -swoopSign;
			psiSpring.kick(swoopSign * GUST_KICK * clamp((w - BREEZE_MAX) / 0.6, 0.6, 1.4));
		} else if (w < GUST_OFF) {
			gustLatch = false;
		}

		// string elevation and lateral swing follow the wind with spring inertia
		elSpring.target = elevationFor(w) + FIG8[1] * Math.sin(t * FIG8[2] * 2 + 0.6);
		psiSpring.target = PSI_BIAS + FIG8[0] * Math.sin(t * FIG8[2]);
		const el = elSpring.update(dt);
		const psi = psiSpring.update(dt);
		const psiVel = psiSpring.velocity;
		const elVel = elSpring.velocity;
		taut += (tautFor(w) - taut) * Math.min(1, dt * TAUT_FOLLOW);
		const g = sstep(BREEZE_MAX, GUST_FULL, w);

		// position: along the wind direction turned by psi, raised by the elevation
		const chord = STRING_LEN * (1 - (SLACK[0] + (SLACK[1] - SLACK[0]) * taut));
		const cp = Math.cos(psi);
		const sp = Math.sin(psi);
		const dhx = dirX * cp - dirZ * sp;
		const dhz = dirX * sp + dirZ * cp;
		const reach = chord * Math.cos(el);
		let px = sx + dhx * reach;
		let py = sy + chord * Math.sin(el);
		let pz = sz + dhz * reach;

		// loop-the-loop: a vertical circle in the wind plane, the body rolls 360 deg about the lateral axis
		let loopA = 0;
		if (loopT >= 0) {
			loopT += dt;
			const s = Math.min(1, loopT / LOOP_TIME);
			loopA = TAU * s * s * (3 - 2 * s);
			if (s >= 1) loopT = -1;
			const fwd = LOOP_R * Math.sin(loopA);
			px += dhx * fwd;
			pz += dhz * fwd;
			py += LOOP_R * (1 - Math.cos(loopA));
		}
		py = Math.max(py, terrain.groundAt(px, pz) + 0.5);

		// attitude: plane basis (lateral, spine, face), then nose pitch / twist / lean from the swoops
		const spine = (SPINE_DEG[0] + (SPINE_DEG[1] - SPINE_DEG[0]) * g) * DEG;
		const cs = Math.cos(spine);
		const ss = Math.sin(spine);
		_l.set(-dhz, 0, dhx);
		_u.set(cs * dhx, ss, cs * dhz);
		_n.set(-ss * dhx, cs, -ss * dhz);
		_m.makeBasis(_l, _u, _n);
		_qBase.setFromRotationMatrix(_m);
		const pitchX = -PITCH_GAIN * elVel + 0.06 * Math.sin(t * 1.7) * (0.5 + w);
		const twistY = TWIST_GAIN * psiVel + 0.03 * w * Math.sin(t * (5 + 4 * w));
		const leanZ = -LEAN_GAIN * psiVel;
		_qLocal.setFromEuler(_eul.set(pitchX, twistY, leanZ, 'XYZ'));
		kite.quaternion.copy(_qBase).multiply(_qLocal);
		if (loopA > 0) {
			_qLoop.setFromAxisAngle(_l, loopA);
			kite.quaternion.premultiply(_qLoop);
		}
		kite.position.set(px, py, pz);
		kite.updateMatrix();

		// bridle knot, kept within the string length
		_e.copy(BRIDLE).applyMatrix4(kite.matrix);
		const ex = _e.x - sx;
		const ey = _e.y - sy;
		const ez = _e.z - sz;
		const el2 = Math.hypot(ex, ey, ez);
		if (el2 > STRING_LEN) {
			const k = STRING_LEN / el2 - 1;
			kite.position.x += ex * k;
			kite.position.y += ey * k;
			kite.position.z += ez * k;
			kite.updateMatrix();
			_e.set(sx + ex * (1 + k), sy + ey * (1 + k), sz + ez * (1 + k));
		}

		// string: parabola sagging by the slack, bowed back against the swoop
		const dist = Math.min(el2, STRING_LEN);
		const sag = Math.min(SAG_MAX, Math.sqrt((3 * dist * Math.max(0, STRING_LEN - dist)) / 8));
		const lag = -psiVel * 0.2;
		for (let i = 0; i < STRING_PTS; i++) {
			const s = i / (STRING_PTS - 1);
			const bell = 4 * s * (1 - s);
			const x = sx + (_e.x - sx) * s + _l.x * lag * bell;
			const z = sz + (_e.z - sz) * s + _l.z * lag * bell;
			const y = sy + (_e.y - sy) * s - sag * bell;
			stringPos[i * 3] = x;
			stringPos[i * 3 + 1] = Math.max(y, terrain.groundAt(x, z) + 0.03);
			stringPos[i * 3 + 2] = z;
		}
		stringTube.update();

		// tail: chained points hanging from the kite's bottom tip
		_t.copy(tailAnchor).applyMatrix4(kite.matrix);
		waveT += dt * (TAIL_WAVE_SPEED[0] + TAIL_WAVE_SPEED[1] * w);
		stepTail(dt / 2, w, _t.x, _t.y, _t.z, dhx, dhz);
		stepTail(dt / 2, w, _t.x, _t.y, _t.z, dhx, dhz);
		tailPos[0] = _t.x;
		tailPos[1] = _t.y;
		tailPos[2] = _t.z;
		tailTube.update();
		for (let i = 0; i < TAIL_N; i++) {
			const k = (i + 1) * 3;
			const a = i * 3;
			const e = Math.min(TAIL_N, i + 2) * 3;
			_t.set(tailPos[e] - tailPos[a], tailPos[e + 1] - tailPos[a + 1], tailPos[e + 2] - tailPos[a + 2]).normalize();
			const bow = bows[i];
			bow.position.set(tailPos[k], tailPos[k + 1], tailPos[k + 2]);
			bow.quaternion.setFromUnitVectors(Y, _t);
			_qLocal.setFromAxisAngle(Y, i * 1.3 + 0.4 * Math.sin(t * 1.4 + i));
			bow.quaternion.multiply(_qLocal);
		}
	}

	// ---------------------------------------------------------------------
	// poke: one loop-the-loop
	// ---------------------------------------------------------------------
	const onPoke = () => {
		if (loopT >= 0) return;
		loopT = 0;
		playWhoosh();
	};
	kite.userData.onPoke = onPoke;
	tailG.userData.onPoke = onPoke;

	function update(t, dt) {
		lastT = t;
		frame(t, Math.min(dt, 0.05));
	}

	function reset() {
		const w = wind.at(kite.position.x, kite.position.z);
		elSpring.snap(elevationFor(w));
		psiSpring.snap(PSI_BIAS);
		taut = tautFor(w);
		gustLatch = w > GUST_OFF;
		loopT = -1;
		// tail hangs below the kite, leaning a little downwind
		kite.position.set(sx + dirX * 3.5, sy + 3, sz + dirZ * 3.5);
		kite.updateMatrix();
		_t.copy(tailAnchor).applyMatrix4(kite.matrix);
		for (let i = 0; i <= TAIL_N; i++) {
			const k = i * 3;
			tailPos[k] = tailPrev[k] = _t.x + dirX * 0.3 * i * TAIL_SEG;
			tailPos[k + 1] = tailPrev[k + 1] = _t.y - 0.95 * i * TAIL_SEG;
			tailPos[k + 2] = tailPrev[k + 2] = _t.z + dirZ * 0.3 * i * TAIL_SEG;
		}
		frame(lastT, 0);
	}
	reset();

	return {
		update,
		reset,
		items: [{ obj: group, stage: 'prop', base: new THREE.Vector3(stakeAt[0], baseY, stakeAt[1]) }],
		pokeTargets: [...panels, spars, ...bows],
	};
}
