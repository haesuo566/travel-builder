import { GoogleGenAI } from "@google/genai";
import { optionalEnv, requireEnv } from "../lib/env.js";

export interface GenerateOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
}

/** Gemini 텍스트 생성 클라이언트 (생성 전용). */
export class GeminiClient {
  private readonly client: GoogleGenAI;
  private readonly defaultModel: string;

  constructor() {
    const apiKey = requireEnv("GEMINI_API_KEY");
    this.defaultModel = optionalEnv("GEMINI_MODEL", "gemini-2.0-flash");
    this.client = new GoogleGenAI({ apiKey });
  }

  /** 프롬프트로 텍스트를 생성해 문자열로 반환한다. */
  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const response = await this.client.models.generateContent({
      model: opts.model ?? this.defaultModel,
      contents: prompt,
      config: {
        systemInstruction: opts.systemInstruction,
        temperature: opts.temperature,
      },
    });
    return response.text ?? "";
  }
}
