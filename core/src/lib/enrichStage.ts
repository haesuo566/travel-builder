import type { PoolClient } from "pg";
import type { PostgresClient } from "../clients/postgres.js";

/**
 * 구조화·임베딩 스테이지 컬럼과 부분 인덱스를 tour_contents에 멱등하게 추가한다.
 *
 * tourContentsTable.ts의 createTourContentsTable이 상세 수집 테이블·인덱스를 만든
 * 직후 이 함수를 호출한다 — 의존 방향은 단방향이다(상세 수집 모듈 → 이 모듈).
 * 기존 테이블에는 CREATE TABLE IF NOT EXISTS가 no-op이라 신규 컬럼이 생기지 않으므로,
 * ADD COLUMN IF NOT EXISTS로 신규 생성·기존 갱신 양쪽을 이 한 곳에서 처리한다.
 */
export async function addStageColumns(client: PoolClient): Promise<void> {
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

/** 구조화·임베딩 체인의 입력. 프롬프트용 이름과 payload용 코드·좌표를 함께 담는다. */
export interface EnrichInput {
  contentid: string;
  title: string;
  addr1: string;
  addr2: string;
  overview: string;
  /** null = 아직 구조화되지 않음 */
  structuredText: string | null;
  /**
   * structure_status 컬럼 그대로. 재사용 분기(ensureStructuredText)가 이 값과 다른
   * 진실을 보면(예: structuredText는 남아 있는데 status가 pending) 그 행은 claim
   * 쿼리에서 영원히 빠지지 않는다 — 재사용 여부의 유일한 근거로 삼는다.
   */
  structureStatus: StageStatus;
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
  structure_status: StageStatus;
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
         c.structure_status,
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
    structureStatus: r.structure_status,
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
export async function claimEmbedPending(pg: PostgresClient, limit: number): Promise<string[]> {
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
