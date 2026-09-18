import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves from a subpath (/HeatDetect/); Cloudflare Pages and the
  // dev server serve from the root. The deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  server: {
    port: 5173,
    // Dev-only proxy: the browser calls /api/... on the Vite origin, so there is
    // no CORS in development and no API base URL baked into dev builds.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
