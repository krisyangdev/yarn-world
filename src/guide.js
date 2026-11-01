import * as THREE from 'three';

// 拉线提示：在线头绒球上叠一个脉冲圆环、一只循环演示拖动的手，开头阶段再加「Pull the thread」标签。
// 世界坐标投影到屏幕后用 DOM 绘制；手的滑动方向由 dir 投影得到，每帧在 JS 里算，镜头环绕时方向跟着转。
const SLIDE = 80; // 手滑动的像素距离
const LOOP = 2; // 手势循环秒数
const RING_LOOP = 1.4;
const HAND_SVG = '<svg viewBox="0 0 40 40" width="40" height="40" style="position:absolute;left:-17px;top:-3.5px;overflow:visible;filter:drop-shadow(0 2px 3px rgba(80,50,30,.3))"><path d="M13 21V7.5a4 4 0 0 1 8 0V16a3 3 0 0 1 6 0a3 3 0 0 1 6 2V28a9 9 0 0 1-9 9H20a8 8 0 0 1-6.5-3.5L7.5 24.5a2.8 2.8 0 0 1 4.5-3.3L13 22.5Z" fill="#fff" stroke="#3b2f28" stroke-width="2" stroke-linejoin="round"/></svg>';

const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));

export function setupGuide({ camera, dom }) {
	const make = (css, html = '') => {
		const el = document.createElement('div');
		el.style.cssText = css;
		el.innerHTML = html;
		return el;
	};
	const root = make('position:fixed;inset:0;z-index:10;pointer-events:none;opacity:0;transition:opacity .25s ease');
	const ring = make('position:absolute;left:0;top:0;width:36px;height:36px;box-sizing:border-box;border-radius:50%;border:3px solid rgba(255,250,243,.95);box-shadow:0 2px 10px rgba(140,90,50,.35);will-change:transform,opacity');
	const hand = make('position:absolute;left:0;top:0;width:0;height:0;will-change:transform,opacity', HAND_SVG);
	const label = make('position:absolute;left:0;top:0;padding:4px 10px;border-radius:999px;background:rgba(255,250,243,.92);color:#3b2f28;font:14px/1.3 system-ui,sans-serif;white-space:nowrap', 'Pull the thread');
	root.append(ring, hand, label);
	document.body.appendChild(root);

	const reduced = matchMedia('(prefers-reduced-motion: reduce)');
	const a = new THREE.Vector3();
	const b = new THREE.Vector3();
	let time = 0;
	let shown = false;
	let kind = '';

	// 把世界点投到屏幕像素，返回是否在镜头前且在画布内
	function project(p, rect, out) {
		a.copy(p).project(camera);
		out.x = rect.left + (a.x * 0.5 + 0.5) * rect.width;
		out.y = rect.top + (0.5 - a.y * 0.5) * rect.height;
		return a.z > -1 && a.z < 1 && out.x >= rect.left && out.x <= rect.right && out.y >= rect.top && out.y <= rect.bottom;
	}
	const p0 = { x: 0, y: 0 };
	const p1 = { x: 0, y: 0 };

	function show(on) {
		if (on === shown) return;
		shown = on;
		root.style.opacity = on ? '1' : '0';
	}

	return {
		update(hint, dt) {
			if (!hint) return show(false);
			camera.updateMatrixWorld();
			const rect = dom.getBoundingClientRect();
			if (!project(hint.point, rect, p0)) return show(false);
			show(true);
			time += dt;

			// 屏幕方向：线头沿 dir 走 0.6 个单位后的投影位移
			b.copy(hint.point).addScaledVector(hint.dir, 0.6);
			project(b, rect, p1);
			let dx = p1.x - p0.x;
			let dy = p1.y - p0.y;
			const len = Math.hypot(dx, dy) || 1;
			dx /= len;
			dy /= len;

			if (hint.kind !== kind) {
				kind = hint.kind;
				label.style.display = kind === 'start' ? '' : 'none';
			}

			const still = reduced.matches;
			const r = (time % RING_LOOP) / RING_LOOP;
			const rs = still ? 1 : 0.8 + 0.5 * r;
			ring.style.opacity = still ? '1' : String(Math.min(1, r * 8) * (1 - r));
			ring.style.transform = `translate(${p0.x - 18}px,${p0.y - 18}px) scale(${rs})`;

			// 手势：0–0.25 出现并按下，0.25–1.15 滑动，1.15–1.4 抬起淡出，其余时间停顿
			hand.style.display = still ? 'none' : '';
			if (!still) {
				const t = time % LOOP;
				let e = 0;
				let s = 0.9;
				let o = 1;
				if (t < 0.25) {
					o = t / 0.25;
					s = 1 - 0.1 * o;
				} else if (t < 1.15) {
					e = easeInOut((t - 0.25) / 0.9);
				} else if (t < 1.4) {
					const k = (t - 1.15) / 0.25;
					e = 1;
					s = 0.9 + 0.1 * k;
					o = 1 - k;
				} else o = 0;
				hand.style.opacity = String(o);
				hand.style.transform = `translate(${p0.x + dx * SLIDE * e}px,${p0.y + dy * SLIDE * e}px) scale(${s})`;
			}

			// 标签放在拖动终点之外，沿方向退到标签盒子外缘再多留 10px
			if (kind === 'start') {
				const off = SLIDE + 10 + Math.min(34 / (Math.abs(dx) || 1e-3), 14 / (Math.abs(dy) || 1e-3));
				label.style.transform = `translate(${p0.x + dx * off}px,${p0.y + dy * off}px) translate(-50%,-50%)`;
			}
		},
	};
}
