import type { PostgresClient } from "../clients/postgres.js";
import type { Enricher, EnrichStats } from "./enricher.js";
import {
  claimEmbedPending,
  claimStructurePending,
  createTourContentsTable,
} from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";

export interface EnrichBacklogResult {
  processed: number;
  stats: EnrichStats;
}

/**
 * 이미 상세를 받아둔 항목의 구조화·임베딩 백로그를 처리한다.
 *
 * 조회 조건이 detail_status='done'이라 nodata·failed는 자동으로 제외된다.
 * 재개는 상태 조회만으로 성립하므로 별도 커서가 없다.
 */
export async function enrichBacklog(
  pg: PostgresClient,
  enricher: Enricher,
  limit: number,
): Promise<EnrichBacklogResult> {
  // 상세 수집 경로를 건너뛰면 이 함수가 유일한 DDL 실행 지점이다 —
  // 없으면 ALTER로 추가한 컬럼이 없는 상태에서 claim 쿼리가 실패한다.
  await pg.transaction((client) => createTourContentsTable(client));

  const structurePending = await claimStructurePending(pg, limit);
  const embedPending = await claimEmbedPending(pg, limit);

  // 두 목록은 structure_status가 배타적이라 겹치지 않아야 정상이지만,
  // 겹쳐 들어오면 같은 항목을 두 번 처리해 Gemini 쿼터를 낭비한다.
  // 구조화 대기가 먼저 오므로 예산이 부족하면 구조화가 우선된다.
  const targets = [...new Set([...structurePending, ...embedPending])].slice(0, limit);

  logger.info(
    `백로그 — 구조화대기 ${structurePending.length} / 임베딩대기 ${embedPending.length}, ` +
      `이번 실행 ${targets.length}건`,
  );

  let processed = 0;
  for (const contentid of targets) {
    await enricher.enrich(contentid);
    processed += 1;
  }
  return { processed, stats: enricher.stats() };
}
