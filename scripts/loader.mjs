/**
 * Node ESM 解析钩子：让 Node 能直接运行 Vite 风格的无扩展名导入。
 *
 * 源码里写的是 `from "../model/types"`（Vite 能解析，Node 不能）。
 * 这些脚本需要在 Node 中直接跑真实的渲染器与条码内核，
 * 因此在这里补上 `.ts`/`.js`/`/index.ts` 的解析尝试。
 *
 *   node --import ./scripts/loader-register.mjs scripts/xxx.mjs
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对导入；裸模块名交给 Node 正常解析
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const candidates = [];
    const base = new URL(specifier, context.parentURL);
    const basePath = fileURLToPath(base);
    if (!/\.[a-z0-9]+$/i.test(basePath)) {
      candidates.push(`${basePath}.ts`, `${basePath}.js`, `${basePath}/index.ts`, `${basePath}/index.js`);
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return nextResolve(new URL(`file://${candidate.replace(/\\/g, "/")}`).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
