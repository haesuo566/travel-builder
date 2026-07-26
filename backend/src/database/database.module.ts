import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  TourContent,
  TourContentType,
  TourLclsSystmCode,
  TourLdongCode,
} from './entities';

/**
 * Postgres 연결. core와 같은 DATABASE_URL 하나로 접속한다.
 *
 * 스키마 소유권은 core에 있다 (core/src/lib/tourContentsTable.ts,
 * core/src/commands/generateTourCodes.ts가 DDL을 직접 실행한다).
 * 그래서 synchronize는 반드시 false다 — true면 TypeORM이 엔티티 정의를 기준으로
 * core가 만든 테이블을 변경하려 든다. 같은 이유로 migrations도 두지 않는다.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: [
          TourContent,
          TourContentType,
          TourLdongCode,
          TourLclsSystmCode,
        ],
        // core가 스키마를 소유한다. 절대 true로 바꾸지 말 것.
        synchronize: false,
        // DB는 사내망에서만 도달한다. 외부망에서는 SYN이 RST 없이 버려지므로
        // connectTimeoutMS가 없으면 커널 TCP 타임아웃(~130초)까지 부팅이 매달린다.
        // retryAttempts는 실패 후 재시도 횟수만 정하고 한 번의 시도 길이는 제한하지
        // 않으므로, 이 값이 있어야 실제로 시간이 한정된다. 최악 3×5초 + 2×1초 ≈ 17초.
        connectTimeoutMS: 5000,
        retryAttempts: 3,
        retryDelay: 1000,
        logging: config.get<string>('NODE_ENV') !== 'production',
      }),
    }),
    // 리포지토리 프로바이더를 여기서 한 번 등록하고 아래 exports로 재수출한다 —
    // 기능 모듈이 각자 forFeature를 반복하지 않고 DatabaseModule만 import하면 된다.
    TypeOrmModule.forFeature([
      TourContent,
      TourContentType,
      TourLdongCode,
      TourLclsSystmCode,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
