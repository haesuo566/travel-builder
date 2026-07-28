import { INestApplication, ValidationPipe } from '@nestjs/common';

import { ExternalServiceFilter } from './clients/external-service.filter';

/**
 * 전역 파이프·필터 배선. main.ts와 e2e가 같은 함수를 부른다.
 *
 * 분리한 이유: 배선이 main.ts 안에만 있으면 어떤 테스트도 그 줄을 태우지 못한다.
 * e2e는 createNestApplication()만 부르고 bootstrap()을 거치지 않으므로,
 * useGlobalFilters를 지워도 전 스위트가 초록불이었다 — 그 상태로 배포되면
 * 모든 kind가 500 + "Internal server error"가 되고 에러 처리 표가 통째로 무효가 된다.
 *
 * corsOrigin을 ConfigService에서 직접 꺼내지 않고 인자로 받는 이유는 두 가지다.
 * (1) 호출부 중 test/external-service.e2e-spec.ts는 ConfigModule을 import하지
 * 않는 프로브 모듈이라 app.get(ConfigService)가 부팅 단계에서 죽는다.
 * (2) 인자로 받으면 키를 더할 때 타입 검사가 호출부 전부를 강제로 짚어준다 —
 * 컨테이너에서 꺼내면 그 연결이 런타임까지 미뤄진다.
 */
export function configureApp(app: INestApplication, corsOrigin: string): void {
  // 배열로 넘긴다. 문자열로 넘기면 cors@2.8.6이 요청 Origin과 무관하게 그 값을
  // 항상 Access-Control-Allow-Origin으로 되돌려주므로(lib/index.js의
  // configureOrigin), 허용되지 않은 origin에 헤더가 붙지 않는다는 사실을
  // 테스트가 고정할 수 없다. 배열이면 isOriginAllowed를 거쳐 불일치 시 헤더가
  // 아예 빠진다.
  //
  // credentials는 켜지 않는다 — 인증·쿠키가 아직 없다. 와일드카드도 쓰지 않는다.
  app.enableCors({ origin: [corsOrigin] });
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
