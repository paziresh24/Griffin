import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // A module's own screen (modules/<id>/web/*.jsx) imports the core through this one door.
  resolve: { alias: { "@griffin/module-kit": fileURLToPath(new URL("./src/module-kit.js", import.meta.url)) } },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:3100", changeOrigin: false } },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
});
