/**
 * 把解析钩子注册到当前 Node 进程。
 * 用法：node --import ./scripts/loader-register.mjs scripts/xxx.mjs
 */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
