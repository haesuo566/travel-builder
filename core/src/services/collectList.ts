import type { TourApiClient } from "../clients/tourApi.js";
import type { PostgresClient } from "../clients/postgres.js";
import { toTourContentRow } from "../lib/tourContent.js";
import { createTourContentsTable, upsertListedContents } from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 100;

export interface CollectListOptions {
  contentTypeId?: string;
  lDongRegnCd?: string;
  lDongSignguCd?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface CollectListResult {
  fetched: number;
  apiCalls: number;
}

/**
 * areaBasedSyncList2를 페이지 순회하며 tour_contents에 목록을 적재한다.
 * 페이지 단위로 커밋한다 — 목록 호출은 실패해도 같은 페이지를 다시 받으면 그만이라
 * 상세 호출과 달리 소실 비용이 없다.
 */
export async function collectList(
  tourApi: TourApiClient,
  pg: PostgresClient,
  opts: CollectListOptions = {},
): Promise<CollectListResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  await pg.transaction((client) => createTourContentsTable(client));

  let fetched = 0;
  let apiCalls = 0;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const page = await tourApi.getAreaBasedSyncList({
      pageNo,
      numOfRows: pageSize,
      contentTypeId: opts.contentTypeId,
      lDongRegnCd: opts.lDongRegnCd,
      lDongSignguCd: opts.lDongSignguCd,
    });
    apiCalls += 1;

    if (page.items.length === 0) break;

    const rows = page.items.map(toTourContentRow);
    await pg.transaction((client) => upsertListedContents(client, rows));
    fetched += rows.length;
    logger.info(`목록 적재 — ${pageNo}페이지, 누적 ${fetched}/${page.totalCount}건`);

    if (fetched >= page.totalCount) break;
  }

  return { fetched, apiCalls };
}
