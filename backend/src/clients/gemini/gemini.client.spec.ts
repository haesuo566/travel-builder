import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('@google/genai', () => ({ GoogleGenAI: jest.fn() }));

import { GoogleGenAI } from '@google/genai';
import type { GenerateContentParameters } from '@google/genai';

import { ExternalServiceError } from '../external-service.error';
import { GeminiClient } from './gemini.client';

/**
 * 모킹 경계는 SDK 모듈이다. 우리 클래스를 모킹하면 아무것도 검증하지 않고,
 * HTTP 레벨로 내리면 검증 대상이 SDK 내부 동작까지 넓어진다.
 */

const GoogleGenAIMock = GoogleGenAI as unknown as jest.Mock;

/**
 * 인자 타입을 SDK 시그니처(GenerateContentParameters)에 묶는다.
 * mock.calls[0][0]을 캐스팅으로 꺼내면 .config를 .cofnig로 써도 통과하고
 * 런타임에 undefined가 되는데, 이렇게 두면 컴파일 단계에서 잡힌다.
 *
 * 반환 타입은 SDK의 GenerateContentResponse 클래스 전체가 아니라 우리가 읽는
 * 필드만 적는다 — 테스트마다 쓰지도 않는 필드를 채울 이유가 없다.
 */
const generateContent = jest.fn<
  Promise<{ text?: string }>,
  [GenerateContentParameters]
>();

async function createClient(
  env: Record<string, string> = { GEMINI_API_KEY: 'test-key' },
): Promise<GeminiClient> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      // 개발자의 .env·셸 환경에 의존하면 키가 설정된 머신에서만 통과하는 테스트가 된다.
      // process.env가 load보다 우선하므로 skipProcessEnv까지 켠다.
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => env],
      }),
    ],
    providers: [GeminiClient],
  }).compile();
  return moduleRef.get(GeminiClient);
}

/**
 * Logger.error의 첫 인자가 any라 여기서 한 번만 좁힌다.
 * unknown을 거치는 것은 call-external.spec.ts:22-25와 같은 이유다 —
 * jest.SpyInstance의 mock.calls 원소가 any로 추론돼 no-unsafe-member-access에 걸린다.
 */
function loggedText(spy: jest.SpyInstance, call = 0): string {
  const calls = spy.mock.calls as unknown as unknown[][];
  return String(calls[call][0]);
}

let errorLog: jest.SpyInstance;

beforeEach(() => {
  generateContent.mockReset().mockResolvedValue({ text: '생성된 답변' });
  GoogleGenAIMock.mockReset().mockImplementation(() => ({
    models: { generateContent },
  }));
  // 실패 경로를 도는 테스트가 여럿이라 스파이를 걸지 않으면 콘솔이 ERROR로 덮인다.
  // 그보다 중요한 이유는 이 파일이 만드는 로그를 단정할 대상으로 삼는 것이다.
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GeminiClient', () => {
  it('생성자가 네트워크를 만지지 않는다', async () => {
    await createClient();

    expect(GoogleGenAIMock).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('model·contents·systemInstruction·temperature를 SDK에 넘긴다', async () => {
    const client = await createClient();
    await client.generate('안녕', {
      model: 'gemini-2.5-pro',
      systemInstruction: '너는 여행 플래너다',
      temperature: 0.3,
    });

    // 중첩 expect.objectContaining은 any를 반환해 config의 타입을 지운다
    // (eslint no-unsafe-assignment). 기록된 인자를 그대로 읽으면 타입이 살아 있어
    // .config를 .cofnig로 쓰면 컴파일이 깨진다.
    const [params] = generateContent.mock.calls[0];
    expect(params.model).toBe('gemini-2.5-pro');
    expect(params.contents).toBe('안녕');
    expect(params.config?.systemInstruction).toBe('너는 여행 플래너다');
    expect(params.config?.temperature).toBe(0.3);
  });

  it('model 미지정이면 GEMINI_MODEL 기본값을 쓴다', async () => {
    const client = await createClient();
    await client.generate('안녕');

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.0-flash' }),
    );
  });

  it('GEMINI_MODEL이 있으면 그 값을 쓴다', async () => {
    const client = await createClient({
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-2.5-flash',
    });
    await client.generate('안녕');

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash' }),
    );
  });

  it('GEMINI_MODEL이 빈 문자열이어도 기본값으로 폴백한다', async () => {
    // ConfigService.get(key, default)는 undefined일 때만 폴백한다. core의
    // optionalEnv(core/src/lib/env.ts:11-17)는 ''도 폴백하므로, 두 번째 인자를
    // 쓰면 .env에 "GEMINI_MODEL="(값만 빈 줄) 한 줄로 같은 파일에서
    // core는 돌고 backend만 죽는다. 빈 모델명이 그대로 SDK에 실려 404가 되는데
    // 응답도 로그도 모델명이 비었다는 걸 말해주지 않는다.
    const client = await createClient({
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: '',
    });
    await client.generate('안녕');

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.0-flash' }),
    );
  });

  it('opts.model이 빈 문자열이어도 기본값으로 폴백한다', async () => {
    // ?? 는 nullish라 ''를 거르지 않는다. env와 호출 인자 두 경로 모두 막는다.
    const client = await createClient();
    await client.generate('안녕', { model: '' });

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.0-flash' }),
    );
  });

  it('systemInstruction·temperature 미지정 시 undefined를 넘긴다', async () => {
    // 지정 시 전달만 보면 "언제나 넘긴다"와 "지정했을 때만 넘긴다"를 구별하지
    // 못한다. 여기에 빈 문자열이나 0이 들어가면 SDK가 그것을 유효한 설정으로
    // 받아 모델 동작이 조용히 달라진다.
    const client = await createClient();
    await client.generate('안녕');

    const [params] = generateContent.mock.calls[0];
    expect(params.config?.systemInstruction).toBeUndefined();
    expect(params.config?.temperature).toBeUndefined();
  });

  it('abortSignal을 SDK에 전달한다', async () => {
    // 빠뜨리면 20초 타임아웃이 통째로 사라지고 아무 테스트도 깨지지 않는다.
    const client = await createClient();
    await client.generate('안녕');

    // 캐스팅이 없다. jest.fn의 인자 타입이 GenerateContentParameters라
    // .config를 잘못 쓰면 여기서 컴파일이 깨진다.
    const { config } = generateContent.mock.calls[0][0];
    expect(config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(config?.abortSignal?.aborted).toBe(false);
  });

  it('타임아웃을 20초로 요청한다', async () => {
    // 신호의 존재만 보면 20초가 200ms가 돼도 통과한다. AbortSignal은 남은 시간을
    // 노출하지 않고, AbortSignal.timeout의 타이머는 Node 내부라 jest 가짜 타이머가
    // 가로채지 못한다 — 그래서 경과가 아니라 요청한 값을 본다.
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const client = await createClient();
    await client.generate('안녕');

    expect(timeout).toHaveBeenCalledWith(20_000);
  });

  it('응답 텍스트를 그대로 반환한다', async () => {
    generateContent.mockResolvedValue({ text: '  앞뒤 공백 있는 답변  ' });
    const client = await createClient();

    await expect(client.generate('안녕')).resolves.toBe(
      '  앞뒤 공백 있는 답변  ',
    );
  });

  it('빈 문자열 응답은 empty-response로 끊는다', async () => {
    // core는 빈 문자열을 성공으로 돌려주지만(core/src/clients/gemini.ts:31)
    // backend에는 뒤에 붙은 검증기가 없어 빈 채팅 말풍선이 그대로 렌더된다.
    generateContent.mockResolvedValue({ text: '' });
    const client = await createClient();

    const failure = await client
      .generate('안녕')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect((failure as ExternalServiceError).kind).toBe('empty-response');
  });

  it('공백만 있는 응답도 empty-response다', async () => {
    generateContent.mockResolvedValue({ text: '   \n  ' });
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('text가 undefined면 empty-response다', async () => {
    generateContent.mockResolvedValue({});
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('429는 quota로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      service: 'gemini',
      kind: 'quota',
    });
  });

  it('401은 auth로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('500은 upstream으로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('server error'), { status: 500 }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('중단은 timeout으로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('GeminiClient — 로그 계약', () => {
  /**
   * callExternal의 마스킹은 원인 메시지에만 걸린다. operation에 실은 것은
   * 무엇이든 날것으로 로그에 간다 — 그리고 마스킹은 자격증명 패턴을 노리는 것이라
   * 실명·카드번호는 애초에 잡지 못한다. 방어는 operation에 사용자 데이터를
   * 넣지 않는 것뿐이고, 그 계약을 지키는 것은 이 테스트다.
   */

  const PROMPT =
    '홍길동, 카드번호 4111-1111-1111-1111 로 제주 3박4일 일정을 짜줘';
  const SYSTEM_INSTRUCTION = '너는 사내 규정 문서 X를 아는 여행 플래너다';

  async function generateAndFail(): Promise<void> {
    generateContent.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    );
    const client = await createClient();
    await client
      .generate(PROMPT, { systemInstruction: SYSTEM_INSTRUCTION })
      .catch(() => undefined);
  }

  it('실패 로그에 프롬프트 원문이 남지 않는다', async () => {
    await generateAndFail();

    const logged = loggedText(errorLog);
    expect(logged).not.toContain('홍길동');
    expect(logged).not.toContain('4111-1111-1111-1111');
    expect(logged).not.toContain('제주 3박4일');
  });

  it('실패 로그에 systemInstruction 원문이 남지 않는다', async () => {
    await generateAndFail();

    expect(loggedText(errorLog)).not.toContain('사내 규정 문서 X');
  });

  it('실패 로그에 프롬프트 길이는 남는다', async () => {
    // 반대 방향 짝. 과잉 방어로 진단 정보까지 지우면 어떤 요청이 실패했는지
    // 추적할 수 없고, "아무것도 안 남긴다"가 계약을 만족시켜 버린다.
    await generateAndFail();

    const logged = loggedText(errorLog);
    expect(logged).toContain(`prompt=${PROMPT.length}자`);
    expect(logged).toContain('gemini');
    expect(logged).toContain('auth');
  });
});
