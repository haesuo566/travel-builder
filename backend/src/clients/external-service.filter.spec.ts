import { ArgumentsHost } from '@nestjs/common';

import { ExternalServiceError } from './external-service.error';
import type { ExternalFailureKind } from './external-service.error';
import { ExternalServiceFilter } from './external-service.filter';

/**
 * kind → HTTP 상태를 한 곳에 고정한다.
 * 어떤 kind도 4xx가 되지 않는다 — 외부 서비스의 실패를 사용자 입력 탓으로 돌리면
 * 프론트엔드가 "입력을 고치세요"라고 안내하고 사용자는 고칠 게 없는 입력을 고치려 든다.
 */

function createHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, setHeader }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json, setHeader };
}

/**
 * 첫 json() 호출의 본문.
 * jest.Mock의 mock.calls 원소는 any로 추론돼 no-unsafe-member-access에 걸린다.
 * unknown을 거쳐 좁힌다.
 */
function firstJsonBody(json: jest.Mock): unknown {
  const calls = json.mock.calls as unknown as unknown[][];
  return calls[0][0];
}

describe('ExternalServiceFilter', () => {
  const filter = new ExternalServiceFilter();

  const cases: Array<[ExternalFailureKind, number]> = [
    ['auth', 500],
    ['not-found', 500],
    ['dimension-mismatch', 500],
    ['quota', 503],
    ['unavailable', 503],
    ['timeout', 504],
    ['upstream', 502],
    ['invalid-request', 502],
    ['empty-response', 502],
  ];

  it.each(cases)('%s는 %i로 매핑된다', (kind, expected) => {
    const { host, status, json } = createHost();
    filter.catch(new ExternalServiceError('gemini', kind, '실패'), host);

    expect(status).toHaveBeenCalledWith(expected);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: expected, error: kind }),
    );
  });

  it('quota에는 Retry-After가 붙는다', () => {
    const { host, setHeader } = createHost();
    filter.catch(new ExternalServiceError('gemini', 'quota', '쿼터'), host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', 60);
  });

  it('quota가 아니면 Retry-After가 붙지 않는다', () => {
    // 만료된 키는 기다린다고 낫지 않는다. 503과 Retry-After는 "나중에 다시"라는
    // 약속이므로 auth에 붙이면 거짓말이 된다.
    const { host, setHeader } = createHost();
    filter.catch(new ExternalServiceError('gemini', 'auth', '키 무효'), host);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('응답 본문에 업스트림 원문과 자격증명이 담기지 않는다', () => {
    const { host, json } = createHost();
    const cause = new Error('key=AIzaSyA1234567890abcdefghijklmnopqrstuv 무효');
    filter.catch(
      new ExternalServiceError(
        'gemini',
        'auth',
        'gemini generateContent 실패: key=AIzaSyA1234567890abcdefghijklmnopqrstuv',
        { cause },
      ),
      host,
    );

    const body = JSON.stringify(firstJsonBody(json));
    expect(body).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(body).not.toContain('generateContent');
  });

  it('본문 shape은 statusCode·error·message 세 키다', () => {
    const { host, json } = createHost();
    filter.catch(new ExternalServiceError('qdrant', 'timeout', '느림'), host);

    expect(Object.keys(firstJsonBody(json) as object).sort()).toEqual([
      'error',
      'message',
      'statusCode',
    ]);
  });
});
