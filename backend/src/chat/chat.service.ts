import { Injectable, Logger } from '@nestjs/common';

import { QdrantSearchClient } from '../clients/qdrant/qdrant.client';
import { TeiClient } from '../clients/tei/tei.client';
import type { TourContent } from '../database/entities';
import { TourContentLookup } from '../database/tour-content.lookup';
import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { buildChatResponse } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildPlanReply } from './plan/plan-reply';
import {
  buildRecommendReply,
  composeRecommendReply,
} from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';
import { RecommendResponder } from './query/recommend.responder';
import type { StructuredQuery } from './query/structured-query';

/**
 * 장소를 찾는 갈래가 받아오는 검색 결과 개수. 고정값이다.
 *
 * plan·recommend 두 갈래가 공유한다. 갈래별로 나누지 않는 이유는 같은 질의가
 * 갈래에 따라 다른 수의 장소를 받을 근거가 없기 때문이다 — 갈리면 사용자는
 * 문장을 어떻게 시작했는지에 따라 후보 폭이 달라지는 것을 설명받지 못한다.
 *
 * QdrantSearchClient의 기본값도 10이지만 생략하지 않는다 — 개수가 이 갈래들의
 * 사용자 계약이므로, 클라이언트 기본값이 바뀌면 조용히 따라 움직이는 자리에
 * 두지 않는다.
 */
const PLACE_SEARCH_LIMIT = 10;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly intentClassifier: IntentClassifier,
    private readonly queryStructurer: QueryStructurer,
    private readonly otherResponder: OtherResponder,
    private readonly tei: TeiClient,
    private readonly qdrant: QdrantSearchClient,
    private readonly tourContents: TourContentLookup,
    private readonly recommendResponder: RecommendResponder,
  ) {}

  /**
   * 메시지를 분류해 갈래로 보낸다.
   *
   * 협력자 일곱이 던진 ExternalServiceError를 잡지 않는다 — 전역 필터가
   * kind별로 500/502/503/504로 매핑한다. 여기서 삼키면 쿼터 소진이
   * "여행과 무관한 메시지"로 둔갑한다.
   */
  async chat(request: ChatRequestDto): Promise<ChatResponseDto> {
    const intent = await this.intentClassifier.classify(request.message);

    switch (intent) {
      // plan과 recommend는 같은 파이프라인을 타고 planStatus도 둘 다 'none'이다.
      // 갈리는 것은 찾은 장소를 무엇으로 만드느냐뿐이며, 오늘 그 차이는 문구
      // 하나로만 나타난다 — 두 case를 다시 묶지 않는 이유는 조립이 들어올 자리가
      // replyPlan이기 때문이다.
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
   * 일정 요청을 받아 **일정에 넣을 후보 장소까지** 찾는다.
   *
   * itinerary가 항상 null이다. 앞 단계(구조화 → 임베딩 → 검색 → 조회)는
   * replyRecommend와 완전히 같고, 갈리는 것은 마지막 하나뿐이다 — 찾은 장소를
   * **day별로 배치하는 조립이 아직 없다.** 조립 없이 채울 수 있는 itinerary는
   * 지어낸 일정뿐이고, 틀린 일정을 자신 있게 보여주는 것이 아무것도 보여주지
   * 않는 것보다 나쁘다. 그래서 planStatus는 이 갈래에서도 'none'이다.
   *
   * TODO: 조립이 들어올 자리. 찾은 장소를 day·시간·핀 번호에 배치해
   * ItineraryDto를 만들면 buildChatResponse의 두 번째 인자만 바뀌고,
   * PLAN_NOT_ASSEMBLED_NOTE와 그것을 잇는 자리가 함께 사라진다.
   *
   * RecommendResponder를 부르지 않는다 — 이 갈래의 문장은 전부 결정론적이다.
   * 모델에게 소개를 받아도 실을 자리가 없고, 결과를 버리는 왕복의 쿼터 소진이
   * 돌려줄 수 있었던 요청을 503으로 만든다(embedQueryText와 같은 규칙).
   */
  private async replyPlan(request: ChatRequestDto): Promise<ChatResponseDto> {
    const query = await this.queryStructurer.structure(request.message);
    const embedding = await this.embedQueryText(query.queryText);
    // null을 빈 배열로 접지 않는다 — replyRecommend와 같은 이유다. 검색을 못 한
    // 것과 검색 결과가 없는 것은 사용자에게 다른 사실이다.
    const places =
      embedding === null ? null : await this.searchPlaces(embedding);

    return buildChatResponse(
      buildPlanReply(query, places?.map((place) => place.title) ?? null),
      null,
    );
  }

  /**
   * 구조화 결과를 되비추고, 찾은 장소는 모델이 소개하게 한다. 이 갈래는 일정을
   * 만들지 않으므로 itinerary가 **항상 null**이고 planStatus도 항상
   * 'none'이다(게이트 1 Q3).
   *
   * 협력자가 셋에서 넷으로 늘었다(구조화 → 임베딩 → 검색·조회 → 소개).
   * 앞의 셋은 재료를 만들고 마지막 하나만 문장을 쓴다.
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
    // null을 빈 배열로 접지 않는다. 검색을 못 한 것과 검색 결과가 없는 것은
    // 사용자에게 다른 사실이고, 문구를 고르는 것은 아래 두 갈래다.
    const places =
      embedding === null ? null : await this.searchPlaces(embedding);

    return buildChatResponse(
      await this.describePlaces(request.message, query, places),
      null,
    );
  }

  /**
   * 찾은 장소를 소개하는 문구를 만든다.
   *
   * **소개할 장소가 있을 때만 Gemini를 부른다.** 검색을 못 했거나(null) 결과가
   * 0건이면 기존 고정 문구를 그대로 쓴다 — 부르면 결과를 버리는 왕복이 하나
   * 늘고, 그 왕복의 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다
   * (replyPlan·embedQueryText와 같은 규칙). 게다가 모델에게 줄 사실이 하나도
   * 없으므로, 부르면 받는 것은 지어낸 장소뿐이다.
   *
   * 이름이 빈 행은 걸러서 넘긴다. title은 색인·수집 사고로 ''일 수 있고
   * (query-reply.ts의 빈 이름 주석), 이름 없는 장소를 소개하라고 시키면 모델은
   * 주소만 보고 이름을 지어낸다. 전부 걸러져 0개가 되면 hit 0건과 같은 문구다.
   *
   * 행을 통째로 넘긴다. 제목만 뽑으면 모델은 이름만 보고 자기 지식으로 답하게
   * 되고, Postgres를 다시 읽은 이유가 사라진다.
   */
  private async describePlaces(
    message: string,
    query: StructuredQuery,
    places: TourContent[] | null,
  ): Promise<string> {
    const found = places?.filter((place) => place.title.trim() !== '') ?? [];

    if (found.length === 0) {
      return buildRecommendReply(
        query,
        places?.map((place) => place.title) ?? null,
      );
    }

    return composeRecommendReply(
      query,
      await this.recommendResponder.describe(message, query, found),
    );
  }

  /**
   * 질의 벡터로 장소를 찾고, 상세는 Postgres에서 읽는다.
   *
   * payload를 쓰지 않는다. Qdrant payload는 core가 색인할 때 떠 놓은
   * 사본이고 단일 진실 원천은 tour_contents다 — 색인 이후 값이 바뀌면 두 쪽이
   * 갈리고, payload를 쓰면 화면에 옛 값이 나간다. Qdrant가 정하는 것은
   * **어떤 장소를 어떤 순서로** 보여줄지이고, 그 장소가 **무엇인지**는
   * Postgres가 정한다.
   *
   * 제목만 뽑지 않고 행을 그대로 돌려준다. 주소·소개가 모델에게 줄 사실이며,
   * 여기서 이름만 남기면 그 사실이 호출자에게 도달하지 못한다.
   *
   * 관련도 순서는 contentid 배열의 순서로 넘어간다. 되받는 순서를 지키는 것은
   * TourContentLookup의 책임이다(In() 조회가 입력 순서를 보장하지 않는다).
   *
   * 실패는 삼키지 않는다. 여기서 빈 배열로 축퇴시키면 Qdrant·Postgres 장애가
   * "조건에 맞는 장소가 없다"로 둔갑하고, 사용자는 자기 조건을 고치려 든다.
   *
   * hit 수를 로그로 남긴다. 화면에 나가는 이름 개수와 이 수가 어긋나면 버려진
   * hit이 섞였다는 뜻이다 — payload 파싱 실패인지 Postgres 미동기화인지는
   * QdrantSearchClient와 TourContentLookup의 warn이 각각 가른다.
   */
  private async searchPlaces(embedding: number[]): Promise<TourContent[]> {
    const hits = await this.qdrant.search(embedding, {
      limit: PLACE_SEARCH_LIMIT,
    });

    this.logger.debug(`장소 검색 완료: hit=${hits.length}`);

    return this.tourContents.findByIds(
      hits.map((hit) => hit.payload.contentid),
    );
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
   * 실패는 삼키지 않는다 — 협력자 일곱에 같은 규칙이 걸린다.
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
