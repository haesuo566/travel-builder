import {
  BadRequestException,
  Body,
  Controller,
  Get,
  INestApplication,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import type { Server } from 'http';
import request from 'supertest';

import { ExternalServiceError } from './external-service.error';
import { ExternalServiceFilter } from './external-service.filter';

/**
 * 필터가 **무엇을 잡도록 선언됐는지**를 고정한다.
 *
 * 단위 테스트는 filter.catch()를 직접 부르므로 @Catch(...)의 인자가 한 번도
 * 평가되지 않는다 — @Catch()로 넓혀도 전부 통과한다. 그러면 ValidationPipe가
 * 던지는 BadRequestException까지 이 필터가 삼키고, kind가 없어
 * STATUS_BY_KIND[undefined] → response.status(undefined)로 400이 깨진 응답이 된다.
 *
 * 선택성은 양방향으로 고정해야 한다. 잡는 쪽만 확인하면 넓어진 것을 못 잡고,
 * 안 잡는 쪽만 확인하면 좁아진 것을 못 잡는다.
 *
 * 부팅 시 실제로 배선되는지(main.ts의 bootstrap)는 이 테스트의 범위가 아니다.
 */

class EchoDto {
  @IsString()
  name!: string;
}

@Controller()
class ProbeController {
  /** 매핑표를 실제 파이프라인에서 태운다. */
  @Get('quota')
  quota(): never {
    throw new ExternalServiceError('gemini', 'quota', '쿼터 소진');
  }

  @Get('auth')
  auth(): never {
    throw new ExternalServiceError('gemini', 'auth', '키 무효');
  }

  /** 필터가 삼키면 안 되는 예외. */
  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException('직접 던진 400');
  }

  /** ValidationPipe가 만드는 400. spec이 "4xx는 이 한 줄뿐"이라 못박은 자리다. */
  @Post('echo')
  echo(@Body() dto: EchoDto): { name: string } {
    return { name: dto.name };
  }
}

describe('ExternalServiceFilter (Nest 파이프라인)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new ExternalServiceFilter());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('ExternalServiceError는 매핑표대로 나간다', async () => {
    const res = await request(server).get('/quota');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body).toEqual({
      statusCode: 503,
      error: 'quota',
      message: '외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요.',
    });
  });

  it('kind가 다르면 상태도 다르다', async () => {
    const res = await request(server).get('/auth');

    expect(res.status).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body).toEqual({
      statusCode: 500,
      error: 'auth',
      message: '외부 서비스 인증에 실패했습니다.',
    });
  });

  it('BadRequestException을 삼키지 않는다', async () => {
    // @Catch()로 넓어지면 이 응답이 깨진다.
    const res = await request(server).get('/bad-request');

    expect(res.status).toBe(400);
    const body = res.body as { message: unknown; error?: unknown };
    expect(body.message).toBe('직접 던진 400');
    // kind 문구표가 끼어들면 안 된다.
    expect(JSON.stringify(res.body)).not.toContain('외부 서비스');
  });

  it('ValidationPipe의 400도 그대로 나간다', async () => {
    const res = await request(server).post('/echo').send({ name: 123 });

    expect(res.status).toBe(400);
    const body = res.body as { message: unknown; error?: unknown };
    // ValidationPipe의 message는 문자열 배열이다 — 필터가 가로채면 문자열이 된다.
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.error).toBe('Bad Request');
  });

  it('정상 요청은 필터를 거치지 않는다', async () => {
    const res = await request(server).post('/echo').send({ name: '여행' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: '여행' });
  });
});
