import { classifyQdrantFailure } from './qdrant.errors';

/**
 * Qdrant SDK는 오류 shape이 둘이고 주 경로가 정반대다.
 * 한 shape만 테스트하면 다른 쪽이 통째로 오분류돼도 초록불이 켜진다 —
 * 이 함수에서 가장 큰 위험이라 아래 판정 케이스를 두 벌로 돌린다.
 */

/**
 * 주 경로. 비-2xx 응답이 정상 반환됐을 때 던져진다.
 * status 프로퍼티가 없고 상태 코드도 본문도 message 문자열 안에만 있다.
 * 형식은 QdrantClientUnexpectedResponseError.forResponse와 같다
 * (설치본 1.18.0의 dist/cjs/errors.js:13-24에서 확인).
 */
function unexpectedResponse(
  status: number,
  statusText: string,
  body: unknown,
): Error {
  const error = new Error(
    `Unexpected Response: ${status} (${statusText})\n` +
      `Raw response content:\n${JSON.stringify(body, null, 2)}`,
  );
  error.name = 'QdrantClientUnexpectedResponseError';
  return error;
}

/**
 * 보조 경로. 내부 fetcher(@qdrant/openapi-typescript-fetch)가 던진다.
 * status는 있지만 message는 statusText뿐이고 본문은 data에 있다.
 */
function apiError(status: number, statusText: string, body: unknown): Error {
  return Object.assign(new Error(statusText), {
    status,
    statusText,
    data: body,
  });
}

const SHAPES = [
  {
    label: 'QdrantClientUnexpectedResponseError (주 경로)',
    build: unexpectedResponse,
  },
  { label: 'ApiError (보조 경로)', build: apiError },
];

const DIMENSION_BODY = {
  status: {
    error: 'Wrong input: Vector dimension error: expected dim: 1024, got 3',
  },
};

/** 컬렉션 부재 문구. 3단계 안전망이 찾는 패턴이 여기 들어 있다. */
const NOT_FOUND_BODY = {
  status: { error: "Collection `tour_contents` doesn't exist!" },
};

for (const { label, build } of SHAPES) {
  describe(`classifyQdrantFailure — ${label}`, () => {
    it('404는 not-found다', () => {
      // 빈 배열로 삼키면 "검색 결과 없음"과 화면에서 구분되지 않는다.
      expect(
        classifyQdrantFailure(build(404, 'Not Found', NOT_FOUND_BODY)),
      ).toBe('not-found');
    });

    it('401은 auth다', () => {
      expect(
        classifyQdrantFailure(
          build(401, 'Unauthorized', { status: { error: 'no api key' } }),
        ),
      ).toBe('auth');
    });

    it('403도 auth다', () => {
      expect(
        classifyQdrantFailure(
          build(403, 'Forbidden', { status: { error: 'forbidden' } }),
        ),
      ).toBe('auth');
    });

    it('차원 불일치 400은 dimension-mismatch다', () => {
      expect(
        classifyQdrantFailure(build(400, 'Bad Request', DIMENSION_BODY)),
      ).toBe('dimension-mismatch');
    });

    it('차원과 무관한 400은 invalid-request다', () => {
      // 위 케이스와 짝이다. 400을 통째로 dimension-mismatch로 보내면
      // 우리 코드 문제(500)와 요청 거절(502)이 한 덩어리가 된다.
      const error = build(400, 'Bad Request', {
        status: { error: 'Format error in JSON body: missing field `query`' },
      });
      expect(classifyQdrantFailure(error)).toBe('invalid-request');
    });

    it('500은 upstream이다', () => {
      expect(
        classifyQdrantFailure(
          build(500, 'Internal Server Error', { status: { error: 'boom' } }),
        ),
      ).toBe('upstream');
    });

    it('503도 upstream이다', () => {
      expect(
        classifyQdrantFailure(
          build(503, 'Service Unavailable', { status: { error: 'busy' } }),
        ),
      ).toBe('upstream');
    });

    it('429는 null이다 — quota로 올리지 않는다', () => {
      // Gemini와 다르다. quota로 올리면 SDK가 쥔 실제 retry_after를 실어 나르려고
      // ExternalServiceError에 필드를 더해야 하고, 그건 구조 검증이 금지한
      // 공통 파일 변경이다(spec 미해결 질문 5의 답 A).
      const body = { status: { error: 'slow down' } };
      expect(
        classifyQdrantFailure(build(429, 'Too Many Requests', body)),
      ).toBeNull();

      // 음성 단정이라 "판정에 도달했는가"를 함께 확인한다. 같은 builder가 404에서는
      // not-found를 내므로 위의 null은 상태를 못 읽은 결과가 아니라 실제 결정이다.
      // 이 짝이 없으면 fixture shape이 깨져도 초록불이 켜진다.
      expect(classifyQdrantFailure(build(404, 'Not Found', body))).toBe(
        'not-found',
      );
    });

    /**
     * 아래 네 건이 3단계 골격의 핵심 계약이다 — **상태가 문자열을 이긴다.**
     *
     * 판정을 `classifyByStatus(...) ?? classifyByDetail(...)`로 바꾸면(= spec 초안의
     * "상태 404 **또는** 문자열 not-found" 형태) 위의 케이스는 **전부 그대로 통과한다.**
     * 상태와 본문이 서로 다른 kind를 가리키는 입력이 하나도 없기 때문이다.
     * 그 조합을 여기서 만든다.
     */
    it('400 본문에 컬렉션 부재 문구가 있어도 invalid-request다', () => {
      // spec :870이 지목한 바로 그 위험. 본문이 상태를 뒤집으면
      // 외부의 요청 거절(502)이 우리 설정 오류(500)로 잘못 청구된다.
      expect(
        classifyQdrantFailure(build(400, 'Bad Request', NOT_FOUND_BODY)),
      ).toBe('invalid-request');
    });

    it('500 본문에 컬렉션 부재 문구가 있어도 upstream이다', () => {
      expect(
        classifyQdrantFailure(
          build(500, 'Internal Server Error', NOT_FOUND_BODY),
        ),
      ).toBe('upstream');
    });

    it('5xx 범위를 벗어난 상태는 upstream이 아니라 null이다', () => {
      // status >= 500의 상한(<= 599)을 지킨다. 상한이 없으면 망가진 status가
      // 무엇이든 "외부 서버 오류"로 보고돼, 우리가 상태를 잘못 읽었다는 사실이
      // 정상적인 502에 섞여 사라진다. 모르는 상태는 모른다고 두는 편이 낫다.
      expect(
        classifyQdrantFailure(
          build(600, 'Nonsense', { status: { error: '?' } }),
        ),
      ).toBeNull();
    });

    it('429 본문에 컬렉션 부재 문구가 있어도 null이다', () => {
      // "상태가 있는데 우리가 그 값을 모르는 것"과 "상태 자체가 없는 것"은 다르다.
      // 전자는 null로 끝내고 안전망으로 내려가지 않는다 — 안전망은 상태를 못 읽었을
      // 때의 추측이지, 아는 상태를 덮어쓰는 수단이 아니다.
      expect(
        classifyQdrantFailure(build(429, 'Too Many Requests', NOT_FOUND_BODY)),
      ).toBeNull();
    });

    it('404 본문에 차원 문구가 있어도 not-found다', () => {
      // 차원 판정은 400 **안에서만** 갈래를 가른다. 400 밖으로 새어 나가면
      // 컬렉션 부재(이름 오타)가 차원 불일치로 보고돼 엉뚱한 곳을 고치게 된다.
      expect(
        classifyQdrantFailure(build(404, 'Not Found', DIMENSION_BODY)),
      ).toBe('not-found');
    });
  });
}

describe('classifyQdrantFailure — 1단계는 머리말에서만 상태를 읽는다', () => {
  /**
   * 묶음 B에서 Gemini가 실제로 당한 결함의 Qdrant판이다. 그쪽은 응답 본문의
   * 토큰 수 1429852가 /429/에 걸려 영구 실패(400)가 quota(503)로 둔갑했다.
   * Qdrant는 message에 JSON.stringify(data)를 통째로 이어붙이므로 같은 병에
   * 더 크게 걸린다 — 그래서 머리말의 정해진 위치에서만 파싱한다.
   */
  it('본문에 실린 "Unexpected Response: NNN"을 상태로 읽지 않는다', () => {
    // 머리말이 없는 오류다. ^ 앵커가 없으면 본문 안의 500을 상태로 읽어
    // upstream(502)이 되고, 앵커가 있으면 상태 미상이라 3단계로 내려가
    // 컬렉션 부재를 제대로 집는다. 두 결과가 갈리므로 앵커를 실제로 지킨다.
    const wrapped = new Error(
      'proxy 오류\nRaw response content:\n' +
        '{"detail":"Unexpected Response: 500 (Internal Server Error)",' +
        '"hint":"Collection `tour_contents` doesn\'t exist!"}',
    );
    expect(classifyQdrantFailure(wrapped)).toBe('not-found');
  });

  it('머리말의 숫자가 세 자리가 아니면 상태로 읽지 않는다', () => {
    // \b가 없으면 4041에서 404를 떼어 not-found(500)로 판정한다.
    // 상태를 못 읽었다고 인정하는 편이 잘못된 상태를 단언하는 것보다 낫다.
    const weird = new Error(
      'Unexpected Response: 4041 (Nonsense)\nRaw response content:\n{}',
    );
    weird.name = 'QdrantClientUnexpectedResponseError';
    expect(classifyQdrantFailure(weird)).toBeNull();
  });

  it('본문에 실린 세 자리 숫자를 상태로 읽지 않는다', () => {
    // 머리말은 400인데 본문에 403·404가 섞여 있다. 머리말 밖을 보는 순간
    // 판정이 본문이 실어 나르는 임의의 숫자에 좌우된다.
    const error = unexpectedResponse(400, 'Bad Request', {
      status: { error: 'codes seen: 403, 404, 500 while validating' },
    });
    expect(classifyQdrantFailure(error)).toBe('invalid-request');
  });
});

describe('classifyQdrantFailure — shape과 무관한 케이스', () => {
  it('QdrantClientTimeoutError는 timeout이다', () => {
    // SDK가 fetch의 AbortError를 자기 타입으로 바꿔 다시 던지므로
    // (api-client.js:31-35) classifyCommonFailure의 이름 판정에 걸리지 않는다.
    // 여기서 잡지 않으면 "Qdrant 5초 초과 → 504"가 조용히 502가 된다.
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'QdrantClientTimeoutError',
    });
    expect(classifyQdrantFailure(error)).toBe('timeout');
  });

  it('타임아웃 판정이 상태·본문보다 먼저다', () => {
    // 위 케이스는 상태도 본문도 없어서 "이름 판정이 먼저인가"를 주장하지 못한다.
    // 순서를 주장하려면 두 조건이 한 입력에 있어야 한다.
    const error = Object.assign(
      new Error(
        'Unexpected Response: 500 (Internal Server Error)\n' +
          'Raw response content:\n{"status":{"error":"boom"}}',
      ),
      { name: 'QdrantClientTimeoutError' },
    );
    expect(classifyQdrantFailure(error)).toBe('timeout');
  });

  it('QdrantClientResourceExhaustedError도 null이다', () => {
    // 우연한 fall-through가 아니라 의도적 낙하임을 이름으로 못 박는다.
    // 이건 "구현 라인을 지키는" 테스트가 아니라 결정을 고정하는 테스트다 —
    // 누가 quota 분기를 새로 넣으면 빨간불이 된다(삭제가 아니라 추가를 잡는다).
    const error = Object.assign(new Error('Too Many Requests'), {
      name: 'QdrantClientResourceExhaustedError',
      retry_after: 30,
    });
    expect(classifyQdrantFailure(error)).toBeNull();
  });

  it('상태 코드를 못 읽어도 메시지에 not found가 있으면 not-found다', () => {
    // core의 isCollectionNotFound(core/src/clients/qdrant.ts:8-14)와 같은 안전망이다.
    expect(
      classifyQdrantFailure(
        new Error("Collection `tour_contents` doesn't exist!"),
      ),
    ).toBe('not-found');
  });

  it('does not exist 표기도 not-found다', () => {
    expect(
      classifyQdrantFailure(
        new Error('Collection tour_contents does not exist'),
      ),
    ).toBe('not-found');
  });

  it('차원 문구가 메시지에서 잘려 나가면 invalid-request로 떨어진다', () => {
    // 판정이 문자열에만 의존한다는 사실을 고정한다. SDK가 본문을 줄여 보내
    // "dimension"이 사라지면 500이 아니라 502가 된다 — 열화 방향을 알고 있어야
    // 실측에서 dimension-mismatch가 안 나올 때 원인을 찾을 수 있다.
    const truncated = new Error(
      'Unexpected Response: 400 (Bad Request)\nRaw response content:\n{\n  "status": {\n    "error": "Wrong input: Vector ...',
    );
    truncated.name = 'QdrantClientUnexpectedResponseError';
    expect(classifyQdrantFailure(truncated)).toBe('invalid-request');
  });

  it('상태를 못 읽고 차원 문구만 있으면 null이다', () => {
    // 3단계 안전망은 컬렉션 부재만 본다. 차원 판정까지 문자열로 추측하면
    // 오분류 표면이 넓어진다(spec :862 "그 외 → null").
    expect(
      classifyQdrantFailure(
        new Error('Vector dimension error: expected dim: 1024'),
      ),
    ).toBeNull();
  });

  it('data가 순환 참조여도 던지지 않는다', () => {
    // 분류기가 던지면 callExternal이 막아 주지만 그 호출의 kind는 upstream으로
    // 떨어진다. 최후 방어선을 쓰게 만들지 않는다.
    const circular: Record<string, unknown> = { status: 'nope' };
    circular.self = circular;
    const error = Object.assign(new Error('Not Found'), {
      status: 404,
      data: circular,
    });

    expect(classifyQdrantFailure(error)).toBe('not-found');
  });

  it('모르는 오류·비-Error 값에는 null을 반환하고 던지지 않는다', () => {
    expect(classifyQdrantFailure(new Error('그냥 오류'))).toBeNull();
    expect(classifyQdrantFailure(null)).toBeNull();
    expect(classifyQdrantFailure(undefined)).toBeNull();
    expect(classifyQdrantFailure('문자열')).toBeNull();
    expect(classifyQdrantFailure(42)).toBeNull();
  });

  it('문자열 입력의 내용도 안전망이 읽는다', () => {
    // 위 케이스의 '문자열'은 null이라 messageOf의 문자열 분기를 지워도 통과한다.
    // 분기가 실제로 동작하는지 보려면 패턴에 걸리는 문자열을 넣어야 한다.
    expect(classifyQdrantFailure("Collection `x` doesn't exist!")).toBe(
      'not-found',
    );
  });

  it('ECONNREFUSED를 자기 것으로 판정하지 않는다', () => {
    // 네트워크 단절은 공통 판정의 몫이다. 여기서 잡으면 같은 실패가 두 곳에서 분류된다.
    const error = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    expect(classifyQdrantFailure(error)).toBeNull();
  });

  it('status가 숫자가 아니면 상태로 읽지 않는다', () => {
    // 문자열 '404'를 상태로 받아들이면 타입 가드가 없는 것과 같다.
    // 가드를 지우면 '404' >= 500이 false라 upstream도 아니고 404 비교도
    // 엄격 동치라 실패하므로, 결과가 갈리는 값(문자열 '500')을 넣는다.
    const error = Object.assign(new Error('이상한 오류'), { status: '500' });
    expect(classifyQdrantFailure(error)).toBeNull();
  });
});
