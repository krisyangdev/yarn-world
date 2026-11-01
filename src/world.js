import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { yarnMaterial } from './knit.js';
import { addFuzz } from './fuzz.js';
import { setupReactions } from './reactions.js';
import { Rope } from './rope.js';
import { setupYarnBall } from './yarnball.js';
import { setupUnravel } from './unravel.js';
import { setupWeave } from './weave.js';
import { setupSheepLife } from './sheeplife.js';
import { createWind } from './wind.js';
import { setupWindProps } from './windprops.js';
import { setupWater } from './water.js';
import { patchRiver } from './riversurface.js';
import { setupCritters } from './critters.js';
import { setupGroundArt } from './groundart.js';
import { setupSmoke } from './smoke.js';
import { setupMeadow } from './meadow.js';
import { setupKite } from './kite.js';
import { buildBlanket } from './blanket.js';
import { LAYOUT, L, S, H, ROLL, HOUSE, BALL, FLOWER_CLUSTERS } from './layout.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const P = {
	cream: '#f6ecdc',
	white: '#fbf4ea',
	sage: '#a8c09a',
	grass: '#8fb57a',
	olive: '#6f8f5a',
	pine: '#5f8450',
	mustard: '#e2b04a',
	terracotta: '#d0694a',
	brick: '#b85a40',
	coral: '#ef8f86',
	coralDeep: '#e27b76',
	pink: '#f4a79d',
	sky: '#8ec5df',
	lavender: '#b8a6d9',
	charcoal: '#3b3633',
	wood: '#b07a4a',
	roof: '#9a6240',
	stone: '#aaa49c',
	stone2: '#bab4aa',
};

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------
function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// Terrain model: value noise, rounded-square island, river channel
// ---------------------------------------------------------------------------
const E0 = 1 - ROLL / H; // normalized radius where the cushion edge starts rolling down
// point in front of the cottage that its door faces
const HOUSE_FACING = L(0.9, 0.1);

const NOISE_N = 64;
const lattice = (() => {
	const r = mulberry32(77);
	const a = new Float32Array(NOISE_N * NOISE_N);
	for (let i = 0; i < a.length; i++) a[i] = r();
	return a;
})();
const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const sstep = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

function vnoise(x, z) {
	const xi = Math.floor(x);
	const zi = Math.floor(z);
	const u = quintic(x - xi);
	const v = quintic(z - zi);
	const g = (i, j) => lattice[(j & 63) * NOISE_N + (i & 63)];
	const a = g(xi, zi);
	const b = g(xi + 1, zi);
	const c = g(xi, zi + 1);
	const d = g(xi + 1, zi + 1);
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const fbm = (x, z) =>
	0.6 * vnoise(x * 0.2 + 3.1, z * 0.2 + 1.7) +
	0.28 * vnoise(x * 0.45 + 11, z * 0.45 + 5) +
	0.12 * vnoise(x * 1.0 + 2, z * 1.0 + 8);

// near-square superellipse metric: 1 on the island outline
const sE = (gx, gz) => {
	const a = gx * gx;
	const b = gz * gz;
	return Math.pow(a * a * a * a + b * b * b * b, 0.125);
};

// hills without house flattening or river carving
function rawHeight(x, z) {
	const fade = 1 - sstep(0.5, 0.9, sE(x / H, z / H));
	let h = 0.4 + (fbm(x / LAYOUT, z / LAYOUT) - 0.48) * 2.4;
	h += 0.75 * Math.exp(-((x - BALL.x) ** 2 + (z - BALL.z) ** 2) / (2 * 1.2 * 1.2));
	return h * fade;
}
const HOUSE_Y = rawHeight(HOUSE.x, HOUSE.z);

function baseHeight(x, z) {
	const h = rawHeight(x, z);
	const w = 1 - sstep(1.0, 2.1, Math.hypot(x - HOUSE.x, z - HOUSE.z));
	return h + (HOUSE_Y - h) * w;
}

// River: centerline curve in the xz plane, ends on the rolled edge on both sides
const riverCurve = new THREE.CatmullRomCurve3(
	[
		L(-7.2, -3.2),
		L(-4.8, -3.5),
		L(-3.0, -2.1),
		L(-1.5, -0.5),
		L(0.3, 0.3),
		L(1.9, -0.1),
		L(3.3, 0.9),
		L(3.9, 2.6),
		L(3.5, 4.3),
		L(4.4, 5.8),
		L(6.4, 6.7),
	].map(([x, z]) => new THREE.Vector3(x, 0, z)),
);
const RIVER_N = 120;
const rX = new Float32Array(RIVER_N + 1);
const rZ = new Float32Array(RIVER_N + 1);
const rBed = new Float32Array(RIVER_N + 1);
riverCurve.getPoints(RIVER_N).forEach((p, i) => {
	rX[i] = p.x;
	rZ[i] = p.z;
	rBed[i] = baseHeight(p.x, p.z) - 0.28;
});

// nearest point on the river centerline; result lives in the shared object `rq`
const rq = { d: 0, bed: 0, nx: 0, nz: 0 };
function riverQuery(x, z) {
	let best = Infinity;
	for (let i = 0; i < RIVER_N; i++) {
		const ax = rX[i];
		const az = rZ[i];
		const bx = rX[i + 1] - ax;
		const bz = rZ[i + 1] - az;
		const l2 = bx * bx + bz * bz;
		let t = l2 > 0 ? ((x - ax) * bx + (z - az) * bz) / l2 : 0;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const px = ax + bx * t;
		const pz = az + bz * t;
		const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
		if (d2 < best) {
			best = d2;
			rq.nx = px;
			rq.nz = pz;
			rq.bed = rBed[i] + (rBed[i + 1] - rBed[i]) * t;
		}
	}
	rq.d = Math.sqrt(best);
	return rq;
}

// final terrain height: hills + house pad + river channel
function heightAt(x, z) {
	let h = baseHeight(x, z);
	riverQuery(x, z);
	const w = 1 - sstep(0.5, 1.8, rq.d);
	if (w > 0) h += (rq.bed - h) * w;
	return h;
}

// Fast ground sampler for physics: heightAt (plus the river ribbon on top of the channel)
// baked once on a grid, sampled bilinearly. Outside the grid it clamps to the edge.
const GROUND_N = Math.round(256 * LAYOUT);
const GROUND_STEP = (2 * H) / GROUND_N;
const RIBBON_HALF = 0.52;
const groundGrid = (() => {
	const n = GROUND_N + 1;
	const a = new Float32Array(n * n);
	for (let j = 0; j < n; j++) {
		for (let i = 0; i < n; i++) {
			const x = -H + i * GROUND_STEP;
			const z = -H + j * GROUND_STEP;
			let h = heightAt(x, z);
			// heightAt left the river query for this point in `rq`
			const k = 1 - sstep(RIBBON_HALF - 0.08, RIBBON_HALF, rq.d);
			if (k > 0) h += k * (0.035 + 0.045 * (1 - Math.min(1, (rq.d / RIBBON_HALF) ** 2)));
			a[j * n + i] = h;
		}
	}
	return a;
})();

export function groundAt(x, z) {
	const n = GROUND_N + 1;
	let fx = (x + H) / GROUND_STEP;
	let fz = (z + H) / GROUND_STEP;
	fx = fx < 0 ? 0 : fx > GROUND_N ? GROUND_N : fx;
	fz = fz < 0 ? 0 : fz > GROUND_N ? GROUND_N : fz;
	let i = fx | 0;
	let j = fz | 0;
	if (i > GROUND_N - 1) i = GROUND_N - 1;
	if (j > GROUND_N - 1) j = GROUND_N - 1;
	const u = fx - i;
	const v = fz - j;
	const o = j * n + i;
	const top = groundGrid[o] + (groundGrid[o + 1] - groundGrid[o]) * u;
	const bot = groundGrid[o + n] + (groundGrid[o + n + 1] - groundGrid[o + n]) * u;
	return top + (bot - top) * v;
}

// Point on the rendered surface for plane coords (x, z), including the rolled cushion
// edge. `lift` moves the point along the surface normal.
function surf(x, z, lift, out) {
	const gx = x / H;
	const gz = z / H;
	const e = sE(gx, gz);
	if (e <= E0) return out.set(x, heightAt(x, z) + lift, z);
	const k = E0 / e;
	const px = x * k;
	const pz = z * k;
	const h0 = heightAt(px, pz);
	const th = Math.min(1, (e - E0) / (1 - E0)) * Math.PI * 0.5;
	// outward direction: smooth "dominant axis" of the square outline
	const ax = Math.sign(gx) * Math.abs(gx) ** 8;
	const az = Math.sign(gz) * Math.abs(gz) ** 8;
	const l = Math.hypot(ax, az) || 1;
	const r = ROLL + lift;
	return out.set(px + (ax / l) * r * Math.sin(th), h0 - ROLL + r * Math.cos(th), pz + (az / l) * r * Math.sin(th));
}

// move (x, z) out of the river channel
function settle(x, z, minD) {
	for (let k = 0; k < 10; k++) {
		riverQuery(x, z);
		if (rq.d >= minD) break;
		const dx = x - rq.nx;
		const dz = z - rq.nz;
		const l = Math.hypot(dx, dz) || 1;
		const push = minD - rq.d + 0.05;
		x += (dx / l) * push;
		z += (dz / l) * push;
	}
	return [x, z];
}

// ---------------------------------------------------------------------------
// Material / geometry caches
// ---------------------------------------------------------------------------
const matCache = new Map();
// color2 + pattern ('stripe' | 'check' | 'fairisle') bake colorwork into the color map
function mat(color, stitch, rep, color2, pattern) {
	const key = `${color}|${stitch}|${rep[0]}x${rep[1]}|${color2 ?? ''}|${pattern ?? ''}`;
	let m = matCache.get(key);
	if (!m) {
		m = yarnMaterial({ color, color2, pattern, stitch, repeat: rep });
		matCache.set(key, m);
	}
	return m;
}
// quantize a stitch count so materials get reused
const qn = (n, q) => Math.max(q, Math.round(n / q) * q);
// repeat for a sphere of radius r: one stitch ~0.1 units
const sphereRep = (r) => {
	const u = qn((Math.PI * 2 * r) / 0.1, 4);
	return [u, u / 2];
};
// one 'strand' tile = 2 ply twists; twist = twist length in world units
const strandRep = (len, q = 8, twist = 0.2) => [qn(len / (twist * 2), q), 1];

const geoCache = new Map();
function cachedGeo(key, make) {
	let g = geoCache.get(key);
	if (!g) {
		g = make();
		geoCache.set(key, g);
	}
	return g;
}
const sphereGeo = (r) => cachedGeo(`s${r}`, () => new THREE.SphereGeometry(r, 32, 22));

const eyeMat = new THREE.MeshStandardMaterial({ color: '#0d0b0b', roughness: 0.2, metalness: 0 });
const woodMat = new THREE.MeshStandardMaterial({ color: P.wood, roughness: 0.6, metalness: 0 });
const doorwayMat = new THREE.MeshStandardMaterial({ color: '#2b2522', roughness: 0.9, metalness: 0 });
const paneMat = new THREE.MeshStandardMaterial({
	color: '#ffe3a0',
	emissive: '#ffb84a',
	emissiveIntensity: 0.45,
	roughness: 0.4,
});

function add(parent, mesh) {
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	parent.add(mesh);
	return mesh;
}
function sphere(parent, r, material, x, y, z) {
	const m = add(parent, new THREE.Mesh(sphereGeo(r), material));
	m.position.set(x, y, z);
	return m;
}

// ---------------------------------------------------------------------------
// Ground: quilt patches, cushion rim, seams
// ---------------------------------------------------------------------------
const CUT_X = [S(-3.4), S(0.2), S(3.4)];
const CUT_Z = [S(-3.0), S(0.4), S(3.6)];
const wobbleX = (z) => 0.5 * Math.sin((z / LAYOUT) * 0.55 + 1.1) + 0.25 * Math.sin((z / LAYOUT) * 1.3 + 0.4);
const wobbleZ = (x) => 0.5 * Math.sin((x / LAYOUT) * 0.5 + 2.0) + 0.25 * Math.sin((x / LAYOUT) * 1.2 + 1.7);

// [iz][ix] -> [color, stitch, swapUV, color2?, pattern?]
const CELLS = [
	[[P.sage, 'rib', 0], [P.grass, 'cable', 0], [P.olive, 'seed', 0], [P.sage, 'garter', 0]],
	[[P.grass, 'stockinette', 1], [P.olive, 'stockinette', 0, P.cream, 'fairisle'], [P.grass, 'rib', 1], [P.mustard, 'stockinette', 0]],
	[[P.lavender, 'rib', 1], [P.grass, 'stockinette', 0, P.coral, 'stripe'], [P.olive, 'cable', 1], [P.grass, 'seed', 0]],
	[[P.sage, 'stockinette', 0], [P.mustard, 'seed', 0], [P.lavender, 'stockinette', 0], [P.grass, 'stockinette', 0, P.cream, 'check']],
];
// repeat of a patch per stitch kind: tiles hold 4 to 8 columns, this keeps stitches ~0.1 to 0.13 units at any island size
const rep = (n) => Math.round(n * LAYOUT);
const PATCH_REP = {
	stockinette: [rep(30), rep(30)],
	rib: [rep(30), rep(30)],
	garter: [rep(30), rep(30)],
	seed: [rep(20), rep(20)],
	cable: [rep(14), rep(14)],
};
const RIM = 16;

function patchId(x, z) {
	if (sE(x / H, z / H) > E0) return RIM;
	const wx = x + wobbleX(z);
	const wz = z + wobbleZ(x);
	const ix = CUT_X.filter((c) => wx > c).length;
	const iz = CUT_Z.filter((c) => wz > c).length;
	return iz * 4 + ix;
}

function buildTerrain(parent) {
	const SEG = Math.round(140 * LAYOUT);
	const geo = new THREE.PlaneGeometry(2 * H, 2 * H, SEG, SEG);
	geo.rotateX(-Math.PI / 2);
	const pos = geo.attributes.position;
	const uvs = geo.attributes.uv;
	const n = pos.count;
	const rest = new Float32Array(n * 2);
	const v = new THREE.Vector3();
	for (let i = 0; i < n; i++) {
		const x = pos.getX(i);
		const z = pos.getZ(i);
		rest[i * 2] = x;
		rest[i * 2 + 1] = z;
		surf(x, z, 0, v);
		pos.setXYZ(i, v.x, v.y, v.z);
	}
	geo.computeVertexNormals();

	// split triangles into one geometry per patch (normals stay smooth across seams)
	const index = geo.index.array;
	const nor = geo.attributes.normal;
	const buckets = new Map();
	for (let t = 0; t < index.length; t += 3) {
		const a = index[t];
		const b = index[t + 1];
		const c = index[t + 2];
		const cx = (rest[a * 2] + rest[b * 2] + rest[c * 2]) / 3;
		const cz = (rest[a * 2 + 1] + rest[b * 2 + 1] + rest[c * 2 + 1]) / 3;
		const id = patchId(cx, cz);
		let bk = buckets.get(id);
		if (!bk) {
			bk = { map: new Map(), p: [], n: [], uv: [], idx: [] };
			buckets.set(id, bk);
		}
		const swap = id === RIM ? 0 : CELLS[id >> 2][id & 3][2];
		for (const old of [a, b, c]) {
			let ni = bk.map.get(old);
			if (ni === undefined) {
				ni = bk.map.size;
				bk.map.set(old, ni);
				bk.p.push(pos.getX(old), pos.getY(old), pos.getZ(old));
				bk.n.push(nor.getX(old), nor.getY(old), nor.getZ(old));
				const u = uvs.getX(old);
				const w = uvs.getY(old);
				bk.uv.push(swap ? w : u, swap ? u : w);
			}
			bk.idx.push(ni);
		}
	}
	for (const [id, bk] of buckets) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(bk.p, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.n, 3));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
		g.setIndex(bk.idx);
		const [color, stitch, , color2, pattern] = id === RIM ? [P.cream, 'garter'] : CELLS[id >> 2][id & 3];
		add(parent, new THREE.Mesh(g, mat(color, stitch, PATCH_REP[stitch], color2, pattern)));
	}
}

// Seams: strand tubes sewn along the patch borders, following the terrain
function buildSeams(parent) {
	const runs = [];
	const lift = 0.03;
	const blocked = (x, z) =>
		Math.hypot(x - HOUSE.x, z - HOUSE.z) < 1.35 || Math.hypot(x - BALL.x, z - BALL.z) < 1.1;
	const okAt = (x, z, eMax) => sE(x / H, z / H) < eMax && !blocked(x, z) && riverQuery(x, z).d > 0.85;

	const trace = (fn, from, to, step, eMax, color) => {
		let run = [];
		const flush = () => {
			if (run.length >= 4) runs.push({ pts: run, color });
			run = [];
		};
		for (let s = from; s <= to + 1e-6; s += step) {
			const [x, z] = fn(s);
			if (okAt(x, z, eMax)) run.push(new THREE.Vector3(x, heightAt(x, z) + lift, z));
			else flush();
		}
		flush();
	};

	for (const cx of CUT_X) trace((z) => [cx - wobbleX(z), z], S(-6.4), S(6.4), 0.12, E0 - 0.02, P.cream);
	for (const cz of CUT_Z) trace((x) => [x, cz - wobbleZ(x)], S(-6.4), S(6.4), 0.12, E0 - 0.02, P.cream);
	// binding seam where the quilt meets the rolled rim
	const sg = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.25);
	trace(
		(a) => [E0 * 0.998 * H * sg(Math.cos(a)), E0 * 0.998 * H * sg(Math.sin(a))],
		0,
		Math.PI * 2,
		0.02,
		E0 + 0.01,
		P.coral,
	);

	for (const { pts, color } of runs) {
		const curve = new THREE.CatmullRomCurve3(pts);
		const len = curve.getLength();
		const geo = new THREE.TubeGeometry(curve, Math.max(8, Math.round(len / 0.1)), 0.022, 6, false);
		add(parent, new THREE.Mesh(geo, mat(color, 'strand', strandRep(len, 4, 0.12))));
	}
}

// ---------------------------------------------------------------------------
// River ribbon and bridge
// ---------------------------------------------------------------------------
function buildRiver(parent) {
	const pts = riverCurve.getSpacedPoints(180);
	const rows = pts.length;
	const cols = 7;
	const position = [];
	const uv = [];
	const index = [];
	const v = new THREE.Vector3();
	for (let i = 0; i < rows; i++) {
		const p = pts[i];
		const q = pts[Math.min(rows - 1, i + 1)];
		const o = pts[Math.max(0, i - 1)];
		const tx = q.x - o.x;
		const tz = q.z - o.z;
		const tl = Math.hypot(tx, tz) || 1;
		const nx = -tz / tl;
		const nz = tx / tl;
		const half = 0.52 + 0.07 * Math.sin(i * 0.17) + 0.05 * Math.sin(i * 0.41 + 1);
		for (let j = 0; j < cols; j++) {
			const s = (j / (cols - 1)) * 2 - 1;
			surf(p.x + nx * s * half, p.z + nz * s * half, 0.035 + 0.045 * (1 - s * s), v);
			position.push(v.x, v.y, v.z);
			uv.push(j / (cols - 1), i / (rows - 1));
		}
	}
	for (let i = 0; i < rows - 1; i++) {
		for (let j = 0; j < cols - 1; j++) {
			const a = i * cols + j;
			const b = a + 1;
			const c = a + cols;
			const d = c + 1;
			index.push(a, b, c, b, d, c);
		}
	}
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
	geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	geo.setIndex(index);
	geo.computeVertexNormals();
	const len = riverCurve.getLength();
	return add(parent, new THREE.Mesh(geo, mat(P.sky, 'rib', [11, Math.round(len / 0.1)])));
}

function buildBridge(parent) {
	const u = 0.46;
	const c = riverCurve.getPointAt(u);
	const tg = riverCurve.getTangentAt(u);
	tg.y = 0;
	tg.normalize();
	const nx = -tg.z;
	const nz = tg.x;
	const half = 1.7;
	const y0 = heightAt(c.x - nx * half, c.z - nz * half);
	const y1 = heightAt(c.x + nx * half, c.z + nz * half);
	// point on the arch at s in [-1, 1]; `side` offsets across the deck width
	const arch = (s, up = 0, side = 0) =>
		new THREE.Vector3(
			c.x + nx * s * half + tg.x * side,
			THREE.MathUtils.lerp(y0, y1, (s + 1) / 2) + 0.04 + 0.62 * (1 - s * s) + up,
			c.z + nz * s * half + tg.z * side,
		);

	// deck planks
	const N = 12;
	const plankGeo = new RoundedBoxGeometry(0.3, 0.12, 1.05, 2, 0.04);
	const plankMat = mat(P.cream, 'garter', [3, 10]);
	const up = new THREE.Vector3(0, 1, 0);
	const m4 = new THREE.Matrix4();
	for (let i = 0; i < N; i++) {
		const s = -1 + (2 * (i + 0.5)) / N;
		const p = arch(s);
		const tx = arch(s + 0.02).sub(arch(s - 0.02)).normalize();
		const tz = new THREE.Vector3().crossVectors(tx, up).normalize();
		const ty = new THREE.Vector3().crossVectors(tz, tx);
		const m = add(parent, new THREE.Mesh(plankGeo, plankMat));
		m.position.copy(p);
		m.quaternion.setFromRotationMatrix(m4.makeBasis(tx, ty, tz));
	}

	// rails and posts
	const postGeo = cachedGeo('post', () => new THREE.CylinderGeometry(0.035, 0.04, 0.44, 8));
	const postMat = mat(P.cream, 'stockinette', [3, 5]);
	for (const side of [-0.55, 0.55]) {
		const pts = [];
		for (let k = 0; k <= 24; k++) pts.push(arch(-1 + (k / 24) * 2, 0.46, side));
		const curve = new THREE.CatmullRomCurve3(pts);
		const len = curve.getLength();
		add(parent, new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.04, 6, false), mat(P.coral, 'strand', strandRep(len))));
		for (const s of [-1, -0.5, 0, 0.5, 1]) {
			const post = add(parent, new THREE.Mesh(postGeo, postMat));
			post.position.copy(arch(s, 0.28, side));
		}
		for (const s of [-1, 1]) {
			sphere(parent, 0.075, mat(P.coral, 'boucle', sphereRep(0.075)), 0, 0, 0).position.copy(arch(s, 0.52, side));
		}
	}
}

// ---------------------------------------------------------------------------
// Cottage
// ---------------------------------------------------------------------------
function buildHouse(parent) {
	const anchor = new THREE.Group();
	anchor.position.set(HOUSE.x, HOUSE_Y - 0.05, HOUSE.z);
	anchor.rotation.y = Math.atan2(HOUSE_FACING[0] - HOUSE.x, HOUSE_FACING[1] - HOUSE.z);
	anchor.scale.setScalar(1.1);
	parent.add(anchor);
	// reaction layer: squashes from the base, everything below hangs off it
	const house = new THREE.Group();
	anchor.add(house);

	const wallMat = mat(P.terracotta, 'stockinette', [14, 10]);
	const walls = add(house, new THREE.Mesh(new RoundedBoxGeometry(1.5, 1.0, 1.2, 4, 0.12), wallMat));
	walls.position.y = 0.5;

	// gable triangles (front and back) under the roof
	const shape = new THREE.Shape();
	shape.moveTo(-0.75, 0);
	shape.lineTo(0.75, 0);
	shape.lineTo(0, 0.62);
	shape.closePath();
	const gableGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.2, bevelEnabled: false });
	gableGeo.translate(0, 0, -0.6);
	const gp = gableGeo.attributes.position;
	const gu = gableGeo.attributes.uv;
	for (let i = 0; i < gp.count; i++) gu.setXY(i, (gp.getX(i) + 0.75) / 1.5, gp.getY(i) / 0.62);
	add(house, new THREE.Mesh(gableGeo, mat(P.terracotta, 'stockinette', [15, 6]))).position.y = 0.98;

	// roof slabs and ridge roll
	const slope = Math.atan2(0.62, 0.75);
	const roofGeo = new RoundedBoxGeometry(1.16, 0.1, 1.5, 2, 0.04);
	const roofMat = mat(P.roof, 'garter', [11, 14]);
	for (const side of [-1, 1]) {
		const slab = add(house, new THREE.Mesh(roofGeo, roofMat));
		slab.position.set(side * 0.453, 1.311, 0);
		slab.rotation.z = -side * slope;
	}
	const ridge = add(house, new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.5, 12), mat(P.roof, 'garter', [5, 15])));
	ridge.rotation.x = Math.PI / 2;
	ridge.position.y = 1.66;

	// chimney
	const chimMat = mat(P.brick, 'stockinette', [3, 6]);
	add(house, new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.6, 0.24, 3, 0.05), chimMat)).position.set(0.42, 1.55, -0.3);
	add(house, new THREE.Mesh(new RoundedBoxGeometry(0.32, 0.09, 0.32, 3, 0.04), mat(P.cream, 'garter', [3, 3]))).position.set(0.42, 1.87, -0.3);

	// dark doorway behind the door, door on a hinge pivot at its left edge
	add(house, new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.58, 0.03), doorwayMat)).position.set(0, 0.3, 0.6);
	const doorHinge = new THREE.Group();
	doorHinge.position.set(-0.18, 0, 0.61);
	house.add(doorHinge);
	add(doorHinge, new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.6, 0.08, 2, 0.04), mat(P.mustard, 'stockinette', [4, 6]))).position.set(0.18, 0.3, 0);
	add(doorHinge, new THREE.Mesh(sphereGeo(0.03), woodMat)).position.set(0.28, 0.3, 0.06);
	const cat = buildCat(house);
	add(house, new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.07, 0.28, 2, 0.03), mat(P.stone2, 'seed', [6, 3]))).position.set(0, 0.03, 0.8);

	// windows with cream frames, lit panes and cross bars
	const frameMat = mat(P.cream, 'stockinette', [4, 4]);
	const frameGeo = new RoundedBoxGeometry(0.38, 0.38, 0.08, 2, 0.03);
	const paneGeo = new THREE.BoxGeometry(0.25, 0.25, 0.09);
	const barH = new THREE.BoxGeometry(0.26, 0.03, 0.1);
	const barV = new THREE.BoxGeometry(0.03, 0.26, 0.1);
	for (const sx of [-0.5, 0.5]) {
		add(house, new THREE.Mesh(frameGeo, frameMat)).position.set(sx, 0.62, 0.6);
		add(house, new THREE.Mesh(paneGeo, paneMat)).position.set(sx, 0.62, 0.61);
		add(house, new THREE.Mesh(barH, frameMat)).position.set(sx, 0.62, 0.62);
		add(house, new THREE.Mesh(barV, frameMat)).position.set(sx, 0.62, 0.62);
	}

	// shrub by the door
	const shrub = sphere(house, 0.22, mat(P.olive, 'boucle', sphereRep(0.22)), 0.98, 0.17, 0.62);
	addFuzz(shrub, { color: P.olive, length: 0.035, density: 300, layers: 10 });

	return { house: anchor, react: house, doorHinge, cat, chimneyTop: new THREE.Vector3(0.42, 1.95, -0.3) };
}

// Cat head that peeks out of the doorway (hidden until the reactions show it)
function buildCat(parent) {
	const cat = new THREE.Group();
	cat.position.set(0, 0.27, 0.45);
	cat.visible = false;
	const fur = mat(P.mustard, 'stockinette', sphereRep(0.1));
	sphere(cat, 0.1, fur, 0, 0, 0);
	sphere(cat, 0.1, fur, 0, -0.13, -0.04);
	const earGeo = cachedGeo('catEar', () => new THREE.ConeGeometry(0.04, 0.085, 10));
	const earMat = mat(P.mustard, 'stockinette', [2, 2]);
	for (const sx of [-1, 1]) {
		const ear = add(cat, new THREE.Mesh(earGeo, earMat));
		ear.position.set(sx * 0.065, 0.1, -0.01);
		ear.rotation.z = -sx * 0.35;
		sphere(cat, 0.015, eyeMat, sx * 0.04, 0.02, 0.092);
	}
	sphere(cat, 0.02, mat(P.coral, 'stockinette', [2, 2]), 0, -0.012, 0.098);
	parent.add(cat);
	return cat;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------
const PINE_TOP_Y = 1.52;
function buildTrees(parent, rand) {
	const sway = [];
	const trunkGeo = cachedGeo('trunk', () => new THREE.CylinderGeometry(0.06, 0.09, 0.55, 10));
	const trunkMat = mat(P.roof, 'stockinette', [4, 6]);

	const pompomTrees = [
		[...L(-5.0, -1.0), 1.1, P.grass, 0.6, P.coral],
		[...L(-1.2, 5.2), 0.95, P.coral, 0.5, P.sky],
		[...L(5.3, -1.0), 1.0, P.mustard, 0.6, P.lavender],
		[...L(-5.6, 3.2), 0.85, P.sage, 0.5, P.mustard],
	];
	for (const [px, pz, s, color, r, fruit] of pompomTrees) {
		const [x, z] = settle(px, pz, 1.4);
		const g = new THREE.Group();
		g.position.set(x, heightAt(x, z) - 0.05, z);
		g.scale.setScalar(s);
		g.rotation.set((rand() - 0.5) * 0.08, rand() * 6.28, (rand() - 0.5) * 0.08);
		const react = new THREE.Group();
		g.add(react);
		add(react, new THREE.Mesh(trunkGeo, trunkMat)).position.y = 0.27;
		const crown = sphere(react, r, mat(color, 'boucle', sphereRep(r)), 0, 0.55 + r * 0.85, 0);
		addFuzz(crown, { color, length: 0.045, density: 320, layers: 12 });
		parent.add(g);
		sway.push({ g, react, crown, r, s, fruit, tx: g.rotation.x, tz: g.rotation.z, phase: rand() * 6.28 });
	}

	const pines = [
		[...L(0.2, -4.4), 1.2],
		[...L(1.3, -5.3), 0.9],
		[...L(-0.9, -5.0), 1.0],
		[...L(5.2, -4.3), 1.1],
		[...L(-5.2, -4.6), 1.0],
	];
	const cones = [
		{ r: 0.55, h: 0.7, y: 0.57, color: P.olive },
		{ r: 0.43, h: 0.62, y: 0.92, color: P.pine },
		{ r: 0.3, h: 0.55, y: 1.22, color: P.olive },
	];
	const pineList = [];
	for (const [px, pz, s] of pines) {
		const [x, z] = settle(px, pz, 1.2);
		const g = new THREE.Group();
		g.position.set(x, heightAt(x, z) - 0.05, z);
		g.scale.setScalar(s);
		g.rotation.set((rand() - 0.5) * 0.07, rand() * 6.28, (rand() - 0.5) * 0.07);
		const react = new THREE.Group();
		g.add(react);
		add(react, new THREE.Mesh(trunkGeo, trunkMat)).position.y = 0.2;
		for (const c of cones) {
			const geo = cachedGeo(`cone${c.r}${c.h}`, () => new THREE.ConeGeometry(c.r, c.h, 28, 1));
			const slant = Math.hypot(c.r, c.h);
			const rep = [qn((Math.PI * 2 * c.r) / 0.1, 4), Math.round(slant / 0.1)];
			add(react, new THREE.Mesh(geo, mat(c.color, 'rib', rep))).position.y = c.y;
		}
		const top = sphere(react, 0.08, mat(P.cream, 'boucle', sphereRep(0.08)), 0, PINE_TOP_Y, 0);
		parent.add(g);
		pineList.push({ g, react, top, topY: PINE_TOP_Y, tx: g.rotation.x, tz: g.rotation.z });
	}
	return { trees: sway, pines: pineList };
}

// ---------------------------------------------------------------------------
// Sheep
// ---------------------------------------------------------------------------
const SHEEP_BODY = [
	[0, 0.5, 0, 0.34],
	[0.2, 0.46, 0.18, 0.26],
	[-0.2, 0.46, 0.18, 0.26],
	[0.2, 0.46, -0.2, 0.26],
	[-0.2, 0.46, -0.2, 0.26],
	[0, 0.72, 0.02, 0.28],
	[0, 0.54, -0.34, 0.24],
];

function makeSheep(spec, parent) {
	const { x: px, z: pz, yaw, phase, hopPeriod } = spec;
	const [x, z] = settle(px, pz, 1.2);
	const g = new THREE.Group();
	g.rotation.order = 'YXZ';
	g.scale.setScalar(spec.scale ?? 0.95);
	// reaction layer (squash from the hooves) between the placed group and the body
	const react = new THREE.Group();
	g.add(react);
	const body = new THREE.Group();
	react.add(body);

	const wool = [];
	for (const [bx, by, bz, r] of SHEEP_BODY) {
		const m = sphere(body, r, mat(P.cream, 'boucle', sphereRep(r)), bx, by, bz);
		addFuzz(m, { color: P.cream, length: 0.05, density: 400, layers: 12 });
		wool.push(m);
	}

	// legs
	const legGeo = cachedGeo('leg', () => new THREE.CylinderGeometry(0.055, 0.05, 0.36, 10));
	const dark = mat(P.charcoal, 'stockinette', [4, 4]);
	for (const [lx, lz] of [[0.14, 0.2], [-0.14, 0.2], [0.14, -0.2], [-0.14, -0.2]]) {
		add(body, new THREE.Mesh(legGeo, dark)).position.set(lx, 0.18, lz);
	}

	// head on a pivot at the neck so it can dip to graze
	const headPop = new THREE.Group();
	headPop.position.set(0, 0.68, 0.34);
	body.add(headPop);
	const head = new THREE.Group();
	headPop.add(head);
	sphere(head, 0.13, dark, 0, 0, 0);
	const skull = sphere(head, 0.19, mat(P.charcoal, 'stockinette', sphereRep(0.19)), 0, 0, 0.17);
	skull.scale.set(0.95, 1, 1.12);
	for (const sx of [-1, 1]) {
		const ear = sphere(head, 0.07, mat(P.charcoal, 'stockinette', sphereRep(0.07)), sx * 0.2, 0.07, 0.12);
		ear.scale.set(1.2, 0.45, 0.75);
		ear.rotation.z = sx * -0.5;
		sphere(head, 0.028, eyeMat, sx * 0.09, 0.07, 0.33);
	}
	const tuft = sphere(head, 0.11, mat(P.cream, 'boucle', sphereRep(0.11)), 0, 0.15, 0.1);
	addFuzz(tuft, { color: P.cream, length: 0.035, density: 300, layers: 10 });

	// stand on the slope
	const fx = Math.sin(yaw);
	const fz = Math.cos(yaw);
	const hF = heightAt(x + fx * 0.25, z + fz * 0.25);
	const hB = heightAt(x - fx * 0.25, z - fz * 0.25);
	const hR = heightAt(x + fz * 0.2, z - fx * 0.2);
	const hL = heightAt(x - fz * 0.2, z + fx * 0.2);
	g.position.set(x, (hF + hB + hR + hL) / 4 - 0.02, z);
	g.rotation.set(-Math.atan2(hF - hB, 0.5), yaw, Math.atan2(hR - hL, 0.4));
	parent.add(g);
	// wool + tuft: the unravel feature shrinks them; busy / bald: set while unravel drives the sheep
	return { g, react, body, headPop, head, wool, tuft, busy: false, bald: false, yaw, phase, hopPeriod, pitch: g.rotation.x, roll: g.rotation.z };
}

// ---------------------------------------------------------------------------
// Yarn ball with loose strand
// ---------------------------------------------------------------------------
function buildYarnBall(parent, rand, sheepSpec) {
	const R = 0.6;
	const gy =
		(heightAt(BALL.x, BALL.z) +
			heightAt(BALL.x + 0.4, BALL.z) +
			heightAt(BALL.x - 0.4, BALL.z) +
			heightAt(BALL.x, BALL.z + 0.4) +
			heightAt(BALL.x, BALL.z - 0.4)) /
		5;
	const center = new THREE.Vector3(BALL.x, gy + R - 0.1, BALL.z);
	const ball = new THREE.Group();
	ball.position.copy(center);
	parent.add(ball);

	// core
	sphere(ball, R - 0.03, mat(P.coralDeep, 'stockinette', sphereRep(R - 0.03)), 0, 0, 0);

	// wound strands: helical arcs hugging the sphere, merged per color
	const colors = [P.coral, P.pink, P.coralDeep];
	const groups = colors.map(() => []);
	for (let i = 0; i < 54; i++) {
		const a = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
		const ref = Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
		const bu = new THREE.Vector3().crossVectors(a, ref).normalize();
		const bv = new THREE.Vector3().crossVectors(a, bu);
		const r = R - 0.02 + (rand() - 0.5) * 0.04;
		const span = Math.PI * (1.5 + rand() * 0.4);
		const phi0 = rand() * 6.28;
		const h0 = (rand() - 0.5) * 0.6 * r;
		const dh = (rand() - 0.5) * 0.7 * r;
		const pts = [];
		for (let k = 0; k <= 40; k++) {
			const f = k / 40;
			const phi = phi0 + f * span;
			const h = THREE.MathUtils.clamp(h0 + dh * f, -0.85 * r, 0.85 * r);
			const rr = Math.sqrt(r * r - h * h);
			pts.push(
				new THREE.Vector3()
					.addScaledVector(bu, Math.cos(phi) * rr)
					.addScaledVector(bv, Math.sin(phi) * rr)
					.addScaledVector(a, h),
			);
		}
		const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.035, 6, false);
		groups[i % 3].push(geo);
	}
	groups.forEach((list, i) => {
		add(ball, new THREE.Mesh(mergeGeometries(list), mat(colors[i], 'strand', strandRep(3.2, 8))));
		list.forEach((g) => g.dispose());
	});

	// knitting needles stuck in the ball
	const needleGeo = cachedGeo('needle', () => new THREE.CylinderGeometry(0.028, 0.022, 1.9, 10));
	const knobGeo = sphereGeo(0.07);
	const yAxis = new THREE.Vector3(0, 1, 0);
	const needles = [];
	for (const d of [new THREE.Vector3(0.55, 0.75, 0.25), new THREE.Vector3(-0.25, 0.8, 0.4)]) {
		d.normalize();
		const n = new THREE.Group();
		n.position.copy(d).multiplyScalar(0.62);
		n.quaternion.setFromUnitVectors(yAxis, d);
		add(n, new THREE.Mesh(needleGeo, woodMat));
		add(n, new THREE.Mesh(knobGeo, woodMat)).position.y = 0.95;
		ball.add(n);
		needles.push(n);
	}

	// loose strand path across the ground, ending in a small curl at the sheep's nose
	const [sx, sz] = settle(sheepSpec.x, sheepSpec.z, 1.2);
	const tx = sx + Math.sin(sheepSpec.yaw) * 0.8;
	const tz = sz + Math.cos(sheepSpec.yaw) * 0.8;
	const dir = new THREE.Vector2(tx - BALL.x, tz - BALL.z);
	const dist = dir.length();
	dir.normalize();
	const start = new THREE.Vector2(BALL.x + dir.x * 0.52, BALL.z + dir.y * 0.52);
	const path = [];
	const M = 10;
	for (let i = 0; i <= M; i++) {
		const t = i / M;
		const off = Math.sin(t * Math.PI * 1.5 + 0.5) * 0.5 * (1 - t * 0.3);
		path.push(
			new THREE.Vector3(
				THREE.MathUtils.lerp(start.x, tx, t) - dir.y * off,
				0,
				THREE.MathUtils.lerp(start.y, tz, t) + dir.x * off,
			),
		);
	}
	for (let k = 1; k <= 10; k++) {
		const ang = (k / 10) * Math.PI * 2 * 1.15;
		const r = 0.16 * (1 - k / 14);
		path.push(new THREE.Vector3(tx + Math.cos(ang) * r - 0.16, 0, tz + Math.sin(ang) * r));
	}
	const dense = new THREE.CatmullRomCurve3(path).getSpacedPoints(Math.round(dist * 40));
	const lifted = dense.map((p) => {
		const dBall = Math.hypot(p.x - BALL.x, p.z - BALL.z);
		const hang = 0.5 * Math.pow(Math.max(0, 1 - (dBall - 0.55) / 0.8), 2);
		return new THREE.Vector3(p.x, heightAt(p.x, p.z) + 0.045 + hang, p.z);
	});
	// the rope in yarnball.js simulates and renders the strand from this polyline
	return { group: ball, radius: R, needles, path: lifted };
}

// ---------------------------------------------------------------------------
// Clouds hanging from strings
// ---------------------------------------------------------------------------
const CLOUD_HANG = 0.7; // cloud-local height of the string knot
function buildClouds(parent, rand) {
	const CLOUD = [
		[0, 0, 0, 0.6],
		[0.7, -0.08, 0.1, 0.5],
		[-0.72, -0.1, -0.05, 0.5],
		[0.3, 0.38, -0.2, 0.45],
		[-0.3, 0.34, 0.25, 0.4],
		[0.05, -0.1, 0.55, 0.4],
	];
	const specs = [
		{ x: S(-5.2), y: 5.6, z: S(-4.6), s: 1.0 },
		{ x: S(5.4), y: 6.2, z: S(-2.8), s: 1.15 },
		{ x: S(-1.0), y: 6.6, z: S(-6.2), s: 0.85 },
	];
	const ANCHOR_Y = 11;
	const pivots = [];
	for (const sp of specs) {
		const pivot = new THREE.Group();
		pivot.position.set(sp.x, ANCHOR_Y, sp.z);
		// swing: extra pendulum motion at the anchor; react: squash hanging from the string knot
		const swing = new THREE.Group();
		pivot.add(swing);
		const cloud = new THREE.Group();
		cloud.position.y = sp.y - ANCHOR_Y;
		cloud.scale.setScalar(sp.s);
		const react = new THREE.Group();
		react.position.y = CLOUD_HANG;
		cloud.add(react);
		for (const [cx, cy, cz, r] of CLOUD) {
			const m = sphere(react, r, mat(P.white, 'boucle', sphereRep(r)), cx, cy - CLOUD_HANG, cz);
			addFuzz(m, { color: P.white, length: 0.05, density: 320, layers: 12 });
		}
		swing.add(cloud);
		// strings from the anchor to the top of the cloud
		const top = (sp.y - ANCHOR_Y) + 0.7 * sp.s;
		for (const [ax, az] of [[0.45, 0], [-0.4, 0.2], [0, -0.4]]) {
			const end = new THREE.Vector3(ax * sp.s, top, az * sp.s);
			const curve = new THREE.LineCurve3(new THREE.Vector3(0, 0, 0), end);
			const geo = new THREE.TubeGeometry(curve, 24, 0.02, 5, false);
			add(swing, new THREE.Mesh(geo, mat(P.cream, 'strand', strandRep(end.length(), 16))));
		}
		parent.add(pivot);
		pivots.push({ pivot, swing, cloud, react, s: sp.s, phase: rand() * 6.28 });
	}
	return pivots;
}

// ---------------------------------------------------------------------------
// Small details: flowers, fence, stones
// ---------------------------------------------------------------------------
function buildFlowers(parent, rand) {
	const colors = [P.coral, P.cream, P.lavender, P.mustard];
	const headGeo = sphereGeo(0.065);
	const stemGeo = cachedGeo('stem', () => new THREE.CylinderGeometry(0.012, 0.012, 0.16, 5));
	const stemMat = mat(P.olive, 'stockinette', [1, 2]);
	const m4 = new THREE.Matrix4();
	const out = [];
	let n = 0;
	// one group per cluster: the weave intro pops each cluster in from its own base
	for (const [cx, cz] of FLOWER_CLUSTERS) {
		const spots = colors.map(() => []);
		for (let tries = 0, got = 0; got < 7 && tries < 60; tries++) {
			const a = rand() * 6.28;
			const d = Math.sqrt(rand()) * 0.8;
			const x = cx + Math.cos(a) * d;
			const z = cz + Math.sin(a) * d;
			if (Math.hypot(x - HOUSE.x, z - HOUSE.z) < 1.9) continue;
			if (Math.hypot(x - BALL.x, z - BALL.z) < 1.1) continue;
			if (riverQuery(x, z).d < 0.95) continue;
			spots[n % colors.length].push([x, z]);
			n++;
			got++;
		}
		const group = new THREE.Group();
		parent.add(group);
		const all = spots.flat();
		const stems = new THREE.InstancedMesh(stemGeo, stemMat, all.length);
		let si = 0;
		spots.forEach((list, ci) => {
			if (!list.length) return;
			const heads = new THREE.InstancedMesh(headGeo, mat(colors[ci], 'boucle', sphereRep(0.065)), list.length);
			list.forEach(([x, z], i) => {
				const y = heightAt(x, z);
				m4.makeTranslation(x, y + 0.17, z);
				heads.setMatrixAt(i, m4);
				m4.makeTranslation(x, y + 0.07, z);
				stems.setMatrixAt(si++, m4);
			});
			heads.castShadow = heads.receiveShadow = true;
			group.add(heads);
		});
		stems.castShadow = stems.receiveShadow = true;
		group.add(stems);
		out.push({ group, base: new THREE.Vector3(cx, heightAt(cx, cz), cz) });
	}
	return out;
}

function buildFence(parent) {
	// two fence runs in front of the cottage with a gap for the path
	const yaw = Math.atan2(HOUSE_FACING[0] - HOUSE.x, HOUSE_FACING[1] - HOUSE.z);
	const cs = Math.cos(yaw);
	const sn = Math.sin(yaw);
	// house-local (lx, lz) -> world xz
	const toWorld = (lx, lz) => [HOUSE.x + lx * cs + lz * sn, HOUSE.z - lx * sn + lz * cs];
	const postGeo = cachedGeo('fencePost', () => new THREE.CylinderGeometry(0.045, 0.05, 0.36, 8));
	const postMat = mat(P.wood, 'stockinette', [3, 4]);
	const capMat = mat(P.cream, 'boucle', sphereRep(0.06));
	const posts = [];
	const runs = [];
	for (const [from, to] of [[-1.5, -0.55], [0.55, 1.5]]) {
		// each run is its own group so the weave intro can pop it in from its base
		const run = new THREE.Group();
		parent.add(run);
		const top = [];
		const low = [];
		const count = 5;
		const base = new THREE.Vector3();
		for (let i = 0; i < count; i++) {
			const [x, z] = toWorld(THREE.MathUtils.lerp(from, to, i / (count - 1)), 1.75);
			const y = heightAt(x, z);
			const post = new THREE.Group();
			post.position.set(x, y, z);
			add(post, new THREE.Mesh(postGeo, postMat)).position.y = 0.14;
			sphere(post, 0.06, capMat, 0, 0.34, 0);
			run.add(post);
			posts.push(post);
			base.add(post.position);
			top.push(new THREE.Vector3(x, y + 0.27, z));
			low.push(new THREE.Vector3(x, y + 0.15, z));
		}
		for (const pts of [top, low]) {
			const curve = new THREE.CatmullRomCurve3(pts);
			const len = curve.getLength();
			add(run, new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.025, 5, false), mat(P.cream, 'strand', strandRep(len))));
		}
		runs.push({ group: run, base: base.divideScalar(count) });
	}
	return { posts, runs };
}

function buildStones(parent) {
	const spec = [
		[...L(-2.3, 0.9), 0.22, P.stone],
		[...L(3.9, -0.5), 0.18, P.stone2],
		[...L(-0.7, 1.7), 0.15, P.stone2],
		[...L(4.9, 3.2), 0.26, P.stone],
		[...L(-5.4, 0.9), 0.2, P.stone2],
		[...L(0.6, -4.0), 0.2, P.stone],
	];
	const stones = [];
	for (const [px, pz, r, color] of spec) {
		const [x, z] = settle(px, pz, 0.9);
		const g = new THREE.Group();
		g.position.set(x, heightAt(x, z), z);
		const m = add(g, new THREE.Mesh(sphereGeo(r), mat(color, 'seed', sphereRep(r))));
		m.scale.set(1, 0.7, 1.15);
		m.rotation.y = x * 3;
		m.position.y = r * 0.2;
		parent.add(g);
		stones.push(g);
	}
	return stones;
}

// Loose thread that leaves the cushion's right binding seam (in view from the default camera) and trails over the
// quilt toward the camera; the weave module makes it a rope and the handle for the unravel outro.
function buildThreadPath() {
	const plan = [
		L(6.05, 1.45),
		L(5.6, 1.75),
		L(5.1, 1.85),
		L(4.7, 2.2),
		L(4.65, 2.75),
	];
	return plan.map(([x, z]) => new THREE.Vector3(x, groundAt(x, z) + 0.055, z));
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
export function buildWorld(scene) {
	const rand = mulberry32(20261031);
	const root = new THREE.Group();
	scene.add(root);

	// ground (patch meshes, seams, river) and bridge are groups so the weave module can patch / wrap them
	const groundG = new THREE.Group();
	root.add(groundG);
	buildTerrain(groundG);
	buildSeams(groundG);
	const riverMesh = buildRiver(groundG);
	const bridgeG = new THREE.Group();
	root.add(bridgeG);
	buildBridge(bridgeG);
	const { house: houseAnchor, react: houseReact, doorHinge, cat, chimneyTop } = buildHouse(root);
	const { trees, pines } = buildTrees(root, rand);

	const sheepSpecs = [
		{ x: S(-0.9), z: S(3.5), yaw: -1.9, phase: 0.1, hopPeriod: 11 },
		{ x: S(-4.6), z: S(1.3), yaw: 0.9, phase: 0.45, hopPeriod: 13 },
		{ x: S(0.7), z: S(-1.9), yaw: 2.4, phase: 0.8, hopPeriod: 9 },
	];
	const sheep = sheepSpecs.map((s) => makeSheep(s, root));
	const ballRig = buildYarnBall(root, rand, sheepSpecs[0]);
	const rope = new Rope({ groundAt, material: mat(P.coral, 'strand', [1, 1]) });
	// ball and its thread share a group so the weave module can pop them in together
	const ballG = new THREE.Group();
	root.add(ballG);
	ballG.add(ballRig.group, rope.mesh);
	const yarn = setupYarnBall({ root, ball: ballRig, rope, groundAt, limit: 0.82 * H });
	// sheep bodies push the thread aside instead of letting it pass through the wool
	const sheepColliders = sheep.map((s) => ({ s, center: new THREE.Vector3(), radius: 0.42 }));
	rope.colliders.push(...sheepColliders);
	const clouds = buildClouds(root, rand);
	const flowerClusters = buildFlowers(root, rand);
	const { posts, runs: fenceRuns } = buildFence(root);
	const stones = buildStones(root);

	// ground a sheep may trot over: on the island, off the river, clear of trees, house, ball, fence and stones
	const blockers = [
		[HOUSE.x, HOUSE.z, 1.5],
		[BALL.x, BALL.z, 1.1],
		...trees.map((t) => [t.g.position.x, t.g.position.z, 0.7]),
		...pines.map((p) => [p.g.position.x, p.g.position.z, 0.7]),
		...posts.map((p) => [p.position.x, p.position.z, 0.35]),
		...stones.map((p) => [p.position.x, p.position.z, 0.5]),
	];
	const walkable = (x, z) =>
		Math.abs(x) < S(5.2) &&
		Math.abs(z) < S(5.2) &&
		riverQuery(x, z).d > 1.0 &&
		blockers.every(([bx, bz, r]) => Math.hypot(x - bx, z - bz) > r);

	// shared helpers for the ambient modules (wind props, water, critters, ground art)
	const GREENS = new Set([P.sage, P.grass, P.olive]);
	const bridgeEnds = (() => {
		const c = riverCurve.getPointAt(0.46);
		const tg = riverCurve.getTangentAt(0.46);
		const l = Math.hypot(tg.x, tg.z);
		return [-1, 1].map((s) => {
			const x = c.x - (tg.z / l) * s * 1.7;
			const z = c.z + (tg.x / l) * s * 1.7;
			return new THREE.Vector3(x, heightAt(x, z), z);
		});
	})();
	const terrain = {
		heightAt,
		groundAt,
		surf,
		riverQuery,
		riverCurve,
		riverHalfWidth: 0.52,
		bridgeU: 0.46,
		bridgeEnds,
		H,
		E0,
		sE,
		HOUSE,
		blockers,
		walkable,
		isGreen: (x, z) => {
			const id = patchId(x, z);
			return id !== RIM && GREENS.has(CELLS[id >> 2][id & 3][0]);
		},
	};
	const kit = { mat, sphereRep, strandRep, sphereGeo, cachedGeo, add, sphere, addFuzz, P };
	const wind = createWind();
	const riverSurface = patchRiver(riverMesh.material, { wind, len: riverCurve.getLength() });
	const windProps = setupWindProps({ root, wind, kit, terrain });
	const water = setupWater({ root, river: riverMesh, wind, kit, terrain });
	// flat embroidery goes into groundG, so it has to exist before setupWeave clones the ground materials
	const groundArt = setupGroundArt({ ground: groundG, root, kit, terrain, wind });
	const smoke = setupSmoke({ root, wind, kit, house: { anchor: houseAnchor, react: houseReact, chimneyTop } });
	const kite = setupKite({ root, wind, kit, terrain });
	// sheep walk around the kite stake, and the wildflower patches stay clear of it
	blockers.push([kite.items[0].base.x, kite.items[0].base.z, 0.45]);
	const meadow = setupMeadow({ root, wind, kit, terrain, trees });
	const syncColliders = () => {
		for (const c of sheepColliders) c.s.body.localToWorld(c.center.set(0, 0.5, -0.05));
	};
	root.updateMatrixWorld(true);
	syncColliders();
	const unravel = setupUnravel({
		root,
		sheep,
		groundAt,
		walkable,
		colliders: sheepColliders,
		mat,
		sphereRep,
		sphereGeo,
		P,
	});

	const reactions = setupReactions({
		root,
		sheep,
		trees,
		pines,
		clouds,
		house: { group: houseReact, door: doorHinge, cat, chimneyTop },
		props: [...stones.map((group) => ({ group, kind: 'stone' })), ...posts.map((group) => ({ group, kind: 'post' }))],
		heightAt,
		kit: { mat, sphereGeo, P, boucle: (color, r) => mat(color, 'boucle', sphereRep(r)) },
	});
	// sheep lift / chase the yarn ball / eat fallen fruit; wraps the sheep's onPoke, so it comes after reactions
	const sheepLife = setupSheepLife({ sheep, groundAt, walkable, yarn, reactions, unravel });
	// lamb, butterflies, birds; wraps the trees' onPoke, so it comes after reactions
	const critters = setupCritters({
		root,
		kit,
		terrain,
		wind,
		sheep,
		sheepState: (s) => sheepLife.stateOf(s),
		makeLamb: (spec) => makeSheep(spec, root),
		trees,
		flowerBases: flowerClusters.map((c) => c.base),
	});

	const TAU = Math.PI * 2;
	const WIND_LEAN = 0.065; // tree tilt (rad) per unit of wind strength
	const shadowFade = { k: 0, set: -1 };
	let wasBusy = true;
	function update(t, dt = 1 / 60) {
		wind.update(dt);
		// sheep: grazing head dips, occasional hop with a wiggle
		for (const s of sheep) {
			if (s.busy) continue; // unravel drives this sheep
			const ph = s.phase * TAU;
			const graze = sstep(0.25, 0.75, 0.5 + 0.5 * Math.sin(t * 0.5 + ph * 3));
			s.head.rotation.x = -0.12 + graze * 0.95 + 0.07 * Math.sin(t * 4.5 + ph) * graze;
			const hc = (t + s.phase * 10) % s.hopPeriod;
			let hop = 0;
			let wig = 0;
			if (hc < 0.7) {
				const u = hc / 0.7;
				hop = Math.sin(u * Math.PI) * 0.14;
				wig = Math.sin(u * Math.PI * 3) * 0.12;
			}
			s.body.position.y = hop;
			s.body.rotation.x = -hop * 0.5;
			s.body.scale.y = 1 + 0.012 * Math.sin(t * 1.7 + ph);
			s.g.rotation.y = s.yaw + wig;
		}
		// clouds swing on their strings, pushed further by the wind (rotation about x tilts toward +z, about z toward -x)
		for (const c of clouds) {
			const w = wind.at(c.pivot.position.x, c.pivot.position.z);
			c.pivot.rotation.z = 0.035 * Math.sin(t * 0.45 + c.phase) - 0.08 * w * wind.dir.x;
			c.pivot.rotation.x = 0.03 * Math.sin(t * 0.37 + c.phase * 1.7) + 0.08 * w * wind.dir.y;
		}
		// trees lean with the wind and flutter while a gust passes
		for (const tr of trees) {
			const p = tr.g.position;
			const w = wind.at(p.x, p.z);
			const lean = WIND_LEAN * w + 0.016 * w * Math.sin(t * 7 + tr.phase);
			tr.g.rotation.z = tr.tz + 0.018 * Math.sin(t * 0.9 + tr.phase) - lean * wind.dir.x;
			tr.g.rotation.x = tr.tx + 0.012 * Math.cos(t * 0.7 + tr.phase) + lean * wind.dir.y;
		}
		for (const pn of pines) {
			const p = pn.g.position;
			const lean = WIND_LEAN * 0.5 * wind.at(p.x, p.z);
			pn.g.rotation.z = pn.tz - lean * wind.dir.x;
			pn.g.rotation.x = pn.tx + lean * wind.dir.y;
		}
		sheepLife.update(t, dt); // sets body/head/legs from scratch; unravel layers its lean on top
		unravel.update(t, dt);
		syncColliders();
		yarn.update(t, dt);
		reactions(t, dt);
		critters.update(t, dt);
		windProps.update(t, dt);
		riverSurface.update(t);
		water.update(t, dt);
		groundArt.update(t, dt);
		smoke.update(t, dt);
		kite.update(t, dt);
		meadow.update(t, dt);
		weave.update(t, dt);
		// the first gust sweeps over the island as soon as the knit-in finishes; cloud shadows fade in with it
		const busy = weave.busy;
		if (wasBusy && !busy) wind.gust(1.1);
		wasBusy = busy;
		shadowFade.k = busy ? 0 : Math.min(1, shadowFade.k + dt * 0.5);
		if (shadowFade.k !== shadowFade.set) groundArt.setShadows((shadowFade.set = shadowFade.k));
	}

	// the blanket under the cushion: top = lowest underside point of the rolled edge, flat zone = the whole
	// footprint (rounded-square corners reach furthest) plus margin. Child of scene, not root, so the weave
	// intro leaves it visible in every state.
	let floorY = Infinity;
	let footprint = 0;
	const edgeP = new THREE.Vector3();
	for (let k = 0; k < 720; k++) {
		const th = (k / 720) * Math.PI * 2;
		const gx = Math.cos(th);
		const gz = Math.sin(th);
		const s = H / sE(gx, gz); // lands on the outline, normalized radius 1
		surf(gx * s, gz * s, 0, edgeP);
		floorY = Math.min(floorY, edgeP.y);
		footprint = Math.max(footprint, Math.hypot(edgeP.x, edgeP.z));
	}
	floorY -= 0.01;
	scene.add(buildBlanket({ kit, y: floorY, clearR: footprint + 0.4 }));

	// intro / outro: objects pop in and out through wrapper groups, the ground is clipped by the knit front
	const weave = setupWeave({
		root,
		floorY,
		ground: groundG,
		items: [
			{ obj: bridgeG, stage: 'bridge' },
			{ obj: houseAnchor, stage: 'house' },
			...fenceRuns.map(({ group, base }) => ({ obj: group, stage: 'fence', base })),
			...stones.map((g) => ({ obj: g, stage: 'stone' })),
			...trees.map((tr) => ({ obj: tr.g, stage: 'tree' })),
			...pines.map((pn) => ({ obj: pn.g, stage: 'pine' })),
			...flowerClusters.map(({ group, base }) => ({ obj: group, stage: 'flower', clip: true, base })),
			{ obj: ballG, stage: 'ball', follow: ballRig.group, drop: 0.5 },
			...sheep.map((s) => ({ obj: s.g, stage: 'sheep' })),
			...clouds.map((c) => ({ obj: c.pivot, stage: 'cloud' })),
			...windProps.items,
			...water.items,
			...groundArt.items,
			...critters.items,
			...kite.items,
			...meadow.items,
		],
		kit: { mat, sphereRep, P },
		H,
		groundAt,
		thread: { path: buildThreadPath() },
		onStart: () => resetAll(),
	});

	// reset the other modules, then knit the world in again
	function resetAll() {
		weave.restore();
		yarn.reset();
		unravel.reset();
		sheepLife.reset();
		critters.reset();
		windProps.reset();
		water.reset();
		groundArt.reset();
		smoke.reset();
		kite.reset();
		meadow.reset();
		weave.playIntro();
	}

	// the thread and the sheep are only grabbable while the world is fully there
	const gate = (g) => ({ pick: (ray, camera) => (weave.busy ? null : g.pick(ray, camera)), grab: () => g.grab() });

	return {
		update,
		focusTarget: new THREE.Vector3(0, 0.6, 0),
		groundAt,
		// nearest river centerline point to (x, z), for the positional water sound
		riverPoint: (x, z, out) => {
			riverQuery(x, z);
			return out.set(rq.nx, groundAt(rq.nx, rq.nz), rq.nz);
		},
		// same array for the whole run: poke.js keeps a reference to it
		grabbables: [...[yarn.grabbable, ...unravel.grabbables, ...sheepLife.grabbables, ...critters.grabbables].map(gate), weave.grabbable],
		reset: resetAll,
		playIntro: resetAll,
		// { kind: 'start' | 'collapse', point, dir } for the guide overlay, or null
		get hint() {
			return weave.hint;
		},
		// for ?debug=1 inspection
		sheep,
		sheepLife,
		yarn,
		wind,
		critters,
	};
}
