import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../../clients/external-service.error';
import type { GeminiGenerateOptions } from '../../clients/gemini/gemini.client';
import { GeminiClient } from '../../clients/gemini/gemini.client';
import { CHAT_INTENTS } from './chat-intent';
import type { ChatIntent } from './chat-intent';
import { INTENT_SYSTEM_INSTRUCTION } from './intent-prompt';
import { IntentClassifier } from './intent.classifier';

/**
 * 모킹 경계는 GeminiClient다. @google/genai를 다시 모킹하지 않는다 —
 * 그건 gemini.client.spec.ts의 몫이고, 여기서 반복하면 같은 것을 두 곳에서
 * 검증한다. 파서·프롬프트는 실물을 태운다.
 */

const generate = jest.fn<Promise<string>, [string, GeminiGenerateOptions?]>();

async function createClassifier(): Promise<IntentClassifier> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      IntentClassifier,
      { provide: GeminiClient, useValue: { generate } },
    ],
  }).compile();
  return moduleRef.get(IntentClassifier);
}

/**
 * warn 로그 메시지.
 * jest.SpyInstance의 mock.calls 원소는 any로 추론돼 no-unsafe-member-access에
 * 걸린다. unknown을 거쳐 좁힌다(call-external.spec.ts:22-25와 같은 이유).
 */
function firstWarnMessage(spy: jest.SpyInstance): string {
  const calls = spy.mock.calls as unknown as unknown[][];
  return String(calls[0][0]);
}

let warnLog: jest.SpyInstance;

beforeEach(() => {
  generate.mockReset();
  // 폴백 경로를 도는 테스트가 여럿이라 스파이를 걸지 않으면 콘솔이 WARN으로 덮인다.
  // 그보다 중요한 이유는 이 파일이 만드는 로그를 단정 대상으로 삼는 것이다.
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('IntentClassifier — 호출 계약', () => {
  it('systemInstruction·temperature 0·model 미지정으로 호출하고 프롬프트에 메시지를 담는다', async () => {
    generate.mockResolvedValue('plan_itinerary');
    const classifier = await createClassifier();

    await classifier.classify('제주 2박3일 일정 짜줘');

    // 중첩 expect.objectContaining은 any를 반환해 opts의 타입을 지운다
    // (eslint no-unsafe-assignment). 기록된 인자를 그대로 읽으면 타입이 살아 있다.
    const [prompt, opts] = generate.mock.calls[0];
    expect(prompt).toContain('제주 2박3일 일정 짜줘');
    expect(opts?.systemInstruction).toBe(INTENT_SYSTEM_INSTRUCTION);
    // 0이 ??나 ||에 삼켜지면 모델이 기본 temperature로 돈다. toBe(0)이 그 회귀를 잡는다.
    expect(opts?.temperature).toBe(0);
    // 모델은 지정하지 않는다 — GEMINI_MODEL 또는 클라이언트 기본값을 쓴다.
    expect(opts?.model).toBeUndefined();
  });

  it('generate를 한 번만 호출한다', async () => {
    generate.mockResolvedValue('other');
    const classifier = await createClassifier();

    await classifier.classify('안녕');

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(CHAT_INTENTS)(
    'gemini가 %s를 반환하면 그 값으로 판정한다',
    async (intent: ChatIntent) => {
      generate.mockResolvedValue(intent);
      const classifier = await createClassifier();

      await expect(classifier.classify('아무 말')).resolves.toBe(intent);
    },
  );
});

describe('IntentClassifier — 폴백 관측', () => {
  /**
   * 폴백은 반환값이 진짜 other와 같으므로 반환값만 단정하는 테스트로는 두 경로를
   * 구별할 수 없다. 그래서 짝을 반환값이 아니라 로그 유무로 만든다.
   */
  const UNPARSEABLE = '분류: plan_itinerary 입니다';

  it('해석 불가 응답을 예외 없이 other로 폴백하고 warn 1건을 남긴다', async () => {
    generate.mockResolvedValue(UNPARSEABLE);
    const classifier = await createClassifier();

    await expect(classifier.classify('제주 2박3일 일정 짜줘')).resolves.toBe(
      'other',
    );

    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(firstWarnMessage(warnLog)).toContain(`길이=${UNPARSEABLE.length}`);
  });

  it('명시적 other는 폴백이 아니다 — warn을 남기지 않는다', async () => {
    // ↔ 짝. 이 케이스가 없으면 항상 warn을 남기는 구현도 통과하고,
    // 그러면 로그가 오분류의 신호가 아니라 상수가 된다.
    generate.mockResolvedValue('other');
    const classifier = await createClassifier();

    await expect(classifier.classify('안녕')).resolves.toBe('other');

    expect(warnLog).not.toHaveBeenCalled();
  });

  it('폴백 로그가 정규화 결과 40자까지만 남긴다', async () => {
    // 원시 응답을 통째로 흘리는 회귀 방어. 모델이 규칙을 어기고 사용자 문장을
    // 되풀이할 수 있으므로 상한이 노출을 문장 조각 수준으로 묶는다.
    generate.mockResolvedValue('x'.repeat(200));
    const classifier = await createClassifier();

    await classifier.classify('안녕');

    const logged = firstWarnMessage(warnLog);
    expect(logged).toContain('길이=200');
    expect(logged).toContain('x'.repeat(40));
    expect(logged).not.toContain('x'.repeat(41));
  });
});

describe('IntentClassifier — 폴백의 경계선', () => {
  /**
   * 해석 불가는 "모델이 뭐라 했는지 모른다"이고, 쿼터 소진은 "모델이 대답할 수
   * 없었다"는 확정된 사실이다. 확정된 사실을 추측으로 덮지 않는다 —
   * classify를 try/catch로 감싸면 쿼터 소진이 "여행과 무관한 메시지"가 되고
   * Retry-After도 503도 사라진다.
   */
  function quotaFailure(): ExternalServiceError {
    return new ExternalServiceError('gemini', 'quota', '쿼터 소진');
  }

  it('gemini 호출 실패는 같은 인스턴스로 그대로 올라간다', async () => {
    const failure = quotaFailure();
    generate.mockRejectedValue(failure);
    const classifier = await createClassifier();

    await expect(classifier.classify('안녕')).rejects.toBe(failure);
  });

  it('호출 실패에는 폴백 warn을 남기지 않는다', async () => {
    // ↔ 짝. 실패 로그는 callExternal의 몫이다. 여기서 warn을 남기면
    // 폴백 로그와 실패 로그가 섞여 "오분류 관측"이라는 신호가 오염된다.
    generate.mockRejectedValue(quotaFailure());
    const classifier = await createClassifier();

    await classifier.classify('안녕').catch(() => undefined);

    expect(warnLog).not.toHaveBeenCalled();
  });
});
