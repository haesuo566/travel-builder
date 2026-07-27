import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { callExternal } from '../call-external';
import { ExternalServiceError } from '../external-service.error';
import { classifyGeminiFailure } from './gemini.errors';

/** core의 GenerateOptions(core/src/clients/gemini.ts:4-8)와 같은 모양이다. */
export interface GeminiGenerateOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
}

/**
 * env로 열지 않는다 — 운영에서 조정이 필요해지면 그때 키를 판다.
 *
 * AbortSignal은 우리 쪽만 끊는다. 504를 돌려준 요청도 Gemini에서는 완주하고
 * 과금된다. 짧게 잡을수록 "돈은 쓰고 응답은 못 받는" 구간이 커진다 —
 * 20초는 실측 후 조정 대상이지 근거 있는 최적값이 아니다.
 */
const GEMINI_TIMEOUT_MS = 20000;

/** core의 기본 모델(core/src/clients/gemini.ts:17)과 같은 값을 유지한다. */
const DEFAULT_MODEL = 'gemini-2.0-flash';

/** Gemini 텍스트 생성 클라이언트 (생성 전용). 임베딩은 만들지 않는다. */
@Injectable()
export class GeminiClient {
  private readonly client: GoogleGenAI;
  private readonly defaultModel: string;

  constructor(config: ConfigService) {
    // 생성자는 네트워크를 만지지 않는다. 첫 실제 호출에서 네트워크를 만난다.
    this.client = new GoogleGenAI({
      apiKey: config.getOrThrow<string>('GEMINI_API_KEY'),
    });
    // ConfigService.get의 두 번째 인자(기본값)를 쓰지 않는다. 그 인자는 값이
    // undefined일 때만 폴백해서 .env의 "GEMINI_MODEL="(값만 빈 줄)을 유효한 값으로
    // 받는다. core의 optionalEnv는 ''도 폴백하므로 같은 .env로 core는 돌고
    // backend만 죽는다. 모델 이름이 ''인 상황은 존재하지 않으니 ||가 안전하다.
    // trim까지 하는 이유는 ||가 공백 문자열을 truthy로 보기 때문이다 — 그러면
    // 모델명이 '  '인 요청이 실제로 Gemini까지 나갔다가 404로 돌아온다.
    this.defaultModel =
      config.get<string>('GEMINI_MODEL')?.trim() || DEFAULT_MODEL;
  }

  /** 프롬프트로 텍스트를 생성한다. core의 generate와 같은 시그니처다. */
  generate(prompt: string, opts: GeminiGenerateOptions = {}): Promise<string> {
    // operation에 프롬프트 전문 대신 길이만 넣는다 — 로그에 프롬프트가 남지 않는다.
    return callExternal(
      'gemini',
      `generateContent(prompt=${prompt.length}자)`,
      classifyGeminiFailure,
      async () => {
        const response = await this.client.models.generateContent({
          // ??가 아니라 ||다. nullish 연산자는 ''를 유효한 모델명으로 통과시킨다.
          // env 경로와 독립이라 trim도 여기서 한 번 더 한다.
          model: opts.model?.trim() || this.defaultModel,
          contents: prompt,
          config: {
            systemInstruction: opts.systemInstruction,
            temperature: opts.temperature,
            abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          },
        });

        const text = response.text ?? '';
        if (text.trim() === '') {
          // core는 빈 문자열을 성공으로 반환하고 뒤의 validateStructuredText가 잡는다.
          // backend에는 그 검증기가 없고 빈 문자열은 빈 채팅 말풍선으로 렌더된다.
          throw new ExternalServiceError(
            'gemini',
            'empty-response',
            'gemini가 빈 텍스트를 반환했습니다.',
          );
        }
        return text;
      },
    );
  }
}
