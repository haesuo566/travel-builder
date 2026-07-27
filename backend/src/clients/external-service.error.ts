/**
 * 외부 서비스 식별자.
 * 클라이언트를 추가할 때 이 유니온에 리터럴 한 줄을 더하는 것 외에는
 * 공통 파일(call-external.ts · external-service.filter.ts)이 바뀌지 않아야 한다.
 */
export type ExternalService = 'gemini' | 'qdrant' | 'tei';

/**
 * 실패의 책임 귀속을 타입으로 강제한다.
 * 우리 설정/코드 문제와 외부 서비스 사정을 같은 값으로 표현하지 않는다.
 */
export type ExternalFailureKind =
  // 우리 설정·코드의 문제 → 500
  | 'auth' // 키가 없거나 무효
  | 'not-found' // 컬렉션 이름이 틀림
  | 'dimension-mismatch' // 질의 벡터 차원이 컬렉션과 다름
  // 외부 서비스 사정 → 502/503/504
  | 'quota' // 429 / RESOURCE_EXHAUSTED
  | 'unavailable' // 연결 거부·DNS 실패
  | 'timeout'
  | 'upstream' // 5xx 및 분류되지 않은 실패
  | 'invalid-request' // 외부가 우리 요청을 400으로 거절
  | 'empty-response'; // 200인데 쓸 내용이 없음

/**
 * 외부 호출 실패. service와 kind만으로 HTTP 상태와 로그 레벨이 결정된다.
 * 서비스마다 쓰는 kind가 다른 것은 결함이 아니다 — 이 타입은 서비스별 API가 아니라
 * 책임 귀속의 어휘다.
 */
export class ExternalServiceError extends Error {
  readonly service: ExternalService;
  readonly kind: ExternalFailureKind;

  constructor(
    service: ExternalService,
    kind: ExternalFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ExternalServiceError';
    this.service = service;
    this.kind = kind;
  }
}
