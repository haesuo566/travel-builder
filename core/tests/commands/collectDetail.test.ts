import { describe, it, expect } from "vitest";
import { formatCollectDetailSummary } from "../../src/commands/collectDetail.js";
import type { CollectDetailResult } from "../../src/services/collectDetail.js";

function result(overrides: Partial<CollectDetailResult> = {}): CollectDetailResult {
  return {
    processed: 900,
    done: 880,
    nodata: 15,
    retryScheduled: 5,
    failed: 0,
    stoppedBy: "budget",
    remainingPending: 334,
    ...overrides,
  };
}

describe("formatCollectDetailSummary", () => {
  it("처리 내역과 남은 건수를 담는다", () => {
    const text = formatCollectDetailSummary(result());
    expect(text).toContain("처리 900건");
    expect(text).toContain("done 880");
    expect(text).toContain("nodata 15");
    expect(text).toContain("재시도대기 5");
    expect(text).toContain("남은 pending 334건");
  });

  it("예산 소진이면 내일 재실행을 안내한다", () => {
    expect(formatCollectDetailSummary(result({ stoppedBy: "budget" }))).toContain(
      "내일 다시 실행하세요",
    );
  });

  it("API 한도 초과면 다른 작업의 소비를 확인하라고 안내한다", () => {
    const text = formatCollectDetailSummary(result({ stoppedBy: "quota-exceeded" }));
    expect(text).toContain("API 일일 한도");
    expect(text).toContain("다른 작업");
  });

  it("연속 실패 중단이면 서비스 키와 네트워크를 확인하라고 안내한다", () => {
    const text = formatCollectDetailSummary(result({ stoppedBy: "aborted" }));
    expect(text).toContain("연속 실패");
    expect(text).toContain("서비스 키");
  });

  it("pending이 없으면 완료를 알린다", () => {
    const text = formatCollectDetailSummary(
      result({ stoppedBy: "no-pending", processed: 0, done: 0, nodata: 0, retryScheduled: 0, remainingPending: 0 }),
    );
    expect(text).toContain("모든 항목 처리 완료");
  });

  it("failed가 있으면 건수를 함께 알린다", () => {
    expect(formatCollectDetailSummary(result({ failed: 3 }))).toContain("failed 3");
  });
});
