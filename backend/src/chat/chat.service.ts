import { Injectable, Logger } from '@nestjs/common';

import { QdrantSearchClient } from '../clients/qdrant/qdrant.client';
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

/**
 * 장소 추천 갈래가 받아오는 검색 결과 개수. 고정값이다.
 *
 * QdrantSearchClient의 기본값도 10이지만 생략하지 않는다 — 개수가 이 갈래의
 * 사용자 계약이므로, 클라이언트 기본값이 바뀌면 조용히 따라 움직이는 자리에
 * 두지 않는다.
 */
const RECOMMEND_SEARCH_LIMIT = 10;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly intentClassifier: IntentClassifier,
    private readonly queryStructurer: QueryStructurer,
    private readonly otherResponder: OtherResponder,
    private readonly tei: TeiClient,
    private readonly qdrant: QdrantSearchClient,
  ) {}

  /**
   * 메시지를 분류해 갈래로 보낸다.
   *
   * 협력자 다섯이 던진 ExternalServiceError를 잡지 않는다 — 전역 필터가
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
   * 장소 목록을 붙여도 planStatus를 만들지 않는다 — 목록은 일정이 아니다.
   *
   * 검색은 벡터만으로 돈다. conditions를 payload 필터로 바꾸려면 이름을
   * ldong_regn_cd·contenttypeid로 옮기는 Postgres 코드표가 필요하고 그건
   * 사내망 전용이다(structured-query.ts의 QueryConditions 주석). 코드표 없이
   * 이름 문자열로 필터하면 payload의 어떤 값과도 매치되지 않아 전 요청이
   * "결과 없음"이 된다 — 필터를 안 거는 것보다 나쁘다.
   */
  private async replyRecommend(
    request: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    const query = await this.queryStructurer.structure(request.message);
    const embedding = await this.embedQueryText(query.queryText);

    if (embedding !== null) {
      await this.searchPlaces(embedding);
    }

    return buildChatResponse(buildRecommendReply(query), null);
  }

  /**
   * 질의 벡터로 장소를 찾는다.
   *
   * 실패는 삼키지 않는다. 여기서 빈 배열로 축퇴시키면 Qdrant 장애가 "조건에
   * 맞는 장소가 없다"로 둔갑하고, 사용자는 자기 조건을 고치려 든다.
   *
   * TODO: 돌려받은 이름을 응답 문구에 싣는 자리. 아직 소비자가 없어 hit 수만
   * 로그로 남긴다. 버려진 hit(payload 파싱 실패)이 있으면 이 수와 화면의 이름
   * 개수가 어긋나므로, 이 로그는 소비자가 붙은 뒤에도 대조 기준으로 남는다.
   */
  private async searchPlaces(embedding: number[]): Promise<string[]> {
    const hits = await this.qdrant.search(embedding, {
      limit: RECOMMEND_SEARCH_LIMIT,
    });

    this.logger.debug(`장소 검색 완료: hit=${hits.length}`);

    return hits.map((hit) => hit.payload.title);
  }

  /**
   * 재조립된 질의 텍스트를 벡터로 만든다.
   *
   * 임베딩 대상은 queryText 하나다. Gemini의 파싱 전 응답을 넘기지 않는다 —
   * '[조건]' 마커와 조건 줄이 벡터에 섞이면 core가 색인한 의미 축 텍스트와
   * 다른 공간이 되고, 같은 장소가 검색되지 않는다. 재조립이 임베딩 대상을
   * 만드는 공정이다(parseStructuredQuery의 '벡터에 들어가지 않는다' 주석).
   *
   * 공백뿐인 질의는 건너뛴다. @IsNotEmpty()가 공백 문자열을 통과시키므로
   * 구조화 폴백이 그 원문을 queryText로 쓰면 여기 도달하고, 그대로 넘기면
   * TeiClient가 invalid-request로 던져 200이던 갈래가 502가 된다 — 사용자
   * 입력 문제를 외부 서비스 장애로 오청구하게 된다(ChatRequestDto.message의
   * MaxLength와 같은 판단). 정상 경로의 queryText에는 라벨이 붙으므로
   * 이 분기는 폴백 전용이다.
   *
   * 실패는 삼키지 않는다 — 협력자 다섯에 같은 규칙이 걸린다.
   *
   * 건너뛴 요청은 null을 받는다. 호출자가 그 요청을 검색 없이 처리해야 하기
   * 때문이다 — 빈 배열을 벡터로 지어 넘기면 질의와 아무 관계 없는 이웃이
   * 추천으로 나간다. 차원 로그는 남긴다: 컬렉션과 맞아야 하는데 코드가
   * 강제하지 않아, 차원 불일치를 볼 수 있는 지점이 여기 하나다.
   */
  private async embedQueryText(queryText: string): Promise<number[] | null> {
    if (queryText.trim() === '') {
      this.logger.warn(
        '질의 임베딩 건너뜀: 질의 텍스트가 비어 있어 검색 재료를 만들지 못했습니다.',
      );
      return null;
    }

    const embedding = await this.tei.embedQuery(queryText);

    this.logger.debug(`질의 임베딩 완료: 차원=${embedding.length}`);

    return embedding;
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
