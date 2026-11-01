// Meadow: taller plants and drifting petals that move with the shared wind (wind.js).
//   1. wildflower patches  4-5 patches of knee-high yarn daisies, tulips and long grass blades, bent in the vertex shader
//   2. petal drift         a pool of tiny felt petals and leaves that leave the patches and the pompom crowns,
//                          travel downwind together, land, lie for a moment and shrink away
// The integrator calls setupMeadow({ root, wind, kit, terrain, trees }) once, update(t, dt) every frame and
// reset() on R / replay. Patch groups are listed in `items` for the knit-in intro; the petal mesh is a direct
// child of root and is not in `items`.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WIND_GLSL, BREEZE_MAX } from './wind.js';
import { S, CLOTHESLINE, FLOWER_CLUSTERS } from './layout.js';

const TAU = Math.PI * 2;

// --- feel knobs ------------------------------------------------------------
// patches
const PATCHES = 5;
const PATCH_R = [0.65, 0.9]; // patch radius
const PATCH_FLOWERS = [12, 20];
const PATCH_BLADES = [6, 9]; // grass tufts per patch
const PATCH_MIN_GAP = S(2.4); // between patch centers
const PATCH_SE_MAX = 0.8; // inside the cushion, off the rolled edge
const SHORT_CLEAR = 0.9; // from the centers of the short flower clusters in world.js
const LINE_CLEAR = [...CLOTHESLINE[0], ...CLOTHESLINE[1], 0.6]; // clothesline segment (windprops.js) and the clearance around it
// plants (local units; instances scale 0.72 .. 1.12, so stems end up 0.29 .. 0.45 tall)
const STEM_H = 0.4;
const BLADE_H = 0.5;
const SCALE = [0.72, 1.12];
// bend: tip offset (world units) = TIP[0] + TIP[1] * wind strength, for a 0.4 tall plant
// breeze (0.4) -> ~0.045, gust (~1.5) -> ~0.155
const TIP = [0.005, 0.1];
const FLUTTER = 0.015; // sideways shimmer amplitude, grows with wind
// petals
const PETAL_POOL = 56;
const PETAL_LIFE = [8, 12]; // seconds in the air at most
const PETAL_SIZE = [0.036, 0.05]; // length
const LEAF_SIZE = [0.05, 0.07];
const PETAL_DRIFT = [0.15, 1.6]; // units/s downwind: base, per unit of wind strength
const PETAL_DRAG = 2.5; // 1/s: how fast a petal's velocity follows the wind
const PETAL_SWAY = 0.22; // units/s sideways, back and forth
const PETAL_SINK = [0.1, 0.1]; // units/s: base, extra for the heaviest petal
const PETAL_LIFT = 0.45; // units/s per unit of wind strength above the breeze
const PETAL_LIE = [1.5, 3]; // seconds on the ground before shrinking
const PETAL_FADE = 0.8; // shrink-away time
const TRICKLE = 1; // petals/s for the whole island at breeze strength
const BURST = [2, 3]; // petals per source when the gust band passes it
const GUST_MIN = 0.3; // gust amplitude needed to trigger a burst

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
const pick = (list, r) => list[Math.floor(r * list.length) % list.length];

// distance from (x, z) to the segment (ax, az)-(bx, bz)
function segDist(x, z, ax, az, bx, bz) {
	const dx = bx - ax;
	const dz = bz - az;
	const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
	return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

function paint(geo, color) {
	const c = new THREE.Color(color);
	const n = geo.attributes.position.count;
	const a = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) c.toArray(a, i * 3);
	geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
	return geo;
}

// Three tapered flat ribbons that curl away from the tuft center. Base at y = 0.
function bladeTuftGeometry(seed) {
	const r = mulberry32(seed);
	const ROWS = 6;
	const pos = [];
	const uv = [];
	const idx = [];
	const count = 3 + (seed % 2);
	for (let b = 0; b < count; b++) {
		const a0 = (b / count) * TAU + r() * 0.8;
		const rad = 0.006 + r() * 0.018;
		const bx = Math.cos(a0) * rad;
		const bz = Math.sin(a0) * rad;
		const az = a0 + (r() - 0.5) * 0.9;
		const hh = b === 0 ? BLADE_H : BLADE_H * (0.62 + 0.3 * r());
		const curl = 0.25 + 0.3 * r();
		const w0 = 0.015 + 0.004 * r();
		const dx = Math.cos(az);
		const dz = Math.sin(az);
		const base = pos.length / 3;
		for (let i = 0; i < ROWS; i++) {
			const f = i / (ROWS - 1);
			const off = curl * hh * f * f;
			const w = w0 * (1 - f * 0.95);
			const cx = bx + dx * off;
			const cz = bz + dz * off;
			pos.push(cx + dz * w, hh * f, cz - dx * w, cx - dz * w, hh * f, cz + dx * w);
			uv.push(0, f, 1, f);
		}
		for (let i = 0; i < ROWS - 1; i++) {
			const a = base + i * 2;
			idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
		}
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

// Lens-shaped petal, length 1 along x, slightly cupped. Normal +z.
function petalGeometry() {
	const shape = new THREE.Shape();
	shape.moveTo(-0.5, 0);
	shape.bezierCurveTo(-0.35, 0.36, 0.2, 0.34, 0.5, 0);
	shape.bezierCurveTo(0.2, -0.34, -0.35, -0.36, -0.5, 0);
	const g = new THREE.ShapeGeometry(shape, 6);
	const p = g.attributes.position;
	for (let i = 0; i < p.count; i++) {
		const x = p.getX(i);
		const y = p.getY(i);
		p.setZ(i, 0.6 * x * x + 2 * y * y);
	}
	g.computeVertexNormals();
	return g;
}

export function setupMeadow({ root, wind, kit, terrain, trees }) {
	const { P } = kit;
	const items = [];
	const rand = mulberry32(5150);
	const H = terrain.H;
	const sE = terrain.sE;
	const dirX = wind.dir.x;
	const dirZ = wind.dir.y;
	const gu = wind.uniforms;

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
			m.customProgramCacheKey = () => `meadow-${key}`;
			windMats.set(id, m);
		}
		return m;
	}

	// ---------------------------------------------------------------------
	// 1. Wildflower patches
	// ---------------------------------------------------------------------
	// One bend for stems, blades and heads. Displacement is a function of the instance's world xz and the
	// height along the plant: quadratic in height, along uWindDir, plus a small sideways flutter that grows
	// with the wind. Stems and blades bend every vertex by its own height. Heads move rigidly with the stem
	// top (displacement at full height) and tilt by the slope of the stem there, around the head pivot.
	const bendBody = (hh, head) => /* glsl */ `
	{
		mat4 im = modelMatrix * instanceMatrix;
		vec2 iw = im[3].xz;
		mat3 m3 = mat3(im);
		float s2 = dot(m3[0], m3[0]);
		float sc = sqrt(s2);
		float w = windAt(iw);
		float ph = dot(iw, vec2(12.9, 7.7));
		float vary = 0.85 + 0.3 * fract(sin(ph) * 43758.5453);
		float hy = ${head ? hh.toFixed(3) : 'position.y'};
		float h = clamp(hy / ${hh.toFixed(3)}, 0.0, 1.0);
		float h2 = h * h;
		float turb = 1.0 + 0.12 * w * sin(uWindT * 3.1 + ph * 0.7);
		float tip = (${TIP[0].toFixed(4)} + ${TIP[1].toFixed(4)} * w) * ${(hh / STEM_H).toFixed(4)} * sc * vary * turb;
		float flut = (sin(uWindT * 2.6 + ph + h * 2.0) * 0.67 + sin(uWindT * 4.7 + ph * 1.7) * 0.33) * ${FLUTTER.toFixed(4)} * (0.3 + w) * ${(hh / STEM_H).toFixed(4)} * sc;
		float lean = h2 * tip;
		vec3 wd = vec3(uWindDir.x, 0.0, uWindDir.y);
		vec3 sd = vec3(-uWindDir.y, 0.0, uWindDir.x);
		vec3 disp = wd * lean + sd * flut * h2;
		disp.y -= 0.5 * lean * lean / (${hh.toFixed(3)} * sc);
		${
			head
				? `float th = atan(2.0 * h * tip / (${hh.toFixed(3)} * sc)) + 0.06 * (0.3 + w) * sin(uWindT * 3.3 + ph * 2.1);
		float cs = cos(th);
		float sn = sin(th);
		vec3 ax = vec3(wd.z, 0.0, -wd.x);
		vec3 pv = vec3(0.0, ${hh.toFixed(3)}, 0.0);
		vec3 rel = m3 * (position - pv);
		rel = rel * cs + cross(ax, rel) * sn + ax * dot(ax, rel) * (1.0 - cs);
		transformed = pv + (transpose(m3) * (rel + disp)) / s2;`
				: 'transformed += (transpose(m3) * disp) / s2;'
		}
	}`;
	const STEM_BODY = bendBody(STEM_H, false);
	const HEAD_BODY = bendBody(STEM_H, true);
	const BLADE_BODY = bendBody(BLADE_H, false);

	const flatTweak = (m) => {
		m.map = null;
		m.normalMap = null;
		m.roughnessMap = null;
	};
	const stemMat = windMaterial('#ffffff', 'strand', [1, 1], 'stem', STEM_BODY, flatTweak);
	const bladeMat = windMaterial('#ffffff', 'strand', [1, 1], 'blade', BLADE_BODY, (m) => {
		flatTweak(m);
		m.side = THREE.DoubleSide;
	});
	const daisyMat = windMaterial('#ffffff', 'stockinette', [2, 2], 'daisy', HEAD_BODY, (m) => {
		m.vertexColors = true;
	});
	const tulipMat = windMaterial('#ffffff', 'boucle', [3, 3], 'tulip', HEAD_BODY, (m) => {
		m.side = THREE.DoubleSide;
	});

	const stemGeo = kit.cachedGeo('meadowStem', () => {
		const g = new THREE.CylinderGeometry(0.0055, 0.0095, STEM_H, 5, 6);
		g.translate(0, STEM_H / 2, 0);
		return g;
	});
	const daisyGeo = kit.cachedGeo('meadowDaisy', () => {
		const parts = [];
		const N = 10;
		for (let i = 0; i < N; i++) {
			const upper = i % 2 === 0;
			const g = new THREE.SphereGeometry(1, 6, 4);
			g.scale(0.034, 0.007, 0.0135);
			g.translate(0.044, 0, 0);
			g.rotateZ(upper ? 0.34 : 0.12);
			g.rotateY((i / N) * TAU);
			g.translate(0, STEM_H + (upper ? 0.008 : 0.003), 0);
			parts.push(paint(g, '#ffffff'));
		}
		const c = new THREE.SphereGeometry(0.026, 10, 7);
		c.scale(1, 0.7, 1);
		c.translate(0, STEM_H + 0.008, 0);
		parts.push(paint(c, P.mustard));
		const g = mergeGeometries(parts);
		parts.forEach((p) => p.dispose());
		return g;
	});
	const tulipGeo = kit.cachedGeo('meadowTulip', () => {
		const prof = [
			[0.001, 0],
			[0.016, 0.008],
			[0.033, 0.03],
			[0.037, 0.055],
			[0.03, 0.078],
			[0.012, 0.093],
		].map(([r, y]) => new THREE.Vector2(r, y));
		const g = new THREE.LatheGeometry(prof, 10);
		g.translate(0, STEM_H - 0.01, 0);
		return g;
	});
	const bladeGeos = [bladeTuftGeometry(701), bladeTuftGeometry(702)].map((g, i) => kit.cachedGeo(`meadowBlades${i}`, () => g));

	const DAISY_COLORS = [P.white, P.cream, P.white, P.cream];
	const TULIP_COLORS = [P.coral, P.pink, P.lavender, P.coral, P.pink];
	const STEM_COLORS = [P.olive, P.pine, P.sage];
	const BLADE_COLORS = [P.olive, P.pine, P.grass, P.sage];

	// spots a plant may stand on
	const spotOk = (x, z, margin) =>
		sE(x / H, z / H) < PATCH_SE_MAX &&
		terrain.isGreen(x, z) &&
		terrain.riverQuery(x, z).d > 1.0 &&
		terrain.blockers.every(([bx, bz, br]) => Math.hypot(x - bx, z - bz) > br + margin) &&
		FLOWER_CLUSTERS.every(([cx, cz]) => Math.hypot(x - cx, z - cz) > SHORT_CLEAR) &&
		segDist(x, z, LINE_CLEAR[0], LINE_CLEAR[1], LINE_CLEAR[2], LINE_CLEAR[3]) > LINE_CLEAR[4];

	// patch centers: a couple beside tree bases, the rest near the island edges, none in the middle
	const centers = (() => {
		const cands = [];
		const score = (x, z) => {
			let ok = 0;
			for (let i = 0; i < 28; i++) {
				const a = rand() * TAU;
				const d = Math.sqrt(rand()) * 0.75;
				if (spotOk(x + Math.cos(a) * d, z + Math.sin(a) * d, 0.05)) ok++;
			}
			return ok / 28;
		};
		for (const tr of trees ?? []) {
			const tx = tr.g.position.x;
			const tz = tr.g.position.z;
			for (let k = 0; k < 12; k++) {
				const a = (k / 12) * TAU + rand() * 0.4;
				const d = 1.1 + rand() * 0.2;
				const x = tx + Math.cos(a) * d;
				const z = tz + Math.sin(a) * d;
				if (!spotOk(x, z, 0.3)) continue;
				const sc = score(x, z);
				if (sc > 0.45) cands.push({ x, z, tree: true, score: sc + 0.3 + rand() * 0.3 });
			}
		}
		for (let tries = 0; tries < 600; tries++) {
			const x = (rand() * 2 - 1) * H;
			const z = (rand() * 2 - 1) * H;
			const e = sE(x / H, z / H);
			if (e < 0.58 || e > 0.76 || !spotOk(x, z, 0.3)) continue;
			const sc = score(x, z);
			if (sc > 0.45) cands.push({ x, z, tree: false, score: sc + rand() * 0.3 });
		}
		cands.sort((a, b) => b.score - a.score);
		const out = [];
		const far = (c) => out.every((o) => Math.hypot(c.x - o.x, c.z - o.z) > PATCH_MIN_GAP);
		for (const c of cands) if (c.tree && out.length < 2 && far(c)) out.push(c);
		for (const c of cands) if (!c.tree && out.length < PATCHES && far(c)) out.push(c);
		for (const c of cands) if (out.length < PATCHES && far(c)) out.push(c);
		return out;
	})();

	const patchSources = [];
	{
		const m4 = new THREE.Matrix4();
		const tilt = new THREE.Matrix4();
		const tilt2 = new THREE.Matrix4();
		const rotM = new THREE.Matrix4();
		const eul = new THREE.Euler();
		const q = new THREE.Quaternion();
		const pos = new THREE.Vector3();
		const scl = new THREE.Vector3();
		const up = new THREE.Vector3(0, 1, 0);
		const col = new THREE.Color();
		const tint = (hex, spread) => col.set(hex).offsetHSL(0, 0, (rand() - 0.5) * spread);

		// plant matrix; heads also tilt about their pivot (the stem top) so they do not all face straight up
		const plantMatrix = (x, z, yaw, s, tx, tz, pivot) => {
			pos.set(x, terrain.heightAt(x, z) - 0.01, z);
			q.setFromAxisAngle(up, yaw);
			scl.setScalar(s);
			m4.compose(pos, q, scl);
			if (pivot) {
				rotM.makeRotationFromEuler(eul.set(tx, 0, tz));
				tilt.makeTranslation(0, pivot, 0).multiply(rotM).multiply(tilt2.makeTranslation(0, -pivot, 0));
				m4.multiply(tilt);
			}
			return m4;
		};

		centers.forEach((c, pi) => {
			const R = PATCH_R[0] + rand() * (PATCH_R[1] - PATCH_R[0]);
			const nFlowers = PATCH_FLOWERS[0] + Math.floor(rand() * (PATCH_FLOWERS[1] - PATCH_FLOWERS[0] + 1));
			const nBlades = PATCH_BLADES[0] + Math.floor(rand() * (PATCH_BLADES[1] - PATCH_BLADES[0] + 1));
			const taken = [];
			const place = (want, gap) => {
				const list = [];
				for (let tries = 0; list.length < want && tries < 300; tries++) {
					const a = rand() * TAU;
					const d = Math.sqrt(rand()) * R;
					const x = c.x + Math.cos(a) * d;
					const z = c.z + Math.sin(a) * d;
					if (!spotOk(x, z, 0.05)) continue;
					if (taken.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < gap)) continue;
					list.push([x, z]);
					taken.push([x, z]);
				}
				return list;
			};
			const flowers = place(nFlowers, 0.13);
			const blades = place(nBlades, 0.08);
			if (!flowers.length) return;
			const daisies = [];
			const tulips = [];
			for (const f of flowers) (rand() < 0.5 ? daisies : tulips).push(f);

			const group = new THREE.Group();
			root.add(group);
			const finish = (mesh) => {
				mesh.castShadow = false; // the bent plants would not match an unbent shadow
				mesh.receiveShadow = true;
				group.add(mesh);
				return mesh;
			};

			const stems = new THREE.InstancedMesh(stemGeo, stemMat, flowers.length);
			let si = 0;
			const stemFor = ([x, z], yaw, s) => {
				stems.setMatrixAt(si, plantMatrix(x, z, yaw, s, 0, 0, 0));
				stems.setColorAt(si, tint(pick(STEM_COLORS, rand()), 0.06));
				si++;
			};
			const headMesh = (list, geo, material, colors, tiltMax) => {
				if (!list.length) return;
				const mesh = new THREE.InstancedMesh(geo, material, list.length);
				list.forEach((f, i) => {
					const yaw = rand() * TAU;
					const s = SCALE[0] + rand() * (SCALE[1] - SCALE[0]);
					mesh.setMatrixAt(i, plantMatrix(f[0], f[1], yaw, s, (rand() - 0.5) * tiltMax, (rand() - 0.5) * tiltMax, STEM_H));
					mesh.setColorAt(i, tint(pick(colors, rand()), 0.05));
					stemFor(f, yaw, s);
				});
				finish(mesh);
			};
			headMesh(daisies, daisyGeo, daisyMat, DAISY_COLORS, 0.36);
			headMesh(tulips, tulipGeo, tulipMat, TULIP_COLORS, 0.16);
			finish(stems);

			if (blades.length) {
				const mesh = new THREE.InstancedMesh(bladeGeos[pi % 2], bladeMat, blades.length);
				blades.forEach(([x, z], i) => {
					const s = 0.8 + rand() * 0.3;
					mesh.setMatrixAt(i, plantMatrix(x, z, rand() * TAU, s, 0, 0, 0));
					mesh.setColorAt(i, tint(pick(BLADE_COLORS, rand()), 0.06));
				});
				finish(mesh);
			}

			items.push({ obj: group, stage: 'flower', clip: true, base: new THREE.Vector3(c.x, terrain.heightAt(c.x, c.z), c.z) });
			patchSources.push({ x: c.x, z: c.z, y: terrain.heightAt(c.x, c.z) + 0.38, rad: R * 0.8, dy: 0.12, tree: false });
		});
	}

	// ---------------------------------------------------------------------
	// 2. Petal and leaf drift
	// ---------------------------------------------------------------------
	const sources = [...patchSources];
	for (const tr of trees ?? []) {
		// crown sphere in buildTrees: center 0.55 + 0.85 r above the trunk base, radius r, all times the group scale
		const sc = tr.g.scale.x;
		const r = (tr.r ?? 0.55) * sc;
		sources.push({
			x: tr.g.position.x,
			z: tr.g.position.z,
			y: tr.g.position.y + sc * 0.55 + 0.85 * r,
			rad: r * 0.85,
			dy: r * 1.1,
			tree: true,
		});
	}
	for (const s of sources) s.s = s.x * dirX + s.z * dirZ;

	const petalMat = new THREE.MeshStandardMaterial({
		color: '#ffffff',
		roughness: 1,
		emissive: P.white,
		emissiveIntensity: 0.12,
		side: THREE.DoubleSide,
	});
	const mesh = new THREE.InstancedMesh(petalGeometry(), petalMat, PETAL_POOL);
	mesh.frustumCulled = false;
	mesh.castShadow = false;
	mesh.receiveShadow = false;
	mesh.raycast = noRaycast;
	root.add(mesh);

	const PETAL_COLORS = [P.pink, P.cream, P.white, P.coral, P.lavender];
	const TREE_PETAL_COLORS = [P.pink, P.cream, P.white, P.coral];
	const LEAF_COLORS = [P.grass, P.sage, P.olive];

	const _m = new THREE.Matrix4();
	const _q = new THREE.Quaternion();
	const _e = new THREE.Euler();
	const _p = new THREE.Vector3();
	const _s = new THREE.Vector3();
	const _c = new THREE.Color('#ffffff');
	const HIDE = new THREE.Matrix4().compose(new THREE.Vector3(0, -50, 0), new THREE.Quaternion(), new THREE.Vector3(0.0001, 0.0001, 0.0001));

	const pool = [];
	for (let i = 0; i < PETAL_POOL; i++) {
		mesh.setMatrixAt(i, HIDE);
		mesh.setColorAt(i, _c);
		pool.push({
			i,
			active: false,
			ground: false,
			age: 0,
			life: 8,
			x: 0,
			y: 0,
			z: 0,
			vx: 0,
			vy: 0,
			vz: 0,
			sx: 0.04,
			sy: 0.03,
			heavy: 0,
			ph: 0,
			ph1: 0,
			ph2: 0,
			w1: 3,
			w2: 2.5,
			spin: 0,
			w3: 2,
			amp: 1,
			flat: 0,
		});
	}
	mesh.instanceMatrix.needsUpdate = true;
	mesh.instanceColor.needsUpdate = true;
	let colorDirty = false;
	let anyActive = false;
	let rover = 0;

	let prevS = gu.uGustS.value;
	let trickleAcc = 0;

	function spawn(src, burst) {
		let p = null;
		for (let k = 0; k < PETAL_POOL; k++) {
			const q = pool[(rover + k) % PETAL_POOL];
			if (!q.active) {
				p = q;
				rover = (rover + k + 1) % PETAL_POOL;
				break;
			}
		}
		if (!p) return;
		const leaf = Math.random() < (src.tree ? 0.5 : 0.12);
		const a = Math.random() * TAU;
		const d = Math.sqrt(Math.random()) * src.rad;
		p.active = true;
		p.ground = false;
		p.age = 0;
		p.life = PETAL_LIFE[0] + Math.random() * (PETAL_LIFE[1] - PETAL_LIFE[0]);
		p.x = src.x + Math.cos(a) * d;
		p.z = src.z + Math.sin(a) * d;
		p.y = src.y + (Math.random() - 0.5) * src.dy;
		const sp = PETAL_DRIFT[0] + PETAL_DRIFT[1] * wind.at(p.x, p.z);
		p.vx = dirX * sp * 0.4;
		p.vz = dirZ * sp * 0.4;
		p.vy = burst ? 0.25 + Math.random() * 0.3 : 0.05;
		const size = leaf
			? LEAF_SIZE[0] + Math.random() * (LEAF_SIZE[1] - LEAF_SIZE[0])
			: PETAL_SIZE[0] + Math.random() * (PETAL_SIZE[1] - PETAL_SIZE[0]);
		p.sx = leaf ? size * 1.15 : size;
		p.sy = leaf ? size * 0.55 : size * 0.8;
		p.heavy = leaf ? 0.5 + Math.random() * 0.5 : Math.random() * 0.6;
		p.ph = Math.random() * TAU;
		p.ph1 = Math.random() * TAU;
		p.ph2 = Math.random() * TAU;
		p.w1 = 2.5 + Math.random() * 2;
		p.w2 = 2 + Math.random() * 1.5;
		p.w3 = (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 2.5);
		p.spin = Math.random() * TAU;
		p.amp = 1;
		p.flat = (Math.random() - 0.5) * 0.2;
		const palette = leaf ? LEAF_COLORS : src.tree ? TREE_PETAL_COLORS : PETAL_COLORS;
		_c.set(pick(palette, Math.random())).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
		mesh.setColorAt(p.i, _c);
		colorDirty = true;
	}

	function kill(p) {
		p.active = false;
		mesh.setMatrixAt(p.i, HIDE);
	}

	function update(t, dt) {
		dt = Math.min(dt, 0.05);

		// emission: gust band crossing a source, plus a trickle that follows the wind
		const S = gu.uGustS.value;
		if (gu.uGustAmp.value > GUST_MIN) {
			for (const src of sources) {
				if (prevS < src.s && S >= src.s) {
					const n = BURST[0] + Math.floor(Math.random() * (BURST[1] - BURST[0] + 1));
					for (let k = 0; k < n; k++) spawn(src, true);
				}
			}
		}
		prevS = S;
		if (sources.length) {
			trickleAcc += dt * TRICKLE * Math.min(2, wind.at(0, 0) / BREEZE_MAX);
			while (trickleAcc >= 1) {
				trickleAcc -= 1;
				spawn(sources[Math.floor(Math.random() * sources.length)], false);
			}
		}

		// motion
		let live = false;
		for (const p of pool) {
			if (!p.active) continue;
			p.age += dt;
			if (p.age >= p.life) {
				kill(p);
				continue;
			}
			live = true;
			const w = wind.at(p.x, p.z);
			if (!p.ground) {
				const k = Math.min(1, dt * PETAL_DRAG);
				const sp = PETAL_DRIFT[0] + PETAL_DRIFT[1] * w;
				const sway = PETAL_SWAY * Math.sin(p.age * 1.6 + p.ph);
				p.vx += (dirX * sp - dirZ * sway - p.vx) * k;
				p.vz += (dirZ * sp + dirX * sway - p.vz) * k;
				const vyT =
					-(PETAL_SINK[0] + PETAL_SINK[1] * p.heavy) +
					PETAL_LIFT * Math.max(0, w - BREEZE_MAX) +
					0.06 * Math.sin(p.age * 2.3 + p.ph1);
				p.vy += (vyT - p.vy) * Math.min(1, dt * 3);
				p.x += p.vx * dt;
				p.z += p.vz * dt;
				p.y += p.vy * dt;
				p.spin += dt * p.w3 * (0.5 + w);
				const e = sE(p.x / H, p.z / H);
				if (e > 1 && p.life > p.age + PETAL_FADE) p.life = p.age + PETAL_FADE;
				const g = terrain.groundAt(p.x, p.z) + 0.012;
				if (p.y <= g) {
					p.y = g;
					p.ground = true;
					const onWater = terrain.riverQuery(p.x, p.z).d < 0.55;
					const lie = onWater ? 0 : PETAL_LIE[0] + Math.random() * (PETAL_LIE[1] - PETAL_LIE[0]);
					p.life = Math.min(p.life, p.age + lie + PETAL_FADE);
				}
			}
			p.amp += ((p.ground ? 0.1 : 1) - p.amp) * Math.min(1, dt * 6);

			const sc = sstep(0, 0.3, p.age) * (1 - sstep(p.life - PETAL_FADE, p.life, p.age));
			_e.set(-Math.PI / 2 + p.flat + p.amp * 0.9 * Math.sin(p.age * p.w1 + p.ph1), p.spin, p.amp * 1.0 * Math.sin(p.age * p.w2 + p.ph2), 'YXZ');
			_q.setFromEuler(_e);
			_p.set(p.x, p.y, p.z);
			const s = Math.max(0.0001, sc);
			_s.set(p.sx * s, p.sy * s, p.sx * s);
			mesh.setMatrixAt(p.i, _m.compose(_p, _q, _s));
		}
		if (live || anyActive) mesh.instanceMatrix.needsUpdate = true;
		anyActive = live;
		if (colorDirty) {
			mesh.instanceColor.needsUpdate = true;
			colorDirty = false;
		}
	}

	function reset() {
		for (const p of pool) kill(p);
		mesh.instanceMatrix.needsUpdate = true;
		trickleAcc = 0;
		anyActive = false;
		prevS = gu.uGustS.value;
	}

	return { update, items, reset };
}
