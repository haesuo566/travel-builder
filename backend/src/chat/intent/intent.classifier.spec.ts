import { Test } from '@nestjs/testing';

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

beforeEach(() => {
  generate.mockReset();
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
