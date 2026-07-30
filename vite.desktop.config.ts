import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve("apps/desktop"),
  plugins: [react()],
  build: {
    outDir: resolve("dist/desktop"),
    emptyOutDir: true,
  },
});
