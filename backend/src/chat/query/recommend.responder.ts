import { Injectable, Logger } from '@nestjs/common';

import { GeminiClient } from '../../clients/gemini/gemini.client';
import { buildConditionSummary, buildPlacesTail } from './query-reply';
import type { RecommendPlace } from './recommend-prompt';
import {
  buildRecommendPrompt,
  RECOMMEND_REPLY_MAX_LENGTH,
  RECOMMEND_SYSTEM_INSTRUCTION,
  validateRecommendReply,
} from './recommend-prompt';
import type { StructuredQuery } from './structured-query';

/**
 * 찾은 장소를 소개하는 맺음말을 모델에게 쓰게 한다.
 *
 * **이 클래스가 "모델의 자유 텍스트를 싣지 않는다"는 추천 갈래의 원칙을
 * 뒤집는다**(사용자 요청). 뒤집힌 것은 맺음말 하나뿐이고, 머리말과 조건 요약은
 * composeRecommendReply가 계속 결정론적으로 만든다 — 모델이 조건을 흘리거나
 * 지어내도 사용자가 대조할 원본이 화면에 함께 나간다.
 *
 * ChatService가 GeminiClient를 직접 주입받지 않는다. IntentClassifier·
 * QueryStructurer·OtherResponder와 같은 모양으로, 목적별 클래스가 프롬프트와
 * 검증을 함께 소유한다.
 */
@Injectable()
export class RecommendResponder {
  private readonly logger = new Logger(RecommendResponder.name);

  constructor(private readonly gemini: GeminiClient) {}

  /**
   * 찾은 장소들의 소개 맺음말을 만든다.
   *
   * places가 비어 있는 채로 불리지 않는다 — 소개할 것이 없으면 호출자가 애초에
   * 부르지 않는다(결과를 버리는 Gemini 왕복을 늘리지 않는다는 이 갈래의 규칙).
   * 빈 이름도 호출자가 이미 걸렀다.
   *
   * 검증에 걸리면 warn 1건을 남기고 이름 목록으로 대체한다 — 반환 타입에 null이
   * 없는 것이 그 계약이다. OtherResponder의 고정 문구와 달리 이쪽 폴백은 실제
   * 검색 결과를 담으므로, 대체가 발동해도 사용자는 여전히 찾은 장소를 받는다.
   *
   * Gemini 호출 실패는 삼키지 않는다. ExternalServiceError가 그대로 올라간다 —
   * 여기서 잡으면 쿼터 소진이 정상 응답과 구별되지 않는다.
   */
  async describe(
    message: string,
    query: StructuredQuery,
    places: RecommendPlace[],
  ): Promise<string> {
    const prompt = buildRecommendPrompt(
      message,
      buildConditionSummary(query.conditions),
      places,
    );

    const raw = await this.gemini.generate(prompt, {
      systemInstruction: RECOMMEND_SYSTEM_INSTRUCTION,
      // other 갈래와 같은 값이다. 결정성이 값을 하는 것은 재현 가능한 벡터를
      // 만드는 구조화 호출이고, 소개 문장에는 그런 하류 소비자가 없다.
      temperature: 0.7,
    });

    const tail = validateRecommendReply(raw);
    if (tail !== null) return tail;

    // 응답 조각을 남기지 않는다. 자유 텍스트라 사용자 문장을 되풀이할 수 있고,
    // 실패 모양은 길이 숫자 하나로 구별된다(상한 초과인가 빈 응답인가).
    this.logger.warn(
      `추천 소개 폴백: gemini 응답이 상한(${RECOMMEND_REPLY_MAX_LENGTH}자)을 넘거나 비어 이름 목록으로 대체했습니다 (길이=${raw.length})`,
    );
    return buildPlacesTail(places.map((place) => place.title));
  }
}
