// The yarn ball and its loose thread: unspooling, shrinking, rolling and the knitting needles.
//
// `state` (live position / radius / velocity) and `nudge(dx, dz, speed)` let sheep see and push the ball.
//
// The rope (rope.js) owns the thread physics. This module owns everything ball specific:
//   - rope particle 0 is pinned to a point on the ball surface facing the rope
//   - pulling: the rope reports how far the hand is beyond its reach (`pullExcess`).
//     That excess is spent two ways each frame:
//       1. unspool: while excess > FEED_THRESHOLD and the spool has budget (SPOOL_SPEED units/s),
//          a new particle is fed at the ball surface. A gentle pull is fully absorbed here.
//       2. drag: what the spool could not release (hard / fast pull, or an empty ball)
//          beyond a stickiness dead zone accelerates the ball toward the hand.
//   - the ball radius follows the released length by volume (exaggerated), the ball spins as
//     yarn comes off and rolls by traveled distance / radius
//   - below NEEDLE_POP_RADIUS the knitting needles pop out and fall to the ground
import * as THREE from 'three';
import { playPop } from './sound.js';

const MAX_DT = 0.05;
const R_MIN = 0.15; // radius when the ball is used up
const UNSPOOL_TOTAL = 17; // pulled yarn that takes the ball from full size to R_MIN
const SINK = 1 / 6; // fraction of the radius the ball sinks into the ground
const ANCHOR_DROP = 0.3; // radians below the equator where the thread leaves the ball
const ANCHOR_REF = 3; // rope particle that defines the thread direction
const ANCHOR_TURN = 12; // 1/s, how fast the leaving point follows the thread direction

const FEED_THRESHOLD = 0.0125; // excess that triggers a new particle
const SPOOL_SPEED = 5; // max units of yarn released per second
const SPOOL_BURST = 0.15; // spool budget cap (units)
const DRAG_DEAD = 0.14; // excess the ball ignores while it can still unspool
const DRAG_DEAD_EMPTY = 0.02; // same, once nothing more can unspool
const DRAG_ACCEL = 70; // ball acceleration per unit of excess
const DRAG_MAX_EXCESS = 1.5;
const ROLL_DAMP = 3; // 1/s viscous rolling resistance
const COULOMB = 0.25; // constant deceleration
const SLOPE_ACC = 2; // downhill acceleration per unit of slope
const SLOPE_MIN_SPEED = 0.05; // the ball must be moving before slopes move it
const MAX_SPEED = 6;
const SLOPE_STEP = 0.1;

const NEEDLE_POP_RADIUS = 0.35;
const NEEDLE_STAGGER = 0.12;
const NEEDLE_HALF = 0.95;
const NEEDLE_GRAVITY = 9.8;

const UP = new THREE.Vector3(0, 1, 0);

export function setupYarnBall({ root, ball, rope, groundAt, limit = 5.9 }) {
	const { group, radius: R0, needles: needleGroups, path } = ball;
	const homePos = group.position.clone();
	const homeQuat = group.quaternion.clone();

	// live collider so the thread wraps around the ball instead of through it
	const collider = { center: group.position, radius: R0 };
	rope.colliders.push(collider);

	const V0 = R0 * R0 * R0;
	const VMIN = R_MIN * R_MIN * R_MIN;
	const radiusFor = (len) => Math.cbrt(Math.max(VMIN, V0 - ((V0 - VMIN) / UNSPOOL_TOTAL) * len));

	let x = homePos.x;
	let z = homePos.z;
	let vx = 0;
	let vz = 0;
	let r = R0;
	let released = 0;
	let spoolBudget = 0;
	let clock = 0;
	let dirX = 1;
	let dirZ = 0;
	let needlesPopped = false;

	const anchor = new THREE.Vector3();
	const pull = new THREE.Vector3(1, 0, 0);
	const tmp = new THREE.Vector3();
	const tmpA = new THREE.Vector3();
	const tmpB = new THREE.Vector3();
	const spinQ = new THREE.Quaternion();
	const axis = new THREE.Vector3();

	const needles = needleGroups.map((obj) => ({
		obj,
		localPos: obj.position.clone(),
		localQuat: obj.quaternion.clone(),
		state: 'stuck', // stuck, wait, fly, settle, rest
		popAt: 0,
		bounces: 0,
		v: new THREE.Vector3(),
		w: new THREE.Vector3(),
	}));

	// ---- ball placement -------------------------------------------------------------------

	function placeBall() {
		const s = r / R0;
		group.scale.setScalar(s);
		const o = r * 0.67;
		const g = (groundAt(x, z) + groundAt(x + o, z) + groundAt(x - o, z) + groundAt(x, z + o) + groundAt(x, z - o)) / 5;
		group.position.set(x, g + r * (1 - SINK), z);
		collider.radius = r - rope.radius - 0.01;
		for (const n of needles) if (n.state === 'stuck') n.obj.scale.setScalar(1 / s);
	}

	// follow the thread direction (horizontal, ball center -> thread)
	function trackDir(dt) {
		rope.positionOf(Math.min(ANCHOR_REF, rope.count - 1), tmp);
		const dx = tmp.x - x;
		const dz = tmp.z - z;
		const l = Math.hypot(dx, dz);
		if (l < 1e-4) return;
		const k = dt > 0 ? 1 - Math.exp(-ANCHOR_TURN * dt) : 1;
		dirX += (dx / l - dirX) * k;
		dirZ += (dz / l - dirZ) * k;
		const n = Math.hypot(dirX, dirZ) || 1;
		dirX /= n;
		dirZ /= n;
	}

	function placeAnchor() {
		const c = group.position;
		anchor.set(
			c.x + dirX * r * Math.cos(ANCHOR_DROP),
			c.y - r * Math.sin(ANCHOR_DROP),
			c.z + dirZ * r * Math.cos(ANCHOR_DROP),
		);
		rope.setAnchor(anchor);
	}

	// rotate the ball by angle about the horizontal axis perpendicular to (dx, dz): rolls it toward (dx, dz)
	function spin(dx, dz, angle) {
		axis.set(dz, 0, -dx);
		if (axis.lengthSq() < 1e-12) return;
		axis.normalize();
		spinQ.setFromAxisAngle(axis, angle);
		group.quaternion.premultiply(spinQ).normalize();
	}

	// ---- needles --------------------------------------------------------------------------

	function popNeedles() {
		needlesPopped = true;
		needles.forEach((n, i) => {
			n.state = 'wait';
			n.popAt = clock + i * NEEDLE_STAGGER;
		});
	}

	function launch(n) {
		root.attach(n.obj);
		n.obj.scale.setScalar(1);
		tmpA.copy(UP).applyQuaternion(n.obj.quaternion);
		n.v.set(tmpA.x * 1.2 + (Math.random() - 0.5) * 0.6, 2.6 + Math.random() * 0.4, tmpA.z * 1.2 + (Math.random() - 0.5) * 0.6);
		n.w.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 8);
		n.bounces = 0;
		n.state = 'fly';
	}

	function updateNeedle(n, dt) {
		const o = n.obj;
		if (n.state === 'wait') {
			if (clock >= n.popAt) launch(n);
			return;
		}
		if (n.state === 'fly') {
			n.v.y -= NEEDLE_GRAVITY * dt;
			o.position.addScaledVector(n.v, dt);
			const wl = n.w.length();
			if (wl > 1e-6) {
				axis.copy(n.w).divideScalar(wl);
				spinQ.setFromAxisAngle(axis, wl * dt);
				o.quaternion.premultiply(spinQ).normalize();
			}
			tmpA.copy(UP).applyQuaternion(o.quaternion);
			const lowest = o.position.y - Math.abs(tmpA.y) * NEEDLE_HALF - 0.04;
			const gy = groundAt(o.position.x, o.position.z);
			if (lowest < gy && n.v.y < 0) {
				o.position.y += gy - lowest;
				const impact = -n.v.y;
				n.v.y = impact * 0.3;
				n.v.x *= 0.6;
				n.v.z *= 0.6;
				n.w.multiplyScalar(0.5);
				n.bounces++;
				if (n.bounces === 1 && impact > 0.8) playPop({ pitch: 0.8 + Math.random() * 0.5 });
				if (n.bounces >= 2) n.state = 'settle';
			}
			return;
		}
		if (n.state === 'settle') {
			tmpA.copy(UP).applyQuaternion(o.quaternion);
			tmpB.set(tmpA.x, 0, tmpA.z);
			if (tmpB.lengthSq() < 1e-4) tmpB.set(1, 0, 0);
			tmpB.normalize();
			spinQ.setFromUnitVectors(UP, tmpB);
			o.quaternion.slerp(spinQ, 1 - Math.exp(-10 * dt));
			tmpA.copy(UP).applyQuaternion(o.quaternion);
			o.position.x += n.v.x * dt;
			o.position.z += n.v.z * dt;
			n.v.x *= Math.exp(-6 * dt);
			n.v.z *= Math.exp(-6 * dt);
			o.position.y = groundAt(o.position.x, o.position.z) + 0.07 + Math.abs(tmpA.y) * NEEDLE_HALF;
			if (Math.abs(tmpA.y) < 0.02) n.state = 'rest';
		}
	}

	// ---- reset ----------------------------------------------------------------------------

	function reset() {
		x = homePos.x;
		z = homePos.z;
		vx = 0;
		vz = 0;
		r = R0;
		released = 0;
		spoolBudget = 0;
		needlesPopped = false;
		group.quaternion.copy(homeQuat);
		for (const n of needles) {
			group.add(n.obj);
			n.obj.position.copy(n.localPos);
			n.obj.quaternion.copy(n.localQuat);
			n.state = 'stuck';
		}
		placeBall();
		// thread direction from the initial path, then rebuild and settle the rope
		const ref = path[Math.min(8, path.length - 1)];
		dirX = ref.x - x;
		dirZ = ref.z - z;
		const l = Math.hypot(dirX, dirZ) || 1;
		dirX /= l;
		dirZ /= l;
		rope.releaseAll();
		placeAnchor();
		rope.setPath(path);
		rope.settle(3);
	}

	// ---- per frame ------------------------------------------------------------------------

	function update(t, dt) {
		dt = Math.min(dt, MAX_DT);
		clock += dt;
		if (dt <= 0) return;

		trackDir(dt);
		placeAnchor();

		// 1. unspool as much as the pull asks for and the spool allows
		let e = rope.pullExcess(pull);
		spoolBudget = Math.min(spoolBudget + SPOOL_SPEED * dt, SPOOL_BURST);
		const seg = rope.segment;
		let fed = 0;
		while (e > FEED_THRESHOLD && spoolBudget >= seg && released < UNSPOOL_TOTAL && rope.count < rope.maxPoints) {
			if (!rope.feed()) break;
			released += seg;
			spoolBudget -= seg;
			fed += seg;
			e -= rope.reachFactor * seg;
		}
		if (fed > 0) {
			r = radiusFor(released);
			// the ball spins as yarn comes off, same sense as rolling toward the hand
			spin(dirX, dirZ, fed / r);
		}

		// 2. the rest of the pull drags the ball toward the hand
		const empty = released >= UNSPOOL_TOTAL || rope.count >= rope.maxPoints;
		const dead = empty ? DRAG_DEAD_EMPTY : DRAG_DEAD;
		if (e > dead) {
			const a = DRAG_ACCEL * Math.min(e - dead, DRAG_MAX_EXCESS);
			vx += pull.x * a * dt;
			vz += pull.z * a * dt;
		}

		// 3. rolling: slopes only move a ball that already moves, friction stops it
		let speed = Math.hypot(vx, vz);
		if (speed > 0) {
			if (speed > SLOPE_MIN_SPEED) {
				const gx = (groundAt(x + SLOPE_STEP, z) - groundAt(x - SLOPE_STEP, z)) / (2 * SLOPE_STEP);
				const gz = (groundAt(x, z + SLOPE_STEP) - groundAt(x, z - SLOPE_STEP)) / (2 * SLOPE_STEP);
				vx -= gx * SLOPE_ACC * dt;
				vz -= gz * SLOPE_ACC * dt;
			}
			const damp = Math.exp(-ROLL_DAMP * dt);
			vx *= damp;
			vz *= damp;
			speed = Math.hypot(vx, vz);
			const dec = COULOMB * dt;
			if (speed <= dec) {
				vx = 0;
				vz = 0;
				speed = 0;
			} else {
				const k = Math.min(speed, MAX_SPEED) - dec;
				vx *= k / speed;
				vz *= k / speed;
				speed = k;
			}
		}
		if (speed > 0) {
			const nx = Math.min(limit, Math.max(-limit, x + vx * dt));
			const nz = Math.min(limit, Math.max(-limit, z + vz * dt));
			if (nx !== x + vx * dt) vx = 0;
			if (nz !== z + vz * dt) vz = 0;
			const dist = Math.hypot(nx - x, nz - z);
			if (dist > 1e-7) spin(nx - x, nz - z, dist / r);
			x = nx;
			z = nz;
		}
		placeBall();

		// 4. needles pop out once the ball is small enough
		if (!needlesPopped && r < NEEDLE_POP_RADIUS) popNeedles();
		if (needlesPopped) for (const n of needles) updateNeedle(n, dt);

		// 5. thread follows the ball
		placeAnchor();
		rope.update(dt);
	}

	// ---- interaction ----------------------------------------------------------------------

	let lastIndex = -1;
	const grabbable = {
		pick(ray, camera) {
			const hit = rope.pick(ray, camera);
			if (!hit) return null;
			lastIndex = hit.index;
			return { distance: hit.distance };
		},
		grab() {
			const g = rope.grab(lastIndex);
			if (!g) return { move() {}, release() {} };
			return {
				move: (target) => g.move(target),
				release: () => g.release(),
			};
		},
	};

	// live ball state for other modules (sheeplife.js): ground position, radius and rolling velocity
	const state = {
		get x() {
			return x;
		},
		get z() {
			return z;
		},
		get r() {
			return r;
		},
		get vx() {
			return vx;
		},
		get vz() {
			return vz;
		},
		get speed() {
			return Math.hypot(vx, vz);
		},
	};

	// give the ball a small push along (dx, dz), speed in units/s added to its rolling velocity
	function nudge(dx, dz, speed) {
		const l = Math.hypot(dx, dz);
		if (l < 1e-6) return;
		vx += (dx / l) * speed;
		vz += (dz / l) * speed;
		const v = Math.hypot(vx, vz);
		if (v > MAX_SPEED) {
			vx *= MAX_SPEED / v;
			vz *= MAX_SPEED / v;
		}
	}

	reset();
	return { update, grabbable, reset, state, nudge };
}
