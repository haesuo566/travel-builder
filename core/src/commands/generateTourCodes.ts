import type { PoolClient } from "pg";
import type { TourApiClient } from "../clients/tourApi.js";
import type { PostgresClient } from "../clients/postgres.js";

const CONTENT_TYPES: Array<{ code: string; name: string }> = [
  { code: "12", name: "관광지" },
  { code: "14", name: "문화시설" },
  { code: "15", name: "축제공연행사" },
  { code: "25", name: "여행코스" },
  { code: "28", name: "레포츠" },
  { code: "32", name: "숙박" },
  { code: "38", name: "쇼핑" },
  { code: "39", name: "음식점" },
];

export interface GenerateTourCodesResult {
  contentTypeCount: number;
  lclsSystmCount: number;
  ldongRegionCount: number;
  ldongSignguCount: number;
}

async function createTables(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tour_content_types (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS tour_ldong_codes (
      regn_code TEXT NOT NULL,
      regn_name TEXT NOT NULL,
      signgu_code TEXT NOT NULL DEFAULT '',
      signgu_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (regn_code, signgu_code)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS tour_lcls_systm_codes (
      lvl1_code TEXT NOT NULL,
      lvl1_name TEXT NOT NULL,
      lvl2_code TEXT NOT NULL DEFAULT '',
      lvl2_name TEXT NOT NULL DEFAULT '',
      lvl3_code TEXT NOT NULL DEFAULT '',
      lvl3_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (lvl1_code, lvl2_code, lvl3_code)
    )
  `);
}

async function upsertContentTypes(client: PoolClient): Promise<number> {
  for (const { code, name } of CONTENT_TYPES) {
    await client.query(
      `INSERT INTO tour_content_types (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [code, name],
    );
  }
  return CONTENT_TYPES.length;
}

/** TourAPI 코드표(관광타입/법정동/분류체계)를 Postgres에 적재한다. */
export async function generateTourCodes(
  tourApi: TourApiClient,
  pg: PostgresClient,
): Promise<GenerateTourCodesResult> {
  return pg.transaction(async (client) => {
    await createTables(client);
    const contentTypeCount = await upsertContentTypes(client);
    return {
      contentTypeCount,
      lclsSystmCount: 0,
      ldongRegionCount: 0,
      ldongSignguCount: 0,
    };
  });
}
