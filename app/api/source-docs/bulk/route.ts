// 2. 여러 건 접수(50건까지). 202. 한 건이 틀려도 나머지는 들어간다.
// 본문은 { texts: [...] } 또는 { csv: "..." } 가운데 하나다.
import { z } from 'zod';
import { BulkIntakeRequestSchema, LIMITS } from '@/contract/api';
import { AppError } from '@/server/errors';
import { intakeBulk, textsFromCsv } from '@/server/service';
import { intakeWorkspace, json, readJson, route } from '../../_lib/http';

export const POST = route('POST /source-docs/bulk', async (request: Request) => {
  const workspaceId = intakeWorkspace(request);
  // 건수가 넘친 것은 "꼴이 틀렸다"가 아니라 상한을 알려 준다. 그래서 꼴을 보기 전에 건수부터 본다.
  const raw = await readJson(request, z.unknown());
  const rawTexts = (raw as { texts?: unknown } | null)?.texts;
  if (Array.isArray(rawTexts) && rawTexts.length > LIMITS.bulkMaxDocs) throw new AppError('BAD_INPUT', `한 번에 ${LIMITS.bulkMaxDocs}건까지 넣을 수 있습니다.`);
  const body = BulkIntakeRequestSchema.parse(raw);
  const texts = 'texts' in body ? body.texts : textsFromCsv(body.csv);
  // 건수는 입력의 꼴이다. 목록이든 CSV 든 같은 번호(400)로 답한다.
  if (texts.length === 0) throw new AppError('BAD_INPUT', '넣을 글이 없습니다.');
  if (texts.length > LIMITS.bulkMaxDocs) throw new AppError('BAD_INPUT', `한 번에 ${LIMITS.bulkMaxDocs}건까지 넣을 수 있습니다.`);
  return json(await intakeBulk(texts, { workspaceId, now: new Date() }), 202);
});
