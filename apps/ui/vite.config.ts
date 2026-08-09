import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

/** Dev server proxies API traffic to the running integrator server. */
const API = "http://127.0.0.1:8080"

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": API,
      "/layers": API,
      "/tiles": API,
      "/map": API,
      "/kit": API,
      "/basemap": API
    }
  }
})
