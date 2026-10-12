// 요청에 붙이는 파일(그림·PDF)의 약속.
// 브라우저로 가는 코드(올리기 화면)도 이 파일을 읽는다. 그래서 환경 변수나 키 이름이 든 llm-types.ts 와 갈라 뒀다.

export const ATTACHMENT_KINDS = ['image', 'pdf'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** 받는 파일 형식. 그림 셋과 PDF. */
export const ATTACHMENT_MEDIA_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  pdf: ['application/pdf'],
} as const satisfies Record<AttachmentKind, readonly string[]>;
export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[AttachmentKind][number];

/**
 * 요청에 붙이는 파일 하나. 모델에게 그대로 넘긴다(따로 글자 인식 엔진을 두지 않는다).
 * dataBase64 는 줄바꿈 없는 base64 글이다. DB 에도 장부에도 로그에도 남기지 않는다.
 */
export interface LlmAttachment {
  kind: AttachmentKind;
  mediaType: AttachmentMediaType;
  dataBase64: string;
}

/** 파일 형식이 그 종류의 목록에 있는가. */
export function isMediaTypeOf(kind: AttachmentKind, mediaType: string): mediaType is AttachmentMediaType {
  return (ATTACHMENT_MEDIA_TYPES[kind] as readonly string[]).includes(mediaType);
}

/** 파일 형식으로 종류를 정한다. 받지 않는 형식이면 null. */
export function attachmentKindOf(mediaType: string): AttachmentKind | null {
  return ATTACHMENT_KINDS.find((kind) => isMediaTypeOf(kind, mediaType)) ?? null;
}
