import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DatabaseModule } from './../src/database/database.module';
import { TourContent } from './../src/database/entities';
import { TourContentLookup } from './../src/database/tour-content.lookup';

/**
 * 실제 Postgres를 대신한다.
 *
 * ChatModule이 DatabaseModule을 import하면서 **AppModule의 부팅 경로가 처음으로
 * 실제 TypeORM 연결을 포함하게 됐다.** TypeORM은 첫 쿼리가 아니라 모듈 초기화
 * 시점에 연결하므로, 이 spec이 GET / 하나만 때려도 app.init()에서 연결이 일어난다.
 *
 * 실측 결과는 타임아웃이 아니라 `password authentication failed for user "e2e"`
 * 였다 — setup-env.ts의 더미 주소(127.0.0.1:5432)가 이 머신에 실제로 떠 있는
 * Postgres에 가 닿았다. e2e가 검증하는 것은 HTTP 라우팅이지 DB 자격증명이 아니다.
 */
@Module({
  providers: [
    TourContentLookup,
    { provide: getRepositoryToken(TourContent), useValue: {} },
  ],
  exports: [TourContentLookup],
})
class FakeDatabaseModule {}

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(FakeDatabaseModule)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
