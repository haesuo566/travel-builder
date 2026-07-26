import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertSkipFlags,
  formatBacklogSummary,
  formatCollectDetailSummary,
  formatEnrichSummary,
  formatStageBacklog,
  runCollectDetail,
} from "../../src/commands/collectDetail.js";
import type { RunCollectDetailOptions } from "../../src/commands/collectDetail.js";
import { collectDetail as collectDetailService } from "../../src/services/collectDetail.js";
import type { CollectDetailResult } from "../../src/services/collectDetail.js";
import { createEnricher } from "../../src/services/enricher.js";
import type { Enricher, EnrichStats } from "../../src/services/enricher.js";
import { enrichBacklog } from "../../src/services/enrichBacklog.js";
import { ensureCollection } from "../../src/lib/qdrantCollection.js";
import { countStageStatus } from "../../src/lib/tourContentsTable.js";
import type { StageCounts } from "../../src/lib/tourContentsTable.js";

// --- Important 2: 조합 루트(runCollectDetail) 배선 검증용 모킹 ---
// 인스턴스가 아니라 클라이언트 클래스를 직접 참조하므로, 클래스 모듈 자체를 vi.mock해
// "몇 개가 생성됐는지"를 생성자 호출 횟수로 검증한다.
const {
  TourApiClientCtor,
  PostgresClientCtor,
  pgConnectMock,
  pgCloseMock,
  GeminiClientCtor,
  TeiEmbeddingClientCtor,
  QdrantStoreCtor,
  qdrantConnectMock,
  qdrantCloseMock,
} = vi.hoisted(() => {
  const pgConnectMock = vi.fn().mockResolvedValue(undefined);
  const pgCloseMock = vi.fn().mockResolvedValue(undefined);
  const qdrantConnectMock = vi.fn().mockResolvedValue(undefined);
  const qdrantCloseMock = vi.fn().mockResolvedValue(undefined);
  return {
    TourApiClientCtor: vi.fn(() => ({})),
    PostgresClientCtor: vi.fn(() => ({ connect: pgConnectMock, close: pgCloseMock })),
    GeminiClientCtor: vi.fn(() => ({})),
    TeiEmbeddingClientCtor: vi.fn(() => ({})),
    QdrantStoreCtor: vi.fn(() => ({ connect: qdrantConnectMock, close: qdrantCloseMock })),
    pgConnectMock,
    pgCloseMock,
    qdrantConnectMock,
    qdrantCloseMock,
  };
});

vi.mock("../../src/clients/tourApi.js", () => ({ TourApiClient: TourApiClientCtor }));
vi.mock("../../src/clients/postgres.js", () => ({ PostgresClient: PostgresClientCtor }));
vi.mock("../../src/clients/gemini.js", () => ({ GeminiClient: GeminiClientCtor }));
vi.mock("../../src/clients/tei.js", () => ({ TeiEmbeddingClient: TeiEmbeddingClientCtor }));
vi.mock("../../src/clients/qdrant.js", () => ({ QdrantStore: QdrantStoreCtor }));
vi.mock("../../src/services/collectDetail.js", () => ({ collectDetail: vi.fn() }));
vi.mock("../../src/services/enricher.js", () => ({ createEnricher: vi.fn() }));
vi.mock("../../src/services/enrichBacklog.js", () => ({ enrichBacklog: vi.fn() }));
vi.mock("../../src/lib/qdrantCollection.js", () => ({ ensureCollection: vi.fn() }));
vi.mock("../../src/lib/tourContentsTable.js", () => ({ countStageStatus: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

describe("runCollectDetail 배선 (Important 2)", () => {
  const fakeEnricher = { enrich: vi.fn(), stats: vi.fn() } as unknown as Enricher;
  const mockedCollectDetailService = vi.mocked(collectDetailService);
  const mockedCreateEnricher = vi.mocked(createEnricher);
  const mockedEnrichBacklog = vi.mocked(enrichBacklog);
  const mockedEnsureCollection = vi.mocked(ensureCollection);
  const mockedCountStageStatus = vi.mocked(countStageStatus);

  function baseOpts(overrides: Partial<RunCollectDetailOptions> = {}): RunCollectDetailOptions {
    return { dailyLimit: 900, maxAttempts: 3, skipDetail: false, skipEmbed: false, ...overrides };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    pgConnectMock.mockResolvedValue(undefined);
    pgCloseMock.mockResolvedValue(undefined);
    qdrantConnectMock.mockResolvedValue(undefined);
    qdrantCloseMock.mockResolvedValue(undefined);
    mockedEnsureCollection.mockResolvedValue({ name: "tour_contents", vectorSize: 4 });
    mockedCreateEnricher.mockReturnValue(fakeEnricher);
    mockedCollectDetailService.mockResolvedValue(result());
    mockedEnrichBacklog.mockResolvedValue({ processed: 0, stats: stats() });
    mockedCountStageStatus.mockResolvedValue({
      structure: { pending: 0, done: 0, failed: 0 },
      embed: { pending: 0, done: 0, failed: 0 },
    });
  });

  it("createEnricher를 정확히 1회 호출하고, collect-detail·백로그 두 경로 모두 그 인스턴스를 그대로 받는다", async () => {
    await runCollectDetail(baseOpts());
    expect(mockedCreateEnricher).toHaveBeenCalledTimes(1);
    expect(mockedCollectDetailService).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      fakeEnricher,
    );

    vi.clearAllMocks();
    pgConnectMock.mockResolvedValue(undefined);
    pgCloseMock.mockResolvedValue(undefined);
    qdrantConnectMock.mockResolvedValue(undefined);
    qdrantCloseMock.mockResolvedValue(undefined);
    mockedEnsureCollection.mockResolvedValue({ name: "tour_contents", vectorSize: 4 });
    mockedCreateEnricher.mockReturnValue(fakeEnricher);
    mockedEnrichBacklog.mockResolvedValue({ processed: 0, stats: stats() });
    mockedCountStageStatus.mockResolvedValue({
      structure: { pending: 0, done: 0, failed: 0 },
      embed: { pending: 0, done: 0, failed: 0 },
    });

    await runCollectDetail(baseOpts({ skipDetail: true }));
    expect(mockedCreateEnricher).toHaveBeenCalledTimes(1);
    expect(mockedEnrichBacklog).toHaveBeenCalledWith(expect.anything(), fakeEnricher, 900);
  });

  it("--skip-embed면 Gemini·TEI·Qdrant 클라이언트를 하나도 만들지 않는다", async () => {
    await runCollectDetail(baseOpts({ skipEmbed: true }));
    expect(GeminiClientCtor).not.toHaveBeenCalled();
    expect(TeiEmbeddingClientCtor).not.toHaveBeenCalled();
    expect(QdrantStoreCtor).not.toHaveBeenCalled();
    expect(mockedCreateEnricher).not.toHaveBeenCalled();
    // enricher가 없으므로 collectDetail은 undefined 인자로 호출된다.
    expect(mockedCollectDetailService).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("--skip-detail이면 TourApiClient를 만들지 않는다", async () => {
    await runCollectDetail(baseOpts({ skipDetail: true }));
    expect(TourApiClientCtor).not.toHaveBeenCalled();
    expect(mockedEnrichBacklog).toHaveBeenCalledOnce();
  });

  it("성공 경로와 throw 경로 양쪽에서 qdrant.close()·pg.close()가 호출된다", async () => {
    await runCollectDetail(baseOpts());
    expect(qdrantCloseMock).toHaveBeenCalledTimes(1);
    expect(pgCloseMock).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    pgConnectMock.mockResolvedValue(undefined);
    pgCloseMock.mockResolvedValue(undefined);
    qdrantConnectMock.mockResolvedValue(undefined);
    qdrantCloseMock.mockResolvedValue(undefined);
    mockedEnsureCollection.mockResolvedValue({ name: "tour_contents", vectorSize: 4 });
    mockedCreateEnricher.mockReturnValue(fakeEnricher);
    mockedCollectDetailService.mockRejectedValue(new Error("boom"));

    await expect(runCollectDetail(baseOpts())).rejects.toThrow("boom");
    expect(qdrantCloseMock).toHaveBeenCalledTimes(1);
    expect(pgCloseMock).toHaveBeenCalledTimes(1);
  });
});
