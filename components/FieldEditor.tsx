'use client';

// 칸 하나를 고치는 입력. 칸의 꼴마다 입력이 다르다. 여기서는 꼴만 맞추고, 맞는 값인지는 서버의 규칙이 다시 본다.
import { useId, useState, type FormEvent } from 'react';
import { fieldDef, parseFieldValue, type FieldKey } from '@/contract/fields';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : '');

interface Row {
  key: string;
  price: string;
}

interface State {
  text: string;
  a: string;
  b: string;
  flag: boolean;
  choice: '' | 'true' | 'false';
  rows: Row[];
}

function initialState(field: FieldKey, value: unknown): State {
  const kind = fieldDef(field).kind;
  const base: State = { text: '', a: '', b: '', flag: false, choice: '', rows: [] };
  if (value === null || value === undefined) return kind.endsWith('_options') ? { ...base, rows: [{ key: '', price: '' }] } : base;
  const o = obj(value);
  switch (kind) {
    case 'bool':
      return { ...base, choice: value === true ? 'true' : value === false ? 'false' : '' };
    case 'size_m':
    case 'size_mm':
    case 'resolution':
      return { ...base, a: str(o.width), b: str(o.height) };
    case 'hours':
      return { ...base, a: str(o.open), b: str(o.close), flag: o.nextDay === true };
    case 'period_options':
    case 'quantity_options': {
      const keyName = kind === 'period_options' ? 'days' : 'qty';
      const rows = Array.isArray(value) ? value.map((item) => ({ key: str(obj(item)[keyName]), price: str(obj(item).price_krw) })) : [];
      return { ...base, rows };
    }
    case 'formats':
      return { ...base, text: Array.isArray(value) ? value.map(String).join(', ') : '' };
    default:
      return { ...base, text: str(value) };
  }
}

const toNumber = (s: string): number => (s.trim() === '' ? Number.NaN : Number(s.replaceAll(',', '').trim()));

/** 입력을 표준 값으로 만든다. 비었으면 null("없음"), 꼴이 틀리면 undefined. */
function build(field: FieldKey, s: State): unknown {
  const kind = fieldDef(field).kind;
  switch (kind) {
    case 'text':
      return s.text.trim() === '' ? null : s.text.trim();
    case 'bool':
      return s.choice === '' ? null : s.choice === 'true';
    case 'money':
    case 'count':
    case 'days':
    case 'footfall':
      return s.text.trim() === '' ? null : toNumber(s.text);
    case 'size_m':
    case 'size_mm':
    case 'resolution':
      return s.a.trim() === '' && s.b.trim() === '' ? null : { width: toNumber(s.a), height: toNumber(s.b) };
    case 'hours':
      return s.a === '' && s.b === '' ? null : { open: s.a, close: s.b, nextDay: s.flag };
    case 'period_options':
    case 'quantity_options': {
      const keyName = kind === 'period_options' ? 'days' : 'qty';
      const rows = s.rows.filter((r) => r.key.trim() !== '' || r.price.trim() !== '');
      return rows.map((r) => ({ [keyName]: toNumber(r.key), price_krw: toNumber(r.price) })).sort((x, y) => (x[keyName] ?? 0) - (y[keyName] ?? 0));
    }
    case 'formats': {
      const list = s.text.split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
      return list.length === 0 ? null : [...new Set(list)].sort();
    }
  }
}

export function FieldEditor({
  field,
  value,
  busy,
  onSave,
  onCancel,
}: {
  field: FieldKey;
  value: unknown;
  busy: boolean;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}) {
  const def = fieldDef(field);
  const [state, setState] = useState<State>(() => initialState(field, value));
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const set = (patch: Partial<State>) => setState((prev) => ({ ...prev, ...patch }));
  const setRow = (index: number, patch: Partial<Row>) =>
    setState((prev) => ({ ...prev, rows: prev.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const built = build(field, state);
    if (!parseFieldValue(field, built).ok) {
      setProblem('값의 꼴이 맞지 않습니다. 숫자 칸에는 숫자만, 시각은 시:분으로 적어 주세요.');
      return;
    }
    setProblem(null);
    onSave(built);
  };

  let inputs;
  switch (def.kind) {
    case 'bool':
      inputs = (
        <select id={id} autoFocus value={state.choice} onChange={(e) => set({ choice: e.target.value as State['choice'] })}>
          <option value="">없음</option>
          <option value="true">예</option>
          <option value="false">아니오</option>
        </select>
      );
      break;
    case 'size_m':
    case 'size_mm':
    case 'resolution':
      inputs = (
        <span className="pair">
          <label>
            가로 <input id={id} autoFocus inputMode="decimal" value={state.a} onChange={(e) => set({ a: e.target.value })} />
          </label>
          <label>
            세로 <input inputMode="decimal" value={state.b} onChange={(e) => set({ b: e.target.value })} />
          </label>
        </span>
      );
      break;
    case 'hours':
      inputs = (
        <span className="pair">
          <label>
            시작 <input id={id} autoFocus type="time" value={state.a} onChange={(e) => set({ a: e.target.value })} />
          </label>
          <label>
            끝 <input type="time" value={state.b} onChange={(e) => set({ b: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={state.flag} onChange={(e) => set({ flag: e.target.checked })} /> 끝이 다음 날
          </label>
        </span>
      );
      break;
    case 'period_options':
    case 'quantity_options': {
      const keyLabel = def.kind === 'period_options' ? '일수' : '수량';
      inputs = (
        <span className="rows">
          {state.rows.map((row, index) => (
            <span className="pair" key={index}>
              <label>
                {keyLabel} <input id={index === 0 ? id : undefined} autoFocus={index === 0} inputMode="numeric" value={row.key} onChange={(e) => setRow(index, { key: e.target.value })} />
              </label>
              <label>
                값(원) <input inputMode="numeric" value={row.price} onChange={(e) => setRow(index, { price: e.target.value })} />
              </label>
              <button type="button" className="btn small" onClick={() => set({ rows: state.rows.filter((_, i) => i !== index) })} aria-label={`${index + 1}번째 옵션 빼기`}>
                빼기
              </button>
            </span>
          ))}
          <button type="button" className="btn small" onClick={() => set({ rows: [...state.rows, { key: '', price: '' }] })}>
            옵션 더하기
          </button>
        </span>
      );
      break;
    }
    case 'formats':
      inputs = <input id={id} autoFocus value={state.text} placeholder="jpg, mp4" onChange={(e) => set({ text: e.target.value })} />;
      break;
    case 'text':
      inputs = <input id={id} autoFocus className="wide" value={state.text} onChange={(e) => set({ text: e.target.value })} />;
      break;
    default:
      inputs = <input id={id} autoFocus inputMode="numeric" value={state.text} onChange={(e) => set({ text: e.target.value })} />;
  }

  return (
    <form className="editor" onSubmit={submit}>
      <label htmlFor={id} className="editor-label">
        {def.label} 고치기 <span className="muted">({def.hint}. 비우면 “없음”)</span>
      </label>
      {inputs}
      {problem ? <p className="problem" role="alert">{problem}</p> : null}
      <span className="actions">
        <button type="submit" className="btn primary small" disabled={busy}>
          {busy ? '저장 중…' : '저장'}
        </button>
        <button type="button" className="btn small" onClick={onCancel} disabled={busy}>
          그만두기
        </button>
      </span>
    </form>
  );
}
