import { Injectable, Logger } from '@nestjs/common';

import { GeminiClient } from '../../clients/gemini/gemini.client';
import {
  buildQueryPrompt,
  normalizeQueryText,
  parseStructuredQuery,
  QUERY_SYSTEM_INSTRUCTION,
} from './query-prompt';
import type { StructuredQuery } from './structured-query';
import { EMPTY_CONDITIONS } from './structured-query';

/**
 * 폴백 로그에 남기는 정규화 결과의 상한.
 *
 * IntentClassifier와 같은 관용구다(intent.classifier.ts:20) — 전체 길이는 숫자로만,
 * 내용은 앞 40자까지. 이 로그가 답해야 하는 질문은 "프롬프트의 무엇을 고쳐야
 * 하는가"이고 실패 모양(펜스·머리말·라벨 변형)은 앞머리에서 드러난다.
 */
const LOG_SNIPPET_LIMIT = 40;

@Injectable()
export class QueryStructurer {
  private readonly logger = new Logger(QueryStructurer.name);

  constructor(private readonly gemini: GeminiClient) {}

  /**
   * 메시지를 검색 질의로 변환한다.
   *
   * 의미 축을 확보하지 못하면 warn 로그를 남기고 사용자 원문을 queryText로
   * 폴백한다 — 반환 타입에 null이 없는 것이 그 계약이다. 근거는 core의
   * buildMinimalText(structuredText.ts:91-105)와 같다: 건너뛰면 그 요청은 검색이
   * 아예 안 되고, 원문에도 검색 가치가 있다. 고정 포맷이 아니므로 색인 텍스트와
   * 같은 종류의 텍스트는 아니다 — core도 같은 예외를 둔다.
   *
   * 반면 Gemini 호출 자체의 실패는 삼키지 않는다. ExternalServiceError가 그대로
   * 올라간다 — 여기에 try/catch를 두면 쿼터 소진이 "질의를 이해하지 못했다"로
   * 둔갑한다(failure-attribution.md).
   */
  async structure(message: string): Promise<StructuredQuery> {
    const raw = await this.gemini.generate(buildQueryPrompt(message), {
      systemInstruction: QUERY_SYSTEM_INSTRUCTION,
      temperature: 0,
    });

    const parsed = parseStructuredQuery(raw);

    if (parsed === null) {
      // callExternal은 generate가 성공한 뒤의 판정을 모른다. 여기서 남기지 않으면
      // 폴백은 어디에도 흔적이 없다 — 응답은 200이고 조건 요약도 정상으로 보인다.
      const snippet = normalizeQueryText(raw).slice(0, LOG_SNIPPET_LIMIT);
      this.logger.warn(
        `질의 구조화 폴백: gemini 응답에서 질의 라벨을 얻지 못해 원문을 질의로 씁니다 (길이=${raw.length}): "${snippet}"`,
      );
      return {
        queryText: message,
        conditions: { ...EMPTY_CONDITIONS },
        droppedLabels: [],
        fellBackToRawMessage: true,
      };
    }

    if (parsed.droppedLabels.length > 0) {
      // 라벨 이름만 담고 값을 담지 않는다 — 값은 사용자 문장에서 왔다.
      this.logger.warn(
        `질의 구조화 일부 실패: 검증에 걸려 버린 항목 (${parsed.droppedLabels.join(', ')})`,
      );
    }

    return { ...parsed, fellBackToRawMessage: false };
  }
}
