// Tiny damped spring (semi-implicit Euler, sub-stepped for long frames).
const MAX_STEP = 1 / 120;

export class Spring {
	constructor(stiffness = 220, damping = 14, value = 0) {
		this.stiffness = stiffness;
		this.damping = damping;
		this.value = value;
		this.target = value;
		this.velocity = 0;
	}

	// add to the current velocity
	kick(v) {
		this.velocity += v;
		return this;
	}

	// jump to a value at rest
	snap(v) {
		this.value = this.target = v;
		this.velocity = 0;
		return this;
	}

	get settled() {
		return Math.abs(this.velocity) < 1e-3 && Math.abs(this.value - this.target) < 1e-3;
	}

	update(dt) {
		const n = Math.max(1, Math.ceil(dt / MAX_STEP));
		const h = dt / n;
		for (let i = 0; i < n; i++) {
			this.velocity += ((this.target - this.value) * this.stiffness - this.velocity * this.damping) * h;
			this.value += this.velocity * h;
		}
		return this.value;
	}
}
