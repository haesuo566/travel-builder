import { Injectable } from '@nestjs/common';

import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';

/**
 * 분기별 임시 문구. 실제 구현이 들어오면 해당 상수와 메서드 본문이 함께 사라진다.
 * export하는 것은 테스트 때문이지 공개 계약이기 때문이 아니다.
 */
export const PLAN_ITINERARY_PLACEHOLDER_REPLY =
  '일정을 새로 짜 드리는 기능은 아직 준비 중이에요. 조금만 기다려 주세요.';

export const RECOMMEND_PLACES_PLACEHOLDER_REPLY =
  '여행지를 추천해 드리는 기능은 아직 준비 중이에요. 조금만 기다려 주세요.';

/** 프론트엔드 mock의 폴백 문구(frontend/src/lib/mock/scenarios.ts:39-43)와 같은 값이다. */
export const OTHER_REPLY =
  "어디로 떠나고 싶으신가요? '제주 2박3일'처럼 목적지와 기간을 말씀해주시면 바로 일정을 만들어드릴게요.";

@Injectable()
export class ChatService {
  constructor(private readonly intentClassifier: IntentClassifier) {}

  /**
   * 메시지를 분류해 갈래로 보낸다. 각 갈래의 실제 응답 생성은 아직 없다.
   *
   * 분류기가 던진 ExternalServiceError를 잡지 않는다 — 전역 필터가
   * kind별로 500/502/503/504로 매핑한다. 여기서 삼키면 쿼터 소진이
   * "여행과 무관한 메시지"로 둔갑한다.
   */
  async chat(request: ChatRequestDto): Promise<ChatResponseDto> {
    const intent = await this.intentClassifier.classify(request.message);

    switch (intent) {
      case 'plan_itinerary':
        return this.planItinerary(request);
      case 'recommend_places':
        return this.recommendPlaces(request);
      case 'other':
        return this.replyOther(request);
      default: {
        // 컴파일 타임 exhaustiveness 확인 수단이다. parseIntent가 CHAT_INTENTS
        // 멤버십을 이미 확인하므로 런타임에 도달하지 않는다. 4번째 분류값을
        // 더하면 이 대입이 컴파일 에러를 낸다.
        const exhaustive: never = intent;
        throw new Error(`분류되지 않은 intent: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * TODO: 여행지 검색(TEI+Qdrant)과 일정 생성을 붙이는 자리.
   * 붙으면 async가 되고 itinerary를 실제로 바꾼다.
   */
  private planItinerary(request: ChatRequestDto): ChatResponseDto {
    return {
      reply: PLAN_ITINERARY_PLACEHOLDER_REPLY,
      itinerary: request.itinerary,
    };
  }

  /** TODO: TEI 임베딩 + Qdrant 검색으로 장소 목록을 만드는 자리. */
  private recommendPlaces(request: ChatRequestDto): ChatResponseDto {
    return {
      reply: RECOMMEND_PLACES_PLACEHOLDER_REPLY,
      itinerary: request.itinerary,
    };
  }

  /** 세 갈래 중 유일하게 완성된 분기다. 안내 문구만 돌려준다. */
  private replyOther(request: ChatRequestDto): ChatResponseDto {
    return {
      reply: OTHER_REPLY,
      itinerary: request.itinerary,
    };
  }
}
