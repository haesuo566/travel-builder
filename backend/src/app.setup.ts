import { INestApplication, ValidationPipe } from '@nestjs/common';

import { ExternalServiceFilter } from './clients/external-service.filter';

/**
 * 전역 파이프·필터 배선. main.ts와 e2e가 같은 함수를 부른다.
 *
 * 분리한 이유: 배선이 main.ts 안에만 있으면 어떤 테스트도 그 줄을 태우지 못한다.
 * e2e는 createNestApplication()만 부르고 bootstrap()을 거치지 않으므로,
 * useGlobalFilters를 지워도 전 스위트가 초록불이었다 — 그 상태로 배포되면
 * 모든 kind가 500 + "Internal server error"가 되고 에러 처리 표가 통째로 무효가 된다.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      // DTO에 없는 속성은 조용히 제거한다. forbidNonWhitelisted는 켜지 않는다 —
      // 프론트엔드가 필드를 하나 추가했을 때 400으로 깨지는 편보다 무시하는 편이 낫다.
      whitelist: true,
      // 평문 JSON을 DTO 인스턴스로 변환한다. @Type 기반 중첩 검증에 필요하다.
      transform: true,
    }),
  );
  // 외부 서비스 실패의 HTTP 매핑은 여기 한 곳뿐이다.
  app.useGlobalFilters(new ExternalServiceFilter());
}
