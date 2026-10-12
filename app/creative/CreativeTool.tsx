'use client';

// 시안 검사 화면. 지면(등록된 광고 지면 상품)을 고르고 시안 파일을 고르면, 파일 머리에서 읽은 값을 그 지면의 규격 칸과 견줘 항목별로 보여 준다.
// 파일 머리는 이 브라우저가 먼저 읽는다(src/tools/creative 의 순수 함수. 서버와 같은 코드다).
//   · 4MB 이하: 파일을 서버로 보내고 서버가 다시 읽어 견준다(POST /api/creative-checks, multipart).
//   · 4MB 초과: 파일을 보내지 않고 읽은 값만 보낸다(같은 경로, JSON). 서버는 파일을 보지 못한다.
// 견주는 판단은 어느 길이든 서버가 한다. AI를 쓰지 않고, 파일도 결과도 저장하지 않는다.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { WORKSPACE_HEADER, type ProductBody, type ProductListResponse } from '@/contract/api';
import {
  CREATIVE_CHECK_LABELS,
  CREATIVE_CHECKS,
  CREATIVE_LIMITS,
  CREATIVE_OUTCOME_LABELS,
  CREATIVE_RULES,
  CREATIVE_SPEC_FIELDS,
  type CreativeCheckResponse,
  type CreativeFacts,
  type CreativeOutcome,
} from '@/contract/tools/creative';
import { CREATIVE_PROBLEM_MESSAGES, RANGE_READ_LIMITS, readCreativeFile, type CreativeFileRead, type ReadRange } from '@/tools/creative';
import { CopyButton, Notice } from '../../components/bits';
import { call, failureMessage, productHref, useMounted, useOrigin, useWorkspace } from '../../components/client';
import { fieldLabel, formatValue } from '../../components/format';

type Space = 'mine' | 'public';

const MB = 1024 * 1024;
const FILE_MAX_MB = CREATIVE_LIMITS.fileMaxBytes / MB;
const WHOLE_MAX_MB = RANGE_READ_LIMITS.wholeFileMaxBytes / MB;
const DECLARED_MAX_GB = CREATIVE_LIMITS.declaredMaxBytes / (1024 * MB);

const OUTCOME_CLASS: Record<CreativeOutcome, string> = { match: 'status status-APPROVED', mismatch: 'status status-FAILED', no_spec: 'status' };

function bytesText(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}바이트`;
}

/** 읽은 값을 한 줄로. 읽지 못한 값은 "읽지 못함"이라고 적는다(비워 두거나 짐작하지 않는다). */
function factsText(facts: CreativeFacts): string {
  const size = facts.width !== null && facts.height !== null ? `${facts.width}x${facts.height}` : '가로·세로 읽지 못함';
  const parts = [facts.format, size];
  if (facts.format === 'mp4') parts.push(facts.durationSeconds !== null ? `${facts.durationSeconds}초` : '길이 읽지 못함');
  parts.push(bytesText(facts.sizeBytes));
  return parts.join(' · ');
}

/** 고른 지면의 규격 칸 셋. 본체가 채운 값을 그대로 보여 준다. */
export function SlotSpec({ slot }: { slot: ProductBody }) {
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <caption className="sr-only">고른 지면의 규격</caption>
        <thead>
          <tr>
            <th scope="col">견주는 항목</th>
            <th scope="col">이 지면의 규격 칸</th>
            <th scope="col">적힌 값</th>
          </tr>
        </thead>
        <tbody>
          {CREATIVE_CHECKS.map((key) => {
            const field = CREATIVE_SPEC_FIELDS[key];
            const value = slot.spec[field];
            const empty = value === null || value === undefined;
            return (
              <tr key={key}>
                <th scope="row">{CREATIVE_CHECK_LABELS[key]}</th>
                <td>{fieldLabel(field)}</td>
                <td>{empty ? <span className="muted">비어 있음. 이 항목은 견주지 못합니다.</span> : formatValue(field, value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 항목별 결과. 서버의 응답을 그대로 보여 준다(여기서 다시 견주지 않는다). */
export function Result({ result }: { result: CreativeCheckResponse }) {
  const mismatches = result.items.filter((i) => i.outcome === 'mismatch').length;
  const unchecked = result.items.filter((i) => i.outcome === 'no_spec').length;
  return (
    <section className="export" aria-label="검사 결과" aria-live="polite">
      <h2>검사 결과</h2>
      {result.verdict === 'pass' ? (
        <p className="ok-line">
          견준 항목은 모두 규격에 맞습니다.
          {unchecked > 0 ? ` 규격 칸이 빈 항목 ${unchecked}개는 견주지 못했습니다.` : ''}
        </p>
      ) : result.verdict === 'fail' ? (
        <Notice kind="warn">
          <strong>규격에 안 맞는 항목이 {mismatches}개 있습니다.</strong> 아래 &ldquo;고칠 점&rdquo;을 보고 다시 내보내 주세요.
        </Notice>
      ) : (
        <Notice>
          이 지면에는 견줄 규격이 하나도 적혀 있지 않습니다. 그래서 맞다고도 틀리다고도 하지 않습니다. 아래는 파일에서 읽은 값입니다.
        </Notice>
      )}

      <div className="table-wrap" tabIndex={0}>
        <table>
          <caption className="sr-only">항목별 결과</caption>
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">결과</th>
              <th scope="col">지면 규격</th>
              <th scope="col">이 파일</th>
              <th scope="col">고칠 점</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr key={item.key}>
                <th scope="row">{CREATIVE_CHECK_LABELS[item.key]}</th>
                <td>
                  <span className={OUTCOME_CLASS[item.outcome]}>{CREATIVE_OUTCOME_LABELS[item.outcome]}</span>
                </td>
                <td>{item.expected ?? <span className="muted">없음</span>}</td>
                <td>{item.actual ?? <span className="muted">읽지 못함</span>}</td>
                <td>{item.fix ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted small">
        지면 #{result.product.id} {result.product.name} · 파일 {result.file.name ?? '(이름 없음)'} · {factsText(result.file)}
      </p>
      <p className="muted small">
        {result.readBy === 'server' ? (
          <>서버가 파일 머리를 직접 읽어 견줬습니다. 파일도 이 결과도 저장하지 않았습니다.</>
        ) : (
          <>
            파일이 {FILE_MAX_MB}MB를 넘어({bytesText(result.file.sizeBytes)}) 서버로 보내지 않았습니다. 이 브라우저가 읽은 값만 보내 견줬고, 서버는 파일을 보지 못했습니다. 이
            결과도 저장하지 않았습니다.
          </>
        )}{' '}
        글자·그림의 내용(문구, 초상)은 살피지 않았습니다.
      </p>
    </section>
  );
}

export function CreativeTool() {
  const mounted = useMounted();
  const workspace = useWorkspace();
  const origin = useOrigin();
  const [space, setSpace] = useState<Space>('mine');
  // 내 작업 공간이 아직 없으면 볼 수 있는 것은 본보기 공간뿐이다.
  const chosen: Space = workspace ? space : 'public';

  const [loaded, setLoaded] = useState<{ space: Space; slots: ProductBody[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ file: File; read: CreativeFileRead } | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreativeCheckResponse | null>(null);
  const turn = useRef(0);

  useEffect(() => {
    if (!mounted) return;
    let alive = true;
    call<ProductListResponse>('GET', '/api/products', { publicSpace: chosen === 'public' })
      .then((list) => {
        if (!alive) return;
        // 시안 규격 칸(해상도, 소재 파일 형식, 한 번 길이)은 광고 지면에만 있다.
        setLoaded({ space: chosen, slots: list.items.filter((p) => p.type === 'ad') });
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(failureMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [mounted, chosen, workspace]);

  const slots = loaded && loaded.space === chosen ? loaded.slots : null;
  // 고르지 않았으면 견줄 규격 칸이 가장 많이 채워진 지면을 먼저 보여 준다(셋 다 빈 지면이 먼저 뜨면 견줄 것이 없다).
  const specCount = (p: ProductBody) => ['resolution_px', 'file_format', 'spot_seconds'].filter((key) => p.spec[key] !== undefined && p.spec[key] !== null).length;
  const fullest = slots ? [...slots].sort((x, y) => specCount(y) - specCount(x))[0] : undefined;
  const slot = slots ? (slots.find((p) => p.id === slotId) ?? fullest ?? null) : null;

  // 읽은 값만 보내는 길에도 용량의 상한이 있다(약속의 declaredMaxBytes). 넘으면 보내지 않고 그렇게 알린다.
  const overDeclared = picked !== null && picked.file.size > CREATIVE_LIMITS.declaredMaxBytes;

  const forget = () => {
    setResult(null);
    setError(null);
  };

  const choose = async (file: File | null) => {
    forget();
    turn.current += 1;
    const mine = turn.current;
    if (!file) {
      setPicked(null);
      setReading(false);
      return;
    }
    setReading(true);
    const range: ReadRange = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    let read: CreativeFileRead;
    try {
      read = await readCreativeFile(range, file.size);
    } catch {
      // 브라우저가 파일을 내주지 않았다(지워졌거나 권한이 없다).
      read = { ok: false, problem: 'unreadable' };
    }
    // 읽는 사이에 다른 파일을 골랐으면 버린다.
    if (mine !== turn.current) return;
    setPicked({ file, read });
    setReading(false);
  };

  const run = async () => {
    if (!slot || !picked || !picked.read.ok || overDeclared) return;
    setBusy(true);
    setError(null);
    try {
      const publicSpace = chosen === 'public';
      const body =
        picked.file.size <= CREATIVE_LIMITS.fileMaxBytes
          ? await call<CreativeCheckResponse>('POST', '/api/creative-checks', {
              file: picked.file,
              fields: { [CREATIVE_LIMITS.productField]: String(slot.id) },
              publicSpace,
              label: '시안 검사 (파일을 올림)',
            })
          : await call<CreativeCheckResponse>('POST', '/api/creative-checks', {
              body: { productId: slot.id, facts: picked.read.facts, fileName: picked.file.name.slice(0, 200) },
              publicSpace,
              label: '시안 검사 (읽은 값만 보냄)',
            });
      setResult(body);
    } catch (err) {
      setResult(null);
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const read = picked?.read ?? null;
  const tooBigForServer = picked !== null && picked.file.size > CREATIVE_LIMITS.fileMaxBytes;
  const header = chosen === 'mine' && workspace ? ` -H "${WORKSPACE_HEADER}: ${workspace}"` : '';
  const curlFile = `curl -sS -X POST "${origin}/api/creative-checks"${header} -F ${CREATIVE_LIMITS.productField}=${slot?.id ?? '<상품 번호>'} -F ${CREATIVE_LIMITS.formField}=@시안.mp4`;
  const curlFacts = `curl -sS -X POST "${origin}/api/creative-checks"${header} -H "Content-Type: application/json" -d '${JSON.stringify({
    productId: slot?.id ?? 1,
    facts: { format: 'mp4', width: 1920, height: 1080, sizeBytes: 180000000, durationSeconds: 15 },
  })}'`;

  return (
    <main className="page">
      <h1>시안 검사</h1>
      <p className="muted">
        광고 시안 파일이 고른 지면의 규격에 맞는지 봅니다. <strong>AI를 쓰지 않습니다.</strong> 파일 머리 몇 바이트에서 형식·가로·세로·길이를 읽어, 그 지면을 등록할
        때 채워 둔 규격 칸과 견줍니다. 파일도 결과도 저장하지 않습니다. 여기서 &ldquo;시안&rdquo;은 등록 칸에서 &ldquo;소재&rdquo;라고 부르는 것과 같은
        것입니다(광고로 내보낼 그림·영상 파일).
      </p>

      <section aria-label="지면 고르기">
        <h2>1. 지면 고르기</h2>
        <div className="who" role="group" aria-label="어느 공간의 지면으로 볼지">
          <button
            type="button"
            className="seg"
            aria-pressed={chosen === 'mine'}
            disabled={!mounted || !workspace}
            onClick={() => {
              setSpace('mine');
              forget();
            }}
          >
            내 작업 공간
          </button>
          <button
            type="button"
            className="seg"
            aria-pressed={chosen === 'public'}
            onClick={() => {
              setSpace('public');
              forget();
            }}
          >
            본보기 공간
          </button>
        </div>
        {mounted && !workspace ? <p className="muted small">아직 내 작업 공간이 없어 본보기 공간의 지면만 볼 수 있습니다.</p> : null}

        {loadError ? <Notice kind="error">{loadError}</Notice> : null}
        {slots === null && !loadError ? (
          <p className="muted">지면을 읽어 오는 중…</p>
        ) : slots && slots.length === 0 ? (
          <Notice>
            {chosen === 'public'
              ? '본보기 공간에 승인된 광고 지면이 아직 없습니다.'
              : '이 공간에 승인한 광고 지면이 아직 없습니다. 위에서 본보기 공간으로 바꿔 볼 수 있습니다.'}{' '}
            견줄 지면이 있어야 검사할 수 있습니다. <Link href="/">작업 화면</Link>에서 광고 지면 소개 글을 넣고 <Link href="/inbox">검수함</Link>에서 승인하면 내
            작업 공간에 지면이 생깁니다. 케이터링·굿즈 상품은 시안 규격 칸이 없어 여기에 나오지 않습니다.
          </Notice>
        ) : slot && slots ? (
          <>
            <div className="actions">
              <label>
                지면{' '}
                <select
                  value={slot.id}
                  onChange={(e) => {
                    setSlotId(Number(e.target.value));
                    forget();
                  }}
                >
                  {slots.map((p) => (
                    <option key={p.id} value={p.id}>
                      #{p.id} {p.name} ({p.subtype})
                    </option>
                  ))}
                </select>
              </label>
              <Link href={productHref(slot.id, chosen === 'public')} className="small">
                이 지면의 상품 화면
              </Link>
            </div>
            <SlotSpec slot={slot} />
            <p className="muted small">
              규격은 이 지면을 등록할 때 채운 칸을 그대로 읽습니다. 여기서 다시 뽑거나 고치지 않습니다. 칸이 비어 있으면 그 항목은 &ldquo;견줄 규격 없음&rdquo;으로
              남습니다.
            </p>
          </>
        ) : null}
      </section>

      <section aria-label="시안 파일 고르기">
        <h2>2. 시안 파일 고르기</h2>
        <p className="muted small">
          JPG·PNG·WEBP 그림과 MP4 영상을 봅니다. 형식은 파일 이름이 아니라 내용으로 정합니다. 고르면 이 브라우저가 먼저 파일 머리를 읽습니다. {FILE_MAX_MB}MB
          이하 파일은 &ldquo;규격과 견주기&rdquo;를 누를 때 서버로 보내 서버가 다시 읽습니다. 그보다 큰 파일은 서버로 보내지 않고 읽은 값만 보냅니다.
        </p>
        <label>
          <span className="sr-only">시안 파일</span>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.mp4,image/jpeg,image/png,image/webp,video/mp4"
            onChange={(e) => void choose(e.target.files?.[0] ?? null)}
          />
        </label>
        <div aria-live="polite">
          {reading ? <p className="muted">파일 머리를 읽는 중…</p> : null}
          {!reading && picked && read?.ok ? (
            <>
              <p>
                <strong>이 브라우저가 읽은 값:</strong> {factsText(read.facts)}
              </p>
              {read.rotation !== 0 ? (
                <Notice kind="warn">
                  이 영상에는 회전 표식({read.rotation}도)이 있습니다.{' '}
                  {read.rotation === 180
                    ? '가로·세로는 그대로지만, 표식을 따르지 않는 재생기에서는 거꾸로 나올 수 있습니다.'
                    : `위의 가로·세로는 표식대로 돌려서 보이는 크기입니다(저장된 크기는 ${read.facts.height}x${read.facts.width}). 표식을 따르지 않는 재생기에서는 옆으로 누워 나올 수 있습니다.`}{' '}
                  돌린 상태로, 회전 표식 없이 다시 내보내는 편이 안전합니다.
                </Notice>
              ) : null}
              {read.wholeSeconds !== undefined ? (
                <Notice kind="info">
                  위의 길이는 영상 트랙의 길이입니다. 파일 전체는 {read.wholeSeconds}초로 더 깁니다(소리 같은 다른 트랙이 영상보다 깁니다). 규격과는 영상 트랙의
                  길이로 견줍니다. 재생기에 따라 전체 길이만큼 돌 수 있으니 소리도 같은 길이로 잘라 내보내는 편이 안전합니다.
                </Notice>
              ) : null}
              {read.facts.format === 'mp4' && read.facts.durationSeconds === null ? (
                <Notice kind="warn">이 영상의 머리에는 전체 길이가 적혀 있지 않습니다(조각으로 나뉜 MP4 등). 길이는 짐작하지 않고 &ldquo;읽지 못함&rdquo;으로 둡니다.</Notice>
              ) : null}
              {overDeclared ? (
                <Notice kind="error">파일이 {DECLARED_MAX_GB}GB를 넘어 견주지 않습니다.</Notice>
              ) : tooBigForServer ? (
                <p className="muted small">
                  {bytesText(picked.file.size)}라서 서버로 보내지 않습니다. 위의 읽은 값만 보내 견줍니다. 서버는 파일을 보지 못합니다.
                </p>
              ) : null}
            </>
          ) : null}
          {!reading && picked && read && !read.ok ? (
            <Notice kind="error">
              {read.problem === 'too_big'
                ? `MP4 가 아닌 파일이 ${WHOLE_MAX_MB}MB를 넘어 이 화면에서는 읽지 않습니다.`
                : CREATIVE_PROBLEM_MESSAGES[read.problem]}
            </Notice>
          ) : null}
        </div>
      </section>

      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || reading || !slot || !read?.ok || overDeclared} onClick={run}>
          {busy ? '견주는 중…' : '규격과 견주기'}
        </button>
        {!slot ? <span className="muted small">먼저 지면을 골라 주세요.</span> : !picked ? <span className="muted small">시안 파일을 골라 주세요.</span> : null}
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {result ? <Result result={result} /> : null}

      <details className="help">
        <summary>이 검사가 보는 것과 보지 않는 것</summary>
        <ul className="reasons">
          <li>
            <span className="flag">{CREATIVE_CHECK_LABELS.format}</span> 파일의 형식이 지면의 &ldquo;{fieldLabel(CREATIVE_SPEC_FIELDS.format)}&rdquo; 목록에 드는가.
            이름의 확장자가 내용과 다르면 내용을 기준으로 하고, 다르다고 적습니다.
          </li>
          <li>
            <span className="flag">{CREATIVE_CHECK_LABELS.resolution}</span> 가로·세로가 지면의 &ldquo;{fieldLabel(CREATIVE_SPEC_FIELDS.resolution)}&rdquo;와 꼭
            같은가. 다르면 비율만 같은지(크기만 바꾸면 되는지), 가로·세로가 뒤바뀐 것인지, 비율부터 다른지 갈라 적습니다.
          </li>
          <li>
            <span className="flag">{CREATIVE_CHECK_LABELS.duration}</span> 영상의 길이가 지면의 &ldquo;{fieldLabel(CREATIVE_SPEC_FIELDS.duration)}&rdquo;와 같은가.{' '}
            {CREATIVE_RULES.durationToleranceSeconds}초까지는 봐줍니다(근거를 재서 정한 값은 아닙니다). 그림에는 이 항목이 없습니다.
          </li>
        </ul>
        <p className="muted small">
          보지 않는 것: 문구·초상 같은 내용, 색과 밝기, 코덱·초당 장 수·소리, 화질. 용량은 읽어서 보여 주기만 합니다(지면에 용량 규격 칸이 없습니다). 움직이는
          WEBP는 그림으로 읽고 길이는 읽지 않습니다. 영상의 길이는 파일 머리에 적힌 전체 길이입니다. 가로·세로는 저장된 픽셀 수이고, 영상에 회전 표식이 있으면
          돌려서 보이는 크기로 바꿔 견줍니다. JPG 사진의 방향 표식(휴대전화 사진을 돌려 보여 주라는 표시)은 읽지 않고 저장된 크기 그대로 견줍니다. 파일을 풀어 보지
          않으므로, 머리는 멀쩡한데 그림·영상 자료가 깨진 파일은 가려내지 못합니다. 읽지 못한 값은 짐작해 채우지 않습니다.
        </p>
      </details>

      <details className="help">
        <summary>같은 일을 하는 curl</summary>
        <p className="muted small">파일을 올리는 길({FILE_MAX_MB}MB까지. 서버가 파일 머리를 읽습니다)</p>
        <pre className="code" tabIndex={0}>{curlFile}</pre>
        <CopyButton text={curlFile} label="curl 복사" />
        <p className="muted small">읽은 값만 보내는 길(큰 파일. 서버는 파일을 보지 못하고 보낸 값을 그대로 견줍니다)</p>
        <pre className="code" tabIndex={0}>{curlFacts}</pre>
        <CopyButton text={curlFacts} label="curl 복사" />
        <p className="muted small">
          공간 헤더({WORKSPACE_HEADER})를 빼면 본보기 공간의 상품과 견줍니다. 견주지 못하면 오류 본문 {'{ code, message }'}로 답합니다: 없는 상품 404, 받지 않는
          형식 415, {FILE_MAX_MB}MB를 넘는 파일 413, 머리를 읽지 못한 파일 422.
        </p>
      </details>
    </main>
  );
}
