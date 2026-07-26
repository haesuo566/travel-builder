import { describe, it, expect } from "vitest";
import {
  assertSkipFlags,
  formatBacklogSummary,
  formatCollectDetailSummary,
  formatEnrichSummary,
  formatStageBacklog,
} from "../../src/commands/collectDetail.js";
import type { CollectDetailResult } from "../../src/services/collectDetail.js";
import type { EnrichStats } from "../../src/services/enricher.js";
import type { StageCounts } from "../../src/lib/tourContentsTable.js";

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

function stats(overrides: Partial<EnrichStats> = {}): EnrichStats {
  return {
    structured: 875,
    fallback: 12,
    structureRetry: 5,
    structureFailed: 0,
    embedded: 875,
    embedRetry: 0,
    embedFailed: 0,
    geminiRateLimited: 0,
    disabled: false,
    ...overrides,
  };
}

describe("assertSkipFlags", () => {
  it("둘 다 지정하면 아무 작업도 안 하므로 거부한다", () => {
    expect(() => assertSkipFlags(true, true)).toThrow("--skip-detail");
    expect(() => assertSkipFlags(true, true)).toThrow("--skip-embed");
  });

  it("하나만 또는 둘 다 아니면 통과한다", () => {
    expect(() => assertSkipFlags(true, false)).not.toThrow();
    expect(() => assertSkipFlags(false, true)).not.toThrow();
    expect(() => assertSkipFlags(false, false)).not.toThrow();
  });
});

describe("formatEnrichSummary", () => {
  it("구조화와 임베딩 집계를 담고 폴백을 done의 내역으로 표시한다", () => {
    const text = formatEnrichSummary(stats());
    expect(text).toContain("구조화 880건");
    expect(text).toContain("done 875");
    expect(text).toContain("폴백 12");
    expect(text).toContain("재시도대기 5");
    expect(text).toContain("임베딩 875건 upsert");
  });

  it("Gemini 한도로 건너뛴 건수가 있으면 이어진다고 안내한다", () => {
    const text = formatEnrichSummary(stats({ geminiRateLimited: 20 }));
    expect(text).toContain("Gemini 한도");
    expect(text).toContain("20건");
    expect(text).toContain("다음 실행");
  });

  it("차단기가 작동했으면 키와 네트워크 확인을 안내한다", () => {
    const text = formatEnrichSummary(stats({ disabled: true }));
    expect(text).toContain("GEMINI_API_KEY");
  });

  it("정상 종료면 경고 문구를 넣지 않는다", () => {
    const text = formatEnrichSummary(stats());
    expect(text).not.toContain("GEMINI_API_KEY");
    expect(text).not.toContain("Gemini 한도");
  });
});

describe("formatCollectDetailSummary + enrichStats", () => {
  it("enrichStats가 있으면 상세 요약 뒤에 붙인다", () => {
    const text = formatCollectDetailSummary(result({ enrichStats: stats() }));
    expect(text).toContain("처리 900건");
    expect(text).toContain("구조화 880건");
    expect(text).toContain("임베딩 875건 upsert");
  });

  it("enrichStats가 없으면 상세 요약만 낸다", () => {
    const text = formatCollectDetailSummary(result());
    expect(text).not.toContain("구조화");
    expect(text).not.toContain("임베딩");
  });
});

describe("formatBacklogSummary", () => {
  it("처리 건수와 구조화·임베딩 집계를 담는다", () => {
    const text = formatBacklogSummary({ processed: 100, stats: stats() });
    expect(text).toContain("백로그 100건");
    expect(text).toContain("구조화 880건");
    expect(text).toContain("임베딩 875건 upsert");
  });
});

describe("formatStageBacklog", () => {
  function counts(overrides: Partial<StageCounts> = {}): StageCounts {
    return {
      structure: { pending: 5, done: 875, failed: 2 },
      embed: { pending: 0, done: 875, failed: 1 },
      ...overrides,
    };
  }

  it("남은 스테이지 대기 건수와 failed를 담는다", () => {
    const text = formatStageBacklog(counts());
    expect(text).toContain("구조화대기 5");
    expect(text).toContain("임베딩대기 0");
    expect(text).toContain("구조화 failed 2");
    expect(text).toContain("임베딩 failed 1");
  });
});
