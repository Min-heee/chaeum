// 조립된 정답 세트의 기계 검산과 판에 박힘 재기. 정답은 고치지 않는다.
//
//   npx tsx scripts/gold-check.ts check [--date 2026-10-12]   100건을 검산해 이번 차례 작업 폴더(저장소 밖)의 check-findings.json 에 쓴다
//   npx tsx scripts/gold-check.ts measure                     칸별 가장 흔한 표기 뼈대의 몫, 닮은 글 짝, 글 길이를 첫 차례와 견줘 measure.json 에 쓴다
//   npx tsx scripts/gold-check.ts selftest                    멀쩡한 원문을 일부러 망가뜨려 검산이 얼마나 잡는지 본다(selftest.md)
//   npx tsx --env-file-if-exists=.env.local scripts/gold-check.ts db   DB 의 gold_docs 가 파일과 같은지 본다(읽기만)
//
// 화면에는 연습 세트의 것만 자세히 찍는다. 안 여는 세트는 번호와 갈래, 건수만 찍는다.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import type { GoldDoc } from '../src/contract/eval-types';
import type { FieldKey } from '../src/contract/fields';
import { alikePairs, checkDoc, lengthStats, shapeTable, type Finding } from '../src/gold/check';
import { argValue } from '../src/gold/cli';
import { canon, docToLine, readJsonlFile, sha256 } from '../src/gold/files';
import { generateSpecs } from '../src/gold/generate';
import { DEV_FILE, TEST_HASH_FILE, roundDir, sealedTestFile, workDir } from '../src/gold/paths';
import { listDocs } from '../src/gold/store';
import type { GoldSpec } from '../src/gold/spec';

const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

async function loadRound(): Promise<{ seed: number; specs: GoldSpec[]; dev: GoldDoc[]; test: GoldDoc[]; top: string[] }> {
  const { seed, specs } = JSON.parse(await readFile(path.join(roundDir(), 'specs.json'), 'utf8')) as { seed: number; specs: GoldSpec[] };
  const top: string[] = [];
  if (!same(specs, generateSpecs(seed))) top.push('설계도 파일이 씨앗으로 다시 만든 것과 다르다');
  const dev = (await readJsonlFile(DEV_FILE)) ?? [];
  const sealedFile = sealedTestFile();
  const test = (await readJsonlFile(sealedFile)) ?? [];
  if (dev.length !== 40) top.push(`연습 세트가 ${dev.length}건이다(40건이어야 한다)`);
  if (test.length !== 60) top.push(`안 여는 세트가 ${test.length}건이다(60건이어야 한다)`);
  const hashLine = (await readFile(TEST_HASH_FILE, 'utf8')).trim();
  if (!hashLine.startsWith(sha256(await readFile(sealedFile, 'utf8')))) top.push('해시 파일이 안 여는 세트 파일과 맞지 않는다');
  return { seed, specs, dev, test, top };
}

async function runCheck(argv: string[]) {
  const { seed, specs, dev, test, top } = await loadRound();
  const docs = new Map([...dev, ...test].map((d) => [d.id, d]));
  const names = specs.filter((x) => typeof x.truth.name === 'string').map((x) => ({ id: x.id, name: x.truth.name as string }));
  const rows: { id: string; split: string; type: string; subtype: string | null; style: string; findings: Finding[] }[] = [];
  for (const spec of specs) {
    const doc = docs.get(spec.id);
    const findings: Finding[] = doc ? checkDoc(spec, doc) : [{ level: 'hard', kind: '빠짐', text: '조립된 파일에 이 번호가 없다' }];
    if (doc && doc.split !== spec.split) top.push(`${spec.id}: 묶음이 다르다`);
    if (doc) for (const n of names) if (n.id !== spec.id && doc.content.includes(n.name)) findings.push({ level: 'soft', kind: '다른 상품 이름', text: `${n.id} 의 상품 이름이 이 글에도 나온다` });
    rows.push({ id: spec.id, split: spec.split, type: spec.type, subtype: spec.subtype, style: spec.style, findings });
  }
  const out = path.join(roundDir(), 'check-findings.json');
  await writeFile(out, `${JSON.stringify({ date: argValue(argv, '--date') ?? null, seed, top, rows }, null, 1)}\n`, 'utf8');

  const hardRows = rows.filter((r) => r.findings.some((f) => f.level === 'hard'));
  const softRows = rows.filter((r) => !r.findings.some((f) => f.level === 'hard') && r.findings.length > 0);
  const n = (list: typeof rows, split: string) => list.filter((r) => r.split === split).length;
  console.log(`전 건 ${rows.length}: 어긋남이 있는 건 ${hardRows.length}(dev ${n(hardRows, 'dev')}, test ${n(hardRows, 'test')}), 살펴볼 것만 ${softRows.length}(dev ${n(softRows, 'dev')}, test ${n(softRows, 'test')})`);
  const kinds = new Map<string, number>();
  for (const r of rows) for (const f of r.findings) kinds.set(`${f.level === 'hard' ? '어긋남' : '살펴볼 것'} / ${f.kind}`, (kinds.get(`${f.level === 'hard' ? '어긋남' : '살펴볼 것'} / ${f.kind}`) ?? 0) + 1);
  for (const [k, c] of [...kinds].sort()) console.log(` ${k}: ${c}`);
  for (const t of top) console.log(`먼저 볼 것: ${t}`);
  for (const r of rows) {
    if (r.findings.length === 0) continue;
    if (r.split === 'dev') for (const f of r.findings) console.log(`${r.id} ${f.level === 'hard' ? '어긋남' : '살펴볼 것'} [${f.kind}] ${f.text}`);
    else console.log(`${r.id} ${r.findings.map((f) => `${f.level === 'hard' ? '어긋남' : '살펴볼 것'}[${f.kind}]`).join(' ')}`);
  }
  console.log('자세한 것 → 이번 차례 작업 폴더의 check-findings.json');
}

/** 첫 차례 원문에 흔하던 문장 틀 셋. 연습 세트 원문에서 그 틀이 몇 건에 나오는지 센다. */
const OLD_FRAMES: { name: string; re: RegExp }[] = [
  { name: '가로 Nm × 세로 Nm', re: /가로\s*\d+(?:\.\d+)?\s*m\s*[×xX*]\s*세로\s*\d+(?:\.\d+)?\s*m/ },
  { name: '하루 N회', re: /하루\s*\d[\d,]*\s*회/ },
  { name: '(게재|행사) N일 전까지', re: /(?:게재|행사)\s*\d+\s*일\s*전까지/ },
  { name: 'N,NNN,NNN원', re: /\d{1,3}(?:,\d{3})+원/ },
  { name: 'VAT 포함·VAT 별도', re: /VAT\s*(?:포함|별도)/ },
];

async function measureRound(label: string, specs: GoldSpec[], dev: GoldDoc[], test: GoldDoc[]) {
  const all = [...dev, ...test];
  const pairs = alikePairs(all);
  const isDev = (id: string) => id.startsWith('dev');
  const over = (list: typeof pairs, t: number) => list.filter((p) => p.rate >= t).length;
  const nearest = new Map<string, number>();
  for (const p of pairs) {
    nearest.set(p.a, Math.max(nearest.get(p.a) ?? 0, p.rate));
    nearest.set(p.b, Math.max(nearest.get(p.b) ?? 0, p.rate));
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const devPairs = pairs.filter((p) => isDev(p.a) && isDev(p.b));
  const cross = pairs.filter((p) => isDev(p.a) !== isDev(p.b));
  const len = (d: GoldDoc) => [...d.content].length;
  const openings = new Set(all.map((d) => d.content.trim().slice(0, 6)));
  return {
    label,
    shapes: { dev: shapeTable(specs.filter((s) => s.split === 'dev')), test: shapeTable(specs.filter((s) => s.split === 'test')) },
    frames: OLD_FRAMES.map((f) => ({ name: f.name, dev: dev.filter((d) => f.re.test(d.content)).length, test: test.filter((d) => f.re.test(d.content)).length })),
    alike: {
      all: { pairs: pairs.length, over10: over(pairs, 0.1), over15: over(pairs, 0.15), over20: over(pairs, 0.2), over30: over(pairs, 0.3), max: Math.max(...pairs.map((p) => p.rate)) },
      dev: { pairs: devPairs.length, over10: over(devPairs, 0.1), over15: over(devPairs, 0.15), over20: over(devPairs, 0.2), over30: over(devPairs, 0.3), max: Math.max(...devPairs.map((p) => p.rate)) },
      devTest: { pairs: cross.length, over10: over(cross, 0.1), over15: over(cross, 0.15), over20: over(cross, 0.2), over30: over(cross, 0.3), max: Math.max(...cross.map((p) => p.rate)) },
      meanNearest: mean([...nearest.values()]),
      meanAll: mean(pairs.map((p) => p.rate)),
    },
    length: { all: lengthStats(all.map(len)), dev: lengthStats(dev.map(len)), test: lengthStats(test.map(len)) },
    openings: openings.size,
  };
}

async function runMeasure() {
  const now = await loadRound();
  const v1Specs = (JSON.parse(await readFile(path.join(workDir(), 'specs.json'), 'utf8')) as { specs: GoldSpec[] }).specs;
  const v1Dev = (await readJsonlFile(path.join(workDir(), 'dev.v1.jsonl'))) ?? [];
  const v1Test = (await readJsonlFile(path.join(path.dirname(sealedTestFile()), 'test.v1.jsonl'))) ?? [];
  if (v1Dev.length !== 40 || v1Test.length !== 60) throw new Error('첫 차례의 정답 파일(dev.v1.jsonl, test.v1.jsonl)을 못 찾았다');
  const result = { v1: await measureRound('1판', v1Specs, v1Dev, v1Test), v2: await measureRound('2판', now.specs, now.dev, now.test) };
  await writeFile(path.join(roundDir(), 'measure.json'), `${JSON.stringify(result, null, 1)}\n`, 'utf8');
  const pct = (a: number, b: number) => `${a}/${b}(${Math.round((a / b) * 100)}%)`;
  console.log('칸 | 1판 dev 가장 흔한 뼈대 | 2판 dev 가장 흔한 뼈대 | 2판 dev 뼈대 가짓수 | 1판 test | 2판 test');
  for (const r of result.v2.shapes.dev) {
    const o = result.v1.shapes.dev.find((x) => x.field === r.field);
    const ot = result.v1.shapes.test.find((x) => x.field === r.field);
    const nt = result.v2.shapes.test.find((x) => x.field === r.field);
    console.log(`${r.label} | ${o ? pct(o.top, o.docs) : '-'} | ${pct(r.top, r.docs)} | ${o?.kinds ?? '-'}→${r.kinds} | ${ot ? pct(ot.top, ot.docs) : '-'} | ${nt ? pct(nt.top, nt.docs) : '-'}`);
  }
  for (const v of [result.v1, result.v2]) {
    console.log(`${v.label} 틀: ${v.frames.map((f) => `${f.name} dev ${f.dev} test ${f.test}`).join(' · ')}`);
    console.log(`${v.label} 닮은 짝: ${JSON.stringify(v.alike)}`);
    console.log(`${v.label} 길이: ${JSON.stringify(v.length)} 첫 여섯 글자 가짓수 ${v.openings}`);
  }
}

async function runDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 이 없다');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    let bad = 0;
    for (const [split, file] of [['dev', DEV_FILE], ['test', sealedTestFile()]] as const) {
      const fileDocs = (await readJsonlFile(file)) ?? [];
      const dbDocs = new Map((await listDocs(client, split)).map((d) => [d.id, d]));
      // style 은 DB 에 싣지 않는 칸이라 빼고 견준다.
      const line = (d: GoldDoc) => docToLine({ ...d, style: undefined });
      const differ = fileDocs.filter((d) => !dbDocs.has(d.id) || line(dbDocs.get(d.id) as GoldDoc) !== line(d)).map((d) => d.id);
      const onlyDb = [...dbDocs.keys()].filter((id) => !fileDocs.some((d) => d.id === id));
      const versions = [...new Set([...dbDocs.values()].map((d) => d.goldVersion))].join(',');
      bad += differ.length + onlyDb.length;
      console.log(`${split}: 파일 ${fileDocs.length}건, DB ${dbDocs.size}건, 다른 문서 ${differ.length}건, DB 에만 있는 문서 ${onlyDb.length}건, DB 의 정답 버전 ${versions}`);
    }
    const reviews = await client.query('SELECT count(*)::int AS n FROM gold_reviews');
    console.log(`확인 기록 ${(reviews.rows[0] as { n: number }).n}줄`);
    if (bad > 0) process.exit(1);
  } finally {
    await client.end();
  }
}


/** 없는 칸에 넣어 볼 값. 검산이 잡는지 보는 데만 쓴다. */
const LEAK_SAMPLE: Partial<Record<FieldKey, string>> = {
  list_price_krw: '정가는 9,990,000원',
  vat_included: '부가세 별도',
  region: '위치: 왕십리역',
  size_m: '크기 3.3m x 2.2m',
  size_mm: '사이즈 111mm x 222mm',
  resolution_px: '해상도 1366x768',
  hours: '운영 시간 10:30~19:30',
  service_hours: '운영 시간 10:30~19:30',
  spot_seconds: '한 번에 45초',
  plays_per_day: '하루 77회',
  footfall_per_day: '유동인구 하루 5만 명',
  material_deadline_days: '소재는 게재 5일 전까지',
  file_format: 'PSD 파일로',
  refund_full_days: '환불은 게재 5일 전까지 전액',
  booking_deadline_days: '예약은 5일 전까지',
  service_region: '출장 지역은 부산',
  design_deadline_days: '시안은 5일 전까지',
  material: '재질은 크라프트',
  lead_time_days: '제작 기간 5일',
  min_order_qty: '최소 7개 이상',
};

/** 멀쩡한 원문을 일부러 망가뜨려 같은 검산을 돌린다. 검산이 얼마나 잡는지 본다. */
async function runSelftest() {
  const { specs, dev, test } = await loadRound();
  const docs = new Map([...dev, ...test].map((d) => [d.id, d]));
  const key = (fs: Finding[]) => fs.map((f) => `${f.level}|${f.kind}|${f.text}`).sort();
  const rows: { name: string; tried: number; caught: number; missed: string[] }[] = [];
  const run = (name: string, mutate: (spec: GoldSpec, content: string) => string | null) => {
    const row = { name, tried: 0, caught: 0, missed: [] as string[] };
    for (const spec of specs) {
      const doc = docs.get(spec.id);
      if (!doc || spec.type === 'not_product') continue;
      const changed = mutate(spec, doc.content);
      if (changed === null || changed === doc.content) continue;
      row.tried += 1;
      const base = new Set(key(checkDoc(spec, doc)));
      if (key(checkDoc(spec, { ...doc, content: changed })).some((k) => !base.has(k))) row.caught += 1;
      else row.missed.push(spec.id);
    }
    rows.push(row);
  };
  const valued = (s: GoldSpec) => s.surface_hints.filter((h) => !['name', 'region', 'service_region', 'material'].includes(h.field));
  run('정답에 없는 금액 넣기', (_s, c) => `${c}\n설치비 33,000원`);
  run('정답에 없는 금액 넣기(기호 꼴)', (_s, c) => `${c}\n￦77,700 추가`);
  run('조각 하나 지우기', (s, c) => {
    const t = valued(s)[0]?.tokens[0];
    return t ? c.replace(t, '') : null;
  });
  run('마지막 칸의 조각 지우기', (s, c) => {
    const t = valued(s).at(-1)?.tokens.at(-1);
    return t ? c.replace(t, '') : null;
  });
  run('시간 범위 하나 더', (_s, c) => `${c}\n상담 09:30~17:30`);
  run('단위를 붙이지 않기로 한 수에 단위 붙이기', (s, c) => {
    const h = s.surface_hints.find((x) => x.unit && x.tokens.length === 1);
    if (!h) return null;
    const t = h.tokens[0] as string;
    return c.split(t).join(`${t}${h.unit}`);
  });
  run('조각 둘의 차례 바꾸기', (s, c) => {
    const h = s.surface_hints.find((x) => x.tokens.length >= 2 && x.tokens[0] !== x.tokens[1]);
    if (!h) return null;
    const [a, b] = h.tokens as [string, string];
    if (a.includes(b) || b.includes(a)) return null;
    return c.replace(a, '\u0000').replace(b, a).replace('\u0000', b);
  });
  run('정답에 없는 파일 형식 넣기', (s, c) => (Array.isArray(s.truth.file_format) ? `${c}\nPSD 도 됩니다` : null));
  run('부가세를 반대로 한 번 더 적기', (s, c) => (typeof s.truth.vat_included === 'boolean' ? `${c}\n부가세 ${s.truth.vat_included ? '별도' : '포함'}` : null));
  run('"며칠 전" 하나 더', (_s, c) => `${c}\n변경은 9일 전까지`);
  for (const field of Object.keys(LEAK_SAMPLE) as FieldKey[]) {
    run(`없는 칸(${field})에 값 넣기`, (s, c) => (s.absent.some((a) => a.field === field) ? `${c}\n${LEAK_SAMPLE[field]}` : null));
  }
  run('값 자리의 "추후 안내" 같은 말 지우기', (s, c) => {
    const a = s.absent.find((x) => x.how === 'placeholder' && x.placeholder);
    return a ? c.split(a.placeholder as string).join('') : null;
  });
  const md = ['| 망가뜨린 방법 | 잡은 수 / 넣은 수 | 못 잡은 건 |', '|---|---|---|'];
  for (const r of rows) md.push(`| ${r.name} | ${r.caught} / ${r.tried} | ${r.missed.join(', ') || '-'} |`);
  md.push(`| **합** | **${rows.reduce((a, r) => a + r.caught, 0)} / ${rows.reduce((a, r) => a + r.tried, 0)}** | |`);
  await writeFile(path.join(roundDir(), 'selftest.md'), `${md.join('\n')}\n`, 'utf8');
  console.log(md.join('\n'));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'check') await runCheck(rest);
  else if (cmd === 'measure') await runMeasure();
  else if (cmd === 'db') await runDb();
  else if (cmd === 'selftest') await runSelftest();
  else throw new Error('check | measure | db | selftest 가운데 하나를 준다');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
