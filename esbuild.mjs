import { copyFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
	entryPoints: ["src/extension.ts"],
	outfile: "out/extension.js",
	bundle: true,
	external: ["vscode"],
	format: "cjs",
	platform: "node",
	target: "node18",
	minify: true,
});

// tiktoken's Node entry point resolves its WASM binary relative to __dirname.
await copyFile(
	"node_modules/tiktoken/tiktoken_bg.wasm",
	"out/tiktoken_bg.wasm"
);
