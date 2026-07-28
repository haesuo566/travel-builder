import { validateEnv } from './env.validation';

/**
 * 부팅 시 fail-fast를 담당하는 유일한 지점이다.
 * 값의 도달성은 검사하지 않는다 — 그래야 외부망에서도 부팅이 된다.
 */

function completeEnv(): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgres://user:pw@db:5432/tb',
    GEMINI_API_KEY: 'key',
    TEI_BASE_URL: 'http://tei:8080',
    QDRANT_URL: 'http://qdrant:6333',
    CORS_ORIGIN: 'http://localhost:3000',
  };
}

/**
 * 키 하나를 뺀 env.
 * `const { DATABASE_URL: _omit, ...rest }` 구조분해는 뺀 변수가
 * no-unused-vars(error)에 걸린다 — typescript-eslint의 ignoreRestSiblings
 * 기본값이 false다.
 */
function envWithout(key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(completeEnv()).filter(([name]) => name !== key),
  );
}

describe('validateEnv', () => {
  it('필수 키가 모두 있으면 config를 그대로 반환한다', () => {
    const config = completeEnv();
    expect(validateEnv(config)).toBe(config);
  });

  it('선택 키가 없어도 통과한다', () => {
    // GEMINI_MODEL·QDRANT_API_KEY·QDRANT_COLLECTION은 기본값이 있다.
    expect(() => validateEnv(completeEnv())).not.toThrow();
  });

  it('DATABASE_URL이 없으면 throw한다', () => {
    expect(() => validateEnv(envWithout('DATABASE_URL'))).toThrow(
      'DATABASE_URL',
    );
  });

  it('TEI_BASE_URL 하나만 없어도 throw한다', () => {
    // 신규 키가 실제로 필수 목록에 들어갔는지 보는 단독 케이스다.
    expect(() => validateEnv(envWithout('TEI_BASE_URL'))).toThrow(
      'TEI_BASE_URL',
    );
  });

  it('GEMINI_API_KEY 하나만 없어도 throw한다', () => {
    expect(() => validateEnv(envWithout('GEMINI_API_KEY'))).toThrow(
      'GEMINI_API_KEY',
    );
  });

  it('QDRANT_URL 하나만 없어도 throw한다', () => {
    expect(() => validateEnv(envWithout('QDRANT_URL'))).toThrow('QDRANT_URL');
  });

  it('CORS_ORIGIN 하나만 없어도 throw한다', () => {
    // 이 키가 없으면 브라우저가 프론트엔드의 POST /chat을 CORS로 막는다.
    // 기본값을 주지 않는 이유는 운영에서 localhost가 조용히 허용되는 편보다
    // 부팅이 실패하는 편이 낫기 때문이다.
    expect(() => validateEnv(envWithout('CORS_ORIGIN'))).toThrow('CORS_ORIGIN');
  });

  it('빈 문자열도 누락으로 본다', () => {
    expect(() => validateEnv({ ...completeEnv(), QDRANT_URL: '' })).toThrow(
      'QDRANT_URL',
    );
  });

  it('전부 없으면 필수 키 이름이 한 메시지에 모두 등장한다', () => {
    // 하나씩 알려주면 여러 개가 비어 있을 때 그 개수만큼 재실행해야 한다.
    let message = '';
    try {
      validateEnv({});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('GEMINI_API_KEY');
    expect(message).toContain('TEI_BASE_URL');
    expect(message).toContain('QDRANT_URL');
    expect(message).toContain('CORS_ORIGIN');
    // 메시지 형식은 core의 requireEnv(core/src/lib/env.ts:5)와 같게 유지한다.
    expect(message).toContain('설정되지 않았습니다');
  });
});
