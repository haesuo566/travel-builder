import { INestApplication, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';

import { configureApp } from '../app.setup';
import { ExternalServiceError } from '../clients/external-service.error';
import type { GeminiGenerateOptions } from '../clients/gemini/gemini.client';
import { GeminiClient } from '../clients/gemini/gemini.client';
import type {
  QdrantSearchOptions,
  TourSearchHit,
} from '../clients/qdrant/qdrant.client';
import { QdrantSearchClient } from '../clients/qdrant/qdrant.client';
import { TeiClient } from '../clients/tei/tei.client';
import { DatabaseModule } from '../database/database.module';
import { TourContent } from '../database/entities';
import { TourContentLookup } from '../database/tour-content.lookup';
import { ChatModule } from './chat.module';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { INTENT_SYSTEM_INSTRUCTION } from './intent/intent-prompt';
import { IntentClassifier } from './intent/intent.classifier';
import { OTHER_REPLY } from './other/other-prompt';
import { OtherResponder } from './other/other.responder';
import {
  PLAN_DESTINATION_UNKNOWN_REPLY,
  PLAN_READY_GUIDE,
} from './plan/plan-reply';
import {
  NO_CONDITIONS_SUMMARY,
  RECOMMEND_NO_HITS_TAIL,
  RECOMMEND_NOT_SEARCHED_TAIL,
  RECOMMEND_PLACES_HEAD,
  RECOMMEND_REPLY_HEAD,
} from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';

/**
 * POST /chat의 HTTP 계약을 고정한다. 컨트롤러 메서드를 직접 부르지 않고
 * 실제 요청을 보내는 이유는, 검증이 전역 ValidationPipe에서 일어나기 때문이다 —
 * 메서드를 직접 부르면 통과해야 할 400들이 전부 200이 된다.
 *
 * 일정 타입은 frontend/src/lib/types.ts에 복제돼 있다. 두 쪽이 어긋나면
 * 여기 fixture가 프론트엔드 mock과 다른 모양이 되므로 리뷰에서 드러난다.
 */

function createItinerary() {
  return {
    summary: {
      destination: '제주',
      duration: '2박 3일',
      travelers: '성인 2명',
    },
    days: [
      {
        day: 1,
        places: [
          {
            id: 'place-1',
            name: '성산일출봉',
            category: '관광지',
            time: '09:00',
            description: '일출 명소',
            pinNumber: 1,
          },
        ],
      },
    ],
  };
}

const generate = jest.fn<Promise<string>, [string, GeminiGenerateOptions?]>();

/**
 * recommend 갈래가 부르는 질의 임베딩.
 *
 * 오버라이드하지 않으면 아래 ENV의 TEI 주소로 실제 fetch가 나간다 — 실제로
 * 그렇게 됐다가 DNS 조회 실패로 드러났다. 단위 테스트는 전부 모킹이다
 * (tei.client.spec.ts:13이 같은 함정을 경고한다).
 */
const embedQuery = jest.fn<Promise<number[]>, [string]>();

/**
 * recommend 갈래가 부르는 장소 검색. embedQuery와 같은 함정이다 —
 * 오버라이드하지 않으면 ENV의 QDRANT_URL로 실제 요청이 나간다.
 */
const search = jest.fn<
  Promise<TourSearchHit[]>,
  [number[], QdrantSearchOptions?]
>();

/** 검색이 돌려주는 hit 하나. title만 화면에 나가므로 나머지는 형식만 채운다. */
const TOUR_HIT: TourSearchHit = {
  id: 'point-1',
  score: 0.9,
  payload: {
    contentid: '126508',
    contenttypeid: '12',
    ldong_regn_cd: '50',
    ldong_signgu_cd: '130',
    lcls_systm1: 'AC',
    lcls_systm2: 'AC01',
    lcls_systm3: 'AC0101',
    title: '성산일출봉',
    mapx: '126.9',
    mapy: '33.4',
  },
};

/**
 * tour_contents 조회. Qdrant hit의 contentid로 Postgres를 다시 읽는 경로다.
 *
 * TourContentLookup 자체를 mock 값으로 갈지 않고 **실물에 리포지토리만 모킹해
 * 넣는다** — 그래야 @InjectRepository 배선과 순서 재정렬이 HTTP까지 실제로
 * 도는지 확인할 수 있고, 아래 협력자 단정도 toBeInstanceOf로 셀 수 있다.
 */
const find = jest.fn<Promise<TourContent[]>, [unknown]>();

/**
 * TOUR_HIT에 대응하는 Postgres 행. **제목을 payload.title과 다른 단어로 둔다** —
 * 같으면 화면에 실린 이름의 출처가 색인 사본인지 DB인지 구별되지 않는다.
 */
function createRow(): TourContent {
  const row = new TourContent();
  row.contentid = '126508';
  row.title = '한라산';
  return row;
}

const TOUR_ROW = createRow();

/**
 * 실제 Postgres를 대신한다. DatabaseModule을 그대로 두면 TypeORM이 **첫 쿼리가
 * 아니라 app.init() 시점에** 연결하므로, 어떤 라우트를 때리든 상관없이 이 spec이
 * 실제 DB로 나간다(실측: ENV에 DATABASE_URL이 없어 getOrThrow가 던졌다).
 *
 * 리포지토리 프로바이더만 갈아서는 부족하다 — forRootAsync가 만드는 DataSource가
 * 독립적으로 초기화되며 연결한다. 그래서 모듈을 통째로 바꾼다.
 */
@Module({
  providers: [
    TourContentLookup,
    { provide: getRepositoryToken(TourContent), useValue: { find } },
  ],
  exports: [TourContentLookup],
})
class FakeDatabaseModule {}

/** 파싱에 성공하는 구조화 응답. 조건 하나만 담아 요약이 '미지정'이 되지 않게 한다. */
const QUERY_RESPONSE = [
  '[조건]',
  '지역: 제주',
  '[질의]',
  '무엇을 하는 곳: 일출 감상',
].join('\n');

/** 검증을 통과하는 대화 응답. OTHER_REPLY와 달라야 폴백과 정상을 구별할 수 있다. */
const OTHER_RESPONSE = '제주는 사계절 모두 좋아요. 어느 계절이 좋으세요?';

/**
 * 구조화 갈래는 요청 하나에 generate를 두 번 부른다 — 분류 1회 + 갈래별 1회.
 * 그래서 호출 지점을 systemInstruction으로 가른다. mockResolvedValueOnce 사슬을
 * 쓰면 호출 순서가 테스트마다 암묵 계약이 되고, 갈래가 늘 때 전부 다시 세어야 한다.
 */
function mockGemini(intentResponse: string, branchResponse: string): void {
  generate.mockImplementation((_prompt, opts) =>
    Promise.resolve(
      opts?.systemInstruction === INTENT_SYSTEM_INSTRUCTION
        ? intentResponse
        : branchResponse,
    ),
  );
}

/**
 * ClientsModule은 세 클라이언트를 전부 인스턴스화하고, TeiClient·QdrantSearchClient
 * 생성자가 TEI_BASE_URL·QDRANT_URL을 getOrThrow한다. 개발자의 .env·셸 환경에
 * 의존하면 키가 설정된 머신에서만 통과하므로 여기서 고정한다
 * (clients.module.spec.ts:19-27과 같은 이유).
 *
 * GeminiClient는 아래에서 오버라이드하므로 GEMINI_API_KEY가 생성자에 도달하지
 * 않지만, 오버라이드가 지워졌을 때 이 파일이 실제 SDK로 나가지 않게 함께 채운다.
 */
const ENV = {
  GEMINI_API_KEY: 'test-key',
  TEI_BASE_URL: 'http://tei.test:8080',
  QDRANT_URL: 'http://qdrant.test:6333',
  // DatabaseModule의 useFactory가 getOrThrow하므로 FakeDatabaseModule로 갈아도
  // 이 키가 없으면 ConfigModule 단계에서 죽는다. 값은 도달하지 않는다.
  DATABASE_URL: 'postgres://test:test@db.test:5432/test',
};

describe('ChatController', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    // 기존 계약 테스트들은 분류 결과에 의존하지 않는다. other로 고정해 두면
    // 세 갈래 중 하나가 항상 성립하고, 분기별 단정은 각 테스트가 따로 지정한다.
    generate.mockReset();
    mockGemini('other', OTHER_RESPONSE);
    embedQuery.mockReset().mockResolvedValue([0.1, 0.2, 0.3]);
    search.mockReset().mockResolvedValue([TOUR_HIT]);
    find.mockReset().mockResolvedValue([TOUR_ROW]);
    // 폴백 경로를 도는 테스트가 있어 스파이를 걸지 않으면 콘솔이 WARN으로 덮인다.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [() => ENV],
        }),
        ChatModule,
      ],
    })
      .overrideProvider(GeminiClient)
      .useValue({ generate })
      .overrideProvider(TeiClient)
      .useValue({ embedQuery })
      .overrideProvider(QdrantSearchClient)
      .useValue({ search })
      .overrideModule(DatabaseModule)
      .useModule(FakeDatabaseModule)
      .compile();

    app = moduleFixture.createNestApplication();
    // main.ts와 같은 설정이어야 한다. 어긋나면 이 테스트가 프로덕션 동작을
    // 증명하지 못한다. 직접 ValidationPipe를 붙이면 ExternalServiceFilter가
    // 빠져 모든 kind가 500 + "Internal server error"가 된다.
    // CORS 허용 origin이 실제로 무엇을 붙이는지는 test/external-service.e2e-spec.ts가
    // 고정한다. 여기서는 시그니처를 만족시키는 리터럴이면 된다.
    configureApp(app, 'http://localhost:3000');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('ChatModule이 여섯 협력자와 Gemini 주입 경로를 제공한다', async () => {
    // ClientsModule·DatabaseModule import가 사라지면 이 요청 자체가 부팅
    // 단계에서 죽는다.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [() => ENV],
        }),
        ChatModule,
      ],
    })
      .overrideProvider(GeminiClient)
      .useValue({ generate })
      .overrideModule(DatabaseModule)
      .useModule(FakeDatabaseModule)
      .compile();

    // 여섯을 모두 센다. 하나라도 provider에서 빠지면 ChatService 주입이 부팅
    // 단계에서 죽으므로, 제목이 말하는 "여섯 협력자"를 여기서 그대로 단정한다.
    expect(moduleFixture.get(IntentClassifier)).toBeInstanceOf(
      IntentClassifier,
    );
    expect(moduleFixture.get(QueryStructurer)).toBeInstanceOf(QueryStructurer);
    expect(moduleFixture.get(OtherResponder)).toBeInstanceOf(OtherResponder);
    // 앞 셋과 달리 ChatModule의 providers가 아니라 ClientsModule이 export한다.
    // 여기서만 오버라이드하지 않는 이유는 실물이어야 그 export가 끊긴 것을
    // 잡을 수 있기 때문이다 — 생성자는 네트워크를 만지지 않아 안전하다.
    expect(moduleFixture.get(TeiClient)).toBeInstanceOf(TeiClient);
    expect(moduleFixture.get(QdrantSearchClient)).toBeInstanceOf(
      QdrantSearchClient,
    );
    // 여섯째는 DatabaseModule이 export한다. FakeDatabaseModule로 갈아도 실물
    // 클래스를 등록하므로, export가 끊기거나 @InjectRepository가 어긋나면 여기서
    // 잡힌다 — 네트워크만 빠지고 DI 배선은 그대로 확인된다.
    expect(moduleFixture.get(TourContentLookup)).toBeInstanceOf(
      TourContentLookup,
    );
  });

  it('reply와 itinerary를 200으로 돌려준다', async () => {
    const itinerary = createItinerary();

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일로 가고 싶어', itinerary })
      .expect(200);

    const body = response.body as ChatResponseDto;
    expect(typeof body.reply).toBe('string');
    expect(body.reply.length).toBeGreaterThan(0);
    // beforeEach가 other로 고정한다. 이 갈래는 일정을 만들지 않으므로 요청에
    // 일정을 실어 보냈어도 응답은 none + null이다(게이트 1 Q3). 예전에는 입력을
    // 그대로 되돌려줬고, 그 echo가 사라진 것이 이번 변경의 핵심이다.
    expect(body.planStatus).toBe('none');
    expect(body.itinerary).toBeNull();
    // 요청 일정이 응답 어디에도 실리지 않는지는 아래 '요청에 실어 보낸 일정은
    // 어느 갈래에서도 …'가 mock 셋에 없는 목적지로 센다. 여기 fixture의 목적지는
    // 제주이고 OTHER_RESPONSE도 제주를 언급하므로 문자열 대조가 성립하지 않는다.
    expect(itinerary.summary.destination).toBe('제주');
  });

  it('message가 비어 있으면 400', async () => {
    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '', itinerary: createItinerary() })
      .expect(400);
  });

  it('itinerary가 없어도 400이 아니다', async () => {
    // 첫 턴이 이 요청이다. 400이던 것을 여는 변경이며, 이 경로가 막혀 있으면
    // 프론트가 일정 없이 대화를 시작할 수 없다.
    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '안녕하세요' })
      .expect(200);

    const body = response.body as ChatResponseDto;
    // planStatus가 none인 것은 요청에 일정이 없어서가 아니라 other 갈래여서다.
    // 갈래와 상태의 대응은 아래 '갈래별 planStatus…'가 따로 센다.
    expect(body.planStatus).toBe('none');
    expect(body.itinerary).toBeNull();
  });

  it('itinerary가 명시적 null이어도 400이 아니다', async () => {
    // ↔ 위 짝. @IsOptional()은 명시적 null을 막지 않고 값을 null로 남긴다(실측).
    // 프론트의 일정 상태 타입이 Itinerary | null이므로 이 모양이 실제로 온다.
    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '안녕하세요', itinerary: null })
      .expect(200);

    const body = response.body as ChatResponseDto;
    expect(body.planStatus).toBe('none');
    expect(body.itinerary).toBeNull();
  });

  it('허용되지 않은 category는 400', async () => {
    const itinerary = createItinerary();
    itinerary.days[0].places[0].category = '카페';

    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일', itinerary })
      .expect(400);
  });

  it('중첩된 일정의 필수 필드 누락도 400으로 잡는다', async () => {
    const itinerary = createItinerary();
    // @ValidateNested가 실제로 걸려 있는지 확인하는 케이스다.
    // 없으면 이 요청이 200으로 통과한다.
    delete (itinerary.days[0].places[0] as { name?: string }).name;

    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일', itinerary })
      .expect(400);
  });

  it('DTO에 없는 속성을 실어 보내도 200이다', async () => {
    // whitelist가 조용히 제거한다(forbidNonWhitelisted를 켜지 않았다).
    //
    // 제거 자체는 여기서 볼 수 없다 — 어느 갈래도 요청 일정을 되돌려주지 않으므로
    // 관측 창이 닫혔다. 제거 동작은 dto/chat-request.dto.spec.ts가 파이프를 직접
    // 불러 센다. 이 케이스가 지키는 것은 "추가 필드가 400을 만들지 않는다"뿐이다.
    await request(app.getHttpServer())
      .post('/chat')
      .send({
        message: '제주 2박3일',
        itinerary: { ...createItinerary(), unexpected: '무시돼야 한다' },
        unexpectedTop: '무시돼야 한다',
      })
      .expect(200);
  });

  it('세 분류값이 각각 다른 reply로 200이 된다', async () => {
    // 분기가 HTTP까지 관통하는지 본다. switch의 arm을 서로 바꾸면 여기가 깨진다.
    const itinerary = createItinerary();
    const replies: string[] = [];

    for (const intent of ['plan_itinerary', 'recommend_places', 'other']) {
      // 구조화 갈래는 QUERY_RESPONSE를, other 갈래는 그 문자열을 그대로 대화
      // 응답으로 받는다 — 검증을 통과하므로 셋이 서로 다른 문구가 된다.
      mockGemini(intent, intent === 'other' ? OTHER_RESPONSE : QUERY_RESPONSE);

      const response = await request(app.getHttpServer())
        .post('/chat')
        // 목적지 키워드가 걸리는 메시지여야 한다. plan 갈래가 목적지를 못
        // 알아들으면 준비 완료 문구가 아니라 안내 문구를 내므로, '아무 말'로는
        // 세 갈래의 정상 문구를 대조할 수 없다.
        .send({ message: '제주 2박3일 일정 짜줘', itinerary })
        .expect(200);

      replies.push((response.body as ChatResponseDto).reply);
    }

    expect(replies[0]).toContain(PLAN_READY_GUIDE);
    expect(replies[1]).toContain(RECOMMEND_REPLY_HEAD);
    // fixture의 [조건]이 실제로 파싱돼 화면까지 실렸는지 센다. 이 줄이 없으면
    // 구조화 폴백('조건: 미지정')이 발동해도 위 단정들이 전부 통과한다.
    // plan 갈래는 이제 구조화를 거치지 않으므로 recommend 쪽에서 센다.
    expect(replies[1]).toContain('지역: 제주');
    expect(replies[2]).toBe(OTHER_RESPONSE);
    // 세 문구가 실제로 갈리는지 센다. 위 셋만으로는 두 갈래가 같은 문장이
    // 돼도(머리말만 다르고 나머지가 뭉개져도) 통과할 수 있다.
    expect(new Set(replies).size).toBe(3);
  });

  it('갈래별 planStatus와 itinerary가 HTTP를 관통한다', async () => {
    // 목적지 키워드가 걸리는 같은 메시지로 세 갈래를 태운다. plan만 ready이고
    // 나머지 둘은 none이다 — 하위 spec이 각각 고정해도 그 합성이 HTTP를
    // 관통하는지는 별개이며, 그 공백에서 두 갈래가 뒤바뀐 전례가 있다.
    const statuses: string[] = [];
    const destinations: (string | undefined)[] = [];

    for (const intent of ['plan_itinerary', 'recommend_places', 'other']) {
      mockGemini(intent, intent === 'other' ? OTHER_RESPONSE : QUERY_RESPONSE);

      const response = await request(app.getHttpServer())
        .post('/chat')
        .send({ message: '제주 2박3일 일정 짜줘' })
        .expect(200);

      const body = response.body as ChatResponseDto;
      statuses.push(body.planStatus);
      destinations.push(body.itinerary?.summary.destination);
    }

    expect(statuses).toEqual(['ready', 'none', 'none']);
    // plan 갈래만 일정을 만든다. 목적지가 실렸는지까지 봐야 빈 일정으로도
    // ready가 통과하는 상태를 막을 수 있다.
    expect(destinations).toEqual(['제주', undefined, undefined]);
  });

  it('plan 갈래는 일정 내용을 채워 돌려준다', async () => {
    // ready인데 days가 비면 프론트는 빈 패널을 띄운다. 그 상태를 200으로
    // 통과시키지 않도록 내용을 센다.
    mockGemini('plan_itinerary', QUERY_RESPONSE);

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '부산 2박3일 일정 짜줘' })
      .expect(200);

    const body = response.body as ChatResponseDto;
    expect(body.planStatus).toBe('ready');
    expect(body.itinerary?.summary.destination).toBe('부산');
    expect(body.itinerary?.days).toHaveLength(3);
    expect(body.itinerary?.days[0].places.length).toBeGreaterThan(0);
  });

  it('plan 갈래도 목적지를 못 알아들으면 200 + none이 나간다', async () => {
    // ↔ 위 짝. 기본 목적지로 폴백하지 않는다(게이트 1 Q4). reply까지 세는 이유는
    // 설명 없는 none이 사용자에게 고장과 구별되지 않기 때문이다.
    mockGemini('plan_itinerary', QUERY_RESPONSE);

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '일정 짜줘' })
      .expect(200);

    const body = response.body as ChatResponseDto;
    expect(body.planStatus).toBe('none');
    expect(body.itinerary).toBeNull();
    expect(body.reply).toBe(PLAN_DESTINATION_UNKNOWN_REPLY);
  });

  it('요청에 실어 보낸 일정은 어느 갈래에서도 응답에 나타나지 않는다', async () => {
    // 게이트 1 Q3의 결정이 HTTP를 관통하는지 센다. 강릉은 mock 일정 셋에 없으므로
    // 응답 어디에도 나타나지 않아야 한다 — 나타나면 어느 갈래가 요청을
    // 되돌려주고 있고, planStatus를 만드는 지점이 둘로 늘어난 것이다.
    const itinerary = createItinerary();
    itinerary.summary.destination = '강릉';

    for (const intent of ['plan_itinerary', 'recommend_places', 'other']) {
      mockGemini(intent, intent === 'other' ? OTHER_RESPONSE : QUERY_RESPONSE);

      const response = await request(app.getHttpServer())
        .post('/chat')
        .send({ message: '제주 2박3일 일정 짜줘', itinerary })
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('강릉');
    }
  });

  it('plan 갈래는 gemini를 분류 1회만 호출한다', async () => {
    // ↔ 'message가 1000자면 …' 케이스(other 갈래 2회)의 짝이다. 목적지를 원문
    // 키워드로 고르므로 구조화 왕복이 없다 — 결과를 버리는 왕복이 되살아나면
    // 여기가 깨진다.
    mockGemini('plan_itinerary', QUERY_RESPONSE);

    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일 일정 짜줘' })
      .expect(200);

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('분류를 해석할 수 없으면 200 + other 갈래 응답이 나간다', async () => {
    // 폴백이 HTTP까지 관통한다. 진짜 other와 바이트 단위로 같은 응답이며
    // 구별은 IntentClassifier의 warn 로그에만 존재한다.
    mockGemini('분류: plan_itinerary 입니다', OTHER_RESPONSE);

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일 일정 짜줘', itinerary: createItinerary() })
      .expect(200);

    expect((response.body as ChatResponseDto).reply).toBe(OTHER_RESPONSE);
  });

  it('대화 응답이 상한을 넘으면 200 + 고정 문구가 나간다', async () => {
    // OtherResponder의 폴백이 HTTP까지 관통한다. 이 경로가 없으면 상한
    // 초과가 502로 새거나 빈 말풍선이 되는 회귀를 아무도 잡지 못한다.
    mockGemini('other', '가'.repeat(501));

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '안녕', itinerary: createItinerary() })
      .expect(200);

    expect((response.body as ChatResponseDto).reply).toBe(OTHER_REPLY);
  });

  it('질의 구조화에 실패하면 200 + 조건 미지정 요약이 나간다', async () => {
    // ↔ 위 짝. 구조화 폴백도 HTTP까지 관통한다. 사용자 원문은 queryText로
    // 폴백되지만 화면에는 절대 나가지 않는다 — 그 경계가 여기서 고정된다.
    // 구조화를 거치는 갈래가 recommend_places 하나로 좁혀졌다.
    mockGemini('recommend_places', '[조건]\n지역: 제주');

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천', itinerary: createItinerary() })
      .expect(200);

    const { reply } = response.body as ChatResponseDto;
    expect(reply).toBe(
      `${RECOMMEND_REPLY_HEAD} — ${NO_CONDITIONS_SUMMARY}. ${RECOMMEND_PLACES_HEAD} ${TOUR_ROW.title}`,
    );
    expect(reply).not.toContain('제주 관광지 추천');
  });

  it('검색된 장소 이름이 HTTP를 관통한다', async () => {
    // 문구 조립은 query-reply.spec.ts가 고정하지만, 그 이름이 실제로 Qdrant
    // 검색 → Postgres 조회를 거쳐 HTTP 본문까지 도달하는지는 별개다. 서비스가
    // 검색 결과를 버리고 조건 요약만 내보내도 하위 spec은 전부 초록불이다.
    mockGemini('recommend_places', QUERY_RESPONSE);
    search.mockResolvedValue([TOUR_HIT]);

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천' })
      .expect(200);

    const { reply } = response.body as ChatResponseDto;
    expect(reply).toContain('지역: 제주');
    // 이름의 출처가 Postgres인지 색인 사본인지를 두 단정으로 가른다. 긍정만
    // 두면 조회를 지우고 payload.title로 되돌려도 통과한다.
    expect(reply).toContain(TOUR_ROW.title);
    expect(reply).not.toContain(TOUR_HIT.payload.title);
  });

  it('hit의 contentid로 tour_contents를 조회한다', async () => {
    // Qdrant가 정하는 것은 어떤 장소를 어떤 순서로 보여줄지이고, 그 장소가
    // 무엇인지는 Postgres가 정한다. 조회에 넘어가는 값이 payload의 contentid가
    // 아니면 엉뚱한 행을 읽고도 응답은 정상 200이다.
    mockGemini('recommend_places', QUERY_RESPONSE);
    search.mockResolvedValue([TOUR_HIT]);

    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천' })
      .expect(200);

    expect(find).toHaveBeenCalledTimes(1);
  });

  it('hit이 0건이면 tour_contents를 조회하지 않는다', async () => {
    // ↔ 위 짝. 조회할 contentid가 없는데 왕복이 나가면 요청마다 빈 쿼리가
    // 하나씩 늘어난다.
    mockGemini('recommend_places', QUERY_RESPONSE);
    search.mockResolvedValue([]);

    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천' })
      .expect(200);

    expect(find).not.toHaveBeenCalled();
  });

  it('DB 조회가 실패하면 500이 나간다', async () => {
    // TypeORM 오류는 ExternalServiceError가 아니라 전역 필터를 타지 않는다 —
    // Nest 기본 처리로 500이 된다. 여기서 삼키면 DB 장애가 200 + "장소를 찾지
    // 못했어요"가 되어 프론트가 재시도 안내를 띄울 근거를 잃는다.
    mockGemini('recommend_places', QUERY_RESPONSE);
    find.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    // 500 경로는 Nest가 스택을 error로 찍는다. 스파이가 없으면 콘솔이 덮인다.
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천' })
      .expect(500);
  });

  it('hit이 0건이면 200 + 못 찾았다는 문구가 나간다', async () => {
    // ↔ 위 짝. 0건이 500이나 빈 말풍선이 되지 않는지 본다.
    mockGemini('recommend_places', QUERY_RESPONSE);
    search.mockResolvedValue([]);

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천' })
      .expect(200);

    const { reply } = response.body as ChatResponseDto;
    expect(reply).toContain(RECOMMEND_NO_HITS_TAIL);
    expect(reply).not.toContain(RECOMMEND_NOT_SEARCHED_TAIL);
  });

  it('qdrant가 unavailable로 실패하면 503이 나간다', async () => {
    // 다섯 번째 협력자도 전역 필터를 탄다. 여기서 삼키면 장애가 200 + "장소를
    // 찾지 못했어요"가 되어 프론트가 재시도 안내를 띄울 근거를 잃는다.
    mockGemini('recommend_places', QUERY_RESPONSE);
    search.mockRejectedValue(
      new ExternalServiceError('qdrant', 'unavailable', '연결 실패'),
    );

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천' })
      .expect(503);

    expect(response.body).toEqual({
      statusCode: 503,
      error: 'unavailable',
      message: '외부 서비스에 연결할 수 없습니다.',
    });
  });

  it('공백뿐인 메시지도 200으로 나간다', async () => {
    // @IsNotEmpty()는 공백뿐인 문자열을 통과시키므로 이 요청은 400이 아니다.
    // 구조화가 폴백하면 그 원문이 그대로 queryText가 되고, 임베딩에 그대로
    // 넘기면 TeiClient가 invalid-request로 던져 502가 된다. 폴백 행은 조용해서
    // (응답이 200이고 문장 틀도 정상) 서비스 단위 테스트만으로는 이 회귀가
    // HTTP까지 관통하는지 알 수 없다.
    mockGemini('recommend_places', '질의를 만들 수 없습니다.');
    // 실제 TeiClient의 계약을 그대로 흉내낸다 — 빈 질의는 네트워크를 타기 전에
    // 거절한다(tei.client.ts:43-55). 기본 mock으로 두면 방어가 사라져도 통과한다.
    embedQuery.mockImplementation((text) =>
      text.trim() === ''
        ? Promise.reject(
            new ExternalServiceError('tei', 'invalid-request', '빈 질의'),
          )
        : Promise.resolve([0.1, 0.2, 0.3]),
    );

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '   ' })
      .expect(200);

    const { reply } = response.body as ChatResponseDto;
    expect(reply).toContain(RECOMMEND_REPLY_HEAD);
    // 벡터가 없으면 검색도 없다. 여기서 호출이 새면 Qdrant가 무엇을 받는지
    // 아무도 정하지 않은 채로 실제 요청이 나간다.
    expect(search).not.toHaveBeenCalled();
    // hit 0건 문구를 쓰면 "조건에 맞는 장소가 없다"가 되지만 사실은 검색조차
    // 하지 않았다 — 두 문구가 HTTP에서도 갈리는지 센다.
    expect(reply).toContain(RECOMMEND_NOT_SEARCHED_TAIL);
    expect(reply).not.toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('gemini가 quota로 실패하면 503 + Retry-After가 나간다', async () => {
    // ChatModule 경로에서 전역 필터가 실제로 동작하는지 본다. configureApp
    // 대신 ValidationPipe를 직접 붙이면 이 테스트만 빨간불이 된다 —
    // 즉 이 케이스가 전역 배선 교체의 유일한 증거다.
    generate.mockRejectedValue(
      new ExternalServiceError('gemini', 'quota', '쿼터 소진'),
    );

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일', itinerary: createItinerary() })
      .expect(503);

    expect(response.headers['retry-after']).toBe('60');
    expect(response.body).toEqual({
      statusCode: 503,
      error: 'quota',
      message: '외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요.',
    });
  });

  it('gemini가 upstream으로 실패하면 502가 나간다', async () => {
    // kind별 매핑 전체는 external-service.filter.spec.ts가 고정한다.
    // chat 경로에서는 대표 2건(quota·upstream)만 태운다.
    generate.mockRejectedValue(
      new ExternalServiceError('gemini', 'upstream', '5xx'),
    );

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일', itinerary: createItinerary() })
      .expect(502);

    expect(response.headers['retry-after']).toBeUndefined();
    expect(response.body).toEqual({
      statusCode: 502,
      error: 'upstream',
      message: '외부 서비스에서 오류가 발생했습니다.',
    });
  });

  it('message가 1000자면 200이고 gemini를 호출한다', async () => {
    // 경계값을 상수에서 가져오지 않는다. 소스에서 읽으면 상한을 500으로
    // 바꿔도 테스트가 따라 움직여 경계가 옮겨진 사실을 아무도 못 잡는다.
    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '가'.repeat(1000), itinerary: createItinerary() })
      .expect(200);

    expect((response.body as ChatResponseDto).reply).toBe(OTHER_RESPONSE);
    // 2회다 — 분류 1회 + other 갈래 1회. 갈래 호출이 사라지면 여기가 깨진다.
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('message가 1001자면 400이고 gemini를 호출하지 않는다', async () => {
    // ↔ 위 짝. 호출 0건이 "우리 쪽에서 끊었다"는 증거다 — 상한이 없으면
    // 이 요청이 Gemini까지 나가 400 INVALID_ARGUMENT → 502로 오청구된다.
    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '가'.repeat(1001), itinerary: createItinerary() })
      .expect(400);

    expect(generate).not.toHaveBeenCalled();
  });
});
