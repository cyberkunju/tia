import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the SPA calls the API same-origin via /api (matching the nginx prod setup).
// Vite proxies /api → the local backend, stripping the prefix.
const API_TARGET = process.env.VITE_DEV_API_TARGET || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
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
