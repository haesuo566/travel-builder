import { ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { ChatModule } from './chat.module';
import type { ChatResponseDto } from './dto/chat-response.dto';

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

describe('ChatController', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ChatModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // main.ts와 같은 설정이어야 한다. 어긋나면 이 테스트가 프로덕션 동작을 증명하지 못한다.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
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
    // 스텁은 일정을 손대지 않는다. LLM을 붙이면 이 단정은 바뀌어야 한다.
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
});
