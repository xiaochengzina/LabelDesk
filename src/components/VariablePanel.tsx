/**
 * 变量面板。
 *
 * 模板中的文本/条码内容可以写 `{{变量名}}`，打印前在这里填值即可复用同一套版式。
 * 变量表随模板保存，因此常见批次可以预先填好默认值。
 */

import { useMemo, useState } from "react";
import type { JSX } from "react";
import { setVariables, useEditor } from "../state/store";
import { extractVariableNames, isValidVariableName } from "../renderer/elements";
import type { LabelElement } from "../model/types";

/** 从模板中扫描出所有 {{变量名}}（含中文名） */
function collectVariableNames(elements: LabelElement[]): string[] {
  const found = new Set<string>();
  for (const element of elements) {
    const record = element as unknown as Record<string, unknown>;
    for (const field of ["text", "value"]) {
      const raw = record[field];
      if (typeof raw === "string") {
        for (const name of extractVariableNames(raw)) found.add(name);
      }
    }
  }
  return [...found].sort();
}

interface Props {
  onClose: () => void;
}

export function VariablePanel({ onClose }: Props): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const names = useMemo(() => collectVariableNames(doc.elements), [doc.elements]);
  const [newName, setNewName] = useState("");

  const update = (name: string, value: string) => {
    setVariables({ ...doc.variables, [name]: value });
  };

  const remove = (name: string) => {
    const next = { ...doc.variables };
    delete next[name];
    setVariables(next);
  };

  const addManual = () => {
    const name = newName.trim();
    if (!name) return;
    if (!isValidVariableName(name)) {
      alert("变量名只能包含字母（含中文）、数字、下划线、点和短横线。");
      return;
    }
    setVariables({ ...doc.variables, [name]: doc.variables[name] ?? "" });
    setNewName("");
  };

  return (
    <div className="variable-panel">
      <div className="variable-header">
        <span>变量</span>
        <button className="icon-button" onClick={onClose} title="收起">
          ✕
        </button>
      </div>

      <div className="variable-body">
        {names.length === 0 ? (
          <div className="hint">
            还没有变量。在文本或条码内容里写 <code>{"{{名称}}"}</code> 就会出现这里。
          </div>
        ) : (
          names.map((name) => (
            <div key={name} className="variable-row">
              <label title={name}>{name}</label>
              <input
                type="text"
                value={doc.variables[name] ?? ""}
                placeholder="（空）"
                onChange={(e) => update(name, e.target.value)}
              />
              <button className="icon-button" title="移除该变量默认值" onClick={() => remove(name)}>
                ✕
              </button>
            </div>
          ))
        )}

        <div className="variable-row add">
          <input
            type="text"
            value={newName}
            placeholder="新增变量名"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addManual();
            }}
          />
          <button onClick={addManual}>添加</button>
        </div>

        <div className="hint">
          变量值随模板保存，只影响预览与打印，不会改动模板里的占位符本身。
        </div>
      </div>
    </div>
  );
}
