import { ExternalFailureKind } from '../external-service.error';

/** @google/genai의 ApiError는 status를, 일부 오류는 code에 숫자를 담는다. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { status?: unknown; code?: unknown };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.code === 'number') return record.code;
  return null;
}

/**
 * instanceof를 쓰지 않는다. SDK 내부의 fetch 실패는 Node(undici)가 호스트 realm에서
 * 만들고, jest는 테스트 파일을 자기 realm의 vm 샌드박스에서 돌린다 — message는
 * 멀쩡한데 instanceof Error만 어긋난다. 그러면 status가 없는 오류의 메시지 판정이
 * 테스트 안에서만 통째로 죽는다(call-external.ts의 causeMessage와 같은 이유).
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/**
 * Gemini SDK 오류를 kind로 판정한다. 모르는 오류에는 null을 반환해 공통 판정에 넘긴다.
 *
 * 429 판정은 core의 isRateLimited(core/src/services/enricher.ts:84-89)와 같은 규칙이다.
 * core가 그 함수에 붙여 놓은 경고도 그대로 유효하다 — 모델 출력 원문을 담은 우리 쪽
 * 오류에 이 정규식을 적용하면 안 된다. 관광지 설명의 "1429년"이 쿼터 초과로 오분류된다.
 * 이 함수는 callExternal이 SDK 호출을 감싼 자리에서만 불리므로 구조적으로 차단된다.
 */
export function classifyGeminiFailure(
  error: unknown,
): ExternalFailureKind | null {
  const status = statusOf(error);
  const message = messageOf(error);

  if (
    status === 429 ||
    /429|rate limit|RESOURCE_EXHAUSTED|quota/i.test(message)
  ) {
    return 'quota';
  }
  if (
    status === 401 ||
    status === 403 ||
    /API key|PERMISSION_DENIED/i.test(message)
  ) {
    return 'auth';
  }
  if (status === 400 || /INVALID_ARGUMENT/i.test(message)) {
    return 'invalid-request';
  }
  if (status !== null && status >= 500 && status <= 599) {
    return 'upstream';
  }
  return null;
}
