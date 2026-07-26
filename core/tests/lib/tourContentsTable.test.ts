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
  fetchEnrichInput,
  markStructureDone,
  markStructureFailure,
  markEmbedDone,
  markEmbedFailure,
  claimStructurePending,
  claimEmbedPending,
  countStageStatus,
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

  it("스테이지 컬럼을 ALTER TABLE로 멱등하게 추가한다", async () => {
    // CREATE TABLE IF NOT EXISTS는 테이블이 이미 있으면 통째로 no-op이므로
    // 신규 컬럼이 생기지 않는다. ALTER가 반드시 있어야 한다.
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

  it("스테이지별 부분 인덱스를 만들고 진행 순서를 조건에 담는다", async () => {
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

function enrichRow(overrides: Record<string, unknown> = {}) {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structured_text: null,
    structure_status: "pending",
    contenttypeid: "12",
    ldong_regn_cd: "11",
    ldong_signgu_cd: "110",
    lcls_systm1: "AC",
    lcls_systm2: "AC01",
    lcls_systm3: "AC010100",
    mapx: "126.9769",
    mapy: "37.5796",
    content_type_nm: "관광지",
    lcls1_nm: "인문(문화/예술/역사)",
    lcls2_nm: "역사관광지",
    lcls3_nm: "고궁",
    regn_nm: "서울특별시",
    signgu_nm: "종로구",
    ...overrides,
  };
}

describe("fetchEnrichInput", () => {
  it("코드표 3개를 LEFT JOIN하고 COALESCE로 빈 문자열을 보정한다", async () => {
    const { pg, queryMock } = fakePg([enrichRow()]);
    await fetchEnrichInput(pg, "126508");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("LEFT JOIN tour_content_types");
    expect(sql).toContain("LEFT JOIN tour_lcls_systm_codes");
    expect(sql).toContain("LEFT JOIN tour_ldong_codes");
    expect(sql).toContain("COALESCE(t.name, '')");
    expect(sql).toContain("COALESCE(d.signgu_name, '')");
    // structure_status를 함께 조회해야 재사용 분기가 claim 쿼리와 같은 진실을 본다 (Important 3).
    expect(sql).toContain("c.structure_status");
    expect(params).toEqual(["126508"]);
  });

  it("프롬프트용 이름과 payload용 코드·좌표·structured_text를 한 쿼리로 반환한다", async () => {
    const { pg, queryMock } = fakePg([enrichRow()]);
    const input = await fetchEnrichInput(pg, "126508");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(input).toEqual({
      contentid: "126508",
      title: "경복궁",
      addr1: "서울특별시 종로구 사직로 161",
      addr2: "",
      overview: "조선 왕조의 법궁이다.",
      structuredText: null,
      structureStatus: "pending",
      contenttypeid: "12",
      ldongRegnCd: "11",
      ldongSignguCd: "110",
      lclsSystm1: "AC",
      lclsSystm2: "AC01",
      lclsSystm3: "AC010100",
      mapx: "126.9769",
      mapy: "37.5796",
      contentTypeNm: "관광지",
      lcls1Nm: "인문(문화/예술/역사)",
      lcls2Nm: "역사관광지",
      lcls3Nm: "고궁",
      regnNm: "서울특별시",
      signguNm: "종로구",
    });
  });

  it("structured_text가 있으면 그대로 담는다", async () => {
    const { pg } = fakePg([enrichRow({ structured_text: "경복궁 — 고궁\n설명: ..." })]);
    const input = await fetchEnrichInput(pg, "126508");
    expect(input?.structuredText).toBe("경복궁 — 고궁\n설명: ...");
  });

  it("structure_status를 structureStatus로 그대로 담는다 (Important 3)", async () => {
    // 재사용 분기가 claim 쿼리와 같은 진실을 보려면 이 값이 그대로 전달돼야 한다.
    const { pg } = fakePg([enrichRow({ structure_status: "failed" })]);
    const input = await fetchEnrichInput(pg, "126508");
    expect(input?.structureStatus).toBe("failed");
  });

  it("overview가 NULL이면 빈 문자열로 정규화한다", async () => {
    const { pg } = fakePg([enrichRow({ overview: null })]);
    expect((await fetchEnrichInput(pg, "126508"))?.overview).toBe("");
  });

  it("행이 없으면 null을 반환한다", async () => {
    const { pg } = fakePg([]);
    expect(await fetchEnrichInput(pg, "없음")).toBeNull();
  });
});

describe("markStructureDone", () => {
  it("텍스트와 done 상태, 시각을 기록하고 last_error를 지운다", async () => {
    const { pg, queryMock } = fakePg();
    await markStructureDone(pg, "126508", "경복궁 — 고궁");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("structure_status     = 'done'");
    expect(sql).toContain("structured_at        = now()");
    expect(sql).toMatch(/structure_last_error\s+= NULL/);
    expect(params).toEqual(["126508", "경복궁 — 고궁"]);
  });
});

describe("markStructureFailure", () => {
  it("단일 UPDATE로 시도횟수를 올리고 CASE로 전이한다", async () => {
    const { pg, queryMock } = fakePg([{ structure_status: "pending" }]);
    const status = await markStructureFailure(pg, "1", "500 Internal", 3);
    expect(status).toBe("pending");
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("structure_attempt_count = structure_attempt_count + 1");
    expect(sql).toContain(
      "CASE WHEN structure_attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END",
    );
    expect(sql).toContain("RETURNING structure_status");
    expect(params).toEqual(["1", "500 Internal", 3]);
  });

  it("maxAttempts에 도달하면 failed를 반환한다", async () => {
    const { pg } = fakePg([{ structure_status: "failed" }]);
    expect(await markStructureFailure(pg, "1", "err", 3)).toBe("failed");
  });

  it("대상 행이 없으면 pending으로 간주한다", async () => {
    const { pg } = fakePg([]);
    expect(await markStructureFailure(pg, "없음", "err", 3)).toBe("pending");
  });
});

describe("markEmbedDone", () => {
  it("done 상태와 시각을 기록하고 last_error를 지운다", async () => {
    const { pg, queryMock } = fakePg();
    await markEmbedDone(pg, "126508");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("embed_status     = 'done'");
    expect(sql).toContain("embedded_at      = now()");
    expect(sql).toMatch(/embed_last_error\s+= NULL/);
    expect(params).toEqual(["126508"]);
  });
});

describe("markEmbedFailure", () => {
  it("단일 UPDATE로 시도횟수를 올리고 CASE로 전이한다", async () => {
    const { pg, queryMock } = fakePg([{ embed_status: "pending" }]);
    expect(await markEmbedFailure(pg, "1", "ECONNREFUSED", 3)).toBe("pending");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("embed_attempt_count = embed_attempt_count + 1");
    expect(sql).toContain(
      "CASE WHEN embed_attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END",
    );
    expect(sql).toContain("RETURNING embed_status");
    expect(params).toEqual(["1", "ECONNREFUSED", 3]);
  });

  it("대상 행이 없으면 pending으로 간주한다", async () => {
    const { pg } = fakePg([]);
    expect(await markEmbedFailure(pg, "없음", "err", 3)).toBe("pending");
  });
});

describe("claimStructurePending", () => {
  it("done이면서 구조화 대기인 항목만 limit개 고른다", async () => {
    const { pg, queryMock } = fakePg([{ contentid: "1" }, { contentid: "2" }]);
    expect(await claimStructurePending(pg, 100)).toEqual(["1", "2"]);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("detail_status = 'done'");
    expect(sql).toContain("structure_status = 'pending'");
    expect(sql).toContain("LIMIT $1");
    expect(params).toEqual([100]);
  });
});

describe("claimEmbedPending", () => {
  it("구조화 완료면서 임베딩 대기인 항목만 limit개 고른다", async () => {
    const { pg, queryMock } = fakePg([{ contentid: "3" }]);
    expect(await claimEmbedPending(pg, 50)).toEqual(["3"]);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("structure_status = 'done'");
    expect(sql).toContain("embed_status = 'pending'");
    expect(params).toEqual([50]);
  });
});

describe("countStageStatus", () => {
  it("detail_status='done' 행만 세고 두 스테이지로 집계한다", async () => {
    const { pg, queryMock } = fakePg([
      { structure_status: "done", embed_status: "done", count: "10" },
      { structure_status: "done", embed_status: "pending", count: "3" },
      { structure_status: "pending", embed_status: "pending", count: "7" },
    ]);
    expect(await countStageStatus(pg)).toEqual({
      structure: { pending: 7, done: 13, failed: 0 },
      embed: { pending: 10, done: 10, failed: 0 },
    });
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toContain("WHERE detail_status = 'done'");
    expect(sql).toContain("GROUP BY structure_status, embed_status");
  });

  it("집계에 없는 상태는 0으로 채운다", async () => {
    const { pg } = fakePg([]);
    expect(await countStageStatus(pg)).toEqual({
      structure: { pending: 0, done: 0, failed: 0 },
      embed: { pending: 0, done: 0, failed: 0 },
    });
  });
});
