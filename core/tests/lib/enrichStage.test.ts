import { describe, it, expect, vi } from "vitest";
import {
  fetchEnrichInput,
  markStructureDone,
  markStructureFailure,
  markEmbedDone,
  markEmbedFailure,
  claimStructurePending,
  claimEmbedPending,
  countStageStatus,
} from "../../src/lib/enrichStage.js";
import type { PostgresClient } from "../../src/clients/postgres.js";

function fakePg(rows: unknown[] = []) {
  const queryMock = vi.fn().mockResolvedValue({ rows });
  return { pg: { query: queryMock } as unknown as PostgresClient, queryMock };
}

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
