import { Injectable, Logger } from '@nestjs/common';

import { TeiClient } from '../clients/tei/tei.client';
import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { buildChatResponse } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildMockItinerary } from './plan/mock-itineraries';
import { buildPlanReply } from './plan/plan-reply';
import { buildRecommendReply } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly intentClassifier: IntentClassifier,
    private readonly queryStructurer: QueryStructurer,
    private readonly otherResponder: OtherResponder,
    private readonly tei: TeiClient,
  ) {}

  /**
   * 메시지를 분류해 갈래로 보낸다.
   *
   * 협력자 넷이 던진 ExternalServiceError를 잡지 않는다 — 전역 필터가
   * kind별로 500/502/503/504로 매핑한다. 여기서 삼키면 쿼터 소진이
   * "여행과 무관한 메시지"로 둔갑한다.
   */
  async chat(request: ChatRequestDto): Promise<ChatResponseDto> {
    const intent = await this.intentClassifier.classify(request.message);

    switch (intent) {
      // 두 갈래가 처음으로 실제로 갈린다. plan만 일정을 만들고 나머지 둘은
      // 만들지 않는다 — 직전 실행이 예고한 대로 묶은 case를 나눈다.
      case 'plan_itinerary':
        return this.replyPlan(request);
      case 'recommend_places':
        return this.replyRecommend(request);
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
   * 일정을 만드는 유일한 갈래. **`itinerary`가 만들어지는 지점도 여기 하나다** —
   * 그래서 planStatus의 단일 진실 원천이 유지된다.
   *
   * 요청의 일정을 보지 않는다. 목적지를 알아들으면 새 일정을, 못 알아들으면
   * null을 낸다(게이트 1 Q4). buildPlanReply가 같은 값에서 문구를 만들므로
   * "일정은 null인데 준비됐다고 말하는" 조합이 표현 불가능하다.
   *
   * TODO: 일정 생성(TEI 임베딩 + Qdrant 검색 + 조립)이 들어올 자리.
   * buildMockItinerary 호출 하나만 교체된다. 지금 돌려주는 것은 목적지 키워드로
   * 고른 고정 데이터이고 **생성이 아니다.**
   *
   * QueryStructurer를 부르지 않는다 — 목적지를 원문 키워드로 고르므로 구조화
   * 결과를 아무도 쓰지 않는다. 부르면 결과를 버리는 Gemini 왕복이 하나 늘고,
   * 그 왕복의 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다.
   */
  private replyPlan(request: ChatRequestDto): ChatResponseDto {
    const itinerary = buildMockItinerary(request.message);

    return buildChatResponse(buildPlanReply(itinerary), itinerary);
  }

  /**
   * 구조화 결과를 사용자에게 되비춘다. 이 갈래는 일정을 만들지 않으므로
   * itinerary가 **항상 null**이고 planStatus도 항상 'none'이다(게이트 1 Q3).
   *
   * 요청의 일정을 되돌려주지 않는다. 되돌려주면 "화면에 띄울 일정이 있다"를 이
   * 갈래도 주장하게 되고, planStatus를 만드는 지점이 둘로 늘어난다.
   *
   * TODO: 조건에 맞는 장소 목록을 붙이는 자리. 목록은 일정이 아니므로 이 갈래는
   * 그때도 planStatus를 만들지 않는다.
   */
  private async replyRecommend(
    request: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    const query = await this.queryStructurer.structure(request.message);

    await this.embedQueryText(query.queryText);

    return buildChatResponse(buildRecommendReply(query), null);
  }

  /**
   * 재조립된 질의 텍스트를 벡터로 만든다.
   *
   * 임베딩 대상은 queryText 하나다. Gemini의 파싱 전 응답을 넘기지 않는다 —
   * '[조건]' 마커와 조건 줄이 벡터에 섞이면 core가 색인한 의미 축 텍스트와
   * 다른 공간이 되고, 같은 장소가 검색되지 않는다. 재조립이 임베딩 대상을
   * 만드는 공정이다(parseStructuredQuery의 '벡터에 들어가지 않는다' 주석).
   *
   * 실패는 삼키지 않는다 — 협력자 넷에 같은 규칙이 걸린다.
   *
   * TODO: 이 벡터로 Qdrant를 검색하는 자리. 아직 소비자가 없어 차원만 남긴다.
   * 차원은 컬렉션과 맞아야 하는데 코드가 강제하지 않으므로, 이 로그가 붙는
   * 시점의 유일한 관측 수단이다.
   */
  private async embedQueryText(queryText: string): Promise<void> {
    const embedding = await this.tei.embedQuery(queryText);

    this.logger.debug(`질의 임베딩 완료: 차원=${embedding.length}`);
  }

  /**
   * 대화 응답을 만든다. 이 갈래도 일정을 만들지 않으므로 항상 null이다 —
   * 위 두 갈래와 달리 TODO가 없다. 이것이 최종 형태다.
   */
  private async replyOther(request: ChatRequestDto): Promise<ChatResponseDto> {
    return buildChatResponse(
      await this.otherResponder.respond(request.message),
      null,
    );
  }
}
