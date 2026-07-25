import type { TourApiClient, TourApiDetailCommon } from "../clients/tourApi.js";
import type { PostgresClient } from "../clients/postgres.js";
import { isNoData, isQuotaExceeded } from "../clients/tourApi.js";
import {
  claimPendingContents,
  countByStatus,
  createTourContentsTable,
  markDetailDone,
  markDetailFailure,
  markDetailNodata,
} from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";

const DEFAULT_DAILY_LIMIT = 900;
const DEFAULT_MAX_ATTEMPTS = 3;
/** 연속 실패가 이 횟수에 이르면 개별 항목 문제가 아니라 시스템 장애로 보고 중단한다. */
const MAX_CONSECUTIVE_FAILURES = 10;

export interface CollectDetailOptions {
  /** 이번 실행에서 소비할 최대 API 호출 수. 기본 900 (일 1,000건 중 여유분 100 확보). */
  dailyLimit?: number;
  /** 이 횟수만큼 실패하면 failed로 제외한다. 기본 3. */
  maxAttempts?: number;
}

export interface CollectDetailResult {
  processed: number;
  done: number;
  nodata: number;
  /** 실패했으나 pending 유지 — 다음 실행에서 재시도된다. */
  retryScheduled: number;
  /** maxAttempts 도달로 제외됨. */
  failed: number;
  stoppedBy: "budget" | "quota-exceeded" | "aborted" | "no-pending";
  remainingPending: number;
}

/**
 * pending 항목의 overview를 detailCommon2로 채운다.
 *
 * 재개는 별도 커서 없이 성립한다 — detail_status='pending' 조회 자체가 남은 일 목록이므로,
 * 프로세스가 어떻게 종료되든 다음 실행이 이어받는다.
 */
export async function collectDetail(
  tourApi: TourApiClient,
  pg: PostgresClient,
  opts: CollectDetailOptions = {},
): Promise<CollectDetailResult> {
  const dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  await pg.transaction((client) => createTourContentsTable(client));

  const before = await countByStatus(pg);
  logger.info(
    `시작 — pending ${before.pending} / done ${before.done} / ` +
      `nodata ${before.nodata} / failed ${before.failed}, 오늘 예산 ${dailyLimit}`,
  );

  const contentIds = await claimPendingContents(pg, dailyLimit);

  let processed = 0;
  let done = 0;
  let nodata = 0;
  let retryScheduled = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stoppedBy: CollectDetailResult["stoppedBy"] =
    contentIds.length === 0 ? "no-pending" : "budget";

  for (const contentid of contentIds) {
    let detail: TourApiDetailCommon;
    try {
      detail = await tourApi.getDetailCommon(contentid);
    } catch (error) {
      // 한도 초과는 데이터의 문제가 아니라 호출자 사정이다.
      // 항목의 상태를 바꾸지 않고 중단해야, 매일 예산 경계의 항목이 실패를 누적하지 않는다.
      if (isQuotaExceeded(error)) {
        stoppedBy = "quota-exceeded";
        break;
      }
      if (isNoData(error)) {
        await markDetailNodata(pg, contentid);
        nodata += 1;
        consecutiveFailures = 0;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`상세 조회 실패 (contentid=${contentid}): ${message}`);
        const status = await markDetailFailure(pg, contentid, message, maxAttempts);
        if (status === "failed") {
          failed += 1;
        } else {
          retryScheduled += 1;
        }
        consecutiveFailures += 1;
      }
      processed += 1;
      // 키 만료·상위 5xx·네트워크 단절 같은 시스템 장애는 개별 항목 오류로 위장해 들어온다.
      // 그대로 두면 claim한 전량이 실패 횟수를 쌓아 며칠 만에 멀쩡한 데이터가 영구 제외된다.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stoppedBy = "aborted";
        logger.error(
          `연속 ${consecutiveFailures}회 실패로 중단합니다. 서비스 키와 네트워크를 확인하세요.`,
        );
        break;
      }
      continue;
    }

    // API 호출은 성공했다. 여기서의 DB 쓰기 실패는 데이터의 문제가 아니므로
    // 실패 횟수로 세지 않고 그대로 전파해 실행을 중단시킨다.
    await markDetailDone(pg, contentid, detail.overview ?? "");
    done += 1;
    consecutiveFailures = 0;
    processed += 1;
  }

  // 예산을 다 쓰지 않고 끝났다면 남은 pending이 없어서 끝난 것이다.
  if (stoppedBy === "budget" && contentIds.length < dailyLimit) {
    stoppedBy = "no-pending";
  }

  const after = await countByStatus(pg);
  return {
    processed,
    done,
    nodata,
    retryScheduled,
    failed,
    stoppedBy,
    remainingPending: after.pending,
  };
}
