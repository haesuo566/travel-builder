# generate-tour-codes 커맨드(TourAPI 코드표 → Postgres 적재) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `core`에 TourAPI 코드표(관광타입/법정동/분류체계)를 Postgres에 적재하는 CLI 커맨드 `tb generate-tour-codes`를 TDD로 구현한다.

**Architecture:** `TourApiClient`에 코드 조회 오퍼레이션(`lclsSystmCode2`, `ldongCode2`) 전용 메서드 3개(`getLclsSystmTree`/`getLdongRegionList`/`getLdongSignguList`)를 추가한다. 새 커맨드 `generateTourCodes(tourApi, pg)`가 이 메서드들을 호출해 얻은 코드 목록을 `PostgresClient.transaction` 안에서 `CREATE TABLE IF NOT EXISTS` + `INSERT ... ON CONFLICT DO UPDATE`(upsert)로 3개 테이블에 멱등하게 적재한다. `contenttypeid`(관광타입) 8종은 API 조회 없이 코드에 하드코딩한다.

**범위 밖(다음 계획에서 다룸):** `getAreaBasedSyncList`/`getDetailCommon` v4.4 정합화, `TourContent` 투영, `collectTourContents`, 코드표를 읽어 이름을 조회하는 `loadTourCodeTables`/`resolve*` 함수. 이번 계획은 코드표를 Postgres에 "적재"만 하며, 읽어서 사용하는 쪽은 별도 계획.

**Tech Stack:** TypeScript(ESM/NodeNext), axios, pg(`PostgresClient` 기존 재사용), commander, Vitest.

---

## File Structure

- `core/src/clients/tourApi.ts` — `getLclsSystmTree`/`getLdongRegionList`/`getLdongSignguList` 메서드 추가 (수정)
- `core/tests/clients/tourApi.test.ts` — 위 3개 메서드 단위 테스트 추가 (수정)
- `core/src/commands/generateTourCodes.ts` — `generateTourCodes`(핵심 로직) + `registerGenerateTourCodes`(CLI 등록) (신규)
- `core/tests/commands/generateTourCodes.test.ts` — 단위 테스트 (신규)
- `core/src/index.ts` — `registerGenerateTourCodes(program)` 등록 (수정)

> **ESM/NodeNext 규칙:** 상대 import는 `.js` 확장자 사용. **작업 디렉토리:** npm/npx/node는 `core/`에서, git은 저장소 루트 `C:\workspace\travel-buider`에서 실행. **브랜치:** `feat/generate-tour-codes` (아직 없으면 `main`에서 분기해 생성).

> **참고 문서:** `docs/superpowers/specs/2026-07-24-tour-info-ingest-design.md`(스펙), `core/docs/한국관광공사_개방데이터_활용매뉴얼(국문)_v4.4_API명세서.md`(`lclsSystmCode2`/`ldongCode2` 오퍼레이션 명세, 1183~1295줄).

---

## Task 1: TourApiClient — `getLclsSystmTree` (분류체계 전체 트리 조회 + 페이지네이션)

**Files:**
- Modify: `core/tests/clients/tourApi.test.ts`
- Modify: `core/src/clients/tourApi.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/clients/tourApi.test.ts`의 `envelope` 헬퍼가 `totalCount`를 항상 0으로 고정하고 있어 페이지네이션 테스트가 불가능하다. 헬퍼에 `totalCount` 파라미터를 추가한다(기존 호출부는 인자를 안 넘기므로 영향 없음).

```typescript
function envelope(items: unknown, resultCode = "0000", resultMsg = "OK", totalCount = 0) {
  return {
    data: {
      response: {
        header: { resultCode, resultMsg },
        body: { items, numOfRows: 10, pageNo: 1, totalCount },
      },
    },
  };
}
```

같은 파일의 `describe("TourApiClient", ...)` 블록 맨 끝(마지막 `it`, `getDetailImages가 여러 이미지를 배열로 반환한다` 다음)에 아래 테스트 2개를 추가한다.

```typescript
  it("getLclsSystmTree가 lclsSystmListYn=Y로 요청하고 전체 트리를 반환한다 (단일 페이지)", async () => {
    const items = [
      {
        lclsSystm1Cd: "AC",
        lclsSystm1Nm: "숙박",
        lclsSystm2Cd: "AC01",
        lclsSystm2Nm: "호텔",
        lclsSystm3Cd: "AC010100",
        lclsSystm3Nm: "호텔",
      },
    ];
    getMock.mockResolvedValue(envelope({ item: items }, "0000", "OK", items.length));
    const client = new TourApiClient();
    const result = await client.getLclsSystmTree();
    expect(result).toEqual(items);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("lclsSystmCode2?");
    expect(url).toContain("lclsSystmListYn=Y");
    expect(url).toContain("numOfRows=1000");
    expect(url).toContain("pageNo=1");
  });

  it("getLclsSystmTree가 totalCount보다 적게 받으면 다음 페이지를 이어서 요청한다", async () => {
    const page1 = [
      {
        lclsSystm1Cd: "AC",
        lclsSystm1Nm: "숙박",
        lclsSystm2Cd: "AC01",
        lclsSystm2Nm: "호텔",
        lclsSystm3Cd: "AC010100",
        lclsSystm3Nm: "호텔",
      },
    ];
    const page2 = [
      {
        lclsSystm1Cd: "FD",
        lclsSystm1Nm: "음식",
        lclsSystm2Cd: "FD01",
        lclsSystm2Nm: "한식",
        lclsSystm3Cd: "FD010100",
        lclsSystm3Nm: "한식",
      },
    ];
    getMock
      .mockResolvedValueOnce(envelope({ item: page1 }, "0000", "OK", 2))
      .mockResolvedValueOnce(envelope({ item: page2 }, "0000", "OK", 2));
    const client = new TourApiClient();
    const result = await client.getLclsSystmTree();
    expect(result).toEqual([...page1, ...page2]);
    expect(getMock).toHaveBeenCalledTimes(2);
    const secondUrl = getMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain("pageNo=2");
  });
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: FAIL — `client.getLclsSystmTree is not a function`.

- [ ] **Step 3: 구현**

`core/src/clients/tourApi.ts`의 `TourApiImage` 인터페이스(현재 66~73줄) 바로 다음, `interface TourApiEnvelope<T>` 앞에 아래 인터페이스를 추가한다.

```typescript
export interface TourApiLclsSystmItem {
  lclsSystm1Cd: string;
  lclsSystm1Nm: string;
  lclsSystm2Cd: string;
  lclsSystm2Nm: string;
  lclsSystm3Cd: string;
  lclsSystm3Nm: string;
}
```

`TourApiClient` 클래스 안, `private async request<T>(...)` 메서드(현재 113~125줄) 바로 다음에 아래 `requestAll` 헬퍼를 추가한다. `totalCount`에 도달하거나 빈 페이지를 받을 때까지 `pageNo`를 늘려가며 누적 조회한다.

```typescript
  private async requestAll<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    numOfRows: number,
  ): Promise<T[]> {
    const results: T[] = [];
    let pageNo = 1;
    while (true) {
      const url = this.buildUrl(path, { ...params, numOfRows, pageNo });
      const { data } = await axios.get<TourApiEnvelope<T>>(url);
      if (data.response.header.resultCode !== "0000") {
        throw new Error(
          `TourAPI 오류(${data.response.header.resultCode}): ${data.response.header.resultMsg}`,
        );
      }
      const items = normalizeItems(data.response.body.items);
      results.push(...items);
      if (items.length === 0 || results.length >= data.response.body.totalCount) {
        break;
      }
      pageNo += 1;
    }
    return results;
  }
```

클래스 맨 끝, `getDetailImages` 메서드(현재 174~182줄) 다음, 클래스 닫는 `}` 앞에 아래 메서드를 추가한다.

```typescript
  /** 분류체계(대/중/소분류) 전체 코드 트리를 조회한다. */
  async getLclsSystmTree(): Promise<TourApiLclsSystmItem[]> {
    return this.requestAll<TourApiLclsSystmItem>("lclsSystmCode2", { lclsSystmListYn: "Y" }, 1000);
  }
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: PASS — 기존 13개 + 신규 2개 = 15개.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/tourApi.ts core/tests/clients/tourApi.test.ts
git commit -m "feat: TourApiClient에 getLclsSystmTree 추가 (분류체계 코드 조회)"
```

---

## Task 2: TourApiClient — `getLdongRegionList` (법정동 시도 목록 조회)

**Files:**
- Modify: `core/tests/clients/tourApi.test.ts`
- Modify: `core/src/clients/tourApi.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

Task 1에서 추가한 두 테스트 다음에 이어서 추가한다.

```typescript
  it("getLdongRegionList가 lDongListYn=N, lDongRegnCd 없이 요청하고 시도 목록을 반환한다", async () => {
    const regions = [
      { code: "11", name: "서울특별시" },
      { code: "26", name: "부산광역시" },
    ];
    getMock.mockResolvedValue(envelope({ item: regions }, "0000", "OK", regions.length));
    const client = new TourApiClient();
    const result = await client.getLdongRegionList();
    expect(result).toEqual(regions);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("ldongCode2?");
    expect(url).toContain("lDongListYn=N");
    expect(url).not.toContain("lDongRegnCd=");
  });
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: FAIL — `client.getLdongRegionList is not a function`.

- [ ] **Step 3: 구현**

`TourApiLclsSystmItem` 인터페이스 다음에 아래 인터페이스를 추가한다.

```typescript
export interface TourApiLdongCodeItem {
  code: string;
  name: string;
}
```

`getLclsSystmTree` 메서드 다음에 아래 메서드를 추가한다.

```typescript
  /** 법정동 시도 코드 목록을 조회한다. */
  async getLdongRegionList(): Promise<TourApiLdongCodeItem[]> {
    return this.requestAll<TourApiLdongCodeItem>("ldongCode2", { lDongListYn: "N" }, 100);
  }
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: PASS — 15개 + 신규 1개 = 16개.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/tourApi.ts core/tests/clients/tourApi.test.ts
git commit -m "feat: TourApiClient에 getLdongRegionList 추가 (법정동 시도 코드 조회)"
```

---

## Task 3: TourApiClient — `getLdongSignguList` (법정동 시군구 목록 조회)

**Files:**
- Modify: `core/tests/clients/tourApi.test.ts`
- Modify: `core/src/clients/tourApi.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

Task 2에서 추가한 테스트 다음에 이어서 추가한다.

```typescript
  it("getLdongSignguList가 lDongRegnCd와 lDongListYn=Y로 요청하고 시군구 목록을 반환한다", async () => {
    const signgus = [
      { lDongRegnCd: "11", lDongRegnNm: "서울특별시", lDongSignguCd: "110", lDongSignguNm: "종로구" },
    ];
    getMock.mockResolvedValue(envelope({ item: signgus }, "0000", "OK", signgus.length));
    const client = new TourApiClient();
    const result = await client.getLdongSignguList("11");
    expect(result).toEqual(signgus);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("ldongCode2?");
    expect(url).toContain("lDongRegnCd=11");
    expect(url).toContain("lDongListYn=Y");
  });
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: FAIL — `client.getLdongSignguList is not a function`.

- [ ] **Step 3: 구현**

`TourApiLdongCodeItem` 인터페이스 다음에 아래 인터페이스를 추가한다.

```typescript
export interface TourApiLdongItem {
  lDongRegnCd: string;
  lDongRegnNm: string;
  lDongSignguCd: string;
  lDongSignguNm: string;
}
```

`getLdongRegionList` 메서드 다음에 아래 메서드를 추가한다.

```typescript
  /** 특정 시도의 법정동 시군구 코드 목록을 조회한다. */
  async getLdongSignguList(regnCd: string): Promise<TourApiLdongItem[]> {
    return this.requestAll<TourApiLdongItem>(
      "ldongCode2",
      { lDongRegnCd: regnCd, lDongListYn: "Y" },
      1000,
    );
  }
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: PASS — 16개 + 신규 1개 = 17개.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/tourApi.ts core/tests/clients/tourApi.test.ts
git commit -m "feat: TourApiClient에 getLdongSignguList 추가 (법정동 시군구 코드 조회)"
```

---

## Task 4: generateTourCodes — 테이블 생성 + 관광타입(contenttype) upsert

**Files:**
- Create: `core/tests/commands/generateTourCodes.test.ts`
- Create: `core/src/commands/generateTourCodes.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
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
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/commands/generateTourCodes.test.ts`
Expected: FAIL — `../../src/commands/generateTourCodes.js` 없음.

- [ ] **Step 3: 구현**

```typescript
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
```

(`lclsSystmCount`/`ldongRegionCount`/`ldongSignguCount`는 Task 5, 6에서 실제 값으로 채운다.)

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/commands/generateTourCodes.test.ts`
Expected: PASS — 2개.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/commands/generateTourCodes.ts core/tests/commands/generateTourCodes.test.ts
git commit -m "feat: generate-tour-codes 커맨드 뼈대 (테이블 생성 + 관광타입 upsert)"
```

---

## Task 5: generateTourCodes — 분류체계 코드(lclsSystm) upsert

**Files:**
- Modify: `core/tests/commands/generateTourCodes.test.ts`
- Modify: `core/src/commands/generateTourCodes.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

Task 4에서 작성한 두 테스트 다음에 이어서 추가한다.

```typescript
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
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/commands/generateTourCodes.test.ts`
Expected: FAIL — `result.lclsSystmCount`이 0이라 `toBe(2)` 불일치.

- [ ] **Step 3: 구현**

`upsertContentTypes` 함수 다음에 아래 함수를 추가한다.

```typescript
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
```

`generateTourCodes` 함수 안의 `return { ... }` 블록을 아래와 같이 수정한다.

```typescript
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
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/commands/generateTourCodes.test.ts`
Expected: PASS — 3개.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/commands/generateTourCodes.ts core/tests/commands/generateTourCodes.test.ts
git commit -m "feat: generate-tour-codes에 분류체계 코드 upsert 추가"
```

---

## Task 6: generateTourCodes — 법정동 코드(lDong 시도+시군구) upsert

**Files:**
- Modify: `core/tests/commands/generateTourCodes.test.ts`
- Modify: `core/src/commands/generateTourCodes.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

Task 5에서 작성한 테스트 다음에 이어서 추가한다.

```typescript
  it("시도 목록과 시도별 시군구 목록을 모두 upsert하고 카운트를 반환한다", async () => {
    const { pg, queryMock } = fakePg();
    const regions = [
      { code: "11", name: "서울특별시" },
      { code: "26", name: "부산광역시" },
    ];
    const signgusByRegion: Record<string, unknown[]> = {
      "11": [{ lDongRegnCd: "11", lDongRegnNm: "서울특별시", lDongSignguCd: "110", lDongSignguNm: "종로구" }],
      "26": [],
    };
    const tourApi = fakeTourApi({
      getLdongRegionList: vi.fn().mockResolvedValue(regions),
      getLdongSignguList: vi.fn((regnCd: string) => Promise.resolve(signgusByRegion[regnCd])),
    });
    const result = await generateTourCodes(tourApi, pg);
    expect(result.ldongRegionCount).toBe(2);
    expect(result.ldongSignguCount).toBe(1);
    const ldongInserts = queryMock.mock.calls.filter((c) =>
      (c[0] as string).includes("INSERT INTO tour_ldong_codes"),
    );
    // 시도 2건(빈 시군구 sentinel) + 시군구 1건 = 3건
    expect(ldongInserts).toHaveLength(3);
  });
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/commands/generateTourCodes.test.ts`
Expected: FAIL — `result.ldongRegionCount`/`ldongSignguCount`이 0이라 불일치.

- [ ] **Step 3: 구현**

`upsertLclsSystmCodes` 함수 다음에 아래 함수를 추가한다.

```typescript
async function upsertLdongCodes(
  client: PoolClient,
  tourApi: TourApiClient,
): Promise<{ regionCount: number; signguCount: number }> {
  const regions = await tourApi.getLdongRegionList();
  let signguCount = 0;
  for (const region of regions) {
    await client.query(
      `INSERT INTO tour_ldong_codes (regn_code, regn_name, signgu_code, signgu_name)
       VALUES ($1, $2, '', '')
       ON CONFLICT (regn_code, signgu_code) DO UPDATE SET regn_name = EXCLUDED.regn_name`,
      [region.code, region.name],
    );
    const signgus = await tourApi.getLdongSignguList(region.code);
    for (const signgu of signgus) {
      await client.query(
        `INSERT INTO tour_ldong_codes (regn_code, regn_name, signgu_code, signgu_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (regn_code, signgu_code) DO UPDATE SET
           regn_name = EXCLUDED.regn_name,
           signgu_name = EXCLUDED.signgu_name`,
        [signgu.lDongRegnCd, signgu.lDongRegnNm, signgu.lDongSignguCd, signgu.lDongSignguNm],
      );
    }
    signguCount += signgus.length;
  }
  return { regionCount: regions.length, signguCount };
}
```

`generateTourCodes` 함수 안의 `return { ... }` 블록을 아래와 같이 수정한다.

```typescript
  return pg.transaction(async (client) => {
    await createTables(client);
    const contentTypeCount = await upsertContentTypes(client);
    const lclsSystmCount = await upsertLclsSystmCodes(client, tourApi);
    const { regionCount, signguCount } = await upsertLdongCodes(client, tourApi);
    return {
      contentTypeCount,
      lclsSystmCount,
      ldongRegionCount: regionCount,
      ldongSignguCount: signguCount,
    };
  });
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/commands/generateTourCodes.test.ts`
Expected: PASS — 4개.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/commands/generateTourCodes.ts core/tests/commands/generateTourCodes.test.ts
git commit -m "feat: generate-tour-codes에 법정동 코드 upsert 추가"
```

---

## Task 7: CLI 등록 (`tb generate-tour-codes`)

**Files:**
- Modify: `core/src/commands/generateTourCodes.ts`
- Modify: `core/src/index.ts`

- [ ] **Step 1: `registerGenerateTourCodes` 구현**

`core/src/commands/generateTourCodes.ts` 맨 위 import 목록에 아래 2줄을 추가한다.

```typescript
import type { Command } from "commander";
import { TourApiClient } from "../clients/tourApi.js";
import { PostgresClient } from "../clients/postgres.js";
import { logger } from "../lib/logger.js";
```

(`TourApiClient`/`PostgresClient`는 기존에 `import type`이었다면 값으로도 써야 하므로 `import type` 제거하고 일반 `import`로 바꾼다 — `new TourApiClient()`/`new PostgresClient()`로 생성하기 때문.)

파일 맨 끝에 아래 함수를 추가한다.

```typescript
/** commander program에 `generate-tour-codes` 명령을 등록한다. */
export function registerGenerateTourCodes(program: Command): void {
  program
    .command("generate-tour-codes")
    .description("TourAPI 코드표(관광타입/법정동/분류체계)를 Postgres에 적재")
    .action(async () => {
      const tourApi = new TourApiClient();
      const pg = new PostgresClient();
      await pg.connect();
      try {
        const result = await generateTourCodes(tourApi, pg);
        logger.info(
          `코드표 적재 완료 — 관광타입 ${result.contentTypeCount}건, ` +
            `분류체계 ${result.lclsSystmCount}건, ` +
            `법정동 시도 ${result.ldongRegionCount}건/시군구 ${result.ldongSignguCount}건`,
        );
      } finally {
        await pg.close();
      }
    });
}
```

- [ ] **Step 2: `index.ts`에 등록**

`core/src/index.ts`를 아래와 같이 수정한다(전체 내용).

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { registerHello } from "./commands/hello.js";
import { registerGenerateTourCodes } from "./commands/generateTourCodes.js";

const program = new Command();

program
  .name("tb")
  .description("travel-builder 개발/운영 보조 CLI")
  .version("0.1.0");

registerHello(program);
registerGenerateTourCodes(program);

program.parse();
```

- [ ] **Step 3: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: 전체 테스트**

Run (in `core/`): `npm test`
Expected: 모든 테스트 PASS (기존 + tourApi 4개 신규 + generateTourCodes 4개 신규).

- [ ] **Step 5: 빌드로 CLI 동작 확인 (선택, `DATABASE_URL`/`TOUR_API_SERVICE_KEY` 없어도 `--help`는 동작)**

Run (in `core/`): `npm run build && node dist/index.js generate-tour-codes --help`
Expected: `generate-tour-codes` 커맨드 설명이 출력됨.

- [ ] **Step 6: Commit**

```bash
git add core/src/commands/generateTourCodes.ts core/src/index.ts
git commit -m "feat: tb generate-tour-codes CLI 커맨드 등록"
```

---

## Task 8: 전체 검증

**Files:**
- (신규 파일 없음 — 통합 검증)

- [ ] **Step 1: 전체 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: 전체 테스트**

Run (in `core/`): `npm test`
Expected: 모든 테스트 PASS.

- [ ] **Step 3: 빌드**

Run (in `core/`): `npm run build`
Expected: 오류 없이 `dist/commands/generateTourCodes.js` 생성.

---

## Self-Review 결과

**Spec coverage** (`docs/superpowers/specs/2026-07-24-tour-info-ingest-design.md` 대비):
- `contenttypeid` 8종 하드코딩 → Task 4.
- `lclsSystmCode2` 전체 트리 조회(`lclsSystmListYn=Y`) → Task 1.
- `ldongCode2` 시도 목록(`lDongListYn=N`, `lDongRegnCd` 없음) → Task 2.
- `ldongCode2` 시도별 시군구 목록(`lDongRegnCd` + `lDongListYn=Y`) → Task 3.
- `tour_content_types`/`tour_ldong_codes`/`tour_lcls_systm_codes` 스키마(종류별 테이블, `CREATE TABLE IF NOT EXISTS`) → Task 4~6.
- upsert(멱등, `ON CONFLICT DO UPDATE`) → Task 4~6.
- `tb generate-tour-codes` CLI 등록 → Task 7.
- 코드표 로드(`loadTourCodeTables`)·`TourContent` 투영·`collectTourContents`는 스펙에 있으나 이번 계획 범위 밖으로 명시(머리말 "범위 밖" 참고) — 별도 계획에서 다룸.

**Placeholder scan:** "TBD"/"TODO"/"add appropriate ..." 등 표현 없음. 모든 스텝에 실행 가능한 전체 코드·정확한 명령어 포함.

**Type consistency:** `TourApiLclsSystmItem`/`TourApiLdongCodeItem`/`TourApiLdongItem` 필드명이 Task 1~3 인터페이스 정의와 Task 5~6의 `upsertLclsSystmCodes`/`upsertLdongCodes` 사용처에서 동일. `GenerateTourCodesResult`의 4개 필드명(`contentTypeCount`/`lclsSystmCount`/`ldongRegionCount`/`ldongSignguCount`)이 Task 4~6의 반환문과 Task 4~6 테스트의 `result.*` 단언에서 일관됨. `requestAll<T>`가 Task 1에서 정의된 그대로 Task 2, 3에서 재사용됨.
