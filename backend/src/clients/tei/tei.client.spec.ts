import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../external-service.error';
import { TeiHttpError } from './tei.errors';
import { TeiClient } from './tei.client';

/**
 * TEI만 모킹 경계가 다르다 — SDK가 없으므로 전역 fetch를 스텁한다.
 * 이 경계는 오히려 더 정확하다: 요청 URL·메서드·바디를 문자열 수준에서
 * 단정할 수 있어 "core와 같은 바디를 보내는가"를 직접 검증할 수 있다.
 *
 * spy를 걸지 않은 테스트가 하나라도 있으면 CI에서 실제 TEI 주소로 나간다.
 */

const BASE_URL = 'http://tei.test:8080';

/**
 * 인자 타입을 fetch 시그니처에 묶는다. 그냥 jest.SpyInstance로 두면
 * mock.calls가 any가 되어 단정마다 캐스팅을 붙이게 되고, 그러면 오타가 통과한다.
 */
let fetchSpy: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

async function createClient(): Promise<TeiClient> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => ({ TEI_BASE_URL: BASE_URL })],
      }),
    ],
    providers: [TeiClient],
  }).compile();
  return moduleRef.get(TeiClient);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse([[0.1, 0.2, 0.3]]));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TeiClient.embedQuery', () => {
  it('POST {TEI_BASE_URL}/embed로 나간다', async () => {
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://tei.test:8080/embed');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('바디가 core의 요청 형태와 정확히 일치한다', async () => {
    // 바디가 갈리면 같은 텍스트가 두 워크스페이스에서 다른 벡터가 된다.
    // core/src/clients/tei.ts:22-31과 짝이다.
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    expect(fetchSpy.mock.calls[0][1]?.body).toBe(
      '{"inputs":["실내 박물관"],"normalize":true,"truncate":true}',
    );
  });

  it('바디에 prompt_name 키가 없다', async () => {
    // bge-m3는 지시문 프리픽스 없이 동작한다. 색인이 만들어진 조건과
    // 다르게 질의할 수 있는 손잡이를 만들지 않는다.
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    expect(fetchSpy.mock.calls[0][1]?.body).not.toContain('prompt_name');
  });

  it('signal을 fetch 옵션에 전달한다', async () => {
    // 빠뜨리면 5초 타임아웃이 통째로 사라지고 아무 테스트도 깨지지 않는다.
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('첫 벡터를 number[]로 반환한다', async () => {
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).resolves.toEqual([
      0.1, 0.2, 0.3,
    ]);
  });

  it('반환 벡터의 길이를 검사하지 않는다', async () => {
    // 차원 판정은 Qdrant의 일이다. 여기서 검사하면 1024가 backend에 박히고,
    // TEI에 뜬 모델과 어긋나면 조용히 틀린 검색이 된다.
    fetchSpy.mockResolvedValue(jsonResponse([[1, 2, 3]]));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).resolves.toHaveLength(3);
  });

  it('빈 문자열은 fetch 없이 invalid-request로 거부한다', async () => {
    const client = await createClient();

    const failure = await client
      .embedQuery('')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect((failure as ExternalServiceError).kind).toBe('invalid-request');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('공백만 있는 입력도 fetch 없이 거부한다', async () => {
    const client = await createClient();

    await expect(client.embedQuery('   \n ')).rejects.toMatchObject({
      service: 'tei',
      kind: 'invalid-request',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('정상 문자열이면 fetch를 한 번 부른다', async () => {
    // 위 두 케이스와 짝이다. 이게 없으면 구현이 항상 거부해도 통과한다.
    const client = await createClient();
    await client.embedQuery('a');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('빈 배열 응답은 empty-response다', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([]));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('빈 벡터 응답도 empty-response다', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([[]]));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('400이면 TeiHttpError를 던지고 callExternal이 invalid-request로 만든다', async () => {
    const body = jsonResponse({ error: '입력이 너무 김' }, 400);
    const jsonSpy = jest.spyOn(body, 'json');
    fetchSpy.mockResolvedValue(body);
    const client = await createClient();

    const failure = await client
      .embedQuery('실내 박물관')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect(failure).toMatchObject({ service: 'tei', kind: 'invalid-request' });
    // 안쪽에서 던진 TeiHttpError가 cause로 보존돼야 로그에 상태가 남는다.
    expect((failure as ExternalServiceError).cause).toBeInstanceOf(
      TeiHttpError,
    );
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('500은 upstream이다', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: '모델 로딩 중' }, 500));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('!response.ok면 본문이 유효한 벡터처럼 생겼어도 던진다', async () => {
    // 상태 확인이 파싱보다 먼저인지 고정한다. 순서가 뒤집히면 TEI가 5xx와 함께
    // 우연히 배열 모양 본문을 돌려줄 때 쓰레기 벡터가 그대로 Qdrant로 간다 —
    // 실패가 조용히 성공으로 흐르는 경로다.
    const body = jsonResponse([[0.1, 0.2, 0.3]], 503);
    const jsonSpy = jest.spyOn(body, 'json');
    fetchSpy.mockResolvedValue(body);
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'upstream',
    });
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('중단은 timeout이다 (공통 판정 재사용)', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('시간 초과'), { name: 'TimeoutError' }),
    );
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      service: 'tei',
      kind: 'timeout',
    });
  });

  it('연결 거부는 unavailable이다 (cause에 숨어 있어도)', async () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    fetchSpy.mockRejectedValue(new TypeError('fetch failed', { cause: inner }));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});
