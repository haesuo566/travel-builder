import type { PoolClient } from "pg";
import type { TourContentRow } from "./tourContent.js";

export type DetailStatus = "pending" | "done" | "nodata" | "failed";

/** 목록(syncList)에서 유래하는 컬럼. upsert 시 이 컬럼들만 갱신한다. */
const LIST_COLUMNS = [
  "contentid",
  "contenttypeid",
  "title",
  "mapx",
  "mapy",
  "addr1",
  "addr2",
  "zipcode",
  "ldong_regn_cd",
  "ldong_signgu_cd",
  "lcls_systm1",
  "lcls_systm2",
  "lcls_systm3",
  "modifiedtime",
] as const;

/**
 * tour_contents 테이블과 pending 부분 인덱스를 생성한다 (멱등).
 * 마이그레이션 도구 없이 커맨드 내에서 직접 실행하는 기존 관례를 따른다.
 */
export async function createTourContentsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tour_contents (
      contentid         TEXT PRIMARY KEY,
      contenttypeid     TEXT NOT NULL,
      title             TEXT NOT NULL,
      mapx              TEXT NOT NULL DEFAULT '',
      mapy              TEXT NOT NULL DEFAULT '',
      addr1             TEXT NOT NULL DEFAULT '',
      addr2             TEXT NOT NULL DEFAULT '',
      zipcode           TEXT NOT NULL DEFAULT '',
      ldong_regn_cd     TEXT NOT NULL DEFAULT '',
      ldong_signgu_cd   TEXT NOT NULL DEFAULT '',
      lcls_systm1       TEXT NOT NULL DEFAULT '',
      lcls_systm2       TEXT NOT NULL DEFAULT '',
      lcls_systm3       TEXT NOT NULL DEFAULT '',
      modifiedtime      TEXT NOT NULL DEFAULT '',
      overview          TEXT,
      detail_status     TEXT NOT NULL DEFAULT 'pending',
      attempt_count     INT  NOT NULL DEFAULT 0,
      last_error        TEXT,
      detail_fetched_at TIMESTAMPTZ,
      listed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // 부분 인덱스: done이 수만 행 쌓여도 pending 조회 비용이 남은 건수에만 비례한다.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tour_contents_pending
      ON tour_contents (contentid) WHERE detail_status = 'pending'
  `);
}

const INSERT_SQL = `
  INSERT INTO tour_contents (${LIST_COLUMNS.join(", ")})
  VALUES (${LIST_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
  ON CONFLICT (contentid) DO UPDATE SET
    ${LIST_COLUMNS.slice(1)
      .map((col) => `${col} = EXCLUDED.${col}`)
      .join(",\n    ")}
`;

/**
 * 목록 항목을 적재한다.
 * 상태 컬럼(overview/detail_status/attempt_count/detail_fetched_at)은 갱신 대상에서 제외한다 —
 * 포함시키면 collect-list 재실행이 이미 채운 overview를 리셋해 소비한 API 쿼터를 무효화한다.
 */
export async function upsertListedContents(
  client: PoolClient,
  rows: TourContentRow[],
): Promise<void> {
  for (const row of rows) {
    await client.query(INSERT_SQL, [
      row.contentid,
      row.contenttypeid,
      row.title,
      row.mapx,
      row.mapy,
      row.addr1,
      row.addr2,
      row.zipcode,
      row.ldongRegnCd,
      row.ldongSignguCd,
      row.lclsSystm1,
      row.lclsSystm2,
      row.lclsSystm3,
      row.modifiedtime,
    ]);
  }
}
