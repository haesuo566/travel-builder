import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('@google/genai', () => ({ GoogleGenAI: jest.fn() }));
jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn() }));

import { ClientsModule } from './clients.module';
import { GeminiClient } from './gemini/gemini.client';
import { QdrantSearchClient } from './qdrant/qdrant.client';

const ENV = {
  GEMINI_API_KEY: 'test-key',
  QDRANT_URL: 'http://qdrant.test:6333',
};

function configModule(env: Record<string, string> = ENV) {
  // 개발자의 .env에 의존하면 키가 설정된 머신에서만 통과하는 테스트가 된다.
  // process.env가 load보다 우선하므로 skipProcessEnv까지 켠다.
  return ConfigModule.forRoot({
    ignoreEnvFile: true,
    skipProcessEnv: true,
    load: [() => env],
  });
}

describe('ClientsModule', () => {
  it('ConfigModule을 명시 주입하면 클라이언트가 모두 해석된다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [configModule(), ClientsModule],
    }).compile();

    expect(moduleRef.get(GeminiClient)).toBeInstanceOf(GeminiClient);
    expect(moduleRef.get(QdrantSearchClient)).toBeInstanceOf(
      QdrantSearchClient,
    );
  });

  it('두 클라이언트를 외부로 export한다', async () => {
    // providers에만 있고 exports에 없으면 위 테스트는 그대로 통과한다 —
    // 테스트 모듈이 ClientsModule을 import하면 provider 스코프 안에서
    // 해석되기 때문이다. 소비자 모듈 관점을 따로 세워야 export가 검증된다.
    class ConsumerModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [configModule(), ClientsModule],
      providers: [
        {
          provide: ConsumerModule,
          useFactory: (gemini: GeminiClient, qdrant: QdrantSearchClient) => ({
            gemini,
            qdrant,
          }),
          inject: [GeminiClient, QdrantSearchClient],
        },
      ],
    }).compile();

    const consumer = moduleRef.get<{
      gemini: GeminiClient;
      qdrant: QdrantSearchClient;
    }>(ConsumerModule);
    expect(consumer.gemini).toBeInstanceOf(GeminiClient);
    expect(consumer.qdrant).toBeInstanceOf(QdrantSearchClient);
  });

  it('전역 모듈이 아니다 — import하지 않은 모듈은 주입받지 못한다', async () => {
    // @Global()을 붙이면 의존 관계가 모듈 그래프에서 사라져 누가 무엇을 쓰는지
    // 코드로 추적할 수 없게 된다.
    //
    // "ClientsModule을 아예 안 넣고 get이 throw하는가"로는 이걸 주장할 수 없다.
    // 전역 등록은 그 모듈이 그래프에 **import됐을 때** 일어나므로, 넣지 않은
    // 그래프에서는 @Global()을 붙여도 똑같이 throw한다 — 조건이 fixture에 없다.
    // 그래서 ClientsModule을 import한 모듈 하나와 import하지 않은 모듈 하나를
    // 같은 그래프에 세운다. 전역이면 후자도 해석되어 이 단정이 빨간불이 된다.
    @Module({ imports: [configModule(), ClientsModule] })
    class OwnerModule {}

    @Module({
      providers: [
        {
          provide: 'STRANGER',
          useFactory: (gemini: GeminiClient) => gemini,
          inject: [GeminiClient],
        },
      ],
    })
    class StrangerModule {}

    await expect(
      Test.createTestingModule({
        imports: [OwnerModule, StrangerModule],
      }).compile(),
    ).rejects.toThrow(/GeminiClient/);
  });

  it('필수 env가 없으면 모듈 초기화가 실패한다', async () => {
    // 클라이언트 생성자의 getOrThrow가 모듈 조립 시점에 돈다. 이 계약이 깨지면
    // 키 없는 배포가 부팅에 성공하고 첫 사용자 요청에서야 드러난다.
    await expect(
      Test.createTestingModule({
        imports: [configModule({}), ClientsModule],
      }).compile(),
    ).rejects.toThrow();
  });
});
