/** 필수 환경 변수를 읽는다. 없거나 빈 문자열이면 throw. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`환경 변수 ${name}가 설정되지 않았습니다.`);
  }
  return value;
}

/** 선택 환경 변수를 읽는다. 없거나 빈 문자열이면 fallback을 반환. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}
