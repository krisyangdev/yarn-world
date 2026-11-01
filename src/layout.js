// Island layout: where things sit on the island, in world units.
// Positions and spawn areas are written at the original 7.2-unit island size and multiplied by LAYOUT,
// so the whole meadow can be resized from one number. Object sizes, local offsets and clearances
// around an object never scale.
export const LAYOUT = 1.2;

// layout point / distance at the original island size -> world units
export const L = (x, z) => [x * LAYOUT, z * LAYOUT];
export const S = (d) => d * LAYOUT;

export const H = S(7.2); // half size of the island plane
export const ROLL = 1.0; // radius of the rolled cushion edge (kept at its original thickness)

export const HOUSE = { x: S(2.9), z: S(-2.9) };
export const BALL = { x: S(-3.2), z: S(2.6) };

// 3D flower clusters (world.js buildFlowers); meadow, ground art and wind props keep clear of / reuse them
export const FLOWER_CLUSTERS = [
	L(-4.7, 1.9),
	L(1.4, 3.2),
	L(-1.8, 4.6),
	L(4.9, -2.4),
	L(-2.6, -4.2),
];

// clothesline posts (windprops.js); meadow keeps its tall flowers off the line
export const CLOTHESLINE = [L(1.2, -2.4), L(1.5, -4.0)];
