/**
 * 图标组件。
 *
 * 用内联 SVG 渲染，颜色继承 `currentColor`，因此能自动适配按钮的
 * 正常/悬停/禁用配色，不需要为每个状态准备图标资源。
 *
 * 图标数据来自生成模块 icons.ts（Lucide，ISC 许可）。
 */

import type { JSX } from "react";
import { ICON_PATHS, type IconName } from "./icons";

export type { IconName };

interface Props {
  name: IconName;
  /** 边长（像素）。默认 16，与 13px 正文搭配视觉均衡 */
  size?: number;
  /** 线宽，默认沿用 Lucide 的 2；小尺寸下可略降以获得更清晰的观感 */
  strokeWidth?: number;
  className?: string;
  /** 可访问名称；省略时视作纯装饰，对读屏器隐藏 */
  title?: string;
}

export function Icon({ name, size = 16, strokeWidth, className, title }: Props): JSX.Element {
  const body = ICON_PATHS[name];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : "icon"}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      // 图标 body 来自受信任的本地生成模块，不含用户输入
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
