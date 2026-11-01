// Unravel the sheep: a loose wool thread at every sheep's rear can be pulled until the sheep is bald.
//
// Per sheep (a "unit"):
//   idle     the thread (rope.js) is pinned to the sheep's rear. Pull beyond the rope's reach feeds
//            particles at the anchor (like the yarn ball). The released length shrinks the wool spheres one
//            by one, rear to front, head tuft last, each taking a share proportional to its volume.
//   shy      all wool gone: the thread lets go, the sheep squashes, baas shyly and shivers
//   run      trots away from the thread with a hopping gait, along the ground
//   wait     stands there, embarrassed
//   regrow   wool pops back front to back with spring overshoot
//   happy    hop and baa, a fresh thread end emerges at the rear, back to idle
//
// The detached thread lies where it fell. Once the sheep has left (and nobody holds the thread) it reels
// itself up into a small yarn ball. At most MAX_BALLS balls stay; the oldest shrinks away.
//
// While a sheep is bald or running, `sheep.busy` is true: world.js skips its graze / hop animation and this
// module drives sheep.g, sheep.body and sheep.head. `sheep.bald` lets reactions.js skip wool tufts.
// sheeplife.js also sets `sheep.busy` while it drives a sheep (held, chasing, eating). The two modules never
// drive the same sheep: sheeplife only acts while stateOf(sheep) is 'idle' and the thread is not being pulled,
// and gives the sheep up as soon as that stops being true.
import * as THREE from 'three';
import { Rope } from './rope.js';
import { Spring } from './spring.js';
import { Walker, clearPath as pathClear, clamp, sstep, WALKING } from './sheepwalk.js';
import { addFuzz } from './fuzz.js';
import { playBaa, playPop } from './sound.js';

const MAX_DT = 0.05;

// thread
const THREAD_PARTICLES = 13; // length of a fresh thread end
const THREAD_MAX = 170; // rope capacity: fresh end + all released wool
const THREAD_LIFT = 0.04; // thread height above the ground when laid out
const EMERGE_STEP = 0.03; // seconds between particles of a thread that grows out of the rear
const REAR_DIR = new THREE.Vector3(0, -0.35, -1).normalize(); // body-local direction to the rear wool tip
const REAR_INSET = 0.92; // fraction of the rear sphere radius where the thread leaves it

// pulling
const WOOL_TOTAL = 6; // world units of yarn in one sheep
const WOOL_DONE = WOOL_TOTAL - 1e-4;
const SHRINK_EXP = 0.6; // sphere scale = (1 - share released) ^ this
const HIDE_BELOW = 0.04; // sphere scale where it pops away
const FEED_THRESHOLD = 0.0125;
const SPOOL_SPEED = 4; // max units of yarn released per second
const SPOOL_BURST = 0.15;
const SURPRISE_JOLT = 2.2; // upward kick of the body on the first unspool
const LEAN_POS = 0.05; // stagger toward the pull, units
const LEAN_TILT = 0.2; // lean toward the pull, radians
const LEAN_DECAY = 3; // 1/s, how fast the brace relaxes after the pull stops
const COLLIDER_BALD = 0.26;
const COLLIDER_SLACK = 0.05;

// bald body: slim pink knitted ellipsoid under the wool (semi axes, body-local center)
const BALD_COLOR = '#f3c8c0';
const BALD_RADII = [0.25, 0.21, 0.38];
const BALD_CENTER = [0, 0.52, -0.02];

// embarrassed
const SQUASH_Y = 0.72;
const SHY_TIME = 1;
const SHIVER_START = 0.15;
const SHIVER_END = 0.95;
const SHIVER_FREQ = 55; // rad/s
const SHIVER_AMP = 0.07; // roll, radians
const HEAD_SHY = 0.9; // head dips this far (radians) when embarrassed

// running away
const RUN_MIN = 2.5;
const RUN_MAX = 3.5;
const RUN_TRIES = [1, 0.75, 0.55]; // fractions of the picked distance to try
const TURN_OFFSETS = [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI];

// regrow
const WAIT_TIME = 1.5;
const REGROW_TIME = 4.5; // from the first pop until everything has settled
const POP_SETTLE = 0.7; // time the last sphere needs to settle
const REGROW_STIFF = 240;
const REGROW_DAMP = 11;
const POP_PITCH = 0.8;
const POP_PITCH_STEP = 0.07;
const POP_BUMP = 1.4; // body squash kick per popped sphere
const HEAD_REGROW = 0.3;
const HAPPY_ANTIC = 0.14;
const HAPPY_AIR = 0.5;
const HAPPY_HOP = 0.3;
const HAPPY_SETTLE = 0.3;

// rolled-up thread balls
const ROLL_TIME = 1.75;
const ROLL_DELAY = 0.4; // after the sheep arrived and the thread is let go
const ROLL_KEEP = 5; // rope.reel() stops at this many particles
const VOL_PER_UNIT = 0.0052; // ball volume per unit of thread
const MAX_BALLS = 3;
const BALL_POOL = MAX_BALLS + 1;
const BALL_MIN_R = 0.03;
const BALL_SINK = 0.1; // fraction of the radius sunk into the ground
const BALL_SHRINK_TIME = 0.4;

const rnd = (a, b) => a + Math.random() * (b - a);

export function setupUnravel({ root, sheep, groundAt, walkable, colliders, mat, sphereRep, sphereGeo, P }) {
	const threadMat = mat(P.cream, 'strand', [1, 1]);
	const baldMat = mat(BALD_COLOR, 'stockinette', sphereRep(0.3));
	const ballMat = mat(P.cream, 'boucle', sphereRep(0.16));
	const ballGeo = sphereGeo(1);
	const baldGeo = sphereGeo(1);

	const BODY_TIP = (() => {
		const [rx, ry, rz] = BALD_RADII;
		const d = [0, -0.3, -1];
		const n = Math.hypot(d[0] / rx, d[1] / ry, d[2] / rz);
		return new THREE.Vector3(BALD_CENTER[0] + d[0] / n, BALD_CENTER[1] + d[1] / n, BALD_CENTER[2] + d[2] / n);
	})();

	const anchor = new THREE.Vector3();
	const tip = new THREE.Vector3();
	const pull = new THREE.Vector3(1, 0, 0);
	const head = new THREE.Vector3();
	const axis = new THREE.Vector3();
	const spinQ = new THREE.Quaternion();
	const dest = { dx: 0, dz: 1, dist: 0 };

	const units = sheep.map(makeUnit);
	const balls = Array.from({ length: BALL_POOL }, makeBall);
	let ballSeq = 0;

	// ---- setup ----------------------------------------------------------------------------

	function makeRope() {
		const rope = new Rope({ groundAt, material: threadMat, maxPoints: THREAD_MAX, colliders });
		rope.mesh.visible = false;
		root.add(rope.mesh);
		return rope;
	}

	function makeUnit(s) {
		// wool spheres ordered rear to front, head tuft last
		const wool = s.wool.map((mesh, i) => ({ mesh, i, z: mesh.position.z }));
		wool.sort((a, b) => a.z - b.z || a.i - b.i);
		const parts = [...wool, { mesh: s.tuft, i: wool.length, z: 0 }];
		let volume = 0;
		for (const p of parts) {
			p.r = p.mesh.geometry.parameters.radius;
			p.vol = p.r ** 3;
			volume += p.vol;
		}
		let acc = 0;
		for (const p of parts) {
			p.start = acc;
			p.share = (WOOL_TOTAL * p.vol) / volume;
			acc += p.share;
			p.gone = false;
			p.started = false;
			p.spring = new Spring(REGROW_STIFF, REGROW_DAMP, 1);
		}

		const bald = new THREE.Mesh(baldGeo, baldMat);
		bald.scale.set(...BALD_RADII);
		bald.position.set(...BALD_CENTER);
		bald.castShadow = true;
		bald.receiveShadow = true;
		s.body.add(bald);

		const collider = colliders.find((c) => c.s === s);
		const walker = new Walker(s, { groundAt, walkable });
		const u = {
			s,
			parts,
			order: [...parts].reverse(), // regrow order: front to back
			home: { pos: s.g.position.clone(), yaw: s.yaw, pitch: s.pitch, roll: s.roll },
			ropes: [makeRope(), makeRope()],
			rope: null, // thread attached to the sheep
			loose: null, // { rope, state: 'lying' | 'rolling', wait, ball, total, reeled, carry, len, rFinal }
			collider,
			baseRadius: collider ? collider.radius : 0.42,
			grabbable: null,
			state: 'idle',
			t: 0,
			released: 0,
			budget: 0,
			surprised: false,
			emerge: 0,
			emergeT: 0,
			walker,
			gait: walker.gait,
			run: null,
			shiver: 0,
			landed: false,
			sy: new Spring(260, 12, 1),
			jolt: new Spring(300, 10, 0),
			leanX: new Spring(140, 12, 0),
			leanZ: new Spring(140, 12, 0),
			act: 0,
			leanLx: 0,
			leanLz: 0,
		};
		u.grabbable = makeGrabbable(u);
		return u;
	}

	function makeBall() {
		const group = new THREE.Group();
		const roll = new THREE.Group();
		const mesh = new THREE.Mesh(ballGeo, ballMat);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		addFuzz(mesh, { color: P.cream, length: 0.3, density: 300, layers: 10 });
		roll.add(mesh);
		group.add(roll);
		root.add(group);
		const b = { group, roll, state: 'free', r: BALL_MIN_R, k: 1, seq: 0, shrinkT: 0, squash: new Spring(260, 12, 1) };
		// poke: squash and pop (the mesh is in the scene from the start, so poke.js can hit it)
		group.userData.onPoke = () => {
			if (b.state !== 'rest') return;
			b.squash.value = 0.62;
			b.squash.velocity = 0;
			playPop({ pitch: 0.9 + Math.random() * 0.5 });
		};
		hideBall(b);
		return b;
	}

	// ---- wool -----------------------------------------------------------------------------

	function applyWool(u) {
		const { parts } = u;
		for (let i = 0; i < parts.length; i++) {
			const p = parts[i];
			if (p.gone) continue;
			const f = (u.released - p.start) / p.share;
			if (f <= 0) break;
			const k = Math.pow(Math.max(0, 1 - f), SHRINK_EXP);
			if (k < HIDE_BELOW) {
				p.gone = true;
				p.mesh.visible = false;
				playPop({ pitch: 0.9 + i * 0.06 + Math.random() * 0.1 });
			} else {
				p.mesh.scale.setScalar(k);
			}
		}
	}

	function restoreWool(u) {
		for (const p of u.parts) {
			p.gone = false;
			p.started = false;
			p.mesh.visible = true;
			p.mesh.scale.setScalar(1);
			p.spring.snap(1);
		}
	}

	// ---- thread ---------------------------------------------------------------------------

	// where the thread leaves the sheep: rearmost of the rear wool tip and the bare body tip
	function anchorWorld(u, out) {
		const { s } = u;
		const rear = u.parts[0];
		tip.copy(BODY_TIP);
		if (rear.mesh.visible) {
			const r = rear.r * rear.mesh.scale.x * REAR_INSET;
			const wz = rear.mesh.position.z + REAR_DIR.z * r;
			if (wz < tip.z) {
				tip.set(rear.mesh.position.x + REAR_DIR.x * r, rear.mesh.position.y + REAR_DIR.y * r, wz);
			}
		}
		s.body.updateWorldMatrix(true, false);
		return out.copy(tip).applyMatrix4(s.body.matrixWorld);
	}

	const freeRope = (u) => u.ropes.find((r) => r !== u.rope && !(u.loose && u.loose.rope === r));

	function threadPath(u) {
		anchorWorld(u, anchor);
		const yaw = u.s.g.rotation.y;
		const bx = -Math.sin(yaw);
		const bz = -Math.cos(yaw);
		const sx = -bz;
		const sz = bx;
		const ground = (x, z) => groundAt(x, z) + THREAD_LIFT;
		const at = (back, side, y) => new THREE.Vector3(anchor.x + bx * back + sx * side, y, anchor.z + bz * back + sz * side);
		const cx = anchor.x + bx * 0.18;
		const cz = anchor.z + bz * 0.18;
		const dy = ground(anchor.x + bx * 0.3 + sx * 0.04, anchor.z + bz * 0.3 + sz * 0.04);
		const pts = [
			anchor.clone(),
			at(0.07, 0, anchor.y - 0.14),
			at(0.18, 0, Math.max(ground(cx, cz), anchor.y - 0.3)),
			at(0.3, 0.04, dy),
		];
		// little curl at the end, lying on the ground
		const R = 0.05;
		for (let k = 1; k <= 9; k++) {
			const a = (k / 9) * Math.PI * 0.9;
			const p = at(0.3 + R * Math.sin(a), 0.04 + R * (1 - Math.cos(a)), 0);
			p.y = ground(p.x, p.z);
			pts.push(p);
		}
		return pts;
	}

	// instant: finished thread with a curl; otherwise it grows out of the rear
	function spawnThread(u, instant) {
		const rope = freeRope(u);
		rope.mesh.visible = true;
		rope.releaseAll();
		if (instant) {
			rope.setAnchor(anchorWorld(u, anchor));
			rope.setPath(threadPath(u));
			rope.settle(3);
			u.emerge = 0;
		} else {
			anchorWorld(u, anchor);
			rope.setAnchor(anchor);
			rope.setPath([anchor.clone(), anchor.clone().setY(anchor.y - 0.2)]);
			u.emerge = Math.max(0, THREAD_PARTICLES - rope.count);
			u.emergeT = 0;
		}
		u.rope = rope;
	}

	function retireRope(rope) {
		rope.releaseAll();
		rope.clearAnchor();
		rope.mesh.visible = false;
	}

	const held = (rope) => {
		for (const g of rope.grabs) if (g.active) return true;
		return false;
	};

	// ---- pointer interaction --------------------------------------------------------------

	function makeGrabbable(u) {
		let target = null;
		let index = -1;
		const consider = (rope, ray, camera, best) => {
			const hit = rope && rope.mesh.visible ? rope.pick(ray, camera) : null;
			if (hit && (!best || hit.distance < best.distance)) return { distance: hit.distance, rope, index: hit.index };
			return best;
		};
		return {
			pick(ray, camera) {
				let best = consider(u.rope, ray, camera, null);
				if (u.loose && u.loose.state === 'lying') best = consider(u.loose.rope, ray, camera, best);
				if (!best) return null;
				target = best.rope;
				index = best.index;
				return { distance: best.distance };
			},
			grab() {
				const g = target && target.grab(index);
				if (!g) return { move() {}, release() {} };
				return { move: (v) => g.move(v), release: () => g.release() };
			},
		};
	}

	// ---- sheep placement and pose ---------------------------------------------------------

	function poseBody(u) {
		const { body } = u.s;
		const { gait } = u;
		const sy = u.sy.value * gait.sq;
		const xz = 1 + (1 - sy) * 0.5;
		body.position.set(0, gait.hopY + u.jolt.value * 0.6, 0);
		body.rotation.set(gait.pitch, 0, gait.roll + u.shiver);
		body.scale.set(xz, sy, xz);
	}

	function decayGait(u, dt) {
		u.gait.decay(dt);
		u.shiver *= Math.exp(-10 * dt);
	}

	// stagger toward the pull; adds on top of whatever the pose set this frame
	function applyLean(u, dt) {
		const { body } = u.s;
		u.act = Math.max(0, u.act - LEAN_DECAY * dt);
		u.leanX.target = u.leanLx * u.act;
		u.leanZ.target = u.leanLz * u.act;
		const lx = u.leanX.update(dt);
		const lz = u.leanZ.update(dt);
		body.position.x += lx * LEAN_POS;
		body.position.z += lz * LEAN_POS;
		body.rotation.x += lz * LEAN_TILT;
		body.rotation.z -= lx * LEAN_TILT;
	}

	// ---- per-sheep state machine ----------------------------------------------------------

	function updateUnit(u, dt) {
		u.jolt.update(dt);
		if (u.state === 'idle') updateIdle(u, dt);
		else updateBusy(u, dt);
		applyLean(u, dt);
		updateCollider(u);
	}

	function updateIdle(u, dt) {
		const { s, rope } = u;
		// the world loop already animated body / head this frame; clear what only this module sets.
		// A sheep driven by sheeplife.js (busy) was posed from scratch this frame: only add the jolt.
		if (!s.busy) {
			s.body.position.x = 0;
			s.body.position.z = 0;
			s.body.rotation.z = 0;
		}
		s.body.position.y += u.jolt.value * 0.6;

		rope.setAnchor(anchorWorld(u, anchor));
		if (u.emerge > 0) {
			u.emergeT += dt;
			while (u.emergeT >= EMERGE_STEP && u.emerge > 0) {
				u.emergeT -= EMERGE_STEP;
				if (!rope.feed()) u.emerge = 0;
				else u.emerge--;
			}
		}

		// unspool as much as the pull asks for and the spool allows
		let e = rope.pullExcess(pull);
		u.budget = Math.min(u.budget + SPOOL_SPEED * dt, SPOOL_BURST);
		const seg = rope.segment;
		let fed = 0;
		while (e > FEED_THRESHOLD && u.budget >= seg && u.released < WOOL_DONE && rope.count < rope.maxPoints) {
			if (!rope.feed()) break;
			u.released += seg;
			u.budget -= seg;
			fed += seg;
			e -= rope.reachFactor * seg;
		}
		if (fed > 0) {
			applyWool(u);
			// brace: lean toward the pull (pull is a horizontal unit vector, world space)
			const yaw = s.g.rotation.y;
			u.leanLx = pull.x * Math.cos(yaw) - pull.z * Math.sin(yaw);
			u.leanLz = pull.x * Math.sin(yaw) + pull.z * Math.cos(yaw);
			u.act = 1;
			if (!u.surprised) {
				u.surprised = true;
				playBaa();
				u.jolt.kick(SURPRISE_JOLT);
			}
		}
		rope.update(dt);
		if (u.released >= WOOL_DONE) startShy(u);
	}

	function startShy(u) {
		const { s } = u;
		// the previous loose thread (if still around) turns into a ball right now
		if (u.loose) finishLoose(u);
		u.loose = { rope: u.rope, state: 'lying', wait: 0, ball: null, total: 0, reeled: 0, carry: 0, len: 0, rFinal: 0 };
		u.rope.clearAnchor();
		u.rope = null;
		s.busy = true;
		s.bald = true;
		u.state = 'shy';
		u.t = 0;
		u.walker.setPos(s.g.position.x, s.g.position.z);
		u.gait.reset();
		u.shiver = 0;
		u.walker.place(0);
		u.sy.value = SQUASH_Y;
		u.sy.velocity = 0;
		playBaa();
	}

	function updateBusy(u, dt) {
		const { s } = u;
		u.t += dt;
		u.sy.update(dt);
		let headTarget = HEAD_SHY;
		switch (u.state) {
			case 'shy': {
				decayGait(u, dt);
				const env = sstep(SHIVER_START, SHIVER_START + 0.1, u.t) * (1 - sstep(SHIVER_END - 0.1, SHIVER_END, u.t));
				u.shiver = Math.sin(u.t * SHIVER_FREQ) * SHIVER_AMP * env;
				if (u.t >= SHY_TIME) startRun(u);
				break;
			}
			case 'run':
				headTarget = updateRun(u, dt);
				break;
			case 'wait':
				decayGait(u, dt);
				if (u.t >= WAIT_TIME) startRegrow(u);
				break;
			case 'regrow':
				decayGait(u, dt);
				headTarget = HEAD_REGROW;
				updateRegrow(u, dt);
				break;
			case 'happy':
				decayGait(u, dt);
				headTarget = -0.2;
				updateHappy(u, dt);
				break;
		}
		poseBody(u);
		s.head.rotation.x += (headTarget - s.head.rotation.x) * (1 - Math.exp(-8 * dt));
	}

	// ---- run away -------------------------------------------------------------------------

	// a direction roughly away from the thread, over ground the sheep may walk on
	function pickDestination(u) {
		const rope = u.loose.rope;
		let cx = 0;
		let cz = 0;
		for (let i = 0; i < rope.count; i++) {
			cx += rope.pos[i * 3];
			cz += rope.pos[i * 3 + 2];
		}
		cx /= rope.count;
		cz /= rope.count;
		const { x: x0, z: z0 } = u.walker;
		let base = Math.atan2(x0 - cx, z0 - cz);
		if (Math.hypot(x0 - cx, z0 - cz) < 0.05) base = u.s.yaw;
		base += rnd(-0.3, 0.3);
		const flip = Math.random() < 0.5 ? 1 : -1;
		const dist0 = rnd(RUN_MIN, RUN_MAX);
		for (const f of RUN_TRIES) {
			for (const off of TURN_OFFSETS) {
				const a = base + off * flip;
				const dx = Math.sin(a);
				const dz = Math.cos(a);
				if (!pathClear(x0, z0, dx, dz, dist0 * f, walkable, sheep, u.s)) continue;
				dest.dx = dx;
				dest.dz = dz;
				dest.dist = dist0 * f;
				return true;
			}
		}
		return false;
	}

	function startRun(u) {
		u.t = 0;
		if (!pickDestination(u)) {
			u.state = 'wait';
			return;
		}
		u.state = 'run';
		const { x, z } = u.walker;
		u.run = { tx: x + dest.dx * dest.dist, tz: z + dest.dz * dest.dist };
		u.walker.begin();
	}

	// returns the head pitch target
	function updateRun(u, dt) {
		const { walker: w, run: r } = u;
		const res = w.walk(r.tx, r.tz, 0, dt);
		u.shiver = 0;
		if (res !== WALKING) {
			u.state = 'wait';
			u.t = 0;
		}
		return w.headBob;
	}

	// ---- regrow ---------------------------------------------------------------------------

	function startRegrow(u) {
		u.state = 'regrow';
		u.t = 0;
		for (const p of u.order) {
			p.started = false;
			p.mesh.visible = false;
		}
	}

	function updateRegrow(u, dt) {
		const n = u.order.length;
		const step = (REGROW_TIME - POP_SETTLE) / (n - 1);
		for (let k = 0; k < n; k++) {
			const p = u.order[k];
			if (!p.started) {
				if (u.t < k * step) break;
				p.started = true;
				p.gone = false;
				p.mesh.visible = true;
				p.spring.snap(0);
				p.spring.target = 1;
				playPop({ pitch: POP_PITCH + k * POP_PITCH_STEP });
				u.sy.kick(-POP_BUMP);
			}
			p.spring.update(dt);
			p.mesh.scale.setScalar(Math.max(0.001, p.spring.value));
		}
		if (u.t >= REGROW_TIME) {
			for (const p of u.order) {
				p.spring.snap(1);
				p.mesh.scale.setScalar(1);
			}
			u.state = 'happy';
			u.t = 0;
			u.landed = false;
		}
	}

	function updateHappy(u, dt) {
		if (u.t < HAPPY_ANTIC) {
			u.gait.sq = 1 - 0.15 * sstep(0, HAPPY_ANTIC, u.t);
			return;
		}
		const a = (u.t - HAPPY_ANTIC) / HAPPY_AIR;
		if (a < 1) {
			if (a - dt / HAPPY_AIR <= 0) playBaa();
			u.gait.hopY = 4 * HAPPY_HOP * a * (1 - a);
			u.gait.sq = 1 + 0.08 * Math.sin(Math.PI * a);
			return;
		}
		if (!u.landed) {
			u.landed = true;
			u.gait.hopY = 0;
			u.gait.sq = 1;
			u.sy.value = 0.86;
			u.sy.velocity = 0;
			// fresh thread end at the rear
			spawnThread(u, false);
			u.released = 0;
			u.budget = 0;
			u.surprised = false;
			for (const p of u.parts) {
				p.gone = false;
				p.started = false;
			}
		}
		if (u.t >= HAPPY_ANTIC + HAPPY_AIR + HAPPY_SETTLE) endBusy(u);
	}

	function endBusy(u) {
		const { s } = u;
		s.busy = false;
		s.bald = false;
		u.state = 'idle';
		u.sy.snap(1);
		u.gait.reset();
		u.shiver = 0;
		s.body.position.set(0, 0, 0);
		s.body.rotation.set(0, 0, 0);
		s.body.scale.set(1, 1, 1);
	}

	// keep the thread outside the sheep's own collider sphere
	function updateCollider(u) {
		const c = u.collider;
		if (!c) return;
		if (u.s.bald) c.radius = COLLIDER_BALD;
		else if (u.rope && u.rope.anchored) {
			c.radius = clamp(u.rope.anchor.distanceTo(c.center) - u.rope.radius - COLLIDER_SLACK, 0.2, u.baseRadius);
		} else c.radius = u.baseRadius;
	}

	// ---- loose thread and little balls ----------------------------------------------------

	function updateLoose(u, dt) {
		const l = u.loose;
		if (!l) return;
		if (l.state === 'lying') {
			l.rope.update(dt);
			const left = u.state !== 'idle' && u.state !== 'shy' && u.state !== 'run';
			const idleAgain = u.state === 'idle';
			if ((left || idleAgain) && !held(l.rope)) {
				l.wait += dt;
				if (l.wait >= ROLL_DELAY) startRoll(u);
			} else l.wait = 0;
			return;
		}
		updateRoll(u, dt);
	}

	function ballRadius(l) {
		return Math.cbrt((3 * VOL_PER_UNIT * l.len) / (4 * Math.PI));
	}

	function startRoll(u) {
		const l = u.loose;
		const { rope } = l;
		rope.releaseAll();
		l.len = (rope.count - 1) * rope.segment;
		l.rFinal = ballRadius(l);
		l.total = rope.count - ROLL_KEEP;
		l.reeled = 0;
		l.carry = 0;
		l.state = 'rolling';
		rope.positionOf(0, head);
		l.ball = claimBall(head.x, head.z, BALL_MIN_R);
		l.ball.state = 'rolling';
		trimBalls();
		if (l.total < 1) finishLoose(u);
	}

	function updateRoll(u, dt) {
		const l = u.loose;
		const { rope, ball } = l;
		l.carry += (l.total / ROLL_TIME) * dt;
		while (l.carry >= 1) {
			l.carry -= 1;
			if (!rope.reel()) {
				finishLoose(u);
				return;
			}
			l.reeled++;
		}
		rope.positionOf(0, head);
		ball.r = Math.max(BALL_MIN_R, l.rFinal * Math.cbrt(l.reeled / l.total));
		const dx = head.x - ball.group.position.x;
		const dz = head.z - ball.group.position.z;
		const dist = Math.hypot(dx, dz);
		if (dist > 1e-6) spin(ball, dx, dz, dist / ball.r);
		ball.group.position.x = head.x;
		ball.group.position.z = head.z;
		placeBall(ball);
		rope.update(dt);
	}

	// the thread becomes a finished ball right now (end of rolling, or forced)
	function finishLoose(u) {
		const l = u.loose;
		const { rope } = l;
		if (!l.ball) {
			l.len = (rope.count - 1) * rope.segment;
			l.rFinal = ballRadius(l);
			rope.positionOf(rope.count - 1, head);
			l.ball = claimBall(head.x, head.z, l.rFinal);
			l.ball.state = 'rolling';
		}
		const b = l.ball;
		b.r = l.rFinal;
		b.state = 'rest';
		placeBall(b);
		retireRope(rope);
		u.loose = null;
		trimBalls();
	}

	function claimBall(x, z, r) {
		let b = balls.find((o) => o.state === 'free');
		if (!b) b = balls.find((o) => o.state === 'shrink');
		b.seq = ++ballSeq;
		b.r = r;
		b.k = 1;
		b.squash.snap(1);
		b.roll.quaternion.identity();
		b.group.visible = true;
		b.group.position.set(x, 0, z);
		b.state = 'rolling';
		placeBall(b);
		return b;
	}

	// keep at most MAX_BALLS: the oldest resting ball shrinks away
	function trimBalls() {
		let live = 0;
		for (const b of balls) if (b.state === 'rest' || b.state === 'rolling') live++;
		while (live > MAX_BALLS) {
			let old = null;
			for (const b of balls) if (b.state === 'rest' && (!old || b.seq < old.seq)) old = b;
			if (!old) return;
			old.state = 'shrink';
			old.shrinkT = 0;
			live--;
		}
	}

	function hideBall(b) {
		b.state = 'free';
		b.group.visible = false;
		b.group.position.set(0, -50, 0);
		b.group.scale.setScalar(1e-4);
		b.squash.snap(1);
	}

	function placeBall(b) {
		const sy = b.squash.value;
		const xz = 1 + (1 - sy) * 0.45;
		const r = b.r * b.k;
		const p = b.group.position;
		b.group.scale.set(r * xz, r * sy, r * xz);
		p.y = groundAt(p.x, p.z) + r * (sy - BALL_SINK);
	}

	// roll the ball toward (dx, dz) by angle
	function spin(b, dx, dz, angle) {
		axis.set(dz, 0, -dx);
		if (axis.lengthSq() < 1e-12) return;
		axis.normalize();
		spinQ.setFromAxisAngle(axis, angle);
		b.roll.quaternion.premultiply(spinQ).normalize();
	}

	function updateBall(b, dt) {
		if (b.state === 'rest') {
			if (b.squash.settled) return;
			b.squash.update(dt);
			if (b.squash.settled) b.squash.snap(1);
			placeBall(b);
		} else if (b.state === 'shrink') {
			b.shrinkT += dt;
			const f = b.shrinkT / BALL_SHRINK_TIME;
			if (f >= 1) {
				hideBall(b);
				playPop({ pitch: 1.5 });
				return;
			}
			b.k = Math.max(1e-3, 1 - sstep(0, 1, f));
			placeBall(b);
		}
	}

	// ---- reset ----------------------------------------------------------------------------

	function resetUnit(u) {
		const { s, home } = u;
		for (const rope of u.ropes) retireRope(rope);
		u.rope = null;
		u.loose = null;
		u.state = 'idle';
		u.t = 0;
		u.released = 0;
		u.budget = 0;
		u.surprised = false;
		u.emerge = 0;
		u.run = null;
		u.act = 0;
		u.leanLx = 0;
		u.leanLz = 0;
		u.leanX.snap(0);
		u.leanZ.snap(0);
		u.sy.snap(1);
		u.jolt.snap(0);
		u.gait.reset();
		u.shiver = 0;
		s.busy = false;
		s.bald = false;
		s.yaw = home.yaw;
		s.pitch = home.pitch;
		s.roll = home.roll;
		u.walker.setPos(home.pos.x, home.pos.z);
		s.g.position.copy(home.pos);
		s.g.rotation.set(home.pitch, home.yaw, home.roll);
		s.body.position.set(0, 0, 0);
		s.body.rotation.set(0, 0, 0);
		s.body.scale.set(1, 1, 1);
		restoreWool(u);
		if (u.collider) u.collider.radius = u.baseRadius;
		s.g.updateMatrixWorld(true);
		spawnThread(u, true);
	}

	function reset() {
		for (const b of balls) hideBall(b);
		for (const u of units) resetUnit(u);
	}

	// ---- per frame ------------------------------------------------------------------------

	function update(t, dt) {
		dt = Math.min(dt, MAX_DT);
		if (dt <= 0) return;
		for (const u of units) {
			updateUnit(u, dt);
			updateLoose(u, dt);
		}
		for (const b of balls) updateBall(b, dt);
	}

	const unitOf = new Map(units.map((u) => [u.s, u]));
	reset();
	return {
		update,
		reset,
		grabbables: units.map((u) => u.grabbable),
		// 'idle' | 'shy' | 'run' | 'wait' | 'regrow' | 'happy' for a sheep
		stateOf: (s) => unitOf.get(s).state,
		// true while the thread is being pulled hard enough to unspool wool (and for ~0.3 s after)
		isPulled: (s) => unitOf.get(s).act > 0,
	};
}
