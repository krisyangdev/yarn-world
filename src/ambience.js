// Looping ambience: wind and birds as stereo beds, river as a positional source. The wind bed swells while
// a gust passes the camera target.
// Everything waits for audioGraph() and the three decoded loops, then starts once.
import { Vector3 } from 'three';
import { S } from './layout.js';
import { audioGraph } from './sound.js';
import { BREEZE_MAX } from './wind.js';

const FADE_IN = 3; // seconds
const TICK = 0.15; // seconds between gain and river updates

const WIND_NEAR = 4; // camera distance with the quietest wind
const WIND_FAR = S(30); // camera distance with the loudest wind
const WIND_GAIN_NEAR = 0.12;
const WIND_GAIN_FAR = 0.45;
const WIND_SMOOTH = 0.4; // setTargetAtTime time constant
const WIND_SWELL = 0.35; // extra gain per unit of wind strength above the breeze (a gust swells the bed)

const BIRDS_GAIN = 0.3;
const BIRDS_SWELL = 0.35; // fraction of gain the swell moves
const BIRDS_SWELL_A = 0.21; // rad/s
const BIRDS_SWELL_B = 0.53; // rad/s
const BIRDS_SWELL_B_PHASE = 1.3;
const BIRDS_SMOOTH = 0.3;

const RIVER_GAIN = 0.9;
const RIVER_REF_DISTANCE = 2;
const RIVER_ROLLOFF = 1.4;
const RIVER_MAX_DISTANCE = 10000;
const RIVER_SMOOTH = 0.15;

const LISTENER_SMOOTH = 0.03;

export function setupAmbience({ camera, target, riverPoint, windAt }) {
	const camPos = new Vector3();
	const camForward = new Vector3();
	const camUp = new Vector3();
	const riverPos = new Vector3();

	let started = false;
	let failed = false;
	let elapsed = 0;
	let tickTimer = TICK;
	let listenerReady = false;
	let ctx = null;
	let windGain = null;
	let birdsGain = null;
	let riverGain = null;
	let panner = null;

	// Smoothed AudioParam write; tc 0 sets the value directly.
	function setParam(param, value, tc) {
		if (tc > 0) param.setTargetAtTime(value, ctx.currentTime, tc);
		else param.value = value;
	}

	function loop(buffer, gainNode, destination) {
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.loop = true;
		source.connect(gainNode);
		gainNode.connect(destination);
		source.start(0, Math.random() * buffer.duration);
		return source;
	}

	function start(graph) {
		const wind = graph.buffers.get('amb-wind');
		const birds = graph.buffers.get('amb-birds');
		const river = graph.buffers.get('amb-river');
		if (!wind || !birds || !river) return;
		ctx = graph.ctx;

		windGain = ctx.createGain();
		windGain.gain.value = 0;
		birdsGain = ctx.createGain();
		birdsGain.gain.value = 0;
		riverGain = ctx.createGain();
		riverGain.gain.value = 0;

		panner = ctx.createPanner();
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'inverse';
		panner.refDistance = RIVER_REF_DISTANCE;
		panner.rolloffFactor = RIVER_ROLLOFF;
		panner.maxDistance = RIVER_MAX_DISTANCE;
		panner.connect(graph.ambBus);
		updateRiver(0);

		loop(wind, windGain, graph.ambBus);
		loop(birds, birdsGain, graph.ambBus);
		loop(river, riverGain, panner);
		started = true;
		tick();
	}

	function updateRiver(tc) {
		riverPoint(target.x, target.z, riverPos);
		if (panner.positionX) {
			setParam(panner.positionX, riverPos.x, tc);
			setParam(panner.positionY, riverPos.y, tc);
			setParam(panner.positionZ, riverPos.z, tc);
		} else {
			panner.setPosition(riverPos.x, riverPos.y, riverPos.z);
		}
	}

	// Gains and river position, a few times per second.
	function tick() {
		const fade = Math.min(1, elapsed / FADE_IN);
		const fadeCurve = fade * fade * (3 - 2 * fade);

		const d = Math.min(1, Math.max(0, (camPos.distanceTo(target) - WIND_NEAR) / (WIND_FAR - WIND_NEAR)));
		const swell = 1 + WIND_SWELL * Math.max(0, windAt(target.x, target.z) - BREEZE_MAX);
		const wind = (WIND_GAIN_NEAR + (WIND_GAIN_FAR - WIND_GAIN_NEAR) * d) * swell;
		setParam(windGain.gain, wind * fadeCurve, WIND_SMOOTH);

		const birdSwell = 0.6 * Math.sin(elapsed * BIRDS_SWELL_A) + 0.4 * Math.sin(elapsed * BIRDS_SWELL_B + BIRDS_SWELL_B_PHASE);
		setParam(birdsGain.gain, BIRDS_GAIN * (1 + BIRDS_SWELL * birdSwell) * fadeCurve, BIRDS_SMOOTH);

		setParam(riverGain.gain, RIVER_GAIN * fadeCurve, WIND_SMOOTH);
		updateRiver(RIVER_SMOOTH);
	}

	function updateListener() {
		const listener = ctx.listener;
		const tc = listenerReady ? LISTENER_SMOOTH : 0;
		if (listener.positionX) {
			setParam(listener.positionX, camPos.x, tc);
			setParam(listener.positionY, camPos.y, tc);
			setParam(listener.positionZ, camPos.z, tc);
			setParam(listener.forwardX, camForward.x, tc);
			setParam(listener.forwardY, camForward.y, tc);
			setParam(listener.forwardZ, camForward.z, tc);
			setParam(listener.upX, camUp.x, tc);
			setParam(listener.upY, camUp.y, tc);
			setParam(listener.upZ, camUp.z, tc);
		} else {
			listener.setPosition(camPos.x, camPos.y, camPos.z);
			listener.setOrientation(camForward.x, camForward.y, camForward.z, camUp.x, camUp.y, camUp.z);
		}
		listenerReady = true;
	}

	return function update(dt) {
		if (failed) return;
		try {
			camera.getWorldPosition(camPos);
			if (!started) {
				const graph = audioGraph();
				if (!graph) return;
				start(graph);
				if (!started) return;
			}
			elapsed += dt;
			camera.getWorldDirection(camForward);
			camUp.set(0, 1, 0).transformDirection(camera.matrixWorld);
			updateListener();
			tickTimer += dt;
			if (tickTimer >= TICK) {
				tickTimer = 0;
				tick();
			}
		} catch {
			failed = true;
		}
	};
}
