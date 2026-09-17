import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  minify: true,
  fixedExtension: true,
  exports: true,
  deps: {
    neverBundle: ["vite", "esbuild"],
  },
});
