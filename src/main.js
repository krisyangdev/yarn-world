import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildWorld } from './world.js';
import { DofPass, makeDepthTarget } from './dof.js';
import { setupPoke } from './poke.js';
import { setupGuide } from './guide.js';
import { setMuted, isMuted, audioGraph } from './sound.js';
import { setupAmbience } from './ambience.js';
import { S } from './layout.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ?dof=0 关掉景深；?still=1 停止自动环绕（截图用）
const params = new URLSearchParams(location.search);
const useDof = params.get('dof') !== '0';
const still = params.get('still') === '1';

// 场景画进带深度的离屏缓冲，画布本身的多重采样用不上
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#f1dcc4');
scene.fog = new THREE.Fog('#f1dcc4', S(24), 62);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.25;

// 偏低的暖色太阳，拉出长影子和针脚的明暗
const sun = new THREE.DirectionalLight('#ffe6c4', 3.4);
sun.position.set(9, 7, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
sun.shadow.camera.far = 40;
sun.shadow.radius = 6;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(new THREE.HemisphereLight('#fde8d2', '#7a6a5c', 0.55));

const world = buildWorld(scene);
const focus = world.focusTarget ?? new THREE.Vector3(0, 0.6, 0);

// ?cam=x,y,z&tgt=x,y,z 指定机位（截图用）
const vec = (s) => s && new THREE.Vector3(...s.split(',').map(Number));
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 100);
camera.position.copy(vec(params.get('cam')) ?? new THREE.Vector3(S(9), S(6.5), S(11)));
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(vec(params.get('tgt')) ?? focus);
controls.enableDamping = true;
controls.autoRotate = !still;
controls.autoRotateSpeed = 0.35;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 4;
controls.maxDistance = S(30);

const pr = renderer.getPixelRatio();
const composer = new EffectComposer(renderer, makeDepthTarget(innerWidth * pr, innerHeight * pr));
composer.addPass(new RenderPass(scene, camera));
const bokeh = new DofPass(camera, { focus: 14, aperture: 0.0008, maxblur: 0.004, focusRange: 0.2 });
bokeh.enabled = useDof;
composer.addPass(bokeh);
composer.addPass(new OutputPass());
// 开场时世界是隐藏的，物体第一次出现才编译着色器会卡一下；加载时把整个场景（含隐藏物体）的材质先编译好。
// 场景实际画进 composer 的缓冲（线性色彩、不做色调映射），编译时也要对着它，程序才对得上
renderer.setRenderTarget(composer.readBuffer);
renderer.compileAsync(scene, camera);
renderer.setRenderTarget(null);

function resize() {
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(innerWidth, innerHeight);
	composer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);

// 自适应分辨率：帧率追不上屏幕刷新率时，帧间隔会在一次和两次刷新之间跳，看起来一顿一顿。
// 开头 3 秒测出屏幕刷新间隔（帧间隔的 10% 分位），之后每 2 秒看平均帧率，
// 低于刷新率的 90% 就把像素比降 0.25（最低 1），只降不升，避免清晰度来回跳
const startupDts = [];
let refreshFps = 60;
let fpsFrames = 0;
let fpsTime = 0;
function measureRefresh(dt) {
	startupDts.push(dt);
}
function adaptPixelRatio(dt) {
	if (startupDts.length) {
		startupDts.sort((a, b) => a - b);
		refreshFps = Math.round(1 / startupDts[Math.floor(startupDts.length * 0.1)]);
		startupDts.length = 0;
	}
	fpsFrames++;
	fpsTime += dt;
	if (fpsTime < 2) return;
	const fps = fpsFrames / fpsTime;
	fpsFrames = fpsTime = 0;
	const cur = renderer.getPixelRatio();
	if (fps >= refreshFps * 0.9 || cur <= 1) return;
	const next = Math.max(1, cur - 0.25);
	renderer.setPixelRatio(next);
	composer.setPixelRatio(next);
	resize();
}

// ?debug=1：左上角显示帧率和当前像素比，每 0.5 秒刷新
const debug = params.get('debug') === '1';
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;top:10px;left:10px;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;font:12px/1.4 ui-monospace,monospace;pointer-events:none';
if (debug) document.body.appendChild(hud);
let hudFrames = 0;
let hudTime = 0;
function updateHud(dt) {
	if (!debug) return;
	hudFrames++;
	hudTime += dt;
	if (hudTime < 0.5) return;
	hud.textContent = `${Math.round(hudFrames / hudTime)}/${refreshFps} fps · ${(1000 * hudTime / hudFrames).toFixed(1)} ms · ${renderer.getPixelRatio()}x`;
	hudFrames = hudTime = 0;
}

// 自动对焦：每帧从屏幕中心打射线，对焦到打中的物体；绒毛壳层不参与。
// 几何体建 BVH 后射线检测从约 1.7 ms 降到可忽略，不会拖慢某一帧
const focusTargets = [];
scene.traverse((o) => {
	if (!o.isMesh || o.isInstancedMesh) return;
	if (!o.geometry.boundsTree) o.geometry.computeBoundsTree();
	focusTargets.push(o);
});
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const screenCenter = new THREE.Vector2(0, 0);
let focusDist = camera.position.distanceTo(controls.target);

// 点一下戳物体，鼠标悬停时物体会鼓一下；和自动对焦共用同一批带 BVH 的网格。
// 戳到的点会锁定焦点 FOCUS_HOLD 秒（像手机点屏幕对焦），之后回到屏幕中心自动对焦
const timer = new THREE.Timer();
const FOCUS_HOLD = 4;
const focusLock = { point: new THREE.Vector3(), until: -1 };
setupPoke({
	dom: renderer.domElement,
	camera,
	controls,
	targets: focusTargets,
	grabbables: world.grabbables,
	groundAt: world.groundAt,
	onPoke: (hit) => {
		focusLock.point.copy(hit.point);
		focusLock.until = timer.getElapsed() + FOCUS_HOLD;
	},
});

const guide = setupGuide({ camera, dom: renderer.domElement });

renderer.setAnimationLoop(() => {
	timer.update();
	const rawDt = timer.getDelta();
	const dt = Math.min(rawDt, 0.05);
	const t = timer.getElapsed();
	controls.update(dt);
	if (useDof && t < focusLock.until) {
		focusDist = camera.position.distanceTo(focusLock.point);
	} else if (useDof) {
		raycaster.setFromCamera(screenCenter, camera);
		const hit = raycaster.intersectObjects(focusTargets, false)[0];
		if (hit) focusDist = hit.distance;
	}
	bokeh.uniforms.focus.value += (focusDist - bokeh.uniforms.focus.value) * Math.min(1, dt * 6);
	world.update?.(t, dt);
	guide.update(world.hint, dt);
	ambience(dt);
	composer.render(dt);
	updateHud(rawDt);
	if (t < 3) measureRefresh(rawDt);
	else adaptPixelRatio(rawDt);
});

// 右上角静音按钮，M 键同样切换
const SPEAKER_ON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';
const muteBtn = document.createElement('button');
muteBtn.style.cssText = 'position:fixed;top:10px;right:10px;width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;cursor:pointer';
const syncMute = () => {
	muteBtn.innerHTML = isMuted() ? SPEAKER_OFF : SPEAKER_ON;
	muteBtn.setAttribute('aria-label', isMuted() ? 'Unmute' : 'Mute');
};
const toggleMute = () => {
	setMuted(!isMuted());
	syncMute();
};
muteBtn.addEventListener('click', toggleMute);
document.body.appendChild(muteBtn);
syncMute();

const ambience = setupAmbience({ camera, target: controls.target, riverPoint: world.riverPoint, windAt: world.wind.at });

// R 键把毛线团、羊和线恢复原样（录视频重拍用），M 键静音
addEventListener('keydown', (e) => {
	if (e.key === 'r' || e.key === 'R') world.reset();
	if (e.key === 'm' || e.key === 'M') toggleMute();
});

// ?debug=1 把渲染对象挂到 window 上，方便在控制台里量性能
if (debug) Object.assign(window, { THREE, world, audioGraph, isMuted, renderer, scene, camera, composer, bokeh, sun, controls, focusTargets });
