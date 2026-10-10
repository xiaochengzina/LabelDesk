import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 需要固定端口 + 明确的 host，避免 dev 时随机端口导致白屏
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // src-tauri 由 cargo 自己监听，避免 vite 重复触发
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Windows WebView2 基于 Chromium，可以直接用现代语法
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
