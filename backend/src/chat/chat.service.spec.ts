import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../clients/external-service.error';
import type {
  QdrantSearchOptions,
  TourSearchHit,
} from '../clients/qdrant/qdrant.client';
import { QdrantSearchClient } from '../clients/qdrant/qdrant.client';
import { TeiClient } from '../clients/tei/tei.client';
import { TourContent } from '../database/entities';
import { TourContentLookup } from '../database/tour-content.lookup';
import { ChatService } from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import {
  PLAN_NO_HITS_TAIL,
  PLAN_NOT_ASSEMBLED_NOTE,
  PLAN_NOT_SEARCHED_TAIL,
  PLAN_PLACES_HEAD,
  PLAN_REPLY_HEAD,
} from './plan/plan-reply';
import {
  buildPlacesTail,
  RECOMMEND_NO_HITS_TAIL,
  RECOMMEND_NOT_SEARCHED_TAIL,
  RECOMMEND_REPLY_HEAD,
} from './query/query-reply';
import type { RecommendPlace } from './query/recommend-prompt';
import { RecommendResponder } from './query/recommend.responder';
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
const findByIds = jest.fn<Promise<TourContent[]>, [string[]]>();
const describePlaces = jest.fn<
  Promise<string>,
  [string, StructuredQuery, RecommendPlace[]]
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

/**
 * Postgres가 돌려주는 행.
 *
 * title 외에 addr1·overview도 채운다 — 이 클래스는 이제 행을 통째로
 * RecommendResponder에 넘기고, 제목만 뽑아 넘기는 회귀는 주소가 도달하는지를
 * 봐야 잡힌다. 나머지 23개 컬럼은 아무도 읽지 않으므로 비워 둔다.
 */
function createRow(
  contentid: string,
  title: string,
  addr1 = '',
  overview: string | null = null,
): TourContent {
  const row = new TourContent();
  row.contentid = contentid;
  row.title = title;
  row.addr1 = addr1;
  row.addr2 = '';
  row.overview = overview;
  return row;
}

/**
 * 두 hit에 대응하는 행. **제목을 Qdrant payload의 title과 일부러 다른 단어로
 * 둔다** — 같거나 부분 문자열이면 화면에 실린 이름이 색인 시점의 것인지
 * Postgres의 현재 값인지 구별되지 않고, 조회를 통째로 지워도 테스트가 통과한다.
 */
const ROWS = [
  createRow('content-성산일출봉', '한라산', '제주 제주시 1100로', '백록담'),
  createRow('content-우도', '마라도'),
];

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

/** 일정 갈래로 분류되는 메시지. 목적지는 구조화 결과가 정한다. */
const PLAN_MESSAGE = '제주 2박3일 일정 짜줘';

/**
 * 요청에 실려 오는 일정. 목적지를 강릉으로 둔다 — 응답에 실린 값과 겹치면
 * "요청을 되돌려줬는가"가 목적지로 구별되지 않는다.
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
      { provide: TourContentLookup, useValue: { findByIds } },
      { provide: RecommendResponder, useValue: { describe: describePlaces } },
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
  // 실제 TourContentLookup의 계약을 그대로 흉내낸다 — 요청한 순서를 지키고
  // 없는 id는 버린다. mockResolvedValue(ROWS)로 두면 검색이 0건인 요청에도
  // 두 행이 돌아와, hit 0건 경로를 보는 기존 테스트가 거짓으로 통과한다.
  findByIds
    .mockReset()
    .mockImplementation((ids) =>
      Promise.resolve(
        ids
          .map((id) => ROWS.find((row) => row.contentid === id))
          .filter((row): row is TourContent => row !== undefined),
      ),
    );
  // 실제 RecommendResponder의 폴백 계약을 그대로 흉내낸다 — 받은 장소의
  // 이름으로 맺음말을 만든다. 고정 문자열로 두면 서비스가 엉뚱한 장소를
  // 넘겨도 문구가 같아, 이름이 도달하는지 보는 기존 테스트가 거짓으로 통과한다.
  describePlaces
    .mockReset()
    .mockImplementation((_message, _query, places) =>
      Promise.resolve(buildPlacesTail(places.map((place) => place.title))),
    );
  // 스파이를 걸지 않으면 임베딩 갈래를 도는 테스트마다 콘솔이 로그로 덮인다.
  debugLog = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ChatService — 갈래별 planStatus와 itinerary', () => {
  const allIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
    'other',
  ];

  it.each(allIntents)('%s는 none이다', async (intent) => {
    // 세 갈래 전부가 none이다. plan 갈래는 장소까지만 찾고 조립하지 않으므로
    // 만들 수 있는 일정이 없다 — 여기서 ready가 나오면 itinerary가 채워졌다는
    // 뜻이고, 조립 없이 채울 수 있는 것은 지어낸 일정뿐이다.
    classify.mockResolvedValue(intent);
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it.each(allIntents)(
    '%s는 요청의 일정을 응답에 싣지 않는다',
    async (intent) => {
      // 게이트 1 Q3의 결정이다. 요청에 강릉 일정을 실어 보내도 응답에 강릉이
      // 나타나지 않는다. 이 단정이 없으면 어느 갈래가 요청을 되돌려주기
      // 시작해도 아무도 모르고, planStatus를 만드는 지점이 조용히 둘로 늘어난다.
      classify.mockResolvedValue(intent);
      const service = await createService();
      const request = createRequest(PLAN_MESSAGE);

      const response = await service.chat(request);

      expect(response.itinerary).toBeNull();
      expect(JSON.stringify(response)).not.toContain('강릉');
    },
  );
});

describe('ChatService — 갈래별 reply', () => {
  it('plan_itinerary는 구조화 결과와 찾은 장소를 되비춘 문장을 돌려준다', async () => {
    // 전문 등가로 고정한다. 서식 자체는 plan/plan-reply.spec.ts가 보고, 여기서
    // 세는 것은 "구조화 결과와 Postgres 이름이 실제로 문장까지 도달했는가"다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.reply).toBe(
      `${PLAN_REPLY_HEAD} — 지역: 제주. ${PLAN_PLACES_HEAD} 한라산, 마라도. ${PLAN_NOT_ASSEMBLED_NOTE}`,
    );
  });

  it('plan_itinerary는 일정을 짜지 못한다는 사실을 함께 말한다', async () => {
    // 이 갈래는 항상 none을 낸다. 설명 없이 패널이 뜨지 않으면 사용자는
    // 서비스가 고장난 것과 구별할 수 없다 — 그 유일한 단서가 이 문장이다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.reply).toContain(PLAN_NOT_ASSEMBLED_NOTE);
  });

  it('↔ 짝: plan_itinerary와 recommend_places는 같은 요청에 다른 문구를 낸다', async () => {
    // 두 갈래가 이제 같은 파이프라인을 타므로 planStatus로는 구별되지 않는다
    // (둘 다 none이다). case 핸들러가 뒤바뀌었을 때 그것을 잡는 단서가 문구
    // 하나로 좁혀졌다 — 과거에 정확히 그 뒤바뀜이 미커밋 상태로 있었다.
    classify.mockResolvedValue('plan_itinerary');
    const plan = await (
      await createService()
    ).chat(createRequestWithoutItinerary(PLAN_MESSAGE));

    classify.mockResolvedValue('recommend_places');
    const recommend = await (
      await createService()
    ).chat(createRequestWithoutItinerary(PLAN_MESSAGE));

    expect(plan.reply).not.toBe(recommend.reply);
    expect(plan.reply).toContain(PLAN_REPLY_HEAD);
    expect(recommend.reply).not.toContain(PLAN_REPLY_HEAD);
  });

  it('plan_itinerary는 장소를 못 찾으면 찾지 못했다고 말한다', async () => {
    // 조건은 알아들었는데 검색이 0건인 경우다. 장소 목록 자리가 조용히 비면
    // 사용자는 무엇이 없는 것인지 알 수 없다.
    classify.mockResolvedValue('plan_itinerary');
    search.mockResolvedValue([]);
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.reply).toContain(PLAN_NO_HITS_TAIL);
    expect(response.reply).not.toContain(PLAN_NOT_SEARCHED_TAIL);
  });

  it('↔ 짝: plan_itinerary도 검색을 못 하면 0건과 다른 문구를 받는다', async () => {
    // 구조화가 폴백해 질의가 비면 검색 자체를 못 한다. 0건과 뭉개면 사용자가
    // 조건을 아무리 고쳐도 같은 답을 받는다(recommend 갈래와 같은 경계).
    classify.mockResolvedValue('plan_itinerary');
    structure.mockResolvedValue({
      queryText: '   ',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    const response = await service.chat(createRequestWithoutItinerary('   '));

    expect(response.reply).toContain(PLAN_NOT_SEARCHED_TAIL);
    expect(response.reply).not.toContain(PLAN_NO_HITS_TAIL);
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

  it('plan_itinerary도 QueryStructurer를 message만으로 한 번 호출한다', async () => {
    // 두 갈래가 같은 파이프라인을 공유한다. 이 갈래가 구조화를 건너뛰면
    // 검색할 질의를 원문 키워드로 지어내게 되고, core가 색인한 의미 축과
    // 다른 공간에서 검색이 돈다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    await service.chat(createRequest('제주 가족여행 일정 짜줘'));

    expect(structure).toHaveBeenCalledTimes(1);
    expect(structure).toHaveBeenCalledWith('제주 가족여행 일정 짜줘');
  });

  const nonStructuringIntents: ChatIntent[] = ['other'];

  it.each(nonStructuringIntents)(
    '↔ 짝: %s는 QueryStructurer를 호출하지 않는다',
    async (intent) => {
      // 대화 갈래에는 구조화할 질의가 없다. 부르면 결과를 버리는 Gemini 왕복이
      // 하나 늘고, 그 왕복의 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다.
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

  it('plan_itinerary도 재조립된 queryText로 임베딩을 한 번 만든다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    await service.chat(createRequest(PLAN_MESSAGE));

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith(STRUCTURED.queryText);
  });

  const nonEmbeddingIntents: ChatIntent[] = ['other'];

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

  it('plan_itinerary도 임베딩 벡터로 Qdrant를 한 번 검색한다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    await service.chat(createRequest(PLAN_MESSAGE));

    expect(search).toHaveBeenCalledTimes(1);
    const [vector, opts] = search.mock.calls[0];
    expect(vector).toBe(EMBEDDING);
    // 개수도 recommend와 같은 10이다. 두 갈래가 같은 상수를 공유하는지 센다 —
    // 갈리면 같은 질의가 갈래에 따라 다른 수의 장소를 받는다.
    expect(opts?.limit).toBe(10);
  });

  const nonSearchingIntents: ChatIntent[] = ['other'];

  it.each(nonSearchingIntents)('↔ 짝: %s는 검색하지 않는다', async (intent) => {
    // 임베딩하지 않는 갈래에는 검색할 벡터가 없다. 부르면 결과를 버리는
    // Qdrant 왕복이 하나 늘고, 그 왕복의 실패가 돌려줄 수 있었던 요청을
    // 502로 만든다(임베딩 짝과 같은 이유).
    classify.mockResolvedValue(intent);
    const service = await createService();

    await service.chat(createRequest(PLAN_MESSAGE));

    expect(search).not.toHaveBeenCalled();
  });

  it('찾은 장소 이름을 응답 문구에 싣는다', async () => {
    // 검색해 놓고 문구에 싣지 않으면 Qdrant 왕복이 통째로 낭비되고, 사용자는
    // 검색이 돌았는지조차 알 수 없다. 이름의 출처는 Postgres다 — 그 대조는
    // 아래 '장소 상세 조회'가 따로 센다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(response.reply).toContain('한라산');
    expect(response.reply).toContain('마라도');
  });

  it('hit이 0건이면 찾지 못했다고 말한다', async () => {
    classify.mockResolvedValue('recommend_places');
    search.mockResolvedValue([]);
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(response.reply).toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('↔ 짝: 검색을 못 한 요청은 hit 0건과 다른 문구를 받는다', async () => {
    // 벡터가 없어 검색을 아예 못 한 것과, 검색은 돌았는데 결과가 없는 것은
    // 사용자에게 다른 사실이다. 뭉개면 폴백을 "결과 없음"으로 오청구하게 된다.
    classify.mockResolvedValue('recommend_places');
    structure.mockResolvedValue({
      queryText: '   ',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    const response = await service.chat(createRequest('   '));

    expect(response.reply).toContain(RECOMMEND_NOT_SEARCHED_TAIL);
    expect(response.reply).not.toContain(RECOMMEND_NO_HITS_TAIL);
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

describe('ChatService — 장소 상세 조회', () => {
  it('hit의 contentid를 관련도 순서 그대로 한 번에 넘긴다', async () => {
    // 순서가 곧 사용자에게 보여줄 순서다. 여기서 정렬을 잃으면 TourContentLookup이
    // 아무리 순서를 지켜도 복원할 근거가 사라진다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(findByIds).toHaveBeenCalledTimes(1);
    const [contentids] = findByIds.mock.calls[0];
    expect(contentids).toEqual(['content-성산일출봉', 'content-우도']);
  });

  it('Qdrant payload의 title이 아니라 Postgres의 title을 싣는다', async () => {
    // Qdrant payload는 색인 시점의 사본이다. 제목의 단일 진실 원천은 Postgres이며,
    // 두 값이 갈리면 화면에 옛 이름이 나간다. 부정 단정이 없으면 조회를 통째로
    // 지우고 payload.title로 되돌려도 위 긍정 단정이 통과한다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(response.reply).toContain('한라산');
    expect(response.reply).toContain('마라도');
    expect(response.reply).not.toContain('성산일출봉');
    expect(response.reply).not.toContain('우도');
  });

  it('Postgres에 없는 id는 빼고 찾은 것만 싣는다', async () => {
    // 색인과 DB 사이의 미동기화 한 건 때문에 나머지까지 사라지게 하지 않는다.
    classify.mockResolvedValue('recommend_places');
    findByIds.mockResolvedValue([ROWS[0]]);
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(response.reply).toContain('한라산');
    expect(response.reply).not.toContain('마라도');
    // 한 건이라도 남았으면 "찾지 못했다"가 아니다.
    expect(response.reply).not.toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('↔ 짝: 전부 없으면 hit 0건과 같은 문구가 나간다', async () => {
    // 사용자가 받는 사실("보여줄 장소가 없다")이 hit 0건과 같으므로 문구도 같다.
    // 검색은 돌았는데 DB에서 전부 사라졌다는 사실은 TourContentLookup의 warn
    // 로그에만 남는다 — 검색조차 못 한 경우(NOT_SEARCHED)와는 여전히 갈린다.
    classify.mockResolvedValue('recommend_places');
    findByIds.mockResolvedValue([]);
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(response.reply).toContain(RECOMMEND_NO_HITS_TAIL);
    expect(response.reply).not.toContain(RECOMMEND_NOT_SEARCHED_TAIL);
  });

  it('plan_itinerary도 hit의 contentid를 관련도 순서 그대로 조회한다', async () => {
    // 이 갈래도 Postgres가 장소의 단일 진실 원천이다. 조회를 건너뛰고 payload를
    // 쓰면 화면에 색인 시점의 옛 이름이 나간다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(createRequest(PLAN_MESSAGE));

    expect(findByIds).toHaveBeenCalledTimes(1);
    const [contentids] = findByIds.mock.calls[0];
    expect(contentids).toEqual(['content-성산일출봉', 'content-우도']);
    // 조회 결과가 문구까지 도달하는지 함께 센다. 부정 단정이 없으면 조회를
    // 통째로 지우고 payload.title로 되돌려도 통과한다.
    expect(response.reply).toContain('한라산');
    expect(response.reply).not.toContain('성산일출봉');
  });

  const nonLookingUpIntents: ChatIntent[] = ['other'];

  it.each(nonLookingUpIntents)(
    '↔ 짝: %s는 tour_contents를 조회하지 않는다',
    async (intent) => {
      // 검색하지 않는 갈래에는 조회할 contentid가 없다. 부르면 결과를 버리는
      // DB 왕복이 하나 늘고, 그 왕복의 실패가 돌려줄 수 있었던 요청을 500으로
      // 만든다(임베딩·검색 짝과 같은 이유).
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(findByIds).not.toHaveBeenCalled();
    },
  );

  it('↔ 짝: 벡터를 만들지 못하면 조회하지 않는다', async () => {
    // 검색을 안 했으면 조회할 contentid도 없다. 여기서 새면 빈 조회 왕복이
    // 공백뿐인 질의마다 하나씩 늘어난다.
    classify.mockResolvedValue('recommend_places');
    structure.mockResolvedValue({
      queryText: '   ',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    await service.chat(createRequest('   '));

    expect(findByIds).not.toHaveBeenCalled();
  });
});

describe('ChatService — 장소 소개 위임', () => {
  it('찾은 장소가 있으면 RecommendResponder를 한 번 부른다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    expect(describePlaces).toHaveBeenCalledTimes(1);
  });

  it('원문·구조화 결과·Postgres 행을 그대로 넘긴다', async () => {
    // 행을 통째로 넘기는 것이 이 변경의 핵심이다. 제목만 뽑아 넘기면 모델은
    // 이름만 보고 자기 지식으로 답하게 되고, Postgres를 읽은 이유가 사라진다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    const [message, query, places] = describePlaces.mock.calls[0];
    expect(message).toBe('제주 일출 명소 추천');
    expect(query).toBe(STRUCTURED);
    expect(places).toEqual(ROWS);
    // 주소·소개가 실제로 실렸는지 따로 센다. toEqual만 두면 fixture가 비어도
    // 통과하고, 그러면 "행을 통째로 넘긴다"가 아무것도 보장하지 않는다.
    expect(places[0].addr1).toBe('제주 제주시 1100로');
    expect(places[0].overview).toBe('백록담');
  });

  it('모델이 쓴 맺음말을 조건 요약 뒤에 싣는다', async () => {
    // 자유 텍스트가 화면까지 도달하는지 본다. 여기서 끊기면 Gemini 왕복이
    // 통째로 낭비되고 사용자는 예전과 같은 이름 목록만 받는다.
    classify.mockResolvedValue('recommend_places');
    describePlaces.mockResolvedValue('한라산은 백록담이 유명해요.');
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(response.reply).toBe(
      `${RECOMMEND_REPLY_HEAD} — 지역: 제주. 한라산은 백록담이 유명해요.`,
    );
  });

  it('모델이 무엇을 쓰든 조건 요약은 코드가 만든다', async () => {
    // ↔ 위 짝. 앞부분까지 모델에 넘기면 "무엇으로 이해했는지"를 사용자가
    // 대조할 근거가 사라진다 — 모델이 조건을 흘려도 아무도 알 수 없다.
    classify.mockResolvedValue('recommend_places');
    describePlaces.mockResolvedValue('아무 말이나 합니다.');
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(response.reply).toContain('지역: 제주');
  });

  it('↔ 짝: hit이 0건이면 부르지 않는다', async () => {
    // 소개할 장소가 없는데 부르면 결과를 버리는 Gemini 왕복이 하나 늘고,
    // 그 왕복의 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다
    // (임베딩·검색·조회 짝과 같은 이유).
    classify.mockResolvedValue('recommend_places');
    search.mockResolvedValue([]);
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(describePlaces).not.toHaveBeenCalled();
    expect(response.reply).toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('↔ 짝: 벡터를 만들지 못하면 부르지 않는다', async () => {
    classify.mockResolvedValue('recommend_places');
    structure.mockResolvedValue({
      queryText: '   ',
      conditions: { ...EMPTY_CONDITIONS },
      droppedLabels: [],
      fellBackToRawMessage: true,
    });
    const service = await createService();

    const response = await service.chat(createRequest('   '));

    expect(describePlaces).not.toHaveBeenCalled();
    expect(response.reply).toContain(RECOMMEND_NOT_SEARCHED_TAIL);
  });

  it('↔ 짝: Postgres에서 전부 못 찾으면 부르지 않는다', async () => {
    classify.mockResolvedValue('recommend_places');
    findByIds.mockResolvedValue([]);
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(describePlaces).not.toHaveBeenCalled();
    expect(response.reply).toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('↔ 짝: 이름이 전부 비어 있으면 부르지 않는다', async () => {
    // 이름 없는 장소를 소개하라고 시키면 모델은 주소만 보고 이름을 지어낸다.
    // 사용자가 받는 사실은 hit 0건과 같으므로 문구도 같다.
    classify.mockResolvedValue('recommend_places');
    findByIds.mockResolvedValue([
      createRow('content-성산일출봉', ''),
      createRow('content-우도', '   '),
    ]);
    const service = await createService();

    const response = await service.chat(createRequest('제주 일출 명소 추천'));

    expect(describePlaces).not.toHaveBeenCalled();
    expect(response.reply).toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('이름이 빈 장소는 빼고 나머지만 넘긴다', async () => {
    // ↔ 위 짝. 한 건이 비었다고 나머지까지 버리지 않는다 — 빈 이름을 그대로
    // 넘기면 모델이 그 자리를 지어낸다.
    classify.mockResolvedValue('recommend_places');
    findByIds.mockResolvedValue([ROWS[0], createRow('content-우도', '')]);
    const service = await createService();

    await service.chat(createRequest('제주 일출 명소 추천'));

    const [, , places] = describePlaces.mock.calls[0];
    expect(places).toEqual([ROWS[0]]);
  });

  const nonDescribingIntents: ChatIntent[] = ['plan_itinerary', 'other'];

  it.each(nonDescribingIntents)(
    '↔ 짝: %s는 장소를 소개하지 않는다',
    async (intent) => {
      // plan 갈래가 recommend와 갈리는 유일한 협력자다. 구조화·임베딩·검색·조회는
      // 공유하지만 소개는 부르지 않는다 — 이 갈래가 돌려주는 문장은 전부
      // 결정론적이며, 모델에게 문장을 받아도 그것을 실을 자리가 없다.
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(describePlaces).not.toHaveBeenCalled();
    },
  );

  it('plan_itinerary는 장소를 찾아도 Gemini를 부르지 않는다', async () => {
    // ↔ 위 짝의 강화형. 위 케이스는 검색이 0건이어도 통과하므로, 소개할 장소가
    // 실제로 있는 상태에서도 부르지 않는지 따로 센다. 부르면 결과를 버리는
    // 왕복이 하나 늘고 그 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(createRequest(PLAN_MESSAGE));

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(response.reply).toContain('한라산');
    expect(describePlaces).not.toHaveBeenCalled();
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

  it('TourContentLookup이 던진 DB 오류를 삼키지 않는다', async () => {
    // 여섯 번째 협력자다. ExternalServiceError가 아니라 TypeORM이 던지는 오류
    // 그대로이고, 전역 필터가 잡지 않으므로 Nest 기본 처리로 500이 된다.
    // 여기서 빈 배열로 축퇴시키면 DB 장애가 200 + "조건에 맞는 장소를 찾지
    // 못했어요"가 되고, 사용자는 자기 조건이 까다로웠다고 이해한다.
    const failure = new Error('Connection terminated unexpectedly');
    classify.mockResolvedValue('recommend_places');
    findByIds.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 관광지'))).rejects.toBe(
      failure,
    );
  });

  it('RecommendResponder가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 일곱 번째 협력자다. 이쪽 폴백은 검증 실패 전용이고 호출 실패에는
    // 발동하지 않는다 — 여기서 삼키면 쿼터 소진이 "이런 곳은 어때요?"가 되어
    // 정상 추천과 구별되지 않고, 503도 Retry-After도 사라진다.
    const failure = quotaFailure();
    classify.mockResolvedValue('recommend_places');
    describePlaces.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 관광지'))).rejects.toBe(
      failure,
    );
  });

  it('plan_itinerary 갈래도 협력자 실패를 삼키지 않는다', async () => {
    // 위 케이스들은 전부 recommend 갈래로 센다. plan이 같은 협력자를 공유하게
    // 됐으므로 형제 갈래에 같은 계약이 있어야 한다 — replyPlan에만 try/catch가
    // 들어가면 이 테스트 없이는 아무도 모르고, TEI 장애가 200 + "장소를 찾지
    // 못했어요"로 둔갑해 사용자가 자기 조건을 고치려 든다.
    const failure = new ExternalServiceError('tei', 'unavailable', '연결 실패');
    classify.mockResolvedValue('plan_itinerary');
    embedQuery.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest(PLAN_MESSAGE))).rejects.toBe(
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
