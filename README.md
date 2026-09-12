# vite-plugin-sveltekit-node-worker

Vite plugin that bundles Node.js [`worker_threads`](https://nodejs.org/api/worker_threads.html) for **SvelteKit 3** with **`adapter-node`**.

Import a worker with `?nodeWorker`. The plugin bundles it with esbuild and returns a `Worker` subclass you can `new`.

It works in both **development** and **production**.

## Installation

SvelteKit 3 is currently published as `next` (beta). This plugin needs that and `adapter-node`:

```bash
npm install @sveltejs/kit@next @sveltejs/adapter-node@next
npm install -D vite-plugin-sveltekit-node-worker
```

## Usage

Add the plugin next to `sveltekit()`:

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { sveltekitNodeWorker } from "vite-plugin-sveltekit-node-worker";

export default defineConfig({
  plugins: [sveltekit(), sveltekitNodeWorker()],
});
```

Match `adapter-node`'s `out` if you change it:

```ts
sveltekitNodeWorker({ out: "dist" });
```

Write a worker, then import it with `?nodeWorker`:

```ts
// src/lib/server/heavy.ts
import { parentPort } from "node:worker_threads";

parentPort?.on("message", (n: number) => {
  parentPort?.postMessage(n * 2);
});
```

```ts
// src/lib/server/spawner.ts
import Worker from "./heavy.ts?nodeWorker";

const worker = new Worker();
worker.postMessage(21);
worker.on("message", (result) => {
  console.log(result); // 42
});
```

The default export is a class that extends `node:worker_threads.Worker` and always spawns with `{ type: "module" }`. Pass extra `Worker` options to the constructor if needed.

Client builds get `export default null` — Node workers only run on the server.

## Worker modules

Worker source can import:

- `#lib/...` — resolved to `src/lib` (SvelteKit 3 subpath imports)
- `$app/env/private` and `$app/env/public` — shims from `src/env.ts` / `src/env.js` (`defineEnvVars`, including `public` and `static`)

`.env` files load in Vite order: `.env.[mode].local`, `.env.[mode]`, `.env.local`, `.env`.

## Dev vs production

**Dev** (`vite dev`): workers build to `.svelte-kit/node-workers` and spawn from that path. Changing a worker file or `src/env` rebuilds and full-reloads.

**Production** (`vite build` + `adapter-node`): the worker file is written next to the SSR chunk that imported it. After the adapter re-bundles, the plugin copies it beside any server chunk that references it under `out` (default `build`).

## Source Code

Since this plugin is MIT licensed, you can also contribute to it at it's repo on [GitHub](https://github.com/YSpoof/vite-plugin-sveltekit-node-worker)
