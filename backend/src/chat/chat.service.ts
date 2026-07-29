import { Injectable } from '@nestjs/common';

import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildStructuredReply } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';

@Injectable()
export class ChatService {
  constructor(
    private readonly intentClassifier: IntentClassifier,
    private readonly queryStructurer: QueryStructurer,
    private readonly otherResponder: OtherResponder,
  ) {}

  /**
   * 메시지를 분류해 갈래로 보낸다.
   *
   * 협력자 셋이 던진 ExternalServiceError를 잡지 않는다 — 전역 필터가
   * kind별로 500/502/503/504로 매핑한다. 여기서 삼키면 쿼터 소진이
   * "여행과 무관한 메시지"로 둔갑한다.
   */
  async chat(request: ChatRequestDto): Promise<ChatResponseDto> {
    const intent = await this.intentClassifier.classify(request.message);

    switch (intent) {
      // 두 갈래를 묶는다. 오늘 유일한 차이는 buildStructuredReply에 넘기는
      // intent이고, 케이스를 묶으면 그 사실이 주석이 아니라 구조가 된다.
      // 묶인 케이스에서 intent가 buildStructuredReply의 파라미터 타입으로
      // 정확히 좁혀지므로 리터럴을 다시 적지도 않는다.
      case 'plan_itinerary':
      case 'recommend_places':
        return this.replyStructured(intent, request);
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
   * 구조화 결과를 사용자에게 되비춘다.
   *
   * TODO: TEI 임베딩 + Qdrant 검색과 일정 조립을 붙이는 자리. 그때 두 갈래가
   * 갈라지므로 이 메서드도 함께 나뉜다 — 지금 나눠 두면 같은 본문이 둘이 된다.
   * itinerary는 아직 손대지 않는다.
   */
  private async replyStructured(
    intent: 'plan_itinerary' | 'recommend_places',
    request: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    const query = await this.queryStructurer.structure(request.message);

    return {
      reply: buildStructuredReply(intent, query),
      itinerary: request.itinerary,
    };
  }

  /**
   * 대화 응답을 만든다. 이 갈래는 일정을 만들지 않으므로 itinerary가
   * 입력 그대로 나가는 것이 최종 형태다 — 위 두 갈래와 달리 TODO가 없다.
   */
  private async replyOther(request: ChatRequestDto): Promise<ChatResponseDto> {
    return {
      reply: await this.otherResponder.respond(request.message),
      itinerary: request.itinerary,
    };
  }
}
