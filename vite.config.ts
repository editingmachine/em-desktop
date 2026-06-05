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
  },
  server: {
    port: 5173,
  },
});
