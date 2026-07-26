/**
 * 환경 변수 검증. core/src/lib/env.ts의 requireEnv와 같은 규칙 —
 * 없거나 빈 문자열이면 throw한다.
 *
 * 부팅 시점에 실패시키는 이유는, DATABASE_URL이 비어 있으면 TypeORM이
 * localhost로 조용히 붙으려 하다 커넥션 단계에서야 터지기 때문이다.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const url = config.DATABASE_URL;
  if (typeof url !== 'string' || url === '') {
    throw new Error('환경 변수 DATABASE_URL이 설정되지 않았습니다.');
  }
  return config;
}
