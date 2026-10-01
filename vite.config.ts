import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins:
    mode === "assets" ? [] : cloudflare({ types: { generate: false }, remoteBindings: false }),
  build: { outDir: "dist/web", emptyOutDir: true, sourcemap: false },
}));
