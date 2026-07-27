import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { GeminiClient } from './gemini/gemini.client';
import { QdrantSearchClient } from './qdrant/qdrant.client';
import { TeiClient } from './tei/tei.client';

/**
 * 외부 서비스 클라이언트 모음.
 *
 * @Global()을 쓰지 않는다 — 전역 모듈은 의존 관계를 모듈 그래프에서 지운다
 * (DatabaseModule이 전역이 아닌 것과 같은 이유). 소비자가 생기면 그 모듈이
 * 이 모듈을 import한다. 이번엔 AppModule에 넣지 않는다 — 지금 배선하면
 * chat이 클라이언트를 주입하는 시점에 지워야 할 import가 된다.
 *
 * imports: [ConfigModule]은 database.module.ts:23과 같은 패턴이다.
 */
@Module({
  imports: [ConfigModule],
  providers: [GeminiClient, TeiClient, QdrantSearchClient],
  exports: [GeminiClient, TeiClient, QdrantSearchClient],
})
export class ClientsModule {}
