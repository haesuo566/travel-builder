import { Injectable, Logger } from '@nestjs/common';

import { GeminiClient } from '../../clients/gemini/gemini.client';
import { OTHER_REPLY } from '../chat.service';
import {
  buildOtherPrompt,
  OTHER_REPLY_MAX_LENGTH,
  OTHER_SYSTEM_INSTRUCTION,
  validateOtherReply,
} from './other-prompt';

@Injectable()
export class OtherResponder {
  private readonly logger = new Logger(OtherResponder.name);

  constructor(private readonly gemini: GeminiClient) {}

  /**
   * 메시지에 대화 응답을 만든다.
   *
   * 검증에 걸리면 warn 1건을 남기고 OTHER_REPLY로 대체한다 — 반환 타입에 null이
   * 없는 것이 그 계약이다. 폴백할 곳이 이미 있다는 점이 분류기와 같다: 분류기에는
   * 폴백할 'other'가 있었고, 이 갈래에는 프론트 mock과 같은 고정 문구가 있다.
   *
   * 이 폴백은 특히 조용하다 — OTHER_REPLY는 직전 실행에서 이 갈래의 정상 응답이었으므로
   * 대체가 늘 발동해도 화면은 직전 실행과 똑같다. 즉 "대화 응답이 통째로 안 되고
   * 있다"는 상태가 사용자 눈에 정상으로 보인다. 관측은 아래 warn 하나에 걸려 있다.
   *
   * Gemini 호출 실패는 삼키지 않는다. ExternalServiceError가 그대로 올라간다.
   */
  async respond(message: string): Promise<string> {
    const raw = await this.gemini.generate(buildOtherPrompt(message), {
      systemInstruction: OTHER_SYSTEM_INSTRUCTION,
      // 0을 쓰지 않는다. 결정성이 값을 하는 것은 재현 가능한 벡터를 만드는
      // 구조화 호출이고, 대화 응답에는 그에 대응하는 하류 소비자가 없다.
      // 지정하지 않는 선택도 기각했다 — GEMINI_MODEL이 움직이는 별칭이라
      // SDK 기본값에 맡기면 움직이는 부분이 둘이 된다.
      temperature: 0.7,
    });

    const reply = validateOtherReply(raw);
    if (reply !== null) return reply;

    // 40자 조각을 남기지 않는다. 분류기의 조각은 응답이 라벨 하나였기 때문에
    // 안전했지만, 여기서는 응답이 자유 텍스트이고 사용자 문장을 되풀이할
    // 가능성이 높다. 실패 모양은 길이 숫자 하나로 구별된다(상한 초과인가 빈 응답인가).
    this.logger.warn(
      `other 응답 폴백: gemini 응답이 상한(${OTHER_REPLY_MAX_LENGTH}자)을 넘거나 비어 고정 문구로 대체했습니다 (길이=${raw.length})`,
    );
    return OTHER_REPLY;
  }
}
