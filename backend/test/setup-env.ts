/**
 * e2e 부팅용 더미 env.
 *
 * AppModule의 ConfigModule.forRoot({ validate })가 필수 키의 부재를 부팅 실패로
 * 처리하므로, 이 파일이 없으면 test/app.e2e-spec.ts가 env 없이 죽는다.
 * e2e가 검증하는 것은 HTTP 라우팅이지 실제 자격증명이 아니다.
 *
 * 더미 값이 실제 오설정을 가리지 않는 이유는, 이 파일이 e2e 실행에만 적용되고
 * 운영 부팅 경로에는 없기 때문이다. 주소를 discard 포트(9)로 둔 것은 실수로
 * 외부 호출이 일어나면 조용히 성공하는 대신 즉시 실패하게 하려는 것이다.
 *
 * 키를 더할 때는 src/config/env.validation.ts의 REQUIRED_KEYS와 .env.example을
 * 함께 본다.
 */
// TEI·Qdrant와 같은 discard 포트(9)를 쓴다. 기본 포트(5432)로 두면 개발
// 머신에 떠 있는 실제 Postgres에 가 닿는다 — 실측으로 확인했다(연결은 됐고
// 인증에서 거절당했다). 자격증명이 우연히 맞는 머신에서는 e2e가 실제 DB에
// 조용히 붙게 되므로, 실수로 나가면 즉시 실패하도록 주소를 옮긴다.
process.env.DATABASE_URL ??= 'postgres://e2e:e2e@127.0.0.1:9/e2e';
process.env.GEMINI_API_KEY ??= 'e2e-dummy-gemini-key';
process.env.TEI_BASE_URL ??= 'http://127.0.0.1:9';
process.env.QDRANT_URL ??= 'http://127.0.0.1:9';
process.env.CORS_ORIGIN ??= 'http://localhost:3000';
