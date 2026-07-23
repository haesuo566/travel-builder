import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { generateContentMock, constructorMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  constructorMock: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
    constructor(opts: unknown) {
      constructorMock(opts);
    }
  },
}));

import { GeminiClient } from "../../src/clients/gemini.js";

beforeEach(() => {
  generateContentMock.mockReset();
  constructorMock.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
});

describe("GeminiClient", () => {
  it("GEMINI_API_KEY 없으면 생성자에서 throw", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiClient()).toThrow("GEMINI_API_KEY");
  });

  it("apiKey로 SDK를 초기화한다", () => {
    new GeminiClient();
    expect(constructorMock).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  it("generate가 기본 모델로 generateContent를 호출하고 텍스트를 반환한다", async () => {
    generateContentMock.mockResolvedValue({ text: "안녕" });
    const client = new GeminiClient();
    const result = await client.generate("hi");
    expect(result).toBe("안녕");
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-2.0-flash",
      contents: "hi",
      config: { systemInstruction: undefined, temperature: undefined },
    });
  });

  it("opts의 model/systemInstruction/temperature를 전달한다", async () => {
    generateContentMock.mockResolvedValue({ text: "x" });
    const client = new GeminiClient();
    await client.generate("hi", { model: "gemini-pro", systemInstruction: "sys", temperature: 0.2 });
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-pro",
      contents: "hi",
      config: { systemInstruction: "sys", temperature: 0.2 },
    });
  });

  it("GEMINI_MODEL 환경변수가 기본 모델을 덮어쓴다", async () => {
    process.env.GEMINI_MODEL = "gemini-custom";
    generateContentMock.mockResolvedValue({ text: "x" });
    const client = new GeminiClient();
    await client.generate("hi");
    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-custom" }),
    );
  });

  it("응답 text가 없으면 빈 문자열을 반환한다", async () => {
    generateContentMock.mockResolvedValue({ text: undefined });
    const client = new GeminiClient();
    expect(await client.generate("hi")).toBe("");
  });
});
