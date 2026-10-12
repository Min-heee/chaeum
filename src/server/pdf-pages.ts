// PDF 쪽수 세기(서버용). 약속의 대강 세기(countPdfPagesRoughly)에 더해, 눌려 있는 객체 묶음을 풀어 그 안의 쪽 표식도 센다.
// PDF 를 다 읽는 것이 아니라 표식만 센다. 작정하고 꾸민 파일은 여전히 숨길 수 있다.
// 그래서 마지막 줄은 그대로 하루 호출 상한과 키의 지출 한도다.
import { inflateSync } from 'node:zlib';
import { countPageMarks, latin1Text } from '@/contract/pipeline-api';

/** 묶음 하나를 풀었을 때의 최대 크기와, 파일 하나에서 푸는 양의 합. 넘으면 그 묶음은 세지 않는다. */
const INFLATE_MAX_BYTES = 4 * 1024 * 1024;
const INFLATE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

/**
 * PDF 의 쪽수. 눈에 보이는 쪽 표식과 눌린 객체 묶음(/Type /ObjStm) 안의 쪽 표식을 더한다.
 * 0 이면 "세지 못했다"이다. 부르는 쪽은 0 인 파일을 받지 않는다.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = latin1Text(bytes);
  let pages = countPageMarks(text);
  let inflated = 0;

  const streamStart = /stream\r?\n/g;
  for (let m = streamStart.exec(text); m; m = streamStart.exec(text)) {
    const from = m.index + m[0].length;
    // 이 묶음의 머리(바로 앞 사전)에 객체 묶음이라고 적혀 있을 때만 푼다. 그림 같은 큰 묶음은 건드리지 않는다.
    const head = text.slice(Math.max(0, text.lastIndexOf('obj', m.index)), m.index).replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (!/\/ObjStm(?![a-zA-Z])/.test(head)) continue;
    const end = text.indexOf('endstream', from);
    if (end < 0) break;
    try {
      const out = inflateSync(bytes.subarray(from, end), { maxOutputLength: INFLATE_MAX_BYTES });
      inflated += out.length;
      if (inflated > INFLATE_TOTAL_MAX_BYTES) break;
      pages += countPageMarks(latin1Text(out));
    } catch {
      // 풀지 못한 묶음(다른 방식으로 눌렸거나 깨졌다)은 세지 않는다.
    }
    streamStart.lastIndex = end;
  }
  return pages;
}
