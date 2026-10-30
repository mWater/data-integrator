import path from "node:path"
import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

/** Repository root: PORT and the rest of .env live there, not under apps/ui. */
const REPO_ROOT = path.resolve(import.meta.dirname, "../..")

/**
 * Vite is the live UI during `pnpm dev`. It proxies API traffic to the
 * integrator server (PORT, default 8080). The server, when VITE_DEV_URL is
 * set, reverse-proxies the SPA back here so the browser stays on one origin.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, REPO_ROOT, "")
  const apiPort = env.PORT || process.env.PORT || "8080"
  const api = `http://127.0.0.1:${apiPort}`
  return {
    envDir: REPO_ROOT,
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // The page is opened on the API port; HMR still talks to this process.
      hmr: { host: "localhost", port: 5173, clientPort: 5173 },
      proxy: {
        "/api": api,
        "/tiles": api,
        "/kit": api,
        "/basemap": api
      }
    }
  }
})
