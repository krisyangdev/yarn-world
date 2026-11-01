// Sample-based sound for the poke interactions. Plain Web Audio, recordings from public/sfx.
// Every play function is a silent no-op until unlockAudio() has produced a running context
// and the sample it needs has finished decoding.

// Cue feel: variant files, base playbackRate, gain, random rate jitter (+-fraction).
const CUES = {
	baa: { files: ['baa-3', 'baa-4'], rate: 1, gain: 0.7, jitter: 0 }, // bleats sound wrong when resampled; keep original speed
	meh: { files: ['meh-1', 'meh-2', 'meh-3'], rate: 1, gain: 0.7, jitter: 0 },
	pop: { files: ['pop-1', 'pop-2', 'pop-3', 'pop-4'], rate: 1, gain: 0.5, jitter: 0.04 },
	rustle: { files: ['rustle-1', 'rustle-2', 'rustle-3'], rate: 1, gain: 0.5, jitter: 0.04 },
	plink: { files: ['plink-1', 'plink-2', 'plink-3', 'plink-4'], rate: 1.1, gain: 0.16, jitter: 0.04 },
	creak: { files: ['creak-1'], rate: 1, gain: 0.5, jitter: 0.04 },
	knock: { files: ['knock-1'], rate: 1, gain: 0.5, jitter: 0.04 },
	chime: { files: ['chime-1', 'chime-2', 'chime-3', 'chime-4'], rate: 1, gain: 0.32, jitter: 0.03 },
	thump: { files: ['thump-1'], rate: 1, gain: 0.6, jitter: 0.05 },
	whirr: { files: ['whirr-1'], rate: 1, gain: 0.45, jitter: 0.05 },
	nudge: { files: ['nudge-1'], rate: 1, gain: 0.5, jitter: 0.06 },
	munch: { files: ['munch-1'], rate: 1, gain: 0.5, jitter: 0.05 },
	stone: { files: ['stone-1'], rate: 1, gain: 0.5, jitter: 0.05 },
	tap: { files: ['tap-1'], rate: 1, gain: 0.5, jitter: 0.05 },
	flap: { files: ['flap-1'], rate: 1, gain: 0.4, jitter: 0.05 },
	whoosh: { files: ['whoosh-1'], rate: 1, gain: 0.45, jitter: 0.03 },
	splash: { files: ['splash-1'], rate: 1, gain: 0.45, jitter: 0.05 },
	quack: { files: ['quack-1'], rate: 1, gain: 0.45, jitter: 0.03 },
	tweet: { files: ['tweet-1'], rate: 1, gain: 0.4, jitter: 0.03 },
	flutter: { files: ['flutter-1'], rate: 1, gain: 0.4, jitter: 0.05 },
	fluff: { files: ['fluff-1'], rate: 1, gain: 0.45, jitter: 0.05 },
	branch: { files: ['branch-1'], rate: 1, gain: 0.5, jitter: 0.05 },
};

const AMBIENCE_FILES = ['amb-wind', 'amb-birds', 'amb-river'];
const KNOCK_DELAY = 0.5; // seconds after the creak starts
const MAX_VOICES = 4; // overlapping voices per cue
const STEAL_FADE = 0.02; // seconds, fade of a voice cut by the cap
const START_LEAD = 0.005; // seconds, scheduling margin

const MASTER_GAIN = 0.9;
const SFX_BUS_GAIN = 1;
const AMB_BUS_GAIN = 1;
const MUTE_RAMP = 0.15; // seconds
const MUTE_KEY = 'yarn.muted';

let ctx = null;
let master = null;
let sfxBus = null;
let ambBus = null;
let loading = false;
let muted = readMuted();

const buffers = new Map();
const graph = { ctx: null, ambBus: null, buffers };

// Per-cue runtime state: last variant played and live voices, oldest first.
const state = {};
for (const name of Object.keys(CUES)) state[name] = { last: -1, voices: [] };

function readMuted() {
	try {
		return localStorage.getItem(MUTE_KEY) === '1';
	} catch {
		return false;
	}
}

function writeMuted(value) {
	try {
		localStorage.setItem(MUTE_KEY, value ? '1' : '0');
	} catch {
		// storage is optional
	}
}

// Fetch every sample's bytes at page load, so the first gesture only has to decode them.
const bytes = new Map();
{
	const names = new Set(AMBIENCE_FILES);
	for (const cue of Object.values(CUES)) for (const file of cue.files) names.add(file);
	for (const name of names) {
		const req = fetch(`${import.meta.env.BASE_URL}sfx/${name}.mp3`).then((res) => res.arrayBuffer());
		req.catch(() => {}); // a missing sample just stays silent
		bytes.set(name, req);
	}
}

// Decode every sample once the context exists.
function loadSamples() {
	if (loading) return;
	loading = true;
	for (const [name, req] of bytes) {
		req
			.then((data) => ctx.decodeAudioData(data))
			.then((buffer) => buffers.set(name, buffer))
			.catch(() => {
				// a missing sample just stays silent
			});
	}
}

// Create or resume the shared context; call from any user gesture.
export function unlockAudio() {
	try {
		if (!ctx) {
			const AudioCtx = window.AudioContext || window.webkitAudioContext;
			if (!AudioCtx) return;
			ctx = new AudioCtx();
			master = ctx.createGain();
			master.gain.value = muted ? 0 : MASTER_GAIN;
			sfxBus = ctx.createGain();
			sfxBus.gain.value = SFX_BUS_GAIN;
			ambBus = ctx.createGain();
			ambBus.gain.value = AMB_BUS_GAIN;
			const comp = ctx.createDynamicsCompressor();
			sfxBus.connect(master);
			ambBus.connect(master);
			master.connect(comp);
			comp.connect(ctx.destination);
			graph.ctx = ctx;
			graph.ambBus = ambBus;
			loadSamples();
		}
		if (ctx.state === 'suspended') ctx.resume();
	} catch {
		// audio is optional
	}
}

// Context, ambience bus and decoded buffers for ambience.js, or null until the context runs.
export function audioGraph() {
	return ctx && ctx.state === 'running' ? graph : null;
}

export function isMuted() {
	return muted;
}

export function setMuted(value) {
	muted = !!value;
	writeMuted(muted);
	if (!ctx || !master) return;
	try {
		const now = ctx.currentTime;
		const gain = master.gain;
		gain.cancelScheduledValues(now);
		gain.setValueAtTime(gain.value, now);
		gain.linearRampToValueAtTime(muted ? 0 : MASTER_GAIN, now + MUTE_RAMP);
	} catch {
		// audio is optional
	}
}

// Fade a voice out quickly and stop it.
function steal(voice, now) {
	const gain = voice.gain.gain;
	gain.cancelScheduledValues(now);
	gain.setValueAtTime(gain.value, now);
	gain.linearRampToValueAtTime(0, now + STEAL_FADE);
	voice.source.stop(now + STEAL_FADE + 0.005);
}

// Play one random variant of a cue (never the same twice in a row), delay in seconds.
function playCue(name, pitch = 1, delay = 0) {
	if (!ctx || ctx.state !== 'running') return;
	try {
		const cue = CUES[name];
		const st = state[name];
		const count = cue.files.length;
		let index = Math.floor(Math.random() * count);
		if (count > 1 && index === st.last) index = (index + 1 + Math.floor(Math.random() * (count - 1))) % count;
		const buffer = buffers.get(cue.files[index]);
		if (!buffer) return;
		st.last = index;

		const now = ctx.currentTime;
		const voices = st.voices;
		while (voices.length >= MAX_VOICES) steal(voices.shift(), now);

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.playbackRate.value = cue.rate * pitch * (1 + (Math.random() * 2 - 1) * cue.jitter);
		const gain = ctx.createGain();
		gain.gain.value = cue.gain;
		source.connect(gain);
		gain.connect(sfxBus);

		const voice = { source, gain };
		voices.push(voice);
		source.onended = () => {
			const i = voices.indexOf(voice);
			if (i >= 0) voices.splice(i, 1);
			gain.disconnect();
		};
		source.start(now + START_LEAD + delay);
	} catch {
		// audio is optional
	}
}

// Lamb bleat; grumpy uses the low "meh" recordings.
export function playBaa({ grumpy = false } = {}) {
	playCue(grumpy ? 'meh' : 'baa', 1);
}

export function playPop({ pitch = 1 } = {}) {
	playCue('pop', pitch);
}

export function playRustle() {
	playCue('rustle');
}

export function playPlink({ pitch = 1 } = {}) {
	playCue('plink', pitch);
}

// Small door opening followed by a soft knock.
export function playDoor() {
	playCue('creak');
	playCue('knock', 1, KNOCK_DELAY);
}

export function playChime() {
	playCue('chime');
}

// soft plush landing (a sheep dropped on the grass)
export function playThump({ pitch = 1 } = {}) {
	playCue('thump', pitch);
}

// pinwheel spun by a poke
export function playWhirr() {
	playCue('whirr');
}

// a sheep butts the yarn ball with its head
export function playNudge() {
	playCue('nudge');
}

// a sheep bites a fallen fruit
export function playMunch() {
	playCue('munch');
}

// poked stone / poked fence post
export function playStone() {
	playCue('stone');
}

export function playTap() {
	playCue('tap');
}

// laundry and tassels flapping after a poke
export function playFlap() {
	playCue('flap');
}

// kite loop-the-loop
export function playWhoosh() {
	playCue('whoosh');
}

// waterwheel paddles slapping the water
export function playSplash() {
	playCue('splash');
}

// duck pops back up after a dive
export function playQuack() {
	playCue('quack');
}

// poked bird flies off
export function playTweet() {
	playCue('tweet');
}

// startled butterfly
export function playFlutter() {
	playCue('flutter');
}

// poked cloud squashes like a shaken blanket
export function playFluff() {
	playCue('fluff');
}

// poked pine hops and its branches swish
export function playBranch() {
	playCue('branch');
}
