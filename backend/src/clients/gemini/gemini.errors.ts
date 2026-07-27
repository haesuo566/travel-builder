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
 * 2단계 — 확정된 상태 **안에서** 세부를 가른다. 메시지는 상태를 뒤집지 못한다.
 *
 * 400에서만 메시지를 보는 이유: 실제 Gemini는 무효한 키에 401이 아니라
 * 400 + "API key not valid"를 낸다. 상태만 보고 끝내면 만료된 키가
 * invalid-request(502)가 되어 "외부가 우리 요청을 거절했다"로 잘못 청구된다.
 */
function classifyByStatus(
  status: number,
  message: string,
): ExternalFailureKind | null {
  if (status === 400) {
    return /API key|PERMISSION_DENIED/i.test(message)
      ? 'auth'
      : 'invalid-request';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  if (status >= 500 && status <= 599) return 'upstream';
  return null;
}

/**
 * 3단계 — 상태를 끝내 확정하지 못했을 때만 쓰는 안전망. 위에서 아래로 첫 일치.
 *
 * core의 isRateLimited(core/src/services/enricher.ts:84-89)에서 맨 `429`와 맨 `quota`를
 * 뺐다. SDK의 message는 사람이 읽는 문구가 아니라 응답 본문 전문이라
 * ("The input token count (1429852) exceeds…", "checking quota service")
 * 흔한 토큰은 아무 본문에나 걸린다. 여기는 이미 추측 경로이므로 오분류 표면이
 * 좁은 토큰만 남긴다.
 */
function classifyByMessage(message: string): ExternalFailureKind | null {
  if (/RESOURCE_EXHAUSTED|rate limit|quota exceeded/i.test(message)) {
    return 'quota';
  }
  if (/API key|PERMISSION_DENIED/i.test(message)) return 'auth';
  if (/INVALID_ARGUMENT/i.test(message)) return 'invalid-request';
  return null;
}

/**
 * Gemini SDK 오류를 kind로 판정한다. 모르는 오류에는 null을 반환해 공통 판정에 넘긴다.
 *
 * spec의 "분류기 공통 원칙 — 상태 코드가 메시지를 이긴다"를 따른다.
 * status는 HTTP 응답 상태 그 자체이고 메시지 정규식은 그걸 추측하려는 대체 수단이다.
 * 확정이 추측을 이겨야 한다 — 상태가 있는데 메시지로 상태를 다시 정하면
 * 400(토큰 초과)이 quota(503 + Retry-After)로 둔갑해 영구 실패에
 * "잠시 후 다시 시도하세요"를 돌려준다.
 */
export function classifyGeminiFailure(
  error: unknown,
): ExternalFailureKind | null {
  const status = statusOf(error);
  const message = messageOf(error);

  // 상태를 못 읽은 경우에만 메시지 추정으로 내려간다. 상태가 있는데 우리가 그 값을
  // 모르는 것과, 상태 자체가 없는 것은 다른 상황이다 — 전자는 null로 끝낸다.
  return status === null
    ? classifyByMessage(message)
    : classifyByStatus(status, message);
}
