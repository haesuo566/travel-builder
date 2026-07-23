import { describe, it, expect } from "vitest";
import { greet } from "../src/commands/hello.js";

describe("greet", () => {
  it("이름을 받으면 인사말을 만든다", () => {
    expect(greet("홍길동")).toBe("Hello, 홍길동!");
  });

  it("기본 world 이름도 처리한다", () => {
    expect(greet("world")).toBe("Hello, world!");
  });
});
