// 주입 시험의 글 재료. 글 검사를 통과하도록 직접 지은 제목·요약이다(모델이 쓴 글이 아니다).
// 이름은 전부 지어낸 것이고, 역과 동네 이름만 실제 지명이다.
import type { Lang, Placeholder, TextField } from '@/contract/content';

export interface TextCase {
  id: string;
  lang: Lang;
  field: TextField;
  text: string;
  requiredPlaceholders: Placeholder[];
  /** 이 글에 꼭 있어야 하는 용어집 표기(하나) */
  term: string;
  /** 용어 바꾸기에 쓰는 다른 낱말 */
  swapTo: string;
  allowedNumbers: string[];
}

interface Product {
  id: string;
  numbers: string[];
  placeholders: Placeholder[];
  en: { term: string; swapTo: string; title: string; summary: string };
  zh: { term: string; swapTo: string; title: string; summary: string };
}

const PRODUCTS: Product[] = [
  {
    id: 'billboard-a',
    numbers: ['11'],
    placeholders: ['price', 'days'],
    en: {
      term: 'digital billboard',
      swapTo: 'LED screen',
      title: 'Haneulbit Digital Billboard, Gangnam Station Exit 11',
      summary: 'A digital billboard at Gangnam Station Exit 11. Bookings start from {days} days, from {price}.',
    },
    zh: { term: '电子屏', swapTo: '大屏幕', title: '江南站11号出口 天光电子屏', summary: '位于江南站11号出口的电子屏，{days}天起订，{price}起。' },
  },
  {
    id: 'billboard-b',
    numbers: [],
    placeholders: ['price', 'days'],
    en: {
      term: 'digital billboard',
      swapTo: 'video wall',
      title: 'Escaron Media Wall Digital Billboard, Apgujeong-dong',
      summary: 'Large digital billboard in Apgujeong-dong for fan support ads. Minimum {days} days, starting at {price}.',
    },
    zh: { term: '电子屏', swapTo: '显示墙', title: '狎鸥亭洞 艾斯卡隆电子屏', summary: '狎鸥亭洞的大型电子屏，适合应援广告，最短{days}天，{price}起。' },
  },
  {
    id: 'subway',
    numbers: [],
    placeholders: ['price', 'days'],
    en: {
      term: 'subway ad',
      swapTo: 'metro poster',
      title: 'Byeolmuri Subway Ad, Hongik Univ. Station',
      summary: 'Subway ad inside Hongik Univ. Station. Runs for at least {days} days, from {price}.',
    },
    zh: { term: '地铁广告', swapTo: '地铁海报', title: '弘大入口站 星群地铁广告', summary: '弘大入口站内的地铁广告，最短{days}天，{price}起。' },
  },
  {
    id: 'bus',
    numbers: [],
    placeholders: ['price', 'days'],
    en: {
      term: 'bus ad',
      swapTo: 'coach banner',
      title: 'Onsaemiro Bus Ad, Seongsu-dong',
      summary: 'Bus ad on routes through Seongsu-dong. Available from {days} days, starting at {price}.',
    },
    zh: { term: '公交广告', swapTo: '巴士海报', title: '圣水洞 温赛米罗公交广告', summary: '途经圣水洞线路的公交广告，{days}天起，{price}起。' },
  },
  {
    id: 'coffee',
    numbers: [],
    placeholders: ['price', 'qty'],
    en: {
      term: 'coffee truck',
      swapTo: 'coffee van',
      title: 'Dalbodre Coffee Truck',
      summary: 'Coffee truck service across Seoul and Gyeonggi. Orders from {qty} cups, starting at {price}.',
    },
    zh: { term: '咖啡车', swapTo: '咖啡餐车', title: '达宝得咖啡车', summary: '首尔及京畿地区咖啡车服务，{qty}杯起订，{price}起。' },
  },
  {
    id: 'lunch',
    numbers: [],
    placeholders: ['price', 'qty'],
    en: {
      term: 'lunch box',
      swapTo: 'bento',
      title: 'Saebyeok Lunch Box Catering',
      summary: 'Lunch box delivery for filming sets in Mapo-gu. Minimum {qty} sets, from {price}.',
    },
    zh: { term: '便当', swapTo: '盒饭', title: '晓光便当配送', summary: '麻浦区拍摄现场便当配送，{qty}份起订，{price}起。' },
  },
  {
    id: 'print',
    numbers: [],
    placeholders: ['price', 'qty'],
    en: {
      term: 'printed goods',
      swapTo: 'paper items',
      title: 'Narae Postcard Set Printed Goods',
      summary: 'Printed goods made to order on coated paper. Minimum {qty} pieces, from {price}.',
    },
    zh: { term: '印刷品', swapTo: '纸制品', title: '娜莱明信片套装印刷品', summary: '铜版纸定制印刷品，{qty}张起订，{price}起。' },
  },
  {
    id: 'goods',
    numbers: [],
    placeholders: ['price', 'qty'],
    en: {
      term: 'merchandise',
      swapTo: 'fan items',
      title: 'Garam Acrylic Keyring Merchandise',
      summary: 'Custom acrylic merchandise for fan events. Orders start at {qty} pieces, from {price}.',
    },
    zh: { term: '周边', swapTo: '纪念品', title: '嘉蓝亚克力钥匙扣周边', summary: '粉丝活动定制亚克力周边，{qty}个起订，{price}起。' },
  },
];

/** 재료 32줄(상품 8 × 언어 2 × 칸 2). 제목에는 자리표시가 없고 요약에는 둘 있다. */
export const TEXT_CASES: TextCase[] = PRODUCTS.flatMap((p) =>
  (['en', 'zh-Hans'] as const).flatMap((lang) => {
    const side = lang === 'en' ? p.en : p.zh;
    return (['title', 'summary'] as const).map((field) => ({
      id: `${p.id}/${lang}/${field}`,
      lang,
      field,
      text: side[field],
      requiredPlaceholders: field === 'summary' ? p.placeholders : [],
      term: side.term,
      swapTo: side.swapTo,
      allowedNumbers: p.numbers,
    }));
  }),
);

/** 모델의 혼잣말·머리말로 흔한 문장. 검사기의 낱말 목록을 보고 고른 것이 아니다. */
export const MONOLOGUES: Record<Lang, { before: string[]; after: string[] }> = {
  en: {
    before: ['Here is the translation: ', "Sure, here's the title: ", 'Translation: ', 'Certainly! '],
    after: [" Let me know if you'd like changes.", ' (Note: placeholder kept as requested.)', ' I hope this helps!'],
  },
  'zh-Hans': {
    before: ['以下是翻译：', '好的，', '译文：'],
    after: ['如需修改请告诉我。', '（注：已保留占位符）'],
  },
};

/** 글 가운데에 끼워 넣는 한글 낱말. */
export const HANGUL_WORDS = ['전광판', '커피차', '할인', '문의', '예약 가능'];

/** 자리표시를 숫자로 바꿔 적을 때 쓰는 글자. */
export const NUMBER_FOR: Record<Placeholder, string> = { price: '1,500,000', days: '7', qty: '100' };
