import { Logger } from '@nestjs/common';

import { callExternal, classifyCommonFailure } from './call-external';
import { ExternalServiceError } from './external-service.error';

/**
 * 외부 호출의 유일한 통로를 고정한다. 여기서 분류가 무너지면
 * 아래 세 클라이언트의 실패가 전부 upstream 한 덩어리가 된다.
 */

/** 실제 Gemini 키와 같은 형태(AIza + 35자). 로그에 이 문자열이 남으면 안 된다. */
const FAKE_API_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';

const alwaysNull = (): null => null;

/**
 * 로그 호출들의 메시지.
 * jest.SpyInstance의 mock.calls 원소는 any로 추론돼 no-unsafe-member-access에 걸린다.
 * unknown을 거쳐 좁힌다.
 */
function allLogMessages(spy: jest.SpyInstance): string[] {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls.map((args) => String(args[0]));
}

function firstLogMessage(spy: jest.SpyInstance): string {
  return allLogMessages(spy)[0];
}

/** spec이 앞으로 만들 classifier들은 unknown을 좁히지 않고 프로퍼티를 탄다 — 즉 던질 수 있다. */
const throwingClassifier = (): never => {
  throw new TypeError("Cannot read properties of undefined (reading 'status')");
};

describe('classifyCommonFailure', () => {
  it('AbortError를 timeout으로 판정한다', () => {
    const error = Object.assign(new Error('중단됨'), { name: 'AbortError' });
    expect(classifyCommonFailure(error)).toBe('timeout');
  });

  it('TimeoutError를 timeout으로 판정한다', () => {
    const error = Object.assign(new Error('시간 초과'), {
      name: 'TimeoutError',
    });
    expect(classifyCommonFailure(error)).toBe('timeout');
  });

  it('ECONNREFUSED를 unavailable로 판정한다', () => {
    const error = Object.assign(new Error('연결 거부'), {
      code: 'ECONNREFUSED',
    });
    expect(classifyCommonFailure(error)).toBe('unavailable');
  });

  it('ENOTFOUND를 unavailable로 판정한다', () => {
    const error = Object.assign(new Error('DNS 실패'), { code: 'ENOTFOUND' });
    expect(classifyCommonFailure(error)).toBe('unavailable');
  });

  it('cause에 숨은 ECONNREFUSED도 판정한다', () => {
    // Node의 fetch는 ECONNREFUSED를 TypeError: fetch failed의 cause에 넣는다.
    // 이 케이스가 없으면 TEI를 붙일 때 이 함수를 고쳐야 한다.
    const inner = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const outer = new TypeError('fetch failed', { cause: inner });
    expect(classifyCommonFailure(outer)).toBe('unavailable');
  });

  it('모르는 오류에는 null을 반환한다', () => {
    expect(classifyCommonFailure(new Error('그냥 오류'))).toBeNull();
  });
});

describe('callExternal', () => {
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('성공하면 값을 그대로 반환하고 감싸지 않는다', async () => {
    const value = { hits: 3 };
    await expect(
      callExternal('qdrant', 'query', alwaysNull, () => Promise.resolve(value)),
    ).resolves.toBe(value);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('실패를 ExternalServiceError로 감싸고 service·kind를 채운다', async () => {
    const failure = await callExternal(
      'gemini',
      'generateContent',
      alwaysNull,
      () => Promise.reject(new Error('무슨 일인가 났다')),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExternalServiceError);
    const external = failure as ExternalServiceError;
    expect(external.service).toBe('gemini');
    expect(external.kind).toBe('upstream');
    expect(external.cause).toBeInstanceOf(Error);
  });

  it('이미 ExternalServiceError면 다시 감싸지 않는다', async () => {
    // 안쪽에서 정확히 분류한 kind가 바깥에서 upstream으로 덮이면 분류가 무의미해진다.
    const original = new ExternalServiceError(
      'gemini',
      'empty-response',
      '빈 응답',
    );
    const failure = await callExternal(
      'gemini',
      'generateContent',
      alwaysNull,
      () => Promise.reject(original),
    ).catch((error: unknown) => error);

    expect(failure).toBe(original);
    expect((failure as ExternalServiceError).kind).toBe('empty-response');
  });

  it('classify가 판정하면 그 kind를 쓴다', async () => {
    const failure = await callExternal(
      'gemini',
      'generateContent',
      () => 'quota',
      () => Promise.reject(new Error('429')),
    ).catch((error: unknown) => error);

    expect((failure as ExternalServiceError).kind).toBe('quota');
  });

  it('classify가 null이면 공통 판정으로 넘어간다', async () => {
    const aborted = Object.assign(new Error('중단됨'), { name: 'AbortError' });
    const failure = await callExternal(
      'gemini',
      'generateContent',
      alwaysNull,
      () => Promise.reject(aborted),
    ).catch((error: unknown) => error);

    expect((failure as ExternalServiceError).kind).toBe('timeout');
  });

  it('둘 다 판정하지 못하면 upstream이다', async () => {
    const failure = await callExternal('qdrant', 'query', alwaysNull, () =>
      Promise.reject(new Error('정체불명')),
    ).catch((error: unknown) => error);

    expect((failure as ExternalServiceError).kind).toBe('upstream');
  });

  /**
   * 분류기는 호출자가 주입하는 임의 콜백이고 catch 안에서 불린다.
   * 무방비로 두면 던지는 순간 원본 오류가 소멸하고 로그도 남지 않으며
   * @Catch(ExternalServiceError)에도 걸리지 않아 무로그 500이 된다.
   * 단일 통로가 통째로 뚫리므로 통로 쪽에서 막는다.
   */
  it('classify가 던져도 ExternalServiceError로 감싸고 원본을 cause에 남긴다', async () => {
    const original = new Error('원본 실패');
    const failure = await callExternal(
      'qdrant',
      'query',
      throwingClassifier,
      () => Promise.reject(original),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExternalServiceError);
    const external = failure as ExternalServiceError;
    expect(external.kind).toBe('upstream');
    // 분류기의 TypeError가 아니라 원본이 cause여야 한다.
    expect(external.cause).toBe(original);
  });

  it('classify가 던져도 공통 판정은 계속 동작한다', async () => {
    // 분류기 예외를 upstream으로 고정해 버리면 timeout·unavailable 판정이 함께 죽는다.
    const aborted = Object.assign(new Error('중단됨'), { name: 'AbortError' });
    const failure = await callExternal(
      'qdrant',
      'query',
      throwingClassifier,
      () => Promise.reject(aborted),
    ).catch((error: unknown) => error);

    expect((failure as ExternalServiceError).kind).toBe('timeout');
  });

  it('분류기가 던진 사실이 별도 로그로 남는다', async () => {
    // 삼키기만 하면 분류기 버그가 영원히 보이지 않는다.
    await callExternal('qdrant', 'query', throwingClassifier, () =>
      Promise.reject(new Error('원본 실패')),
    ).catch(() => undefined);

    const logs = allLogMessages(errorLog);
    expect(logs.some((line) => line.includes('분류기'))).toBe(true);
    // 원인 실패 자체의 로그도 사라지지 않는다.
    expect(logs.some((line) => line.includes('원본 실패'))).toBe(true);
  });

  it('분류기 예외 로그에도 마스킹이 걸린다', async () => {
    const leakyClassifier = (): never => {
      throw new Error('분류 실패: ?api-key=classifier-secret-9');
    };
    await callExternal('qdrant', 'query', leakyClassifier, () =>
      Promise.reject(new Error('원본 실패')),
    ).catch(() => undefined);

    expect(allLogMessages(errorLog).join('\n')).not.toContain(
      'classifier-secret-9',
    );
  });

  it('quota는 warn으로, 나머지는 error로 남긴다', async () => {
    await callExternal(
      'gemini',
      'generateContent',
      () => 'quota',
      () => Promise.reject(new Error('쿼터 소진')),
    ).catch(() => undefined);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();

    await callExternal(
      'gemini',
      'generateContent',
      () => 'auth',
      () => Promise.reject(new Error('키 무효')),
    ).catch(() => undefined);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('로그에 service·operation·kind가 모두 들어간다', async () => {
    await callExternal(
      'qdrant',
      'query(tour_contents)',
      () => 'not-found',
      () => Promise.reject(new Error('컬렉션 없음')),
    ).catch(() => undefined);

    const logged = firstLogMessage(errorLog);
    expect(logged).toContain('qdrant');
    expect(logged).toContain('query(tour_contents)');
    expect(logged).toContain('not-found');
  });

  it('로그에 API 키 문자열이 남지 않는다', async () => {
    const leaky = new Error(
      `요청 실패: https://generativelanguage.googleapis.com/v1beta/models?key=${FAKE_API_KEY}`,
    );
    await callExternal('gemini', 'generateContent', alwaysNull, () =>
      Promise.reject(leaky),
    ).catch(() => undefined);

    const logged = firstLogMessage(errorLog);
    expect(logged).not.toContain(FAKE_API_KEY);
    // 원인이 무엇이었는지는 남아야 한다 — 마스킹이 로그를 통째로 지우면 안 된다.
    expect(logged).toContain('요청 실패');
  });

  it('Bearer 토큰도 가린다', async () => {
    const leaky = new Error(
      '인증 거부: Authorization: Bearer sk-live-abcdef123456',
    );
    await callExternal('gemini', 'generateContent', alwaysNull, () =>
      Promise.reject(leaky),
    ).catch(() => undefined);

    const logged = firstLogMessage(errorLog);
    expect(logged).not.toContain('sk-live-abcdef123456');
  });

  /**
   * 쿼리 파라미터 마스킹 규칙.
   * 값에 일부러 `AIza`를 넣지 않는다 — 넣으면 Gemini 키 규칙이 먼저 가려버려
   * 이 규칙이 일할 기회가 없고, 규칙을 통째로 지워도 테스트가 통과한다.
   * Google 형식이 아닌 자격증명(관리형 Qdrant Cloud의 api-key 등)이 실제로 새는 경로다.
   */
  const queryParamCases: Array<[string, string, string]> = [
    ['api-key(하이픈)', '?api-key=secret-abc-123', 'secret-abc-123'],
    ['access_token', '?access_token=ya29.SECRETVALUE', 'ya29.SECRETVALUE'],
    [
      'api_key(밑줄·후속 파라미터 있음)',
      '?api_key=plain-secret-1&limit=10',
      'plain-secret-1',
    ],
    ['KEY(대문자)', '?KEY=plainsecret123', 'plainsecret123'],
    [
      'key(& 로 이어진 두 번째 파라미터)',
      '?limit=10&key=tail-secret-9',
      'tail-secret-9',
    ],
  ];

  it.each(queryParamCases)(
    '%s 쿼리 파라미터 값을 가린다',
    async (_이름, query, secret) => {
      const leaky = new Error(
        `요청 실패: https://qdrant.example.com/collections${query}`,
      );
      await callExternal('qdrant', 'query', alwaysNull, () =>
        Promise.reject(leaky),
      ).catch(() => undefined);

      const logged = firstLogMessage(errorLog);
      expect(logged).not.toContain(secret);
      // 값만 가리고 파라미터 이름은 남긴다 — 무엇이 가려졌는지 알 수 없으면 진단이 안 된다.
      expect(logged).toContain('=***');
    },
  );

  it('후속 쿼리 파라미터까지 삼키지 않는다', async () => {
    // `[^&\s]+`가 `&`를 넘어 탐욕적으로 먹으면 뒤따르는 진단 정보가 함께 사라진다.
    const leaky = new Error(
      '요청 실패: /collections?api_key=plain-secret-1&limit=10',
    );
    await callExternal('qdrant', 'query', alwaysNull, () =>
      Promise.reject(leaky),
    ).catch(() => undefined);

    const logged = firstLogMessage(errorLog);
    expect(logged).not.toContain('plain-secret-1');
    expect(logged).toContain('limit=10');
  });

  /**
   * 판정은 cause 체인을 펼쳐 안쪽을 보는데 로그가 바깥만 보면 정보량이 0이 된다.
   * Node의 fetch 실패는 바깥이 항상 "fetch failed"라 호스트도 포트도 사라지고
   * ECONNREFUSED("서버가 안 떠 있다")인지 ENOTFOUND("호스트명 오타")인지 구별할 수 없다.
   */
  it('cause 체인 안쪽 메시지가 로그에 남는다', async () => {
    const inner = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:8080'),
      { code: 'ECONNREFUSED' },
    );
    const outer = new TypeError('fetch failed', { cause: inner });
    await callExternal('qdrant', 'query', alwaysNull, () =>
      Promise.reject(outer),
    ).catch(() => undefined);

    const logged = firstLogMessage(errorLog);
    expect(logged).toContain('fetch failed');
    expect(logged).toContain('connect ECONNREFUSED 127.0.0.1:8080');
  });

  it('AggregateError의 빈 message를 건너뛰고 errors[0]을 쓴다', async () => {
    // 듀얼스택 localhost의 실측 모양(Node v24). 한 겹 벗겨도 message가 빈 문자열이라
    // 체인만 훑어서는 주소를 못 얻는다.
    const aggregate = Object.assign(
      new AggregateError(
        [new Error('connect ECONNREFUSED ::1:59999')],
        '', // 실측에서 빈 문자열이다
      ),
      { code: 'ECONNREFUSED' },
    );
    const outer = new TypeError('fetch failed', { cause: aggregate });
    await callExternal('qdrant', 'query', alwaysNull, () =>
      Promise.reject(outer),
    ).catch(() => undefined);

    expect(firstLogMessage(errorLog)).toContain(
      'connect ECONNREFUSED ::1:59999',
    );
  });

  it('비-Error를 던져도 값이 로그에 남는다', async () => {
    // 이 분기를 지워도 아무 테스트가 깨지지 않던 자리다. 지우면 catch 안에서
    // 새 예외가 나 통로 자체가 무너진다.
    await callExternal('qdrant', 'query', alwaysNull, () =>
      // 비-Error 거부가 바로 이 테스트의 대상이다. 규칙을 지키면 검증 대상이 사라진다.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject('문자열로 던진 실패'),
    ).catch(() => undefined);

    expect(firstLogMessage(errorLog)).toContain('문자열로 던진 실패');
  });

  it('비-Error 객체를 던져도 로그가 끊기지 않는다', async () => {
    await callExternal('qdrant', 'query', alwaysNull, () =>
      // 위와 같은 이유. SDK가 Error가 아닌 값을 거부 이유로 넘기는 경우를 재현한다.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject({ code: 'ECONNREFUSED' }),
    ).catch(() => undefined);

    // 판정은 살아 있어야 한다 — 체인 탐색이 Error만 보느라 code를 놓치면 안 된다.
    expect(firstLogMessage(errorLog)).toContain('unavailable');
  });

  it('체인 안쪽 메시지에도 마스킹이 걸린다', async () => {
    // 체인을 펼쳐 더 많은 정보를 남기게 됐으므로 마스킹이 새 경로에도 걸려야 한다.
    const inner = new Error('요청 거절: ?api-key=inner-secret-7');
    const outer = new TypeError('fetch failed', { cause: inner });
    await callExternal('qdrant', 'query', alwaysNull, () =>
      Promise.reject(outer),
    ).catch(() => undefined);

    const logged = firstLogMessage(errorLog);
    expect(logged).not.toContain('inner-secret-7');
    expect(logged).toContain('요청 거절');
  });

  it('자격증명이 없는 원인 메시지는 그대로 남는다', async () => {
    // 반대 방향 짝. 과잉 마스킹(URL 통삭제·긴 토큰 통삭제)으로 진단 정보를 잃으면
    // 로그가 남아 있어도 무엇이 실패했는지 알 수 없다.
    const detail =
      'http://qdrant.internal:6333/collections/tour_contents 조회 실패: connect ECONNREFUSED 10.0.0.5:6333';
    await callExternal('qdrant', 'query', alwaysNull, () =>
      Promise.reject(new Error(detail)),
    ).catch(() => undefined);

    expect(firstLogMessage(errorLog)).toContain(detail);
  });
});
