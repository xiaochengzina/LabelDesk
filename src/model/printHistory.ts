/**
 * 打印去重守卫。
 *
 * 贴标签不可逆，重复打印 = 浪费一张纸 + 要重贴。所以在真正出纸前查一次历史。
 *
 * 三个刻意的设计决定：
 *
 * 1. **不硬拦**：命中重复时只给黄色提醒 + 「仍要打印」，不弹 modal。
 *    赶时间的时候被弹窗拦一下很烦，而且有时确实需要补打。
 * 2. **查重失败不阻止打印**：后端出错、文件损坏、权限问题都不该导致打不出标签。
 *    宁可漏一次提醒，也不能让主流程卡住。
 * 3. **只在"像序列号"的值上判重**：见 `fill.ts` 的 `serialCandidates` ——
 *    拿型号判重会把同型号的机器全误报。
 */

import { useCallback, useState } from "react";
import { printHistoryCheck, type DuplicateHit } from "../api/backend";

export interface DuplicateGuard {
  /** 待确认的重复（有值时说明已拦下，等用户决定） */
  pending: DuplicateHit[] | null;
  /** 查重进行中 */
  checking: boolean;
  /**
   * 查重。返回 `true` 表示可以继续打印（无重复或查重失败），
   * `false` 表示发现重复、已拦下并展示提醒。
   */
  guard: (candidates: string[]) => Promise<boolean>;
  /** 用户选择「仍要打印」 */
  dismiss: () => void;
}

export function useDuplicateGuard(): DuplicateGuard {
  const [pending, setPending] = useState<DuplicateHit[] | null>(null);
  const [checking, setChecking] = useState(false);

  const guard = useCallback(async (candidates: string[]): Promise<boolean> => {
    const clean = candidates.filter((c) => c.trim());
    if (clean.length === 0) {
      setPending(null);
      return true;
    }
    setChecking(true);
    try {
      const hits = await printHistoryCheck(clean);
      if (hits.length === 0) {
        setPending(null);
        return true;
      }
      setPending(hits);
      return false;
    } catch {
      // 查重不可用不该拦住打印
      setPending(null);
      return true;
    } finally {
      setChecking(false);
    }
  }, []);

  const dismiss = useCallback(() => setPending(null), []);

  return { pending, checking, guard, dismiss };
}

/** 把「多少小时前」格式化成人话 */
export function formatHoursAgo(hours: number): string {
  // 先取整、再按取整后的值分档，否则会出现
  // 「60 分钟前」「24 小时前」「30 天前」这种越界说法
  // （`hours` 才 0.99 但 round(hours*60) = 60）。
  const minutes = Math.max(1, Math.round(hours * 60));
  if (minutes < 60) return `${minutes} 分钟前`;
  const h = Math.round(hours);
  if (h < 24) return `${h} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.round(months / 12)} 年前`;
}

/** 毫秒时间戳 → 本地时间字符串（YYYY-MM-DD HH:mm） */
export function formatAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
