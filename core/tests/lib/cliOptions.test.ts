import { describe, it, expect } from "vitest";
import { parsePositiveInt } from "../../src/lib/cliOptions.js";

describe("parsePositiveInt", () => {
  it("정수 문자열을 숫자로 변환한다", () => {
    expect(parsePositiveInt("--daily-limit", "900", 1)).toBe(900);
  });

  it("값이 없으면 기본값을 쓴다", () => {
    expect(parsePositiveInt("--daily-limit", undefined, 900)).toBe(900);
  });

  it("숫자가 아니면 옵션 이름과 입력값을 담아 던진다", () => {
    expect(() => parsePositiveInt("--max-pages", "abc", 100)).toThrow("--max-pages");
    expect(() => parsePositiveInt("--max-pages", "abc", 100)).toThrow("abc");
  });

  it("0과 음수를 거부한다", () => {
    expect(() => parsePositiveInt("--page-size", "0", 1000)).toThrow();
    expect(() => parsePositiveInt("--page-size", "-5", 1000)).toThrow();
  });

  it("소수를 거부한다", () => {
    expect(() => parsePositiveInt("--page-size", "1.5", 1000)).toThrow();
  });

  it("빈 문자열을 거부한다", () => {
    expect(() => parsePositiveInt("--page-size", "", 1000)).toThrow();
  });
});
