// Wind props: everything on the island that moves because of the shared wind field (wind.js).
//   1. grass tufts   ~400 thin yarn blades in 8 instanced clusters, bent in the vertex shader
//   2. corner tassels a yarn tassel hangs from each cushion corner and swings like a pendulum
//   3. clothesline   two wooden posts, a sagging strand, four knitted garments that flap
//   4. pinwheels     two felt pinwheels on sticks; spin rate follows the wind, inertia included
//   5. fluff         a pool of dandelion-seed puffs that lift off the flower areas when a gust passes
// The integrator calls setupWindProps({ root, wind, kit, terrain }) once, update(t, dt) every frame and
// reset() on R / replay. Every object is a direct child of root; `items` lists what the knit-in intro pops in.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WIND_GLSL } from './wind.js';
import { Spring } from './spring.js';
import { playFlap, playWhirr } from './sound.js';
import { S, CLOTHESLINE, FLOWER_CLUSTERS } from './layout.js';

const TAU = Math.PI * 2;

// --- feel knobs ------------------------------------------------------------
// grass
const GRASS_COUNT = 400;
const GRASS_H = 0.16; // tallest blade in the tuft geometry (instances scale 0.7 .. 1.0)
const GRASS_BLADE_R = 0.01;
const GRASS_LEAN = [0.1, 0.45]; // tip lean as a fraction of GRASS_H: breeze, per unit of wind strength
// tassels
const TASSEL_E = 0.97; // sE where the tassel hangs from the rolled edge (0.86 = top of the roll, 1 = its outermost side)
const TASSEL_OUT = 0.09; // pushed this far away from the cushion along the corner diagonal
const TASSEL_LEN = 0.38; // strand length below the band (whole tassel is ~0.57)
const TASSEL_STRANDS = 14;
const TASSEL_SWING = [0.1, 0.42]; // pendulum angle (rad): at rest, per unit of wind strength
const TASSEL_SPRING = [16, 1.1]; // stiffness, damping (underdamped: it overshoots and settles)
// clothesline
const POST_H = 0.82;
const LINE_DROP = 0.04; // line is tied this far below the post tops
const LINE_SAG = 0.07;
const SWING_AMP = [0.06, 0.42]; // garment swing angle (rad): at rest, per unit of wind strength
const POKE_KICK = [3, 2]; // garment swing velocity kick on poke: base, random extra
// pinwheels
const SPIN_BASE = 1.5; // rad/s in no wind
const SPIN_GAIN = 9; // rad/s per unit of wind strength
const SPIN_INERTIA = 1.1; // 1/s: how fast the spin follows the wind
const SPIN_POKE = 16; // rad/s added by a poke
const PIN_STICK_H = 0.58;
const PIN_R = 0.17; // blade radius
// fluff
const PUFF_POOL = 10;
const PUFF_LIFE = [4, 6];
const PUFF_SIZE = 1.3;
const PUFF_DRIFT = [0.3, 2.0]; // units/s: base, per unit of wind strength

function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const sstep = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const noRaycast = () => {};

// Subdivide triangles until every edge is <= maxEdge, so flat cloth has vertices to ripple.
// Returns a non-indexed geometry with position, normal, uv.
function refine(geo, maxEdge) {
	const src = geo.index ? geo.toNonIndexed() : geo;
	const sp = src.attributes.position;
	const sn = src.attributes.normal;
	const su = src.attributes.uv;
	const vert = (i) => [sp.getX(i), sp.getY(i), sp.getZ(i), sn.getX(i), sn.getY(i), sn.getZ(i), su.getX(i), su.getY(i)];
	let tris = [];
	for (let i = 0; i < sp.count; i += 3) tris.push([vert(i), vert(i + 1), vert(i + 2)]);
	const mid = (a, b) => {
		const m = a.map((v, i) => (v + b[i]) / 2);
		const l = Math.hypot(m[3], m[4], m[5]) || 1;
		m[3] /= l;
		m[4] /= l;
		m[5] /= l;
		return m;
	};
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	for (let pass = 0; pass < 5; pass++) {
		const next = [];
		let split = false;
		for (const [a, b, c] of tris) {
			if (Math.max(dist(a, b), dist(b, c), dist(c, a)) <= maxEdge) {
				next.push([a, b, c]);
				continue;
			}
			const ab = mid(a, b);
			const bc = mid(b, c);
			const ca = mid(c, a);
			next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
			split = true;
		}
		tris = next;
		if (!split) break;
	}
	const pos = new Float32Array(tris.length * 9);
	const nor = new Float32Array(tris.length * 9);
	const uv = new Float32Array(tris.length * 6);
	tris.forEach((tri, t) => {
		tri.forEach((v, k) => {
			pos.set(v.slice(0, 3), t * 9 + k * 3);
			nor.set(v.slice(3, 6), t * 9 + k * 3);
			uv.set(v.slice(6, 8), t * 6 + k * 2);
		});
	});
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
	out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
	return out;
}

// Tapered tube blade (4 rows, 4 sides), appended to the buffers. Curls away along azimuth `az`.
function addBlade(buf, bx, bz, az, hh, curl, r0) {
	const ROWS = 4;
	const SIDES = 4;
	const dx = Math.cos(az);
	const dz = Math.sin(az);
	const rows = [];
	for (let i = 0; i < ROWS; i++) {
		const f = i / (ROWS - 1);
		const off = curl * hh * f * f;
		rows.push([bx + dx * off, hh * f, bz + dz * off, r0 * (1 - f * 0.9)]);
	}
	const b1 = [-dz, 0, dx];
	const base = buf.pos.length / 3;
	for (let i = 0; i < ROWS; i++) {
		const a = rows[Math.max(0, i - 1)];
		const b = rows[Math.min(ROWS - 1, i + 1)];
		let tx = b[0] - a[0];
		let ty = b[1] - a[1];
		let tz = b[2] - a[2];
		const tl = Math.hypot(tx, ty, tz);
		tx /= tl;
		ty /= tl;
		tz /= tl;
		// b2 = t x b1
		const b2 = [ty * b1[2] - tz * b1[1], tz * b1[0] - tx * b1[2], tx * b1[1] - ty * b1[0]];
		for (let j = 0; j <= SIDES; j++) {
			const ang = (j / SIDES) * TAU;
			const c = Math.cos(ang);
			const s = Math.sin(ang);
			const nx = c * b1[0] + s * b2[0];
			const ny = c * b1[1] + s * b2[1];
			const nz = c * b1[2] + s * b2[2];
			buf.pos.push(rows[i][0] + nx * rows[i][3], rows[i][1] + ny * rows[i][3], rows[i][2] + nz * rows[i][3]);
			buf.nor.push(nx, ny, nz);
			buf.uv.push(i / (ROWS - 1), j / SIDES);
		}
	}
	for (let i = 0; i < ROWS - 1; i++) {
		for (let j = 0; j < SIDES; j++) {
			const a = base + i * (SIDES + 1) + j;
			const b = a + 1;
			const c = a + SIDES + 1;
			const d = c + 1;
			buf.idx.push(a, b, d, a, d, c);
		}
	}
}

export function setupWindProps({ root, wind, kit, terrain }) {
	const { P } = kit;
	const items = [];
	const rand = mulberry32(31337);
	const H = terrain.H;
	const E0 = terrain.E0;
	const sE = terrain.sE;
	const dirX = wind.dir.x;
	const dirZ = wind.dir.y;

	// clone a yarn material and bend its vertices with the wind (`body` edits `transformed`)
	const windMats = new Map();
	function windMaterial(color, stitch, rep, key, body, tweak) {
		const id = `${key}|${color}|${stitch}|${rep[0]}x${rep[1]}`;
		let m = windMats.get(id);
		if (!m) {
			m = kit.mat(color, stitch, rep).clone();
			if (tweak) tweak(m);
			m.onBeforeCompile = (shader) => {
				Object.assign(shader.uniforms, wind.uniforms);
				shader.vertexShader = shader.vertexShader
					.replace('#include <common>', `#include <common>\n${WIND_GLSL}`)
					.replace('#include <begin_vertex>', `#include <begin_vertex>\n${body}`);
			};
			m.customProgramCacheKey = () => `windprops-${key}`;
			windMats.set(id, m);
		}
		return m;
	}

	// ---------------------------------------------------------------------
	// 1. Grass tufts
	// ---------------------------------------------------------------------
	const GRASS_BODY = /* glsl */ `
	{
		mat4 im = modelMatrix * instanceMatrix;
		vec2 iw = im[3].xz;
		float w = windAt(iw);
		float h = clamp(position.y / ${GRASS_H.toFixed(3)}, 0.0, 1.0);
		float h2 = h * h;
		float ph = dot(iw, vec2(12.9, 7.7));
		float vary = 0.8 + 0.4 * fract(sin(ph) * 43758.5453);
		mat3 m3 = mat3(im);
		float s2 = dot(m3[0], m3[0]);
		float lean = h2 * ${GRASS_H.toFixed(3)} * (${GRASS_LEAN[0].toFixed(3)} + ${GRASS_LEAN[1].toFixed(3)} * w) * vary;
		float fl = sin(uWindT * 2.4 + ph + h * 2.0) * 0.012 + sin(uWindT * 4.3 + ph * 1.7) * 0.006;
		vec3 push = vec3(uWindDir.x, 0.0, uWindDir.y) * lean + vec3(-uWindDir.y, 0.0, uWindDir.x) * fl * h2 * (0.5 + w);
		transformed += (transpose(m3) * push) / s2;
		transformed.y -= 0.5 * lean * lean / ${GRASS_H.toFixed(3)};
	}`;
	const grassMat = windMaterial('#ffffff', 'strand', [1, 1], 'grass', GRASS_BODY, (m) => {
		m.map = null;
		m.normalMap = null;
		m.roughnessMap = null;
	});

	const grassGeo = (variant) =>
		kit.cachedGeo(`windGrass${variant}`, () => {
			const r = mulberry32(900 + variant * 31);
			const count = [4, 5, 3][variant % 3];
			const buf = { pos: [], nor: [], uv: [], idx: [] };
			for (let b = 0; b < count; b++) {
				const a0 = (b / count) * TAU + r() * 0.8;
				const rad = 0.008 + r() * 0.022;
				const az = a0 + (r() - 0.5) * 0.9;
				const hh = b === 0 ? GRASS_H : GRASS_H * (0.72 + 0.28 * r());
				addBlade(buf, Math.cos(a0) * rad, Math.sin(a0) * rad, az, hh, 0.3 + 0.35 * r(), GRASS_BLADE_R);
			}
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
			g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
			g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
			g.setIndex(buf.idx);
			return g;
		});

	{
		const grassOk = (x, z) =>
			sE(x / H, z / H) < E0 - 0.03 &&
			terrain.isGreen(x, z) &&
			terrain.riverQuery(x, z).d > 0.9 &&
			terrain.blockers.every(([bx, bz, br]) => Math.hypot(x - bx, z - bz) > br + 0.08);
		const spots = [];
		for (let tries = 0; spots.length < GRASS_COUNT && tries < 20000; tries++) {
			const cx = (rand() * 2 - 1) * S(6.2);
			const cz = (rand() * 2 - 1) * S(6.2);
			const clump = 1 + Math.floor(rand() * 4);
			for (let k = 0; k < clump && spots.length < GRASS_COUNT; k++) {
				const x = cx + (rand() - 0.5) * 0.5;
				const z = cz + (rand() - 0.5) * 0.5;
				if (grassOk(x, z)) spots.push([x, z]);
			}
		}
		// 2 x 4 spatial clusters
		const buckets = Array.from({ length: 8 }, () => []);
		for (const s of spots) {
			const band = s[1] < S(-2.5) ? 0 : s[1] < 0 ? 1 : s[1] < S(2.5) ? 2 : 3;
			buckets[(s[0] < 0 ? 0 : 4) + band].push(s);
		}
		const shades = [P.olive, P.pine, P.grass, P.sage];
		const m4 = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const pos = new THREE.Vector3();
		const scl = new THREE.Vector3();
		const up = new THREE.Vector3(0, 1, 0);
		const col = new THREE.Color();
		buckets.forEach((list, ci) => {
			if (!list.length) return;
			const group = new THREE.Group();
			root.add(group);
			const mesh = new THREE.InstancedMesh(grassGeo(ci % 3), grassMat, list.length);
			let mx = 0;
			let mz = 0;
			list.forEach(([x, z], i) => {
				const s = 0.7 + 0.3 * rand();
				pos.set(x, terrain.heightAt(x, z) - 0.01, z);
				q.setFromAxisAngle(up, rand() * TAU);
				scl.setScalar(s);
				mesh.setMatrixAt(i, m4.compose(pos, q, scl));
				col.set(shades[Math.floor(rand() * shades.length)]).offsetHSL(0, 0, (rand() - 0.5) * 0.06);
				mesh.setColorAt(i, col);
				mx += x;
				mz += z;
			});
			mx /= list.length;
			mz /= list.length;
			mesh.castShadow = false;
			mesh.receiveShadow = true;
			group.add(mesh);
			items.push({ obj: group, stage: 'grass', clip: true, base: new THREE.Vector3(mx, terrain.heightAt(mx, mz), mz) });
		});
	}

	// ---------------------------------------------------------------------
	// 2. Corner tassels
	// ---------------------------------------------------------------------
	const TASSEL_BODY = /* glsl */ `
	{
		float f = clamp(-(position.y + 0.19) / ${TASSEL_LEN.toFixed(3)}, 0.0, 1.0);
		float w = windAt(modelMatrix[3].xz);
		vec3 wl = transpose(mat3(modelMatrix)) * vec3(uWindDir.x, 0.0, uWindDir.y);
		float ph = dot(modelMatrix[3].xz, vec2(3.7, 5.1)) + position.x * 9.0 + position.z * 6.0;
		float a = f * f * (0.02 + 0.05 * w);
		transformed.xz += wl.xz * a;
		transformed.x += sin(uWindT * 3.2 + ph) * 0.01 * f * (0.4 + w);
		transformed.z += cos(uWindT * 2.7 + ph * 1.3) * 0.01 * f * (0.4 + w);
	}`;

	const tassels = [];
	const _p = new THREE.Vector3();
	[
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
	].forEach(([sx, sz], k) => {
		// march along the diagonal until the rounded-square norm reaches TASSEL_E (bisection)
		let lo = 0;
		let hi = H * 1.6;
		for (let i = 0; i < 40; i++) {
			const mid = (lo + hi) / 2;
			if (sE((mid * sx) / H, (mid * sz) / H) < TASSEL_E) lo = mid;
			else hi = mid;
		}
		const t = (lo + hi) / 2;
		terrain.surf(sx * t, sz * t, 0, _p);
		const ox = sx * Math.SQRT1_2;
		const oz = sz * Math.SQRT1_2;

		const group = new THREE.Group();
		group.position.set(_p.x + ox * TASSEL_OUT, _p.y, _p.z + oz * TASSEL_OUT);
		root.add(group);

		// knot ball, cap band, strand bundle
		kit.sphere(group, 0.065, kit.mat(P.coral, 'boucle', kit.sphereRep(0.065)), 0, -0.065, 0);
		const bandGeo = kit.cachedGeo('windTasselBand', () => new THREE.CylinderGeometry(0.052, 0.058, 0.07, 12));
		kit.add(group, new THREE.Mesh(bandGeo, kit.mat(P.cream, 'garter', [8, 2]))).position.y = -0.165;
		const lists = [[], []];
		for (let i = 0; i < TASSEL_STRANDS; i++) {
			const phi = (i / TASSEL_STRANDS) * TAU + rand() * 0.3;
			const c = Math.cos(phi);
			const s = Math.sin(phi);
			const r0 = 0.035;
			const r1 = 0.075 + rand() * 0.04;
			const len = TASSEL_LEN * (0.88 + 0.12 * rand());
			const y0 = -0.19;
			const rm = r0 + (r1 - r0) * 0.3;
			const jx = (rand() - 0.5) * 0.012;
			const jz = (rand() - 0.5) * 0.012;
			const curve = new THREE.CatmullRomCurve3([
				new THREE.Vector3(c * r0, y0, s * r0),
				new THREE.Vector3(c * rm + jx, y0 - len * 0.4, s * rm + jz),
				new THREE.Vector3(c * r1, y0 - len, s * r1),
			]);
			lists[i % 2].push(new THREE.TubeGeometry(curve, 8, 0.016, 5, false));
		}
		[P.coral, P.coralDeep].forEach((color, ci) => {
			const geo = mergeGeometries(lists[ci]);
			lists[ci].forEach((g) => g.dispose());
			const m = windMaterial(color, 'strand', kit.strandRep(TASSEL_LEN, 4, 0.12), 'tassel', TASSEL_BODY);
			kit.add(group, new THREE.Mesh(geo, m));
		});

		const tl = {
			group,
			ox,
			oz,
			cx: group.position.x,
			cz: group.position.z,
			phase: rand() * TAU,
			sx: new Spring(TASSEL_SPRING[0] * (0.9 + 0.2 * rand()), TASSEL_SPRING[1], 0),
			sz: new Spring(TASSEL_SPRING[0] * (0.9 + 0.2 * rand()), TASSEL_SPRING[1], 0),
		};
		group.userData.onPoke = () => {
			tl.sx.kick((rand() - 0.5) * 6);
			tl.sz.kick((rand() - 0.5) * 6);
			playFlap();
		};
		tassels.push(tl);
		items.push({ obj: group, stage: 'prop' });
	});

	// ---------------------------------------------------------------------
	// 3. Clothesline
	// ---------------------------------------------------------------------
	const lineG = new THREE.Group();
	root.add(lineG);

	// keep both posts clear of blockers and the river; slide the line sideways if needed
	const free = (x, z) =>
		terrain.riverQuery(x, z).d > 1.0 && terrain.blockers.every(([bx, bz, br]) => Math.hypot(x - bx, z - bz) > br + 0.1);
	let [ax, az] = CLOTHESLINE[0];
	let [bx, bz] = CLOTHESLINE[1];
	{
		const l = Math.hypot(bx - ax, bz - az);
		const nx = -(bz - az) / l;
		const nz = (bx - ax) / l;
		for (const k of [0, 1, -1, 2, -2, 3, -3]) {
			const o = k * 0.25;
			if (free(ax + nx * o, az + nz * o) && free(bx + nx * o, bz + nz * o)) {
				ax += nx * o;
				az += nz * o;
				bx += nx * o;
				bz += nz * o;
				break;
			}
		}
	}
	const woodMat = kit.mat(P.wood, 'stockinette', [3, 8]);
	const capMat = kit.mat(P.cream, 'boucle', kit.sphereRep(0.045));
	const postGeo = kit.cachedGeo('windPost', () => new THREE.CylinderGeometry(0.028, 0.036, POST_H, 8));
	const topA = new THREE.Vector3(ax, terrain.heightAt(ax, az) + POST_H - LINE_DROP, az);
	const topB = new THREE.Vector3(bx, terrain.heightAt(bx, bz) + POST_H - LINE_DROP, bz);
	for (const [x, z] of [
		[ax, az],
		[bx, bz],
	]) {
		const y = terrain.heightAt(x, z);
		kit.add(lineG, new THREE.Mesh(postGeo, woodMat)).position.set(x, y + POST_H / 2, z);
		kit.sphere(lineG, 0.045, capMat, x, y + POST_H + 0.01, z);
	}
	const lineLen = Math.hypot(bx - ax, bz - az);
	{
		const pts = [];
		for (let i = 0; i <= 8; i++) {
			const s = i / 8;
			pts.push(
				new THREE.Vector3(
					THREE.MathUtils.lerp(topA.x, topB.x, s),
					THREE.MathUtils.lerp(topA.y, topB.y, s) - LINE_SAG * 4 * s * (1 - s),
					THREE.MathUtils.lerp(topA.z, topB.z, s),
				),
			);
		}
		const curve = new THREE.CatmullRomCurve3(pts);
		const geo = new THREE.TubeGeometry(curve, 24, 0.011, 5, false);
		kit.add(lineG, new THREE.Mesh(geo, kit.mat(P.cream, 'strand', kit.strandRep(curve.getLength(), 8, 0.12))));
	}

	// garments hang in a frame whose +x runs along the line
	const frame = new THREE.Group();
	const yaw = Math.atan2(-(bz - az), bx - ax);
	frame.position.copy(topA);
	frame.rotation.y = yaw;
	lineG.add(frame);
	const sinY = Math.sin(yaw);
	const cosY = Math.cos(yaw);

	const CLOTH_BODY = /* glsl */ `
	{
		float w = windAt(modelMatrix[3].xz);
		vec3 wl = transpose(mat3(modelMatrix)) * vec3(uWindDir.x, 0.0, uWindDir.y);
		float f = clamp(-position.y / 0.3, 0.0, 1.0);
		f *= f;
		float ph = dot(modelMatrix[3].xz, vec2(5.3, 3.1));
		float rip = sin(uWindT * (2.6 + 3.0 * w) + position.x * 16.0 - position.y * 8.0 + ph);
		float push = (0.01 + 0.045 * w) * f;
		transformed.z += wl.z * push + rip * (0.003 + 0.012 * w) * f;
		transformed.x += wl.x * push * 0.4;
		transformed.y += abs(wl.z) * push * 0.35;
	}`;
	const cloth = (color, stitch) => windMaterial(color, stitch, [16, 16], 'cloth', CLOTH_BODY);
	const extrude = (points, depth = 0.012) => {
		const shape = new THREE.Shape();
		points.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
		shape.closePath();
		const g = new THREE.ExtrudeGeometry(shape, {
			depth,
			bevelEnabled: true,
			bevelThickness: 0.007,
			bevelSize: 0.007,
			bevelSegments: 2,
			curveSegments: 4,
		});
		g.translate(0, 0, -depth / 2);
		return refine(g, 0.04);
	};
	const rect = (x0, y0, x1, y1) => [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	];
	const pegGeo = (xs) =>
		kit.cachedGeo(`windPegs${xs.join(',')}`, () => {
			const parts = xs.map((x) => new THREE.BoxGeometry(0.02, 0.055, 0.045).translate(x, -0.004, 0));
			const g = mergeGeometries(parts);
			parts.forEach((p) => p.dispose());
			return g;
		});
	const pegMat = kit.mat(P.wood, 'stockinette', [1, 2]);

	const sweater = () =>
		new THREE.Mesh(
			extrude([
				[-0.07, 0],
				[-0.04, -0.03],
				[0.04, -0.03],
				[0.07, 0],
				[0.2, -0.035],
				[0.21, -0.18],
				[0.15, -0.18],
				[0.11, -0.09],
				[0.11, -0.27],
				[-0.11, -0.27],
				[-0.11, -0.09],
				[-0.15, -0.18],
				[-0.21, -0.18],
				[-0.2, -0.035],
			]),
			cloth(P.sky, 'stockinette'),
		);
	const sock = (color) => {
		const body = extrude([
			[-0.035, 0],
			[0.035, 0],
			[0.035, -0.15],
			[0.095, -0.165],
			[0.108, -0.205],
			[0.09, -0.238],
			[-0.035, -0.238],
		]);
		const cuff = extrude(rect(-0.037, 0, 0.037, -0.045), 0.018);
		const g = mergeGeometries([body, cuff], true);
		body.dispose();
		cuff.dispose();
		return new THREE.Mesh(g, [cloth(color, 'rib'), cloth(P.cream, 'garter')]);
	};
	const scarf = () => {
		const stripes = [];
		const mats = [];
		for (let i = 0; i < 8; i++) {
			stripes.push(extrude(rect(-0.048, -i * 0.042 - 0.007, 0.048, -i * 0.042 - 0.035)));
			mats.push(cloth(i % 2 ? P.cream : P.coral, 'garter'));
		}
		const g = mergeGeometries(stripes, true);
		stripes.forEach((s) => s.dispose());
		return new THREE.Mesh(g, mats);
	};

	const garments = [
		{ s: 0.2, mesh: sweater, pegs: [-0.1, 0.1], k: 30, c: 2.2 },
		{ s: 0.42, mesh: () => sock(P.mustard), pegs: [-0.02, 0.022], k: 55, c: 2.4 },
		{ s: 0.58, mesh: () => sock(P.lavender), pegs: [-0.02, 0.022], k: 55, c: 2.4 },
		{ s: 0.8, mesh: scarf, pegs: [-0.035, 0.035], k: 36, c: 2.2 },
	].map((spec) => {
		const g = new THREE.Group();
		const s = spec.s;
		g.position.set(
			s * lineLen,
			THREE.MathUtils.lerp(0, topB.y - topA.y, s) - LINE_SAG * 4 * s * (1 - s),
			0,
		);
		frame.add(g);
		const mesh = spec.mesh();
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		g.add(mesh);
		kit.add(g, new THREE.Mesh(pegGeo(spec.pegs), pegMat));
		return { g, spring: new Spring(spec.k, spec.c, 0), phase: rand() * TAU };
	});

	lineG.userData.onPoke = () => {
		for (const gm of garments) gm.spring.kick((rand() < 0.5 ? -1 : 1) * (POKE_KICK[0] + rand() * POKE_KICK[1]));
		playFlap();
	};
	{
		const mx = (ax + bx) / 2;
		const mz = (az + bz) / 2;
		items.push({ obj: lineG, stage: 'prop', base: new THREE.Vector3(mx, terrain.heightAt(mx, mz), mz) });
	}
	const lineCx = (ax + bx) / 2;
	const lineCz = (az + bz) / 2;
	// wind component along the garments' normal (local +z in world is (sinY, cosY))
	const lineNormal = dirX * sinY + dirZ * cosY;

	// ---------------------------------------------------------------------
	// 4. Pinwheels
	// ---------------------------------------------------------------------
	const bladeGeo = (ang0) => {
		// sector of 72 degrees, curled toward the viewer along its leading edge
		const NA = 6;
		const NR = 5;
		const pos = [];
		const uv = [];
		const idx = [];
		for (let i = 0; i <= NA; i++) {
			const a = i / NA;
			const ang = ang0 + a * 1.26;
			for (let j = 0; j <= NR; j++) {
				const rr = (j / NR) * PIN_R;
				const x = Math.cos(ang) * rr;
				const y = Math.sin(ang) * rr;
				pos.push(x, y, 0.07 * (j / NR) * Math.pow(a, 1.5));
				uv.push(x, y);
			}
		}
		for (let i = 0; i < NA; i++) {
			for (let j = 0; j < NR; j++) {
				const a = i * (NR + 1) + j;
				idx.push(a, a + NR + 1, a + 1, a + 1, a + NR + 1, a + NR + 2);
			}
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
		g.setIndex(idx);
		g.computeVertexNormals();
		return g;
	};
	const bladePair = (name, a, b) =>
		kit.cachedGeo(name, () => {
			const parts = [bladeGeo(a), bladeGeo(b)];
			const g = mergeGeometries(parts);
			parts.forEach((p) => p.dispose());
			return g;
		});
	const geoA = bladePair('windBladesA', 0, Math.PI);
	const geoB = bladePair('windBladesB', Math.PI / 2, (Math.PI * 3) / 2);
	const feltMat = (color) => {
		const m = kit.mat(color, 'stockinette', [10, 10]).clone();
		m.side = THREE.DoubleSide;
		return m;
	};
	const stickGeo = kit.cachedGeo('windStick', () => new THREE.CylinderGeometry(0.011, 0.014, PIN_STICK_H, 6));
	const stickMat = kit.mat(P.wood, 'stockinette', [1, 4]);

	const pinwheels = [];
	const pinSpot = (cx, cz) => {
		const prefer = Math.atan2(0.77, 0.63); // toward the default camera
		for (const da of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.2, -2.2, Math.PI]) {
			const x = cx + Math.cos(prefer + da) * 0.6;
			const z = cz + Math.sin(prefer + da) * 0.6;
			if (
				sE(x / H, z / H) < E0 - 0.15 &&
				terrain.riverQuery(x, z).d > 1.0 &&
				terrain.blockers.every(([bx2, bz2, br]) => Math.hypot(x - bx2, z - bz2) > br + 0.2)
			) {
				return [x, z];
			}
		}
		return [cx + Math.cos(prefer) * 0.6, cz + Math.sin(prefer) * 0.6];
	};
	// axle direction: mostly toward the camera so the face reads, turned a bit toward the wind
	const axX = 0.257 / Math.hypot(0.257, 0.946);
	const axZ = 0.946 / Math.hypot(0.257, 0.946);
	[
		[...FLOWER_CLUSTERS[1], [P.coral, P.cream]],
		[...FLOWER_CLUSTERS[0], [P.sky, P.mustard]],
	].forEach(([cx, cz, [cA, cB]]) => {
		const [x, z] = pinSpot(cx, cz);
		const g = new THREE.Group();
		g.position.set(x, terrain.heightAt(x, z), z);
		root.add(g);
		kit.add(g, new THREE.Mesh(stickGeo, stickMat)).position.y = PIN_STICK_H / 2;
		const head = new THREE.Group();
		head.position.set(axX * 0.035, PIN_STICK_H - 0.02, axZ * 0.035);
		head.rotation.y = Math.atan2(axX, axZ);
		g.add(head);
		const spinner = new THREE.Group();
		head.add(spinner);
		kit.add(spinner, new THREE.Mesh(geoA, feltMat(cA)));
		kit.add(spinner, new THREE.Mesh(geoB, feltMat(cB)));
		kit.sphere(head, 0.03, kit.mat(P.white, 'boucle', kit.sphereRep(0.03)), 0, 0, 0.055);
		const pw = { g, spinner, x, z, omega: SPIN_BASE, angle: rand() * TAU, lx: 0, lz: 0 };
		g.userData.onPoke = () => {
			pw.omega += SPIN_POKE;
			playWhirr();
		};
		pinwheels.push(pw);
		items.push({ obj: g, stage: 'prop' });
	});

	// ---------------------------------------------------------------------
	// 5. Fluff
	// ---------------------------------------------------------------------
	const puffGeo = kit.cachedGeo('windPuff', () => {
		const parts = [new THREE.SphereGeometry(0.02, 10, 8)];
		for (let i = 0; i < 9; i++) {
			const ray = new THREE.CylinderGeometry(0.0012, 0.0035, 0.075, 4, 1);
			ray.translate(0, 0.0375, 0);
			ray.rotateZ(0.5 + (i % 3) * 0.35);
			ray.rotateY(i * 2.4);
			parts.push(ray);
		}
		const g = mergeGeometries(parts);
		parts.forEach((p) => p.dispose());
		return g;
	});
	const puffMat = new THREE.MeshStandardMaterial({
		color: P.white,
		roughness: 1,
		emissive: P.white,
		emissiveIntensity: 0.25,
	});
	const puffs = [];
	for (let i = 0; i < PUFF_POOL; i++) {
		const mesh = new THREE.Mesh(puffGeo, puffMat);
		mesh.visible = false;
		mesh.raycast = noRaycast;
		mesh.castShadow = false;
		root.add(mesh);
		puffs.push({ mesh, active: false, age: 0, life: 5, x: 0, z: 0, y0: 0, phase: 0 });
	}
	const areas = FLOWER_CLUSTERS.map(([cx, cz]) => ({ cx, cz, s: cx * dirX + cz * dirZ }));
	const gu = wind.uniforms;
	let prevS = gu.uGustS.value;

	function spawnPuffs(area) {
		const n = 2 + (Math.random() < 0.5 ? 1 : 0);
		for (let k = 0; k < n; k++) {
			const p = puffs.find((q) => !q.active);
			if (!p) return;
			p.active = true;
			p.age = 0;
			p.life = PUFF_LIFE[0] + Math.random() * (PUFF_LIFE[1] - PUFF_LIFE[0]);
			p.x = area.cx + (Math.random() - 0.5) * 0.8;
			p.z = area.cz + (Math.random() - 0.5) * 0.8;
			p.y0 = terrain.heightAt(p.x, p.z) + 0.22;
			p.phase = Math.random() * TAU;
			p.mesh.visible = true;
			p.mesh.scale.setScalar(0.001);
		}
	}

	// ---------------------------------------------------------------------
	// per frame
	// ---------------------------------------------------------------------
	function update(t, dt) {
		// tassels: pendulum along the wind, kept from swinging into the cushion
		for (const tl of tassels) {
			const w = wind.at(tl.cx, tl.cz);
			const amp = TASSEL_SWING[0] + TASSEL_SWING[1] * w;
			let tx = dirX * amp;
			let tz = dirZ * amp;
			const inward = tx * tl.ox + tz * tl.oz;
			if (inward < 0) {
				tx -= inward * 0.7 * tl.ox;
				tz -= inward * 0.7 * tl.oz;
			}
			tx += 0.03 * Math.sin(t * 1.1 + tl.phase) + 0.015 * Math.sin(t * 2.3 + tl.phase * 2);
			tz += 0.03 * Math.cos(t * 0.9 + tl.phase);
			tl.sx.target = tx;
			tl.sz.target = tz;
			tl.group.rotation.x = -tl.sz.update(dt);
			tl.group.rotation.z = tl.sx.update(dt);
		}

		// garments: swing about the line, pushed along their normal by the wind
		const lw = wind.at(lineCx, lineCz);
		const push = lineNormal * (SWING_AMP[0] + SWING_AMP[1] * lw);
		for (const gm of garments) {
			gm.spring.target = -push + 0.03 * (0.4 + lw) * Math.sin(t * 2.1 + gm.phase);
			gm.g.rotation.x = gm.spring.update(dt);
		}

		// pinwheels: spin follows the wind with inertia; the stick leans downwind
		for (const pw of pinwheels) {
			const w = wind.at(pw.x, pw.z);
			pw.omega += (SPIN_BASE + SPIN_GAIN * w - pw.omega) * Math.min(1, dt * SPIN_INERTIA);
			pw.angle += pw.omega * dt;
			pw.spinner.rotation.z = pw.angle;
			const lean = 0.03 + 0.07 * w;
			const k = Math.min(1, dt * 2);
			pw.lx += (dirX * lean - pw.lx) * k;
			pw.lz += (dirZ * lean - pw.lz) * k;
			pw.g.rotation.x = -pw.lz;
			pw.g.rotation.z = pw.lx;
		}

		// fluff: lift off when the gust band crosses a flower area, drift downwind, shrink away
		const S = gu.uGustS.value;
		if (gu.uGustAmp.value > 0.3) {
			for (const a of areas) if (prevS < a.s && S >= a.s) spawnPuffs(a);
		}
		prevS = S;
		for (const p of puffs) {
			if (!p.active) continue;
			p.age += dt;
			if (p.age >= p.life) {
				p.active = false;
				p.mesh.visible = false;
				continue;
			}
			const w = wind.at(p.x, p.z);
			const speed = PUFF_DRIFT[0] + PUFF_DRIFT[1] * w;
			const curl = 0.25 * Math.cos(p.age * 1.3 + p.phase);
			p.x += (dirX * speed - dirZ * curl) * dt;
			p.z += (dirZ * speed + dirX * curl) * dt;
			if (sE(p.x / H, p.z / H) > 1.0 && p.life > p.age + 0.8) p.life = p.age + 0.8;
			const y = p.y0 + 0.55 * (1 - Math.exp(-p.age * 1.4)) + 0.08 * Math.sin(p.age * 2.1 + p.phase);
			const sc = PUFF_SIZE * sstep(0, 0.5, p.age) * (1 - sstep(p.life - 1.2, p.life, p.age));
			p.mesh.position.set(p.x, y, p.z);
			p.mesh.scale.setScalar(Math.max(0.001, sc));
			p.mesh.rotation.z = 0.5 * Math.sin(p.age * 1.2 + p.phase);
			p.mesh.rotation.y += dt * 0.8;
		}
	}

	function reset() {
		for (const tl of tassels) {
			tl.sx.snap(0);
			tl.sz.snap(0);
			tl.group.rotation.set(0, 0, 0);
		}
		for (const gm of garments) {
			gm.spring.snap(0);
			gm.g.rotation.x = 0;
		}
		for (const pw of pinwheels) {
			pw.omega = SPIN_BASE;
			pw.lx = 0;
			pw.lz = 0;
		}
		for (const p of puffs) {
			p.active = false;
			p.mesh.visible = false;
		}
		prevS = gu.uGustS.value;
	}

	return { update, items, reset };
}
