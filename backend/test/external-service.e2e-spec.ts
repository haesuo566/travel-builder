import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import type { Server } from 'http';
import request from 'supertest';

import { configureApp } from './../src/app.setup';
import { ExternalServiceError } from './../src/clients/external-service.error';

/**
 * configureApp이 실제로 무엇을 붙이는지 고정한다.
 *
 * 전역 배선이 main.ts 안에만 있으면 어떤 테스트도 그 줄을 태우지 못한다 —
 * app.e2e-spec.ts는 createNestApplication()만 부르고 bootstrap()을 거치지 않아
 * useGlobalPipes·useGlobalFilters가 하나도 적용되지 않는다. 단위 spec은
 * ArgumentsHost를 위조한다. 그래서 배선 한 줄을 지워도 전부 초록불이었다(F-5).
 *
 * 필터가 **무엇을 잡는가**는 external-service.filter.nest.spec.ts가 이미 고정한다.
 * 여기서 보는 것은 **configureApp을 부르면 그게 붙는가** 하나다 — 파이프·필터·CORS
 * 세 쪽을 한 건씩만 태운다.
 *
 * CORS를 POST /chat이 아니라 이 프로브 컨트롤러로 확인하는 이유는, chat 경로가
 * IntentClassifier를 거쳐 Gemini를 왕복하기 때문이다(src/chat/chat.service.ts:33).
 * enableCors는 전역 미들웨어라 라우트를 가리지 않으므로, 외부 의존이 없는
 * 프로브 라우트에서 확인하는 편이 같은 것을 증명하면서 더 싸다.
 */

class EchoDto {
  @IsString()
  name!: string;
}

@Controller()
class WiringProbeController {
  /** 필터가 붙어 있지 않으면 500 + "Internal server error"가 된다. */
  @Get('wiring/quota')
  quota(): never {
    throw new ExternalServiceError('gemini', 'quota', '쿼터 소진');
  }

  /** ValidationPipe가 붙어 있지 않으면 400이 아니라 201이 된다. */
  @Post('wiring/echo')
  echo(@Body() dto: EchoDto): { name: string } {
    return { name: dto.name };
  }
}

/**
 * 이 파일이 configureApp에 넘기는 값. process.env.CORS_ORIGIN을 읽지 않는다 —
 * 읽으면 setup-env.ts와 개발자 .env 중 무엇이 이겼는지에 따라 단정이 흔들린다.
 */
const ALLOWED_ORIGIN = 'http://localhost:3000';
const DISALLOWED_ORIGIN = 'http://evil.test';

describe('configureApp 전역 배선 (e2e)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WiringProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    // main.ts가 부르는 것과 같은 함수다. 진입 경로가 둘이면 같은 함수를
    // 재사용하게 만든다(circuit-breaker-entry-paths.md).
    configureApp(app, ALLOWED_ORIGIN);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('configureApp이 ExternalServiceFilter를 붙인다', async () => {
    const res = await request(server).get('/wiring/quota');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    const body = res.body as { error?: unknown };
    expect(body.error).toBe('quota');
  });

  it('configureApp이 ValidationPipe를 붙인다', async () => {
    // 필터만 확인하면 파이프 배선이 사라져도 초록불이다. 같은 함수가 붙이는 것을
    // 둘 다 태운다.
    const res = await request(server).post('/wiring/echo').send({ name: 123 });

    expect(res.status).toBe(400);
  });

  it('configureApp이 허용 origin의 preflight를 통과시킨다', async () => {
    // 프론트엔드의 POST /chat은 Content-Type: application/json이라 브라우저가
    // 먼저 OPTIONS를 보낸다. 이게 막히면 본 요청은 아예 나가지 않는다.
    const res = await request(server)
      .options('/wiring/echo')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('허용 origin의 실제 요청 응답에 CORS 헤더가 붙는다', async () => {
    const res = await request(server)
      .post('/wiring/echo')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ name: '테스트' });

    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('허용되지 않은 origin에는 CORS 헤더를 붙이지 않는다', async () => {
    // 위 케이스와 Origin 헤더만 다른 짝이다. 이 단정이 없으면 origin을 true로
    // 바꿔 임의 사이트를 허용해도 전 스위트가 초록불이다.
    //
    // status 201을 함께 단정하는 이유: 헤더 부재만 보면 enableCors를 통째로
    // 지워도 통과한다. cors는 요청을 서버에서 막지 않고 헤더만 뺀다 —
    // 차단은 브라우저가 한다. 그래서 "요청은 처리됐고 헤더만 없다"까지가
    // 이 케이스가 고정하려는 상태다.
    const res = await request(server)
      .post('/wiring/echo')
      .set('Origin', DISALLOWED_ORIGIN)
      .send({ name: '테스트' });

    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
