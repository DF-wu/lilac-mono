import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { serviceWorkerBuild } from "./service-worker-build.ts";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerBuild()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.LILAC_WEB_BACKEND_URL ?? "http://127.0.0.1:8787", ws: true },
    },
  },
  build: { target: "es2022", manifest: true },
});
