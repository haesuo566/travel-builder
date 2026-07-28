import { Module } from '@nestjs/common';

import { ClientsModule } from '../clients/clients.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { QueryStructurer } from './query/query.structurer';

/**
 * DatabaseModule을 일부러 import하지 않는다. 지금은 DB가 필요 없고,
 * Postgres는 사내망에서만 도달하므로 배선하면 외부망에서 부팅이 매달린다.
 * 대화 이력을 저장하게 되면 그때 여기서 import한다.
 *
 * ClientsModule은 그 판단에 걸리지 않는다 — ConfigModule만 import하고 세
 * 클라이언트 생성자가 SDK 인스턴스만 만든다. 네트워크를 만지는 코드가 부팅
 * 경로에 없으므로 외부망에서도 부팅이 성공한다. GeminiClient를 여기 직접
 * 등록하지 않는 이유는 인스턴스 생성 경로를 둘로 만들지 않기 위해서다.
 *
 * 대가: ChatModule 하나를 띄우면 TeiClient·QdrantSearchClient도 함께
 * 인스턴스화되고 TEI_BASE_URL·QDRANT_URL을 getOrThrow한다. 네 키가 이미
 * validateEnv의 필수 목록이므로 실질 손해가 없다.
 */
@Module({
  imports: [ClientsModule],
  controllers: [ChatController],
  providers: [ChatService, IntentClassifier, QueryStructurer, OtherResponder],
})
export class ChatModule {}
