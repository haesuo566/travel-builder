import { describe, it, expect, vi, beforeEach } from "vitest";
import { enrichBacklog } from "../../src/services/enrichBacklog.js";
import type { Enricher, EnrichStats } from "../../src/services/enricher.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
import * as table from "../../src/lib/tourContentsTable.js";
import * as stage from "../../src/lib/enrichStage.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/tourContentsTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof table>();
  return {
    ...actual,
    createTourContentsTable: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/lib/enrichStage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof stage>();
  return {
    ...actual,
    claimStructurePending: vi.fn().mockResolvedValue([]),
    claimEmbedPending: vi.fn().mockResolvedValue([]),
  };
});

const mockedTable = vi.mocked(table);
const mockedStage = vi.mocked(stage);

const EMPTY_STATS: EnrichStats = {
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

function fakePg() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  return {
    transaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as PostgresClient;
}

function fakeEnricher() {
  const enrich = vi.fn().mockResolvedValue(undefined);
  return { enricher: { enrich, stats: () => EMPTY_STATS } as Enricher, enrich };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTable.createTourContentsTable.mockResolvedValue(undefined);
  mockedStage.claimStructurePending.mockResolvedValue([]);
  mockedStage.claimEmbedPending.mockResolvedValue([]);
});

describe("enrichBacklog", () => {
  it("컬럼이 없을 수 있으므로 테이블 DDL을 먼저 멱등 실행한다", async () => {
    // collect-detail 경로를 건너뛰면 createTourContentsTable이 호출되지 않아
    // ALTER로 추가한 컬럼이 없는 상태에서 claim 쿼리가 실패한다.
    const pg = fakePg();
    const { enricher } = fakeEnricher();
    await enrichBacklog(pg, enricher, 100);
    expect(mockedTable.createTourContentsTable).toHaveBeenCalledOnce();
    expect(vi.mocked(pg.transaction)).toHaveBeenCalledOnce();
    // 두 claim은 서로 독립이라 병렬로 나가지만, 둘 다 DDL 이후여야 한다 —
    // DDL 전에 나가면 ALTER로 추가한 컬럼이 없는 상태에서 claim이 실패한다.
    const ddlOrder = mockedTable.createTourContentsTable.mock.invocationCallOrder[0];
    const structureOrder = mockedStage.claimStructurePending.mock.invocationCallOrder[0];
    const embedOrder = mockedStage.claimEmbedPending.mock.invocationCallOrder[0];
    expect(ddlOrder).toBeLessThan(structureOrder);
    expect(ddlOrder).toBeLessThan(embedOrder);
  });

  it("두 대기 목록을 합쳐 중복 없이 순회한다", async () => {
    mockedStage.claimStructurePending.mockResolvedValue(["1", "2"]);
    mockedStage.claimEmbedPending.mockResolvedValue(["2", "3"]);
    const { enricher, enrich } = fakeEnricher();
    const result = await enrichBacklog(fakePg(), enricher, 100);
    expect(enrich.mock.calls.map((c) => c[0])).toEqual(["1", "2", "3"]);
    expect(result.processed).toBe(3);
  });

  it("limit을 넘지 않는다", async () => {
    mockedStage.claimStructurePending.mockResolvedValue(["1", "2"]);
    mockedStage.claimEmbedPending.mockResolvedValue(["3", "4"]);
    const { enricher, enrich } = fakeEnricher();
    const result = await enrichBacklog(fakePg(), enricher, 3);
    expect(enrich).toHaveBeenCalledTimes(3);
    expect(result.processed).toBe(3);
  });

  it("limit을 두 claim 쿼리에 그대로 넘긴다", async () => {
    const pg = fakePg();
    const { enricher } = fakeEnricher();
    await enrichBacklog(pg, enricher, 42);
    expect(mockedStage.claimStructurePending).toHaveBeenCalledWith(pg, 42);
    expect(mockedStage.claimEmbedPending).toHaveBeenCalledWith(pg, 42);
  });

  it("대상이 없으면 enrich를 호출하지 않는다", async () => {
    const { enricher, enrich } = fakeEnricher();
    const result = await enrichBacklog(fakePg(), enricher, 100);
    expect(enrich).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("차단기가 트립되면 이후 항목은 enrich를 부르지 않고 skipped로 센다 (Minor 8)", async () => {
    // stats.disabled만 보면 "claim한 게 애초에 적었음"과 "10건 실패로 중단하고
    // 나머지를 스킵했음"을 processed 하나로 구분할 수 없다.
    mockedStage.claimStructurePending.mockResolvedValue(["1", "2", "3"]);
    let disabled = false;
    const enrich = vi.fn().mockImplementation(async () => {
      disabled = true; // 첫 호출에서 바로 차단기가 트립됐다고 가정한다.
    });
    const enricher = { enrich, stats: () => ({ ...EMPTY_STATS, disabled }) } as Enricher;
    const result = await enrichBacklog(fakePg(), enricher, 100);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("enricher의 최종 stats를 반환한다", async () => {
    mockedStage.claimStructurePending.mockResolvedValue(["1"]);
    const enrich = vi.fn().mockResolvedValue(undefined);
    const stats: EnrichStats = { ...EMPTY_STATS, structured: 1, embedded: 1 };
    const enricher = { enrich, stats: () => stats } as Enricher;
    const result = await enrichBacklog(fakePg(), enricher, 100);
    expect(result.stats).toEqual(stats);
  });

  it("enrich가 throw하면 전파한다", async () => {
    mockedStage.claimStructurePending.mockResolvedValue(["1", "2"]);
    const enrich = vi.fn().mockRejectedValue(new Error("DB 쓰기 실패"));
    const enricher = { enrich, stats: () => EMPTY_STATS } as Enricher;
    await expect(enrichBacklog(fakePg(), enricher, 100)).rejects.toThrow("DB 쓰기 실패");
  });
});
