import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../clients/external-service.error';
import type {
  QdrantSearchOptions,
  TourSearchHit,
} from '../clients/qdrant/qdrant.client';
import { QdrantSearchClient } from '../clients/qdrant/qdrant.client';
import { TeiClient } from '../clients/tei/tei.client';
import { ChatService } from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildMockItinerary } from './plan/mock-itineraries';
import {
  buildPlanReply,
  PLAN_DESTINATION_UNKNOWN_REPLY,
  PLAN_READY_GUIDE,
} from './plan/plan-reply';
import { RECOMMEND_REPLY_HEAD } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';
import type { StructuredQuery } from './query/structured-query';
import { EMPTY_CONDITIONS } from './query/structured-query';

/**
 * 갈래 라우팅·위임과 갈래별 planStatus만 본다. 모킹 경계는 협력자다 — 분류는
 * intent.classifier.spec.ts가, 구조화는 query.structurer.spec.ts가, 문장 서식은
 * query-reply.spec.ts·plan/plan-reply.spec.ts가, planStatus와 itinerary의 짝은
 * dto/chat-response.dto.spec.ts가 따로 고정한다.
 */

const classify = jest.fn<Promise<ChatIntent>, [string]>();
const structure = jest.fn<Promise<StructuredQuery>, [string]>();
const respond = jest.fn<Promise<string>, [string]>();
const embedQuery = jest.fn<Promise<number[]>, [string]>();
const search = jest.fn<
  Promise<TourSearchHit[]>,
  [number[], QdrantSearchOptions?]
>();

/** TeiClient가 돌려주는 벡터. 차원이 로그에 실리는지 세려고 길이를 3으로 둔다. */
const EMBEDDING = [0.1, 0.2, 0.3];

/**
 * Qdrant hit. payload 전 필드를 채우는 이유는 TourContentPayload가 옵셔널 필드를
 * 두지 않기 때문이다 — 표시에 쓰는 title만 인자로 받는다.
 */
function createHit(title: string): TourSearchHit {
  return {
    id: `point-${title}`,
    score: 0.9,
    payload: {
      contentid: `content-${title}`,
      contenttypeid: '12',
      ldong_regn_cd: '50',
      ldong_signgu_cd: '130',
      lcls_systm1: 'AC',
      lcls_systm2: 'AC01',
      lcls_systm3: 'AC0101',
      title,
      mapx: '126.9',
      mapy: '33.4',
    },
  };
}

/** 기본 검색 결과. 이름이 문구까지 도달하는지 세려고 둘을 둔다. */
const HITS = [createHit('성산일출봉'), createHit('우도')];

const STRUCTURED: StructuredQuery = {
  queryText: '무엇을 하는 곳: 일출 감상',
  conditions: { ...EMPTY_CONDITIONS, region: '제주' },
  droppedLabels: [],
  fellBackToRawMessage: false,
};

/**
 * OtherResponder가 돌려주는 값. OTHER_REPLY를 쓰지 않는다 — 그 상수는 이제
 * responder 안쪽의 폴백이고, 여기서 쓰면 위임이 끊겨도 값이 같아 통과한다.
 */
const OTHER_RESPONSE =
  '제주는 사계절 모두 좋아요. 어느 계절을 생각하고 계신가요?';

/** 목적지 키워드가 걸리는 메시지. mock 일정의 목적지는 제주다. */
const PLAN_MESSAGE = '제주 2박3일 일정 짜줘';

/** 목적지 키워드가 하나도 걸리지 않는 일정 요청. */
const PLAN_MESSAGE_WITHOUT_DESTINATION = '일정 짜줘';

/**
 * 요청에 실려 오는 일정. 목적지를 강릉으로 둔다 — mock 일정 셋(서울·부산·제주)과
 * 겹치면 "요청을 되돌려줬는가"와 "새로 만들었는가"가 목적지로 구별되지 않는다.
 *
 * 호출마다 새 리터럴을 만든다. 모듈 상수를 공유하면 참조 동일성 단정이 통과
 * 근거를 잃는다.
 */
function createRequest(message: string): ChatRequestDto {
  return {
    message,
    itinerary: {
      summary: {
        destination: '강릉',
        duration: '1박 2일',
        travelers: '성인 2명',
      },
      days: [
        {
          day: 1,
          places: [
            {
              id: 'place-1',
              name: '경포해변',
              category: '관광지',
              time: '09:00',
              description: '해돋이 명소',
              pinNumber: 1,
            },
          ],
        },
      ],
    },
  };
}

/** 첫 턴의 요청. itinerary가 optional이 된 뒤 프론트가 실제로 보내는 모양이다. */
function createRequestWithoutItinerary(message: string): ChatRequestDto {
  return { message };
}

async function createService(): Promise<ChatService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatService,
      { provide: IntentClassifier, useValue: { classify } },
      { provide: QueryStructurer, useValue: { structure } },
      { provide: OtherResponder, useValue: { respond } },
      { provide: TeiClient, useValue: { embedQuery } },
      { provide: QdrantSearchClient, useValue: { search } },
    ],
  }).compile();
  return moduleRef.get(ChatService);
}

function quotaFailure(): ExternalServiceError {
  return new ExternalServiceError('gemini', 'quota', '쿼터 소진');
}

/**
 * 로그 메시지. jest.SpyInstance의 mock.calls 원소는 any로 추론돼
 * no-unsafe-member-access에 걸린다 — unknown을 거쳐 좁힌다
 * (query.structurer.spec.ts:42-45와 같은 관용구).
 */
function logMessages(spy: jest.SpyInstance): string[] {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls.map((call) => String(call[0]));
}

function firstMessage(spy: jest.SpyInstance): string {
  return logMessages(spy)[0];
}

let debugLog: jest.SpyInstance;
let warnLog: jest.SpyInstance;

beforeEach(() => {
  classify.mockReset();
  structure.mockReset().mockResolvedValue(STRUCTURED);
  respond.mockReset().mockResolvedValue(OTHER_RESPONSE);
  embedQuery.mockReset().mockResolvedValue(EMBEDDING);
  search.mockReset().mockResolvedValue(HITS);
  // 스파이를 걸지 않으면 임베딩 갈래를 도는 테스트마다 콘솔이 로그로 덮인다.
  debugLog = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ChatService — 갈래별 planStatus와 itinerary', () => {
  it('plan_itinerary는 목적지를 알아들으면 새 일정을 ready로 돌려준다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary?.summary.destination).toBe('제주');
    expect(response.itinerary?.days).toHaveLength(3);
  });

  it('↔ 짝: recommend_places는 같은 요청에서 none이다', async () => {
    // 위 케이스와 요청이 완전히 같고 분류값만 다르다. 두 갈래의 case 핸들러가
    // 뒤바뀌면 이 짝이 잡는다 — 과거에 정확히 그 뒤바뀜이 미커밋 상태로 있었고,
    // 갈래별 응답이 없어서 테스트가 초록불이었다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('plan_itinerary는 목적지를 못 알아들으면 none이다', async () => {
    // 기본 목적지로 폴백하지 않는다(게이트 1 Q4). 같은 intent가 메시지에 따라
    // ready/none으로 갈리며, 판정 입력은 (intent, 목적지 매칭 여부) 둘이고
    // 둘 다 Gemini 추가 호출 없이 결정론적이다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE_WITHOUT_DESTINATION),
    );

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('other는 none이다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequestWithoutItinerary('안녕'));

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  const allIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
    'other',
  ];

  it.each(allIntents)(
    '%s는 요청의 일정을 응답에 싣지 않는다',
    async (intent) => {
      // 게이트 1 Q3의 결정이다. 요청에 강릉 일정을 실어 보내도 응답에 강릉이
      // 나타나지 않는다 — plan 갈래는 자기가 만든 일정을, 나머지 둘은 null을 낸다.
      // 이 단정이 없으면 어느 갈래가 요청을 되돌려주기 시작해도 아무도 모르고,
      // planStatus를 만드는 지점이 조용히 둘로 늘어난다.
      classify.mockResolvedValue(intent);
      const service = await createService();
      const request = createRequest(PLAN_MESSAGE);

      const response = await service.chat(request);

      expect(response.itinerary).not.toBe(request.itinerary);
      expect(response.itinerary?.summary.destination).not.toBe('강릉');
    },
  );

  it('plan_itinerary는 요청에 일정이 있어도 자기가 만든 일정을 낸다', async () => {
    // ↔ 위 짝의 긍정형. "요청 일정이 아니다"만으로는 null을 내는 구현도 통과한다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(createRequest(PLAN_MESSAGE));

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary?.summary.destination).toBe('제주');
  });
});

describe('ChatService — 갈래별 reply', () => {
  it('plan_itinerary는 준비된 일정을 알리는 문장을 돌려준다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.reply).toBe(
      buildPlanReply(buildMockItinerary(PLAN_MESSAGE)),
    );
    // 위 단정만으로는 두 함수가 함께 망가져도 통과한다. 문장에 목적지와
    // 맺음말이 실제로 실렸는지 따로 센다.
    expect(response.reply).toContain('제주');
    expect(response.reply).toContain(PLAN_READY_GUIDE);
  });

  it('plan_itinerary는 목적지를 못 알아들으면 무엇을 알려달라고 말한다', async () => {
    // none이면서 아무 설명이 없으면 사용자는 서비스가 고장난 것과 구별할 수 없다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE_WITHOUT_DESTINATION),
    );

    expect(response.reply).toBe(PLAN_DESTINATION_UNKNOWN_REPLY);
  });

  it('recommend_places는 구조화 결과를 되비춘 문장을 돌려준다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(createRequest('제주 관광지 추천해줘'));

    // 서식 전문은 query-reply.spec.ts가 고정한다. 여기서 보는 것은 "구조화
    // 결과가 실제로 문장에 실렸는가"다 — STRUCTURED의 region이 문구까지
    // 도달하지 않으면 구조화 폴백이 발동해도 머리말 단정만으로는 통과한다.
    expect(response.reply).toContain(RECOMMEND_REPLY_HEAD);
    expect(response.reply).toContain('지역: 제주');
  });

  it('other는 OtherResponder의 응답을 그대로 돌려준다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequest('안녕'));

    expect(response.reply).toBe(OTHER_RESPONSE);
  });

  it('분류기를 message만으로 호출한다', async () => {
    // itinerary·대화 이력을 프롬프트에 싣지 않는다는 결정이 여기서 고정된다.
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 2박3일 일정 짜줘'));

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith('제주 2박3일 일정 짜줘');
  });
});

describe('ChatService — 구조화 위임', () => {
  it('recommend_places는 QueryStructurer를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 가족여행 관광지 추천'));

    expect(structure).toHaveBeenCalledTimes(1);
    expect(structure).toHaveBeenCalledWith('제주 가족여행 관광지 추천');
  });

  const nonStructuringIntents: ChatIntent[] = ['plan_itinerary', 'other'];

  it.each(nonStructuringIntents)(
    '↔ 짝: %s는 QueryStructurer를 호출하지 않는다',
    async (intent) => {
      // plan 갈래는 목적지를 원문 키워드로 고르므로 구조화 결과를 쓰지 않는다.
      // 부르면 결과를 버리는 Gemini 왕복이 하나 늘고, 그 왕복의 쿼터 소진이
      // 돌려줄 수 있었던 요청을 503으로 만든다.
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(structure).not.toHaveBeenCalled();
    },
  );
});

describe('ChatService — 질의 임베딩', () => {
  it('recommend_places는 재조립된 queryText로 임베딩을 한 번 만든다', async () => {
    // 사용자 원문이 아니라 queryText다. 원문을 그대로 넘기면 core가 색인한
    // 의미 축 텍스트와 다른 공간의 벡터가 되고, 같은 장소가 검색되지 않는다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith(STRUCTURED.queryText);
  });

  it('만들어진 벡터의 차원을 로그로 남긴다', async () => {
    // 벡터를 아직 아무도 쓰지 않으므로 "실제로 받았다"의 관측 수단이 이 로그
    // 하나다. 차원은 Qdrant 컬렉션과 맞아야 하는데 코드가 강제하지 않는다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(firstMessage(debugLog)).toContain(`차원=${EMBEDDING.length}`);
  });

  const nonEmbeddingIntents: ChatIntent[] = ['plan_itinerary', 'other'];

  it.each(nonEmbeddingIntents)(
    '↔ 짝: %s는 임베딩하지 않는다',
    async (intent) => {
      // 구조화를 거치지 않는 갈래에는 임베딩할 질의가 없다. 부르면 결과를 버리는
      // TEI 왕복이 하나 늘고, 그 왕복의 실패가 돌려줄 수 있었던 요청을 502로 만든다.
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(embedQuery).not.toHaveBeenCalled();
    },
  );

  it('구조화 폴백에서도 원문 질의를 임베딩한다', async () => {
    // 폴백은 "질의를 못 만들었다"가 아니라 "원문을 질의로 쓴다"는 계약이다
    // (QueryStructurer.structure). 원문에도 검색 가치가 있으므로 건너뛰지 않는다.
    classify.mockResolvedValue('recommend_places');
    structure.mockResolvedValue({
      queryText: '제주 일출 명소 추천',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith('제주 일출 명소 추천');
  });

  it('공백뿐인 질의는 임베딩하지 않고 warn을 남긴다', async () => {
    // @IsNotEmpty()는 공백뿐인 문자열을 통과시킨다(실측). 그 메시지가 구조화
    // 폴백을 타면 원문이 그대로 queryText가 되어 여기 도달하고, 그대로 넘기면
    // TeiClient가 invalid-request로 던져 200이던 갈래가 502가 된다 — 사용자
    // 입력 문제를 외부 서비스 장애로 오청구하는 셈이다(ChatRequestDto.message의
    // MaxLength 주석과 같은 판단).
    classify.mockResolvedValue('recommend_places');
    structure.mockResolvedValue({
      queryText: '   ',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    const response = await service.chat(createRequest('   '));

    expect(embedQuery).not.toHaveBeenCalled();
    // 건너뛴 사실이 로그에 없으면 "왜 이 요청만 검색이 비었는가"를 알 수 없다.
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(response.reply).toContain(RECOMMEND_REPLY_HEAD);
  });

  it('↔ 짝: 질의가 있으면 건너뛰기 warn을 남기지 않는다', async () => {
    // 이 짝이 없으면 항상 건너뛰는 구현도 통과하고, 그러면 임베딩이 통째로
    // 사라져도 응답은 200이라 아무도 모른다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(warnLog).not.toHaveBeenCalled();
  });

  it('임베딩을 만들어도 응답에 벡터를 싣지 않는다', async () => {
    // 벡터는 검색 재료이지 UI 계약이 아니다. 한 번 실으면 프론트가 의존하게 되고
    // 응답 본문이 요청당 수 KB로 불어난다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(JSON.stringify(response)).not.toContain('0.1');
  });
});

describe('ChatService — 장소 검색', () => {
  it('recommend_places는 임베딩 벡터로 Qdrant를 한 번 검색한다', async () => {
    // 벡터를 만들어 놓고 검색에 넘기지 않으면 TEI 왕복이 통째로 낭비된다.
    // 넘기는 값이 embedQuery의 산출물 자체인지까지 본다 — 다른 배열을 넘기면
    // 질의와 무관한 이웃이 검색되고 응답은 여전히 200이다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(search).toHaveBeenCalledTimes(1);
    const [vector] = search.mock.calls[0];
    expect(vector).toBe(EMBEDDING);
  });

  it('검색 개수를 10으로 고정한다', async () => {
    // 상수에서 읽지 않고 리터럴로 센다. 소스에서 가져오면 개수를 바꿔도
    // 테스트가 따라 움직여 고정값이 옮겨진 사실을 아무도 못 잡는다
    // (chat.controller.spec.ts의 1000자 경계와 같은 판단).
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    const [, opts] = search.mock.calls[0];
    expect(opts?.limit).toBe(10);
  });

  it('↔ 짝: 벡터를 만들지 못하면 검색하지 않는다', async () => {
    // 공백뿐인 질의는 임베딩을 건너뛴다. 벡터 없이 검색을 강행하면 무엇을
    // 넘길지가 없어 빈 배열이나 0 벡터를 지어내게 되고, 그렇게 얻은 이웃은
    // 질의와 아무 관계가 없는데 화면에는 추천으로 나간다.
    classify.mockResolvedValue('recommend_places');
    structure.mockResolvedValue({
      queryText: '   ',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    await service.chat(createRequest('   '));

    expect(search).not.toHaveBeenCalled();
  });

  it('구조화 폴백이어도 벡터가 있으면 검색한다', async () => {
    // 폴백은 "질의를 못 만들었다"가 아니라 "원문을 질의로 쓴다"는 계약이다.
    // 위 짝의 기준이 fellBackToRawMessage가 아니라 벡터의 유무라는 사실을
    // 여기서 고정한다 — 폴백을 기준으로 끊으면 검색 가치가 있는 원문 질의가
    // 통째로 검색되지 않는다.
    classify.mockResolvedValue('recommend_places');
    structure.mockResolvedValue({
      queryText: '제주 일출 명소 추천',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(search).toHaveBeenCalledTimes(1);
  });

  const nonSearchingIntents: ChatIntent[] = ['plan_itinerary', 'other'];

  it.each(nonSearchingIntents)('↔ 짝: %s는 검색하지 않는다', async (intent) => {
    // 임베딩하지 않는 갈래에는 검색할 벡터가 없다. 부르면 결과를 버리는
    // Qdrant 왕복이 하나 늘고, 그 왕복의 실패가 돌려줄 수 있었던 요청을
    // 502로 만든다(임베딩 짝과 같은 이유).
    classify.mockResolvedValue(intent);
    const service = await createService();

    await service.chat(createRequest(PLAN_MESSAGE));

    expect(search).not.toHaveBeenCalled();
  });

  it('검색된 hit 수를 로그로 남긴다', async () => {
    // 버려진 hit(payload 파싱 실패·빈 title)이 있으면 화면의 이름 개수와
    // 이 수가 어긋난다. 그 어긋남을 볼 수 있는 지점이 이 로그 하나다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(logMessages(debugLog)).toContainEqual(
      expect.stringContaining(`hit=${HITS.length}`),
    );
  });
});

describe('ChatService — 대화 위임', () => {
  it('other 갈래는 OtherResponder를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 어때?'));

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('제주 어때?');
  });

  const nonChattingIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
  ];

  it.each(nonChattingIntents)(
    '↔ 짝: %s는 OtherResponder를 호출하지 않는다',
    async (intent) => {
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(respond).not.toHaveBeenCalled();
    },
  );
});

describe('ChatService — 실패를 삼키지 않는다', () => {
  it('분류기가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 여기에 try/catch를 두면 쿼터 소진이 200 + 안내 문구가 되고
    // 전역 필터의 503 + Retry-After가 사라진다.
    const failure = quotaFailure();
    classify.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });

  it('QueryStructurer가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 분류기와 대칭이어야 한다. 한쪽만 고정하면 새로 붙은 호출이 조용히
    // 200 + 조건 미지정 요약으로 축퇴해도 테스트가 초록불을 준다.
    const failure = quotaFailure();
    classify.mockResolvedValue('recommend_places');
    structure.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 관광지'))).rejects.toBe(
      failure,
    );
  });

  it('TeiClient가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 협력자 넷에 대해 대칭으로 고정한다. 여기서 삼키면 TEI 장애가 200 + 정상
    // 요약이 되고, 검색 재료가 없다는 사실이 응답 어디에도 나타나지 않는다.
    const failure = new ExternalServiceError('tei', 'unavailable', '연결 실패');
    classify.mockResolvedValue('recommend_places');
    embedQuery.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 관광지'))).rejects.toBe(
      failure,
    );
  });

  it('QdrantSearchClient가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 협력자 다섯에 대해 대칭으로 고정한다. 여기서 삼키면 Qdrant 장애가
    // 200 + "조건에 맞는 장소를 찾지 못했어요"가 되고, 사용자는 자기 조건이
    // 까다로웠다고 이해한다 — 장애를 사용자 잘못으로 오청구하는 셈이다.
    const failure = new ExternalServiceError(
      'qdrant',
      'unavailable',
      '연결 실패',
    );
    classify.mockResolvedValue('recommend_places');
    search.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 관광지'))).rejects.toBe(
      failure,
    );
  });

  it('OtherResponder가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 세 협력자에 대해 대칭으로 고정한다. other 갈래는 폴백 문구가 정상 응답과
    // 구별되지 않으므로, 여기서 삼키면 쿼터 소진이 평범한 대화로 보인다.
    const failure = quotaFailure();
    classify.mockResolvedValue('other');
    respond.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });
});
