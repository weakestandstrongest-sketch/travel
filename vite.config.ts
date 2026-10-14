import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  // GitHub Pages の https://<ユーザー>.github.io/travel/ で動くよう相対パスにする
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true },
});
