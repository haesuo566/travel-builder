import { Injectable } from '@nestjs/common';

import { GeminiClient } from '../../clients/gemini/gemini.client';
import type { ChatIntent } from './chat-intent';
import {
  buildIntentPrompt,
  INTENT_SYSTEM_INSTRUCTION,
  parseIntent,
} from './intent-prompt';

@Injectable()
export class IntentClassifier {
  constructor(private readonly gemini: GeminiClient) {}

  /**
   * 메시지를 세 분류값 중 하나로 판정한다.
   *
   * Gemini 호출 자체의 실패는 삼키지 않는다 — GeminiClient가 만든
   * ExternalServiceError가 그대로 올라간다.
   */
  async classify(message: string): Promise<ChatIntent> {
    const raw = await this.gemini.generate(buildIntentPrompt(message), {
      systemInstruction: INTENT_SYSTEM_INSTRUCTION,
      temperature: 0,
    });

    // 해석 불가 시의 관측(warn 로그)은 다음 태스크에서 붙인다.
    return parseIntent(raw) ?? 'other';
  }
}
