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

beforeEach(() => {
  generateContent.mockReset().mockResolvedValue({ text: '생성된 답변' });
  GoogleGenAIMock.mockReset().mockImplementation(() => ({
    models: { generateContent },
  }));
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
