// 글자 칸의 감싼 꼴 벗기기 시험. 글과 이름은 모두 지어낸 것이다.
import { describe, expect, it } from 'vitest';
import { unwrapLabeled } from './unwrap';

const SOURCE = `안녕하세요 하늘마루 스크린 보드 안내드려요
위치는 새별역 3번 출구 이에요
Location: Saebyeol Stn. Exit 3
地点：新星站
재질 - 린넨 혼방 원단
출장 지역: 한빛시 전역`;

const region = (raw: string, value: string, source = SOURCE) => unwrapLabeled('region', raw, value, source);

describe('unwrapLabeled — 벗기는 꼴', () => {
  it.each([
    ['위치: 새별역 3번 출구', '이름표 + 쌍점'],
    ['위치 : 새별역 3번 출구', '쌍점 앞뒤 공백'],
    ['위치：새별역 3번 출구', '전각 쌍점'],
    ['위치 = 새별역 3번 출구', '같음표'],
    ['위치 | 새별역 3번 출구', '세로줄'],
    ['위치: 새별역 3번 출구.', '끝의 마침표'],
    ['위치: 새별역 3번 출구 입니다', '이름표 + 쌍점 + 맺는 말'],
    ['위치는 새별역 3번 출구 이에요', '조사 + 맺는 말(띄어 씀)'],
    ['위치는 새별역 3번 출구 이에요.', '조사 + 맺는 말 + 마침표'],
    ['새별역 3번 출구 입니다', '맺는 말만'],
    ['새별역 3번 출구 이라고 합니다!', '긴 맺는 말 + 느낌표'],
    ['"새별역 3번 출구" 입니다', '따옴표로 감싼 값 + 맺는 말'],
    ['"새별역 3번 출구"입니다', '닫는 따옴표 뒤에 붙은 맺는 말'],
    ['새별역 3번 출구 에 있어요', '위치 칸의 "에 있어요"(띄어 씀)'],
    ['■ 위치 : 새별역 3번 출구', '글머리 기호'],
    ['2. 위치: 새별역 3번 출구', '글머리 번호'],
    ['[위치] 새별역 3번 출구', '괄호로 감싼 이름표'],
    ['설치 위치: 새별역 3번 출구', '띄어 쓴 이름표'],
    ['위치: "새별역 3번 출구"', '값을 감싼 따옴표'],
    ['장소가 새별역 3번 출구 이구요', '다른 이름표 낱말, 이어지는 말끝'],
  ])('%s (%s)', (raw) => {
    expect(region(raw, '새별역 3번 출구')).toBe('새별역 3번 출구');
  });

  it('영어·중국어 이름표', () => {
    expect(region('Location: Saebyeol Stn. Exit 3', 'Saebyeol Stn. Exit 3')).toBe('Saebyeol Stn. Exit 3');
    expect(region('LOCATION : Saebyeol Stn. Exit 3', 'Saebyeol Stn. Exit 3')).toBe('Saebyeol Stn. Exit 3');
    expect(region('地点：新星站', '新星站')).toBe('新星站');
  });

  it('칸마다 제 이름표를 쓴다', () => {
    expect(unwrapLabeled('name', '상품명: 하늘마루 스크린 보드', '하늘마루 스크린 보드', SOURCE)).toBe('하늘마루 스크린 보드');
    expect(unwrapLabeled('name', 'Product name: 하늘마루 스크린 보드', '하늘마루 스크린 보드', SOURCE)).toBe('하늘마루 스크린 보드');
    expect(unwrapLabeled('name', '상품 이름은 하늘마루 스크린 보드 입니다', '하늘마루 스크린 보드', SOURCE)).toBe('하늘마루 스크린 보드');
    expect(unwrapLabeled('material', '재질: 린넨 혼방 원단', '린넨 혼방 원단', SOURCE)).toBe('린넨 혼방 원단');
    expect(unwrapLabeled('service_region', '출장 지역: 한빛시 전역', '한빛시 전역', SOURCE)).toBe('한빛시 전역');
  });

  it('원문과는 공백·전각 차이만 봐준다', () => {
    expect(region('위치: 새별역 3번 출구', '새별역 3번 출구', '위치 안내\n새별역  3번\n출구')).toBe('새별역 3번 출구');
    expect(region('위치: 새별역 3번 출구', '새별역 3번 출구', '새별역 ３번 출구')).toBe('새별역 3번 출구');
  });

  it('값의 앞뒤 공백은 떼고 본다', () => {
    expect(region('위치: 새별역 3번 출구', ' 새별역 3번 출구 ')).toBe('새별역 3번 출구');
  });
});

describe('unwrapLabeled — 벗기지 않는 꼴(null 이면 전과 같이 raw 를 쓴다)', () => {
  it('나머지에 뜻이 있는 낱말이 남는다', () => {
    expect(region('위치: 새별역 3번 출구 맞은편 건물', '새별역 3번 출구')).toBeNull();
    expect(region('새별역 3번 출구 근처에요', '새별역 3번 출구')).toBeNull();
    expect(region('위치는 번화가인 새별역 3번 출구 이에요', '새별역 3번 출구')).toBeNull();
    expect(region('정식 위치는 새별역 3번 출구 로 적어 주심 돼요', '새별역 3번 출구')).toBeNull();
  });

  it('값이 raw 의 일부 낱말뿐이다(이름 자르기)', () => {
    expect(unwrapLabeled('name', '하늘마루 스크린 보드', '하늘마루', SOURCE)).toBeNull();
    expect(unwrapLabeled('name', '상품명: 하늘마루 스크린 보드', '하늘마루', SOURCE)).toBeNull();
    expect(unwrapLabeled('name', '상품명: 하늘마루 스크린 보드', '스크린 보드', SOURCE)).toBeNull();
    expect(unwrapLabeled('name', '하늘마루 스크린 보드 입니다', '하늘마루 스크린', SOURCE)).toBeNull();
    expect(region('위치: 새별역 3번 출구', '새별역')).toBeNull();
    expect(region('위치: 새별역 3번 출구', '새별')).toBeNull();
    expect(region('Location: Saebyeol Stn. Exit 3', 'Saebyeol')).toBeNull();
  });

  it('값이 raw 에 없다', () => {
    expect(region('위치: 새별역 3번 출구', '샛별역 3번 출구')).toBeNull();
    expect(region('위치: 새별역 3번 출구', '새별역 3번출구')).toBeNull();
  });

  it('값이 원문에 없다(지어낸 값)', () => {
    expect(region('위치: 달빛역 1번 출구', '달빛역 1번 출구')).toBeNull();
  });

  it('값이 한 글자다', () => {
    expect(region('위치: 역', '역', `${SOURCE}\n위치: 역`)).toBeNull();
  });

  it('값이 이름표 낱말 자체다', () => {
    const source = `${SOURCE}\n위치: 위치\n재질 - 소재`;
    expect(region('위치: 위치', '위치', source)).toBeNull();
    expect(region('위치: Location', 'Location', `${source}\n위치: Location`)).toBeNull();
    expect(unwrapLabeled('material', '재질 - 소재', '소재', source)).toBeNull();
  });

  it('raw 와 값이 같거나 괄호·따옴표만 다르면 손대지 않는다', () => {
    expect(region('새별역 3번 출구', '새별역 3번 출구')).toBeNull();
    expect(region('【새별역 3번 출구】', '새별역 3번 출구', `${SOURCE}\n【새별역 3번 출구】`)).toBeNull();
  });

  it('이름표 뒤에 조사도 가르는 기호도 없으면 이름의 앞 낱말일 수 있다', () => {
    expect(unwrapLabeled('name', '상품 하늘마루 스크린 보드', '하늘마루 스크린 보드', SOURCE)).toBeNull();
    expect(region('위치 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
  });

  it('줄표와 화살표는 가르는 기호가 아니다(이름 한가운데에도 오는 꼴이다)', () => {
    const source = '제품-하늘마루 보드 안내\n제품 - 하늘마루 보드\n제품 > 하늘마루 보드';
    expect(unwrapLabeled('name', '제품-하늘마루 보드', '하늘마루 보드', source)).toBeNull();
    expect(unwrapLabeled('name', '제품 - 하늘마루 보드', '하늘마루 보드', source)).toBeNull();
    expect(unwrapLabeled('name', '제품 > 하늘마루 보드', '하늘마루 보드', source)).toBeNull();
    expect(region('설치 위치 - 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
  });

  it('이름표 + 조사는 뒤에 맺는 말이 있을 때만 벗긴다(없으면 이름·구절의 앞머리일 수 있다)', () => {
    expect(unwrapLabeled('name', '이름이 긴 보드', '긴 보드', '이름이 긴 보드')).toBeNull();
    expect(unwrapLabeled('service_region', '지역이 넓은 한빛시', '넓은 한빛시', '지역이 넓은 한빛시')).toBeNull();
    expect(region('위치는 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
  });

  it('조사가 값에 붙어 있으면 벗기지 않는다', () => {
    expect(region('장소는새별역 3번 출구 이에요', '새별역 3번 출구')).toBeNull();
    expect(region('위치가(새별역 3번 출구) 입니다', '새별역 3번 출구')).toBeNull();
  });

  it('조사가 아닌 말로 이은 것은 벗기지 않는다', () => {
    expect(region('위치의 새별역 3번 출구 이에요', '새별역 3번 출구')).toBeNull();
    expect(region('위치도 새별역 3번 출구 이에요', '새별역 3번 출구')).toBeNull();
    expect(unwrapLabeled('name', '名称为新星屏', '新星屏', '名称为新星屏')).toBeNull();
    expect(region('位置在新星站', '新星站')).toBeNull();
  });

  it('이름표 앞에 다른 낱말이 있으면 벗기지 않는다', () => {
    expect(unwrapLabeled('name', '특가 제품: 하늘마루 스크린 보드', '하늘마루 스크린 보드', SOURCE)).toBeNull();
    expect(region('우리 매장 위치: 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
    expect(region('A 위치는 새별역 3번 출구 이에요', '새별역 3번 출구')).toBeNull();
  });

  it('이름표 없이 조사나 가르는 기호만 있으면 벗기지 않는다', () => {
    expect(region(': 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
    expect(region('- 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
    expect(region('이 새별역 3번 출구 입니다', '새별역 3번 출구')).toBeNull();
    expect(region('는 새별역 3번 출구 이에요', '새별역 3번 출구')).toBeNull();
  });

  it('값의 앞뒤에 숫자가 남으면 벗기지 않는다', () => {
    expect(unwrapLabeled('name', '하늘마루 스크린 보드 2', '하늘마루 스크린 보드', SOURCE)).toBeNull();
    expect(unwrapLabeled('name', '상품명: 하늘마루 스크린 보드 #2', '하늘마루 스크린 보드', SOURCE)).toBeNull();
    expect(unwrapLabeled('name', '상품명: 2 하늘마루 스크린 보드', '하늘마루 스크린 보드', SOURCE)).toBeNull();
    expect(region('위치: 새별역 3번 출구 2 입니다', '새별역 3번 출구')).toBeNull();
  });

  it('값 뒤에 뜻이 있을 수 있는 기호가 남으면 벗기지 않는다', () => {
    for (const tail of ['?', ' (?)', ' ×', ' ~', ' …', ' +', '+', '™', ' 등', ',']) {
      expect(region(`위치: 새별역 3번 출구${tail}`, '새별역 3번 출구')).toBeNull();
    }
    expect(region('위치: ~새별역 3번 출구', '새별역 3번 출구')).toBeNull();
    expect(region('위치: 약 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
  });

  it('띄어 온 낱말이 이름의 끝 낱말일 수 있으면 맺는 말로 보지 않는다', () => {
    const name = (raw: string, value: string) => unwrapLabeled('name', raw, value, raw);
    expect(name('하늘마루 라운지 고요', '하늘마루 라운지')).toBeNull();
    expect(name('하늘마루 이다', '하늘마루')).toBeNull();
    expect(name('하늘마루 구요', '하늘마루')).toBeNull();
    expect(name('하늘마루 랍니다', '하늘마루')).toBeNull();
    expect(name('하늘마루 네요', '하늘마루')).toBeNull();
    expect(name('하늘마루 이요', '하늘마루')).toBeNull();
    expect(name('하늘마루 이며', '하늘마루')).toBeNull();
    expect(name('상품명: 하늘마루 고요', '하늘마루')).toBeNull();
    expect(region('새별역 3번 출구 요', '새별역 3번 출구')).toBeNull();
  });

  it('값에 바로 붙은 말은 낱말의 끝 글자일 수 있어 벗기지 않는다', () => {
    const name = (raw: string, value: string) => unwrapLabeled('name', raw, value, raw);
    expect(name('하늘마루 모임', '하늘마루 모')).toBeNull();
    expect(name('하늘마루 고요', '하늘마루 고')).toBeNull();
    expect(name('하늘마루 놀이요', '하늘마루 놀')).toBeNull();
    expect(name('하늘마루 그네요', '하늘마루 그')).toBeNull();
    expect(name('하늘마루 스테이지요', '하늘마루 스테이')).toBeNull();
    expect(name('하늘마루 도예요', '하늘마루 도')).toBeNull();
    expect(name('상품명: 하늘마루 모임', '하늘마루 모')).toBeNull();
    expect(region('새별이요', '새별', '새별이요')).toBeNull();
    expect(region('새별역', '새별', '새별역')).toBeNull();
    expect(region('새별역 3번 출구요', '새별역 3번 출구')).toBeNull();
    expect(region('새별역 3번 출구입니다', '새별역 3번 출구')).toBeNull();
    expect(region('위치는 새별역 3번 출구이에요.', '새별역 3번 출구')).toBeNull();
    expect(region('새별역 3번 출구에 있어요', '새별역 3번 출구')).toBeNull();
  });

  it('값이 raw 에 두 번 나와도 나머지에 낱말이 남으면 벗기지 않는다', () => {
    expect(region('위치: 새별역 새별역', '새별역')).toBeNull();
    expect(region('새별역 입니다 (새별역)', '새별역')).toBeNull();
  });

  it('값이 raw 에 두 번 나오면 자리마다 따로 본다', () => {
    // 뒤 자리만 감싼 꼴인 것, 앞 자리만 감싼 꼴인 것. 억지스러운 글이지만 어느 자리든 놓치지 않는지 본다.
    expect(region('■■ 위치: ■■', '■■', '■■ 위치: ■■')).toBe('■■');
    expect(region('위치: 입니다 입니다', '입니다', '위치: 입니다 입니다')).toBe('입니다');
  });

  it('이름표 앞의 숫자는 글머리 번호 꼴일 때만 넘긴다', () => {
    expect(region('2024 위치: 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
    expect(region('3 위치: 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
  });

  it('이름표와 조사가 띄어 있으면 벗기지 않는다', () => {
    expect(region('위치 는 새별역 3번 출구 이에요', '새별역 3번 출구')).toBeNull();
  });

  it('다른 칸의 이름표는 이름표가 아니다', () => {
    expect(region('재질: 새별역 3번 출구', '새별역 3번 출구')).toBeNull();
    expect(unwrapLabeled('name', '위치: 하늘마루 스크린 보드', '하늘마루 스크린 보드', SOURCE)).toBeNull();
  });

  it('"에 있어요"는 위치 칸에서만 맺는 말이다', () => {
    const source = '하늘마루 스크린 보드 에 있어요';
    expect(unwrapLabeled('name', '하늘마루 스크린 보드 에 있어요', '하늘마루 스크린 보드', source)).toBeNull();
    expect(unwrapLabeled('region', '하늘마루 스크린 보드 에 있어요', '하늘마루 스크린 보드', source)).toBe('하늘마루 스크린 보드');
  });

  it('글자 칸이 아니면 벗기지 않는다', () => {
    expect(unwrapLabeled('price_krw', '가격: 150만원', '150만원', '가격: 150만원')).toBeNull();
    expect(unwrapLabeled('size_m', '크기: 7*12', '7*12', '크기: 7*12')).toBeNull();
  });
});
