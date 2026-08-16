import fs from "node:fs";
import path from "node:path";

import { build, type Plugin as EsbuildPlugin } from "esbuild";
import { type Plugin } from "vite";

const NODE_WORKER_PREFIX = "\0node-worker:";

type PendingWorker = {
  source: Uint8Array;
  assetName: string;
  importerStems: Set<string>;
};

function hasNodeWorkerQuery(id: string): boolean {
  const query = id.split("?")[1];
  if (!query) return false;
  return new URLSearchParams(query).has("nodeWorker");
}

function workerAssetName(entryPath: string): string {
  return `${path.basename(entryPath, path.extname(entryPath))}.node-worker.js`;
}

function importerStem(importer: string | undefined): string | null {
  if (!importer) return null;
  const clean = importer.split("?")[0];
  return path.basename(clean, path.extname(clean));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function resolveExistingFile(basePath: string): string | null {
  const ext = path.extname(basePath);
  if (ext === ".js" || ext === ".mjs") {
    const stem = basePath.slice(0, -ext.length);
    return firstExistingFile([basePath, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`]);
  }

  return firstExistingFile([
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.js"),
  ]);
}

type EnvVarDef = { name: string; public: boolean; static: boolean };

function envFilePath(projectRoot: string): string | null {
  return resolveExistingFile(path.join(projectRoot, "src/env"));
}

function parseEnvVars(projectRoot: string): EnvVarDef[] {
  const entry = envFilePath(projectRoot);
  if (!entry) return [];

  const source = fs.readFileSync(entry, "utf8");
  const vars: EnvVarDef[] = [];

  for (const match of source.matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*\{([^}]*)\}/gm)) {
    vars.push({
      name: match[1],
      public: /\bpublic\s*:\s*true\b/.test(match[2]),
      static: /\bstatic\s*:\s*true\b/.test(match[2]),
    });
  }

  return vars;
}

function envShimSource(
  kind: "private" | "public",
  projectRoot: string,
  vars: EnvVarDef[],
  dev: boolean,
): string {
  const mode = dev ? "development" : "production";
  const names = vars.filter((v) => (kind === "public") === v.public);

  const header = `
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

let loaded = false;
function ensureEnvLoaded() {
  if (loaded) return;
  loaded = true;
  const root = ${JSON.stringify(projectRoot)};
  for (const file of ${JSON.stringify([`.env.${mode}.local`, `.env.${mode}`, ".env.local", ".env"])}) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;
    loadEnvFile(fullPath);
  }
}
ensureEnvLoaded();
`;

  const exports = names
    .map((v) => {
      if (v.static) {
        const value = process.env[v.name];
        return `export const ${v.name} = ${value === undefined ? "undefined" : JSON.stringify(value)};`;
      }
      return `export const ${v.name} = process.env.${v.name};`;
    })
    .join("\n");

  return `${header}\n${exports}\n`;
}

function svelteKitEnvPlugin(projectRoot: string, dev: boolean): EsbuildPlugin {
  return {
    name: "sveltekit-env",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^\$app\/env\/(private|public)$/ }, (args) => ({
        path: args.path,
        namespace: "sveltekit-env",
      }));

      esbuild.onLoad({ filter: /.*/, namespace: "sveltekit-env" }, (args) => {
        const kind = args.path.endsWith("private") ? "private" : "public";
        return {
          contents: envShimSource(kind, projectRoot, parseEnvVars(projectRoot), dev),
          loader: "js",
        };
      });
    },
  };
}

function svelteKitModulesPlugin(projectRoot: string): EsbuildPlugin {
  const libRoot = path.join(projectRoot, "src/lib");

  return {
    name: "sveltekit-modules",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^#lib(\/|$)/ }, (args) => {
        const subpath = args.path === "#lib" ? "" : args.path.slice("#lib/".length);
        const resolved = resolveExistingFile(path.join(libRoot, subpath));
        if (!resolved) {
          return { errors: [{ text: `Could not resolve ${args.path}` }] };
        }
        return { path: resolved };
      });

      esbuild.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
        if (!args.resolveDir) return;
        const resolved = resolveExistingFile(path.join(args.resolveDir, args.path));
        if (resolved) return { path: resolved };
      });
    },
  };
}

function workerBuildOptions(
  projectRoot: string,
  entryPoints: string[],
  out: string | false,
  dev = false,
) {
  return {
    entryPoints,
    ...(out ? { outfile: out } : { write: false }),
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    target: "node22",
    packages: "external" as const,
    external: ["node:*", "worker_threads"],
    define: {
      "import.meta.env.DEV": dev ? "true" : "false",
      "import.meta.env.PROD": dev ? "false" : "true",
      "import.meta.env.MODE": JSON.stringify(dev ? "development" : "production"),
    },
    plugins: [svelteKitEnvPlugin(projectRoot, dev), svelteKitModulesPlugin(projectRoot)],
    logLevel: "silent" as const,
  };
}

function writeWorkerAsset(targetDir: string, assetName: string, source: Uint8Array) {
  const workerPath = path.join(targetDir, assetName);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(workerPath, source);
  return workerPath;
}

function findFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];

  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, pattern));
      continue;
    }
    if (pattern.test(entry.name)) results.push(fullPath);
  }
  return results;
}

function workerClassSource(imports: string, workerUrlExpr: string): string {
  return `${imports}

const workerUrl = ${workerUrlExpr};

export default class extends NodeWorker {
  constructor(options) {
    super(workerUrl, { type: "module", ...options });
  }
}
`;
}

function findImporterChunks(tree: string, stems: Set<string>): string[] {
  const matches: string[] = [];
  for (const stem of stems) {
    const pattern = new RegExp(`^${escapeRegex(stem)}\\.js-[^/]+\\.js$`);
    for (const file of findFiles(tree, pattern)) {
      if (!file.includes(".remote")) matches.push(file);
    }
  }
  return matches;
}

function placeWorkerInBuildOutput(pendingWorker: PendingWorker) {
  const trees = [
    { root: path.resolve("build/server"), alwaysFallback: true },
    { root: path.resolve(".svelte-kit/output/server"), alwaysFallback: false },
  ];

  for (const { root, alwaysFallback } of trees) {
    const chunks = findImporterChunks(root, pendingWorker.importerStems);
    if (chunks.length) {
      for (const chunk of chunks) {
        writeWorkerAsset(path.dirname(chunk), pendingWorker.assetName, pendingWorker.source);
      }
      continue;
    }

    const chunksDir = path.join(root, "chunks");
    if (alwaysFallback || fs.existsSync(chunksDir)) {
      writeWorkerAsset(chunksDir, pendingWorker.assetName, pendingWorker.source);
    }
  }
}

export function sveltekitNodeWorker(): Plugin {
  let isDev = false;
  let isServer = false;
  let devOutDir = "";
  const watchedEntries = new Set<string>();
  const importerStems = new Map<string, Set<string>>();
  const pendingWorkers = new Map<string, PendingWorker>();
  const projectRoot = process.cwd();

  const buildWorker = async (entryPath: string, out: string) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await build(workerBuildOptions(projectRoot, [entryPath], out, isDev));
  };

  return {
    name: "vite-plugin-sveltekit-node-worker",
    enforce: "pre",
    configResolved(config) {
      isDev = config.command === "serve";
      isServer = !!config.build.ssr;
      devOutDir = path.resolve(".svelte-kit/node-workers");
    },
    async resolveId(id, importer, options) {
      if (!hasNodeWorkerQuery(id)) return null;

      const cleanId = id.split("?")[0];
      const resolved = await this.resolve(cleanId, importer, { ...options, skipSelf: true });
      if (!resolved) return null;

      const resolvedId = typeof resolved === "string" ? resolved : resolved.id;
      const entryPath = path.resolve(resolvedId);
      watchedEntries.add(entryPath);

      const stem = importerStem(importer);
      if (stem) {
        let stems = importerStems.get(entryPath);
        if (!stems) {
          stems = new Set();
          importerStems.set(entryPath, stems);
        }
        stems.add(stem);
      }

      return `${NODE_WORKER_PREFIX}${resolvedId}`;
    },
    async handleHotUpdate({ file, server }) {
      const envPath = envFilePath(projectRoot);
      const envChanged = envPath !== null && path.resolve(file) === path.resolve(envPath);
      if (!watchedEntries.has(file) && !envChanged) return;

      let rebuilt = false;
      for (const entryPath of watchedEntries) {
        if (!envChanged && file !== entryPath) continue;
        await buildWorker(entryPath, path.join(devOutDir, workerAssetName(entryPath)));
        rebuilt = true;
      }
      if (rebuilt) server.ws.send({ type: "full-reload" });
    },
    async load(id) {
      if (!id.startsWith(NODE_WORKER_PREFIX)) return null;

      const envPath = envFilePath(projectRoot);
      if (envPath) this.addWatchFile(envPath);

      const entryPath = id.slice(NODE_WORKER_PREFIX.length);
      const assetName = workerAssetName(entryPath);

      if (!isServer && !isDev) {
        return `export default null;`;
      }

      if (isDev) {
        const workerPath = path.join(devOutDir, assetName);
        await buildWorker(entryPath, workerPath);
        const escapedPath = workerPath.replace(/\\/g, "\\\\");
        return workerClassSource(
          `import { Worker as NodeWorker } from "node:worker_threads";
import { pathToFileURL } from "node:url";`,
          `pathToFileURL("${escapedPath}")`,
        );
      }

      const result = await build(workerBuildOptions(projectRoot, [entryPath], false, isDev));
      const output = result.outputFiles?.[0];
      if (!output) {
        throw new Error("Worker build produced no output");
      }

      pendingWorkers.set(entryPath, {
        source: output.contents,
        assetName,
        importerStems: importerStems.get(path.resolve(entryPath)) ?? new Set(),
      });

      return workerClassSource(
        `import { Worker as NodeWorker } from "node:worker_threads";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";`,
        `pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "${assetName}"))`,
      );
    },
    closeBundle: {
      sequential: true,
      order: "post",
      async handler() {
        if (isDev || pendingWorkers.size === 0) return;
        for (const worker of pendingWorkers.values()) {
          placeWorkerInBuildOutput(worker);
        }
        pendingWorkers.clear();
      },
    },
  };
}
