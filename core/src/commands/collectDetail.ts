import type { Command } from "commander";
import { TourApiClient } from "../clients/tourApi.js";
import { PostgresClient } from "../clients/postgres.js";
import { GeminiClient } from "../clients/gemini.js";
import { TeiEmbeddingClient } from "../clients/tei.js";
import { QdrantStore } from "../clients/qdrant.js";
import { collectDetail } from "../services/collectDetail.js";
import type { CollectDetailResult } from "../services/collectDetail.js";
import { createEnricher } from "../services/enricher.js";
import type { Enricher, EnrichStats } from "../services/enricher.js";
import { enrichBacklog } from "../services/enrichBacklog.js";
import type { EnrichBacklogResult } from "../services/enrichBacklog.js";
import { ensureCollection } from "../lib/qdrantCollection.js";
import { countStageStatus } from "../lib/tourContentsTable.js";
import type { StageCounts } from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";
import { parsePositiveInt } from "../lib/cliOptions.js";
import { optionalEnv } from "../lib/env.js";

interface CollectDetailCliOptions {
  dailyLimit?: string;
  maxAttempts?: string;
  skipDetail?: boolean;
  skipEmbed?: boolean;
}

const NEXT_STEP: Record<CollectDetailResult["stoppedBy"], string> = {
  budget: "내일 다시 실행하세요.",
  "quota-exceeded":
    "API 일일 한도에 도달했습니다. 다른 작업이 한도를 사용했는지 확인하세요.",
  aborted:
    "연속 실패로 중단했습니다. 서비스 키 만료 여부와 네트워크를 확인한 뒤 다시 실행하세요.",
  "no-pending": "모든 항목 처리 완료.",
};

/** 두 스킵 플래그를 함께 주면 아무 작업도 하지 않으므로 거부한다 (순수 함수). */
export function assertSkipFlags(skipDetail: boolean, skipEmbed: boolean): void {
  if (skipDetail && skipEmbed) {
    throw new Error(
      "--skip-detail과 --skip-embed를 함께 지정하면 아무 작업도 수행하지 않습니다.",
    );
  }
}

/** 구조화·임베딩 집계를 사람이 읽을 여러 줄로 만든다 (순수 함수). */
export function formatEnrichSummary(stats: EnrichStats): string {
  const structureTotal = stats.structured + stats.structureRetry + stats.structureFailed;
  const lines = [
    `       구조화 ${structureTotal}건 (done ${stats.structured} — 그중 폴백 ${stats.fallback}, ` +
      `재시도대기 ${stats.structureRetry}, failed ${stats.structureFailed})`,
    `       임베딩 ${stats.embedded}건 upsert ` +
      `(재시도대기 ${stats.embedRetry}, failed ${stats.embedFailed})`,
  ];
  if (stats.geminiRateLimited > 0) {
    lines.push(
      `       Gemini 한도로 ${stats.geminiRateLimited}건 구조화를 건너뜀 — ` +
        `다음 --skip-detail 실행에서 이어집니다.`,
    );
  }
  if (stats.disabled) {
    lines.push(
      "       연속 실패로 구조화·임베딩이 중단됐습니다. " +
        "GEMINI_API_KEY·TEI·Qdrant 연결 상태를 확인하세요.",
    );
  }
  return lines.join("\n");
}

/** collect-detail 실행 결과를 사람이 읽을 요약으로 만든다 (순수 함수). */
export function formatCollectDetailSummary(result: CollectDetailResult): string {
  const breakdown = [
    `done ${result.done}`,
    `nodata ${result.nodata}`,
    `재시도대기 ${result.retryScheduled}`,
    `failed ${result.failed}`,
  ].join(", ");
  const head =
    `종료 — 처리 ${result.processed}건 (${breakdown})\n` +
    `       남은 pending ${result.remainingPending}건. ${NEXT_STEP[result.stoppedBy]}`;
  return result.enrichStats === undefined
    ? head
    : `${head}\n${formatEnrichSummary(result.enrichStats)}`;
}

/** 백로그 실행 결과를 사람이 읽을 요약으로 만든다 (순수 함수). */
export function formatBacklogSummary(result: EnrichBacklogResult): string {
  // 차단기 트립 후 스킵된 건수를 함께 보여줘야 "claim한 게 애초에 적었음"과
  // "10건 실패로 중단하고 나머지 수천 건을 스킵했음"이 구분된다.
  const skippedNote = result.skipped > 0 ? ` (차단기로 스킵 ${result.skipped}건 제외)` : "";
  return (
    `종료 — 백로그 ${result.processed}건 처리${skippedNote}\n` +
    `${formatEnrichSummary(result.stats)}`
  );
}

/**
 * 남은 스테이지 대기 건수를 한 줄로 만든다 (순수 함수).
 * 하루 유입량(상세 done)보다 구조화 처리량이 적으면 이 수치가 늘어난다 —
 * free tier에서 백로그가 쌓이는지 판단하는 유일한 신호다.
 */
export function formatStageBacklog(counts: StageCounts): string {
  return (
    `       구조화대기 ${counts.structure.pending} / 임베딩대기 ${counts.embed.pending}` +
    ` (구조화 failed ${counts.structure.failed}, 임베딩 failed ${counts.embed.failed})`
  );
}

export interface RunCollectDetailOptions {
  dailyLimit: number;
  maxAttempts: number;
  skipDetail: boolean;
  skipEmbed: boolean;
}

/**
 * collect-detail의 조합 루트 — 클라이언트 생성, 두 스킵 플래그에 따른 조건부 배선,
 * 정리(close)를 한곳에 모은다. `.action()`은 옵션 파싱만 하고 이 함수를 호출한다.
 *
 * createEnricher를 호출하는 지점이 이 함수 안에 정확히 하나여야 한다 — 차단기(stats.disabled)와
 * Gemini 쿼터 단축회로(내부 geminiQuotaExhausted)가 createEnricher가 반환하는 클로저 안에
 * 살아 있어서, 실행당 인스턴스 1개를 skipDetail의 두 분기가 공유할 때만 두 안전장치가
 * 이번 실행 전체를 보호한다. 분기마다 새로 만들면 두 안전장치가 매번 초기화된다.
 */
export async function runCollectDetail(opts: RunCollectDetailOptions): Promise<void> {
  const { dailyLimit, maxAttempts, skipDetail, skipEmbed } = opts;
  assertSkipFlags(skipDetail, skipEmbed);

  const pg = new PostgresClient();
  await pg.connect();
  let qdrant: QdrantStore | undefined;
  try {
    let enricher: Enricher | undefined;
    if (!skipEmbed) {
      // 클라이언트 생성자가 requireEnv로 throw하므로 조건부로 만든다 —
      // --skip-embed면 GEMINI_API_KEY·TEI_BASE_URL·QDRANT_URL 없이도 동작해야 한다.
      const gemini = new GeminiClient();
      const tei = new TeiEmbeddingClient();
      qdrant = new QdrantStore();
      await qdrant.connect();
      const collection = await ensureCollection(
        qdrant,
        tei,
        optionalEnv("QDRANT_COLLECTION", "tour_contents"),
      );
      logger.info(
        `컬렉션 ${collection.name} (${collection.vectorSize}차원, ${collection.distance}) 확인`,
      );
      enricher = createEnricher(gemini, tei, qdrant, pg, collection, { maxAttempts });
    }

    if (skipDetail) {
      // assertSkipFlags가 통과했고 skipDetail이 참이므로 enricher는 반드시 존재해야 한다.
      // 이 불변식이 깨지면 27행 떨어진 캐스트 뒤에서 TypeError로 터지는 대신
      // 여기서 명확한 메시지로 즉시 드러나야 한다.
      if (enricher === undefined) {
        throw new Error("--skip-detail은 구조화·임베딩 클라이언트를 필요로 합니다.");
      }
      const result = await enrichBacklog(pg, enricher, dailyLimit);
      logger.info(formatBacklogSummary(result));
    } else {
      const tourApi = new TourApiClient();
      const result = await collectDetail(
        tourApi,
        pg,
        { dailyLimit, maxAttempts },
        enricher,
      );
      logger.info(formatCollectDetailSummary(result));
    }

    if (enricher !== undefined) {
      // --skip-embed면 스테이지 컬럼을 쓰지 않았으므로 출력할 의미가 없다.
      logger.info(formatStageBacklog(await countStageStatus(pg)));
    }
  } finally {
    await qdrant?.close();
    await pg.close();
  }
}

/** commander program에 `collect-detail` 명령을 등록한다. */
export function registerCollectDetail(program: Command): void {
  program
    .command("collect-detail")
    .description(
      "pending 콘텐츠의 overview를 detailCommon2로 채우고 Gemini 구조화 후 Qdrant에 색인 (중단 시 재실행하면 이어서)",
    )
    .option("--daily-limit <n>", "이번 실행에서 처리할 최대 건수", "900")
    .option("--max-attempts <n>", "이 횟수만큼 실패하면 제외", "3")
    .option("--skip-detail", "상세 수집을 건너뛰고 구조화·임베딩 백로그만 처리")
    .option("--skip-embed", "구조화·임베딩을 건너뛰고 상세 수집만 수행")
    .action(async (options: CollectDetailCliOptions) => {
      const dailyLimit = parsePositiveInt("--daily-limit", options.dailyLimit, 900);
      const maxAttempts = parsePositiveInt("--max-attempts", options.maxAttempts, 3);
      await runCollectDetail({
        dailyLimit,
        maxAttempts,
        skipDetail: options.skipDetail ?? false,
        skipEmbed: options.skipEmbed ?? false,
      });
    });
}
