import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectDetail } from "../../src/services/collectDetail.js";
import { TourApiError } from "../../src/clients/tourApi.js";
import type { TourApiClient } from "../../src/clients/tourApi.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
import * as table from "../../src/lib/tourContentsTable.js";
import { logger } from "../../src/lib/logger.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/tourContentsTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof table>();
  return {
    ...actual,
    createTourContentsTable: vi.fn().mockResolvedValue(undefined),
    claimPendingContents: vi.fn().mockResolvedValue([]),
    markDetailDone: vi.fn().mockResolvedValue(undefined),
    markDetailNodata: vi.fn().mockResolvedValue(undefined),
    markDetailFailure: vi.fn().mockResolvedValue("pending"),
    countByStatus: vi.fn().mockResolvedValue({ pending: 0, done: 0, nodata: 0, failed: 0 }),
  };
});

const mocked = vi.mocked(table);

function fakePg() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  return {
    transaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as PostgresClient;
}

function fakeApi(getDetailCommon: ReturnType<typeof vi.fn>): TourApiClient {
  return { getDetailCommon } as unknown as TourApiClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createTourContentsTable.mockResolvedValue(undefined);
  mocked.claimPendingContents.mockResolvedValue([]);
  mocked.markDetailDone.mockResolvedValue(undefined);
  mocked.markDetailFailure.mockResolvedValue("pending");
  mocked.countByStatus.mockResolvedValue({ pending: 0, done: 0, nodata: 0, failed: 0 });
});

describe("collectDetail", () => {
  it("pending이 없으면 API를 호출하지 않고 no-pending으로 끝낸다", async () => {
    const getDetailCommon = vi.fn();
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(getDetailCommon).not.toHaveBeenCalled();
    expect(result.stoppedBy).toBe("no-pending");
    expect(result.processed).toBe(0);
  });

  it("성공 항목마다 overview를 저장하고 done으로 집계한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const pg = fakePg();
    const getDetailCommon = vi.fn(async (id: string) => ({ contentid: id, overview: `설명${id}` }));
    const result = await collectDetail(fakeApi(getDetailCommon), pg);
    expect(getDetailCommon).toHaveBeenCalledTimes(2);
    expect(mocked.markDetailDone).toHaveBeenCalledWith(pg, "1", "설명1");
    expect(mocked.markDetailDone).toHaveBeenCalledWith(pg, "2", "설명2");
    expect(result).toMatchObject({ processed: 2, done: 2, stoppedBy: "no-pending" });
  });

  it("예산을 전부 소진하면 budget으로 끝낸다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const getDetailCommon = vi.fn(async (id: string) => ({ contentid: id, overview: "x" }));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg(), { dailyLimit: 2 });
    expect(result.stoppedBy).toBe("budget");
  });

  it("dailyLimit을 claimPendingContents에 그대로 전달한다", async () => {
    const pg = fakePg();
    await collectDetail(fakeApi(vi.fn()), pg, { dailyLimit: 42 });
    expect(mocked.claimPendingContents).toHaveBeenCalledWith(pg, 42);
  });

  it("기본 dailyLimit은 900이다", async () => {
    const pg = fakePg();
    await collectDetail(fakeApi(vi.fn()), pg);
    expect(mocked.claimPendingContents).toHaveBeenCalledWith(pg, 900);
  });

  it("NODATA는 nodata로 종결하고 실패 횟수를 올리지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["999"]);
    const pg = fakePg();
    const getDetailCommon = vi.fn().mockRejectedValue(new TourApiError("03", "NODATA_ERROR"));
    const result = await collectDetail(fakeApi(getDetailCommon), pg);
    expect(mocked.markDetailNodata).toHaveBeenCalledWith(pg, "999");
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 1, nodata: 1, done: 0 });
  });

  it("한도 초과면 즉시 중단하고 해당 항목의 상태를 바꾸지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2", "3"]);
    const pg = fakePg();
    const getDetailCommon = vi
      .fn()
      .mockResolvedValueOnce({ contentid: "1", overview: "설명1" })
      .mockRejectedValueOnce(new TourApiError("22", "LIMITED"));
    const result = await collectDetail(fakeApi(getDetailCommon), pg);

    expect(getDetailCommon).toHaveBeenCalledTimes(2);
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
    expect(mocked.markDetailNodata).not.toHaveBeenCalled();
    expect(mocked.markDetailDone).toHaveBeenCalledTimes(1);
    expect(mocked.markDetailDone).toHaveBeenCalledWith(pg, "1", "설명1");
    expect(result).toMatchObject({
      processed: 1,
      done: 1,
      stoppedBy: "quota-exceeded",
    });
  });

  it("첫 항목에서 한도 초과면 아무 것도 처리하지 않고 중단한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new TourApiError("22", "LIMITED"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(getDetailCommon).toHaveBeenCalledTimes(1);
    expect(mocked.markDetailDone).not.toHaveBeenCalled();
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 0, done: 0, stoppedBy: "quota-exceeded" });
  });

  it("일반 오류는 실패로 기록하고 다음 항목을 계속 처리한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const pg = fakePg();
    const getDetailCommon = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ contentid: "2", overview: "설명2" });
    const result = await collectDetail(fakeApi(getDetailCommon), pg, { maxAttempts: 3 });

    expect(mocked.markDetailFailure).toHaveBeenCalledWith(pg, "1", "ECONNRESET", 3);
    expect(result).toMatchObject({ processed: 2, done: 1, retryScheduled: 1, failed: 0 });
  });

  it("maxAttempts 도달로 failed 전이되면 failed로 집계한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    mocked.markDetailFailure.mockResolvedValue("failed");
    const getDetailCommon = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(result).toMatchObject({ failed: 1, retryScheduled: 0 });
  });

  it("배치 트랜잭션으로 감싸지 않는다 (테이블 생성 1회만 트랜잭션 사용)", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2", "3"]);
    const getDetailCommon = vi.fn(async (id: string) => ({ contentid: id, overview: "x" }));
    const pg = fakePg();
    await collectDetail(fakeApi(getDetailCommon), pg);
    expect(vi.mocked(pg.transaction)).toHaveBeenCalledTimes(1);
    // mark* 함수는 트랜잭션 클라이언트가 아니라 pg 인스턴스를 직접 받아야
    // 건당 커밋이 성립한다 — 테이블 생성 트랜잭션이 루프 전체를 감싸버리면
    // 이 assertion이 깨진다.
    expect(mocked.markDetailDone).toHaveBeenCalledWith(pg, "1", "x");
    expect(mocked.markDetailDone).toHaveBeenCalledWith(pg, "2", "x");
    expect(mocked.markDetailDone).toHaveBeenCalledWith(pg, "3", "x");
  });

  it("overview가 없는 응답은 빈 문자열로 저장한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const pg = fakePg();
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1" });
    await collectDetail(fakeApi(getDetailCommon), pg);
    expect(mocked.markDetailDone).toHaveBeenCalledWith(pg, "1", "");
  });

  it("종료 후 남은 pending 건수를 재조회해 반환한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    mocked.countByStatus
      .mockResolvedValueOnce({ pending: 10, done: 0, nodata: 0, failed: 0 })
      .mockResolvedValueOnce({ pending: 9, done: 1, nodata: 0, failed: 0 });
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1", overview: "설명" });
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(result.remainingPending).toBe(9);
  });

  it("연속 10회 실패하면 남은 항목을 건드리지 않고 중단한다", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(i));
    mocked.claimPendingContents.mockResolvedValue(ids);
    const getDetailCommon = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(getDetailCommon).toHaveBeenCalledTimes(10);
    expect(mocked.markDetailFailure).toHaveBeenCalledTimes(10);
    expect(result).toMatchObject({
      processed: 10,
      done: 0,
      nodata: 0,
      retryScheduled: 10,
      failed: 0,
      stoppedBy: "aborted",
    });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining("연속"));
  });

  it("성공하면 연속 실패 카운터가 초기화된다", async () => {
    // 9회 실패 → 1회 성공 → 다시 9회 실패: 연속 10회에 도달하지 않아 끝까지 간다.
    // (총 19개: 실패 9 + 성공 1 + 실패 9. 성공 이후 실패가 10개 이상이면
    // 리셋과 무관하게 회로차단기가 작동하므로 30개로는 이 시나리오를 표현할 수 없다.)
    const ids = Array.from({ length: 19 }, (_, i) => String(i));
    mocked.claimPendingContents.mockResolvedValue(ids);
    const getDetailCommon = vi.fn(async (id: string) => {
      if (Number(id) === 9) return { contentid: id, overview: "설명" };
      throw new Error("ECONNRESET");
    });
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(result.stoppedBy).not.toBe("aborted");
    expect(result.done).toBe(1);
    expect(getDetailCommon).toHaveBeenCalledTimes(19);
  });

  it("NODATA도 연속 실패 카운터를 초기화한다", async () => {
    // 위와 동일한 이유로 총 19개 (실패 9 + NODATA 1 + 실패 9).
    const ids = Array.from({ length: 19 }, (_, i) => String(i));
    mocked.claimPendingContents.mockResolvedValue(ids);
    const getDetailCommon = vi.fn(async (id: string) => {
      if (Number(id) === 9) throw new TourApiError("03", "NODATA_ERROR");
      throw new Error("ECONNRESET");
    });
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(result.stoppedBy).not.toBe("aborted");
    expect(result.nodata).toBe(1);
    expect(getDetailCommon).toHaveBeenCalledTimes(19);
  });

  it("일반 오류를 logger.error로 기록한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining("ECONNRESET"),
    );
  });

  it("maxAttempts 기본값 3을 markDetailFailure에 넘긴다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(mocked.markDetailFailure).toHaveBeenCalledWith(
      expect.anything(),
      "1",
      "ECONNRESET",
      3,
    );
  });

  it("markDetailDone 실패는 실패 횟수로 세지 않고 전파한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    mocked.markDetailDone.mockRejectedValueOnce(new Error("DB 쓰기 실패"));
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1", overview: "설명" });
    await expect(collectDetail(fakeApi(getDetailCommon), fakePg())).rejects.toThrow(
      "DB 쓰기 실패",
    );
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
  });
});
