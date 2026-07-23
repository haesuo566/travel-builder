import { describe, it, expect, afterEach } from "vitest";
import { requireEnv, optionalEnv } from "../src/lib/env.js";

const KEY = "TEST_ENV_VAR_X";

afterEach(() => {
  delete process.env[KEY];
});

describe("requireEnv", () => {
  it("설정된 값을 반환한다", () => {
    process.env[KEY] = "hello";
    expect(requireEnv(KEY)).toBe("hello");
  });

  it("미설정이면 throw한다", () => {
    expect(() => requireEnv(KEY)).toThrow(KEY);
  });

  it("빈 문자열이면 throw한다", () => {
    process.env[KEY] = "";
    expect(() => requireEnv(KEY)).toThrow(KEY);
  });
});

describe("optionalEnv", () => {
  it("설정된 값을 반환한다", () => {
    process.env[KEY] = "v";
    expect(optionalEnv(KEY, "fb")).toBe("v");
  });

  it("미설정이면 fallback을 반환한다", () => {
    expect(optionalEnv(KEY, "fb")).toBe("fb");
  });
});
