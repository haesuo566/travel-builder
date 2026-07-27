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
 * 첫 로그 호출의 메시지.
 * jest.SpyInstance의 mock.calls 원소는 any로 추론돼 no-unsafe-member-access에 걸린다.
 * unknown을 거쳐 좁힌다.
 */
function firstLogMessage(spy: jest.SpyInstance): string {
  const calls = spy.mock.calls as unknown as unknown[][];
  return String(calls[0][0]);
}

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
});
