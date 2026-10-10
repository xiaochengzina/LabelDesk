/**
 * 属性面板：完全由元素注册表的 `properties` 声明驱动。
 *
 * 新增元素类型时无需改动本文件——字段类型、条件显示、单位提示都来自注册表。
 */

import { useMemo } from "react";
import type { JSX } from "react";
import type { LabelElement } from "../model/types";
import { getElementDefinition, resolveVariables, type PropertyField } from "../renderer/elements";
import { encodeBarcode, encodeQr } from "../model/barcode";
import { fmt } from "../model/units";
import { updateElements, useEditor } from "../state/store";

export function PropertiesPanel(): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const selectedIds = useEditor((s) => s.selectedIds);
  const selected = useMemo(
    () => doc.elements.filter((e) => selectedIds.includes(e.id)),
    [doc.elements, selectedIds],
  );

  if (selected.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">属性</div>
        <div className="empty-hint">
          未选中元素。
          <br />
          在左侧「元素」面板添加，或点击画布中的元素。
        </div>
      </div>
    );
  }

  if (selected.length > 1) {
    return <MultiSelectionPanel count={selected.length} ids={selectedIds} />;
  }

  const element = selected[0];
  const def = getElementDefinition(element.kind);

  return (
    <div className="panel">
      <div className="panel-title">
        属性 · {def.label}
        <span className="panel-subtitle">{element.name}</span>
      </div>
      <div className="panel-body">
        <ContentWarnings element={element} />
        <GeometrySection element={element} />
        <AppearanceSection element={element} />

        <div className="section-title">{def.label}设置</div>
        {def.properties.map((field) => (
          <FieldRow key={field.key} field={field} element={element} />
        ))}
      </div>
    </div>
  );
}

/**
 * 内容校验提示。
 * 条码/二维码的内容错误（字符集不符、超容量被截断）在设计阶段就暴露出来，
 * 避免打完一整批才发现扫不出来。
 */
function ContentWarnings({ element }: { element: LabelElement }): JSX.Element | null {
  const variables = useEditor((s) => s.doc.variables);
  const record = element as unknown as Record<string, unknown>;

  const messages: Array<{ kind: "error" | "info"; text: string }> = [];
  if (element.kind === "barcode" && typeof record.value === "string") {
    const pattern = encodeBarcode(
      record.format as Parameters<typeof encodeBarcode>[0],
      resolveVariables(record.value, variables),
    );
    for (const w of pattern.warnings) messages.push({ kind: "error", text: w });
  }
  if (element.kind === "qrcode" && typeof record.value === "string") {
    const matrix = encodeQr(resolveVariables(record.value, variables), String(record.ecc ?? "M"));
    for (const w of matrix.warnings) messages.push({ kind: "error", text: w });
    if (matrix.size > 0 && matrix.warnings.length === 0) {
      messages.push({
        kind: "info",
        text: `二维码版本 ${matrix.version}（${matrix.size}×${matrix.size} 模块），已通过解码验证`,
      });
    }
  }

  if (messages.length === 0) return null;
  return (
    <>
      {messages.map((m, i) => (
        <div key={i} className={`alert ${m.kind === "error" ? "error" : "info"}`}>
          {m.text}
        </div>
      ))}
    </>
  );
}

function MultiSelectionPanel({ count, ids }: { count: number; ids: string[] }): JSX.Element {
  const doc = useEditor((s) => s.doc);
  const elements = doc.elements.filter((e) => ids.includes(e.id));
  const kinds = [...new Set(elements.map((e) => e.kind))];
  return (
    <div className="panel">
      <div className="panel-title">多选 · {count} 个元素</div>
      <div className="panel-body">
        <div className="field-row">
          <label>类型</label>
          <div className="field-value">{kinds.join(" / ")}</div>
        </div>
        <div className="field-row">
          <label>统一旋转</label>
          <input
            type="number"
            step={1}
            defaultValue={elements[0]?.rotation ?? 0}
            onChange={(e) => updateElements(ids, { rotation: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>统一透明度</label>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            defaultValue={elements[0]?.opacity ?? 1}
            onChange={(e) => updateElements(ids, { opacity: Number(e.target.value) })}
          />
        </div>
        <div className="hint">几何属性请单选后编辑，或使用工具栏的对齐功能。</div>
      </div>
    </div>
  );
}

function GeometrySection({ element }: { element: LabelElement }): JSX.Element {
  const ids = [element.id];
  const num = (key: keyof LabelElement, value: number) =>
    updateElements(ids, { [key]: Math.round(value * 100) / 100 } as Partial<LabelElement>);

  return (
    <>
      <div className="section-title">位置与尺寸</div>
      <div className="grid-2">
        <label className="mini-field">
          <span>X</span>
          <input type="number" step={0.5} value={fmt(element.xMm)} onChange={(e) => num("xMm", Number(e.target.value))} />
          <em>mm</em>
        </label>
        <label className="mini-field">
          <span>Y</span>
          <input type="number" step={0.5} value={fmt(element.yMm)} onChange={(e) => num("yMm", Number(e.target.value))} />
          <em>mm</em>
        </label>
        <label className="mini-field">
          <span>宽</span>
          <input type="number" step={0.5} min={0.5} value={fmt(element.widthMm)} onChange={(e) => num("widthMm", Math.max(0.5, Number(e.target.value)))} />
          <em>mm</em>
        </label>
        <label className="mini-field">
          <span>高</span>
          <input type="number" step={0.5} min={0.5} value={fmt(element.heightMm)} onChange={(e) => num("heightMm", Math.max(0.5, Number(e.target.value)))} />
          <em>mm</em>
        </label>
        <label className="mini-field">
          <span>旋转</span>
          <input type="number" step={1} min={0} max={359} value={fmt(element.rotation)} onChange={(e) => num("rotation", ((Number(e.target.value) % 360) + 360) % 360)} />
          <em>°</em>
        </label>
        <label className="mini-field">
          <span>名称</span>
          <input
            type="text"
            value={element.name}
            onChange={(e) => updateElements(ids, { name: e.target.value } as Partial<LabelElement>)}
          />
        </label>
      </div>
    </>
  );
}

function AppearanceSection({ element }: { element: LabelElement }): JSX.Element {
  const ids = [element.id];
  return (
    <>
      <div className="section-title">外观</div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={element.locked}
          onChange={(e) => updateElements(ids, { locked: e.target.checked } as Partial<LabelElement>)}
        />
        锁定（画布上不可拖动）
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={element.visible}
          onChange={(e) => updateElements(ids, { visible: e.target.checked } as Partial<LabelElement>)}
        />
        显示与打印
      </label>
      <label className="check-row">
        <span>打印浓度</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={element.opacity}
          onChange={(e) => updateElements(ids, { opacity: Number(e.target.value) } as Partial<LabelElement>)}
        />
        <em>{Math.round(element.opacity * 100)}%</em>
      </label>
    </>
  );
}

function FieldRow({ field, element }: { field: PropertyField; element: LabelElement }): JSX.Element | null {
  const record = element as unknown as Record<string, unknown>;
  const value = record[field.key];

  // 条件显示
  if (field.visibleWhen && record[field.visibleWhen.key] !== field.visibleWhen.equals) return null;

  const setValue = (next: unknown) => {
    updateElements([element.id], { [field.key]: next } as Partial<LabelElement>);
  };

  switch (field.type) {
    case "textarea":
      return (
        <div className="field-row">
          <label>{field.label}</label>
          <textarea
            rows={Math.min(6, Math.max(2, String(value ?? "").split("\n").length))}
            value={String(value ?? "")}
            onChange={(e) => setValue(e.target.value)}
          />
          {field.hint ? <div className="hint">{field.hint}</div> : null}
        </div>
      );

    case "number":
      return (
        <div className="field-row inline">
          <label>{field.label}</label>
          <input
            type="number"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={Number(value ?? 0)}
            onChange={(e) => setValue(Number(e.target.value))}
          />
          {field.unit ? <em className="unit">{field.unit}</em> : null}
          {field.hint ? <div className="hint">{field.hint}</div> : null}
        </div>
      );

    case "boolean":
      return (
        <div className="field-row">
          <label className="check-row">
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => setValue(e.target.checked)} />
            {field.label}
          </label>
          {field.hint ? <div className="hint">{field.hint}</div> : null}
        </div>
      );

    case "select":
      return (
        <div className="field-row">
          <label>{field.label}</label>
          <select value={String(value ?? "")} onChange={(e) => setValue(e.target.value)}>
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {field.hint ? <div className="hint">{field.hint}</div> : null}
        </div>
      );

    case "image":
      return <ImageField field={field} value={String(value ?? "")} onChange={setValue} />;

    default:
      return (
        <div className="field-row">
          <label>{field.label}</label>
          <input type="text" value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
          {field.hint ? <div className="hint">{field.hint}</div> : null}
        </div>
      );
  }
}

function ImageField({
  field,
  value,
  onChange,
}: {
  field: PropertyField;
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/bmp,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        alert("图片过大（超过 4MB）。请先压缩，或改用矢量形状。");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => onChange(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    };
    input.click();
  };

  return (
    <div className="field-row">
      <label>{field.label}</label>
      {value ? <img className="image-preview" src={value} alt="已选图片" /> : <div className="image-placeholder">未选择图片</div>}
      <div className="button-row">
        <button type="button" onClick={pick}>
          选择图片…
        </button>
        {value ? (
          <button type="button" className="ghost" onClick={() => onChange("")}>
            清除
          </button>
        ) : null}
      </div>
      {field.hint ? <div className="hint">{field.hint}</div> : null}
    </div>
  );
}
