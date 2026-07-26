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
/** 연속으로 쿼터(429)에 걸리는 횟수가 이 문턱에 이르면 이번 실행 동안 Gemini 호출을 멈춘다. */
const DEFAULT_MAX_CONSECUTIVE_RATE_LIMITS = 3;
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
  /**
   * Gemini 호출이 연속으로 쿼터(429)에 걸리는 횟수의 문턱. 기본 3.
   * 도달하면 이번 실행 동안 Gemini 호출 자체를 건너뛴다 — 이미 소진된 쿼터를 향해
   * 항목마다 재시도·대기(건당 최대 geminiRetries+1회 호출, 초 단위 sleep)를
   * 반복하는 것은 소멸성 자원(TourAPI 예산)만 낭비한다.
   */
  maxConsecutiveRateLimits?: number;
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
 *
 * callGemini가 던진 오류에만 적용해야 한다 — validateStructuredText의 실패 메시지는
 * 모델 출력 원문을 그대로 담으므로("...'—' 구분자가 없습니다: 숭례문 1429년 중건") 같은
 * 정규식을 검증 오류에 적용하면 우연히 "429"를 포함한 데이터가 쿼터 초과로 오분류된다.
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
  const maxConsecutiveRateLimits =
    opts.maxConsecutiveRateLimits ?? DEFAULT_MAX_CONSECUTIVE_RATE_LIMITS;
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
  /** 구조화·임베딩 두 단계가 공유하는 카운터 — 시스템 장애가 항목별 오류로 위장하는 것을 막는다. */
  let consecutiveFailures = 0;
  /** Gemini 쿼터에 연속으로 걸린 횟수. 문턱에 이르면 geminiQuotaExhausted를 켠다. */
  let consecutiveRateLimits = 0;
  /**
   * 켜지면 이번 실행 동안 Gemini를 아예 호출하지 않는다.
   * stats.disabled(차단기)와 달리 enrich() 자체를 멈추지 않는다 — 이미 구조화된
   * 행의 임베딩은 계속되고, 구조화가 필요한 행은 상태·시도횟수를 건드리지 않은 채 pending으로 남는다.
   */
  let geminiQuotaExhausted = false;

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

  /** 구조화 실패를 기록한다. markStructureFailure(DB 쓰기)만 await하고 그 실패는 그대로 전파한다. */
  async function recordStructureFailure(input: EnrichInput, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`구조화 실패 (contentid=${input.contentid}): ${message}`);
    const status = await markStructureFailure(pg, input.contentid, message, maxAttempts);
    if (status === "failed") stats.structureFailed += 1;
    else stats.structureRetry += 1;
    consecutiveFailures += 1;
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

    if (geminiQuotaExhausted) {
      // 쿼터가 소진된 채로는 재시도해도 결과가 같다. 항목에 책임이 없으므로 pending 그대로 둔다.
      stats.geminiRateLimited += 1;
      return null;
    }

    let text: string;
    try {
      // try는 Gemini 호출만 감싼다. validateStructuredText는 별도 try에서 다뤄
      // 검증 실패 메시지(모델 출력 원문 포함)가 isRateLimited로 새는 것을 구조적으로 막는다(F1).
      text = await callGemini(buildStructurePrompt(input));
    } catch (error) {
      if (isRateLimited(error)) {
        // 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이다. 항목에 책임을 묻지 않는다.
        stats.geminiRateLimited += 1;
        consecutiveRateLimits += 1;
        logger.error(
          `Gemini 한도 초과로 구조화를 건너뜁니다 (contentid=${input.contentid}). ` +
            `상세 수집은 계속됩니다.`,
        );
        if (consecutiveRateLimits >= maxConsecutiveRateLimits) {
          geminiQuotaExhausted = true;
          logger.warn(
            `Gemini 쿼터 소진이 연속 ${consecutiveRateLimits}회 감지되어 이번 실행 동안 ` +
              `구조화를 건너뜁니다. 이미 구조화된 행의 임베딩은 계속 진행됩니다.`,
          );
        }
        return null;
      }
      await recordStructureFailure(input, error);
      return null;
    }
    consecutiveRateLimits = 0; // Gemini 호출 성공 — 쿼터 연속 카운터 리셋

    try {
      validateStructuredText(text);
    } catch (error) {
      await recordStructureFailure(input, error);
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
      consecutiveFailures += 1;
      return;
    }

    await markEmbedDone(pg, input.contentid);
    stats.embedded += 1;
    consecutiveFailures = 0;
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
        // 구조화·임베딩 어느 단계든 연속 실패는 항목이 아니라 시스템(키 만료·네트워크
        // 단절·TEI/Qdrant 장애) 문제일 가능성이 높다 — 특정 단계로 좁혀 말하지 않는다.
        logger.error(
          `연속 ${consecutiveFailures}회 실패로 이번 실행을 중단합니다. ` +
            `GEMINI_API_KEY·TEI·Qdrant 연결 상태를 확인하세요. 상세 수집은 계속됩니다.`,
        );
      }
    },
    stats(): EnrichStats {
      return { ...stats };
    },
  };
}
