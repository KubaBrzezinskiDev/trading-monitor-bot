import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "fs";

mkdirSync("dist/dashboard", { recursive: true });
// Override "type": "module" from root package.json — Electron main needs CJS
writeFileSync("dist/dashboard/package.json", JSON.stringify({ type: "commonjs" }));

await Promise.all([
  // Electron main process — CJS, Node platform, electron external
  esbuild.build({
    entryPoints: ["src/dashboard/main.ts"],
    bundle: true,
    platform: "node",
    external: ["electron"],
    format: "cjs",
    outfile: "dist/dashboard/main.js",
  }),

  // Preload script — CJS, Node platform, electron external
  esbuild.build({
    entryPoints: ["src/dashboard/preload.ts"],
    bundle: true,
    platform: "node",
    external: ["electron"],
    format: "cjs",
    outfile: "dist/dashboard/preload.js",
  }),

  // Renderer — browser bundle with React
  esbuild.build({
    entryPoints: ["src/dashboard/App.tsx"],
    bundle: true,
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "react",
    define: { "process.env.NODE_ENV": '"development"' },
    outfile: "dist/dashboard/renderer.js",
  }),
]);

copyFileSync("src/dashboard/index.html", "dist/dashboard/index.html");
console.log("Dashboard built → dist/dashboard/");
