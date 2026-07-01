import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the SPA calls the API same-origin via /api (matching the nginx prod setup).
// Vite proxies /api → the local backend, stripping the prefix.
const API_TARGET = process.env.VITE_DEV_API_TARGET || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split heavy, rarely-changing vendor libs into their own chunks so the
        // browser caches them across app deploys (app code changes far more often).
        // Function form for Vite 8 / rolldown compatibility.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react")) return "react-vendor";
          if (id.includes("framer-motion") || id.includes("lucide")) return "ui-vendor";
          if (id.includes("@tanstack") || id.includes("zustand")) return "data-vendor";
          return "vendor";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
