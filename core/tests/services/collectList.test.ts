import { describe, it, expect, vi } from "vitest";
import { collectList } from "../../src/services/collectList.js";
import type { TourApiClient, TourApiSyncItem, TourApiPage } from "../../src/clients/tourApi.js";
import type { PostgresClient } from "../../src/clients/postgres.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

function syncItem(contentid: string): TourApiSyncItem {
  return {
    contentid,
    contenttypeid: "12",
    title: `제목${contentid}`,
    mapx: "126.9",
    mapy: "37.5",
    addr1: "주소",
    addr2: "",
    zipcode: "03045",
    lDongRegnCd: "11",
    lDongSignguCd: "110",
    lclsSystm1: "AC",
    lclsSystm2: "AC01",
    lclsSystm3: "AC010100",
    createdtime: "20030204092000",
    modifiedtime: "20250101120000",
    showflag: "1",
  };
}

function page(items: TourApiSyncItem[], totalCount: number, pageNo = 1): TourApiPage<TourApiSyncItem> {
  return { items, totalCount, pageNo, numOfRows: 1000 };
}

function fakePg() {
  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  const client = { query: queryMock };
  const pg = {
    transaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
  } as unknown as PostgresClient;
  return { pg, queryMock };
}

describe("collectList", () => {
  it("totalCount에 도달할 때까지 페이지를 순회하고 전부 적재한다", async () => {
    const getAreaBasedSyncList = vi
      .fn()
      .mockResolvedValueOnce(page([syncItem("1"), syncItem("2")], 3, 1))
      .mockResolvedValueOnce(page([syncItem("3")], 3, 2));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg, queryMock } = fakePg();

    const result = await collectList(tourApi, pg, { pageSize: 2 });

    expect(result).toEqual({ fetched: 3, apiCalls: 2 });
    expect(getAreaBasedSyncList).toHaveBeenCalledTimes(2);
    expect(getAreaBasedSyncList.mock.calls[0][0]).toMatchObject({ pageNo: 1, numOfRows: 2 });
    expect(getAreaBasedSyncList.mock.calls[1][0]).toMatchObject({ pageNo: 2 });
    const inserts = queryMock.mock.calls.filter((c) =>
      (c[0] as string).includes("INSERT INTO tour_contents"),
    );
    expect(inserts).toHaveLength(3);
  });

  it("빈 페이지를 만나면 즉시 멈춘다", async () => {
    const getAreaBasedSyncList = vi.fn().mockResolvedValue(page([], 999, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg } = fakePg();

    const result = await collectList(tourApi, pg);

    expect(result).toEqual({ fetched: 0, apiCalls: 1 });
    expect(getAreaBasedSyncList).toHaveBeenCalledTimes(1);
  });

  it("maxPages를 넘기지 않는다", async () => {
    const getAreaBasedSyncList = vi.fn(async () => page([syncItem("1")], 99999, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg } = fakePg();

    const result = await collectList(tourApi, pg, { pageSize: 1, maxPages: 3 });

    expect(result.apiCalls).toBe(3);
    expect(result.fetched).toBe(3);
  });

  it("필터 옵션을 API 파라미터로 전달한다", async () => {
    const getAreaBasedSyncList = vi.fn().mockResolvedValue(page([], 0, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg } = fakePg();

    await collectList(tourApi, pg, {
      contentTypeId: "12",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
    });

    expect(getAreaBasedSyncList.mock.calls[0][0]).toMatchObject({
      contentTypeId: "12",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
    });
  });

  it("테이블 생성을 트랜잭션 안에서 먼저 수행한다", async () => {
    const getAreaBasedSyncList = vi.fn().mockResolvedValue(page([], 0, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg, queryMock } = fakePg();

    await collectList(tourApi, pg);

    expect((queryMock.mock.calls[0][0] as string)).toContain(
      "CREATE TABLE IF NOT EXISTS tour_contents",
    );
  });
});
