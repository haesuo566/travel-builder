import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      // DTO에 없는 속성은 조용히 제거한다. forbidNonWhitelisted는 켜지 않는다 —
      // 프론트엔드가 필드를 하나 추가했을 때 400으로 깨지는 편보다 무시하는 편이 낫다.
      whitelist: true,
      // 평문 JSON을 DTO 인스턴스로 변환한다. @Type 기반 중첩 검증에 필요하다.
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
