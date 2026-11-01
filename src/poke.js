// Pointer interaction: grabbing threads, poking things, hover feedback.
// - Grab: a press near a grabbable (world.grabbables) that then moves more than CLICK_SLOP px holds it;
//   the hand point is the ground under the cursor raised by GRAB_LIFT. The press is swallowed so
//   OrbitControls doesn't also start rotating; released without moving it counts as a poke.
// - Poke: a mesh is poke-able when it or an ancestor has userData.onPoke; a press that moves less than
//   CLICK_SLOP px counts as a poke, anything longer is an orbit drag.
import * as THREE from 'three';
import { unlockAudio } from './sound.js';

const CLICK_SLOP = 6;
const GRAB_LIFT = 0.35;
const MARCH_STEP = 0.08;
const MARCH_FAR = 60;

function pokeable(obj) {
	for (let o = obj; o; o = o.parent) if (typeof o.userData.onPoke === 'function') return o;
	return null;
}

export function setupPoke({ dom, camera, controls, targets, grabbables = [], groundAt, onPoke }) {
	const raycaster = new THREE.Raycaster();
	raycaster.firstHitOnly = true;
	const ndc = new THREE.Vector2();
	const hand = new THREE.Vector3();
	const probe = new THREE.Vector3();
	let down = null;
	let hovered = null;
	let pending = null; // grabbable under the press, until the pointer moves
	let grip = null; // { handle, autoRotate }

	function aim(e) {
		const r = dom.getBoundingClientRect();
		ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
		raycaster.setFromCamera(ndc, camera);
	}

	function pickPoke() {
		const hit = raycaster.intersectObjects(targets, false)[0];
		const owner = hit && pokeable(hit.object);
		return owner ? { hit, owner } : null;
	}

	function pickGrab() {
		let best = null;
		for (const g of grabbables) {
			const p = g.pick(raycaster.ray, camera);
			if (p && (!best || p.distance < best.distance)) best = { distance: p.distance, g };
		}
		return best?.g ?? null;
	}

	// Ground point under the cursor (march along the ray, then bisect), raised to hand height.
	// Off the island the hand keeps its last height on a horizontal plane.
	function handPoint() {
		const { origin, direction } = raycaster.ray;
		let prev = 0;
		for (let s = MARCH_STEP; s < MARCH_FAR; s += MARCH_STEP) {
			probe.copy(origin).addScaledVector(direction, s);
			if (probe.y > groundAt(probe.x, probe.z)) {
				prev = s;
				continue;
			}
			let lo = prev;
			let hi = s;
			for (let k = 0; k < 8; k++) {
				const mid = (lo + hi) / 2;
				probe.copy(origin).addScaledVector(direction, mid);
				if (probe.y > groundAt(probe.x, probe.z)) lo = mid;
				else hi = mid;
			}
			return hand.copy(origin).addScaledVector(direction, hi).setY(probe.y + GRAB_LIFT);
		}
		if (Math.abs(direction.y) > 1e-4) {
			const s = (hand.y - origin.y) / direction.y;
			if (s > 0) return hand.copy(origin).addScaledVector(direction, s);
		}
		return hand;
	}

	function setHover(next, cursor) {
		if (next !== hovered) {
			hovered?.userData.onHover?.(false);
			next?.userData.onHover?.(true);
			hovered = next;
		}
		dom.style.cursor = cursor;
	}

	// capture phase: runs before OrbitControls' own pointerdown so a grab can swallow the press
	dom.addEventListener(
		'pointerdown',
		(e) => {
			unlockAudio();
			down = { x: e.clientX, y: e.clientY };
			aim(e);
			pending = pickGrab();
			if (!pending) return;
			e.stopImmediatePropagation();
			dom.setPointerCapture(e.pointerId);
		},
		{ capture: true },
	);

	dom.addEventListener('pointermove', (e) => {
		aim(e);
		// a press on a grabbable becomes a grab only once it moves; a still press stays a poke
		if (pending && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) {
			grip = { handle: pending.grab(), autoRotate: controls.autoRotate };
			pending = null;
			controls.autoRotate = false;
			setHover(null, 'grabbing');
		}
		if (grip) {
			grip.handle.move(handPoint());
			return;
		}
		if (down || e.pointerType !== 'mouse') return;
		const grabbable = pickGrab();
		const owner = pickPoke()?.owner ?? null;
		setHover(owner, grabbable ? 'grab' : owner ? 'pointer' : '');
	});

	dom.addEventListener('pointercancel', () => {
		pending = null;
		if (!grip) return;
		grip.handle.release();
		controls.autoRotate = grip.autoRotate;
		grip = null;
		down = null;
	});

	dom.addEventListener('pointerup', (e) => {
		if (grip) {
			grip.handle.release();
			controls.autoRotate = grip.autoRotate;
			grip = null;
			down = null;
			dom.style.cursor = 'grab';
			return;
		}
		if (!down) return;
		const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
		down = null;
		pending = null;
		if (moved > CLICK_SLOP) return;
		aim(e);
		const p = pickPoke();
		if (!p) return;
		p.owner.userData.onPoke(p.hit);
		onPoke?.(p.hit);
	});

	dom.addEventListener('pointerleave', () => {
		if (!grip) setHover(null, '');
	});
}
