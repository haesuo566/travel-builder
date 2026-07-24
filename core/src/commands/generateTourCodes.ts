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

async function upsertLclsSystmCodes(client: PoolClient, tourApi: TourApiClient): Promise<number> {
  const items = await tourApi.getLclsSystmTree();
  for (const item of items) {
    await client.query(
      `INSERT INTO tour_lcls_systm_codes
         (lvl1_code, lvl1_name, lvl2_code, lvl2_name, lvl3_code, lvl3_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lvl1_code, lvl2_code, lvl3_code) DO UPDATE SET
         lvl1_name = EXCLUDED.lvl1_name,
         lvl2_name = EXCLUDED.lvl2_name,
         lvl3_name = EXCLUDED.lvl3_name`,
      [
        item.lclsSystm1Cd,
        item.lclsSystm1Nm,
        item.lclsSystm2Cd,
        item.lclsSystm2Nm,
        item.lclsSystm3Cd,
        item.lclsSystm3Nm,
      ],
    );
  }
  return items.length;
}

/** TourAPI 코드표(관광타입/법정동/분류체계)를 Postgres에 적재한다. */
export async function generateTourCodes(
  tourApi: TourApiClient,
  pg: PostgresClient,
): Promise<GenerateTourCodesResult> {
  return pg.transaction(async (client) => {
    await createTables(client);
    const contentTypeCount = await upsertContentTypes(client);
    const lclsSystmCount = await upsertLclsSystmCodes(client, tourApi);
    return {
      contentTypeCount,
      lclsSystmCount,
      ldongRegionCount: 0,
      ldongSignguCount: 0,
    };
  });
}
