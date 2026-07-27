import { classifyTeiFailure, TeiHttpError } from './tei.errors';

/**
 * TEI는 SDK가 없어 실패가 두 갈래다 — fetch가 던지는 것(연결 거부·중단)과
 * 던지지 않는 것(4xx·5xx 응답). 후자를 TeiClient가 TeiHttpError로 바꿔 던지므로
 * 이 분류기는 다른 둘과 같은 (error: unknown) 시그니처를 갖는다.
 *
 * 전자를 여기서 가로채면 안 된다 — classifyCommonFailure가 이름·code로
 * 판정하는 몫이고, 여기서 잡으면 같은 실패가 두 곳에서 분류된다.
 */

describe('TeiHttpError', () => {
  it('status와 bodySnippet을 노출한다', () => {
    const error = new TeiHttpError(413, '{"error":"input too long"}');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TeiHttpError');
    expect(error.status).toBe(413);
    expect(error.bodySnippet).toBe('{"error":"input too long"}');
  });

  it('message에 상태와 본문이 함께 들어간다', () => {
    // callExternal의 로그는 cause 체인의 message만 읽는다. 여기 안 넣으면
    // bodySnippet이 어디에도 출력되지 않아 죽은 값이 된다.
    const error = new TeiHttpError(500, 'model is loading');

    expect(error.message).toContain('500');
    expect(error.message).toContain('model is loading');
  });

  it('본문이 비면 message에 군더더기가 붙지 않는다', () => {
    expect(new TeiHttpError(503, '').message).toBe(
      'TEI가 503으로 응답했습니다.',
    );
  });
});

describe('classifyTeiFailure', () => {
  it('400은 invalid-request다', () => {
    expect(classifyTeiFailure(new TeiHttpError(400, ''))).toBe(
      'invalid-request',
    );
  });

  it('413은 invalid-request다', () => {
    expect(classifyTeiFailure(new TeiHttpError(413, ''))).toBe(
      'invalid-request',
    );
  });

  it('422는 invalid-request다', () => {
    expect(classifyTeiFailure(new TeiHttpError(422, ''))).toBe(
      'invalid-request',
    );
  });

  it('500은 upstream이다', () => {
    expect(classifyTeiFailure(new TeiHttpError(500, ''))).toBe('upstream');
  });

  it('503(모델 로딩 중)도 upstream이다', () => {
    expect(classifyTeiFailure(new TeiHttpError(503, ''))).toBe('upstream');
  });

  it('분류되지 않은 비-2xx는 upstream이다', () => {
    expect(classifyTeiFailure(new TeiHttpError(404, ''))).toBe('upstream');
    expect(classifyTeiFailure(new TeiHttpError(418, ''))).toBe('upstream');
  });

  it('bodySnippet은 판정에 쓰이지 않는다', () => {
    // 같은 상태 코드면 본문이 무엇이든 같은 kind다. 본문으로 판정하기 시작하면
    // TEI 버전이 문구를 바꿀 때 분류가 조용히 어긋난다.
    expect(
      classifyTeiFailure(new TeiHttpError(400, 'dimension mismatch')),
    ).toBe(classifyTeiFailure(new TeiHttpError(400, '')));
  });

  it('bodySnippet의 숫자·토큰이 500 판정을 뒤집지 못한다', () => {
    // 리뷰 지적(review-CD.md Minor 1): 위 동치 비교는 두 fixture 모두
    // 400 + quota 무관 문구라 "본문에 quota 신호가 있으면 quota로 승격시키는"
    // 변이를 넣어도 통과했다. 묶음 B의 1429852 결함(spec :1114)의 TEI판을
    // 리터럴 단정으로 막는다 — 셋이 함께 quota로 바뀌면 위 동치 비교는
    // 여전히 초록불이다.
    expect(classifyTeiFailure(new TeiHttpError(500, ''))).toBe('upstream');
    expect(
      classifyTeiFailure(
        new TeiHttpError(500, '{"error":"token count (1429852) exceeds limit"}'),
      ),
    ).toBe('upstream');
    expect(
      classifyTeiFailure(new TeiHttpError(500, 'RESOURCE_EXHAUSTED')),
    ).toBe('upstream');
  });

  it('TeiHttpError가 아닌 오류에는 null을 반환한다', () => {
    // fetch가 던진 것을 가로채지 않고 공통 판정에 넘기는지 보는 반대 방향 케이스다.
    // 음성 단정이므로 "가드를 지우면 실제로 다른 결과가 나오는" 값을 넣는다 —
    // instanceof 가드를 빼면 status가 undefined가 되어 upstream이 나온다.
    const aborted = Object.assign(new Error('시간 초과'), {
      name: 'TimeoutError',
    });
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });

    expect(classifyTeiFailure(aborted)).toBeNull();
    expect(classifyTeiFailure(refused)).toBeNull();
    expect(classifyTeiFailure(new Error('그냥 오류'))).toBeNull();
  });

  it('status를 가진 남의 오류도 TeiHttpError가 아니면 null이다', () => {
    // 위 케이스만으로는 "status 프로퍼티를 덕 타이핑으로 읽는" 오구현을 못 잡는다.
    // 그렇게 구현하면 이 400짜리 가짜가 invalid-request로 새어 나온다.
    const impostor = Object.assign(new Error('Bad Request'), { status: 400 });

    expect(classifyTeiFailure(impostor)).toBeNull();
  });

  it('비-Error 값에도 null을 반환하고 던지지 않는다', () => {
    expect(classifyTeiFailure(null)).toBeNull();
    expect(classifyTeiFailure(undefined)).toBeNull();
    expect(classifyTeiFailure('문자열')).toBeNull();
    expect(classifyTeiFailure(400)).toBeNull();
  });
});
