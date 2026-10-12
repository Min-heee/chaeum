// 서버가 던지는 오류 하나. 경로 파일이 code 를 보고 HTTP 상태로 바꾼다(API_ERRORS 표).
import type { ApiErrorBody, ApiErrorCode } from '@/contract/api';
import type { LlmSkipCause } from '@/contract/reasons';

export class AppError extends Error {
  readonly code: ApiErrorCode;
  /** 낡은 version 이거나 상품 등록이 막혔을 때 초안의 지금 상태 */
  readonly current?: { status: string; version: number };

  /** 그림·PDF 올리기에서 모델을 못 불렀을 때의 까닭 */
  readonly skipCause?: LlmSkipCause;

  constructor(code: ApiErrorCode, message: string, current?: { status: string; version: number }, skipCause?: LlmSkipCause) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.current = current;
    this.skipCause = skipCause;
  }

  toBody(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.current ? { current: this.current } : {}),
      ...(this.skipCause ? { skipCause: this.skipCause } : {}),
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** PostgreSQL 이 제약 위반으로 거절했는가(23xxx: NOT NULL, UNIQUE, CHECK, FK). */
export function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('23');
}
