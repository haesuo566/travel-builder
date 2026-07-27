import { runInNewContext } from 'vm';

import { classifyGeminiFailure } from './gemini.errors';

/**
 * 에러 처리 표의 Gemini 행마다 판정 1건씩.
 * 마지막 케이스(모르는 오류 → null)가 공통 판정으로 넘어가는 경로를 지킨다.
 *
 * 규칙별 fixture만으로는 부족하다 — spec의 "분류기 공통 원칙"(3단계)은 규칙 하나가
 * 아니라 규칙 사이의 우선순위를 정한 것이라, 한 fixture가 한 규칙에만 걸리면
 * 순서가 통째로 뒤집혀도 아무도 모른다. 아래 describe 셋이 그 경계를 잡는다.
 */

function apiError(status: number, message = '오류'): Error {
  return Object.assign(new Error(message), { status });
}

/** 실제로 결함이 났던 응답 본문. 토큰 수 1429852 안에 429가 들어 있다. */
const TOKEN_LIMIT_BODY =
  '{"error":{"code":400,"message":"The input token count (1429852) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}';

/** 5xx 본문에 quota라는 단어가 흔히 섞여 들어온다. */
const QUOTA_SERVICE_BODY =
  '{"error":{"code":500,"message":"Internal error encountered while checking quota service.","status":"INTERNAL"}}';

describe('classifyGeminiFailure', () => {
  it('429는 quota다', () => {
    expect(classifyGeminiFailure(apiError(429))).toBe('quota');
  });

  it('RESOURCE_EXHAUSTED 메시지도 quota다', () => {
    expect(
      classifyGeminiFailure(new Error('RESOURCE_EXHAUSTED: 할당량 초과')),
    ).toBe('quota');
  });

  it('401은 auth다', () => {
    expect(classifyGeminiFailure(apiError(401))).toBe('auth');
  });

  it('403은 auth다', () => {
    expect(classifyGeminiFailure(apiError(403))).toBe('auth');
  });

  it('API key 메시지도 auth다', () => {
    expect(classifyGeminiFailure(new Error('API key not valid'))).toBe('auth');
  });

  it('400은 invalid-request다', () => {
    expect(classifyGeminiFailure(apiError(400))).toBe('invalid-request');
  });

  it('INVALID_ARGUMENT 메시지도 invalid-request다', () => {
    expect(
      classifyGeminiFailure(new Error('INVALID_ARGUMENT: 잘못된 모델')),
    ).toBe('invalid-request');
  });

  it('404는 not-found다', () => {
    // GEMINI_MODEL 오타(gemini-2.5-flesh)나 미배포 모델 지정이 여기로 온다.
    // Gemini는 멀쩡하고 틀린 것은 우리 .env이므로 외부 사정(502)이 아니라
    // 우리 설정(500)이다 — Qdrant가 컬렉션 이름 오타를 끊는 것과 같은 kind다.
    expect(classifyGeminiFailure(apiError(404))).toBe('not-found');
  });

  it('500은 upstream이다', () => {
    expect(classifyGeminiFailure(apiError(500))).toBe('upstream');
  });

  it('503도 upstream이다', () => {
    expect(classifyGeminiFailure(apiError(503))).toBe('upstream');
  });

  it('모르는 오류에는 null을 반환한다', () => {
    // 이 케이스가 없으면 공통 판정으로 넘어가는 경로가 죽어도 아무도 모른다.
    expect(classifyGeminiFailure(new Error('그냥 오류'))).toBeNull();
    expect(classifyGeminiFailure('문자열')).toBeNull();
    expect(classifyGeminiFailure(null)).toBeNull();
  });

  it('status가 없고 code에 숫자가 있으면 그것을 상태로 읽는다', () => {
    // 스트리밍 경로는 HTTP 상태가 아니라 응답 본문의 code로 ApiError를 만든다.
    // 이 분기가 없으면 그 경로의 오류가 전부 상태 없는 것으로 취급된다.
    expect(classifyGeminiFailure({ code: 429, message: '오류' })).toBe('quota');
    expect(classifyGeminiFailure({ code: 404, message: '오류' })).toBe(
      'not-found',
    );
  });

  it('code가 숫자가 아니면 상태로 읽지 않는다', () => {
    // Node의 시스템 오류는 code에 'ECONNREFUSED' 같은 문자열을 담는다. 타입 확인 없이
    // 상태로 읽으면 문자열 '503'이 비교 연산에서 숫자로 강제 변환돼 네트워크 단절이
    // Gemini의 5xx 응답으로 둔갑한다 — 숫자 문자열이라야 이 실수가 드러난다.
    expect(classifyGeminiFailure({ code: '503', message: '오류' })).toBeNull();
    expect(
      classifyGeminiFailure({ code: 'ECONNREFUSED', message: '연결 거부' }),
    ).toBeNull();
  });

  it('문자열을 던진 경우 그 문자열을 메시지로 읽는다', () => {
    // 3단계 판정이 살아 있는지. null만 확인하면 ''를 반환하는 구현과 구별되지 않는다.
    expect(classifyGeminiFailure('RESOURCE_EXHAUSTED: 할당량 초과')).toBe(
      'quota',
    );
  });

  it('message가 문자열이 아니면 빈 메시지로 취급한다', () => {
    // 문자열이 아닌 message를 String()으로 밀어 넣으면 배열·객체 안의 값이
    // 정규식에 노출된다. G-1과 같은 종류의 실수라 배열로 확인한다 —
    // String(['API key not valid'])는 따옴표 없이 그대로 매칭된다.
    expect(
      classifyGeminiFailure({ message: ['API key not valid'] }),
    ).toBeNull();
  });

  it('AbortError를 자기 것으로 판정하지 않는다', () => {
    // 중단은 공통 판정의 몫이다. 여기서 잡으면 같은 실패가 두 곳에서 분류된다.
    const aborted = Object.assign(new Error('중단됨'), { name: 'AbortError' });
    expect(classifyGeminiFailure(aborted)).toBeNull();
  });

  it('다른 realm에서 만들어진 오류의 메시지도 읽는다', () => {
    // jest는 각 테스트 파일을 vm 샌드박스에서 돌리고, SDK가 내부에서 쓰는 fetch의
    // 실패는 Node 내부(undici)가 호스트 realm에서 만든다. message는 멀쩡한데
    // instanceof Error만 어긋나므로, instanceof로 메시지를 꺼내면 상태 코드가 없는
    // 오류가 전부 판정 없이 빠져나간다. 판정은 덕 타이핑이어야 한다.
    const foreign: unknown = runInNewContext(
      'new Error("API key not valid")',
    ) as unknown;
    expect(foreign instanceof Error).toBe(false);

    expect(classifyGeminiFailure(foreign)).toBe('auth');
  });
});

describe('classifyGeminiFailure — 1단계: 상태가 메시지를 이긴다', () => {
  /**
   * SDK의 message는 사람이 읽는 문구가 아니라 응답 본문 전문이다
   * (@google/genai의 throwErrorIfNotOK가 JSON.stringify(errorBody)를 넣는다).
   * 정규식이 code·details·도움말 URL·Google이 실어 보내는 임의의 숫자를 전부 훑으므로,
   * 상태가 있는데도 메시지로 상태를 추측하면 확정 정보를 버리는 셈이 된다.
   */

  it('status가 400이면 본문에 429가 들어 있어도 invalid-request다', () => {
    // 프롬프트가 길어서 생긴 영구 실패다. quota로 판정하면 503 + Retry-After가 나가
    // 정상 429와 응답이 바이트 단위로 같아지고, 클라이언트는 영원히 재시도한다.
    expect(classifyGeminiFailure(apiError(400, TOKEN_LIMIT_BODY))).toBe(
      'invalid-request',
    );
  });

  it('status가 500이면 본문에 quota가 들어 있어도 upstream이다', () => {
    expect(classifyGeminiFailure(apiError(500, QUOTA_SERVICE_BODY))).toBe(
      'upstream',
    );
  });

  it('판정할 수 없는 상태가 있으면 메시지 추정으로 내려가지 않는다', () => {
    // 3단계는 상태를 끝내 확정하지 못했을 때의 안전망이다. 상태가 있는데
    // 우리가 그 값을 모른다는 것과, 상태 자체가 없다는 것은 다른 상황이다.
    expect(
      classifyGeminiFailure(apiError(302, 'RESOURCE_EXHAUSTED')),
    ).toBeNull();
  });

  /**
   * 위 셋은 메시지가 "잘못된 kind"를 가리키는 경우이고, 아래 둘은 메시지가
   * "다른 kind"를 가리키는 경우다. 패턴을 좁히고 나면 전자는 대부분 사라지지만
   * 후자는 남는다 — 3단계 패턴이 아무리 좁아도 429 본문에 "API key"가 들어 있는 것을
   * 막을 수는 없다. 두 규칙이 같은 fixture에 동시에 걸려야 순서를 검증할 수 있다.
   */

  it('429 본문에 API key가 들어 있어도 auth가 아니라 quota다', () => {
    // 실제 Gemini의 429 본문은 소비자를 api_key로 지칭한다.
    const error = apiError(
      429,
      '{"error":{"code":429,"message":"Requests from this API key have exceeded the configured limit."}}',
    );
    expect(classifyGeminiFailure(error)).toBe('quota');
  });

  it('500 본문에 API key가 들어 있어도 auth가 아니라 upstream이다', () => {
    // auth는 500(우리 설정), upstream은 502(외부 사정)로 책임 귀속이 갈린다.
    const error = apiError(
      500,
      '{"error":{"code":500,"message":"Internal error while validating API key.","status":"INTERNAL"}}',
    );
    expect(classifyGeminiFailure(error)).toBe('upstream');
  });
});

describe('classifyGeminiFailure — 2단계: 확정된 상태 안에서 세부를 가른다', () => {
  it('400 + API key not valid는 auth다', () => {
    // 실제 Gemini는 무효한 키에 401이 아니라 400을 낸다. 여기서 메시지는 상태를
    // 뒤집는 게 아니라 400 안에서 auth와 invalid-request를 가른다 —
    // 이 분기가 죽으면 만료된 키가 invalid-request(502)로 잘못 청구된다.
    const error = apiError(
      400,
      '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
    );
    expect(classifyGeminiFailure(error)).toBe('auth');
  });

  it('400 + PERMISSION_DENIED도 auth다', () => {
    expect(classifyGeminiFailure(apiError(400, 'PERMISSION_DENIED'))).toBe(
      'auth',
    );
  });
});

describe('classifyGeminiFailure — 3단계: 상태가 없을 때만 메시지로 추정한다', () => {
  it('rate limit 메시지는 quota다', () => {
    expect(classifyGeminiFailure(new Error('rate limit exceeded'))).toBe(
      'quota',
    );
  });

  it('quota exceeded 메시지는 quota다', () => {
    expect(classifyGeminiFailure(new Error('Quota exceeded for model'))).toBe(
      'quota',
    );
  });

  it('is not found for API version 메시지는 not-found다', () => {
    // 스트리밍 경로는 HTTP 상태가 아니라 응답 본문의 code로 ApiError를 만든다.
    // 상태를 못 읽는 경우가 있어 3단계에도 같은 판정을 둔다.
    const error = new Error(
      'models/gemini-2.5-flesh is not found for API version v1beta',
    );
    expect(classifyGeminiFailure(error)).toBe('not-found');
  });

  it('NOT_FOUND와 INVALID_ARGUMENT가 함께 있으면 not-found가 이긴다', () => {
    // 두 토큰이 한 본문에 실린 입력이 3단계의 순서를 관찰할 수 있는 유일한
    // 형태다. spec이 not-found를 invalid-request보다 위에 둔 이유는
    // 모델명 오설정(우리 설정, 500)이 외부의 요청 거절(502)로 새면
    // 응답을 받은 사람이 Gemini 장애를 의심하기 때문이다.
    const error = new Error(
      '{"error":{"message":"models/gemini-2.5-flesh is not found for API version v1beta","status":"NOT_FOUND","details":[{"reason":"INVALID_ARGUMENT"}]}}',
    );
    expect(classifyGeminiFailure(error)).toBe('not-found');
  });

  it('PERMISSION_DENIED 메시지는 auth다', () => {
    expect(
      classifyGeminiFailure(new Error('PERMISSION_DENIED: 권한 없음')),
    ).toBe('auth');
  });

  it('메시지에 429라는 숫자만 있으면 quota가 아니다', () => {
    // core의 isRateLimited(/429|rate limit|RESOURCE_EXHAUSTED|quota/i)를 그대로
    // 복사하면 이 케이스가 깨진다. 3단계는 이미 추측 경로이므로 오분류 표면이
    // 좁은 토큰만 남긴다.
    const error = new Error(
      'The input token count (1429852) exceeds the maximum number of tokens allowed (1048576).',
    );
    expect(classifyGeminiFailure(error)).toBeNull();
  });

  it('메시지에 quota라는 단어만 있으면 quota가 아니다', () => {
    const error = new Error(
      'Internal error encountered while checking quota service.',
    );
    expect(classifyGeminiFailure(error)).toBeNull();
  });
});
