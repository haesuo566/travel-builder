import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn() }));

import { QdrantClient } from '@qdrant/js-client-rest';

import { ExternalServiceError } from '../external-service.error';
import { QdrantSearchClient } from './qdrant.client';

/**
 * core가 vi.mock("@qdrant/js-client-rest")로 잡는 것과 같은 자리를 jest.mock으로 잡는다.
 *
 * 인자 타입을 SDK 메서드 시그니처에 묶는다. spec은 SDK 경계 모킹이 옵션 이름의
 * 오타를 못 잡는다고 적었지만(with_payload를 withPayload로 써도 mock은 통과),
 * Parameters<QdrantClient['query']>로 묶으면 그 오타가 컴파일에서 걸린다.
 * 런타임 동작(SDK가 그 옵션을 실제로 어떻게 쓰는가)의 구멍은 여전히 실측 몫이다.
 *
 * 반환 타입은 SDK의 전체 응답 타입이 아니라 우리가 읽는 필드만 적는다.
 */
const QdrantClientMock = QdrantClient as unknown as jest.Mock;

const query = jest.fn<
  Promise<{ points: unknown[] }>,
  Parameters<QdrantClient['query']>
>();

const getCollection = jest.fn<
  Promise<{ config?: { params?: { vectors?: unknown } } }>,
  Parameters<QdrantClient['getCollection']>
>();

/**
 * SDK 생성자에 넘어간 인자.
 * QdrantClientMock은 jest.Mock으로 캐스팅한 것이라 mock.calls 원소가 any로
 * 추론돼 no-unsafe-member-access에 걸린다. unknown을 거쳐 좁힌다
 * (call-external.spec.ts의 allLogMessages와 같은 관용구).
 */
function constructorParams(): Record<string, unknown> {
  const calls = QdrantClientMock.mock.calls as unknown as unknown[][];
  return calls[0][0] as Record<string, unknown>;
}

const VECTOR = [0.1, 0.2, 0.3];

function point(contentid: string, score: number) {
  return {
    id: Number(contentid),
    version: 1,
    score,
    payload: {
      contentid,
      contenttypeid: '12',
      ldong_regn_cd: '50',
      ldong_signgu_cd: '110',
      lcls_systm1: 'NA',
      lcls_systm2: 'NA01',
      lcls_systm3: 'NA0101',
      title: `관광지 ${contentid}`,
      mapx: '126.9',
      mapy: '33.4',
    },
  };
}

async function createClient(
  env: Record<string, string> = { QDRANT_URL: 'http://qdrant.test:6333' },
): Promise<QdrantSearchClient> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => env],
      }),
    ],
    providers: [QdrantSearchClient],
  }).compile();
  return moduleRef.get(QdrantSearchClient);
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ points: [] });
  getCollection.mockReset().mockResolvedValue({
    config: { params: { vectors: { size: 1024, distance: 'Cosine' } } },
  });
  QdrantClientMock.mockReset().mockImplementation(() => ({
    query,
    getCollection,
  }));
  // 실패 경로를 도는 테스트가 여럿이라 스파이를 걸지 않으면 콘솔이 ERROR로 덮인다.
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('QdrantSearchClient 생성자', () => {
  it('url과 timeout을 SDK에 전달한다', async () => {
    // timeout을 빠뜨리면 SDK 기본값 300초가 적용돼 사용자가 5분을 기다린다
    // (설치본 1.18.0의 qdrant-client.js:11에서 확인).
    await createClient();

    const params = constructorParams();
    expect(params.url).toBe('http://qdrant.test:6333');
    expect(params.timeout).toBe(5000);
  });

  it('QDRANT_URL이 없으면 부팅이 실패한다', async () => {
    // getOrThrow가 get으로 바뀌면 url이 undefined인 클라이언트가 부팅에 성공하고
    // 첫 검색에서야 드러난다. 필수 설정 누락은 배포 시점에 보여야 한다.
    await expect(createClient({})).rejects.toThrow(/QDRANT_URL/);
    expect(QdrantClientMock).not.toHaveBeenCalled();
  });

  it('QDRANT_API_KEY가 있으면 apiKey를 넘긴다', async () => {
    await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_API_KEY: 'secret',
    });

    expect(constructorParams().apiKey).toBe('secret');
  });

  it('QDRANT_API_KEY가 없으면 apiKey 키 자체를 넘기지 않는다', async () => {
    // 위 케이스와 짝이다. undefined를 넘기는 오구현은 apiKey 값 단정만으로는
    // 안 잡히므로 키 존재 여부를 본다.
    await createClient();

    expect('apiKey' in constructorParams()).toBe(false);
  });

  it('QDRANT_API_KEY가 빈 문자열이면 apiKey를 넘기지 않는다', async () => {
    // .env의 "QDRANT_API_KEY="(값만 빈 줄)이 빈 인증 헤더로 나가면
    // 인증을 끈 것도 켠 것도 아닌 상태가 된다.
    await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_API_KEY: '',
    });

    expect('apiKey' in constructorParams()).toBe(false);
  });

  it('QDRANT_API_KEY가 공백뿐이면 apiKey를 넘기지 않는다', async () => {
    // ||만으로는 통과한다 — 공백 문자열은 truthy다. .env 줄 끝 공백이 흔하다.
    await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_API_KEY: '   ',
    });

    expect('apiKey' in constructorParams()).toBe(false);
  });

  it('QDRANT_API_KEY의 앞뒤 공백을 제거하고 넘긴다', async () => {
    // .env 줄 끝 공백이 인증 헤더에 그대로 실리면 401이 나는데,
    // 로그의 키는 눈으로 봐서 멀쩡해 보인다.
    await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_API_KEY: '  secret  ',
    });

    expect(constructorParams().apiKey).toBe('secret');
  });

  it('네트워크를 만지지 않는다', async () => {
    await createClient();

    expect(query).not.toHaveBeenCalled();
    expect(getCollection).not.toHaveBeenCalled();
  });
});

describe('QdrantSearchClient.search', () => {
  it('QDRANT_COLLECTION 기본값 tour_contents를 쓴다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    // expect.anything()을 쓰지 않는다 — any를 타입 있는 인자 자리에 넣으면
    // no-unsafe-argument 경고가 뜨고, 리뷰 게이트는 --max-warnings=0으로 돈다.
    expect(query.mock.calls[0][0]).toBe('tour_contents');
  });

  it('QDRANT_COLLECTION이 있으면 그 값을 쓴다', async () => {
    const client = await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_COLLECTION: 'tour_v2',
    });
    await client.search(VECTOR);

    expect(query.mock.calls[0][0]).toBe('tour_v2');
  });

  it('QDRANT_COLLECTION이 빈 문자열이면 기본값으로 폴백한다', async () => {
    // ConfigService.get(key, default)의 두 번째 인자는 undefined일 때만 폴백한다.
    // .env에 "QDRANT_COLLECTION="(값만 빈 줄)이 있으면 컬렉션 이름 ''가 그대로
    // SDK에 나가고, 돌아오는 것은 404다 — 이름이 비었다는 사실은 어디에도 없다.
    const client = await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_COLLECTION: '',
    });
    await client.search(VECTOR);

    expect(query.mock.calls[0][0]).toBe('tour_contents');
  });

  it('QDRANT_COLLECTION이 공백뿐이면 기본값으로 폴백한다', async () => {
    // ||는 공백 문자열을 truthy로 본다(gemini.client.ts:46이 .trim()을 붙인 이유).
    const client = await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_COLLECTION: '   ',
    });
    await client.search(VECTOR);

    expect(query.mock.calls[0][0]).toBe('tour_contents');
  });

  it('with_payload를 true로 보내고 with_vector는 보내지 않는다', async () => {
    // with_payload를 빠뜨리면 payload가 null로 오고 파서가 전 건을 버려
    // "정상 200 + 빈 배열"이 된다. hit당 1024 float를 되받을 이유도 없다.
    const client = await createClient();
    await client.search(VECTOR);

    // 캐스팅이 없다. 인자 타입이 SDK 시그니처라 with_payload를 withPayload로
    // 잘못 쓰면 구현 쪽에서 컴파일이 깨진다.
    const [, request] = query.mock.calls[0];
    expect(request.with_payload).toBe(true);
    expect('with_vector' in request).toBe(false);
  });

  it('질의 벡터를 query로 보낸다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    expect(query.mock.calls[0][1]).toMatchObject({ query: VECTOR });
  });

  it('limit 기본값은 10이다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    expect(query.mock.calls[0][1]).toMatchObject({ limit: 10 });
  });

  it('limit을 지정하면 그 값을 쓴다', async () => {
    const client = await createClient();
    await client.search(VECTOR, { limit: 3 });

    expect(query.mock.calls[0][1]).toMatchObject({ limit: 3 });
  });

  it('limit 0을 기본값으로 바꾸지 않는다', async () => {
    // 숫자 선택 값은 ??다. ||를 쓰면 0을 부재로 보고 10으로 바꿔 버리는데,
    // 호출자는 "아무것도 가져오지 말라"고 한 것이고 10건을 받는다.
    // 문자열 규칙(?.trim() ||)을 숫자에 그대로 복사하면 이 자리가 깨진다.
    const client = await createClient();
    await client.search(VECTOR, { limit: 0 });

    expect(query.mock.calls[0][1]).toMatchObject({ limit: 0 });
  });

  it('필터를 지정하면 변환해 전달한다', async () => {
    const client = await createClient();
    await client.search(VECTOR, { filter: { contenttypeid: '12' } });

    expect(query.mock.calls[0][1]).toMatchObject({
      filter: { must: [{ key: 'contenttypeid', match: { value: '12' } }] },
    });
  });

  it('필터 미지정이면 filter 키 자체가 요청에 없다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    const [, request] = query.mock.calls[0];
    expect('filter' in request).toBe(false);
  });

  it('필터가 빈 조건뿐이면 filter 키 자체가 요청에 없다', async () => {
    // buildQdrantFilter가 undefined를 돌려주는 경로가 클라이언트까지
    // 이어지는지 본다. 여기서 {} 를 실어 보내면 요청만 커진다.
    const client = await createClient();
    await client.search(VECTOR, { filter: { contenttypeid: '  ' } });

    const [, request] = query.mock.calls[0];
    expect('filter' in request).toBe(false);
  });

  it('결과를 TourSearchHit[]로 매핑한다', async () => {
    query.mockResolvedValue({ points: [point('1', 0.9), point('2', 0.8)] });
    const client = await createClient();

    const hits = await client.search(VECTOR);
    expect(hits).toHaveLength(2);
    // 중첩 objectContaining을 쓰지 않는다(Global Constraints 참조).
    // 반환 타입이 TourSearchHit[]라 필드별 단정이 오히려 더 정확하다.
    expect(hits[0].id).toBe(1);
    expect(hits[0].score).toBe(0.9);
    expect(hits[0].payload.contentid).toBe('1');
    expect(hits[0].payload.title).toBe('관광지 1');
  });

  it('hit 순서를 SDK가 준 그대로 유지한다', async () => {
    // 점수 정렬은 Qdrant가 한다. 우리가 다시 정렬하면 score 동점 처리나
    // 정렬 키가 서버와 갈리고, 그 차이는 "가끔 순서가 이상하다"로만 나타난다.
    query.mockResolvedValue({
      points: [point('2', 0.8), point('1', 0.9), point('3', 0.7)],
    });
    const client = await createClient();

    const hits = await client.search(VECTOR);
    expect(hits.map((hit) => hit.payload.contentid)).toEqual(['2', '1', '3']);
  });

  it('hit 0건은 빈 배열을 반환하고 throw하지 않는다', async () => {
    query.mockResolvedValue({ points: [] });
    const client = await createClient();

    await expect(client.search(VECTOR)).resolves.toEqual([]);
  });

  it('일부만 payload 불량이면 나머지를 반환한다', async () => {
    const broken = { ...point('3', 0.7), payload: { title: 'contentid 없음' } };
    query.mockResolvedValue({
      points: [point('1', 0.9), broken, point('2', 0.8)],
    });
    const client = await createClient();

    const hits = await client.search(VECTOR);
    expect(hits.map((hit) => hit.payload.contentid)).toEqual(['1', '2']);
  });

  it('버린 hit이 있으면 건수를 warn으로 남긴다', async () => {
    // 조용히 버리면 "왜 3건 중 2건만 나오나"를 추적할 방법이 없다.
    // 부분 불량은 throw할 일이 아니지만 흔적 없이 넘어갈 일도 아니다.
    const warnLog = jest.spyOn(Logger.prototype, 'warn');
    const broken = { ...point('3', 0.7), payload: { title: 'contentid 없음' } };
    query.mockResolvedValue({
      points: [point('1', 0.9), broken, point('2', 0.8)],
    });
    const client = await createClient();
    await client.search(VECTOR);

    const calls = warnLog.mock.calls as unknown as unknown[][];
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain('1건');
  });

  it('전 건 정상이면 warn을 남기지 않는다', async () => {
    // 위 케이스와 짝이다. 조건 없이 늘 warn하면 정상 검색마다 경고가 쌓여
    // 진짜 경고가 묻힌다 — 그 상태도 위 테스트만으로는 통과한다.
    query.mockResolvedValue({ points: [point('1', 0.9), point('2', 0.8)] });
    const warnLog = jest.spyOn(Logger.prototype, 'warn');
    const client = await createClient();
    await client.search(VECTOR);

    expect(warnLog).not.toHaveBeenCalled();
  });

  it('전 건 payload 불량은 upstream으로 throw한다', async () => {
    // 위 두 케이스와 짝이다. 여기서 끊지 않으면 with_payload 누락이
    // "검색 결과 없음"으로 위장한 채 며칠을 간다.
    query.mockResolvedValue({
      points: [
        { ...point('1', 0.9), payload: null },
        { ...point('2', 0.8), payload: null },
      ],
    });
    const client = await createClient();

    const failure = await client
      .search(VECTOR)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect((failure as ExternalServiceError).kind).toBe('upstream');
  });

  it('전 건 불량 오류에 버린 건수와 첫 hit의 키가 담긴다', async () => {
    // 이 오류의 유일한 독자는 로그다. "payload를 읽을 수 없다"만으로는
    // with_payload 누락인지 core의 키 변경인지 구분할 수 없어,
    // 판단 재료가 없으면 결국 서버에 붙어 다시 재현해야 한다.
    query.mockResolvedValue({
      points: [{ ...point('1', 0.9), payload: { titel: '오타 키' } }],
    });
    const client = await createClient();

    const failure = await client
      .search(VECTOR)
      .catch((error: unknown) => error);
    const message = (failure as ExternalServiceError).message;
    expect(message).toContain('1');
    expect(message).toContain('titel');
  });

  it('payload가 전부 빈 객체면 키가 없다고 보고한다', async () => {
    // 위 케이스와 짝. 키 목록이 빈 배열일 때 join('')이 빈 문자열을 남기면
    // "첫 hit의 키: " 뒤가 잘려 로그를 읽는 사람이 출력이 깨졌다고 오해한다.
    query.mockResolvedValue({
      points: [{ ...point('1', 0.9), payload: {} }],
    });
    const client = await createClient();

    const failure = await client
      .search(VECTOR)
      .catch((error: unknown) => error);
    expect((failure as ExternalServiceError).message).toContain('없음');
  });

  it('404는 not-found로 throw한다 (빈 배열이 아니다)', async () => {
    // SDK의 주 경로 오류 형태다 — status 프로퍼티가 없고 message에 전부 들어 있다.
    // 판정 규칙은 qdrant.errors.spec.ts가 두 shape으로 검증하고, 여기서는
    // 그 판정이 실제로 배선돼 있는지만 본다.
    const notFound = new Error(
      'Unexpected Response: 404 (Not Found)\nRaw response content:\n' +
        '{ "status": { "error": "Collection `tour_contents` doesn\'t exist!" } }',
    );
    notFound.name = 'QdrantClientUnexpectedResponseError';
    query.mockRejectedValue(notFound);
    const client = await createClient();

    await expect(client.search(VECTOR)).rejects.toMatchObject({
      service: 'qdrant',
      kind: 'not-found',
    });
  });

  it('차원 불일치 400은 dimension-mismatch다', async () => {
    // 이쪽은 보조 경로(ApiError) 형태로 둔다 — 클라이언트가 두 shape 모두에서
    // 올바른 kind를 받아 오는지 확인한다.
    query.mockRejectedValue(
      Object.assign(new Error('Bad Request'), {
        status: 400,
        data: {
          status: {
            error: 'Vector dimension error: expected dim: 1024, got 3',
          },
        },
      }),
    );
    const client = await createClient();

    await expect(client.search(VECTOR)).rejects.toMatchObject({
      kind: 'dimension-mismatch',
    });
  });

  it('연결 거부는 unavailable이다', async () => {
    query.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    );
    const client = await createClient();

    await expect(client.search(VECTOR)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('실패 로그에 컬렉션 이름이 남는다', async () => {
    // operation 문자열이 비면 로그에서 어느 컬렉션이 실패했는지 알 수 없다.
    // 질의 벡터는 사용자 입력에서 온 것이라 operation에 넣지 않는다.
    const errorLog = jest.spyOn(Logger.prototype, 'error');
    query.mockRejectedValue(new Error('무슨 일인가 났다'));
    const client = await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_COLLECTION: 'tour_v2',
    });
    await client.search(VECTOR).catch(() => undefined);

    const calls = errorLog.mock.calls as unknown as unknown[][];
    const logged = String(calls[0][0]);
    expect(logged).toContain('tour_v2');
    expect(logged).toContain('qdrant');
  });
});

describe('QdrantSearchClient.getCollectionInfo', () => {
  it('vectorSize와 distance를 반환한다', async () => {
    const client = await createClient();

    await expect(client.getCollectionInfo()).resolves.toEqual({
      vectorSize: 1024,
      distance: 'Cosine',
    });
    expect(getCollection).toHaveBeenCalledWith('tour_contents');
  });

  it('벡터 설정을 읽을 수 없으면 throw한다', async () => {
    // 차원과 distance를 버리고 넘어가면 잘못된 컬렉션 위에서 검색이 조용히 돈다.
    getCollection.mockResolvedValue({ config: { params: {} } });
    const client = await createClient();

    await expect(client.getCollectionInfo()).rejects.toMatchObject({
      service: 'qdrant',
      kind: 'upstream',
    });
  });

  it('size가 수로 읽히지 않으면 throw한다', async () => {
    // 위 케이스는 vectors 자체가 없어서 size·distance 두 검사 중 어느 쪽이
    // 걸렸는지 구분하지 못한다. 각 검사를 따로 건드린다.
    getCollection.mockResolvedValue({
      config: { params: { vectors: { size: '많음', distance: 'Cosine' } } },
    });
    const client = await createClient();

    await expect(client.getCollectionInfo()).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('숫자 문자열 size는 수로 읽어 통과시킨다', async () => {
    // 위 케이스와 짝이다. 판정 기준은 "타입이 number인가"가 아니라
    // "수로 읽히는가"다 — Number()가 '1024'를 1024로 바꾸고 반환 타입도 number라
    // 계약이 깨지지 않는다. 진단용 메서드를 JSON 타입 흔들림으로 실패시키지 않는다.
    getCollection.mockResolvedValue({
      config: { params: { vectors: { size: '1024', distance: 'Cosine' } } },
    });
    const client = await createClient();

    await expect(client.getCollectionInfo()).resolves.toEqual({
      vectorSize: 1024,
      distance: 'Cosine',
    });
  });

  it('size가 0이면 throw한다', async () => {
    // 차원 0인 컬렉션은 존재하지 않는다. Number('')도 0이라 여기서 막지 않으면
    // 빈 문자열이 유효한 차원으로 통과한다.
    getCollection.mockResolvedValue({
      config: { params: { vectors: { size: 0, distance: 'Cosine' } } },
    });
    const client = await createClient();

    await expect(client.getCollectionInfo()).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('distance가 없으면 throw한다', async () => {
    getCollection.mockResolvedValue({
      config: { params: { vectors: { size: 1024 } } },
    });
    const client = await createClient();

    await expect(client.getCollectionInfo()).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('오류에 컬렉션 이름이 담긴다', async () => {
    getCollection.mockResolvedValue({ config: { params: {} } });
    const client = await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_COLLECTION: 'tour_v2',
    });

    const failure = await client
      .getCollectionInfo()
      .catch((error: unknown) => error);
    expect((failure as ExternalServiceError).message).toContain('tour_v2');
  });

  it('404는 not-found로 분류된다', async () => {
    // search와 같은 분류기가 배선돼 있는지 본다. 진단용 메서드라고 분류를
    // 빼먹으면 컬렉션 오타가 502로 보고돼 원인이 외부로 떠넘겨진다.
    const notFound = new Error(
      'Unexpected Response: 404 (Not Found)\nRaw response content:\n' +
        '{ "status": { "error": "Collection `tour_contents` doesn\'t exist!" } }',
    );
    notFound.name = 'QdrantClientUnexpectedResponseError';
    getCollection.mockRejectedValue(notFound);
    const client = await createClient();

    await expect(client.getCollectionInfo()).rejects.toMatchObject({
      service: 'qdrant',
      kind: 'not-found',
    });
  });
});
