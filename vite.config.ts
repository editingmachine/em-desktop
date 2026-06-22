import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Renderer-only Vite config. Builds src/renderer → src/renderer/dist,
// which electron-builder packages (see electron-builder.yml).
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "src/renderer/dist"),
    emptyOutDir: true,
    // The renderer imports src/shared/sync-state.js — a CommonJS module also
    // require()'d by the Electron main process (which has no build step). By
    // default Rollup only converts CommonJS inside node_modules, so include the
    // shared dir here or the named import fails at build time.
    commonjsOptions: {
      include: [/src\/shared/, /node_modules/],
    },
  },
  server: {
    port: 5173,
  },
});
