import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Blanket: a huge knitted quilt under the island. It fills the whole view and fades into the fog, so the
// cushion never sits on a visible edge.
//
// A disc of large quilt patches (a square lattice rotated by TILT so seams do not line up with the island's
// quilt). Each patch is a subdivided grid; all patches of one color are merged into one mesh (4 draw calls).
// Soft folds are a smooth height function of world xz: 0 inside clearR, full strength from 2 * clearR out.
// The same function drives every patch, so seams stay closed. Normals come from the function's gradient
// (not computeVertexNormals), so shading is continuous across patch borders.
// uv are patch-local world units; the material repeat turns them into ~STITCH sized garter stitches.
// ---------------------------------------------------------------------------
const RADIUS = 70; // disc radius, beyond the fog far plane
const PATCH = 5; // patch edge length
const CELL = 0.8; // grid cell size inside a patch
const TILT = (20 * Math.PI) / 180;
const STITCH = 0.13; // world size of one stitch (the island uses 0.1)
const COLORS = ['#eadbc6', '#dfc7b4', '#d2d6bd', '#e6d2a8']; // oat, rose-beige, sage-gray, honey
const AMP = 0.35; // fold height at full strength
const WRINKLE = 0.03; // small fabric wrinkle on top of the folds
const RAMP_FROM = 1; // folds start at clearR * RAMP_FROM
const RAMP_TO = 2; // and reach full height at clearR * RAMP_TO
const EPS = 0.05; // finite difference step for normals

const smoothstep = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

// integer hash -> [0, 1)
function hash(i, j, s) {
	let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1440670441)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

// long, low waves: [weight, wavelength, direction angle, phase]
const WAVES = [
	[0.5, 13, 0.45, 0.7],
	[0.3, 9, 1.95, 2.1],
	[0.2, 7.5, 3.3, 4.0],
].map(([w, wl, a, ph]) => ({ w, k: (Math.PI * 2) / wl, dx: Math.cos(a), dz: Math.sin(a), ph }));
const WR_K = (Math.PI * 2) / 1.9;
const WR_D = [Math.cos(1.1), Math.sin(1.1)];

function fold(x, z, clearR) {
	const r = Math.hypot(x, z);
	const ramp = smoothstep(clearR * RAMP_FROM, clearR * RAMP_TO, r);
	if (ramp === 0) return 0;
	let s = 0;
	for (const { w, k, dx, dz, ph } of WAVES) {
		// slow phase wobble keeps the ridges from looking like perfect sine bands
		s += w * Math.sin(k * (x * dx + z * dz) + ph + 0.8 * Math.sin(k * 0.55 * (x * dz - z * dx)));
	}
	const env = 0.5 + 0.5 * Math.sin(0.23 * x - 0.31 * z + 1.3);
	const wr = WRINKLE * env * Math.sin(WR_K * (x * WR_D[0] + z * WR_D[1]) + 1.5 * Math.sin(0.4 * (x * WR_D[1] - z * WR_D[0])));
	return ramp * (AMP * s + wr);
}

// `y`: blanket top height (lowest point of the cushion underside); `clearR`: radius that stays perfectly flat
export function buildBlanket({ kit, y, clearR }) {
	const group = new THREE.Group();
	group.name = 'blanket';

	const cosT = Math.cos(TILT);
	const sinT = Math.sin(TILT);
	const n = Math.ceil(RADIUS / PATCH) + 1;

	// patch colors: neighbours to the left and below always differ
	const colorOf = new Map();
	const patches = [];
	for (let i = -n; i <= n; i++) {
		for (let j = -n; j <= n; j++) {
			if (Math.hypot((i + 0.5) * PATCH, (j + 0.5) * PATCH) > RADIUS) continue;
			const banned = [colorOf.get(`${i - 1},${j}`), colorOf.get(`${i},${j - 1}`)];
			const allowed = COLORS.map((_, c) => c).filter((c) => !banned.includes(c));
			const c = allowed[Math.floor(hash(i, j, 7) * allowed.length)];
			colorOf.set(`${i},${j}`, c);
			patches.push({ i, j, c });
		}
	}

	const cells = Math.max(1, Math.round(PATCH / CELL));
	const step = PATCH / cells;
	const row = cells + 1;
	const vPer = row * row;
	for (let c = 0; c < COLORS.length; c++) {
		const mine = patches.filter((p) => p.c === c);
		const pos = new Float32Array(mine.length * vPer * 3);
		const nor = new Float32Array(mine.length * vPer * 3);
		const uv = new Float32Array(mine.length * vPer * 2);
		const idx = new Uint32Array(mine.length * cells * cells * 6);
		let vi = 0;
		let ti = 0;
		mine.forEach(({ i, j }, pi) => {
			const base = pi * vPer;
			for (let b = 0; b <= cells; b++) {
				for (let a = 0; a <= cells; a++) {
					const lx = i * PATCH + a * step;
					const lz = j * PATCH + b * step;
					const x = cosT * lx - sinT * lz;
					const z = sinT * lx + cosT * lz;
					const hx = (fold(x + EPS, z, clearR) - fold(x - EPS, z, clearR)) / (2 * EPS);
					const hz = (fold(x, z + EPS, clearR) - fold(x, z - EPS, clearR)) / (2 * EPS);
					const il = 1 / Math.hypot(hx, 1, hz);
					pos.set([x, y + fold(x, z, clearR), z], vi * 3);
					nor.set([-hx * il, il, -hz * il], vi * 3);
					uv.set([lx, lz], vi * 2);
					vi++;
				}
			}
			for (let b = 0; b < cells; b++) {
				for (let a = 0; a < cells; a++) {
					const v00 = base + b * row + a;
					const v10 = v00 + 1;
					const v01 = v00 + row;
					const v11 = v01 + 1;
					idx.set([v00, v01, v10, v10, v01, v11], ti);
					ti += 6;
				}
			}
		});
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
		g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
		g.setIndex(new THREE.BufferAttribute(idx, 1));
		// garter tile = 4 stitches across, 6 ridges along
		const mesh = new THREE.Mesh(g, kit.mat(COLORS[c], 'garter', [1 / (4 * STITCH), 1 / (6 * STITCH)]));
		mesh.receiveShadow = true;
		mesh.castShadow = false;
		mesh.matrixAutoUpdate = false;
		group.add(mesh);
	}
	return group;
}
