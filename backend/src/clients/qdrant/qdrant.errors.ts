import { ExternalFailureKind } from '../external-service.error';

/**
 * 1단계에서만 쓴다. 주 경로 오류(QdrantClientUnexpectedResponseError)는 상태 코드를
 * 프로퍼티가 아니라 message **머리말**에 담는다: "Unexpected Response: 404 (Not Found)".
 *
 * ^ 앵커가 이 규칙의 핵심이다. SDK는 머리말 뒤에 응답 본문을 JSON.stringify로
 * 통째로 이어붙이므로(errors.js:13-24), 앵커 없이 아무 데서나 세 자리 숫자를 찾으면
 * 본문이 실어 나르는 임의의 숫자를 상태로 읽는다 — 묶음 B에서 Gemini가 토큰 수
 * 1429852의 429에 걸려 영구 실패를 quota(503 + Retry-After)로 둔갑시킨 것과 같은 병이다.
 * \b는 "4041"에서 404를 떼어내지 않게 한다. 상태를 못 읽었다고 인정하는 편이
 * 잘못된 상태를 단언하는 것보다 낫다 — 못 읽으면 3단계 안전망이 받는다.
 */
const STATUS_IN_MESSAGE_HEAD = /^Unexpected Response:\s*(\d{3})\b/;

/** core의 isCollectionNotFound(core/src/clients/qdrant.ts:8-14)와 같은 규칙이다. */
const NOT_FOUND_PATTERN = /not found|doesn't exist|does not exist/i;

/** Qdrant는 "Wrong input: Vector dimension error: expected dim: 1024, got 3"을 낸다. */
const DIMENSION_PATTERN = /dimension|expected dim/i;

function nameOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as { name?: unknown };
  return typeof record.name === 'string' ? record.name : '';
}

/**
 * instanceof를 쓰지 않는다. SDK 내부의 fetch 실패는 Node(undici)가 호스트 realm에서
 * 만들고 jest는 테스트를 자기 realm의 vm 샌드박스에서 돌린다 — message는 멀쩡한데
 * instanceof Error만 어긋난다(call-external.ts의 causeMessage와 같은 이유).
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

function stringifyData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    // 순환 참조. 분류기는 절대 던지지 않는다 — 던지면 이 호출의 kind가
    // upstream으로 떨어져 상태에서 이미 얻은 정보까지 함께 버려진다.
    return '';
  }
}

/**
 * 1단계 — 상태 코드를 두 곳에서 찾는다. **본문은 보지 않는다.**
 *
 * ApiError는 status 프로퍼티를 갖지만, 주 경로인 QdrantClientUnexpectedResponseError는
 * 갖지 않는다. 프로퍼티만 보면 실제 운영에서 오는 오류의 대부분이 "상태 미상"이 되고
 * 전부 upstream(502)으로 떨어진다 — not-found도 dimension-mismatch도 나오지 않는다.
 */
function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const record = error as { status?: unknown };
    if (typeof record.status === 'number') return record.status;
  }
  const matched = STATUS_IN_MESSAGE_HEAD.exec(messageOf(error));
  return matched === null ? null : Number(matched[1]);
}

/**
 * 2·3단계가 함께 보는 검색 문자열. 두 shape이 응답 본문을 서로 다른 곳에 넣으므로
 * 이어붙인다 — UnexpectedResponse는 message에, ApiError는 data에 담는다.
 */
function detailOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return messageOf(error);
  }
  const record = error as { data?: unknown };
  return `${messageOf(error)} ${stringifyData(record.data)}`;
}

/**
 * 2단계 — 확정된 상태 **안에서** 세부를 가른다. 본문은 상태를 뒤집지 못한다.
 *
 * 400에서만 본문을 보는 이유: Qdrant는 차원 불일치도 형식 오류도 400으로 낸다.
 * 전자는 우리 코드/설정 문제(500)이고 후자는 요청 거절(502)이라 청구 대상이 다르다.
 * 차원 판정을 400 밖으로 꺼내면 컬렉션 부재(404)가 차원 불일치로 보고돼
 * 엉뚱한 곳을 고치게 된다.
 *
 * 429는 어느 분기에도 없어 null로 떨어진다 — 의도된 낙하다.
 * quota로 올리려면 SDK가 쥔 실제 retry_after를 실어 나르도록 ExternalServiceError를
 * 바꿔야 하고, 그건 구조 검증이 금지한 공통 파일 변경이다(spec 미해결 질문 5의 답 A).
 */
function classifyByStatus(
  status: number,
  detail: string,
): ExternalFailureKind | null {
  if (status === 404) return 'not-found';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400) {
    return DIMENSION_PATTERN.test(detail)
      ? 'dimension-mismatch'
      : 'invalid-request';
  }
  if (status >= 500 && status <= 599) return 'upstream';
  return null;
}

/**
 * 3단계 — 상태를 끝내 확정하지 못했을 때만 쓰는 안전망.
 *
 * core가 isCollectionNotFound에 남긴 주석("SDK 버전에 따라 status를 노출하지 않는
 * 경우가 있어 메시지도 함께 본다")이 정확히 이 자리다. 컬렉션 부재만 본다 —
 * 다른 kind까지 문자열로 추측하면 오분류 표면이 넓어진다.
 */
function classifyByDetail(detail: string): ExternalFailureKind | null {
  if (NOT_FOUND_PATTERN.test(detail)) return 'not-found';
  return null;
}

/**
 * Qdrant SDK 오류를 kind로 판정한다. 모르는 오류에는 null을 반환해 공통 판정에 넘긴다.
 * 절대 던지지 않는다 — callExternal이 분류기 예외를 막아 주지만 그건 최후 방어선이고,
 * 던지는 순간 이 호출의 kind는 upstream으로 떨어진다.
 *
 * gemini.errors.ts와 같은 3단계 골격이다: 상태 추출 → 상태 안에서 세부 → 상태를
 * 못 읽었을 때만 문자열 추정. **확정이 추측을 이긴다.**
 */
export function classifyQdrantFailure(
  error: unknown,
): ExternalFailureKind | null {
  // 상태 코드가 없는 실패라 3단계 골격 밖에서 먼저 본다.
  // SDK가 fetch의 AbortError를 자기 타입으로 바꿔 다시 던지므로(api-client.js:31-35)
  // classifyCommonFailure의 이름 판정에 걸리지 않는다. 여기서 잡지 않으면
  // 에러 표의 "Qdrant 5초 초과 → 504"가 조용히 502가 된다.
  if (nameOf(error) === 'QdrantClientTimeoutError') return 'timeout';

  const status = statusOf(error);
  const detail = detailOf(error);

  // 상태를 못 읽은 경우에만 문자열 추정으로 내려간다. 상태가 있는데 우리가 그 값을
  // 모르는 것(429)과, 상태 자체가 없는 것은 다른 상황이다 — 전자는 null로 끝낸다.
  // ?? 로 이어 붙이면 400 본문의 "doesn't exist"가 400을 not-found로 뒤집는다.
  return status === null
    ? classifyByDetail(detail)
    : classifyByStatus(status, detail);
}
