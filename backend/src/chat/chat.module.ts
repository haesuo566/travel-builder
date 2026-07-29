import { Module } from '@nestjs/common';

import { ClientsModule } from '../clients/clients.module';
import { DatabaseModule } from '../database/database.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { QueryStructurer } from './query/query.structurer';

/**
 * ClientsModule은 ConfigModule만 import하고 세 클라이언트 생성자가 SDK
 * 인스턴스만 만든다. 네트워크를 만지는 코드가 부팅 경로에 없으므로 외부망에서도
 * 부팅이 성공한다. GeminiClient를 여기 직접 등록하지 않는 이유는 인스턴스 생성
 * 경로를 둘로 만들지 않기 위해서다.
 *
 * **DatabaseModule은 지금까지 일부러 배선하지 않았고, 이번에 그 판단이 뒤집힌다.**
 * 추천 갈래가 장소 제목을 tour_contents에서 읽으므로 소비자가 생겼다 — 미배선의
 * 근거였던 "지금은 DB가 필요 없다"가 사라졌다.
 *
 * 대가는 그때 예고한 그대로다: **부팅 경로가 처음으로 실제 Postgres 연결을
 * 포함한다.** TypeORM은 첫 쿼리가 아니라 모듈 초기화 시점에 연결하므로, 사내망
 * 밖에서는 어떤 라우트도 때리지 않은 채로 app.init()이 최악 ~17초 뒤 실패한다
 * (database.module.ts의 connectTimeoutMS·retryAttempts 주석). 그래서 Nest 모듈을
 * 실제로 컴파일하는 테스트는 DatabaseModule을 오버라이드해야 한다 —
 * chat.controller.spec.ts와 test/app.e2e-spec.ts가 그 둘이다.
 *
 * ClientsModule과 함께: ChatModule 하나를 띄우면 TeiClient·QdrantSearchClient도
 * 인스턴스화되어 TEI_BASE_URL·QDRANT_URL을, DatabaseModule이 DATABASE_URL을
 * getOrThrow한다. 세 키가 이미 validateEnv의 필수 목록이므로 실질 손해가 없다.
 */
@Module({
  imports: [ClientsModule, DatabaseModule],
  controllers: [ChatController],
  providers: [ChatService, IntentClassifier, QueryStructurer, OtherResponder],
})
export class ChatModule {}
