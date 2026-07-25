import type { Command } from "commander";
import { TourApiClient } from "../clients/tourApi.js";
import { PostgresClient } from "../clients/postgres.js";
import { collectList } from "../services/collectList.js";
import { logger } from "../lib/logger.js";
import { parsePositiveInt } from "../lib/cliOptions.js";

interface CollectListCliOptions {
  contentType?: string;
  ldongRegn?: string;
  ldongSigngu?: string;
  pageSize?: string;
  maxPages?: string;
}

/** commander program에 `collect-list` 명령을 등록한다. */
export function registerCollectList(program: Command): void {
  program
    .command("collect-list")
    .description("TourAPI 동기화 목록을 tour_contents에 적재 (detail_status=pending)")
    .option("--content-type <id>", "관광타입 코드 (예: 12)")
    .option("--ldong-regn <cd>", "법정동 시도 코드 (예: 11)")
    .option("--ldong-signgu <cd>", "법정동 시군구 코드 (예: 110)")
    .option("--page-size <n>", "페이지당 건수", "1000")
    .option("--max-pages <n>", "최대 페이지 수", "100")
    .action(async (options: CollectListCliOptions) => {
      const pageSize = parsePositiveInt("--page-size", options.pageSize, 1000);
      const maxPages = parsePositiveInt("--max-pages", options.maxPages, 100);

      const tourApi = new TourApiClient();
      const pg = new PostgresClient();
      await pg.connect();
      try {
        const result = await collectList(tourApi, pg, {
          contentTypeId: options.contentType,
          lDongRegnCd: options.ldongRegn,
          lDongSignguCd: options.ldongSigngu,
          pageSize,
          maxPages,
        });
        logger.info(
          `목록 적재 완료 — ${result.fetched}건, API 호출 ${result.apiCalls}회`,
        );
      } finally {
        await pg.close();
      }
    });
}
