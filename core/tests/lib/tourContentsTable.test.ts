import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  createTourContentsTable,
  upsertListedContents,
  claimPendingContents,
  markDetailDone,
  markDetailNodata,
  markDetailFailure,
  countByStatus,
} from "../../src/lib/tourContentsTable.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
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

  it("스테이지 컬럼을 ALTER TABLE로 멱등하게 추가한다 (enrichStage.addStageColumns에 위임)", async () => {
    // CREATE TABLE IF NOT EXISTS는 테이블이 이미 있으면 통째로 no-op이므로
    // 신규 컬럼이 생기지 않는다. ALTER가 반드시 있어야 한다 — 실제 DDL은
    // enrichStage.ts의 addStageColumns가 담당하지만, createTourContentsTable을
    // 호출했을 때 그 결과가 여전히 나오는지(위임이 실제로 일어나는지)를 확인한다.
    const { client, queryMock } = fakeClient();
    await createTourContentsTable(client);
    const sql = queryMock.mock.calls.map((c) => c[0] as string).join("\n");
    expect(sql).toContain("ALTER TABLE tour_contents");
    // 컬럼마다 타입·기본값까지 검증한다 (컬럼명만 확인하면 잘못된 타입/기본값이
    // 섞여 들어가도 통과해버린다). 정렬 공백은 \s+로 흡수한다.
    const stageColumnDefs: Array<[string, string]> = [
      ["structured_text", "TEXT"],
      ["structure_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["structure_attempt_count", "INT\\s+NOT NULL DEFAULT 0"],
      ["structure_last_error", "TEXT"],
      ["structured_at", "TIMESTAMPTZ"],
      ["embed_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["embed_attempt_count", "INT\\s+NOT NULL DEFAULT 0"],
      ["embed_last_error", "TEXT"],
      ["embedded_at", "TIMESTAMPTZ"],
    ];
    for (const [col, typeAndDefault] of stageColumnDefs) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      expect(sql).toMatch(new RegExp(`${col}\\s+${typeAndDefault}(?:,|\\s*$)`, "m"));
    }
  });

  it("스테이지별 부분 인덱스를 만들고 진행 순서를 조건에 담는다 (enrichStage.addStageColumns에 위임)", async () => {
    const { client, queryMock } = fakeClient();
    await createTourContentsTable(client);
    const calls = queryMock.mock.calls.map((c) => c[0] as string);
    const sql = calls.join("\n");
    // WHERE 절을 자기 자신의 CREATE INDEX 호출에 묶어서 검증한다 — 조인된
    // 문자열 전체에서만 찾으면 두 인덱스의 WHERE 조건이 서로 뒤바뀌어도
    // (스테이지 진행 순서를 깨뜨리는 결함) 통과해버린다.
    const callFor = (indexName: string) => calls.find((s) => s.includes(indexName));

    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_tour_contents_structure_pending");
    expect(callFor("idx_tour_contents_structure_pending")).toContain(
      "WHERE detail_status = 'done' AND structure_status = 'pending'",
    );

    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_tour_contents_embed_pending");
    expect(callFor("idx_tour_contents_embed_pending")).toContain(
      "WHERE structure_status = 'done' AND embed_status = 'pending'",
    );
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

function fakePg(rows: unknown[] = []) {
  const queryMock = vi.fn().mockResolvedValue({ rows });
  return { pg: { query: queryMock } as unknown as PostgresClient, queryMock };
}

describe("claimPendingContents", () => {
  it("pending만 limit개 골라 contentid 배열로 반환한다", async () => {
    const { pg, queryMock } = fakePg([{ contentid: "1" }, { contentid: "2" }]);
    const ids = await claimPendingContents(pg, 900);
    expect(ids).toEqual(["1", "2"]);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("detail_status = 'pending'");
    expect(sql).toContain("LIMIT $1");
    expect(params).toEqual([900]);
  });
});

describe("markDetailDone", () => {
  it("overview와 done 상태, 조회 시각을 기록하고 last_error를 지운다", async () => {
    const { pg, queryMock } = fakePg();
    await markDetailDone(pg, "126508", "경복궁 설명");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("detail_status = 'done'");
    expect(sql).toContain("detail_fetched_at = now()");
    expect(sql).toMatch(/last_error\s+= NULL/);
    expect(params).toEqual(["126508", "경복궁 설명"]);
  });
});

describe("markDetailNodata", () => {
  it("overview를 빈 문자열로 두고 nodata로 종결한다", async () => {
    const { pg, queryMock } = fakePg();
    await markDetailNodata(pg, "999");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("detail_status = 'nodata'");
    expect(sql).toMatch(/overview\s+= ''/);
    expect(params).toEqual(["999"]);
  });
});

describe("markDetailFailure", () => {
  it("단일 UPDATE로 시도횟수를 올리고 CASE로 상태를 전이한다", async () => {
    const { pg, queryMock } = fakePg([{ detail_status: "pending" }]);
    const status = await markDetailFailure(pg, "1", "ECONNRESET", 3);
    expect(status).toBe("pending");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sql).toContain("attempt_count = attempt_count + 1");
    expect(sql).toContain("CASE WHEN attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END");
    expect(sql).toContain("RETURNING detail_status");
    expect(params).toEqual(["1", "ECONNRESET", 3]);
  });

  it("maxAttempts에 도달하면 failed를 반환한다", async () => {
    const { pg } = fakePg([{ detail_status: "failed" }]);
    expect(await markDetailFailure(pg, "1", "ECONNRESET", 3)).toBe("failed");
  });

  it("대상 행이 없으면 pending으로 간주한다", async () => {
    const { pg } = fakePg([]);
    expect(await markDetailFailure(pg, "없음", "err", 3)).toBe("pending");
  });
});

describe("countByStatus", () => {
  it("pg 드라이버가 문자열로 주는 count를 숫자로 변환한다", async () => {
    const { pg } = fakePg([
      { detail_status: "pending", count: "10" },
      { detail_status: "done", count: "5" },
    ]);
    expect(await countByStatus(pg)).toEqual({ pending: 10, done: 5, nodata: 0, failed: 0 });
  });

  it("집계에 없는 상태는 0으로 채운다", async () => {
    const { pg } = fakePg([{ detail_status: "failed", count: "3" }]);
    expect(await countByStatus(pg)).toEqual({ pending: 0, done: 0, nodata: 0, failed: 3 });
  });
});
