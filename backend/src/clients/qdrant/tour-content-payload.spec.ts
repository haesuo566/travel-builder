import {
  buildQdrantFilter,
  parseTourContentPayload,
} from './tour-content-payload';

/**
 * core의 toPayload(core/src/lib/qdrantCollection.ts:76-89)와 키가 1:1이어야 한다.
 * 타입 시스템이 두 워크스페이스를 연결하지 못하므로 여기서 리터럴로 단정한다.
 */

/**
 * 특정 키만 뺀 사본.
 * `const { contentid: _ignored, ...rest }` 구조분해는 뺀 변수가
 * no-unused-vars(error)에 걸린다 — typescript-eslint의 ignoreRestSiblings 기본값이
 * false다. 헬퍼로 뺀다.
 */
function without(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => name !== key),
  );
}

function completePayload(): Record<string, unknown> {
  return {
    contentid: '126508',
    contenttypeid: '12',
    ldong_regn_cd: '50',
    ldong_signgu_cd: '110',
    lcls_systm1: 'NA',
    lcls_systm2: 'NA01',
    lcls_systm3: 'NA0101',
    title: '성산일출봉',
    mapx: '126.9423',
    mapy: '33.4581',
  };
}

describe('parseTourContentPayload', () => {
  it('완전한 payload의 전 필드를 매핑한다', () => {
    expect(parseTourContentPayload(completePayload())).toEqual({
      contentid: '126508',
      contenttypeid: '12',
      ldong_regn_cd: '50',
      ldong_signgu_cd: '110',
      lcls_systm1: 'NA',
      lcls_systm2: 'NA01',
      lcls_systm3: 'NA0101',
      title: '성산일출봉',
      mapx: '126.9423',
      mapy: '33.4581',
    });
  });

  it('contentid가 없으면 null이다', () => {
    // contentid가 없으면 Postgres 재조회가 불가능해 hit 자체가 쓸모없다.
    expect(
      parseTourContentPayload(without(completePayload(), 'contentid')),
    ).toBeNull();
  });

  it('contentid가 빈 문자열이어도 null이다', () => {
    expect(
      parseTourContentPayload({ ...completePayload(), contentid: '' }),
    ).toBeNull();
  });

  it('contentid가 문자열이 아니면 null이다', () => {
    // 숫자 126508은 truthy라 asString을 거치지 않으면 통과해 버린다.
    // TourContentPayload.contentid의 타입이 string이므로 여기서 끊어야
    // 소비자가 .trim()을 부르다 런타임에 깨지지 않는다.
    expect(
      parseTourContentPayload({ ...completePayload(), contentid: 126508 }),
    ).toBeNull();
  });

  it('contentid만 있으면 나머지를 빈 문자열로 보정한다', () => {
    expect(parseTourContentPayload({ contentid: '126508' })).toEqual({
      contentid: '126508',
      contenttypeid: '',
      ldong_regn_cd: '',
      ldong_signgu_cd: '',
      lcls_systm1: '',
      lcls_systm2: '',
      lcls_systm3: '',
      title: '',
      mapx: '',
      mapy: '',
    });
  });

  it('문자열이 아닌 필드는 빈 문자열로 보정한다', () => {
    // 위 케이스와 짝이다. 키가 아예 없는 것과 타입이 다른 것을 같게 다룬다 —
    // 숫자 mapx를 그대로 통과시키면 선언 타입(string)과 실제 값이 갈린다.
    const payload = parseTourContentPayload({
      contentid: '126508',
      title: 42,
      mapx: null,
    });

    expect(payload?.title).toBe('');
    expect(payload?.mapx).toBe('');
  });

  it('null·문자열·배열 입력은 null이다', () => {
    expect(parseTourContentPayload(null)).toBeNull();
    expect(parseTourContentPayload(undefined)).toBeNull();
    expect(parseTourContentPayload('126508')).toBeNull();
    expect(parseTourContentPayload([{ contentid: '126508' }])).toBeNull();
  });

  it('contentid를 직접 가진 배열도 null이다', () => {
    // 위 케이스의 [{ contentid }]는 Array.isArray 가드를 지워도 null이 된다 —
    // 배열 **자신**에게는 contentid가 없어 아래 contentid 검사에 먼저 걸리기
    // 때문이다. 그 fixture만으로는 가드가 통째로 사라져도 초록불이 켜진다
    // (라인 삭제 검사에서 실제로 생존했다). 가드가 하는 일을 보려면
    // 배열 자신이 contentid를 들고 있어야 한다.
    const arrayWithContentid = Object.assign(['126508'], {
      contentid: '126508',
    });
    expect(parseTourContentPayload(arrayWithContentid)).toBeNull();
  });
});

describe('buildQdrantFilter', () => {
  it('조건이 하나면 must 한 개를 만든다', () => {
    expect(buildQdrantFilter({ contenttypeid: '12' })).toEqual({
      must: [{ key: 'contenttypeid', match: { value: '12' } }],
    });
  });

  it('여러 조건은 must에 모두 들어간다', () => {
    expect(buildQdrantFilter({ ldongRegnCd: '50', lclsSystm1: 'NA' })).toEqual({
      must: [
        { key: 'ldong_regn_cd', match: { value: '50' } },
        { key: 'lcls_systm1', match: { value: 'NA' } },
      ],
    });
  });

  it('필터가 없으면 undefined다', () => {
    // 빈 must 절을 보내면 Qdrant가 조건 없는 필터로 해석해도 요청만 커진다.
    expect(buildQdrantFilter(undefined)).toBeUndefined();
  });

  it('빈 객체도 undefined다', () => {
    expect(buildQdrantFilter({})).toBeUndefined();
  });

  it('빈 문자열 조건은 넣지 않는다', () => {
    // spec :320 (C 행). ''로 필터하면 payload의 어떤 값과도 매치되지 않아
    // 예외 없이 "정상 200 + 결과 없음"이 된다 — Task 8이 502로 끊는
    // payload 전 건 불량과 같은 종류인데 이쪽은 흔적조차 남지 않는다.
    // undefined가 아니라 '' 하나만 넣어 !== undefined 필터로는 못 걸러냄을 보인다.
    expect(buildQdrantFilter({ contenttypeid: '' })).toBeUndefined();
  });

  it('공백뿐인 조건도 넣지 않는다', () => {
    // ||만으로는 통과한다 — 공백 문자열은 truthy다.
    // gemini.client.ts:46이 .trim()을 붙인 것과 같은 이유다.
    expect(buildQdrantFilter({ ldongRegnCd: '   ' })).toBeUndefined();
  });

  it('빈 조건과 유효한 조건이 섞이면 유효한 것만 남는다', () => {
    // 위 두 케이스는 결과가 전부 undefined라 "필터를 통째로 버리는" 오구현으로도
    // 통과한다. 여기서 선별이 실제로 일어나는지 못 박는다.
    expect(
      buildQdrantFilter({
        contenttypeid: '',
        ldongRegnCd: '50',
        lclsSystm1: '  ',
      }),
    ).toEqual({ must: [{ key: 'ldong_regn_cd', match: { value: '50' } }] });
  });

  it('조건 값의 앞뒤 공백을 제거하고 보낸다', () => {
    // ' 12 '는 payload의 '12'와 매치되지 않는다. ''를 부재로 다루기로 한 이상
    // 같은 이유로 실패하는 ' 12 '를 원문 그대로 보낼 근거가 없다.
    expect(buildQdrantFilter({ contenttypeid: ' 12 ' })).toEqual({
      must: [{ key: 'contenttypeid', match: { value: '12' } }],
    });
  });

  it('필터 키가 core의 payload 키 문자열과 정확히 일치한다', () => {
    // core가 키 이름을 바꾸면 이 단정이 깨져야 한다. 타입은 두 워크스페이스를
    // 연결하지 못하므로 문자열 리터럴이 유일한 대조 지점이다.
    const filter = buildQdrantFilter({
      contenttypeid: 'a',
      ldongRegnCd: 'b',
      ldongSignguCd: 'c',
      lclsSystm1: 'd',
      lclsSystm2: 'e',
      lclsSystm3: 'f',
    }) as { must: Array<{ key: string }> };

    expect(filter.must.map((condition) => condition.key)).toEqual([
      'contenttypeid',
      'ldong_regn_cd',
      'ldong_signgu_cd',
      'lcls_systm1',
      'lcls_systm2',
      'lcls_systm3',
    ]);
  });
});
