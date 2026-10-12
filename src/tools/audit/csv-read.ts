// CSV 글을 줄과 칸으로 가른다. 내려받기가 쓰는 규칙(CSV_RULES)의 거꾸로다.
// 큰따옴표로 감싼 칸 안의 쉼표·줄바꿈·겹따옴표("")를 읽고, 맨 앞의 BOM 을 뗀다. 줄 끝은 \r\n 과 \n 을 모두 받는다.

/** 칸은 전부 글자다. 빈칸은 빈 글자. 닫히지 않은 따옴표는 글 끝에서 닫힌 것으로 본다. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r' && text[i + 1] === '\n') {
      endRow();
      i += 1;
    } else cell += ch;
  }
  // 마지막 줄이 줄바꿈 없이 끝났으면 그 줄도 넣는다. 줄바꿈으로 끝났으면 빈 줄을 만들지 않는다.
  if (cell !== '' || wasQuoted || row.length > 0) endRow();
  return rows;
}
