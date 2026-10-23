import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In local dev (`npm run dev`) we proxy /api to a port-forwarded gateway so the
// SPA talks same-origin, mirroring how nginx proxies /api in the cluster.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.GATEWAY_URL ?? "http://localhost:18080",
        changeOrigin: true,
      },
    },
  },
});
