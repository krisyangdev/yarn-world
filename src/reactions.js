// Poke reactions: squash and stretch springs, hops and small surprises per object kind.
// world.js builds the objects (with a react group at each base) and hands them in here.
import * as THREE from 'three';
import { Spring } from './spring.js';
import { playBaa, playBranch, playFluff, playPop, playRustle, playPlink, playDoor, playChime, playStone, playTap } from './sound.js';

const TAU = Math.PI * 2;
const GRAVITY = 9.8;
const HOVER_SCALE = 1.04;

const rnd = (a, b) => a + Math.random() * (b - a);
const sstep = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const wrapPi = (a) => a - TAU * Math.round(a / TAU);
const easeOutBack = (u) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2;
const noRaycast = () => {};

// sheep
const GRUMPY_POKES = 3;
const GRUMPY_WINDOW = 2.5;
const GRUMPY_TIME = 4;
const GRUMPY_TURN = 2.6; // max turn away, radians (~150 deg)
const HOP_VY = 2.0;
const STOMP_VY = 1.1;
const TUFT_R = 0.07;
const TUFT_LIFE = 1.5;
const TUFT_MAX = 40;

// pompom trees
const FRUIT_R = 0.07;
const FRUIT_MAX = 24;
const FRUIT_LIFE = 8;
const FRUIT_SHRINK = 0.4;
const FRUIT_EAT_SHRINK = 0.22; // time the last bite takes to make the fruit vanish
const FRUIT_NIBBLE = 14; // 1/s, how fast the fruit follows its nibbled size
const EAT_DELAY_MIN = 1; // a resting fruit is edible after this many seconds ...
const EAT_DELAY_MAX = 3; // ... chosen per fruit
const ROLL_ACCEL = 6;
const ROLL_TIME = 1.5;

// clouds
const RAIN_MAX = 160;
const RAIN_DROPS = 40;
const RAIN_PLINKS = 6;
const RAIN_SPREAD = 1.4; // drops start within this many seconds
const RAIN_GRAVITY = 7;
const POP_TIME = 0.18;

// cottage
const DOOR_OPEN = (70 * Math.PI) / 180;
const DOOR_CLOSE_AT = 1.6;
const DOOR_END = 2.4;
const HEART_N = 10;
const HEART_R = 0.075;
const HEART_W = 0.28;
const HEART_LIFE = 2.5;

// Springy squash and stretch about the group's origin, plus a hover inflate
class Jelly {
	constructor(group, k = 260, c = 12) {
		this.group = group;
		this.y = new Spring(k, c, 1);
		this.xz = new Spring(k, c, 1);
		this.hover = new Spring(180, 16, 1);
		this.rest = true;
	}

	// jump to a squashed pose now; the spring releases it with overshoot
	squash(sy, sxz) {
		this.y.value = sy;
		this.y.velocity = 0;
		this.xz.value = sxz;
		this.xz.velocity = 0;
		this.rest = false;
	}

	setHover(on) {
		this.hover.target = on ? HOVER_SCALE : 1;
		this.rest = false;
	}

	update(dt) {
		if (this.rest) return;
		const y = this.y.update(dt);
		const xz = this.xz.update(dt);
		const h = this.hover.update(dt);
		this.group.scale.set(xz * h, y * h, xz * h);
		if (this.y.settled && this.xz.settled && this.hover.settled) {
			this.y.snap(1);
			this.xz.snap(1);
			this.hover.snap(this.hover.target);
			this.group.scale.setScalar(this.hover.target);
			this.rest = true;
		}
	}
}

// Ballistic hop offset above the rest position
class Hop {
	constructor() {
		this.y = 0;
		this.vy = 0;
		this.air = false;
	}

	launch(vy) {
		this.vy = vy;
		this.air = true;
	}

	// true on the frame it lands
	update(dt) {
		if (!this.air) return false;
		this.vy -= GRAVITY * dt;
		this.y += this.vy * dt;
		if (this.y <= 0 && this.vy < 0) {
			this.y = 0;
			this.vy = 0;
			this.air = false;
			return true;
		}
		return false;
	}
}

export function setupReactions({ root, sheep, trees, pines, clouds, house, props = [], heightAt, kit }) {
	const { P } = kit;
	const jellies = [];
	let now = 0;

	const _v = new THREE.Vector3();
	const _m = new THREE.Matrix4();
	const dir = { x: 0, z: 0 };

	// unit xz direction from the poke point to obj, optionally in obj's yaw frame
	function awayDir(obj, point, local) {
		let dx = obj.position.x - point.x;
		let dz = obj.position.z - point.z;
		const l = Math.hypot(dx, dz);
		if (l < 1e-4) {
			const a = Math.random() * TAU;
			dx = Math.cos(a);
			dz = Math.sin(a);
		} else {
			dx /= l;
			dz /= l;
		}
		if (local) {
			const c = Math.cos(obj.rotation.y);
			const s = Math.sin(obj.rotation.y);
			const lx = dx * c - dz * s;
			const lz = dx * s + dz * c;
			dx = lx;
			dz = lz;
		}
		dir.x = dx;
		dir.z = dz;
	}

	function attach(obj, jelly, onPoke) {
		jellies.push(jelly);
		obj.userData.onPoke = onPoke;
		obj.userData.onHover = (on) => jelly.setHover(on);
	}

	function spawn(geo, material) {
		const mesh = new THREE.Mesh(geo, material);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.raycast = noRaycast;
		root.add(mesh);
		return mesh;
	}

	// -----------------------------------------------------------------------
	// Sheep: squash, hop, head pop, wool tufts, grumpy after repeated pokes
	// -----------------------------------------------------------------------
	const tuftGeo = kit.sphereGeo(TUFT_R);
	const tuftMat = kit.boucle(P.cream, TUFT_R);
	const tufts = [];

	function spawnTufts(s, point) {
		const n = 3 + Math.floor(Math.random() * 3);
		_v.set(s.g.position.x, s.g.position.y + 0.5, s.g.position.z);
		_v.set(point.x - _v.x, point.y - _v.y, point.z - _v.z).normalize();
		for (let i = 0; i < n; i++) {
			if (tufts.length >= TUFT_MAX) root.remove(tufts.shift().mesh);
			const mesh = spawn(tuftGeo, tuftMat);
			mesh.position.set(point.x + rnd(-0.06, 0.06), point.y + rnd(0, 0.08), point.z + rnd(-0.06, 0.06));
			const size = rnd(0.7, 1.2);
			mesh.scale.setScalar(size);
			const sp = rnd(0.3, 0.8);
			tufts.push({
				mesh,
				size,
				age: 0,
				vx: _v.x * sp + rnd(-0.3, 0.3),
				vy: rnd(0.6, 1.2),
				vz: _v.z * sp + rnd(-0.3, 0.3),
				spin: rnd(-4, 4),
			});
		}
	}

	const sheepStates = sheep.map((s, i) => {
		const st = {
			s,
			jelly: new Jelly(s.react),
			hop: new Hop(),
			headRot: new Spring(160, 9),
			headScale: new Spring(200, 11, 1),
			turn: new Spring(24, 7),
			pokes: [],
			stomps: 0,
			grumpyUntil: 0,
			turned: false,
		};
		attach(s.g, st.jelly, (hit) => pokeSheep(st, hit));
		return st;
	});

	function pokeSheep(st, hit) {
		const { s } = st;
		const point = hit.point;
		st.pokes.push(now);
		while (st.pokes.length && st.pokes[0] < now - GRUMPY_WINDOW) st.pokes.shift();

		const wasGrumpy = now < st.grumpyUntil;
		if (wasGrumpy || st.pokes.length >= GRUMPY_POKES) {
			// grumpy: two little stomps, turn the back to the poke point for a while
			st.pokes.length = 0;
			playBaa({ grumpy: true });
			st.jelly.squash(0.85, 1.08);
			st.hop.launch(STOMP_VY);
			st.stomps = 1;
			if (!wasGrumpy) {
				const away = Math.atan2(s.g.position.x - point.x, s.g.position.z - point.z);
				st.turn.target = THREE.MathUtils.clamp(wrapPi(away - s.yaw), -GRUMPY_TURN, GRUMPY_TURN);
				st.turned = true;
			}
			st.grumpyUntil = now + GRUMPY_TIME;
			return;
		}

		playBaa();
		st.jelly.squash(0.75, 1.15);
		st.hop.launch(HOP_VY);
		st.headRot.value = -0.55;
		st.headRot.velocity = 0;
		st.headScale.value = 1.25;
		st.headScale.velocity = 0;
		if (!s.bald) spawnTufts(s, point);
	}

	function updateSheep(dt) {
		for (const st of sheepStates) {
			const { s } = st;
			if (st.hop.update(dt)) {
				if (st.stomps > 0) {
					st.stomps--;
					st.hop.launch(STOMP_VY);
					st.jelly.squash(0.84, 1.08);
				} else {
					st.jelly.squash(0.9, 1.06);
				}
			}
			s.react.position.y = st.hop.y;
			if (st.turned && now >= st.grumpyUntil) {
				st.turn.target = 0;
				st.turned = false;
			}
			s.react.rotation.y = st.turn.update(dt);
			s.headPop.rotation.x = st.headRot.update(dt);
			s.headPop.scale.setScalar(st.headScale.update(dt));
		}
		for (let i = tufts.length - 1; i >= 0; i--) {
			const f = tufts[i];
			f.age += dt;
			const u = f.age / TUFT_LIFE;
			if (u >= 1) {
				root.remove(f.mesh);
				tufts.splice(i, 1);
				continue;
			}
			const damp = Math.exp(-1.2 * dt);
			f.vx *= damp;
			f.vz *= damp;
			f.vy = f.vy * damp - 1.8 * dt;
			f.mesh.position.x += f.vx * dt;
			f.mesh.position.y += f.vy * dt;
			f.mesh.position.z += f.vz * dt;
			f.mesh.rotation.y += f.spin * dt;
			f.mesh.scale.setScalar(Math.max(1e-3, f.size * (1 - sstep(0.4, 1, u))));
		}
	}

	// -----------------------------------------------------------------------
	// Pompom trees: wobble, crown squash, falling pompom fruits
	// -----------------------------------------------------------------------
	const fruitGeo = kit.sphereGeo(FRUIT_R);
	const fruits = [];
	const FALL = 0;
	const ROLL = 1;
	const REST = 2;

	// drop a fruit from the world (oldest unclaimed first when the pool is full)
	function evictFruit() {
		let i = fruits.findIndex((f) => !f.claimed);
		if (i < 0) i = 0;
		const [f] = fruits.splice(i, 1);
		f.gone = true;
		root.remove(f.mesh);
	}

	function spawnFruits(tr) {
		const n = 2 + Math.floor(Math.random() * 2);
		const mat = kit.boucle(tr.fruit, FRUIT_R);
		tr.crown.getWorldPosition(_v);
		const radius = tr.r * tr.s * 0.95;
		for (let i = 0; i < n; i++) {
			while (fruits.length >= FRUIT_MAX) evictFruit();
			const a = Math.random() * TAU;
			const el = rnd(-0.15, 0.6);
			const cx = Math.cos(a) * Math.cos(el);
			const cz = Math.sin(a) * Math.cos(el);
			const mesh = spawn(fruitGeo, mat);
			const size = rnd(0.85, 1.15);
			mesh.scale.setScalar(size);
			mesh.position.set(_v.x + cx * radius, _v.y + Math.sin(el) * radius, _v.z + cz * radius);
			fruits.push({
				mesh,
				size,
				R: FRUIT_R * size,
				state: FALL,
				age: 0,
				rollT: 0,
				landed: false,
				vx: cx * 0.5,
				vy: 0,
				vz: cz * 0.5,
				// sheep interaction (see `fruit` below)
				resting: false, // came to rest on the ground
				restT: 0, // seconds at rest
				eatDelay: rnd(EAT_DELAY_MIN, EAT_DELAY_MAX),
				claimed: false, // a sheep is on its way: the fruit does not expire
				eatK: 1, // nibbled size factor
				eatTarget: 1,
				eaten: false,
				eatT: 0,
				gone: false, // removed from the world
			});
		}
	}

	const E = 0.15;
	function updateFruits(dt) {
		for (let i = fruits.length - 1; i >= 0; i--) {
			const f = fruits[i];
			const p = f.mesh.position;
			if (f.eaten) {
				f.eatT += dt;
				const u = f.eatT / FRUIT_EAT_SHRINK;
				if (u >= 1) {
					f.gone = true;
					root.remove(f.mesh);
					fruits.splice(i, 1);
				} else {
					f.mesh.scale.setScalar(Math.max(1e-3, f.size * f.eatK * (1 - u * u)));
				}
				continue;
			}
			f.age += dt;
			if (f.claimed && f.age > FRUIT_LIFE) f.age = FRUIT_LIFE; // a sheep is coming
			if (f.age > FRUIT_LIFE) {
				const u = (f.age - FRUIT_LIFE) / FRUIT_SHRINK;
				if (u >= 1) {
					f.gone = true;
					root.remove(f.mesh);
					fruits.splice(i, 1);
				} else {
					f.mesh.scale.setScalar(Math.max(1e-3, f.size * (1 - u)));
				}
				continue;
			}
			if (f.state === REST) {
				f.restT += dt;
				if (f.eatK !== f.eatTarget) {
					f.eatK += (f.eatTarget - f.eatK) * (1 - Math.exp(-FRUIT_NIBBLE * dt));
					if (Math.abs(f.eatK - f.eatTarget) < 1e-3) f.eatK = f.eatTarget;
					f.mesh.scale.setScalar(Math.max(1e-3, f.size * f.eatK));
				}
				continue;
			}

			if (f.state === FALL) {
				f.vy -= GRAVITY * dt;
				p.x += f.vx * dt;
				p.y += f.vy * dt;
				p.z += f.vz * dt;
				const gy = heightAt(p.x, p.z) + f.R;
				if (p.y <= gy) {
					p.y = gy;
					if (!f.landed) {
						f.landed = true;
						playPop({ pitch: 1 / f.size });
					}
					if (f.vy < -1.2) {
						f.vy = -f.vy * 0.42;
						f.vx *= 0.7;
						f.vz *= 0.7;
					} else {
						f.state = ROLL;
						f.vy = 0;
					}
				}
				continue;
			}

			// roll downhill along the height gradient
			const h0 = heightAt(p.x, p.z);
			const gx = (heightAt(p.x + E, p.z) - h0) / E;
			const gz = (heightAt(p.x, p.z + E) - h0) / E;
			f.vx -= gx * ROLL_ACCEL * dt;
			f.vz -= gz * ROLL_ACCEL * dt;
			const damp = Math.exp(-2.5 * dt);
			f.vx *= damp;
			f.vz *= damp;
			p.x += f.vx * dt;
			p.z += f.vz * dt;
			p.y = heightAt(p.x, p.z) + f.R;
			f.mesh.rotation.x += (f.vz * dt) / f.R;
			f.mesh.rotation.z -= (f.vx * dt) / f.R;
			f.rollT += dt;
			if (f.rollT > ROLL_TIME || (f.rollT > 0.2 && f.vx * f.vx + f.vz * f.vz < 4e-4)) {
				f.state = REST;
				f.resting = true;
			}
		}
	}

	// Sheep interaction (used by sheeplife.js): `list` is the live array of fruits. A fruit is edible once
	// `resting` and `restT >= eatDelay`. claim() keeps it from expiring while a sheep walks over; nibble()
	// shrinks it to a fraction per bite; eat() shrinks the rest away and removes it. Check `gone` before use.
	const fruit = {
		list: fruits,
		claim(f) {
			if (f.gone || f.claimed || f.eaten || !f.resting || f.age > FRUIT_LIFE) return false;
			f.claimed = true;
			return true;
		},
		release(f) {
			f.claimed = false;
		},
		nibble(f, k) {
			f.eatTarget = k;
		},
		eat(f) {
			if (f.gone || f.eaten) return;
			f.eaten = true;
			f.eatT = 0;
			f.eatK = Math.min(f.eatK, f.eatTarget);
			playPop({ pitch: 1.6 });
		},
	};

	const treeStates = trees.map((tr) => {
		const st = { tr, jelly: new Jelly(tr.react), rx: new Spring(110, 5.5), rz: new Spring(110, 5.5) };
		attach(tr.g, st.jelly, (hit) => {
			awayDir(tr.g, hit.point, true);
			st.rz.value = -dir.x * 0.16;
			st.rz.velocity = 0;
			st.rx.value = dir.z * 0.16;
			st.rx.velocity = 0;
			st.jelly.squash(0.88, 1.08);
			playRustle();
			spawnFruits(tr);
		});
		return st;
	});

	// -----------------------------------------------------------------------
	// Pines: wobble, the top pompom hops
	// -----------------------------------------------------------------------
	const pineStates = pines.map((pn) => {
		const st = {
			pn,
			jelly: new Jelly(pn.react),
			rx: new Spring(110, 5.5),
			rz: new Spring(110, 5.5),
			hop: new Hop(),
			topSy: new Spring(300, 13, 1),
		};
		attach(pn.g, st.jelly, (hit) => {
			awayDir(pn.g, hit.point, true);
			st.rz.value = -dir.x * 0.12;
			st.rz.velocity = 0;
			st.rx.value = dir.z * 0.12;
			st.rx.velocity = 0;
			st.jelly.squash(0.9, 1.06);
			st.hop.launch(2.6);
			st.topSy.value = 0.75;
			st.topSy.velocity = 0;
			playBranch();
		});
		return st;
	});

	// -----------------------------------------------------------------------
	// Clouds: squash, string swing, yarn rain (one instanced mesh)
	// -----------------------------------------------------------------------
	const dropGeo = new THREE.CapsuleGeometry(0.022, 0.09, 3, 8);
	const dropMesh = new THREE.InstancedMesh(dropGeo, kit.mat('#ffffff', 'stockinette', [1, 2]), RAIN_MAX);
	dropMesh.castShadow = true;
	dropMesh.frustumCulled = false;
	dropMesh.raycast = noRaycast;
	const dropBlue = new THREE.Color(P.sky);
	const dropWhite = new THREE.Color(P.white);
	_m.makeScale(0, 0, 0);
	for (let i = 0; i < RAIN_MAX; i++) {
		dropMesh.setMatrixAt(i, _m);
		dropMesh.setColorAt(i, dropWhite);
	}
	root.add(dropMesh);

	const DROP_FREE = 0;
	const DROP_WAIT = 1;
	const DROP_FALL = 2;
	const DROP_POP = 3;
	const drop = {
		state: new Uint8Array(RAIN_MAX),
		plink: new Uint8Array(RAIN_MAX),
		x: new Float32Array(RAIN_MAX),
		y: new Float32Array(RAIN_MAX),
		z: new Float32Array(RAIN_MAX),
		vy: new Float32Array(RAIN_MAX),
		gy: new Float32Array(RAIN_MAX),
		t: new Float32Array(RAIN_MAX), // wait time left, then time in the current phase
	};
	let rainDirty = false;

	function startRain(c) {
		c.cloud.getWorldPosition(_v);
		const spread = 0.75 * c.s;
		let slot = 0;
		for (let k = 0; k < RAIN_DROPS; k++) {
			while (slot < RAIN_MAX && drop.state[slot] !== DROP_FREE) slot++;
			if (slot >= RAIN_MAX) break;
			const a = Math.random() * TAU;
			const d = Math.sqrt(Math.random()) * spread;
			const x = _v.x + Math.cos(a) * d;
			const z = _v.z + Math.sin(a) * d;
			drop.x[slot] = x;
			drop.z[slot] = z;
			drop.y[slot] = _v.y - 0.55 * c.s - Math.random() * 0.2;
			drop.gy[slot] = heightAt(x, z) + 0.05;
			drop.vy[slot] = -rnd(0.5, 1.5);
			drop.t[slot] = Math.random() * RAIN_SPREAD;
			drop.plink[slot] = k < RAIN_PLINKS ? 1 : 0;
			drop.state[slot] = DROP_WAIT;
			dropMesh.setColorAt(slot, k % 3 === 0 ? dropWhite : dropBlue);
		}
		dropMesh.instanceColor.needsUpdate = true;
		rainDirty = true;
	}

	function writeDrop(i, sx, sy) {
		_m.makeScale(sx, sy, sx).setPosition(drop.x[i], drop.y[i], drop.z[i]);
		dropMesh.setMatrixAt(i, _m);
	}

	function updateRain(dt) {
		if (!rainDirty) return;
		let active = 0;
		for (let i = 0; i < RAIN_MAX; i++) {
			const st = drop.state[i];
			if (st === DROP_FREE) continue;
			active++;
			if (st === DROP_WAIT) {
				drop.t[i] -= dt;
				if (drop.t[i] > 0) continue;
				drop.state[i] = DROP_FALL;
				drop.t[i] = 0;
			}
			if (drop.state[i] === DROP_FALL) {
				drop.t[i] += dt;
				drop.vy[i] -= RAIN_GRAVITY * dt;
				drop.y[i] += drop.vy[i] * dt;
				if (drop.y[i] <= drop.gy[i]) {
					drop.y[i] = drop.gy[i];
					drop.state[i] = DROP_POP;
					drop.t[i] = 0;
					if (drop.plink[i]) playPlink({ pitch: rnd(0.9, 1.7) });
				} else {
					const s = Math.min(1, drop.t[i] / 0.12);
					writeDrop(i, s, s);
					continue;
				}
			}
			// pop: swell a little, flatten, vanish
			drop.t[i] += dt;
			const u = drop.t[i] / POP_TIME;
			if (u >= 1) {
				drop.state[i] = DROP_FREE;
				_m.makeScale(0, 0, 0);
				dropMesh.setMatrixAt(i, _m);
			} else {
				const fade = 1 - u * u;
				writeDrop(i, (1 + 0.8 * Math.sin(u * Math.PI * 0.5)) * fade, 0.5 * fade);
			}
		}
		dropMesh.instanceMatrix.needsUpdate = true;
		if (active === 0) rainDirty = false;
	}

	const cloudStates = clouds.map((c) => {
		const st = { c, jelly: new Jelly(c.react, 200, 10), sx: new Spring(50, 3), sz: new Spring(50, 3) };
		attach(c.react, st.jelly, (hit) => {
			awayDir(c.pivot, hit.point, false);
			st.sz.value = -dir.x * 0.1;
			st.sz.velocity = 0;
			st.sx.value = dir.z * 0.1;
			st.sx.velocity = 0;
			st.jelly.squash(0.7, 1.2);
			playFluff();
			startRain(c);
		});
		return st;
	});

	// -----------------------------------------------------------------------
	// Cottage: squash, door swing, cat peek, chimney heart
	// -----------------------------------------------------------------------
	const houseJelly = new Jelly(house.group);
	const door = new Spring(90, 10);
	let doorT = -1; // time since the door was opened, -1 when idle

	const heart = new THREE.Group();
	heart.visible = false;
	const heartGeo = kit.sphereGeo(HEART_R);
	const heartMat = kit.boucle(P.white, HEART_R);
	for (let i = 0; i < HEART_N; i++) {
		const a = (i / HEART_N) * TAU;
		const hx = 16 * Math.sin(a) ** 3;
		const hy = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
		const m = new THREE.Mesh(heartGeo, heartMat);
		m.castShadow = true;
		m.raycast = noRaycast;
		m.position.set((hx / 17) * HEART_W, ((hy + 2.5) / 17) * HEART_W, 0);
		heart.add(m);
	}
	house.group.add(heart);
	let heartT = -1;

	attach(house.group, houseJelly, () => {
		houseJelly.squash(0.9, 1.05);
		if (doorT < 0) {
			doorT = 0;
			door.target = -DOOR_OPEN;
			playDoor();
		}
		heartT = 0;
		playChime();
	});

	function updateHouse(dt) {
		if (doorT >= 0) {
			doorT += dt;
			if (doorT >= DOOR_CLOSE_AT) door.target = 0;
			door.update(dt);
			if (door.value > 0) door.snap(0); // door meets the frame
			house.door.rotation.y = door.value;

			const cat = house.cat;
			if (doorT > 0.3 && doorT < 1.55) {
				cat.visible = true;
				if (doorT < 0.75) {
					cat.position.z = THREE.MathUtils.lerp(0.42, 0.66, easeOutBack((doorT - 0.3) / 0.45));
				} else if (doorT < 1.15) {
					cat.position.z = 0.66;
					cat.rotation.z = Math.sin(((doorT - 0.75) / 0.4) * Math.PI) * 0.35;
				} else {
					const u = (doorT - 1.15) / 0.4;
					cat.rotation.z = 0;
					cat.position.z = THREE.MathUtils.lerp(0.66, 0.42, u * u * u);
				}
			} else {
				cat.visible = false;
			}
			if (doorT > DOOR_END) {
				doorT = -1;
				door.snap(0);
				house.door.rotation.y = 0;
			}
		}

		if (heartT >= 0) {
			heartT += dt;
			const u = heartT / HEART_LIFE;
			if (u >= 1) {
				heartT = -1;
				heart.visible = false;
			} else {
				const top = house.chimneyTop;
				heart.visible = true;
				heart.position.set(top.x + Math.sin(u * 5) * 0.06, top.y + u * 1.3, top.z + u * 0.25);
				heart.rotation.y = Math.sin(u * 3) * 0.3;
				const env = sstep(0, 0.12, u) * (1 - sstep(0.65, 1, u));
				heart.scale.setScalar(Math.max(1e-3, (0.5 + 0.7 * u) * env));
			}
		}
	}

	// -----------------------------------------------------------------------
	// Small props: stones, fence posts
	// -----------------------------------------------------------------------
	for (const { group, kind } of props) {
		const jelly = new Jelly(group);
		attach(group, jelly, () => {
			jelly.squash(0.75, 1.15);
			if (kind === 'stone') playStone();
			else playTap();
		});
	}

	// -----------------------------------------------------------------------
	function update(t, dt) {
		now = t;
		for (const j of jellies) j.update(dt);
		updateSheep(dt);
		for (const st of treeStates) {
			st.tr.react.rotation.z = st.rz.update(dt);
			st.tr.react.rotation.x = st.rx.update(dt);
		}
		updateFruits(dt);
		for (const st of pineStates) {
			const { pn } = st;
			pn.react.rotation.z = st.rz.update(dt);
			pn.react.rotation.x = st.rx.update(dt);
			if (st.hop.update(dt)) st.topSy.value = 0.7;
			const sy = st.topSy.update(dt);
			const sxz = 1 + (1 - sy) * 0.5;
			pn.top.scale.set(sxz, sy, sxz);
			pn.top.position.y = pn.topY + st.hop.y;
		}
		for (const st of cloudStates) {
			st.c.swing.rotation.z = st.sz.update(dt);
			st.c.swing.rotation.x = st.sx.update(dt);
		}
		updateRain(dt);
		updateHouse(dt);
	}
	update.fruit = fruit; // the update function carries the sheep-facing fruit API
	return update;
}
