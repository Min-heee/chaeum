// 장부(LlmCallStore)의 구현 둘: 메모리, jsonl 파일. DB 구현은 src/server 에 있다.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LLM_PROVIDER_NAMES, LLM_TASKS, type LlmCallRecord, type LlmCallStore } from '@/contract/llm-types';

/** 장부 한 줄의 꼴. 파일에서 읽은 줄은 이것으로 검사한다. */
export const LlmCallRecordSchema: z.ZodType<LlmCallRecord> = z.object({
  task: z.enum(LLM_TASKS),
  provider: z.enum(LLM_PROVIDER_NAMES),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  cacheKey: z.string().regex(/^[0-9a-f]{64}$/),
  response: z.unknown(),
  stopReason: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  isRecorded: z.boolean(),
}) as z.ZodType<LlmCallRecord>;

/** 메모리 장부. 시험에 쓴다. */
export class MemoryCallStore implements LlmCallStore {
  private readonly byKey = new Map<string, LlmCallRecord>();

  constructor(records: readonly LlmCallRecord[] = []) {
    for (const r of records) this.byKey.set(r.cacheKey, r);
  }

  async find(cacheKey: string): Promise<LlmCallRecord | null> {
    return this.byKey.get(cacheKey) ?? null;
  }

  async save(record: LlmCallRecord): Promise<void> {
    this.byKey.set(record.cacheKey, record);
  }

  get size(): number {
    return this.byKey.size;
  }
}

/** jsonl 글(한 줄에 장부 한 줄)을 읽는다. 꼴이 다른 줄이 있으면 몇째 줄인지 알리고 멈춘다. */
export function parseRecordingLines(text: string, label = 'jsonl'): LlmCallRecord[] {
  const out: LlmCallRecord[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${label} ${i + 1}째 줄: JSON 이 아니다`);
    }
    const parsed = LlmCallRecordSchema.safeParse(json);
    if (!parsed.success) throw new Error(`${label} ${i + 1}째 줄: 장부 꼴이 아니다`);
    out.push(parsed.data);
  });
  return out;
}

/**
 * 폴더 안의 *.jsonl 을 읽는 장부(녹화본). 처음 찾을 때 한 번 읽어 둔다.
 * 같은 키가 여러 번 나오면 파일 이름순으로 뒤에 나온 줄이 이긴다.
 */
export class JsonlCallStore implements LlmCallStore {
  private byKey: Map<string, LlmCallRecord> | null = null;

  /** @param dir 녹화 폴더.  @param writeFileName save 가 줄을 덧붙일 파일 이름. */
  constructor(
    private readonly dir: string,
    private readonly writeFileName = 'calls.jsonl',
  ) {}

  private load(): Map<string, LlmCallRecord> {
    if (this.byKey) return this.byKey;
    const map = new Map<string, LlmCallRecord>();
    if (existsSync(this.dir)) {
      const files = readdirSync(this.dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort();
      for (const file of files) {
        for (const r of parseRecordingLines(readFileSync(join(this.dir, file), 'utf8'), file)) map.set(r.cacheKey, r);
      }
    }
    this.byKey = map;
    return map;
  }

  async find(cacheKey: string): Promise<LlmCallRecord | null> {
    return this.load().get(cacheKey) ?? null;
  }

  async save(record: LlmCallRecord): Promise<void> {
    const checked = LlmCallRecordSchema.parse(record);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, this.writeFileName), `${JSON.stringify(checked)}\n`, 'utf8');
    this.load().set(checked.cacheKey, checked);
  }
}
