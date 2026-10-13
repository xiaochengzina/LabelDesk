import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { QuickPanel } from "./components/QuickPanel";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}

/**
 * 按窗口标签决定渲染哪套界面。
 *
 * 小窗与完整窗口共用同一个前端包：小窗只渲染 [`QuickPanel`]，
 * 省掉整套设计器/模板管理的加载与内存。
 */
const label = getCurrentWindow().label;
const isQuick = label === "quick";
if (isQuick) {
  document.body.classList.add("quick-window");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>{isQuick ? <QuickPanel /> : <App />}</React.StrictMode>,
);