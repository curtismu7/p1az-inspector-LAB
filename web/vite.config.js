import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on PORT (default 4840, npm run dev -w server) and Vite on VITE_PORT (default 4841); /api is proxied.
const api = { target: `http://127.0.0.1:${Number(process.env.PORT) || 4840}` };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 4841, strictPort: true, proxy: { "/api": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
});
