import { Injectable, Logger } from '@nestjs/common';

import { GeminiClient } from '../../clients/gemini/gemini.client';
import type { ChatIntent } from './chat-intent';
import {
  buildIntentPrompt,
  INTENT_SYSTEM_INSTRUCTION,
  normalizeIntentText,
  parseIntent,
} from './intent-prompt';

/**
 * 폴백 로그에 남기는 정규화 결과의 상한.
 *
 * 이 로그가 답해야 하는 질문은 "프롬프트의 무엇을 고쳐야 하는가"이고, 실제 실패
 * 모양은 앞머리에서 드러난다 — 접두어·설명문·다른 언어·마크다운 목록 모두 40자
 * 안에서 구별된다. 넘겨서 문단 전체를 남기면 얻는 정보는 거의 없고 사용자
 * 문장이 통째로 실릴 위험만 커진다.
 */
const LOG_SNIPPET_LIMIT = 40;

@Injectable()
export class IntentClassifier {
  private readonly logger = new Logger(IntentClassifier.name);

  constructor(private readonly gemini: GeminiClient) {}

  /**
   * 메시지를 세 분류값 중 하나로 판정한다.
   *
   * 응답을 해석할 수 없으면 warn 로그를 남기고 'other'를 반환한다 —
   * 반환 타입에 null이 없는 것이 그 계약이다. HTTP 응답에서 진짜 other와
   * 구별되지 않으므로 구별은 이 로그 하나에만 존재한다.
   *
   * 반면 Gemini 호출 자체의 실패는 삼키지 않는다. GeminiClient가 만든
   * ExternalServiceError가 그대로 올라간다 — 여기에 try/catch를 두면
   * 쿼터 소진이 "여행과 무관한 메시지"로 둔갑한다.
   */
  async classify(message: string): Promise<ChatIntent> {
    const raw = await this.gemini.generate(buildIntentPrompt(message), {
      systemInstruction: INTENT_SYSTEM_INSTRUCTION,
      temperature: 0,
    });

    const intent = parseIntent(raw);
    if (intent !== null) return intent;

    // callExternal은 generate가 성공한 뒤의 판정을 모른다. 여기서 남기지 않으면
    // 폴백은 어디에도 흔적이 없다 — 응답은 200이고 본문도 정상이다.
    const snippet = normalizeIntentText(raw).slice(0, LOG_SNIPPET_LIMIT);
    this.logger.warn(
      `intent 폴백: gemini 응답이 분류값이 아니라 other로 처리했다 (길이=${raw.length}): "${snippet}"`,
    );
    return 'other';
  }
}
