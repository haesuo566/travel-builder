import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  createTourContentsTable,
  upsertListedContents,
} from "../../src/lib/tourContentsTable.js";
import type { TourContentRow } from "../../src/lib/tourContent.js";

function fakeClient() {
  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  return { client: { query: queryMock } as unknown as PoolClient, queryMock };
}

function row(overrides: Partial<TourContentRow> = {}): TourContentRow {
  return {
    contentid: "126508",
    contenttypeid: "12",
    title: "경복궁",
    mapx: "126.9769",
    mapy: "37.5796",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    zipcode: "03045",
    ldongRegnCd: "11",
    ldongSignguCd: "110",
    lclsSystm1: "AC",
    lclsSystm2: "AC01",
    lclsSystm3: "AC010100",
    modifiedtime: "20250101120000",
    ...overrides,
  };
}

describe("createTourContentsTable", () => {
  it("테이블과 pending 부분 인덱스를 멱등하게 생성한다", async () => {
    const { client, queryMock } = fakeClient();
    await createTourContentsTable(client);
    const sql = queryMock.mock.calls.map((c) => c[0] as string).join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS tour_contents");
    // 컬럼 정렬 공백에 의존하지 않도록 \s+로 둔다.
    expect(sql).toMatch(/contentid\s+TEXT PRIMARY KEY/);
    expect(sql).toMatch(/detail_status\s+TEXT NOT NULL DEFAULT 'pending'/);
    expect(sql).toMatch(/attempt_count\s+INT\s+NOT NULL DEFAULT 0/);
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_tour_contents_pending");
    expect(sql).toContain("WHERE detail_status = 'pending'");
  });
});

describe("upsertListedContents", () => {
  it("행마다 INSERT를 발행하고 목록 필드를 파라미터로 전달한다", async () => {
    const { client, queryMock } = fakeClient();
    await upsertListedContents(client, [row(), row({ contentid: "2" })]);
    expect(queryMock).toHaveBeenCalledTimes(2);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("126508");
    expect(params).toHaveLength(14);
    expect(params).toContain("AC010100");
  });

  it("ON CONFLICT DO UPDATE가 상태 컬럼을 건드리지 않는다", async () => {
    const { client, queryMock } = fakeClient();
    await upsertListedContents(client, [row()]);
    const sql = queryMock.mock.calls[0][0] as string;
    const onConflict = sql.slice(sql.indexOf("ON CONFLICT"));
    expect(onConflict).toContain("title = EXCLUDED.title");
    expect(onConflict).not.toContain("overview");
    expect(onConflict).not.toContain("detail_status");
    expect(onConflict).not.toContain("attempt_count");
    expect(onConflict).not.toContain("detail_fetched_at");
    expect(onConflict).not.toContain("contentid = EXCLUDED.contentid");
  });

  it("빈 배열이면 쿼리를 발행하지 않는다", async () => {
    const { client, queryMock } = fakeClient();
    await upsertListedContents(client, []);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
