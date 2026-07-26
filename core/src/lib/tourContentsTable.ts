import type { PoolClient } from "pg";
import type { TourContentRow } from "./tourContent.js";
import type { PostgresClient } from "../clients/postgres.js";

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
  // 기존 테이블에는 CREATE TABLE IF NOT EXISTS가 no-op이라 신규 컬럼이 생기지 않는다.
  // ADD COLUMN IF NOT EXISTS는 멱등이므로 신규 생성·기존 갱신 양쪽을 이 한 곳에서 처리한다.
  await client.query(`
    ALTER TABLE tour_contents
      ADD COLUMN IF NOT EXISTS structured_text         TEXT,
      ADD COLUMN IF NOT EXISTS structure_status        TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS structure_attempt_count INT  NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS structure_last_error    TEXT,
      ADD COLUMN IF NOT EXISTS structured_at           TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS embed_status            TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS embed_attempt_count     INT  NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS embed_last_error        TEXT,
      ADD COLUMN IF NOT EXISTS embedded_at             TIMESTAMPTZ
  `);
  // 인덱스 조건이 스테이지 진행 순서를 조회 수준에서 강제한다 —
  // 구조화되지 않은 항목은 임베딩 대상이 될 수 없다.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tour_contents_structure_pending
      ON tour_contents (contentid)
      WHERE detail_status = 'done' AND structure_status = 'pending'
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tour_contents_embed_pending
      ON tour_contents (contentid)
      WHERE structure_status = 'done' AND embed_status = 'pending'
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

/** 아직 상세를 받지 않은 항목을 limit개 고른다. 이 조회 자체가 '남은 일 목록'이자 재개 지점이다. */
export async function claimPendingContents(
  pg: PostgresClient,
  limit: number,
): Promise<string[]> {
  const result = await pg.query<{ contentid: string }>(
    `SELECT contentid FROM tour_contents
     WHERE detail_status = 'pending'
     ORDER BY contentid
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => r.contentid);
}

/** 상세 수집 성공을 기록한다. */
export async function markDetailDone(
  pg: PostgresClient,
  contentid: string,
  overview: string,
): Promise<void> {
  await pg.query(
    `UPDATE tour_contents SET
       overview      = $2,
       detail_status = 'done',
       last_error    = NULL,
       detail_fetched_at = now()
     WHERE contentid = $1`,
    [contentid, overview],
  );
}

/** NODATA를 종결 처리한다. overview NULL(미조회)과 ''(조회했으나 내용 없음)을 구분한다. */
export async function markDetailNodata(pg: PostgresClient, contentid: string): Promise<void> {
  await pg.query(
    `UPDATE tour_contents SET
       overview      = '',
       detail_status = 'nodata',
       last_error    = NULL,
       detail_fetched_at = now()
     WHERE contentid = $1`,
    [contentid],
  );
}

/**
 * 일시적 오류를 기록한다. 증가와 전이를 단일 UPDATE로 처리해 읽기-판단-쓰기 경합을 없앤다.
 * 반환값으로 호출자가 '재시도 대기'와 '영구 제외'를 구분해 집계한다.
 */
export async function markDetailFailure(
  pg: PostgresClient,
  contentid: string,
  error: string,
  maxAttempts: number,
): Promise<DetailStatus> {
  const result = await pg.query<{ detail_status: DetailStatus }>(
    `UPDATE tour_contents SET
       attempt_count = attempt_count + 1,
       last_error    = $2,
       detail_status = CASE WHEN attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END
     WHERE contentid = $1
     RETURNING detail_status`,
    [contentid, error, maxAttempts],
  );
  return result.rows[0]?.detail_status ?? "pending";
}

const ALL_STATUSES: DetailStatus[] = ["pending", "done", "nodata", "failed"];

/** 상태별 건수. 집계에 없는 상태는 0으로 채워 호출자의 undefined 분기를 없앤다. */
export async function countByStatus(
  pg: PostgresClient,
): Promise<Record<DetailStatus, number>> {
  const result = await pg.query<{ detail_status: DetailStatus; count: string | number }>(
    `SELECT detail_status, COUNT(*) AS count FROM tour_contents GROUP BY detail_status`,
  );
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    DetailStatus,
    number
  >;
  for (const row of result.rows) {
    counts[row.detail_status] = Number(row.count);
  }
  return counts;
}

/** 구조화·임베딩 체인의 입력. 프롬프트용 이름과 payload용 코드·좌표를 함께 담는다. */
export interface EnrichInput {
  contentid: string;
  title: string;
  addr1: string;
  addr2: string;
  overview: string;
  /** null = 아직 구조화되지 않음 */
  structuredText: string | null;
  // payload 구성용 (원본 코드·좌표)
  contenttypeid: string;
  ldongRegnCd: string;
  ldongSignguCd: string;
  lclsSystm1: string;
  lclsSystm2: string;
  lclsSystm3: string;
  mapx: string;
  mapy: string;
  // 프롬프트 구성용 (코드표 join 결과)
  contentTypeNm: string;
  lcls1Nm: string;
  lcls2Nm: string;
  lcls3Nm: string;
  regnNm: string;
  signguNm: string;
}

interface EnrichInputRow {
  contentid: string;
  title: string;
  addr1: string;
  addr2: string;
  overview: string | null;
  structured_text: string | null;
  contenttypeid: string;
  ldong_regn_cd: string;
  ldong_signgu_cd: string;
  lcls_systm1: string;
  lcls_systm2: string;
  lcls_systm3: string;
  mapx: string;
  mapy: string;
  content_type_nm: string;
  lcls1_nm: string;
  lcls2_nm: string;
  lcls3_nm: string;
  regn_nm: string;
  signgu_nm: string;
}

const ENRICH_INPUT_SQL = `
  SELECT c.contentid, c.title, c.addr1, c.addr2, c.overview, c.structured_text,
         c.contenttypeid, c.ldong_regn_cd, c.ldong_signgu_cd,
         c.lcls_systm1, c.lcls_systm2, c.lcls_systm3, c.mapx, c.mapy,
         COALESCE(t.name, '')        AS content_type_nm,
         COALESCE(l.lvl1_name, '')   AS lcls1_nm,
         COALESCE(l.lvl2_name, '')   AS lcls2_nm,
         COALESCE(l.lvl3_name, '')   AS lcls3_nm,
         COALESCE(d.regn_name, '')   AS regn_nm,
         COALESCE(d.signgu_name, '') AS signgu_nm
    FROM tour_contents c
    LEFT JOIN tour_content_types    t ON t.code = c.contenttypeid
    LEFT JOIN tour_lcls_systm_codes l ON l.lvl1_code = c.lcls_systm1
                                     AND l.lvl2_code = c.lcls_systm2
                                     AND l.lvl3_code = c.lcls_systm3
    LEFT JOIN tour_ldong_codes      d ON d.regn_code   = c.ldong_regn_cd
                                     AND d.signgu_code = c.ldong_signgu_cd
   WHERE c.contentid = $1
`;

/**
 * 체인 입력을 한 번에 조회한다.
 *
 * LEFT JOIN + COALESCE이므로 코드표에 없는 신규 코드는 빈 문자열이 된다(soft reference).
 * 인메모리 코드표 맵을 쓰지 않는 이유는, 인라인 경로와 백로그 경로가 같은 함수로
 * 같은 입력을 봐야 재구조화 결과가 달라지지 않기 때문이다.
 */
export async function fetchEnrichInput(
  pg: PostgresClient,
  contentid: string,
): Promise<EnrichInput | null> {
  const result = await pg.query<EnrichInputRow>(ENRICH_INPUT_SQL, [contentid]);
  const r = result.rows[0];
  if (r === undefined) return null;
  return {
    contentid: r.contentid,
    title: r.title,
    addr1: r.addr1,
    addr2: r.addr2,
    overview: r.overview ?? "",
    structuredText: r.structured_text,
    contenttypeid: r.contenttypeid,
    ldongRegnCd: r.ldong_regn_cd,
    ldongSignguCd: r.ldong_signgu_cd,
    lclsSystm1: r.lcls_systm1,
    lclsSystm2: r.lcls_systm2,
    lclsSystm3: r.lcls_systm3,
    mapx: r.mapx,
    mapy: r.mapy,
    contentTypeNm: r.content_type_nm,
    lcls1Nm: r.lcls1_nm,
    lcls2Nm: r.lcls2_nm,
    lcls3Nm: r.lcls3_nm,
    regnNm: r.regn_nm,
    signguNm: r.signgu_nm,
  };
}

/** 구조화·임베딩 스테이지의 상태. nodata는 상세 단계 고유 개념이라 쓰지 않는다. */
export type StageStatus = "pending" | "done" | "failed";

/** 구조화 성공을 기록한다. */
export async function markStructureDone(
  pg: PostgresClient,
  contentid: string,
  text: string,
): Promise<void> {
  await pg.query(
    `UPDATE tour_contents SET
       structured_text      = $2,
       structure_status     = 'done',
       structure_last_error = NULL,
       structured_at        = now()
     WHERE contentid = $1`,
    [contentid, text],
  );
}

/** 구조화 실패를 기록한다. 증가와 전이를 단일 UPDATE로 처리해 경합을 없앤다. */
export async function markStructureFailure(
  pg: PostgresClient,
  contentid: string,
  error: string,
  maxAttempts: number,
): Promise<StageStatus> {
  const result = await pg.query<{ structure_status: StageStatus }>(
    `UPDATE tour_contents SET
       structure_attempt_count = structure_attempt_count + 1,
       structure_last_error    = $2,
       structure_status        = CASE WHEN structure_attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END
     WHERE contentid = $1
     RETURNING structure_status`,
    [contentid, error, maxAttempts],
  );
  return result.rows[0]?.structure_status ?? "pending";
}

/** 임베딩 성공을 기록한다. */
export async function markEmbedDone(pg: PostgresClient, contentid: string): Promise<void> {
  await pg.query(
    `UPDATE tour_contents SET
       embed_status     = 'done',
       embed_last_error = NULL,
       embedded_at      = now()
     WHERE contentid = $1`,
    [contentid],
  );
}

/** 임베딩 실패를 기록한다. */
export async function markEmbedFailure(
  pg: PostgresClient,
  contentid: string,
  error: string,
  maxAttempts: number,
): Promise<StageStatus> {
  const result = await pg.query<{ embed_status: StageStatus }>(
    `UPDATE tour_contents SET
       embed_attempt_count = embed_attempt_count + 1,
       embed_last_error    = $2,
       embed_status        = CASE WHEN embed_attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END
     WHERE contentid = $1
     RETURNING embed_status`,
    [contentid, error, maxAttempts],
  );
  return result.rows[0]?.embed_status ?? "pending";
}

/** 구조화 대기 목록. 이 조회 자체가 남은 일 목록이자 재개 지점이다. */
export async function claimStructurePending(
  pg: PostgresClient,
  limit: number,
): Promise<string[]> {
  const result = await pg.query<{ contentid: string }>(
    `SELECT contentid FROM tour_contents
      WHERE detail_status = 'done' AND structure_status = 'pending'
      ORDER BY contentid
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => r.contentid);
}

/** 임베딩 대기 목록. */
export async function claimEmbedPending(
  pg: PostgresClient,
  limit: number,
): Promise<string[]> {
  const result = await pg.query<{ contentid: string }>(
    `SELECT contentid FROM tour_contents
      WHERE structure_status = 'done' AND embed_status = 'pending'
      ORDER BY contentid
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => r.contentid);
}

export interface StageCounts {
  structure: Record<StageStatus, number>;
  embed: Record<StageStatus, number>;
}

const EMPTY_STAGE_COUNTS = (): Record<StageStatus, number> => ({
  pending: 0,
  done: 0,
  failed: 0,
});

/** 상세를 받아둔 행만 대상으로 두 스테이지의 상태별 건수를 센다. */
export async function countStageStatus(pg: PostgresClient): Promise<StageCounts> {
  const result = await pg.query<{
    structure_status: StageStatus;
    embed_status: StageStatus;
    count: string | number;
  }>(
    `SELECT structure_status, embed_status, COUNT(*) AS count
       FROM tour_contents
      WHERE detail_status = 'done'
      GROUP BY structure_status, embed_status`,
  );
  const counts: StageCounts = {
    structure: EMPTY_STAGE_COUNTS(),
    embed: EMPTY_STAGE_COUNTS(),
  };
  for (const row of result.rows) {
    const n = Number(row.count);
    // 알 수 없는 상태값이 들어와도 NaN으로 오염되지 않게 키 존재를 확인한다.
    if (row.structure_status in counts.structure) counts.structure[row.structure_status] += n;
    if (row.embed_status in counts.embed) counts.embed[row.embed_status] += n;
  }
  return counts;
}
