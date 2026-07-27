import { runInNewContext } from 'vm';

import { classifyGeminiFailure } from './gemini.errors';

/**
 * 에러 처리 표의 Gemini 행마다 판정 1건씩.
 * 마지막 케이스(모르는 오류 → null)가 공통 판정으로 넘어가는 경로를 지킨다.
 */

function apiError(status: number, message = '오류'): Error {
  return Object.assign(new Error(message), { status });
}

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
