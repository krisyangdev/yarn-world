# Yarn World

A small knitted island you can play with in the browser, built with three.js. Everything is made of yarn, felt and pompoms: the ground is a patchwork quilt, the river is a knitted ribbon, the sheep are wool.

**Live:** [yarn.krisyang.dev](https://yarn.krisyang.dev)

![Yarn World](public/og.jpg)

## How to play

- **Pull the thread** on the yarn ball to knit the world. The ball lifts off its mat, the quilt grows out from the center and every object flies out of the ball to its place.
- **Pull the loose end** at the edge of the cushion to unravel it all back into the ball.
- **Drag** to orbit the camera, **scroll** to zoom.
- **Poke** anything: the house opens its door and knocks, the kite loops, the pinwheels spin, carrots pop out of the garden, birds fly off, the waterwheel splashes.
- **Pick up a sheep** and drop it. Pull the thread on a sheep's back to unravel its wool; it runs off embarrassed and the wool grows back.
- Keys: `R` replays the intro, `M` mutes.

## What's in it

- **Procedural knit materials.** Stockinette, rib, garter, seed and cable stitches are painted as height fields at startup and turned into normal, AO and roughness maps. No image textures are loaded.
- **Wool fuzz.** Sheep and pompoms use shell rendering: the mesh is drawn several times, each shell pushed out along the normal, with a fiber mask that leaves a hairy halo.
- **One shared wind.** Grass, trees, laundry, tassels, pinwheels, the kite, chimney smoke, dandelion fluff and cloud shadows all read the same wind field, so a gust visibly travels across the island.
- **Rope physics.** The yarn ball's thread, the sheep's wool threads and the intro and outro handles are Verlet ropes with ground and sphere collisions.
- **A flowing knitted river.** Swell bands advected downstream with a flow-map phase reset, bank foam, depth tint, drifting streaks, ducks with wakes and ripple rings.
- **Knit-in and unravel.** The ground is revealed and removed by a shader front shared with the shadow pass, so shadows follow the visible quilt exactly. The intro is the unravel played backwards.
- **Small lives.** Sheep graze, chase the rolling yarn ball and eat fallen fruit; a lamb follows its mother; butterflies and birds come and go.
- **Sound.** Every interaction has its own recorded sound, plus wind, birdsong and a positional river.

## Run locally

```bash
npm install
npm run dev
```

Open the printed URL. Add `?debug=1` for an fps counter and the scene objects on `window`.

`npm run build` writes a static site to `dist/`.

## Built with

- [three.js](https://threejs.org)
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) for fast raycasts (camera autofocus, poking)
- [Vite](https://vite.dev)

## Credits

Sound effects are CC0 recordings from [freesound.org](https://freesound.org), listed in [public/sfx/SOURCES.txt](public/sfx/SOURCES.txt).

## License

Code is MIT. Sound files are CC0.
