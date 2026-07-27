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

  /**
   * kind별 상태코드와 응답 문구를 함께 못박는다.
   * 문구를 단정하지 않으면 전 kind가 같은 문구여도 통과한다 — 그러면
   * 예외 message를 쓰지 않고 고정 문구표를 둔 결정(자격증명 누출의 구조적 차단)이
   * 무의미해진다. 값은 구현 상수를 import하지 않고 리터럴로 적는다.
   */
  const cases: Array<[ExternalFailureKind, number, string]> = [
    ['auth', 500, '외부 서비스 인증에 실패했습니다.'],
    ['not-found', 500, '외부 서비스에서 대상을 찾을 수 없습니다.'],
    ['dimension-mismatch', 500, '질의 벡터 차원이 컬렉션과 일치하지 않습니다.'],
    [
      'quota',
      503,
      '외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요.',
    ],
    ['unavailable', 503, '외부 서비스에 연결할 수 없습니다.'],
    ['timeout', 504, '외부 서비스가 시간 안에 응답하지 않았습니다.'],
    ['upstream', 502, '외부 서비스에서 오류가 발생했습니다.'],
    ['invalid-request', 502, '외부 서비스가 요청을 거절했습니다.'],
    ['empty-response', 502, '외부 서비스가 빈 응답을 반환했습니다.'],
  ];

  it.each(cases)(
    '%s는 %i와 고유 문구로 매핑된다',
    (kind, expected, message) => {
      const { host, status, json } = createHost();
      filter.catch(new ExternalServiceError('gemini', kind, '실패'), host);

      expect(status).toHaveBeenCalledWith(expected);
      expect(json).toHaveBeenCalledWith({
        statusCode: expected,
        error: kind,
        message,
      });
    },
  );

  it('kind마다 문구가 서로 다르다', () => {
    // 문구가 겹치면 사용자도 로그 독자도 어느 실패인지 구별하지 못한다.
    const messages = cases.map(([kind]) => {
      const { host, json } = createHost();
      filter.catch(new ExternalServiceError('gemini', kind, '실패'), host);
      const body = firstJsonBody(json) as { message: string };
      return body.message;
    });

    expect(new Set(messages).size).toBe(cases.length);
  });

  it('quota에는 Retry-After가 붙는다', () => {
    const { host, setHeader } = createHost();
    filter.catch(new ExternalServiceError('gemini', 'quota', '쿼터'), host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', 60);
  });

  /**
   * 반대 방향 짝을 전 kind로 돌린다.
   * 음성 케이스가 auth(500) 하나뿐이면 "503 전체에 붙인다"는 오구현이 통과한다 —
   * 같은 503인 unavailable이 여기 포함되는 것이 요점이다.
   * 만료된 키도, 연결 거부도 기다린다고 낫지 않는다. Retry-After는
   * "나중에 다시"라는 약속이므로 quota 밖에 붙이면 거짓말이 된다.
   */
  const nonQuotaKinds = cases
    .map(([kind]) => kind)
    .filter((kind) => kind !== 'quota');

  it.each(nonQuotaKinds)('%s에는 Retry-After가 붙지 않는다', (kind) => {
    const { host, setHeader } = createHost();
    filter.catch(new ExternalServiceError('gemini', kind, '실패'), host);

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
