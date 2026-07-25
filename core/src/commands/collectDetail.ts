import type { Command } from "commander";
import { TourApiClient } from "../clients/tourApi.js";
import { PostgresClient } from "../clients/postgres.js";
import { collectDetail } from "../services/collectDetail.js";
import type { CollectDetailResult } from "../services/collectDetail.js";
import { logger } from "../lib/logger.js";

interface CollectDetailCliOptions {
  dailyLimit?: string;
  maxAttempts?: string;
}

const NEXT_STEP: Record<CollectDetailResult["stoppedBy"], string> = {
  budget: "내일 다시 실행하세요.",
  "quota-exceeded":
    "API 일일 한도에 도달했습니다. 다른 작업이 한도를 사용했는지 확인하세요.",
  aborted:
    "연속 실패로 중단했습니다. 서비스 키 만료 여부와 네트워크를 확인한 뒤 다시 실행하세요.",
  "no-pending": "모든 항목 처리 완료.",
};

/** collect-detail 실행 결과를 사람이 읽을 요약으로 만든다 (순수 함수). */
export function formatCollectDetailSummary(result: CollectDetailResult): string {
  const breakdown = [
    `done ${result.done}`,
    `nodata ${result.nodata}`,
    `재시도대기 ${result.retryScheduled}`,
    `failed ${result.failed}`,
  ].join(", ");
  return (
    `종료 — 처리 ${result.processed}건 (${breakdown})\n` +
    `       남은 pending ${result.remainingPending}건. ${NEXT_STEP[result.stoppedBy]}`
  );
}

/** commander program에 `collect-detail` 명령을 등록한다. */
export function registerCollectDetail(program: Command): void {
  program
    .command("collect-detail")
    .description("pending 콘텐츠의 overview를 detailCommon2로 채움 (중단 시 재실행하면 이어서)")
    .option("--daily-limit <n>", "이번 실행에서 소비할 최대 API 호출 수", "900")
    .option("--max-attempts <n>", "이 횟수만큼 실패하면 제외", "3")
    .action(async (options: CollectDetailCliOptions) => {
      const tourApi = new TourApiClient();
      const pg = new PostgresClient();
      await pg.connect();
      try {
        const result = await collectDetail(tourApi, pg, {
          dailyLimit: Number(options.dailyLimit ?? 900),
          maxAttempts: Number(options.maxAttempts ?? 3),
        });
        logger.info(formatCollectDetailSummary(result));
      } finally {
        await pg.close();
      }
    });
}
