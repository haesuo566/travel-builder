import { describe, it, expect, vi } from "vitest";
import { generateTourCodes } from "../../src/commands/generateTourCodes.js";
import type { TourApiClient } from "../../src/clients/tourApi.js";
import type { PostgresClient } from "../../src/clients/postgres.js";

function fakeTourApi(
  overrides: Partial<{
    getLclsSystmTree: () => Promise<unknown[]>;
    getLdongRegionList: () => Promise<unknown[]>;
    getLdongSignguList: (regnCd: string) => Promise<unknown[]>;
  }> = {},
): TourApiClient {
  return {
    getLclsSystmTree: vi.fn().mockResolvedValue([]),
    getLdongRegionList: vi.fn().mockResolvedValue([]),
    getLdongSignguList: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TourApiClient;
}

function fakePg() {
  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  const client = { query: queryMock };
  const pg = {
    transaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
  } as unknown as PostgresClient;
  return { pg, queryMock };
}

describe("generateTourCodes", () => {
  it("3개 테이블을 CREATE TABLE IF NOT EXISTS로 생성한다", async () => {
    const { pg, queryMock } = fakePg();
    await generateTourCodes(fakeTourApi(), pg);
    const statements = queryMock.mock.calls.map((c) => c[0] as string);
    expect(statements.some((s) => s.includes("CREATE TABLE IF NOT EXISTS tour_content_types"))).toBe(
      true,
    );
    expect(statements.some((s) => s.includes("CREATE TABLE IF NOT EXISTS tour_ldong_codes"))).toBe(
      true,
    );
    expect(
      statements.some((s) => s.includes("CREATE TABLE IF NOT EXISTS tour_lcls_systm_codes")),
    ).toBe(true);
  });

  it("관광타입 8종을 upsert하고 결과 카운트를 반환한다", async () => {
    const { pg, queryMock } = fakePg();
    const result = await generateTourCodes(fakeTourApi(), pg);
    expect(result.contentTypeCount).toBe(8);
    const contentTypeInserts = queryMock.mock.calls.filter((c) =>
      (c[0] as string).includes("INSERT INTO tour_content_types"),
    );
    expect(contentTypeInserts).toHaveLength(8);
    expect(contentTypeInserts[0][1]).toEqual(["12", "관광지"]);
  });

  it("getLclsSystmTree 결과를 전부 upsert하고 카운트를 반환한다", async () => {
    const { pg, queryMock } = fakePg();
    const items = [
      {
        lclsSystm1Cd: "AC",
        lclsSystm1Nm: "숙박",
        lclsSystm2Cd: "AC01",
        lclsSystm2Nm: "호텔",
        lclsSystm3Cd: "AC010100",
        lclsSystm3Nm: "호텔",
      },
      {
        lclsSystm1Cd: "FD",
        lclsSystm1Nm: "음식",
        lclsSystm2Cd: "FD01",
        lclsSystm2Nm: "한식",
        lclsSystm3Cd: "FD010100",
        lclsSystm3Nm: "한식",
      },
    ];
    const tourApi = fakeTourApi({ getLclsSystmTree: vi.fn().mockResolvedValue(items) });
    const result = await generateTourCodes(tourApi, pg);
    expect(result.lclsSystmCount).toBe(2);
    const lclsInserts = queryMock.mock.calls.filter((c) =>
      (c[0] as string).includes("INSERT INTO tour_lcls_systm_codes"),
    );
    expect(lclsInserts).toHaveLength(2);
    expect(lclsInserts[0][1]).toEqual(["AC", "숙박", "AC01", "호텔", "AC010100", "호텔"]);
  });
});
