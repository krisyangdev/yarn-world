// Generic position-based-dynamics (Verlet) rope with an in-place tube mesh.
//
//   const rope = new Rope({ groundAt, material });  // material: strand material, repeat [1, 1]
//   scene.add(rope.mesh);                            // mesh.raycast is a no-op (moves every frame)
//
// Particle 0 is the head (index grows toward the free tail). All particles are pre-allocated
// up to `maxPoints`; nothing allocates per frame.
//
// Constructor options (all optional except groundAt)
//   groundAt(x, z)   fast ground height sampler
//   material         THREE material for the tube (uv: u = arc length / (2 * twist), v around)
//   maxPoints 800    capacity of particles
//   segment 0.05     rest length between neighbours
//   radius 0.035     tube radius, also the ground / collider clearance
//   twist 0.2        world length of one ply twist (one texture tile = 2 twists)
//   radialSegments 8 tube sides
//   gravity 9        downward acceleration
//   iterations 10    constraint sweeps per substep (substeps are ~1/100 s, max 6)
//   airDamping 1.2   velocity loss per second
//   groundFriction 0.85  fraction of velocity removed per substep while touching the ground
//   bend 0.5         strength of the soft anti-kink constraint (0 disables)
//   reachFactor 0.99 a grabbed particle can only get this fraction of its chain length away
//                    from the anchor (keeps the rope from stretching under a hard pull)
//   colliders        array of { center: Vector3, radius } spheres, read live (mutate freely,
//                    call wake() after moving one)
//
// Properties: mesh, count, maxPoints, segment, radius, reachFactor, colliders, pos (Float32Array
// xyz per particle, read only)
//
// Methods
//   setAnchor(v3)      pin particle 0 to v3 (re-called every frame by the owner; wakes on change)
//   clearAnchor()      unpin particle 0
//   setPath(points)    replace the rope with a polyline (Vector3-like array) resampled to `segment`
//   settle(seconds=3)  run the simulation at 60 Hz until it sleeps (use after setPath)
//   feed(v3?)          insert a new particle at index 0 (unspool); default position = anchor.
//                      returns false when full. Grab indices shift by one.
//   reel()             remove particle 0 (reel in); returns false when too short
//   grab(index)        pin particle `index` to a moving target; returns a Grab { move(v3), release() }
//                      or null (index < 3 is not grabbable, 4 grabs max)
//   releaseAll()       release every grab
//   pullExcess(out)    for the most overstretched grab: how far its raw target is beyond the reach
//                      (0 if none); out (Vector3) receives the horizontal unit direction anchor -> target
//   pick(ray, camera)  nearest particle to the ray -> { distance, index } or null
//   positionOf(i, out) copy particle position
//   wake()             leave sleep
//   update(dt)         simulate (dt <= 0.05) and refresh the mesh; skips work while asleep
//
// Sleep: with no grab and max particle speed below 0.02 for 1 s the rope stops simulating until
// a grab, feed, reel, setPath, wake() or an anchor move.
import * as THREE from 'three';

const MIN_GRAB_INDEX = 3;
const GRAB_SLOTS = 4;
const GRAB_FOLLOW = 80; // 1/s, how fast a grabbed particle chases its target
const GRAB_SPEED = 14; // max speed of a grabbed particle
const SUBSTEP_RATE = 100;
const MAX_SUBSTEPS = 6;
const MAX_DT = 0.05;
const BEND_MIN = 1.5; // min distance between particles i and i+2, in segments
const CONTACT_EPS = 0.003;
const GROUND_CLEAR = 0.9; // fraction of the radius that rests above the ground height
const REST_SPEED = 0.02;
const REST_TIME = 1;
const PICK_SCREEN = 0.03;
// rounded tail cap: [offset along tangent, ring radius scale] in tube radii
const CAP = [
	[0.64, 0.77],
	[0.985, 0.17],
];

class Grab {
	constructor(rope) {
		this.rope = rope;
		this.active = false;
		this.index = 0;
		this.target = new THREE.Vector3();
	}
	move(target) {
		this.target.copy(target);
		this.rope.wake();
	}
	release() {
		if (!this.active) return;
		this.active = false;
		this.rope.wake();
	}
}

export class Rope {
	constructor({
		groundAt,
		material,
		maxPoints = 800,
		segment = 0.05,
		radius = 0.035,
		twist = 0.2,
		radialSegments = 8,
		gravity = 9,
		iterations = 10,
		airDamping = 1.2,
		groundFriction = 0.85,
		bend = 0.5,
		reachFactor = 0.99,
		colliders = [],
	}) {
		this.groundAt = groundAt;
		this.maxPoints = maxPoints;
		this.segment = segment;
		this.radius = radius;
		this.twist = twist;
		this.radialSegments = radialSegments;
		this.gravity = gravity;
		this.iterations = iterations;
		this.airDamping = airDamping;
		this.groundFriction = groundFriction;
		this.bend = bend;
		this.reachFactor = reachFactor;
		this.colliders = colliders;

		this.count = 0;
		this.pos = new Float32Array(maxPoints * 3);
		this.prev = new Float32Array(maxPoints * 3);
		this.pinned = new Uint8Array(maxPoints);
		this.contact = new Uint8Array(maxPoints);
		this.smooth = new Float32Array(maxPoints * 3);
		this.cum = new Float32Array(maxPoints);

		this.anchor = new THREE.Vector3();
		this.anchored = false;
		this.grabs = Array.from({ length: GRAB_SLOTS }, () => new Grab(this));
		this.sleeping = true;
		this.restTime = 0;
		this.lastSpeed = 0;

		this.tmp = new THREE.Vector3();
		this.tmp2 = new THREE.Vector3();
		this.cs = new Float32Array(radialSegments + 1);
		this.sn = new Float32Array(radialSegments + 1);
		for (let j = 0; j <= radialSegments; j++) {
			this.cs[j] = Math.cos((j / radialSegments) * Math.PI * 2);
			this.sn[j] = Math.sin((j / radialSegments) * Math.PI * 2);
		}
		this.buildMesh(material);
	}

	// ---- mesh ----------------------------------------------------------------------------

	buildMesh(material) {
		const R = this.radialSegments;
		const R1 = R + 1;
		const rings = this.maxPoints + CAP.length;
		this.maxRings = rings;
		const geo = new THREE.BufferGeometry();
		this.posAttr = new THREE.BufferAttribute(new Float32Array(rings * R1 * 3), 3).setUsage(THREE.DynamicDrawUsage);
		this.norAttr = new THREE.BufferAttribute(new Float32Array(rings * R1 * 3), 3).setUsage(THREE.DynamicDrawUsage);
		this.uvAttr = new THREE.BufferAttribute(new Float32Array(rings * R1 * 2), 2).setUsage(THREE.DynamicDrawUsage);
		const index = new Uint32Array((rings - 1) * R * 6);
		let w = 0;
		for (let r = 0; r < rings - 1; r++) {
			for (let j = 0; j < R; j++) {
				const a = r * R1 + j;
				const b = a + 1;
				const c = a + R1;
				const d = c + 1;
				index[w++] = a;
				index[w++] = b;
				index[w++] = c;
				index[w++] = b;
				index[w++] = d;
				index[w++] = c;
			}
		}
		geo.setAttribute('position', this.posAttr);
		geo.setAttribute('normal', this.norAttr);
		geo.setAttribute('uv', this.uvAttr);
		geo.setIndex(new THREE.BufferAttribute(index, 1));
		geo.setDrawRange(0, 0);
		this.mesh = new THREE.Mesh(geo, material);
		this.mesh.castShadow = true;
		this.mesh.receiveShadow = true;
		this.mesh.frustumCulled = false;
		this.mesh.raycast = () => {};
	}

	// one ring of R + 1 vertices (the seam vertex is duplicated for uv wrap)
	writeRing(r, c, n, b, t, rad, tilt, u) {
		const R1 = this.radialSegments + 1;
		const p = this.posAttr.array;
		const nn = this.norAttr.array;
		const uv = this.uvAttr.array;
		const flat = Math.sqrt(Math.max(0, 1 - tilt * tilt));
		let vp = r * R1 * 3;
		let vu = r * R1 * 2;
		for (let j = 0; j < R1; j++) {
			const co = this.cs[j];
			const si = this.sn[j];
			const dx = n[0] * co + b[0] * si;
			const dy = n[1] * co + b[1] * si;
			const dz = n[2] * co + b[2] * si;
			p[vp] = c[0] + dx * rad;
			p[vp + 1] = c[1] + dy * rad;
			p[vp + 2] = c[2] + dz * rad;
			nn[vp] = dx * flat + t[0] * tilt;
			nn[vp + 1] = dy * flat + t[1] * tilt;
			nn[vp + 2] = dz * flat + t[2] * tilt;
			vp += 3;
			uv[vu] = u;
			uv[vu + 1] = j / this.radialSegments;
			vu += 2;
		}
	}

	updateMesh() {
		const n = this.count;
		const geo = this.mesh.geometry;
		if (n < 2) {
			geo.setDrawRange(0, 0);
			return;
		}
		const { pos, smooth: s, cum } = this;
		const R = this.radialSegments;
		const R1 = R + 1;
		const invTile = 1 / (2 * this.twist);

		// light smoothing, ends stay put
		s[0] = pos[0];
		s[1] = pos[1];
		s[2] = pos[2];
		const last = (n - 1) * 3;
		s[last] = pos[last];
		s[last + 1] = pos[last + 1];
		s[last + 2] = pos[last + 2];
		for (let k = 3; k < last; k++) s[k] = 0.25 * pos[k - 3] + 0.5 * pos[k] + 0.25 * pos[k + 3];

		// arc length measured from the tail, so texture stays attached to the yarn when it is fed
		cum[n - 1] = 0;
		for (let i = n - 2; i >= 0; i--) {
			const k = i * 3;
			cum[i] = cum[i + 1] + Math.hypot(s[k + 3] - s[k], s[k + 4] - s[k + 1], s[k + 5] - s[k + 2]);
		}

		const c = this.ringC || (this.ringC = [0, 0, 0]);
		const nv = this.ringN || (this.ringN = [0, 0, 0]);
		const bv = this.ringB || (this.ringB = [0, 0, 0]);
		const tv = this.ringT || (this.ringT = [0, 0, 0]);
		let tx = 0;
		let ty = 0;
		let tz = 1;
		for (let i = 0; i < n; i++) {
			const k = i * 3;
			const a = Math.max(0, i - 1) * 3;
			const e = Math.min(n - 1, i + 1) * 3;
			let dx = s[e] - s[a];
			let dy = s[e + 1] - s[a + 1];
			let dz = s[e + 2] - s[a + 2];
			const l = Math.hypot(dx, dy, dz);
			if (l > 1e-7) {
				tx = dx / l;
				ty = dy / l;
				tz = dz / l;
			}
			if (i === 0) {
				// seed normal: world up (or x) projected off the tangent
				const rx = Math.abs(ty) < 0.9 ? 0 : 1;
				const ry = Math.abs(ty) < 0.9 ? 1 : 0;
				const d = rx * tx + ry * ty;
				dx = rx - tx * d;
				dy = ry - ty * d;
				dz = -tz * d;
			} else {
				// parallel transport: drop the new tangent component of the previous normal
				const d = nv[0] * tx + nv[1] * ty + nv[2] * tz;
				dx = nv[0] - tx * d;
				dy = nv[1] - ty * d;
				dz = nv[2] - tz * d;
			}
			let nl = Math.hypot(dx, dy, dz);
			if (nl < 1e-5) {
				// degenerate: any perpendicular
				dx = ty;
				dy = -tx;
				dz = 0;
				nl = Math.hypot(dx, dy, dz) || 1;
			}
			nv[0] = dx / nl;
			nv[1] = dy / nl;
			nv[2] = dz / nl;
			// b = t x n
			bv[0] = ty * nv[2] - tz * nv[1];
			bv[1] = tz * nv[0] - tx * nv[2];
			bv[2] = tx * nv[1] - ty * nv[0];
			tv[0] = tx;
			tv[1] = ty;
			tv[2] = tz;
			c[0] = s[k];
			c[1] = s[k + 1];
			c[2] = s[k + 2];
			this.writeRing(i, c, nv, bv, tv, this.radius, 0, -cum[i] * invTile);
		}
		// rounded tail cap
		const kl = (n - 1) * 3;
		for (let q = 0; q < CAP.length; q++) {
			const [off, sc] = CAP[q];
			c[0] = s[kl] + tx * off * this.radius;
			c[1] = s[kl + 1] + ty * off * this.radius;
			c[2] = s[kl + 2] + tz * off * this.radius;
			this.writeRing(n + q, c, nv, bv, tv, this.radius * sc, off, off * this.radius * invTile);
		}

		const rings = n + CAP.length;
		geo.setDrawRange(0, (rings - 1) * R * 6);
		const verts = rings * R1;
		for (const [attr, size] of [
			[this.posAttr, 3],
			[this.norAttr, 3],
			[this.uvAttr, 2],
		]) {
			attr.clearUpdateRanges();
			attr.addUpdateRange(0, verts * size);
			attr.needsUpdate = true;
		}
	}

	// ---- state control -------------------------------------------------------------------

	wake() {
		this.sleeping = false;
		this.restTime = 0;
	}

	setAnchor(v) {
		// wake when the pin point is more than 1e-4 away from where particle 0 actually is
		if (this.sleeping) {
			const p = this.pos;
			const dx = v.x - p[0];
			const dy = v.y - p[1];
			const dz = v.z - p[2];
			if (!this.anchored || this.count === 0 || dx * dx + dy * dy + dz * dz > 1e-8) this.wake();
		}
		this.anchor.copy(v);
		this.anchored = true;
	}

	clearAnchor() {
		this.anchored = false;
		this.wake();
	}

	positionOf(i, out) {
		const k = i * 3;
		return out.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
	}

	releaseAll() {
		for (const g of this.grabs) g.active = false;
		this.wake();
	}

	setPath(points) {
		this.releaseAll();
		const { pos, segment, maxPoints } = this;
		let n = 0;
		const put = (x, y, z) => {
			pos[n * 3] = x;
			pos[n * 3 + 1] = y;
			pos[n * 3 + 2] = z;
			n++;
		};
		let a = points[0];
		put(a.x, a.y, a.z);
		let need = segment;
		for (let j = 1; j < points.length && n < maxPoints; j++) {
			const b = points[j];
			const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
			let used = 0;
			while (L - used >= need && n < maxPoints) {
				used += need;
				const f = used / L;
				put(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
				need = segment;
			}
			need -= L - used;
			a = b;
		}
		this.count = n;
		this.prev.set(pos.subarray(0, n * 3));
		this.pinned.fill(0);
		this.contact.fill(0);
		this.wake();
		this.updateMesh();
	}

	settle(seconds = 3) {
		for (let t = 0; t < seconds && !this.sleeping; t += 1 / 60) this.update(1 / 60);
	}

	feed(at) {
		const n = this.count;
		if (n >= this.maxPoints || n < 1) return false;
		const { pos, prev, contact } = this;
		pos.copyWithin(3, 0, n * 3);
		prev.copyWithin(3, 0, n * 3);
		contact.copyWithin(1, 0, n);
		this.count = n + 1;
		const p = at || (this.anchored ? this.anchor : null);
		if (p) {
			pos[0] = p.x;
			pos[1] = p.y;
			pos[2] = p.z;
		}
		// the old head becomes particle 1: put it halfway to particle 2 so no segment starts at zero length
		if (n >= 2) {
			for (let c = 0; c < 3; c++) pos[3 + c] = 0.5 * (pos[c] + pos[6 + c]);
		}
		for (let c = 0; c < 6; c++) prev[c] = pos[c];
		contact[0] = 0;
		for (const g of this.grabs) if (g.active) g.index++;
		this.wake();
		return true;
	}

	reel() {
		const n = this.count;
		if (n <= MIN_GRAB_INDEX + 2) return false;
		const { pos, prev, contact } = this;
		pos.copyWithin(0, 3, n * 3);
		prev.copyWithin(0, 3, n * 3);
		contact.copyWithin(0, 1, n);
		this.count = n - 1;
		for (const g of this.grabs) {
			if (!g.active) continue;
			g.index--;
			if (g.index < MIN_GRAB_INDEX) g.active = false;
		}
		this.wake();
		return true;
	}

	grab(index) {
		const i = Math.min(Math.max(index, MIN_GRAB_INDEX), this.count - 1);
		if (this.count <= MIN_GRAB_INDEX) return null;
		const slot = this.grabs.find((g) => !g.active);
		if (!slot) return null;
		slot.active = true;
		slot.index = i;
		this.positionOf(i, slot.target);
		this.wake();
		return slot;
	}

	pullExcess(out) {
		if (!this.anchored) return 0;
		const a = this.anchor;
		let best = 0;
		for (const g of this.grabs) {
			if (!g.active) continue;
			const dx = g.target.x - a.x;
			const dy = g.target.y - a.y;
			const dz = g.target.z - a.z;
			const e = Math.hypot(dx, dy, dz) - this.reachFactor * g.index * this.segment;
			if (e <= best) continue;
			best = e;
			const h = Math.hypot(dx, dz);
			if (h > 1e-6) out.set(dx / h, 0, dz / h);
		}
		return best;
	}

	pick(ray, camera) {
		const o = ray.origin;
		const d = ray.direction;
		const pos = this.pos;
		const ortho = camera && camera.isOrthographicCamera;
		const orthoTol = ortho ? (PICK_SCREEN * (camera.top - camera.bottom)) / camera.zoom : 0;
		let bestScore = Infinity;
		let bestT = 0;
		let bestI = -1;
		for (let i = MIN_GRAB_INDEX; i < this.count; i++) {
			const k = i * 3;
			const vx = pos[k] - o.x;
			const vy = pos[k + 1] - o.y;
			const vz = pos[k + 2] - o.z;
			const t = vx * d.x + vy * d.y + vz * d.z;
			if (t <= 0) continue;
			const tol = Math.max(ortho ? orthoTol : PICK_SCREEN * t, this.radius * 1.5);
			const perp2 = vx * vx + vy * vy + vz * vz - t * t;
			const score = perp2 / (tol * tol);
			if (score > 1 || score >= bestScore) continue;
			bestScore = score;
			bestT = t;
			bestI = i;
		}
		return bestI < 0 ? null : { distance: bestT, index: bestI };
	}

	// ---- simulation ----------------------------------------------------------------------

	update(dt) {
		if (this.count < 2) return;
		let held = false;
		for (const g of this.grabs) if (g.active && g.index < this.count) held = true;
		if (this.sleeping && !held) return;
		this.sleeping = false;
		dt = Math.min(dt, MAX_DT);
		if (dt <= 0) return;
		const sub = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt * SUBSTEP_RATE - 1e-6)));
		const h = dt / sub;
		let speed = 0;
		for (let s = 0; s < sub; s++) {
			this.substep(h);
			speed = Math.max(speed, this.lastSpeed);
		}
		if (!held && speed < REST_SPEED) {
			this.restTime += dt;
			if (this.restTime >= REST_TIME) this.sleeping = true;
		} else {
			this.restTime = 0;
		}
		this.updateMesh();
	}

	substep(h) {
		const n = this.count;
		const { pos, prev, pinned, contact } = this;
		const gh = this.gravity * h * h;
		const damp = Math.exp(-this.airDamping * h);

		// pins: anchor and grabbed particles
		pinned.fill(0, 0, n);
		if (this.anchored) {
			pinned[0] = 1;
			pos[0] = prev[0] = this.anchor.x;
			pos[1] = prev[1] = this.anchor.y;
			pos[2] = prev[2] = this.anchor.z;
		}
		for (const g of this.grabs) {
			if (!g.active || g.index >= n) continue;
			this.followGrab(g, h);
			pinned[g.index] = 1;
		}

		// Verlet integration; particles on the ground feel no gravity so they lie still
		for (let i = 0; i < n; i++) {
			if (pinned[i]) continue;
			const k = i * 3;
			const x = pos[k];
			const y = pos[k + 1];
			const z = pos[k + 2];
			const vx = (x - prev[k]) * damp;
			const vy = (y - prev[k + 1]) * damp;
			const vz = (z - prev[k + 2]) * damp;
			prev[k] = x;
			prev[k + 1] = y;
			prev[k + 2] = z;
			pos[k] = x + vx;
			pos[k + 1] = y + vy - (contact[i] ? 0 : gh);
			pos[k + 2] = z + vz;
		}

		for (let it = 0; it < this.iterations; it++) {
			if ((it & 1) === 0) {
				for (let i = 0; i < n - 1; i++) this.pair(i);
				if (this.bend > 0) for (let i = 0; i < n - 2; i++) this.skip(i);
			} else {
				for (let i = n - 2; i >= 0; i--) this.pair(i);
				if (this.bend > 0) for (let i = n - 3; i >= 0; i--) this.skip(i);
			}
			this.collide();
		}

		// rest measurement, then ground friction (bleeds velocity of touching particles)
		let maxD2 = 0;
		const fr = this.groundFriction;
		for (let i = 0; i < n; i++) {
			if (pinned[i]) continue;
			const k = i * 3;
			const dx = pos[k] - prev[k];
			const dy = pos[k + 1] - prev[k + 1];
			const dz = pos[k + 2] - prev[k + 2];
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 > maxD2) maxD2 = d2;
			if (contact[i]) {
				prev[k] += dx * fr;
				prev[k + 1] += dy * fr;
				prev[k + 2] += dz * fr;
			}
		}
		this.lastSpeed = Math.sqrt(maxD2) / h;
	}

	// a grabbed particle eases toward its target, which is clamped to the rope's reach
	followGrab(g, h) {
		const { pos, prev, tmp, tmp2 } = this;
		const k = g.index * 3;
		tmp.copy(g.target);
		if (this.anchored) {
			const reach = this.reachFactor * g.index * this.segment;
			tmp2.copy(tmp).sub(this.anchor);
			const l = tmp2.length();
			if (l > reach) tmp.copy(this.anchor).addScaledVector(tmp2, reach / l);
		}
		const dx = tmp.x - pos[k];
		const dy = tmp.y - pos[k + 1];
		const dz = tmp.z - pos[k + 2];
		const dist = Math.hypot(dx, dy, dz);
		if (dist > 1e-7) {
			const move = Math.min(dist * (1 - Math.exp(-GRAB_FOLLOW * h)), GRAB_SPEED * h);
			const f = move / dist;
			pos[k] += dx * f;
			pos[k + 1] += dy * f;
			pos[k + 2] += dz * f;
		}
		prev[k] = pos[k];
		prev[k + 1] = pos[k + 1];
		prev[k + 2] = pos[k + 2];
	}

	// distance constraint between particles i and i + 1
	pair(i) {
		const { pos, pinned } = this;
		const w0 = pinned[i] ? 0 : 1;
		const w1 = pinned[i + 1] ? 0 : 1;
		const w = w0 + w1;
		if (w === 0) return;
		const a = i * 3;
		const b = a + 3;
		const dx = pos[b] - pos[a];
		const dy = pos[b + 1] - pos[a + 1];
		const dz = pos[b + 2] - pos[a + 2];
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (d < 1e-7) return;
		const c = (d - this.segment) / d / w;
		pos[a] += dx * c * w0;
		pos[a + 1] += dy * c * w0;
		pos[a + 2] += dz * c * w0;
		pos[b] -= dx * c * w1;
		pos[b + 1] -= dy * c * w1;
		pos[b + 2] -= dz * c * w1;
	}

	// soft minimum distance between particles i and i + 2: stops sharp kinks
	skip(i) {
		const { pos, pinned } = this;
		const w0 = pinned[i] ? 0 : 1;
		const w1 = pinned[i + 2] ? 0 : 1;
		const w = w0 + w1;
		if (w === 0) return;
		const a = i * 3;
		const b = a + 6;
		const dx = pos[b] - pos[a];
		const dy = pos[b + 1] - pos[a + 1];
		const dz = pos[b + 2] - pos[a + 2];
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		const min = BEND_MIN * this.segment;
		if (d >= min || d < 1e-7) return;
		const c = ((d - min) / d / w) * this.bend;
		pos[a] += dx * c * w0;
		pos[a + 1] += dy * c * w0;
		pos[a + 2] += dz * c * w0;
		pos[b] -= dx * c * w1;
		pos[b + 1] -= dy * c * w1;
		pos[b + 2] -= dz * c * w1;
	}

	// sphere colliders and ground
	collide() {
		const { pos, pinned, contact, colliders, groundAt } = this;
		const n = this.count;
		const clear = this.radius * GROUND_CLEAR;
		for (let i = 0; i < n; i++) {
			if (pinned[i]) continue;
			const k = i * 3;
			for (let q = 0; q < colliders.length; q++) {
				const c = colliders[q];
				const rr = c.radius + this.radius;
				const dx = pos[k] - c.center.x;
				const dy = pos[k + 1] - c.center.y;
				const dz = pos[k + 2] - c.center.z;
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 >= rr * rr) continue;
				if (d2 < 1e-10) {
					pos[k + 1] = c.center.y + rr;
					continue;
				}
				const f = rr / Math.sqrt(d2);
				pos[k] = c.center.x + dx * f;
				pos[k + 1] = c.center.y + dy * f;
				pos[k + 2] = c.center.z + dz * f;
			}
			const gy = groundAt(pos[k], pos[k + 2]) + clear;
			if (pos[k + 1] <= gy + CONTACT_EPS) {
				if (pos[k + 1] < gy) pos[k + 1] = gy;
				contact[i] = 1;
			} else {
				contact[i] = 0;
			}
		}
	}
}
