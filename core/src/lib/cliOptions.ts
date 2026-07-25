/**
 * CLI 숫자 옵션을 파싱한다.
 * 유효하지 않으면 던진다 — Number()가 만든 NaN이 그대로 흘러가면
 * 루프가 한 번도 돌지 않은 채 "완료 0건" 같은 성공 메시지를 찍어, 잘못된 입력이
 * 빈 결과로 위장된다.
 */
export function parsePositiveInt(
  optionName: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${optionName} 옵션은 1 이상의 정수여야 합니다: ${raw}`);
  }
  return value;
}
