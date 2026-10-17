/**
 * 打印历史（独立页面）。
 *
 * 从设置弹窗里拆出来的原因：历史是「查证/审计」用途，需要宽表格和搜索，
 * 塞在设置里的窄弹窗中既挤又难查。现在是一个完整工作区，左侧标签页
 * 与「打标签」「设计模板」并列。
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  printHistoryClear,
  printHistoryCount,
  printHistorySearch,
  printHistoryTemplates,
  type PrintRecord,
} from "../api/backend";
import { formatAt, formatHoursAgo } from "../model/printHistory";
import { Icon } from "./Icon";

/** 一次最多取多少条：足够覆盖日常回查，又不至于把 DOM 撑爆 */
const PAGE_SIZE = 500;

interface Props {
  /** 点「复打」：把这一行的原始数据带回打标签页，由用户自己按打印 */
  onReprint: (record: PrintRecord) => void;
}

export function HistoryPanel({ onReprint }: Props): JSX.Element {
  const [records, setRecords] = useState<PrintRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [templates, setTemplates] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [templateFilter, setTemplateFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const [list, count, tpl] = await Promise.all([
        printHistorySearch(q, PAGE_SIZE),
        printHistoryCount(),
        printHistoryTemplates(),
      ]);
      setRecords(list);
      setTotal(count);
      setTemplates(tpl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次载入
  useEffect(() => {
    void load("");
  }, [load]);

  // 搜索防抖：每敲一个字都读历史文件没必要
  useEffect(() => {
    const q = query.trim();
    if (!q && records.length === 0 && !loading) {
      void load("");
      return;
    }
    const timer = window.setTimeout(() => void load(q), 250);
    return () => window.clearTimeout(timer);
    // 只在输入变化时触发；records/loading 仅用于首次空搜索的兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const shown = useMemo(
    () => (templateFilter ? records.filter((r) => r.template === templateFilter) : records),
    [records, templateFilter],
  );

  const doClear = useCallback(async () => {
    if (!confirm(`确定清空全部 ${total} 条打印历史？清空后无法再提醒重复打印。`)) return;
    setError(null);
    setNote(null);
    try {
      await printHistoryClear();
      setRecords([]);
      setTotal(0);
      setTemplates([]);
      setQuery("");
      setTemplateFilter("");
      setNote("打印历史已清空");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [total]);

  return (
    <div className="history-main">
      <header className="history-head">
        <div className="history-head-title">
          <Icon name="clock" size={16} />
          <span>打印历史</span>
          <span className="history-count">
            共 {total} 条
            {total > PAGE_SIZE ? `（仅显示最近 ${PAGE_SIZE} 条）` : ""}
          </span>
        </div>
        <button className="danger compact" disabled={total === 0} onClick={() => void doClear()}>
          <Icon name="eraser" size={14} />
          清空历史
        </button>
      </header>

      <div className="history-toolbar">
        <div className="history-search-wrap">
          <Icon name="search" size={14} />
          <input
            type="text"
            className="history-search"
            value={query}
            placeholder="搜索序列号 / 型号 / 模板名"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              className="icon-button"
              title="清除搜索"
              onClick={() => setQuery("")}
            >
              <Icon name="x" size={13} />
            </button>
          ) : null}
        </div>
        <select
          className="history-filter"
          value={templateFilter}
          onChange={(e) => setTemplateFilter(e.target.value)}
        >
          <option value="">全部模板</option>
          {templates.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {note ? <div className="alert success">{note}</div> : null}

      <div className="history-table-wrap">
        {loading && records.length === 0 ? (
          <div className="history-empty">
            <div className="hint">读取中…</div>
          </div>
        ) : shown.length === 0 ? (
          <div className="history-empty">
            <Icon name="clock" size={26} />
            <div className="history-empty-title">
              {query || templateFilter ? "没有匹配的记录" : "还没有打印记录"}
            </div>
            <div className="hint">
              {query || templateFilter
                ? "换个关键字，或把模板筛选改回「全部模板」。"
                : "每次打印出纸都会在这里记一条，用来提醒重复打印。"}
            </div>
          </div>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th className="col-time">时间</th>
                <th className="col-serial">序列号</th>
                <th>型号 / 摘要</th>
                <th className="col-template">模板</th>
                <th className="col-printer">打印机</th>
                <th className="col-src">来源</th>
                <th className="col-action" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={`${r.atMs}-${i}`}>
                  <td className="col-time">
                    <span className="history-time">{formatAt(r.atMs)}</span>
                    <span className="history-ago">{formatHoursAgo(hoursAgo(r.atMs))}</span>
                  </td>
                  <td className="col-serial">
                    <code>{r.serial || "—"}</code>
                  </td>
                  <td className="history-summary-cell" title={r.summary}>
                    {r.summary || "—"}
                  </td>
                  <td className="col-template">{r.template || "—"}</td>
                  <td className="col-printer" title={r.printer}>
                    {r.printer || "—"}
                  </td>
                  <td className="col-src">
                    {r.quick ? <span className="tag">小窗</span> : <span className="tag dim">主窗口</span>}
                  </td>
                  <td className="col-action">
                    <button
                      className="ghost compact reprint-button"
                      disabled={!r.raw}
                      title={
                        r.raw
                          ? "把这一行填回输入框，由你自己确认后打印"
                          : "这条记录来自旧版本，没有保存原始行，无法复打"
                      }
                      onClick={() => onReprint(r)}
                    >
                      <Icon name="redo-2" size={13} />
                      复打
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {shown.length > 0 && templateFilter && shown.length !== records.length ? (
        <div className="hint">
          已按模板「{templateFilter}」筛选：{shown.length} / {records.length} 条
        </div>
      ) : null}
    </div>
  );
}

function hoursAgo(ms: number): number {
  return (Date.now() - ms) / 3_600_000;
}
