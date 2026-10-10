/**
 * 字段映射编辑器（管理员用）。
 *
 * 打标签页要按「列的位置」把操作员粘贴的一行数据填进变量，因此必须在这里
 * 事先声明：第几列是什么、对应模板里的哪个变量。
 *
 * 顺序即列顺序，可以上下移动调整。配好后建议用底部的「试解析」验证一遍。
 */

import { useMemo, useState } from "react";
import type { JSX } from "react";
import type { TemplateField } from "../model/types";
import { buildFill, inferFields } from "../model/fill";
import { extractVariableNames } from "../renderer/elements";
import { setTemplateFields, useEditor } from "../state/store";

export function FieldMappingEditor(): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const fields = doc.fields ?? [];
  const [probe, setProbe] = useState("");

  /** 模板里出现过的所有变量，用于下拉选择 */
  const availableVariables = useMemo(() => {
    const names = new Set<string>();
    for (const element of doc.elements) {
      const record = element as unknown as Record<string, unknown>;
      for (const key of ["text", "value"]) {
        for (const name of extractVariableNames(String(record[key] ?? ""))) names.add(name);
      }
    }
    for (const key of Object.keys(doc.variables ?? {})) names.add(key);
    return [...names];
  }, [doc.elements, doc.variables]);

  const update = (index: number, patch: Partial<TemplateField>) => {
    const next = fields.map((f, i) => (i === index ? { ...f, ...patch, column: i } : { ...f, column: f.column }));
    setTemplateFields(next);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setTemplateFields(next.map((f, i) => ({ ...f, column: i })));
  };

  const remove = (index: number) => {
    setTemplateFields(fields.filter((_, i) => i !== index).map((f, i) => ({ ...f, column: i })));
  };

  const add = () => {
    // 自动挑一个还没被使用的变量，减少管理员的手工输入
    const used = new Set(fields.map((f) => f.variable));
    const free = availableVariables.find((v) => !used.has(v)) ?? "";
    setTemplateFields([
      ...fields,
      { column: fields.length, label: free || `第 ${fields.length + 1} 列`, variable: free, sample: "" },
    ]);
  };

  const toggleSkip = (index: number) => {
    const field = fields[index];
    const nextSkip = !field.skip;
    // 标记为忽略时清空变量与示例值，避免残留造成误解
    update(index, nextSkip ? { skip: true, variable: "", sample: "" } : { skip: false });
  };

  const probeResult = probe.trim() ? buildFill(doc, probe) : null;

  return (
    <>
      <div className="section-title">
        字段映射
        <span className="hint-inline">粘贴内容的列顺序</span>
      </div>

      {fields.length === 0 ? (
        <div className="hint">
          还没有配置映射。「打标签」页需要按列的位置识别数据，所以这里必须定义
          <strong>第几列对应哪个变量</strong>。
        </div>
      ) : (
        <table className="mapping-table">
          <thead>
            <tr>
              <th>#</th>
              <th>列名（给人看）</th>
              <th>对应变量</th>
              <th>忽略</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => (
              <tr key={index} className={field.skip ? "skipped" : ""}>
                <td className="col-index">{index + 1}</td>
                <td>
                  <input
                    type="text"
                    value={field.label}
                    placeholder="如：笔记本型号"
                    onChange={(e) => update(index, { label: e.target.value })}
                  />
                </td>
                <td>
                  {field.skip ? (
                    <span className="hint-inline">（此列跳过）</span>
                  ) : (
                    <select value={field.variable} onChange={(e) => update(index, { variable: e.target.value })}>
                      <option value="">（未选择）</option>
                      {availableVariables.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                      {field.variable && !availableVariables.includes(field.variable) ? (
                        <option value={field.variable}>{field.variable}（模板中未使用）</option>
                      ) : null}
                    </select>
                  )}
                </td>
                <td className="col-skip">
                  <input
                    type="checkbox"
                    checked={Boolean(field.skip)}
                    title="勾选后这一列只占位置、不填入变量。表格里的序号/复选框/备注列用它跳过。"
                    onChange={() => toggleSkip(index)}
                  />
                </td>
                <td className="col-actions">
                  <button className="icon-button" title="上移" onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button className="icon-button" title="下移" onClick={() => move(index, 1)}>
                    ↓
                  </button>
                  <button className="icon-button" title="删除" onClick={() => remove(index)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="hint">
        表格里如果有序号、复选框、备注等不需要印上标签的列，把对应位置勾上
        <strong>「忽略」</strong>——它仍然占用列位置，但不会填入变量。
      </div>

      <div className="button-row">
        <button onClick={add}>添加一列</button>
        <button
          className="ghost"
          onClick={() => setTemplateFields(inferFields(doc))}
          title="按模板中变量出现的顺序（先上后下、再左到右）生成初稿"
        >
          从模板变量自动生成
        </button>
      </div>

      {fields.length > 0 ? (
        <>
          <div className="section-title">试解析</div>
          <div className="hint">
            把表格里的一行粘到这里，验证列顺序是否正确。这段内容不会保存。
          </div>
          <textarea
            className="paste-area small"
            value={probe}
            placeholder="在表格里复制一行，粘到这里…"
            onChange={(e) => setProbe(e.target.value)}
          />
          {probeResult ? (
            <>
              {probeResult.warnings.length > 0 ? (
                <div className="alert error">
                  {probeResult.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              ) : (
                <div className="alert success">解析正常，列数与映射一致。</div>
              )}
              <table className="field-table compact">
                <tbody>
                  {probeResult.values.map((item, i) => (
                    <tr key={i} className={item.missing ? "missing" : ""}>
                      <th>{item.field.label || item.field.variable || `第 ${i + 1} 列`}</th>
                      <td>{item.value || "（空）"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
