// Shared sheep locomotion: slope-following placement, hop gait and a target-following trot.
// Used by unravel.js (trot away) and sheeplife.js (chase the ball, walk to fruit, hop back to safe ground).
//
// A Walker owns the sheep's ground position (x, z) and a Gait (hop / pitch / roll / squash offsets for the
// body). The caller poses the body from the gait; the walker only moves and turns `s.g`.
const TAU = Math.PI * 2;

export const WALK_SPEED = 1.6;
const TURN = 9; // 1/s, turn toward the travel direction
const EASE_IN = 0.35;
const EASE_OUT = 0.7;
const HOP_HZ = 3.2; // hops per second
const HOP_H = 0.09;
const GAIT_PITCH = 0.1;
const GAIT_ROLL = 0.07;
const GAIT_SQUASH = 0.08;
const SLOPE_FOLLOW = 12; // 1/s, pitch / roll follow the ground slope
const ARRIVE_EPS = 0.02;
const STEER = [0.6, -0.6, 1.2, -1.2]; // radians tried when the next step is not walkable
const AVOID_R = 0.85; // walking sheep keep this far from other sheep
const AVOID_PUSH = 1.2; // units/s at zero distance

export const PATH_STEP = 0.2;
export const SHEEP_GAP = 0.8; // keep destinations this far from other sheep

// walk() results
export const WALKING = 0;
export const ARRIVED = 1;
export const BLOCKED = 2;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const wrapPi = (a) => a - TAU * Math.round(a / TAU);
export const sstep = (a, b, x) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};

// height of the sheep's origin when it stands at (x, z) facing yaw: mean of four ground samples
export function standHeight(x, z, yaw, groundAt) {
	const fx = Math.sin(yaw);
	const fz = Math.cos(yaw);
	return (
		(groundAt(x + fx * 0.25, z + fz * 0.25) +
			groundAt(x - fx * 0.25, z - fz * 0.25) +
			groundAt(x + fz * 0.2, z - fx * 0.2) +
			groundAt(x - fz * 0.2, z + fx * 0.2)) /
			4 -
		0.02
	);
}

// put the sheep at (x, z) facing s.yaw, standing on the slope like makeSheep does; lift raises it above the ground
export function placeSheep(s, x, z, groundAt, dt, lift = 0) {
	const fx = Math.sin(s.yaw);
	const fz = Math.cos(s.yaw);
	const hF = groundAt(x + fx * 0.25, z + fz * 0.25);
	const hB = groundAt(x - fx * 0.25, z - fz * 0.25);
	const hR = groundAt(x + fz * 0.2, z - fx * 0.2);
	const hL = groundAt(x - fz * 0.2, z + fx * 0.2);
	const k = dt > 0 ? 1 - Math.exp(-SLOPE_FOLLOW * dt) : 1;
	s.pitch += (-Math.atan2(hF - hB, 0.5) - s.pitch) * k;
	s.roll += (Math.atan2(hR - hL, 0.4) - s.roll) * k;
	s.g.position.set(x, (hF + hB + hR + hL) / 4 - 0.02 + lift, z);
	s.g.rotation.set(s.pitch, s.yaw, s.roll);
}

// true when a straight line of `dist` from (x0, z0) along (dx, dz) stays on walkable ground and clear of other sheep
export function clearPath(x0, z0, dx, dz, dist, walkable, sheep, self) {
	for (let d = PATH_STEP; d < dist + PATH_STEP; d += PATH_STEP) {
		const x = x0 + dx * Math.min(d, dist);
		const z = z0 + dz * Math.min(d, dist);
		if (!walkable(x, z)) return false;
		if (sheep) {
			for (const o of sheep) {
				if (o === self) continue;
				const p = o.g.position;
				if (Math.hypot(x - p.x, z - p.z) < SHEEP_GAP) return false;
			}
		}
	}
	return true;
}

// Body offsets of the hopping trot
export class Gait {
	constructor() {
		this.reset();
	}

	reset() {
		this.phase = 0;
		this.hopY = 0;
		this.pitch = 0;
		this.roll = 0;
		this.sq = 1;
	}

	// amp 0..1: how fast the sheep moves
	step(amp, dt) {
		this.phase += Math.PI * HOP_HZ * dt;
		const ph = this.phase % Math.PI;
		const arc = Math.sin(ph);
		this.hopY = HOP_H * amp * arc;
		this.pitch = -GAIT_PITCH * amp * Math.cos(ph);
		this.roll = GAIT_ROLL * amp * Math.sin(this.phase * 0.5);
		this.sq = 1 - GAIT_SQUASH * amp * Math.pow(1 - arc, 8);
	}

	// relax toward standing still
	decay(dt) {
		const k = Math.exp(-10 * dt);
		this.hopY *= k;
		this.pitch *= k;
		this.roll *= k;
		this.sq += (1 - this.sq) * (1 - k);
	}
}

export class Walker {
	// sheep: the other sheep to keep apart from while walking (optional)
	constructor(s, { groundAt, walkable, sheep = null }) {
		this.s = s;
		this.groundAt = groundAt;
		this.walkable = walkable;
		this.sheep = sheep;
		this.gait = new Gait();
		this.x = s.g.position.x;
		this.z = s.g.position.z;
		this.t = 0; // time since begin(), drives the ease-in
		this.speed = 0;
		this.headBob = 0; // head pitch target while trotting
	}

	setPos(x, z) {
		this.x = x;
		this.z = z;
	}

	// start a new trip: speed eases in again
	begin() {
		this.t = 0;
	}

	place(dt, lift = 0) {
		placeSheep(this.s, this.x, this.z, this.groundAt, dt, lift);
	}

	// turn toward (dx, dz); returns the remaining angle
	turnTo(dx, dz, dt, rate = TURN) {
		const s = this.s;
		const diff = wrapPi(Math.atan2(dx, dz) - s.yaw);
		s.yaw += diff * (1 - Math.exp(-rate * dt));
		return diff;
	}

	// Trot toward (tx, tz) and stop `stop` units short of it. `free` ignores walkability (hop back to safe
	// ground). Poses the sheep on the ground; returns WALKING, ARRIVED or BLOCKED.
	walk(tx, tz, stop, dt, free = false, speedMul = 1) {
		const s = this.s;
		this.t += dt;
		const dx = tx - this.x;
		const dz = tz - this.z;
		const dist = Math.hypot(dx, dz);
		const remaining = dist - stop;
		if (remaining < ARRIVE_EPS || dist < 1e-6) {
			this.stand(dt);
			return ARRIVED;
		}
		const ux = dx / dist;
		const uz = dz / dist;
		const diff = this.turnTo(ux, uz, dt);
		const face = Math.max(0, Math.cos(diff));
		const speed = WALK_SPEED * speedMul * Math.min(1, this.t / EASE_IN) * clamp(remaining / EASE_OUT, 0.2, 1) * face * face;
		const step = Math.min(speed * dt, remaining);

		let mx = ux;
		let mz = uz;
		let nx = this.x + mx * step;
		let nz = this.z + mz * step;
		if (!free && step > 0 && !this.walkable(nx, nz)) {
			let ok = false;
			for (const a of STEER) {
				const c = Math.cos(a);
				const sn = Math.sin(a);
				mx = ux * c - uz * sn;
				mz = ux * sn + uz * c;
				nx = this.x + mx * step;
				nz = this.z + mz * step;
				if (this.walkable(nx, nz)) {
					ok = true;
					break;
				}
			}
			if (!ok) {
				this.stand(dt);
				return BLOCKED;
			}
		}
		this.x = nx;
		this.z = nz;
		if (this.sheep && step > 0) this.separate(dt);
		this.speed = speed;
		const amp = clamp(speed / WALK_SPEED, 0, 1);
		this.gait.step(amp, dt);
		this.headBob = 0.05 + 0.2 * amp * Math.sin(this.gait.phase * 2);
		this.place(dt);
		return WALKING;
	}

	// push away from other sheep that are too close
	separate(dt) {
		for (const o of this.sheep) {
			if (o === this.s) continue;
			const p = o.g.position;
			const ox = this.x - p.x;
			const oz = this.z - p.z;
			const d = Math.hypot(ox, oz);
			if (d >= AVOID_R || d < 1e-5) continue;
			const k = ((AVOID_R - d) / AVOID_R) * AVOID_PUSH * dt;
			this.x += (ox / d) * k;
			this.z += (oz / d) * k;
		}
	}

	// standing still: gait relaxes, sheep stays on the slope
	stand(dt) {
		this.speed = 0;
		this.headBob = 0.05;
		this.gait.decay(dt);
		this.place(dt);
	}
}
