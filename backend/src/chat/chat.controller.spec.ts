import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import type { GeminiGenerateOptions } from '../clients/gemini/gemini.client';
import { GeminiClient } from '../clients/gemini/gemini.client';
import { ChatModule } from './chat.module';
import {
  OTHER_REPLY,
  PLAN_ITINERARY_PLACEHOLDER_REPLY,
  RECOMMEND_PLACES_PLACEHOLDER_REPLY,
} from './chat.service';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';

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
};

describe('ChatController', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    // 기존 계약 테스트들은 분류 결과에 의존하지 않는다. other로 고정해 두면
    // 세 갈래 중 하나가 항상 성립하고, 분기별 단정은 각 테스트가 따로 지정한다.
    generate.mockReset().mockResolvedValue('other');
    // 폴백 경로를 도는 테스트가 있어 스파이를 걸지 않으면 콘솔이 WARN으로 덮인다.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

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
      .compile();

    app = moduleFixture.createNestApplication();
    // main.ts와 같은 설정이어야 한다. 어긋나면 이 테스트가 프로덕션 동작을
    // 증명하지 못한다.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('ChatModule이 분류기와 Gemini 주입 경로를 제공한다', async () => {
    // ClientsModule import가 사라지면 이 요청 자체가 부팅 단계에서 죽는다.
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
      .compile();

    expect(moduleFixture.get(IntentClassifier)).toBeInstanceOf(
      IntentClassifier,
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
    // 세 갈래 모두 일정을 손대지 않는다. 각 분기에 실제 구현이 들어오면
    // 이 단정은 바뀌어야 한다.
    expect(body.itinerary).toEqual(itinerary);
  });

  it('message가 비어 있으면 400', async () => {
    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '', itinerary: createItinerary() })
      .expect(400);
  });

  it('itinerary가 없으면 400', async () => {
    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일' })
      .expect(400);
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

  it('DTO에 없는 속성은 제거한다', async () => {
    const itinerary = createItinerary();

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({
        message: '제주 2박3일',
        // 서버가 그대로 되돌려주는 itinerary 안에 심어야 whitelist 동작이 보인다.
        // 최상위에 심으면 응답이 애초에 그 필드를 담지 않으므로 아무것도 증명하지 못한다.
        itinerary: { ...itinerary, unexpected: '무시돼야 한다' },
      })
      .expect(200);

    const body = response.body as ChatResponseDto;
    expect(body.itinerary).not.toHaveProperty('unexpected');
    expect(body.itinerary).toEqual(itinerary);
  });

  it('세 분류값이 각각 다른 reply로 200이 된다', async () => {
    // 분기가 HTTP까지 관통하는지 본다. switch의 arm을 서로 바꾸면 여기가 깨진다.
    const itinerary = createItinerary();
    const replies: string[] = [];

    for (const intent of ['plan_itinerary', 'recommend_places', 'other']) {
      generate.mockResolvedValue(intent);

      const response = await request(app.getHttpServer())
        .post('/chat')
        .send({ message: '아무 말', itinerary })
        .expect(200);

      replies.push((response.body as ChatResponseDto).reply);
    }

    expect(replies).toEqual([
      PLAN_ITINERARY_PLACEHOLDER_REPLY,
      RECOMMEND_PLACES_PLACEHOLDER_REPLY,
      OTHER_REPLY,
    ]);
  });

  it('해석할 수 없는 응답이면 200 + other 문구가 나간다', async () => {
    // 폴백이 HTTP까지 관통한다. 진짜 other와 바이트 단위로 같은 응답이며
    // 구별은 IntentClassifier의 warn 로그에만 존재한다.
    generate.mockResolvedValue('분류: plan_itinerary 입니다');

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일 일정 짜줘', itinerary: createItinerary() })
      .expect(200);

    expect((response.body as ChatResponseDto).reply).toBe(OTHER_REPLY);
  });
});
