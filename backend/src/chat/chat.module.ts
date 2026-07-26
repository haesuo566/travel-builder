import { Module } from '@nestjs/common';

import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * DatabaseModule을 일부러 import하지 않는다. 지금 스텁은 DB가 필요 없고,
 * Postgres는 사내망에서만 도달하므로 배선하면 외부망에서 부팅이 매달린다.
 * 대화 이력을 저장하게 되면 그때 여기서 import한다.
 */
@Module({
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
