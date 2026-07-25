import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectDetail } from "../../src/services/collectDetail.js";
import { TourApiError } from "../../src/clients/tourApi.js";
import type { TourApiClient } from "../../src/clients/tourApi.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
import * as table from "../../src/lib/tourContentsTable.js";

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
    const getDetailCommon = vi.fn(async (id: string) => ({ contentid: id, overview: `설명${id}` }));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(getDetailCommon).toHaveBeenCalledTimes(2);
    expect(mocked.markDetailDone).toHaveBeenCalledWith(expect.anything(), "1", "설명1");
    expect(mocked.markDetailDone).toHaveBeenCalledWith(expect.anything(), "2", "설명2");
    expect(result).toMatchObject({ processed: 2, done: 2, stoppedBy: "budget" });
  });

  it("dailyLimit을 claimPendingContents에 그대로 전달한다", async () => {
    await collectDetail(fakeApi(vi.fn()), fakePg(), { dailyLimit: 42 });
    expect(mocked.claimPendingContents).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("기본 dailyLimit은 900이다", async () => {
    await collectDetail(fakeApi(vi.fn()), fakePg());
    expect(mocked.claimPendingContents).toHaveBeenCalledWith(expect.anything(), 900);
  });

  it("NODATA는 nodata로 종결하고 실패 횟수를 올리지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["999"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new TourApiError("03", "NODATA_ERROR"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(mocked.markDetailNodata).toHaveBeenCalledWith(expect.anything(), "999");
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 1, nodata: 1, done: 0 });
  });

  it("한도 초과면 즉시 중단하고 해당 항목의 상태를 바꾸지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2", "3"]);
    const getDetailCommon = vi
      .fn()
      .mockResolvedValueOnce({ contentid: "1", overview: "설명1" })
      .mockRejectedValueOnce(new TourApiError("22", "LIMITED"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());

    expect(getDetailCommon).toHaveBeenCalledTimes(2);
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
    expect(mocked.markDetailNodata).not.toHaveBeenCalled();
    expect(mocked.markDetailDone).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      processed: 1,
      done: 1,
      stoppedBy: "quota-exceeded",
    });
  });

  it("일반 오류는 실패로 기록하고 다음 항목을 계속 처리한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const getDetailCommon = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ contentid: "2", overview: "설명2" });
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg(), { maxAttempts: 3 });

    expect(mocked.markDetailFailure).toHaveBeenCalledWith(
      expect.anything(),
      "1",
      "ECONNRESET",
      3,
    );
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
  });

  it("overview가 없는 응답은 빈 문자열로 저장한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1" });
    await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(mocked.markDetailDone).toHaveBeenCalledWith(expect.anything(), "1", "");
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
});
