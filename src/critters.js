// Critters: small life for the default scene. A lamb, five butterflies and two birds.
//
// Lamb (a makeLamb sheep, ~0.55 scale, big head). It poses its own body / head / legs every frame.
//   idle     mode rest    stays beside the mother; cycles graze / look around / tiny hops / bounce-circle
//            mode follow  mother is farther than FOLLOW_FAR: trots to a slot behind and beside her
//            mode under   mother is held: runs under her, looks up, hops
//   held     hangs from the hand, legs paddling                       (grab)
//   falling  dropped, falls with gravity                              (release)
//   landed   squash and stagger; then idle (trots back), or hopAway on bad ground
//   hopAway  hops (ignoring obstacles) to the nearest walkable spot
// Poke: squash, jump, head pop, baa.
//
// Butterflies (felt wings, flat rounded shapes with a little edge thickness):
//   flit    wanders toward a point near a flower cluster, 0.3-1.2 above the ground; a gust pushes it along the wind
//   settle  eases onto a flower, or onto the back of a calm sheep / the lamb (sometimes; one butterfly per sheep)
//   rest    slow open / close wings for a few seconds; on a sheep's back 4-8 s, riding along with it, and it
//           lifts off when the sheep is no longer calm (state change, busy, a hop) or the wind picks up
//   flee    poked: bursts up and away, then leaves the scene
//   gone    waits offscreen, then comes back in from the edge
//
// Birds (round felt robins, wings flap only in flight):
//   away    off the island, waiting for the next visit (15-25 s)
//   enter   flies in on an arc from beyond the island and lands on a pompom tree crown
//   perch   hops a little, pecks, turns its head; stays 10-20 s
//   leave   burst up, arc off the island (also right away when its tree or the bird is poked)
//
// Poke contract: butterfly and bird groups carry userData.onPoke; the lamb group (s.g) does too and also has onHover.
// Nothing here allocates per frame.
import * as THREE from 'three';
import { Spring } from './spring.js';
import { H, S } from './layout.js';
import { playBaa, playFlutter, playThump, playTweet } from './sound.js';
import { BREEZE_MAX } from './wind.js';
import { Walker, WALKING, ARRIVED, BLOCKED, WALK_SPEED, placeSheep, standHeight, clamp, sstep, wrapPi } from './sheepwalk.js';

const TAU = Math.PI * 2;
const MAX_DT = 0.05;
const rnd = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;

// --- lamb: shape and follow ---
const LAMB_SCALE = 0.55;
const LAMB_HEAD = 1.3; // head scale for baby proportions
const SLOT_BACK = 0.55; // follow slot: behind the mother ...
const SLOT_SIDE = 0.45; // ... and to her right
const FOLLOW_FAR = 1.1; // farther than this from the mother: trot after her
const FOLLOW_SPEED = 1.3; // x walk speed
const QUICK_HZ = 1.6; // extra hops per second while trotting (Gait has 3.2)
const HOP_BOOST = 1.3;
const BLOCK_FREE = 0.7; // blocked this long: hop over the obstacle
const UNDER_SPEED = 1.7;
const UNDER_NEAR = 0.45; // close enough to the held mother to look up and hop
const UNDER_HEAD = -0.65;
const BOUNCE_R = 0.8; // happy circle around the mother
const BOUNCE_W = 1.7; // rad/s around her
const BOUNCE_SPEED = 1.5;
const BOUNCE_GAP = 14; // s between circles
const HOP_T = 0.5; // one tiny hop
const HOP_H = 0.12; // lamb-local units
const HEAD_REST = -0.1;
const HEAD_RATE = 9;
const LEG_H = 0.36;
const LEG_RATE = 10;
const LEG_SPLAY = 0.2;
const LEG_TROT = 0.55;
const LEG_TROT_FREQ = 24;
const BAA_COOL = 8;
// --- lamb: lift, drop ---
const GRAVITY = 12;
const PICK_R = 0.32;
const PICK_Y = 0.5;
const HANG = 0.95 * LAMB_SCALE; // hang point (top of the back) above the hooves
const HAND_OFF = 0.12; // hang point above the hand point
const HAND_LIMIT = 0.8 * H;
const FOLLOW_K = 120;
const FOLLOW_C = 13;
const SWING_K = 70;
const SWING_C = 6;
const SWING_GAIN = 0.16;
const SWING_MAX = 0.6;
const SWING_IDLE = 0.05;
const HELD_PITCH = 0.1;
const STRETCH_GAIN = 0.03;
const STRETCH_MAX = 0.12;
const LIFT_POP = 1.15;
const LEG_HELD = 0.8;
const LEG_HELD_FREQ = 16;
const LEG_FALL = 0.9;
const RELEASE_KEEP = 0.5;
const RELEASE_MAX = 3;
const LAND_TIME = 0.8;
const LAND_SQUASH = 0.05;
const LAND_SQUASH_MIN = 0.55;
const LAND_SQUASH_MAX = 0.85;
const SHAKE_FREQ = 28;
const SHAKE_DECAY = 4.5;
const SHAKE_ROLL = 0.14;
const SHAKE_HEAD = 0.5;
const HOP_AWAY_SPEED = 1.3;
const HOP_AWAY_TIMEOUT = 5;
const SPOT_GAP = 0.5;
const SPOT_MARGIN = 0.12;
const POKE_VY = 3.2;
const POKE_G = 14;
const HOVER_SCALE = 1.06;

// --- butterflies ---
const BF_COUNT = 5;
const BF_SPEED = 0.8;
const BF_REST_CHANCE = 0.45;
const BF_REST_H = 0.27; // above the ground, among the flower heads
const FLAP_HZ = 5.2;
const FLAP_MID = 0.3;
const FLAP_AMP = 0.85;
const REST_MID = 0.95;
const REST_AMP = 0.45;
const REST_RATE = 2.0; // rad/s, slow open and close
const GUST_MIN = BREEZE_MAX + 0.1; // wind strength where the breeze ends and a gust begins
const REST_WIND_MAX = BREEZE_MAX + 0.6; // a resting butterfly lifts off above this
const GUST_PUSH = 1.2; // units/s per unit of gust strength
const FLEE_SPEED = 3.4;
const FLEE_RISE = 4.2;
const GONE_MIN = 8;
const GONE_MAX = 14;
const WING_T = 0.008;
const BACK_CHANCE = 0.3; // chance that the next target is a sheep's back
const BACK_LIFT = 0.04; // above the wool top (the fuzz sticks out)
const BACK_Z = [-0.22, 0]; // sheep-local z range of the landing spot, toward the rump
const BACK_REST = [4, 8];
const BACK_HOP = 0.06; // body height that counts as a hop under the butterfly
const BACK_HOP_STAY = 0.5; // chance to stay on through a hop (adult sheep; the lamb's little hops never shake it off)
const BACK_WIND_MAX = BREEZE_MAX + 0.9; // holds on to the wool through most gusts
const BACK_FACE = 0.5; // random offset from the sheep's heading, rad
const BACK_BURST = 0.6; // extra height when lifting off a back

const BF_EDGE_R = S(9); // return from this far out

// --- birds ---
const BIRD_COUNT = 2;
const BIRD_SCALE = 1.3;
const BIRD_SPEED = 3.2; // average units/s along the arc
const FLY_R = S(13); // distance of the off-island start / end points
const PERCH_SINK = 0.03;
const PERCH_R = 0.16; // hop range around the crown top
const STAY_MIN = 10;
const STAY_MAX = 20;
const VISIT_MIN = 15;
const VISIT_MAX = 25;
const FIRST_VISIT = [6, 14]; // first visit of each bird, s
const FOLD = -1.3; // folded wing angle

const IDLE = 'idle';
const HELD = 'held';
const FALLING = 'falling';
const LANDED = 'landed';
const HOP_AWAY = 'hopAway';
const REST = 0;
const FOLLOW = 1;
const UNDER = 2;
const GRAZE = 'graze';
const LOOK = 'look';
const HOPS = 'hops';
const BOUNCE = 'bounce';

const FLIT = 'flit';
const SETTLE = 'settle';
const BREST = 'rest';
const FLEE = 'flee';
const GONE = 'gone';

const AWAY = 'away';
const ENTER = 'enter';
const PERCH = 'perch';
const LEAVE = 'leave';
const B_IDLE = 'idle';
const B_HOP = 'hop';
const B_PECK = 'peck';
const B_LOOK = 'look';
const B_WAG = 'wag';

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();
const _pt = { x: 0, z: 0 };

// Give every leg its own pivot at the hip so it can swing (same rig as sheeplife.js).
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

export function setupCritters({ root, kit, terrain, wind, sheep, sheepState, makeLamb, trees, flowerBases }) {
	const { groundAt, walkable } = terrain;
	const P = kit.P;
	const mom = sheep[0];
	let now = 0;

	// =====================================================================================
	// Lamb
	// =====================================================================================

	// follow slot of the mother: behind her and to her right
	function slotOf(mx, mz, yaw, back, side) {
		const fx = Math.sin(yaw);
		const fz = Math.cos(yaw);
		_pt.x = mx - fx * back + fz * side;
		_pt.z = mz - fz * back - fx * side;
		return _pt;
	}

	let startX = mom.g.position.x + 0.6;
	let startZ = mom.g.position.z;
	const myaw0 = mom.g.rotation.y;
	for (const [bk, sd] of [[SLOT_BACK, SLOT_SIDE], [SLOT_BACK, -SLOT_SIDE], [0.7, 0], [0, 0.7], [0, -0.7], [-0.7, 0]]) {
		slotOf(mom.g.position.x, mom.g.position.z, myaw0, bk, sd);
		if (walkable(_pt.x, _pt.z)) {
			startX = _pt.x;
			startZ = _pt.z;
			break;
		}
	}

	const s = makeLamb({ x: startX, z: startZ, yaw: myaw0, phase: 0.3, hopPeriod: 7, scale: LAMB_SCALE });
	s.head.scale.setScalar(LAMB_HEAD);

	const L = {
		s,
		w: new Walker(s, { groundAt, walkable }),
		legs: rigLegs(s),
		home: { x: s.g.position.x, z: s.g.position.z, yaw: s.yaw },
		state: IDLE,
		mode: REST,
		t: 0,
		token: 0,
		free: false, // walk ignoring obstacles (hop over a blocker)
		blockT: 0,
		// activity while resting
		act: null,
		last: null,
		actT: 0,
		actDur: 0,
		nextBounce: 0,
		lookT: 0,
		lookHy: 0,
		lookHx: 0,
		yawGoal: s.yaw,
		ba: 0,
		bdir: 1,
		cheerCool: 0,
		nextBaa: 0,
		// springs
		sy: new Spring(260, 12, 1), // body squash / stretch
		jy: new Spring(260, 12, 1), // poke squash on the react group
		jxz: new Spring(260, 12, 1),
		jh: new Spring(180, 16, 1), // hover inflate
		headRot: new Spring(160, 9),
		headScale: new Spring(200, 11, 1),
		fx: new Spring(FOLLOW_K, FOLLOW_C),
		fy: new Spring(FOLLOW_K, FOLLOW_C),
		fz: new Spring(FOLLOW_K, FOLLOW_C),
		swX: new Spring(SWING_K, SWING_C),
		swZ: new Spring(SWING_K, SWING_C),
		hopY: 0, // poke jump above the react group origin
		hopVy: 0,
		hopAir: false,
		// held / falling
		handX: 0,
		handY: 0,
		handZ: 0,
		vx: 0,
		vy: 0,
		vz: 0,
		h: 0,
		yawTarget: 0,
		tx: 0,
		tz: 0,
		valid: true,
		// per-frame pose requests
		py: 0,
		pp: 0,
		pr: 0,
		hx: HEAD_REST,
		hy: 0,
		hz: 0,
		ex: 0, // extra body hop
		sq: 1, // extra squash
		wig: 0, // yaw wiggle
		legTarget: 0,
		legRate: LEG_TROT_FREQ,
		legAmp: 0,
		legPhase: 0,
	};

	function spotOk(x, z) {
		if (!walkable(x, z) || !walkable(x + SPOT_MARGIN, z) || !walkable(x - SPOT_MARGIN, z)) return false;
		if (!walkable(x, z + SPOT_MARGIN) || !walkable(x, z - SPOT_MARGIN)) return false;
		for (let i = 0; i < sheep.length; i++) {
			const p = sheep[i].g.position;
			if (Math.hypot(x - p.x, z - p.z) < SPOT_GAP) return false;
		}
		return true;
	}

	// nearest free walkable spot to (x, z): rings outward, starting toward the island center
	function findSpot(x, z) {
		const a0 = Math.atan2(-x, -z);
		for (let r = 0.25; r <= S(4.5); r += 0.25) {
			const n = Math.max(8, Math.ceil(r * 14));
			for (let i = 0; i < n; i++) {
				const a = a0 + (i / n) * TAU;
				const px = x + Math.sin(a) * r;
				const pz = z + Math.cos(a) * r;
				if (spotOk(px, pz)) {
					_pt.x = px;
					_pt.z = pz;
					return _pt;
				}
			}
		}
		return slotOf(mom.g.position.x, mom.g.position.z, mom.g.rotation.y, SLOT_BACK, SLOT_SIDE);
	}

	function lambBaa() {
		if (now < L.nextBaa) return;
		L.nextBaa = now + BAA_COOL;
		playBaa();
	}

	// ---- walking ---------------------------------------------------------------------------

	// trot toward (tx, tz); sets the trot pose requests while moving
	function walkTo(tx, tz, stop, dt, mul) {
		const { w } = L;
		const res = w.walk(tx, tz, stop, dt, L.free, mul);
		if (res === WALKING) {
			const amp = clamp(w.speed / WALK_SPEED, 0, 1);
			w.gait.phase += Math.PI * QUICK_HZ * dt * amp;
			L.hx = w.headBob;
			L.legTarget = LEG_TROT * amp;
			L.legRate = LEG_TROT_FREQ;
			L.blockT = 0;
		} else if (res === BLOCKED) {
			L.blockT += dt;
			if (L.blockT > BLOCK_FREE) L.free = true;
		} else {
			L.free = false;
		}
		return res;
	}

	// ---- idle: rest / follow / under -------------------------------------------------------

	function startAct(kind, mx, mz) {
		const { w } = L;
		L.act = kind;
		L.last = kind;
		L.actT = 0;
		switch (kind) {
			case GRAZE:
				L.actDur = rnd(3, 6);
				break;
			case LOOK:
				L.actDur = rnd(3, 5);
				L.lookT = 0;
				L.yawGoal = L.s.yaw;
				break;
			case HOPS:
				L.actDur = (2 + Math.floor(Math.random() * 3)) * HOP_T;
				break;
			case BOUNCE:
				L.actDur = rnd(2.6, 3.6);
				L.ba = Math.atan2(w.x - mx, w.z - mz);
				L.bdir = Math.random() < 0.5 ? -1 : 1;
				L.nextBounce = now + BOUNCE_GAP;
				L.free = false;
				L.blockT = 0;
				w.begin();
				if (Math.random() < 0.4) lambBaa();
				break;
		}
	}

	function pickAct(mx, mz) {
		const wg = L.last === GRAZE ? 0 : 3;
		const wh = L.last === HOPS ? 0 : 3;
		const wl = L.last === LOOK ? 0 : 2;
		const wb = now >= L.nextBounce && L.last !== BOUNCE ? 1.2 : 0;
		let r = Math.random() * (wg + wh + wl + wb);
		if ((r -= wg) < 0) startAct(GRAZE, mx, mz);
		else if ((r -= wh) < 0) startAct(HOPS, mx, mz);
		else if ((r -= wl) < 0) startAct(LOOK, mx, mz);
		else if (wb > 0) startAct(BOUNCE, mx, mz);
		else startAct(GRAZE, mx, mz);
	}

	function updateRest(dt, mx, mz, ms) {
		const { w } = L;
		if (L.cheerCool > 0) L.cheerCool -= dt;
		if (ms === 'cheer' && L.cheerCool <= 0) {
			L.cheerCool = 3;
			startAct(HOPS, mx, mz);
			L.actDur = 3 * HOP_T;
		}
		if (L.act === null) pickAct(mx, mz);
		L.actT += dt;
		const u = L.actT;
		switch (L.act) {
			case GRAZE: {
				w.stand(dt);
				const dip = sstep(0, 0.7, u) * (1 - sstep(L.actDur - 0.7, L.actDur, u));
				L.hx = HEAD_REST + 1.0 * dip + 0.07 * Math.sin(u * 5.5) * dip;
				L.pp = 0.06 * dip;
				break;
			}
			case LOOK: {
				L.lookT -= dt;
				if (L.lookT <= 0) {
					L.lookT = rnd(0.9, 1.6);
					L.lookHy = rnd(-1, 1);
					L.lookHx = rnd(-0.3, 0.05);
					if (Math.random() < 0.5) L.yawGoal = L.s.yaw + rnd(-1.2, 1.2);
				}
				w.turnTo(Math.sin(L.yawGoal), Math.cos(L.yawGoal), dt, 3);
				w.stand(dt);
				L.hy = L.lookHy;
				L.hx = HEAD_REST + L.lookHx;
				L.hz = 0.12 * L.lookHy;
				break;
			}
			case HOPS: {
				w.stand(dt);
				const f = (u % HOP_T) / HOP_T;
				const arc = Math.sin(Math.PI * f);
				L.ex = HOP_H * arc;
				L.sq = 1 - 0.07 * Math.pow(1 - arc, 6);
				L.pp = -0.1 * Math.cos(Math.PI * f);
				L.hx = HEAD_REST - 0.25 * arc;
				L.legTarget = 0.35 * arc;
				L.legRate = 20;
				break;
			}
			case BOUNCE: {
				const a = L.ba + L.bdir * (BOUNCE_W * u + 0.5);
				walkTo(mx + Math.sin(a) * BOUNCE_R, mz + Math.cos(a) * BOUNCE_R, 0, dt, BOUNCE_SPEED);
				if (L.blockT > 0.25) {
					L.free = false;
					L.actT = L.actDur;
				}
				break;
			}
		}
		if (L.actT >= L.actDur) L.act = null;
	}

	function updateIdle(dt) {
		const { w } = L;
		const m = mom.g.position;
		const mx = m.x;
		const mz = m.z;
		const myaw = mom.g.rotation.y;
		const ms = sheepState(mom);
		const dist = Math.hypot(mx - w.x, mz - w.z);

		let mode = L.mode;
		if (ms === 'held') mode = UNDER;
		else if (mode === UNDER) mode = FOLLOW;
		else if (mode === REST && dist > FOLLOW_FAR) mode = FOLLOW;
		if (mode !== L.mode) {
			L.mode = mode;
			L.free = false;
			L.blockT = 0;
			L.act = null;
			w.begin();
		}

		if (mode === UNDER) {
			if (dist > 0.2) walkTo(mx, mz, 0.15, dt, UNDER_SPEED);
			else w.stand(dt);
			L.hx = UNDER_HEAD;
			if (dist < UNDER_NEAR) {
				L.ex = 0.12 * Math.abs(Math.sin(L.t * 9));
				L.sq = 1 - 0.05 * Math.pow(1 - Math.abs(Math.sin(L.t * 9)), 6);
				L.legTarget = 0.6;
				L.legRate = 20;
				L.wig = 0.4 * Math.sin(L.t * 4);
			}
			return;
		}
		if (mode === FOLLOW) {
			slotOf(mx, mz, myaw, SLOT_BACK, SLOT_SIDE);
			const mul = FOLLOW_SPEED + clamp((dist - 1.6) * 0.25, 0, 0.5);
			const res = walkTo(_pt.x, _pt.z, 0.12, dt, mul);
			if (res === ARRIVED || (res === BLOCKED && dist < FOLLOW_FAR)) {
				L.mode = REST;
				L.free = false;
				L.act = null;
			}
			return;
		}
		updateRest(dt, mx, mz, ms);
	}

	// ---- lift: pick, hold, drop ------------------------------------------------------------

	const lambGrabbable = {
		pick(ray) {
			if (L.state !== IDLE) return null;
			_c.set(0, PICK_Y, 0).applyMatrix4(L.s.body.matrixWorld);
			_v.subVectors(_c, ray.origin);
			const tca = _v.dot(ray.direction);
			const d2 = _v.lengthSq() - tca * tca;
			if (d2 > PICK_R * PICK_R) return null;
			const t = tca - Math.sqrt(PICK_R * PICK_R - d2);
			return { distance: Math.max(0, t) + 0.1 };
		},
		grab() {
			const noop = { move() {}, release() {} };
			if (L.state !== IDLE) return noop;
			const token = startHeld();
			return {
				move(target) {
					if (L.token === token && L.state === HELD) setHand(target);
				},
				release() {
					if (L.token === token && L.state === HELD) startFall();
				},
			};
		},
	};

	// zero what idle posing leaves behind
	function clearPose() {
		const { s: sh } = L;
		sh.body.position.set(0, 0, 0);
		sh.body.rotation.set(0, 0, 0);
		sh.body.scale.set(1, 1, 1);
		sh.head.rotation.set(HEAD_REST, 0, 0);
		for (const leg of L.legs) leg.pivot.rotation.set(0, 0, 0);
		L.legAmp = 0;
		L.w.gait.reset();
		L.sy.snap(1);
	}

	function startHeld() {
		const { s: sh, w } = L;
		L.state = HELD;
		L.t = 0;
		L.act = null;
		const token = ++L.token;
		w.gait.reset();
		const p = sh.g.position;
		L.handX = p.x;
		L.handZ = p.z;
		L.handY = p.y - HAND_OFF + HANG - 0.35;
		L.fx.snap(p.x);
		L.fy.snap(p.y + HANG);
		L.fz.snap(p.z);
		L.fx.target = p.x;
		L.fy.target = p.y + HANG;
		L.fz.target = p.z;
		L.swX.snap(sh.pitch);
		L.swZ.snap(sh.roll);
		L.sy.value = LIFT_POP;
		L.sy.velocity = 0;
		L.legPhase = 0;
		L.nextBaa = now + rnd(2, 4);
		playBaa();
		return token;
	}

	// hand target from poke.js: ground point under the cursor + 0.35
	function setHand(target) {
		L.handX = clamp(target.x, -HAND_LIMIT, HAND_LIMIT);
		L.handZ = clamp(target.z, -HAND_LIMIT, HAND_LIMIT);
		const gy = groundAt(L.handX, L.handZ);
		L.handY = Math.max(target.y, gy + 0.35);
		L.fx.target = L.handX;
		L.fy.target = Math.max(L.handY + HAND_OFF, gy + HANG + 0.03);
		L.fz.target = L.handZ;
	}

	function updateHeld(dt) {
		const { s: sh, w } = L;
		L.fx.update(dt);
		L.fy.update(dt);
		L.fz.update(dt);
		const vx = L.fx.velocity;
		const vy = L.fy.velocity;
		const vz = L.fz.velocity;
		const speed = Math.hypot(vx, vy, vz);
		const sn = Math.sin(sh.yaw);
		const cs = Math.cos(sh.yaw);
		L.swX.target = clamp((vx * sn + vz * cs) * SWING_GAIN, -SWING_MAX, SWING_MAX) + SWING_IDLE * Math.sin(now * 1.7);
		L.swZ.target = clamp(-(vx * cs - vz * sn) * SWING_GAIN, -SWING_MAX, SWING_MAX) + SWING_IDLE * Math.sin(now * 1.3 + 1);
		const ax = L.swX.update(dt);
		const az = L.swZ.update(dt);
		const yaw = sh.yaw + 0.18 * Math.sin(now * 1.9);
		_e.set(ax, yaw, az, 'YXZ');
		_q.setFromEuler(_e);
		_v.set(0, HANG, 0).applyQuaternion(_q);
		sh.g.position.set(L.fx.value - _v.x, L.fy.value - _v.y, L.fz.value - _v.z);
		sh.g.rotation.set(ax, yaw, az);
		w.setPos(sh.g.position.x, sh.g.position.z);

		L.sy.target = 1 + clamp(speed * STRETCH_GAIN, 0, STRETCH_MAX);
		L.pp = HELD_PITCH;
		L.pr = 0.04 * Math.sin(now * 6.5) * Math.min(1, speed);
		L.legTarget = LEG_HELD * (0.85 + 0.3 * Math.min(1, speed / 3));
		L.legRate = LEG_HELD_FREQ;
		L.hx = -0.3 + 0.25 * Math.sin(now * 2.3);
		L.hy = 0.7 * Math.sin(now * 1.4);
		L.hz = 0.2 * Math.sin(now * 1.1);
		if (now >= L.nextBaa) {
			playBaa();
			L.nextBaa = now + rnd(2, 4);
		}
	}

	function startFall() {
		const { s: sh, w } = L;
		w.setPos(sh.g.position.x, sh.g.position.z);
		L.vx = clamp(L.fx.velocity * RELEASE_KEEP, -RELEASE_MAX, RELEASE_MAX);
		L.vz = clamp(L.fz.velocity * RELEASE_KEEP, -RELEASE_MAX, RELEASE_MAX);
		L.vy = clamp(L.fy.velocity * RELEASE_KEEP, -1, RELEASE_MAX);
		sh.pitch = sh.g.rotation.x;
		sh.roll = sh.g.rotation.z;
		L.h = Math.max(0, sh.g.position.y - standHeight(w.x, w.z, sh.yaw, groundAt));
		L.sy.target = 1;
		L.state = FALLING;
		L.t = 0;
		L.token++;
	}

	function updateFalling(dt) {
		const { s: sh, w } = L;
		L.vy -= GRAVITY * dt;
		L.h += L.vy * dt;
		w.x += L.vx * dt;
		w.z += L.vz * dt;
		const damp = Math.exp(-0.8 * dt);
		L.vx *= damp;
		L.vz *= damp;
		if (Math.abs(w.x) > HAND_LIMIT) {
			w.x = clamp(w.x, -HAND_LIMIT, HAND_LIMIT);
			L.vx = 0;
		}
		if (Math.abs(w.z) > HAND_LIMIT) {
			w.z = clamp(w.z, -HAND_LIMIT, HAND_LIMIT);
			L.vz = 0;
		}
		if (L.h <= 0 && L.vy < 0) {
			land(-L.vy);
			return;
		}
		placeSheep(sh, w.x, w.z, groundAt, dt, L.h);
		L.legTarget = LEG_FALL;
		L.legRate = LEG_HELD_FREQ * 1.4;
		L.hx = -0.4;
		L.hy = 0.5 * Math.sin(L.t * 9);
		L.sy.target = 1.05;
	}

	function land(impact) {
		const { s: sh, w } = L;
		L.h = 0;
		L.vy = 0;
		L.state = LANDED;
		L.t = 0;
		L.sy.target = 1;
		L.sy.value = clamp(1 - impact * LAND_SQUASH, LAND_SQUASH_MIN, LAND_SQUASH_MAX);
		L.sy.velocity = 0;
		L.yawTarget = rnd(0, TAU);
		L.valid = spotOk(w.x, w.z) || walkable(w.x, w.z);
		placeSheep(sh, w.x, w.z, groundAt, 0);
		playThump({ pitch: 1.2 }); // lighter lamb
	}

	function backToIdle() {
		L.state = IDLE;
		L.t = 0;
		L.mode = REST; // follow takes over at once when the mother is far
		L.act = null;
		L.free = false;
		L.blockT = 0;
		L.w.begin();
	}

	function updateLanded(dt) {
		const { w } = L;
		const env = Math.exp(-L.t * SHAKE_DECAY);
		const shake = Math.sin(L.t * SHAKE_FREQ) * env;
		L.pr = shake * SHAKE_ROLL;
		L.hy = shake * SHAKE_HEAD;
		L.hx = 0.35 * env;
		if (L.valid) w.turnTo(Math.sin(L.yawTarget), Math.cos(L.yawTarget), dt, 3);
		w.stand(dt);
		if (L.t < LAND_TIME) return;
		if (L.valid) {
			backToIdle();
			return;
		}
		const p = findSpot(w.x, w.z);
		L.tx = p.x;
		L.tz = p.z;
		L.state = HOP_AWAY;
		L.t = 0;
		L.free = true;
		w.begin();
	}

	function updateHopAway(dt) {
		const res = walkTo(L.tx, L.tz, 0, dt, HOP_AWAY_SPEED);
		if (res !== WALKING || L.t > HOP_AWAY_TIMEOUT) backToIdle();
	}

	// ---- poke ------------------------------------------------------------------------------

	s.g.userData.onPoke = () => {
		L.jy.value = 0.75;
		L.jy.velocity = 0;
		L.jxz.value = 1.15;
		L.jxz.velocity = 0;
		L.hopVy = POKE_VY;
		L.hopAir = true;
		L.headRot.value = -0.55;
		L.headRot.velocity = 0;
		L.headScale.value = 1.25;
		L.headScale.velocity = 0;
		L.nextBaa = now + 1;
		playBaa();
	};
	s.g.userData.onHover = (on) => {
		L.jh.target = on ? HOVER_SCALE : 1;
	};

	// ---- pose ------------------------------------------------------------------------------

	function poseLamb(dt) {
		const { s: sh, w } = L;
		const { gait } = w;
		const sy = L.sy.update(dt) * gait.sq * L.sq;
		const xz = 1 + (1 - sy) * 0.5;
		sh.body.position.y = gait.hopY * HOP_BOOST + L.py + L.ex;
		sh.body.rotation.set(gait.pitch + L.pp, 0, gait.roll + L.pr);
		sh.body.scale.set(xz, sy, xz);

		const k = 1 - Math.exp(-HEAD_RATE * dt);
		const head = sh.head;
		head.rotation.x += (L.hx - head.rotation.x) * k;
		head.rotation.y += (L.hy - head.rotation.y) * k;
		head.rotation.z += (L.hz - head.rotation.z) * k;

		const lk = 1 - Math.exp(-LEG_RATE * dt);
		L.legAmp += (L.legTarget - L.legAmp) * lk;
		L.legPhase += dt * L.legRate;
		const legs = L.legs;
		if (L.legAmp < 1e-3 && L.legTarget === 0) {
			L.legAmp = 0;
			for (let i = 0; i < legs.length; i++) legs[i].pivot.rotation.set(0, 0, 0);
		} else {
			for (let i = 0; i < legs.length; i++) {
				const leg = legs[i];
				leg.pivot.rotation.x = L.legAmp * Math.sin(L.legPhase + leg.off);
				leg.pivot.rotation.z = LEG_SPLAY * L.legAmp * leg.sx;
			}
		}

		// poke: squash springs and jump on the react group, head pop on the neck pivot
		if (L.hopAir) {
			L.hopVy -= POKE_G * dt;
			L.hopY += L.hopVy * dt;
			if (L.hopY <= 0 && L.hopVy < 0) {
				L.hopY = 0;
				L.hopVy = 0;
				L.hopAir = false;
				L.jy.value = 0.88;
				L.jy.velocity = 0;
				L.jxz.value = 1.07;
				L.jxz.velocity = 0;
			}
		}
		const jy = L.jy.update(dt);
		const jxz = L.jxz.update(dt);
		const jh = L.jh.update(dt);
		sh.react.scale.set(jxz * jh, jy * jh, jxz * jh);
		sh.react.position.y = L.hopY;
		sh.headPop.rotation.x = L.headRot.update(dt);
		sh.headPop.scale.setScalar(L.headScale.update(dt));
		if (L.wig !== 0) sh.g.rotation.y = sh.yaw + L.wig;
	}

	function updateLamb(dt) {
		L.t += dt;
		L.py = L.pp = L.pr = 0;
		L.hx = HEAD_REST;
		L.hy = 0;
		L.hz = 0;
		L.ex = 0;
		L.sq = 1;
		L.wig = 0;
		L.legTarget = 0;
		switch (L.state) {
			case IDLE:
				updateIdle(dt);
				break;
			case HELD:
				updateHeld(dt);
				break;
			case FALLING:
				updateFalling(dt);
				break;
			case LANDED:
				updateLanded(dt);
				break;
			case HOP_AWAY:
				updateHopAway(dt);
				break;
		}
		poseLamb(dt);
	}

	function resetLamb() {
		const { s: sh, w } = L;
		L.state = IDLE;
		L.mode = REST;
		L.token++;
		L.t = 0;
		L.act = null;
		L.last = null;
		L.free = false;
		L.blockT = 0;
		L.nextBounce = 0;
		L.nextBaa = 0;
		L.cheerCool = 0;
		L.hopY = 0;
		L.hopVy = 0;
		L.hopAir = false;
		L.legPhase = 0;
		for (const sp of [L.fx, L.fy, L.fz, L.swX, L.swZ, L.headRot]) sp.snap(0);
		L.jy.snap(1);
		L.jxz.snap(1);
		L.jh.snap(1);
		L.headScale.snap(1);
		sh.yaw = L.home.yaw;
		L.yawGoal = sh.yaw;
		sh.pitch = 0;
		sh.roll = 0;
		w.setPos(L.home.x, L.home.z);
		w.begin();
		clearPose();
		placeSheep(sh, L.home.x, L.home.z, groundAt, 0);
		sh.react.scale.set(1, 1, 1);
		sh.react.position.y = 0;
		sh.headPop.scale.setScalar(1);
		sh.headPop.rotation.x = 0;
	}

	// =====================================================================================
	// Butterflies
	// =====================================================================================

	const bfWingMats = [P.coral, P.lavender, P.mustard, P.sky, P.terracotta].map(
		(color) => new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 }),
	);
	const bfDotMat = new THREE.MeshStandardMaterial({ color: P.cream, roughness: 1, metalness: 0 });
	const bfBodyMat = new THREE.MeshStandardMaterial({ color: P.charcoal, roughness: 0.8, metalness: 0 });
	const hitMat = new THREE.MeshBasicMaterial({ visible: false });

	// flat wing shape: hinge at the origin, wing out along +x, front toward +z, thickness around y = 0
	function wingGeo(cx, cy, rx, ry, rot) {
		const shape = new THREE.Shape();
		shape.absellipse(cx, cy, rx, ry, 0, TAU, false, rot);
		const g = new THREE.ExtrudeGeometry(shape, { depth: WING_T, bevelEnabled: false, curveSegments: 14 });
		g.rotateX(Math.PI / 2);
		g.translate(0, WING_T / 2, 0);
		return g;
	}
	const foreGeo = kit.cachedGeo('bfFore', () => wingGeo(0.07, 0.045, 0.07, 0.058, 0.4));
	const hindGeo = kit.cachedGeo('bfHind', () => wingGeo(0.05, -0.04, 0.05, 0.042, -0.5));
	const dotGeo = kit.cachedGeo('bfDot', () => new THREE.CylinderGeometry(0.016, 0.016, 0.003, 12));
	const bodyGeo = kit.cachedGeo('bfBody', () => {
		const g = new THREE.CapsuleGeometry(0.011, 0.06, 4, 8);
		g.rotateX(Math.PI / 2);
		return g;
	});
	const antGeo = kit.cachedGeo('bfAnt', () => new THREE.CylinderGeometry(0.0015, 0.0015, 0.045, 4));

	function makeButterfly(i) {
		const g = new THREE.Group();
		g.rotation.order = 'YXZ';
		const wingMat = bfWingMats[i % bfWingMats.length];
		kit.add(g, new THREE.Mesh(bodyGeo, bfBodyMat));
		kit.sphere(g, 0.014, bfBodyMat, 0, 0, 0.042);
		for (const sx of [-1, 1]) {
			const a = 1.05;
			const ant = new THREE.Mesh(antGeo, bfBodyMat);
			ant.position.set(sx * 0.012, 0.008 + Math.cos(a) * 0.0225, 0.05 + Math.sin(a) * 0.0225);
			ant.rotation.set(a, 0, -sx * 0.3);
			g.add(ant);
		}
		const wings = [];
		for (const side of [1, -1]) {
			const hinge = new THREE.Group();
			hinge.position.x = side * 0.012;
			if (side < 0) hinge.scale.x = -1;
			kit.add(hinge, new THREE.Mesh(foreGeo, wingMat));
			const hind = kit.add(hinge, new THREE.Mesh(hindGeo, wingMat));
			hind.position.y = -0.003;
			const dot = new THREE.Mesh(dotGeo, bfDotMat);
			dot.position.set(0.078, WING_T / 2 + 0.0012, 0.05);
			hinge.add(dot);
			g.add(hinge);
			wings.push(hinge);
		}
		g.add(new THREE.Mesh(kit.sphereGeo(0.14), hitMat)); // bigger target for the poke ray
		root.add(g);
		return {
			g,
			wr: wings[0],
			wl: wings[1],
			state: FLIT,
			t: 0,
			x: 0,
			y: 0,
			z: 0,
			hdg: 0,
			pitch: 0,
			roll: 0,
			vy: 0,
			turn: 0,
			tx: 0,
			ty: 0,
			tz: 0,
			flower: 0,
			restNext: false,
			restFor: 0,
			restW: 0,
			fa: Math.random() * TAU,
			ph: (i / BF_COUNT) * TAU + 0.7,
			gustK: 0,
			pt: null, // perch (sheep back) this butterfly is heading for or sitting on
			pz: 0, // landing z on that back
			pyaw: 0,
			hopSeen: false,
			lift: 0,
			fleeH: 0,
			wait: 0,
		};
	}

	const butterflies = [];
	for (let i = 0; i < BF_COUNT; i++) butterflies.push(makeButterfly(i));

	// sheep backs: one perch per sheep and the lamb; the wool spheres give the top height at a given z
	const perches = [...sheep.map((rig) => ({ rig, lamb: false })), { rig: s, lamb: true }];
	for (const p of perches) {
		p.who = null;
		p.cy = [];
		p.cz = [];
		p.cr = [];
		for (const m of p.rig.wool) {
			p.cy.push(m.position.y);
			p.cz.push(m.position.z);
			p.cr.push(m.geometry.parameters.radius);
		}
	}
	const pcand = new Int8Array(perches.length);
	const _bp = new THREE.Vector3();

	function calm(p) {
		if (p.lamb) return L.state === IDLE && L.mode === REST && L.act !== BOUNCE;
		return !p.rig.busy && sheepState(p.rig) === IDLE;
	}

	// world point on the wool top at sheep-local z, following the body pose
	function backPoint(p, z, out) {
		let y = 0;
		for (let i = 0; i < p.cy.length; i++) {
			const dz = z - p.cz[i];
			const r = p.cr[i];
			if (Math.abs(dz) < r) y = Math.max(y, p.cy[i] + Math.sqrt(r * r - dz * dz));
		}
		p.rig.body.updateWorldMatrix(true, false);
		return p.rig.body.localToWorld(out.set(0, y + BACK_LIFT, z));
	}

	function releasePerch(b) {
		if (b.pt && b.pt.who === b) b.pt.who = null;
		b.pt = null;
	}

	// retarget to the current back point; false once the sheep is no longer calm
	function followBack(b) {
		if (!calm(b.pt)) return false;
		backPoint(b.pt, b.pz, _bp);
		b.tx = _bp.x;
		b.ty = _bp.y;
		b.tz = _bp.z;
		return true;
	}

	// back to flitting toward a flower, with a little upward burst
	function leaveBack(b) {
		b.state = FLIT;
		b.t = 0;
		pickTarget(b, false);
		b.restNext = false;
		b.lift = BACK_BURST;
	}

	function pickTarget(b, perch = true) {
		releasePerch(b);
		if (perch && Math.random() < BACK_CHANCE) {
			let n = 0;
			for (let i = 0; i < perches.length; i++) if (!perches[i].who && calm(perches[i])) pcand[n++] = i;
			if (n > 0) {
				const p = perches[pcand[Math.floor(Math.random() * n)]];
				p.who = b;
				b.pt = p;
				b.pz = rnd(BACK_Z[0], BACK_Z[1]);
				b.pyaw = rnd(-BACK_FACE, BACK_FACE);
				b.hopSeen = false;
				b.restNext = true;
				followBack(b);
				return;
			}
		}
		const n = flowerBases.length;
		b.flower = (b.flower + 1 + Math.floor(Math.random() * Math.max(1, n - 1))) % n;
		const fl = flowerBases[b.flower];
		b.restNext = Math.random() < BF_REST_CHANCE;
		if (b.restNext) {
			b.tx = fl.x + rnd(-0.4, 0.4);
			b.tz = fl.z + rnd(-0.4, 0.4);
			b.ty = groundAt(b.tx, b.tz) + BF_REST_H;
		} else {
			b.tx = fl.x + rnd(-1, 1);
			b.tz = fl.z + rnd(-1, 1);
			b.ty = groundAt(b.tx, b.tz) + rnd(0.3, 1.2);
		}
	}

	function startButterfly(b, i) {
		const fl = flowerBases[(i * 2) % flowerBases.length];
		b.flower = (i * 2) % flowerBases.length;
		b.x = fl.x + rnd(-0.7, 0.7);
		b.z = fl.z + rnd(-0.7, 0.7);
		b.y = groundAt(b.x, b.z) + rnd(0.5, 0.9);
		b.hdg = rnd(0, TAU);
		b.state = FLIT;
		b.t = 0;
		b.pitch = b.roll = b.vy = b.turn = b.restW = b.gustK = b.lift = 0;
		b.g.visible = true;
		pickTarget(b, false);
		b.restNext = false;
	}

	function scare(b) {
		if (b.state === FLEE || b.state === GONE) return;
		playFlutter();
		releasePerch(b);
		b.lift = 0;
		b.state = FLEE;
		b.t = 0;
		b.fleeH = (Math.hypot(b.x, b.z) < 0.5 ? rnd(0, TAU) : Math.atan2(b.x, b.z)) + rnd(-0.6, 0.6);
	}
	butterflies.forEach((b) => {
		b.g.userData.onPoke = () => scare(b);
	});

	// turn toward the sheep's heading plus the butterfly's own offset
	function faceSheep(b, dt, rate) {
		b.hdg += wrapPi(b.pt.rig.g.rotation.y + b.pyaw - b.hdg) * (1 - Math.exp(-rate * dt));
	}

	function updateButterfly(b, dt) {
		const t = now;
		switch (b.state) {
			case FLIT: {
				if (b.pt && !followBack(b)) pickTarget(b, false);
				const dx = b.tx - b.x;
				const dz = b.tz - b.z;
				const d = Math.hypot(dx, dz);
				const wob = (0.9 * Math.sin(t * 1.9 + b.ph) + 0.5 * Math.sin(t * 3.1 + b.ph * 2.3)) * clamp(d / 1.2, 0.12, 1);
				const diff = wrapPi(Math.atan2(dx, dz) + wob - b.hdg);
				b.hdg += diff * (1 - Math.exp(-2.4 * dt));
				b.turn = diff;
				let v = BF_SPEED * (0.75 + 0.25 * Math.sin(t * 2.3 + b.ph));
				v *= 1 + clamp((d - 2) * 0.35, 0, 1.2); // hurry when far
				v *= clamp(d / 0.45, 0.3, 1); // ease onto the target
				b.x += Math.sin(b.hdg) * v * dt;
				b.z += Math.cos(b.hdg) * v * dt;
				// gust: pushed along the wind
				const push = Math.max(0, wind.at(b.x, b.z) - GUST_MIN) * GUST_PUSH;
				b.x += wind.dir.x * push * dt;
				b.z += wind.dir.y * push * dt;
				b.gustK += (push - b.gustK) * (1 - Math.exp(-4 * dt));
				const gy = groundAt(b.x, b.z);
				const oy = b.y;
				b.lift *= Math.exp(-1.5 * dt);
				const yT = b.ty + b.lift + 0.07 * Math.sin(t * 1.7 + b.ph) + 0.015 * Math.sin(b.fa * 2);
				b.y += (yT - b.y) * (1 - Math.exp(-1.8 * dt));
				if (b.y < gy + 0.22) b.y = gy + 0.22;
				b.vy = (b.y - oy) / dt;
				if (d < 0.3) {
					if (b.restNext) {
						b.state = SETTLE;
						b.t = 0;
					} else {
						pickTarget(b);
					}
				}
				break;
			}
			case SETTLE: {
				if (b.pt && !followBack(b)) {
					leaveBack(b);
					break;
				}
				b.t += dt;
				if (b.pt) faceSheep(b, dt, 3);
				const k = 1 - Math.exp(-3.5 * dt);
				const oy = b.y;
				b.x += (b.tx - b.x) * k;
				b.z += (b.tz - b.z) * k;
				b.y += (b.ty - b.y) * k;
				b.vy = (b.y - oy) / dt;
				b.turn = 0;
				b.gustK *= Math.exp(-4 * dt);
				if (b.t > 1) {
					b.x = b.tx;
					b.y = b.ty;
					b.z = b.tz;
					b.state = BREST;
					b.t = 0;
					b.restFor = b.pt ? rnd(BACK_REST[0], BACK_REST[1]) : rnd(2, 4);
				}
				break;
			}
			case BREST: {
				if (b.pt) {
					if (!followBack(b)) {
						leaveBack(b);
						break;
					}
					b.x = b.tx;
					b.y = b.ty;
					b.z = b.tz;
					faceSheep(b, dt, 4);
					// a hop under the butterfly: lifts off about half the time
					const hop = b.pt.rig.body.position.y + b.pt.rig.react.position.y;
					let hopOff = false;
					if (hop > BACK_HOP && !b.pt.lamb) {
						if (!b.hopSeen) hopOff = Math.random() >= BACK_HOP_STAY;
						b.hopSeen = true;
					} else {
						b.hopSeen = false;
					}
					b.t += dt;
					b.vy = 0;
					b.turn = 0;
					if (hopOff || b.t >= b.restFor || wind.at(b.x, b.z) > BACK_WIND_MAX) leaveBack(b);
					break;
				}
				b.t += dt;
				b.vy = 0;
				b.turn = 0;
				if (b.t >= b.restFor || wind.at(b.x, b.z) > REST_WIND_MAX) {
					b.state = FLIT;
					pickTarget(b, false);
					b.restNext = false;
				}
				break;
			}
			case FLEE: {
				b.t += dt;
				const diff = wrapPi(b.fleeH - b.hdg);
				b.hdg += diff * (1 - Math.exp(-6 * dt));
				b.turn = diff;
				const v = lerp(1.2, FLEE_SPEED, sstep(0, 0.4, b.t));
				b.x += Math.sin(b.hdg) * v * dt;
				b.z += Math.cos(b.hdg) * v * dt;
				const oy = b.y;
				b.y += (FLEE_RISE - b.y) * (1 - Math.exp(-1.4 * dt));
				b.vy = (b.y - oy) / dt;
				if (Math.hypot(b.x, b.z) > S(11) || b.t > 5) {
					b.state = GONE;
					b.wait = rnd(GONE_MIN, GONE_MAX);
					b.g.visible = false;
					b.g.position.set(0, -60, 0);
				}
				break;
			}
			case GONE: {
				b.wait -= dt;
				if (b.wait <= 0) {
					const a = rnd(0, TAU);
					b.x = Math.sin(a) * BF_EDGE_R;
					b.z = Math.cos(a) * BF_EDGE_R;
					b.y = 2.5;
					b.hdg = Math.atan2(-b.x, -b.z);
					b.pitch = b.roll = b.vy = b.turn = 0;
					b.state = FLIT;
					pickTarget(b);
					b.g.visible = true;
				}
				return;
			}
		}
		// wings
		b.restW += ((b.state === BREST ? 1 : b.state === SETTLE ? 0.55 : 0) - b.restW) * (1 - Math.exp(-3 * dt));
		let hz = FLAP_HZ * (0.9 + 0.2 * Math.sin(t * 0.9 + b.ph)) * (1 + 0.6 * clamp(b.gustK, 0, 1));
		if (b.state === FLEE) hz *= 1.5;
		b.fa += dt * TAU * hz * (1 - 0.7 * b.restW);
		const flyA = FLAP_MID + FLAP_AMP * Math.sin(b.fa);
		const restA = REST_MID + REST_AMP * Math.sin(t * REST_RATE + b.ph);
		const a = flyA + (restA - flyA) * b.restW;
		b.wr.rotation.z = a;
		b.wl.rotation.z = -a;
		// body tilt: nose follows the climb, banks into turns, leans away from the gust
		const free = 1 - b.restW;
		const pk = 1 - Math.exp(-6 * dt);
		b.pitch += (clamp(-b.vy * 0.4, -0.5, 0.5) * free - b.pitch) * pk;
		b.roll += (clamp(-b.turn * 0.5, -0.5, 0.5) * free - b.gustK * 0.15 - b.roll) * pk;
		b.g.position.set(b.x, b.y, b.z);
		b.g.rotation.set(b.pitch, b.hdg, b.roll);
	}

	function resetButterflies() {
		for (const p of perches) p.who = null;
		for (const b of butterflies) b.pt = null;
		butterflies.forEach((b, i) => startButterfly(b, i));
	}

	// =====================================================================================
	// Birds
	// =====================================================================================

	// finer stitches than the world's knit: reads as felt
	function felt(color, r) {
		const [u, v] = kit.sphereRep(r);
		return kit.mat(color, 'stockinette', [u * 1.5, v * 1.5]);
	}
	const eyeMat = new THREE.MeshStandardMaterial({ color: '#0d0b0b', roughness: 0.2, metalness: 0 });
	const beakMat = new THREE.MeshStandardMaterial({ color: P.mustard, roughness: 0.8, metalness: 0 });
	const legGeo = kit.cachedGeo('birdLeg', () => new THREE.CylinderGeometry(0.008, 0.008, 0.05, 5));
	const beakGeo = kit.cachedGeo('birdBeak', () => {
		const g = new THREE.ConeGeometry(0.017, 0.04, 8);
		g.rotateX(Math.PI / 2);
		return g;
	});

	// bird frame: forward +z, up +y, origin at the feet
	function makeBird(backColor, bellyColor) {
		const g = new THREE.Group();
		g.rotation.order = 'YXZ';
		g.scale.setScalar(BIRD_SCALE);
		const body = new THREE.Group();
		g.add(body);
		const backMat = felt(backColor, 0.1);
		const back = kit.sphere(body, 0.1, backMat, 0, 0.12, -0.005);
		back.scale.set(1, 0.95, 1.15);
		const belly = kit.sphere(body, 0.088, felt(bellyColor, 0.088), 0, 0.1, 0.045);
		belly.scale.set(0.97, 0.95, 1);
		for (const sx of [-1, 1]) {
			const leg = new THREE.Mesh(legGeo, beakMat);
			leg.position.set(sx * 0.03, 0.03, 0.01);
			body.add(leg);
		}
		// tail on a pivot so it can lift and wag
		const tail = new THREE.Group();
		tail.position.set(0, 0.13, -0.1);
		tail.rotation.x = 0.4;
		body.add(tail);
		const tailMesh = kit.sphere(tail, 0.04, backMat, 0, 0, -0.07);
		tailMesh.scale.set(0.7, 0.18, 1.9);
		// head on a neck pivot
		const head = new THREE.Group();
		head.position.set(0, 0.17, 0.07);
		body.add(head);
		kit.sphere(head, 0.066, backMat, 0, 0.035, 0.02);
		for (const sx of [-1, 1]) kit.sphere(head, 0.012, eyeMat, sx * 0.046, 0.055, 0.062);
		const beak = new THREE.Mesh(beakGeo, beakMat);
		beak.position.set(0, 0.03, 0.095);
		head.add(beak);
		// wings: pivot at the shoulder, flat oval out along +x (left one mirrored)
		const wings = [];
		for (const side of [1, -1]) {
			const pivot = new THREE.Group();
			pivot.position.set(side * 0.085, 0.15, 0);
			if (side < 0) pivot.scale.x = -1;
			const m = kit.sphere(pivot, 0.05, backMat, 0.07, 0, 0);
			m.scale.set(1.5, 0.28, 1.2);
			body.add(pivot);
			wings.push(pivot);
		}
		root.add(g);
		return { g, body, head, tail, wr: wings[0], wl: wings[1] };
	}

	const occ = new Int8Array(trees.length).fill(-1); // bird index on each tree
	const cand = new Int8Array(trees.length);
	const birds = [
		{ ...makeBird(P.sky, P.cream), hy: new Spring(100, 11), bsq: new Spring(260, 12, 1) },
		{ ...makeBird(P.coralDeep, P.cream), hy: new Spring(100, 11), bsq: new Spring(260, 12, 1) },
	].slice(0, BIRD_COUNT);

	function initBird(b, i) {
		Object.assign(b, {
			i,
			state: AWAY,
			nextVisit: now + rnd(FIRST_VISIT[0], FIRST_VISIT[1]) + i * 4,
			tree: -1,
			lastTree: -1,
			t: 0,
			dur: 1,
			x: 0,
			y: -60,
			z: 0,
			yaw: 0,
			yawT: 0,
			pitch: 0,
			roll: 0,
			fold: 0,
			fa: Math.random() * TAU,
			flapHz: 8,
			sx: 0,
			sy: 0,
			sz: 0,
			cx: 0,
			cy: 0,
			cz: 0,
			ex: 0,
			ey: 0,
			ez: 0,
			stay: 0,
			act: B_IDLE,
			actT: 0,
			actDur: 0,
			next: 1,
			ox: 0,
			oz: 0,
			hx0: 0,
			hz0: 0,
			hx1: 0,
			hz1: 0,
			nPeck: 2,
			lookFlip: false,
		});
		b.hy.snap(0);
		b.bsq.snap(1);
		b.g.visible = false;
		b.g.position.set(0, -60, 0);
	}
	birds.forEach((b, i) => initBird(b, i));

	// top of the tree crown plus a hop offset, following the crown's sway
	function crownTop(ti, ox, oz, out) {
		const tr = trees[ti];
		tr.crown.getWorldPosition(out);
		const R = tr.r * tr.s;
		out.x += ox;
		out.z += oz;
		out.y += Math.sqrt(Math.max(R * R - ox * ox - oz * oz, 0)) - PERCH_SINK;
		return out;
	}

	function startEnter(b, ti) {
		b.tree = ti;
		occ[ti] = b.i;
		b.state = ENTER;
		b.t = 0;
		b.fold = 0;
		b.flapHz = 6;
		crownTop(ti, 0, 0, _p);
		const tp = trees[ti].g.position;
		const ang = Math.atan2(tp.x, tp.z) + rnd(-0.8, 0.8);
		b.sx = Math.sin(ang) * FLY_R;
		b.sz = Math.cos(ang) * FLY_R;
		b.sy = rnd(4.5, 6);
		const side = Math.random() < 0.5 ? -1 : 1;
		const dx = _p.x - b.sx;
		const dz = _p.z - b.sz;
		const dl = Math.hypot(dx, dz) || 1;
		b.cx = b.sx + dx * 0.55 - (dz / dl) * 2 * side;
		b.cz = b.sz + dz * 0.55 + (dx / dl) * 2 * side;
		b.cy = _p.y + 2.2;
		b.ex = _p.x;
		b.ey = _p.y;
		b.ez = _p.z;
		b.dur = Math.hypot(dx, dz, _p.y - b.sy) / BIRD_SPEED;
		b.x = b.sx;
		b.y = b.sy;
		b.z = b.sz;
		b.yaw = Math.atan2(dx, dz);
		b.pitch = b.roll = 0;
		b.g.visible = true;
	}

	function leave(b) {
		if (b.state === AWAY || b.state === LEAVE) return;
		if (b.tree >= 0) {
			occ[b.tree] = -1;
			b.lastTree = b.tree;
			b.tree = -1;
		}
		b.state = LEAVE;
		b.t = 0;
		b.sx = b.x;
		b.sy = b.y;
		b.sz = b.z;
		const l = Math.hypot(b.x, b.z);
		const ang = (l < 1 ? b.yaw : Math.atan2(b.x, b.z)) + rnd(-0.5, 0.5);
		b.ex = Math.sin(ang) * FLY_R;
		b.ez = Math.cos(ang) * FLY_R;
		b.ey = rnd(5, 7);
		const side = Math.random() < 0.5 ? -1 : 1;
		const dx = b.ex - b.sx;
		const dz = b.ez - b.sz;
		const dl = Math.hypot(dx, dz) || 1;
		b.cx = b.sx + dx * 0.3 - (dz / dl) * 1.2 * side;
		b.cz = b.sz + dz * 0.3 + (dx / dl) * 1.2 * side;
		b.cy = b.sy + 2.4;
		b.dur = Math.hypot(dx, dz, b.ey - b.sy) / BIRD_SPEED;
		b.flapHz = 10;
	}

	// position on the quadratic arc at s; turns the bird along it
	function flyStep(b, s, dt, pitchBias) {
		const q = 1 - s;
		b.x = q * q * b.sx + 2 * q * s * b.cx + s * s * b.ex;
		b.y = q * q * b.sy + 2 * q * s * b.cy + s * s * b.ey;
		b.z = q * q * b.sz + 2 * q * s * b.cz + s * s * b.ez;
		const tx = q * (b.cx - b.sx) + s * (b.ex - b.cx);
		const ty = q * (b.cy - b.sy) + s * (b.ey - b.cy);
		const tz = q * (b.cz - b.sz) + s * (b.ez - b.cz);
		const hz = Math.hypot(tx, tz);
		const diff = hz > 1e-4 ? wrapPi(Math.atan2(tx, tz) - b.yaw) : 0;
		b.yaw += diff * (1 - Math.exp(-6 * dt));
		const pitchT = clamp(-Math.atan2(ty, hz || 1e-4) * 0.8, -0.6, 0.6) + pitchBias;
		b.pitch += (pitchT - b.pitch) * (1 - Math.exp(-6 * dt));
		b.roll += (clamp(-diff * 0.6, -0.5, 0.5) - b.roll) * (1 - Math.exp(-4 * dt));
	}

	function land_(b) {
		b.state = PERCH;
		b.t = 0;
		b.ox = b.oz = 0;
		b.yawT = b.yaw;
		b.stay = rnd(STAY_MIN, STAY_MAX);
		b.act = B_IDLE;
		b.actT = 0;
		b.next = rnd(0.6, 1.2);
		b.bsq.value = 0.88;
		b.bsq.velocity = 0;
	}

	function startPerchAct(b) {
		const r = Math.random();
		b.actT = 0;
		if (r < 0.35) {
			b.act = B_HOP;
			b.actDur = rnd(0.26, 0.32);
			b.hx0 = b.ox;
			b.hz0 = b.oz;
			const a = rnd(0, TAU);
			const st = rnd(0.07, 0.12);
			let nx = b.ox + Math.sin(a) * st;
			let nz = b.oz + Math.cos(a) * st;
			const l = Math.hypot(nx, nz);
			if (l > PERCH_R) {
				nx *= PERCH_R / l;
				nz *= PERCH_R / l;
			}
			b.hx1 = nx;
			b.hz1 = nz;
			if (Math.hypot(nx - b.ox, nz - b.oz) > 0.02) b.yawT = Math.atan2(nx - b.ox, nz - b.oz);
		} else if (r < 0.65) {
			b.act = B_PECK;
			b.nPeck = 2 + Math.floor(Math.random() * 2);
			b.actDur = b.nPeck * 0.5 + 0.2;
		} else if (r < 0.9) {
			b.act = B_LOOK;
			b.actDur = rnd(1.8, 2.8);
			b.lookFlip = false;
			b.hy.target = (Math.random() < 0.5 ? -1 : 1) * 0.9;
		} else {
			b.act = B_WAG;
			b.actDur = 0.8;
		}
	}

	function updatePerch(b, dt) {
		b.t += dt;
		b.stay -= dt;
		const k = 1 - Math.exp(-8 * dt);
		b.pitch += (0 - b.pitch) * k;
		b.roll += (0 - b.roll) * k;
		b.fold += (1 - b.fold) * (1 - Math.exp(-6 * dt));
		b.yaw += wrapPi(b.yawT - b.yaw) * (1 - Math.exp(-7 * dt));
		b.actT += dt;
		let hopY = 0;
		let bodyP = 0;
		let headX = 0;
		let headZ = 0;
		let tailUp = 0;
		let wag = 0;
		switch (b.act) {
			case B_IDLE:
				if (b.actT >= b.next) startPerchAct(b);
				break;
			case B_HOP: {
				const u = Math.min(1, b.actT / b.actDur);
				const e = sstep(0, 1, u);
				b.ox = lerp(b.hx0, b.hx1, e);
				b.oz = lerp(b.hz0, b.hz1, e);
				hopY = 0.055 * Math.sin(Math.PI * u);
				bodyP = -0.3 * Math.sin(Math.PI * u);
				if (u >= 1) endPerchAct(b);
				break;
			}
			case B_PECK: {
				const f = (b.actT / 0.5) % 1;
				const on = b.actT < b.nPeck * 0.5 ? 1 : 0;
				headX = 0.95 * Math.pow(Math.sin(Math.PI * f), 0.8) * on;
				bodyP = 0.22 * headX;
				tailUp = 0.5 * headX;
				if (b.actT >= b.actDur) endPerchAct(b);
				break;
			}
			case B_LOOK: {
				if (!b.lookFlip && b.actT > b.actDur * 0.5) {
					b.lookFlip = true;
					b.hy.target = Math.random() < 0.5 ? -b.hy.target * 0.8 : 0;
				}
				headX = -0.08;
				if (b.actT >= b.actDur) {
					b.hy.target = 0;
					endPerchAct(b);
				}
				break;
			}
			case B_WAG:
				wag = 0.3 * Math.sin(b.actT * 16) * Math.sin(Math.PI * Math.min(1, b.actT / b.actDur));
				if (b.actT >= b.actDur) endPerchAct(b);
				break;
		}
		const hyaw = b.hy.update(dt);
		headZ = 0.15 * hyaw;
		crownTop(b.tree, b.ox, b.oz, _p);
		b.x = _p.x;
		b.y = _p.y + hopY;
		b.z = _p.z;
		const sy = b.bsq.update(dt) * (1 + 0.015 * Math.sin(b.t * 3.2 + b.i));
		const xz = 1 + (1 - sy) * 0.5;
		b.body.scale.set(xz, sy, xz);
		b.body.rotation.x = bodyP;
		b.head.rotation.set(headX, hyaw + 0.04 * Math.sin(b.t * 1.3 + b.i), headZ);
		b.tail.rotation.set(0.4 + tailUp, wag, 0);
		if (b.stay <= 0) leave(b);
	}

	function endPerchAct(b) {
		b.act = B_IDLE;
		b.actT = 0;
		b.next = rnd(0.5, 1.4);
	}

	function pickTree(b) {
		let n = 0;
		for (let i = 0; i < trees.length; i++) if (occ[i] < 0 && i !== b.lastTree) cand[n++] = i;
		return n > 0 ? cand[Math.floor(Math.random() * n)] : -1;
	}

	function applyBird(b, dt) {
		b.g.position.set(b.x, b.y, b.z);
		b.g.rotation.set(b.pitch, b.yaw, b.roll);
		b.fa += dt * TAU * b.flapHz;
		const flap = 0.2 + 0.8 * Math.sin(b.fa);
		const a = flap + (FOLD - flap) * b.fold;
		b.wr.rotation.z = a;
		b.wl.rotation.z = -a;
	}

	function updateBird(b, dt) {
		switch (b.state) {
			case AWAY:
				if (now >= b.nextVisit) {
					const ti = pickTree(b);
					if (ti < 0) b.nextVisit = now + 3;
					else startEnter(b, ti);
				}
				return;
			case ENTER: {
				b.t += dt;
				const u = Math.min(1, b.t / b.dur);
				crownTop(b.tree, 0, 0, _p);
				b.ex = _p.x;
				b.ey = _p.y;
				b.ez = _p.z;
				flyStep(b, 1 - (1 - u) * (1 - u), dt, -0.5 * sstep(0.8, 1, u));
				b.flapHz = 6 + 5 * sstep(0.65, 1, u);
				if (u >= 1) land_(b);
				break;
			}
			case PERCH:
				updatePerch(b, dt);
				break;
			case LEAVE: {
				b.t += dt;
				const u = Math.min(1, b.t / b.dur);
				flyStep(b, u * (1.5 - 0.5 * u), dt, 0);
				b.fold += (0 - b.fold) * (1 - Math.exp(-10 * dt));
				b.flapHz = 10 - 3 * u;
				const sy = b.bsq.update(dt);
				b.body.scale.set(1 + (1 - sy) * 0.5, sy, 1 + (1 - sy) * 0.5);
				b.body.rotation.x += (0 - b.body.rotation.x) * (1 - Math.exp(-8 * dt));
				b.head.rotation.x += (0 - b.head.rotation.x) * (1 - Math.exp(-8 * dt));
				b.head.rotation.y += (0 - b.head.rotation.y) * (1 - Math.exp(-8 * dt));
				b.head.rotation.z += (0 - b.head.rotation.z) * (1 - Math.exp(-8 * dt));
				b.tail.rotation.set(0.4, 0, 0);
				if (u >= 1) {
					b.state = AWAY;
					b.nextVisit = now + rnd(VISIT_MIN, VISIT_MAX);
					b.g.visible = false;
					b.g.position.set(0, -60, 0);
					return;
				}
				break;
			}
		}
		applyBird(b, dt);
	}

	// poke a bird: it flies off
	birds.forEach((b) => {
		b.g.userData.onPoke = () => {
			if (b.state !== ENTER && b.state !== PERCH) return;
			playTweet();
			leave(b);
		};
	});
	// poke a tree: the bird on it (or landing on it) leaves at once
	trees.forEach((tr, ti) => {
		const orig = tr.g.userData.onPoke;
		tr.g.userData.onPoke = (hit) => {
			if (orig) orig(hit);
			for (const b of birds) if (b.tree === ti && (b.state === PERCH || b.state === ENTER)) leave(b);
		};
	});

	function resetBirds() {
		occ.fill(-1);
		birds.forEach((b, i) => initBird(b, i));
	}

	// =====================================================================================

	resetButterflies();
	resetLamb();

	return {
		items: [{ obj: s.g, stage: 'sheep' }],
		grabbables: [lambGrabbable],
		lamb: s,
		butterflies, // for ?debug=1 inspection
		update(t, dt) {
			dt = Math.min(dt, MAX_DT);
			if (dt <= 0) return;
			now = t;
			updateLamb(dt);
			for (let i = 0; i < butterflies.length; i++) updateButterfly(butterflies[i], dt);
			for (let i = 0; i < birds.length; i++) updateBird(birds[i], dt);
		},
		reset() {
			resetLamb();
			resetButterflies();
			resetBirds();
		},
	};
}
