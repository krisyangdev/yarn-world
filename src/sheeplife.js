// Sheep life: three things a sheep does besides grazing.
//   1. pick it up and drop it  (held -> falling -> landed [-> hopAway])
//   2. chase the rolling yarn ball and nudge it  (notice -> chase <-> nudge)
//   3. walk over and eat fallen pompom fruit  (fetch -> eat -> cheer)
//
// One state machine per sheep, in `state`:
//   idle      world.js grazes it; the only state that may start something new
//   held      hangs from the hand, legs paddling                           (grab)
//   falling   dropped, falls with gravity                                  (release)
//   landed    squash, stagger, turns to a random heading; then idle, or hopAway on bad ground
//   hopAway   hops (ignoring obstacles) to the nearest walkable, free spot
//   notice    head pops up, tiny hop                                       (ball is rolling)
//   chase     trots toward the ball
//   nudge     at the ball: wind up, head butt (yarn.nudge), sniff; repeats a few times
//   fetch     trots to the claimed fruit
//   eat       faces the fruit, three bites
//   cheer     happy hop and baa
// notice / chase / nudge / fetch / eat are interrupted by a poke (the sheep wrapped userData.onPoke) and by
// pulling its thread. unravel.js owns a sheep whenever unravel.stateOf(s) !== 'idle': sheeplife then lets go
// at once. While sheeplife drives a sheep it sets `s.busy` so world.js skips the graze / hop animation.
//
// Call update() before unravel.update(): it poses body / head / legs from scratch every frame and unravel
// adds the thread lean and jolt on top.
import * as THREE from 'three';
import { Spring } from './spring.js';
import { H, S } from './layout.js';
import { playBaa, playMunch, playNudge, playThump } from './sound.js';
import { Walker, WALKING, ARRIVED, BLOCKED, WALK_SPEED, placeSheep, standHeight, clearPath, clamp, sstep } from './sheepwalk.js';

const MAX_DT = 0.05;
const TAU = Math.PI * 2;
const GRAVITY = 12;

// --- lift ---
const PICK_R = 0.5; // pick sphere radius around the body, world units
const PICK_Y = 0.5; // body-local height of the pick sphere center
const PICK_BIAS = 0.25; // added to the pick distance so a thread behind the sheep wins a close call
const HOLD_LIFT = 0.4; // hooves this far above the hand point (hand = ground under the cursor + 0.35)
const HANG = 0.95; // hang point (top of the back) above the hooves
const HAND_LIMIT = 0.8 * H; // the hand stays on the island
const FOLLOW_K = 120; // hand follow spring
const FOLLOW_C = 13;
const SWING_K = 70; // pendulum springs (underdamped so the sheep swings)
const SWING_C = 6;
const SWING_GAIN = 0.16; // radians of lag tilt per unit/s of hand speed
const SWING_MAX = 0.6;
const SWING_IDLE = 0.05; // gentle sway while held still
const HELD_PITCH = 0.1; // nose-down hang
const STRETCH_GAIN = 0.03; // body stretches with hand speed
const STRETCH_MAX = 0.12;
const LIFT_POP = 1.2; // stretch when picked up
const LEG_RATE = 10; // 1/s, leg amplitude follows its target
const LEG_SPLAY = 0.2;
const LEG_HELD = 0.75; // leg swing amplitude, radians
const LEG_HELD_FREQ = 14; // rad/s
const LEG_FALL = 0.9;
const LEG_TROT = 0.5;
const LEG_TROT_FREQ = 18;
const BAA_MIN = 2;
const BAA_MAX = 4;
const RELEASE_KEEP = 0.5; // fraction of the hand velocity the sheep keeps when dropped
const RELEASE_MAX = 3;
const LAND_TIME = 0.9; // squash, stagger and turn before the sheep carries on
const LAND_SQUASH = 0.05; // squash per unit of impact speed
const LAND_SQUASH_MIN = 0.55;
const LAND_SQUASH_MAX = 0.85;
const SHAKE_FREQ = 28; // rad/s
const SHAKE_DECAY = 4.5;
const SHAKE_ROLL = 0.14;
const SHAKE_HEAD = 0.5;
const LAND_TURN = 3; // 1/s, turn to the random heading
const LAND_COOL = 2;
const SPOT_GAP = 0.75; // a landing spot keeps this far from other sheep
const SPOT_BALL_GAP = 0.5; // ... and from the ball surface
const SPOT_MARGIN = 0.12;
const SPOT_RING = 0.3;
const SPOT_MAX = S(4.5);
const HOP_AWAY_SPEED = 1.4; // x walk speed
const HOP_AWAY_TIMEOUT = 5;

// --- chase the ball ---
const NOTICE_DIST = S(4.5); // a sheep this close to the ball notices it rolling
const BALL_MOVE_SPEED = 0.2; // ball speed that counts as rolling
const BALL_INTEREST = 2.5; // the ball stays interesting this long after it last moved
const NUDGE_QUIET = 1.8; // ball motion this long after a nudge is ignored (sheep do not feed on their own nudges)
const MAX_CHASERS = 2;
const CHASE_STAGGER = 0.9; // seconds between two sheep joining
const CHASE_COOL_MIN = 8; // before the same sheep chases again
const CHASE_COOL_MAX = 12;
const NOTICE_TIME = 0.55;
const NOTICE_HEAD = -0.5;
const NOTICE_HOP = 0.1;
const NOTICE_BAA = 0.4; // chance
const NUDGE_STOP = 0.7; // body center to ball surface when the sheep stops (the nose is ~0.65 ahead of the center)
const NUDGE_SPEED = 1.1; // roll speed given to the ball
const NUDGE_MAX = 3;
const SESSION_MAX = 6; // seconds at the ball before the sheep loses interest
const CHASE_MAX = 14;
const GIVE_UP_DIST = S(7);
const REACH_SLACK = 0.45; // ball this far beyond the stop distance: walk after it
const BLOCK_CLOSE = 0.6; // blocked this close to the stop point counts as arrived
const BLOCK_GIVE_UP = 1;
const NUDGE_TURN = 8;
const WIND_TIME = 0.28;
const THRUST_TIME = 0.14;
const SNIFF_TIME = 1;
const WIND_HEAD = -0.35;
const THRUST_HEAD = 0.6;
const SNIFF_HEAD = 0.45;
const SNIFF_AMP = 0.2;
const SNIFF_FREQ = 16;

// --- eat fruit ---
const EAT_RANGE = S(5);
const EAT_STOP = 0.5; // sheep center to fruit
const EAT_TURN = 10;
const DIP_TIME = 0.25;
const BITE_TIME = 0.34;
const BITES = 3;
const BITE_HEAD = 1;
const BITE_DIP = 0.4;
const EAT_PITCH = 0.14;
const NIBBLE = [0.62, 0.3];
const FETCH_TIMEOUT = 10;
const EAT_COOL = 1;
const APPROACH_ANGLES = [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI];
const CHEER_ANTIC = 0.14;
const CHEER_AIR = 0.45;
const CHEER_HOP = 0.28;
const CHEER_SETTLE = 0.25;
const POKE_COOL = 3;

const LEG_H = 0.36; // legGeo height in world.js makeSheep
const HEAD_REST = -0.1;
const HEAD_RATE = 9;

const IDLE = 'idle';
const HELD = 'held';
const FALLING = 'falling';
const LANDED = 'landed';
const HOP_AWAY = 'hopAway';
const NOTICE = 'notice';
const CHASE = 'chase';
const NUDGE = 'nudge';
const FETCH = 'fetch';
const EAT = 'eat';
const CHEER = 'cheer';

const INTERRUPTIBLE = new Set([NOTICE, CHASE, NUDGE, FETCH, EAT]);
const GRABBABLE = new Set([IDLE, NOTICE, CHASE, NUDGE, FETCH, EAT, CHEER]);

const rnd = (a, b) => a + Math.random() * (b - a);

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _pt = { x: 0, z: 0 };

// Give every leg its own pivot at the hip so it can swing. The leg meshes are body children that use the
// 0.36 high cylinder from makeSheep.
function rigLegs(s) {
	const legs = [];
	for (const m of [...s.body.children]) {
		const p = m.geometry && m.geometry.parameters;
		if (!m.isMesh || !p || p.height !== LEG_H || p.radiusTop === undefined) continue;
		const { x, y, z } = m.position;
		const pivot = new THREE.Group();
		pivot.position.set(x, y + LEG_H / 2, z);
		m.position.set(0, -LEG_H / 2, 0);
		s.body.add(pivot);
		pivot.add(m);
		legs.push({ pivot, sx: x > 0 ? 1 : -1, off: x * z > 0 ? 0 : Math.PI });
	}
	return legs;
}

export function setupSheepLife({ sheep, groundAt, walkable, yarn, reactions, unravel }) {
	const fruit = reactions.fruit;
	const ball = yarn.state;
	let now = 0;
	let ballInterestUntil = 0;
	let ballIgnoreUntil = 0;
	let nextChaseAt = 0;
	let skip = new WeakSet(); // fruits no sheep could reach

	const lives = sheep.map(makeLife);
	const lifeOf = new Map(lives.map((l) => [l.s, l]));
	for (const l of lives) hookPoke(l);

	function makeLife(s) {
		const l = {
			s,
			state: IDLE,
			t: 0, // time in the current state
			cool: 0, // generic cooldown before a new behaviour
			chaseCool: 0, // extra cooldown after chasing the ball
			walker: new Walker(s, { groundAt, walkable, sheep }),
			legs: rigLegs(s),
			home: { x: s.g.position.x, z: s.g.position.z },
			token: 0, // identifies the current grab
			sy: new Spring(260, 12, 1), // body squash / stretch
			fx: new Spring(FOLLOW_K, FOLLOW_C),
			fy: new Spring(FOLLOW_K, FOLLOW_C),
			fz: new Spring(FOLLOW_K, FOLLOW_C),
			swX: new Spring(SWING_K, SWING_C),
			swZ: new Spring(SWING_K, SWING_C),
			handX: 0,
			handY: 0,
			handZ: 0,
			nextBaa: 0,
			vx: 0,
			vy: 0,
			vz: 0,
			h: 0, // height above the ground while falling
			yawTarget: 0,
			tx: 0,
			tz: 0,
			valid: true, // landing spot is fine
			// per-frame pose requests, set by the state handlers
			py: 0,
			pp: 0,
			pr: 0,
			hx: HEAD_REST,
			hy: 0,
			hz: 0,
			legTarget: 0,
			legRate: LEG_TROT_FREQ,
			legAmp: 0,
			legPhase: 0,
			// chase
			chaseT: 0,
			sessionT: 0,
			arrived: false,
			nudges: 0,
			blockT: 0,
			ph: 0, // nudge phase
			pt: 0,
			baaOnce: false,
			// fruit
			fruit: null,
			bites: 0,
			ate: false,
			landed: false,
			grabbable: null,
		};
		l.grabbable = makeGrabbable(l);
		return l;
	}

	// ---- helpers --------------------------------------------------------------------------

	const unravelIdle = (l) => unravel.stateOf(l.s) === 'idle';
	const canStart = (l) => l.state === IDLE && l.cool <= 0 && unravelIdle(l) && !unravel.isPulled(l.s);

	function take(l, state) {
		const { s, walker: w } = l;
		l.state = state;
		l.t = 0;
		s.busy = true;
		w.setPos(s.g.position.x, s.g.position.z);
		w.gait.reset();
		l.sy.snap(1);
	}

	// zero everything this module poses; the owner of the sheep (world loop or unravel) takes over
	function clearPose(l) {
		const { s } = l;
		s.body.position.set(0, 0, 0);
		s.body.rotation.set(0, 0, 0);
		s.body.scale.set(1, 1, 1);
		s.head.rotation.y = 0;
		s.head.rotation.z = 0;
		for (const leg of l.legs) leg.pivot.rotation.set(0, 0, 0);
		l.legAmp = 0;
		l.py = l.pp = l.pr = 0;
		l.walker.gait.reset();
		l.sy.snap(1);
		s.g.rotation.y = s.yaw;
	}

	function dropClaim(l) {
		if (l.fruit) {
			fruit.release(l.fruit);
			l.fruit = null;
		}
	}

	function returnIdle(l, cool = 1, chaseCool = 0) {
		dropClaim(l);
		clearPose(l);
		if (unravelIdle(l)) l.s.busy = false; // otherwise unravel just took the sheep over
		l.state = IDLE;
		l.token++;
		l.cool = cool;
		l.chaseCool = Math.max(l.chaseCool, chaseCool);
	}

	// unravel took over: forget everything without touching s.busy (unravel owns it now)
	function abort(l) {
		dropClaim(l);
		clearPose(l);
		l.state = IDLE;
		l.token++;
		l.cool = 1;
	}

	// ---- pose -----------------------------------------------------------------------------

	function pose(l, dt) {
		const { s, walker: w } = l;
		const { gait } = w;
		const sy = l.sy.update(dt) * gait.sq;
		const xz = 1 + (1 - sy) * 0.5;
		s.body.position.set(0, gait.hopY + l.py, 0);
		s.body.rotation.set(gait.pitch + l.pp, 0, gait.roll + l.pr);
		s.body.scale.set(xz, sy, xz);

		const k = 1 - Math.exp(-HEAD_RATE * dt);
		const head = s.head;
		head.rotation.x += (l.hx - head.rotation.x) * k;
		head.rotation.y += (l.hy - head.rotation.y) * k;
		head.rotation.z += (l.hz - head.rotation.z) * k;

		// legs
		const lk = 1 - Math.exp(-LEG_RATE * dt);
		l.legAmp += (l.legTarget - l.legAmp) * lk;
		l.legPhase += dt * l.legRate;
		const legs = l.legs;
		if (l.legAmp < 1e-3 && l.legTarget === 0) {
			l.legAmp = 0;
			for (let i = 0; i < legs.length; i++) legs[i].pivot.rotation.set(0, 0, 0);
		} else {
			for (let i = 0; i < legs.length; i++) {
				const leg = legs[i];
				leg.pivot.rotation.x = l.legAmp * Math.sin(l.legPhase + leg.off);
				leg.pivot.rotation.z = LEG_SPLAY * l.legAmp * leg.sx;
			}
		}
	}

	// pose requests from a trotting sheep
	function trotPose(l) {
		const w = l.walker;
		l.hx = w.headBob;
		l.legTarget = LEG_TROT * clamp(w.speed / WALK_SPEED, 0, 1);
		l.legRate = LEG_TROT_FREQ;
	}

	// ---- landing spot ---------------------------------------------------------------------

	function spotOk(l, x, z) {
		// walkable with a small margin, so a hop that stops a hair short still ends on walkable ground
		if (!walkable(x, z) || !walkable(x + SPOT_MARGIN, z) || !walkable(x - SPOT_MARGIN, z)) return false;
		if (!walkable(x, z + SPOT_MARGIN) || !walkable(x, z - SPOT_MARGIN)) return false;
		for (const o of lives) {
			if (o === l) continue;
			const p = o.s.g.position;
			if (Math.hypot(x - p.x, z - p.z) < SPOT_GAP) return false;
		}
		return Math.hypot(x - ball.x, z - ball.z) > ball.r + SPOT_BALL_GAP;
	}

	// nearest free walkable spot to (x, z): rings outward, starting toward the island center
	function findSpot(l, x, z) {
		const a0 = Math.atan2(-x, -z);
		for (let r = SPOT_RING; r <= SPOT_MAX; r += SPOT_RING) {
			const n = Math.max(8, Math.ceil(r * 14));
			for (let i = 0; i < n; i++) {
				const a = a0 + (i / n) * TAU;
				const px = x + Math.sin(a) * r;
				const pz = z + Math.cos(a) * r;
				if (spotOk(l, px, pz)) {
					_pt.x = px;
					_pt.z = pz;
					return _pt;
				}
			}
		}
		_pt.x = l.home.x;
		_pt.z = l.home.z;
		return _pt;
	}

	// ---- lift: pick, hold, drop -----------------------------------------------------------

	function makeGrabbable(l) {
		return {
			pick(ray) {
				if (!GRABBABLE.has(l.state) || !unravelIdle(l)) return null;
				_c.set(0, PICK_Y, 0).applyMatrix4(l.s.body.matrixWorld);
				_v.subVectors(_c, ray.origin);
				const tca = _v.dot(ray.direction);
				const d2 = _v.lengthSq() - tca * tca;
				if (d2 > PICK_R * PICK_R) return null;
				const t = tca - Math.sqrt(PICK_R * PICK_R - d2);
				return { distance: Math.max(0, t) + PICK_BIAS };
			},
			grab() {
				const noop = { move() {}, release() {} };
				if (!GRABBABLE.has(l.state) || !unravelIdle(l)) return noop;
				const token = startHeld(l);
				return {
					move(target) {
						if (l.token === token && l.state === HELD) setHand(l, target);
					},
					release() {
						if (l.token === token && l.state === HELD) startFall(l);
					},
				};
			},
		};
	}

	function startHeld(l) {
		const { s } = l;
		dropClaim(l);
		take(l, HELD);
		const token = ++l.token;
		// the hang point starts where the sheep's back is, so the first frame does not jump
		const p = s.g.position;
		l.handX = p.x;
		l.handZ = p.z;
		l.handY = p.y - HOLD_LIFT;
		l.fx.snap(p.x);
		l.fy.snap(p.y + HANG);
		l.fz.snap(p.z);
		l.fx.target = l.handX;
		l.fy.target = l.handY + HOLD_LIFT + HANG;
		l.fz.target = l.handZ;
		l.swX.snap(s.pitch);
		l.swZ.snap(s.roll);
		l.sy.value = LIFT_POP;
		l.sy.velocity = 0;
		l.nextBaa = rnd(BAA_MIN, BAA_MAX);
		l.legPhase = 0;
		playBaa();
		return token;
	}

	// hand target from poke.js: ground point under the cursor + 0.35
	function setHand(l, target) {
		l.handX = clamp(target.x, -HAND_LIMIT, HAND_LIMIT);
		l.handZ = clamp(target.z, -HAND_LIMIT, HAND_LIMIT);
		l.handY = Math.max(target.y, groundAt(l.handX, l.handZ) + 0.35);
		l.fx.target = l.handX;
		l.fy.target = l.handY + HOLD_LIFT + HANG;
		l.fz.target = l.handZ;
	}

	function updateHeld(l, dt) {
		const { s, walker: w } = l;
		l.fx.update(dt);
		l.fy.update(dt);
		l.fz.update(dt);
		const vx = l.fx.velocity;
		const vy = l.fy.velocity;
		const vz = l.fz.velocity;
		const speed = Math.hypot(vx, vy, vz);
		const sn = Math.sin(s.yaw);
		const cs = Math.cos(s.yaw);
		// the sheep lags behind the hand: tilt opposite to the motion, springs add the swing
		l.swX.target = clamp((vx * sn + vz * cs) * SWING_GAIN, -SWING_MAX, SWING_MAX) + SWING_IDLE * Math.sin(now * 1.7);
		l.swZ.target = clamp(-(vx * cs - vz * sn) * SWING_GAIN, -SWING_MAX, SWING_MAX) + SWING_IDLE * Math.sin(now * 1.3 + 1);
		const ax = l.swX.update(dt);
		const az = l.swZ.update(dt);
		const yaw = s.yaw + 0.18 * Math.sin(now * 1.9);
		// the hang point is fixed to the hand: the hooves are where it puts them after the tilt
		_e.set(ax, yaw, az, 'YXZ');
		_q.setFromEuler(_e);
		_v.set(0, HANG, 0).applyQuaternion(_q);
		s.g.position.set(l.fx.value - _v.x, l.fy.value - _v.y, l.fz.value - _v.z);
		s.g.rotation.set(ax, yaw, az);
		w.setPos(s.g.position.x, s.g.position.z);

		l.sy.target = 1 + clamp(speed * STRETCH_GAIN, 0, STRETCH_MAX);
		l.pp = HELD_PITCH;
		l.pr = 0.04 * Math.sin(now * 6.5) * Math.min(1, speed);
		l.legTarget = LEG_HELD * (0.85 + 0.3 * Math.min(1, speed / 3));
		l.legRate = LEG_HELD_FREQ;
		l.hx = -0.3 + 0.25 * Math.sin(now * 2.3);
		l.hy = 0.7 * Math.sin(now * 1.4);
		l.hz = 0.2 * Math.sin(now * 1.1);
		l.nextBaa -= dt;
		if (l.nextBaa <= 0) {
			playBaa();
			l.nextBaa = rnd(BAA_MIN, BAA_MAX);
		}
	}

	function startFall(l) {
		const { s, walker: w } = l;
		w.setPos(s.g.position.x, s.g.position.z);
		l.vx = clamp(l.fx.velocity * RELEASE_KEEP, -RELEASE_MAX, RELEASE_MAX);
		l.vz = clamp(l.fz.velocity * RELEASE_KEEP, -RELEASE_MAX, RELEASE_MAX);
		l.vy = clamp(l.fy.velocity * RELEASE_KEEP, -1, RELEASE_MAX);
		// tilt and height carry over; placeSheep eases the tilt back to the slope
		s.pitch = s.g.rotation.x;
		s.roll = s.g.rotation.z;
		l.h = Math.max(0, s.g.position.y - standHeight(w.x, w.z, s.yaw, groundAt));
		l.sy.target = 1;
		l.state = FALLING;
		l.t = 0;
		l.token++;
	}

	function updateFalling(l, dt) {
		const { s, walker: w } = l;
		l.vy -= GRAVITY * dt;
		l.h += l.vy * dt;
		w.x += l.vx * dt;
		w.z += l.vz * dt;
		const damp = Math.exp(-0.8 * dt);
		l.vx *= damp;
		l.vz *= damp;
		if (Math.abs(w.x) > HAND_LIMIT) {
			w.x = clamp(w.x, -HAND_LIMIT, HAND_LIMIT);
			l.vx = 0;
		}
		if (Math.abs(w.z) > HAND_LIMIT) {
			w.z = clamp(w.z, -HAND_LIMIT, HAND_LIMIT);
			l.vz = 0;
		}
		if (l.h <= 0 && l.vy < 0) {
			land(l, -l.vy);
			return;
		}
		placeSheep(s, w.x, w.z, groundAt, dt, l.h);
		l.legTarget = LEG_FALL;
		l.legRate = LEG_HELD_FREQ * 1.4;
		l.hx = -0.4;
		l.hy = 0.5 * Math.sin(l.t * 9);
		l.sy.target = 1.05;
	}

	function land(l, impact) {
		const { s, walker: w } = l;
		l.h = 0;
		l.vy = 0;
		l.state = LANDED;
		l.t = 0;
		l.sy.target = 1;
		l.sy.value = clamp(1 - impact * LAND_SQUASH, LAND_SQUASH_MIN, LAND_SQUASH_MAX);
		l.sy.velocity = 0;
		l.yawTarget = rnd(0, TAU);
		l.valid = spotOk(l, w.x, w.z);
		placeSheep(s, w.x, w.z, groundAt, 0);
		playThump();
	}

	function updateLanded(l, dt) {
		const { walker: w } = l;
		const env = Math.exp(-l.t * SHAKE_DECAY);
		const shake = Math.sin(l.t * SHAKE_FREQ) * env;
		l.pr = shake * SHAKE_ROLL;
		l.hy = shake * SHAKE_HEAD;
		l.hx = 0.35 * env;
		l.legTarget = 0;
		if (l.valid) w.turnTo(Math.sin(l.yawTarget), Math.cos(l.yawTarget), dt, LAND_TURN);
		w.stand(dt);
		if (l.t < LAND_TIME) return;
		if (l.valid) {
			returnIdle(l, LAND_COOL);
			return;
		}
		const p = findSpot(l, w.x, w.z);
		l.tx = p.x;
		l.tz = p.z;
		l.state = HOP_AWAY;
		l.t = 0;
		w.begin();
	}

	function updateHopAway(l, dt) {
		const w = l.walker;
		const res = w.walk(l.tx, l.tz, 0, dt, true, HOP_AWAY_SPEED);
		trotPose(l);
		if (res !== WALKING || l.t > HOP_AWAY_TIMEOUT) returnIdle(l, LAND_COOL);
	}

	// ---- chase the ball -------------------------------------------------------------------

	function updateBallInterest() {
		if (ball.speed > BALL_MOVE_SPEED && now >= ballIgnoreUntil) ballInterestUntil = now + BALL_INTEREST;
	}

	function scanChase() {
		if (now >= ballInterestUntil || now < nextChaseAt) return;
		let chasers = 0;
		let best = null;
		let bestD = NOTICE_DIST;
		for (const l of lives) {
			if (l.state === NOTICE || l.state === CHASE || l.state === NUDGE) chasers++;
			else if (canStart(l) && l.chaseCool <= 0) {
				const p = l.s.g.position;
				const d = Math.hypot(ball.x - p.x, ball.z - p.z);
				if (d < bestD) {
					bestD = d;
					best = l;
				}
			}
		}
		if (!best || chasers >= MAX_CHASERS) return;
		startNotice(best);
		nextChaseAt = now + CHASE_STAGGER;
	}

	function startNotice(l) {
		take(l, NOTICE);
		l.baaOnce = Math.random() < NOTICE_BAA;
		l.chaseT = 0;
		l.sessionT = 0;
		l.arrived = false;
		l.nudges = 0;
		l.blockT = 0;
	}

	function updateNotice(l, dt) {
		const w = l.walker;
		const u = clamp(l.t / NOTICE_TIME, 0, 1);
		w.turnTo(ball.x - w.x, ball.z - w.z, dt, 8);
		w.stand(dt);
		l.hx = NOTICE_HEAD;
		// tiny hop in the middle
		const hop = clamp((u - 0.2) / 0.5, 0, 1);
		w.gait.hopY = NOTICE_HOP * Math.sin(hop * Math.PI);
		w.gait.sq = 1 + 0.06 * Math.sin(hop * Math.PI);
		if (l.baaOnce && l.t > 0.15) {
			l.baaOnce = false;
			playBaa();
		}
		if (l.t >= NOTICE_TIME) {
			l.state = CHASE;
			l.t = 0;
			w.begin();
		}
	}

	function startNudgeAt(l) {
		l.state = NUDGE;
		l.t = 0;
		l.arrived = true;
		l.ph = 0;
		l.pt = 0;
	}

	function loseInterest(l) {
		returnIdle(l, 1, rnd(CHASE_COOL_MIN, CHASE_COOL_MAX));
	}

	function updateChase(l, dt) {
		const w = l.walker;
		l.chaseT += dt;
		if (l.arrived) l.sessionT += dt;
		const stop = ball.r + NUDGE_STOP;
		const dist = Math.hypot(ball.x - w.x, ball.z - w.z);
		if (l.chaseT > CHASE_MAX || l.sessionT > SESSION_MAX || dist > GIVE_UP_DIST) {
			loseInterest(l);
			return;
		}
		const res = w.walk(ball.x, ball.z, stop, dt);
		trotPose(l);
		if (res === ARRIVED) {
			startNudgeAt(l);
		} else if (res === BLOCKED) {
			l.blockT += dt;
			if (dist - stop < BLOCK_CLOSE) startNudgeAt(l);
			else if (l.blockT > BLOCK_GIVE_UP) loseInterest(l);
		} else {
			l.blockT = 0;
		}
	}

	// phases: 0 turn, 1 wind up, 2 head butt, 3 sniff
	function updateNudge(l, dt) {
		const w = l.walker;
		l.chaseT += dt;
		l.sessionT += dt;
		l.pt += dt;
		const dx = ball.x - w.x;
		const dz = ball.z - w.z;
		const dist = Math.hypot(dx, dz);
		const diff = w.turnTo(dx, dz, dt, NUDGE_TURN);
		w.stand(dt);
		if (l.chaseT > CHASE_MAX || l.sessionT > SESSION_MAX || dist > GIVE_UP_DIST) {
			loseInterest(l);
			return;
		}
		const far = dist - (ball.r + NUDGE_STOP) > REACH_SLACK;
		switch (l.ph) {
			case 0:
				l.hx = 0.1;
				if (far) {
					l.state = CHASE;
					l.t = 0;
					w.begin();
				} else if (Math.abs(diff) < 0.3) {
					l.ph = 1;
					l.pt = 0;
				}
				break;
			case 1:
				l.hx = WIND_HEAD;
				l.pp = -0.05 * sstep(0, WIND_TIME, l.pt);
				if (l.pt >= WIND_TIME) {
					l.ph = 2;
					l.pt = 0;
				}
				break;
			case 2: {
				const u = clamp(l.pt / THRUST_TIME, 0, 1);
				l.hx = WIND_HEAD + (THRUST_HEAD - WIND_HEAD) * u * u;
				l.pp = -0.05 + 0.15 * u;
				if (l.pt >= THRUST_TIME) {
					yarn.nudge(dx, dz, NUDGE_SPEED);
					ballIgnoreUntil = now + NUDGE_QUIET;
					playNudge();
					l.nudges++;
					l.ph = 3;
					l.pt = 0;
				}
				break;
			}
			default: {
				const u = clamp(l.pt / SNIFF_TIME, 0, 1);
				l.hx = SNIFF_HEAD + SNIFF_AMP * Math.sin(l.pt * SNIFF_FREQ) * (1 - u);
				l.pp = 0.05 * (1 - u);
				if (l.pt >= SNIFF_TIME) {
					if (l.nudges >= NUDGE_MAX) loseInterest(l);
					else if (far) {
						l.state = CHASE;
						l.t = 0;
						w.begin();
					} else {
						l.ph = 0;
						l.pt = 0;
					}
				}
			}
		}
	}

	// ---- eat fruit ------------------------------------------------------------------------

	function edible(f) {
		return f.resting && !f.claimed && !f.eaten && !f.gone && f.restT >= f.eatDelay && !skip.has(f);
	}

	// a walkable spot EAT_STOP from the fruit, reachable in a straight line; false when there is none
	function approachPoint(l, f) {
		const w = l.walker;
		const fx = f.mesh.position.x;
		const fz = f.mesh.position.z;
		let ux = w.x - fx;
		let uz = w.z - fz;
		const len = Math.hypot(ux, uz);
		if (len < 1e-3) {
			ux = Math.sin(l.s.yaw);
			uz = Math.cos(l.s.yaw);
		} else {
			ux /= len;
			uz /= len;
		}
		for (const a of APPROACH_ANGLES) {
			const c = Math.cos(a);
			const sn = Math.sin(a);
			const px = fx + (ux * c - uz * sn) * EAT_STOP;
			const pz = fz + (ux * sn + uz * c) * EAT_STOP;
			if (!walkable(px, pz)) continue;
			const d = Math.hypot(px - w.x, pz - w.z);
			if (d > 1e-3 && !clearPath(w.x, w.z, (px - w.x) / d, (pz - w.z) / d, d, walkable, null, null)) continue;
			_pt.x = px;
			_pt.z = pz;
			return true;
		}
		return false;
	}

	function scanFruit() {
		const list = fruit.list;
		for (let i = 0; i < list.length; i++) {
			const f = list[i];
			if (!edible(f)) continue;
			let best = null;
			let bestD = EAT_RANGE;
			for (const l of lives) {
				if (!canStart(l)) continue;
				const p = l.s.g.position;
				const d = Math.hypot(f.mesh.position.x - p.x, f.mesh.position.z - p.z);
				if (d < bestD) {
					bestD = d;
					best = l;
				}
			}
			if (!best) continue;
			best.walker.setPos(best.s.g.position.x, best.s.g.position.z);
			if (!approachPoint(best, f) || !fruit.claim(f)) {
				skip.add(f);
				continue;
			}
			startFetch(best, f, _pt.x, _pt.z);
		}
	}

	function startFetch(l, f, x, z) {
		take(l, FETCH);
		l.fruit = f;
		l.tx = x;
		l.tz = z;
		l.walker.begin();
	}

	function updateFetch(l, dt) {
		const w = l.walker;
		const f = l.fruit;
		if (f.gone) {
			returnIdle(l, 1);
			return;
		}
		const res = w.walk(l.tx, l.tz, 0, dt);
		trotPose(l);
		if (res === ARRIVED) {
			l.state = EAT;
			l.t = 0;
			l.bites = 0;
			l.ate = false;
		} else if (res === BLOCKED || l.t > FETCH_TIMEOUT) {
			skip.add(f);
			returnIdle(l, 2);
		}
	}

	function updateEat(l, dt) {
		const w = l.walker;
		const f = l.fruit;
		if (f.gone && !l.ate) {
			returnIdle(l, 1);
			return;
		}
		w.turnTo(f.mesh.position.x - w.x, f.mesh.position.z - w.z, dt, EAT_TURN);
		w.stand(dt);
		const dip = sstep(0, DIP_TIME, l.t);
		l.hx = BITE_HEAD * dip;
		l.pp = EAT_PITCH * dip;
		const tb = l.t - DIP_TIME;
		const bite = Math.floor(tb / BITE_TIME);
		if (tb >= 0 && bite < BITES) {
			// each bite: the head dips and comes back; the fruit is chewed at the lowest point
			const u = tb / BITE_TIME - bite;
			l.hx = BITE_HEAD + BITE_DIP * Math.sin(u * Math.PI);
			if (u >= 0.5 && l.bites === bite) {
				if (bite < BITES - 1) {
					playMunch();
					fruit.nibble(f, NIBBLE[bite]);
				} else {
					fruit.eat(f);
					l.ate = true;
				}
				l.bites++;
			}
		}
		if (tb >= BITES * BITE_TIME) {
			dropClaim(l);
			l.state = CHEER;
			l.t = 0;
			l.landed = false;
		}
	}

	function updateCheer(l, dt) {
		const w = l.walker;
		const { gait } = w;
		w.place(dt);
		l.hx = -0.2;
		if (l.t < CHEER_ANTIC) {
			gait.sq = 1 - 0.15 * sstep(0, CHEER_ANTIC, l.t);
			return;
		}
		const a = (l.t - CHEER_ANTIC) / CHEER_AIR;
		if (a < 1) {
			if (a - dt / CHEER_AIR <= 0) playBaa();
			gait.hopY = 4 * CHEER_HOP * a * (1 - a);
			gait.sq = 1 + 0.08 * Math.sin(Math.PI * a);
			l.legTarget = 0.6;
			l.legRate = LEG_HELD_FREQ;
			return;
		}
		if (!l.landed) {
			l.landed = true;
			gait.hopY = 0;
			gait.sq = 1;
			l.sy.value = 0.86;
			l.sy.velocity = 0;
		}
		if (l.t >= CHEER_ANTIC + CHEER_AIR + CHEER_SETTLE) returnIdle(l, EAT_COOL);
	}

	// ---- poke -----------------------------------------------------------------------------

	// reactions.js already squashes and hops the sheep; startle it out of chasing / eating too
	function hookPoke(l) {
		const orig = l.s.g.userData.onPoke;
		l.s.g.userData.onPoke = (hit) => {
			if (orig) orig(hit);
			if (INTERRUPTIBLE.has(l.state)) returnIdle(l, POKE_COOL);
		};
	}

	// ---- per frame ------------------------------------------------------------------------

	function updateLife(l, dt) {
		l.cool -= dt;
		l.chaseCool -= dt;
		if (l.state === IDLE) return;
		if (!unravelIdle(l)) {
			abort(l);
			return;
		}
		if (INTERRUPTIBLE.has(l.state) && unravel.isPulled(l.s)) {
			returnIdle(l, 1.5);
			return;
		}
		l.t += dt;
		l.py = l.pp = l.pr = 0;
		l.hx = HEAD_REST;
		l.hy = 0;
		l.hz = 0;
		l.legTarget = 0;
		switch (l.state) {
			case HELD:
				updateHeld(l, dt);
				break;
			case FALLING:
				updateFalling(l, dt);
				break;
			case LANDED:
				updateLanded(l, dt);
				break;
			case HOP_AWAY:
				updateHopAway(l, dt);
				break;
			case NOTICE:
				updateNotice(l, dt);
				break;
			case CHASE:
				updateChase(l, dt);
				break;
			case NUDGE:
				updateNudge(l, dt);
				break;
			case FETCH:
				updateFetch(l, dt);
				break;
			case EAT:
				updateEat(l, dt);
				break;
			case CHEER:
				updateCheer(l, dt);
				break;
		}
		// a handler may have returned the sheep to idle: nothing to pose then
		if (l.state !== IDLE) pose(l, dt);
	}

	function update(t, dt) {
		dt = Math.min(dt, MAX_DT);
		if (dt <= 0) return;
		now = t;
		updateBallInterest();
		for (const l of lives) updateLife(l, dt);
		scanChase();
		scanFruit();
	}

	// back to the original spots is unravel's job; this only forgets every behaviour
	function reset() {
		for (const l of lives) {
			dropClaim(l);
			clearPose(l);
			l.s.busy = false;
			l.state = IDLE;
			l.token++;
			l.cool = 1;
			l.chaseCool = 0;
			for (const sp of [l.fx, l.fy, l.fz, l.swX, l.swZ]) sp.snap(0);
		}
		ballInterestUntil = 0;
		ballIgnoreUntil = 0;
		nextChaseAt = 0;
		skip = new WeakSet();
	}

	return {
		update,
		reset,
		grabbables: lives.map((l) => l.grabbable),
		// 'idle' | 'held' | 'falling' | 'landed' | 'hopAway' | 'notice' | 'chase' | 'nudge' | 'fetch' | 'eat' | 'cheer'
		stateOf: (s) => lifeOf.get(s).state,
	};
}
