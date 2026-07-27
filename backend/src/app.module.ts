import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatModule } from './chat/chat.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    // 필수 env를 부팅 시 한 번에 확인한다. 네트워크를 요구하지 않으므로
    // 사내망 밖에서도 부팅이 매달리지 않는다. ClientsModule은 아직 배선하지
    // 않는다 — 소비자가 생길 때 그 모듈이 직접 import한다.
    ConfigModule.forRoot({ validate: validateEnv, cache: true }),
    ChatModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
