import type { GeminiClient } from "../clients/gemini.js";
import type { TeiEmbeddingClient } from "../clients/tei.js";
import type { QdrantStore } from "../clients/qdrant.js";
import type { PostgresClient } from "../clients/postgres.js";
import type { CollectionInfo } from "../lib/qdrantCollection.js";
import type { EnrichInput } from "../lib/tourContentsTable.js";
import { toPayload, toPointId } from "../lib/qdrantCollection.js";
import {
  fetchEnrichInput,
  markEmbedDone,
  markEmbedFailure,
  markStructureDone,
  markStructureFailure,
} from "../lib/tourContentsTable.js";
import {
  STRUCTURE_SYSTEM_INSTRUCTION,
  buildMinimalText,
  buildStructurePrompt,
  needsFallback,
  validateStructuredText,
} from "../lib/structuredText.js";
import { logger } from "../lib/logger.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_GEMINI_RETRIES = 3;
/** 연속 실패가 이 횟수에 이르면 개별 항목 문제가 아니라 시스템 장애로 본다. */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;
const RETRY_BASE_DELAY_MS = 2000;

export interface EnrichStats {
  /** 이번 실행에서 새로 구조화한 건수 (폴백 포함). 기존 텍스트 재사용은 세지 않는다. */
  structured: number;
  /** overview가 비어 Gemini 없이 최소 텍스트로 처리한 건수. */
  fallback: number;
  structureRetry: number;
  structureFailed: number;
  embedded: number;
  embedRetry: number;
  embedFailed: number;
  /** Gemini 한도로 구조화를 건너뛴 건수. 상태·시도횟수는 변경하지 않았다. */
  geminiRateLimited: number;
  /** 연속 실패 차단기가 작동해 스스로를 끈 상태. */
  disabled: boolean;
}

export interface Enricher {
  /** 상세 저장 직후 구조화·임베딩 체인을 수행한다. DB 쓰기 실패만 throw한다. */
  enrich(contentid: string): Promise<void>;
  stats(): EnrichStats;
}

export interface EnricherOptions {
  maxAttempts?: number;
  /** 429 백오프 재시도 횟수. 기본 3 (2s → 4s → 8s). */
  geminiRetries?: number;
  maxConsecutiveFailures?: number;
  /** 테스트에서 대기 없이 돌리기 위한 주입점. */
  sleep?: (ms: number) => Promise<void>;
}

function readProp(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

/**
 * Gemini 오류가 rate limit인지 판별한다.
 * SDK가 status를 노출하지 않는 경우가 있어 메시지 패턴도 함께 본다
 * (Gemini는 한도 초과를 RESOURCE_EXHAUSTED / Quota exceeded로 알린다).
 */
export function isRateLimited(error: unknown): boolean {
  if (readProp(error, "status") === 429) return true;
  if (readProp(error, "code") === 429) return true;
  const message = error instanceof Error ? error.message : "";
  return /429|rate limit|RESOURCE_EXHAUSTED|quota/i.test(message);
}

export function createEnricher(
  gemini: GeminiClient,
  tei: TeiEmbeddingClient,
  qdrant: QdrantStore,
  pg: PostgresClient,
  collection: CollectionInfo,
  opts: EnricherOptions = {},
): Enricher {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const geminiRetries = opts.geminiRetries ?? DEFAULT_GEMINI_RETRIES;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const stats: EnrichStats = {
    structured: 0,
    fallback: 0,
    structureRetry: 0,
    structureFailed: 0,
    embedded: 0,
    embedRetry: 0,
    embedFailed: 0,
    geminiRateLimited: 0,
    disabled: false,
  };
  let consecutiveFailures = 0;

  /** 429면 지수 백오프로 재시도한다. 소진하면 원래 오류를 그대로 던진다. */
  async function callGemini(prompt: string): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await gemini.generate(prompt, {
          systemInstruction: STRUCTURE_SYSTEM_INSTRUCTION,
          temperature: 0,
        });
      } catch (error) {
        if (!isRateLimited(error) || attempt >= geminiRetries) throw error;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  /**
   * 구조화 텍스트를 확보한다.
   * null 반환 = 이번 실행에서 확보하지 못했다(상태는 이미 기록했거나 의도적으로 건드리지 않았다).
   */
  async function ensureStructuredText(input: EnrichInput): Promise<string | null> {
    if (input.structuredText !== null && input.structuredText !== "") {
      return input.structuredText; // 이미 구조화됨 — Gemini 재호출 없음
    }

    if (needsFallback(input)) {
      // 고정 포맷이 아니므로 validateStructuredText를 적용하지 않는다.
      const text = buildMinimalText(input);
      await markStructureDone(pg, input.contentid, text);
      stats.fallback += 1;
      stats.structured += 1;
      consecutiveFailures = 0;
      return text;
    }

    let text: string;
    try {
      // try는 외부 호출만 감싼다 — DB 쓰기 실패를 데이터 문제로 오분류하지 않기 위해.
      text = await callGemini(buildStructurePrompt(input));
      validateStructuredText(text);
    } catch (error) {
      if (isRateLimited(error)) {
        // 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이다. 항목에 책임을 묻지 않는다.
        stats.geminiRateLimited += 1;
        logger.error(
          `Gemini 한도 초과로 구조화를 건너뜁니다 (contentid=${input.contentid}). ` +
            `상세 수집은 계속됩니다.`,
        );
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`구조화 실패 (contentid=${input.contentid}): ${message}`);
      const status = await markStructureFailure(pg, input.contentid, message, maxAttempts);
      if (status === "failed") stats.structureFailed += 1;
      else stats.structureRetry += 1;
      consecutiveFailures += 1;
      return null;
    }

    await markStructureDone(pg, input.contentid, text);
    stats.structured += 1;
    consecutiveFailures = 0;
    return text;
  }

  async function embedAndUpsert(input: EnrichInput, text: string): Promise<void> {
    const pointId = toPointId(input.contentid);
    if (pointId === null) {
      // 재시도해도 숫자가 되지 않으므로 maxAttempts=1로 즉시 종결한다.
      const message = `contentid가 숫자가 아니어서 Qdrant point id로 쓸 수 없습니다: ${input.contentid}`;
      logger.warn(message);
      await markEmbedFailure(pg, input.contentid, message, 1);
      stats.embedFailed += 1;
      return;
    }

    try {
      const vectors = await tei.embed([text]);
      const vector = vectors[0];
      if (vector === undefined || vector.length !== collection.vectorSize) {
        throw new Error(
          `TEI가 예상 차원(${collection.vectorSize})과 다른 벡터를 반환했습니다: ${vector?.length ?? 0}`,
        );
      }
      await qdrant.upsert(collection.name, [
        { id: pointId, vector, payload: toPayload(input) },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`임베딩 실패 (contentid=${input.contentid}): ${message}`);
      const status = await markEmbedFailure(pg, input.contentid, message, maxAttempts);
      if (status === "failed") stats.embedFailed += 1;
      else stats.embedRetry += 1;
      return;
    }

    await markEmbedDone(pg, input.contentid);
    stats.embedded += 1;
  }

  return {
    async enrich(contentid: string): Promise<void> {
      if (stats.disabled) return;

      const input = await fetchEnrichInput(pg, contentid);
      if (input === null) {
        logger.warn(`구조화 대상 행을 찾을 수 없습니다 (contentid=${contentid})`);
        return;
      }

      const text = await ensureStructuredText(input);
      if (text !== null) {
        await embedAndUpsert(input, text);
      }

      if (consecutiveFailures >= maxConsecutiveFailures) {
        stats.disabled = true;
        logger.error(
          `구조화 연속 ${consecutiveFailures}회 실패로 임베딩을 중단합니다. ` +
            `GEMINI_API_KEY와 네트워크를 확인하세요. 상세 수집은 계속됩니다.`,
        );
      }
    },
    stats(): EnrichStats {
      return { ...stats };
    },
  };
}
