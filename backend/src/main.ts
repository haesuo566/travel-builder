import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // ConfigService.get의 두 번째 인자(기본값)를 쓰지 않는다. CORS_ORIGIN은
  // validateEnv의 필수 키이므로 여기 도달하면 이미 존재가 보장돼 있다.
  const corsOrigin = app.get(ConfigService).getOrThrow<string>('CORS_ORIGIN');
  configureApp(app, corsOrigin);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
