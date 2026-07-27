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
 * 여기서 보는 것은 **configureApp을 부르면 그게 붙는가** 하나다 — 파이프와 필터
 * 양쪽을 한 건씩만 태운다.
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
    configureApp(app);
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
});
