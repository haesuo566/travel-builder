/**
 * 필수 환경 변수. 여기에 키를 더하면 .env.example과 test/setup-env.ts도 함께 고친다
 * (.claude/skills/tb-tdd-implement/references/workspaces.md의 경계표 참조).
 */
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'TEI_BASE_URL',
  'QDRANT_URL',
] as const;

/**
 * 환경 변수 검증. core/src/lib/env.ts의 requireEnv와 같은 규칙 —
 * 없거나 빈 문자열이면 throw한다.
 *
 * 부팅 시점에 실패시키는 이유는, DATABASE_URL이 비어 있으면 TypeORM이
 * localhost로 조용히 붙으려 하다 커넥션 단계에서야 터지기 때문이다.
 * 외부 서비스 키도 같다 — 없으면 첫 요청이 올 때까지 문제가 드러나지 않는다.
 *
 * 값의 도달성은 검사하지 않는다. 이 성질이 사내망 밖에서도 부팅을 가능하게 한다.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  // 누락 키를 전부 모아 한 번에 보고한다. 하나씩 알려주면 네 개가 비어 있을 때
  // 네 번 재실행해야 한다.
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value === '';
  });

  if (missing.length > 0) {
    throw new Error(`환경 변수 ${missing.join(', ')}가 설정되지 않았습니다.`);
  }
  return config;
}
