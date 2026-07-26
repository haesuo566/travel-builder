# collect-detail 인라인 임베딩 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tb collect-detail` 한 실행으로 한 콘텐츠가 `detailCommon2 → Postgres → Gemini 구조화 → TEI(bge-m3) 임베딩 → Qdrant 저장`을 통과하게 만든다.

**Architecture:** 기존 `collectDetail()` 루프에 옵셔널 `enricher` 훅을 추가한다. `markDetailDone`이 커밋된 **뒤에** `enricher.enrich(contentid)`를 호출하므로, 그 아래의 어떤 실패도 이미 소비한 TourAPI 쿼터를 잃지 않는다. enricher는 DB 쓰기 실패를 제외한 모든 실패를 내부에서 분류·기록하고 정상 반환하며, 연속 실패 차단기에 걸리면 스스로를 비활성화해 상세 수집만 계속되게 한다. 세 스테이지(`detail_*` / `structure_*` / `embed_*`)의 상태 컬럼이 재개 지점 역할을 하므로 별도 커서가 없다.

**Tech Stack:** TypeScript (ESM, Node ≥20) · commander · pg · `@google/genai` · `@qdrant/js-client-rest` · axios(TEI) · vitest

**설계 문서:** `docs/superpowers/specs/2026-07-26-collect-detail-inline-embedding-design.md`

## Global Constraints

- 작업 디렉터리는 `core/`. 모든 명령은 `core/`에서 실행한다.
- ESM이므로 **상대 import에 반드시 `.js` 확장자**를 붙인다 (`../lib/env.js`). 빠뜨리면 런타임에 모듈을 못 찾는다.
- 주석·로그 메시지·에러 메시지는 **한국어**로 쓴다. 기존 코드 전체가 그렇다.
- 마이그레이션 프레임워크를 도입하지 않는다. DDL은 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`로 커맨드 내에서 직접 실행한다.
- **커밋은 건당.** `pg.transaction()`으로 여러 항목을 묶지 않는다. `mark*` 함수는 `PostgresClient`를 받아 자동 커밋으로 실행한다.
- 임베딩 모델은 **bge-m3 dense, 1024차원, Cosine**. 차원은 하드코딩하지 않고 TEI 응답에서 감지한다.
- Qdrant point id는 `Number(contentid)`. Qdrant는 unsigned integer 또는 UUID만 허용한다.
- 테스트는 vitest. 외부 의존은 전부 `vi.mock`으로 대체하고 **실제 네트워크·DB 호출을 하지 않는다.**
- 테스트 실행: `npm test -- <경로>`. 전체는 `npm test`. 타입 검사는 `npm run typecheck`.

---

### Task 1: `QdrantStore.getCollectionInfo`

컬렉션의 벡터 차원을 읽는 메서드. 현행 `QdrantStore`에는 컬렉션 조회 수단이 전혀 없어서 차원 불일치를 감지할 방법이 없다.

**Files:**
- Modify: `core/src/clients/qdrant.ts`
- Test: `core/tests/clients/qdrant.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `QdrantStore.getCollectionInfo(name: string): Promise<{ vectorSize: number } | null>`

- [ ] **Step 1: 테스트 mock에 `getCollection` 추가**

`core/tests/clients/qdrant.test.ts`의 `vi.hoisted` 블록에 `getCollectionMock`을 추가한다. 기존 블록을 아래로 교체:

```ts
const {
  getCollectionsMock,
  getCollectionMock,
  createCollectionMock,
  deleteCollectionMock,
  upsertMock,
  searchMock,
  deleteMock,
  QdrantClientMock,
} = vi.hoisted(() => {
  const getCollectionsMock = vi.fn();
  const getCollectionMock = vi.fn();
  const createCollectionMock = vi.fn();
  const deleteCollectionMock = vi.fn();
  const upsertMock = vi.fn();
  const searchMock = vi.fn();
  const deleteMock = vi.fn();
  const QdrantClientMock = vi.fn(() => ({
    getCollections: getCollectionsMock,
    getCollection: getCollectionMock,
    createCollection: createCollectionMock,
    deleteCollection: deleteCollectionMock,
    upsert: upsertMock,
    search: searchMock,
    delete: deleteMock,
  }));
  return {
    getCollectionsMock,
    getCollectionMock,
    createCollectionMock,
    deleteCollectionMock,
    upsertMock,
    searchMock,
    deleteMock,
    QdrantClientMock,
  };
});
```

그리고 `beforeEach`의 mockReset 목록에 한 줄 추가 (`getCollectionsMock` 줄 바로 아래):

```ts
  getCollectionMock.mockReset();
```

- [ ] **Step 2: 실패하는 테스트 작성**

`core/tests/clients/qdrant.test.ts`의 `describe("QdrantStore", ...)` 블록 맨 끝(`deletePoints` 테스트 다음)에 추가:

```ts
  it("getCollectionInfo가 벡터 차원을 반환한다", async () => {
    getCollectionMock.mockResolvedValue({
      config: { params: { vectors: { size: 1024, distance: "Cosine" } } },
    });
    const store = new QdrantStore();
    await store.connect();
    expect(await store.getCollectionInfo("col")).toEqual({ vectorSize: 1024 });
    expect(getCollectionMock).toHaveBeenCalledWith("col");
  });

  it("컬렉션이 없으면(404) null을 반환한다", async () => {
    getCollectionMock.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    const store = new QdrantStore();
    await store.connect();
    expect(await store.getCollectionInfo("없는컬렉션")).toBeNull();
  });

  it("404가 아닌 에러는 전파한다", async () => {
    // 연결 장애를 "컬렉션 없음"으로 오분류하면, 기존 컬렉션 위에
    // 다른 차원으로 재생성을 시도하게 된다.
    getCollectionMock.mockRejectedValue(Object.assign(new Error("ECONNREFUSED"), { status: 500 }));
    const store = new QdrantStore();
    await store.connect();
    await expect(store.getCollectionInfo("col")).rejects.toThrow("ECONNREFUSED");
  });

  it("차원을 읽을 수 없는 응답이면 throw", async () => {
    getCollectionMock.mockResolvedValue({ config: { params: {} } });
    const store = new QdrantStore();
    await store.connect();
    await expect(store.getCollectionInfo("col")).rejects.toThrow("벡터 크기");
  });

  it("connect 전 getCollectionInfo 호출 시 throw", async () => {
    const store = new QdrantStore();
    await expect(store.getCollectionInfo("col")).rejects.toThrow("연결");
  });
```

- [ ] **Step 3: 실패를 확인**

```
npm test -- tests/clients/qdrant.test.ts
```

Expected: FAIL — `store.getCollectionInfo is not a function`

- [ ] **Step 4: 구현**

`core/src/clients/qdrant.ts`의 `import` 아래(클래스 위)에 판별 헬퍼를 추가:

```ts
/**
 * 컬렉션 부재(404)인지 판별한다.
 * SDK 버전에 따라 status를 노출하지 않는 경우가 있어 메시지도 함께 본다.
 */
function isCollectionNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record.status === 404) return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /not found|doesn't exist|does not exist/i.test(message);
}
```

`QdrantStore`의 `createCollection` 메서드 **위**에 추가:

```ts
  /**
   * 컬렉션 정보를 조회한다. 컬렉션이 없으면 null.
   * 404가 아닌 에러는 전파한다 — 연결 장애를 "없음"으로 오분류하면
   * 기존 컬렉션 위에 다른 차원으로 재생성을 시도하게 된다.
   */
  async getCollectionInfo(name: string): Promise<{ vectorSize: number } | null> {
    const client = this.requireClient();
    let info: Awaited<ReturnType<QdrantClient["getCollection"]>>;
    try {
      info = await client.getCollection(name);
    } catch (error) {
      if (isCollectionNotFound(error)) return null;
      throw error;
    }
    const vectors = info.config?.params?.vectors;
    const size =
      typeof vectors === "object" && vectors !== null && "size" in vectors
        ? Number((vectors as { size: unknown }).size)
        : Number.NaN;
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`컬렉션 ${name}의 벡터 크기를 읽을 수 없습니다.`);
    }
    return { vectorSize: size };
  }
```

- [ ] **Step 5: 통과를 확인**

```
npm test -- tests/clients/qdrant.test.ts
npm run typecheck
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 6: 커밋**

```bash
git add core/src/clients/qdrant.ts core/tests/clients/qdrant.test.ts
git commit -m "feat(core): QdrantStore에 getCollectionInfo 추가

차원 불일치를 감지하려면 컬렉션 조회가 필요하다. 404는 null로
바꾸되 그 외 에러는 전파한다 — 연결 장애를 '컬렉션 없음'으로
오분류하면 기존 컬렉션 위에 다른 차원으로 재생성을 시도한다."
```

---

### Task 2: 스키마 확장 (스테이지 컬럼 + 부분 인덱스 2개)

**Files:**
- Modify: `core/src/lib/tourContentsTable.ts` (`createTourContentsTable`)
- Test: `core/tests/lib/tourContentsTable.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `tour_contents`에 `structured_text` `structure_status` `structure_attempt_count` `structure_last_error` `structured_at` `embed_status` `embed_attempt_count` `embed_last_error` `embedded_at` 컬럼과 인덱스 `idx_tour_contents_structure_pending` / `idx_tour_contents_embed_pending`

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/tourContentsTable.test.ts`의 `describe("createTourContentsTable", ...)` 블록 안, 기존 `it` 다음에 추가:

```ts
  it("스테이지 컬럼을 ALTER TABLE로 멱등하게 추가한다", async () => {
    // CREATE TABLE IF NOT EXISTS는 테이블이 이미 있으면 통째로 no-op이므로
    // 신규 컬럼이 생기지 않는다. ALTER가 반드시 있어야 한다.
    const { client, queryMock } = fakeClient();
    await createTourContentsTable(client);
    const sql = queryMock.mock.calls.map((c) => c[0] as string).join("\n");
    expect(sql).toContain("ALTER TABLE tour_contents");
    for (const col of [
      "structured_text",
      "structure_status",
      "structure_attempt_count",
      "structure_last_error",
      "structured_at",
      "embed_status",
      "embed_attempt_count",
      "embed_last_error",
      "embedded_at",
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(sql).toMatch(/structure_status\s+TEXT NOT NULL DEFAULT 'pending'/);
    expect(sql).toMatch(/embed_status\s+TEXT NOT NULL DEFAULT 'pending'/);
  });

  it("스테이지별 부분 인덱스를 만들고 진행 순서를 조건에 담는다", async () => {
    const { client, queryMock } = fakeClient();
    await createTourContentsTable(client);
    const sql = queryMock.mock.calls.map((c) => c[0] as string).join("\n");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_tour_contents_structure_pending");
    expect(sql).toContain("WHERE detail_status = 'done' AND structure_status = 'pending'");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_tour_contents_embed_pending");
    expect(sql).toContain("WHERE structure_status = 'done' AND embed_status = 'pending'");
  });
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/lib/tourContentsTable.test.ts
```

Expected: FAIL — `ALTER TABLE tour_contents`를 찾을 수 없음

- [ ] **Step 3: 구현**

`core/src/lib/tourContentsTable.ts`의 `createTourContentsTable` 안, 기존 `CREATE INDEX ... idx_tour_contents_pending` 쿼리 **다음**에 세 개의 쿼리를 추가한다 (함수 끝):

```ts
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
```

- [ ] **Step 4: 통과를 확인**

```
npm test -- tests/lib/tourContentsTable.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add core/src/lib/tourContentsTable.ts core/tests/lib/tourContentsTable.test.ts
git commit -m "feat(core): tour_contents에 구조화·임베딩 스테이지 컬럼 추가

CREATE TABLE IF NOT EXISTS는 기존 테이블에 no-op이라 컬럼이 생기지
않는다. ALTER TABLE ... ADD COLUMN IF NOT EXISTS로 신규 생성과 기존
갱신을 한 곳에서 처리한다. 부분 인덱스 조건이 스테이지 진행 순서를
조회 수준에서 강제한다."
```

---

### Task 3: `fetchEnrichInput` — 체인 입력 단건 조회

`tour_contents`에는 분류·지역이 코드로만 들어 있다. 코드 문자열은 프롬프트에서 의미가 없으므로 코드표 3개를 조인해 이름을 붙인다. 같은 조회가 payload용 원본 코드·좌표와 `structured_text`까지 함께 가져와 체인 전체의 입력을 한 번에 공급한다.

**Files:**
- Modify: `core/src/lib/tourContentsTable.ts`
- Test: `core/tests/lib/tourContentsTable.test.ts`

**Interfaces:**
- Consumes: Task 2의 `structured_text` 컬럼
- Produces:
  - `interface EnrichInput` — 필드: `contentid` `title` `addr1` `addr2` `overview` `structuredText: string | null` `contenttypeid` `ldongRegnCd` `ldongSignguCd` `lclsSystm1` `lclsSystm2` `lclsSystm3` `mapx` `mapy` `contentTypeNm` `lcls1Nm` `lcls2Nm` `lcls3Nm` `regnNm` `signguNm` (모두 `string`, `structuredText` 제외)
  - `fetchEnrichInput(pg: PostgresClient, contentid: string): Promise<EnrichInput | null>`

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/tourContentsTable.test.ts`의 import 목록에 `fetchEnrichInput`을 추가하고, 파일 맨 끝에 추가:

```ts
function enrichRow(overrides: Record<string, unknown> = {}) {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structured_text: null,
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

  it("overview가 NULL이면 빈 문자열로 정규화한다", async () => {
    const { pg } = fakePg([enrichRow({ overview: null })]);
    expect((await fetchEnrichInput(pg, "126508"))?.overview).toBe("");
  });

  it("행이 없으면 null을 반환한다", async () => {
    const { pg } = fakePg([]);
    expect(await fetchEnrichInput(pg, "없음")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/lib/tourContentsTable.test.ts
```

Expected: FAIL — `fetchEnrichInput` export 없음

- [ ] **Step 3: 구현**

`core/src/lib/tourContentsTable.ts` 맨 끝에 추가:

```ts
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
```

- [ ] **Step 4: 통과를 확인**

```
npm test -- tests/lib/tourContentsTable.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add core/src/lib/tourContentsTable.ts core/tests/lib/tourContentsTable.test.ts
git commit -m "feat(core): fetchEnrichInput — 체인 입력을 코드표 조인으로 한 번에 조회

프롬프트용 이름, payload용 원본 코드·좌표, structured_text를 한 쿼리로
가져온다. 인라인 경로와 백로그 경로가 같은 함수로 같은 입력을 보므로
재구조화 결과가 달라지지 않는다."
```

---

### Task 4: 스테이지 상태 함수 (mark / claim / count)

**Files:**
- Modify: `core/src/lib/tourContentsTable.ts`
- Test: `core/tests/lib/tourContentsTable.test.ts`

**Interfaces:**
- Consumes: Task 2의 스테이지 컬럼
- Produces:
  - `type StageStatus = "pending" | "done" | "failed"`
  - `markStructureDone(pg: PostgresClient, contentid: string, text: string): Promise<void>`
  - `markStructureFailure(pg: PostgresClient, contentid: string, error: string, maxAttempts: number): Promise<StageStatus>`
  - `markEmbedDone(pg: PostgresClient, contentid: string): Promise<void>`
  - `markEmbedFailure(pg: PostgresClient, contentid: string, error: string, maxAttempts: number): Promise<StageStatus>`
  - `claimStructurePending(pg: PostgresClient, limit: number): Promise<string[]>`
  - `claimEmbedPending(pg: PostgresClient, limit: number): Promise<string[]>`
  - `interface StageCounts { structure: Record<StageStatus, number>; embed: Record<StageStatus, number> }`
  - `countStageStatus(pg: PostgresClient): Promise<StageCounts>`

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/tourContentsTable.test.ts`의 import 목록에 7개 함수를 추가하고, 파일 맨 끝에 추가:

```ts
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
```

`countStageStatus` 첫 테스트의 기대값 계산: `embed.pending`은 3 + 7 = 10, `embed.done`은 10, `structure.done`은 10 + 3 = 13, `structure.pending`은 7이다.

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/lib/tourContentsTable.test.ts
```

Expected: FAIL — 7개 함수 export 없음

- [ ] **Step 3: 구현**

`core/src/lib/tourContentsTable.ts` 맨 끝에 추가:

```ts
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
```

- [ ] **Step 4: 통과를 확인**

```
npm test -- tests/lib/tourContentsTable.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add core/src/lib/tourContentsTable.ts core/tests/lib/tourContentsTable.test.ts
git commit -m "feat(core): 구조화·임베딩 스테이지 상태 함수 추가

markDetailFailure와 같은 패턴 — 증가와 전이를 단일 UPDATE의 CASE로
처리하고 RETURNING으로 전이 결과를 돌려줘 호출자가 '재시도 대기'와
'영구 제외'를 구분해 집계한다."
```

---

### Task 5: `lib/structuredText.ts` — 프롬프트 조립·검증·폴백

**Files:**
- Create: `core/src/lib/structuredText.ts`
- Test: `core/tests/lib/structuredText.test.ts`

**Interfaces:**
- Consumes: `EnrichInput` (Task 3)
- Produces:
  - `const STRUCTURE_SYSTEM_INSTRUCTION: string`
  - `needsFallback(input: EnrichInput): boolean`
  - `buildStructurePrompt(input: EnrichInput): string`
  - `buildMinimalText(input: EnrichInput): string`
  - `validateStructuredText(text: string): void` — 위반 시 throw

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/structuredText.test.ts` 생성:

```ts
import { describe, it, expect } from "vitest";
import {
  STRUCTURE_SYSTEM_INSTRUCTION,
  buildMinimalText,
  buildStructurePrompt,
  needsFallback,
  validateStructuredText,
} from "../../src/lib/structuredText.js";
import type { EnrichInput } from "../../src/lib/tourContentsTable.js";

function input(overrides: Partial<EnrichInput> = {}): EnrichInput {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structuredText: null,
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
    ...overrides,
  };
}

/** 포맷을 지킨 유효한 구조화 텍스트. */
function validText(): string {
  return [
    "경복궁 — 고궁",
    "무엇을 하는 곳: 궁궐 관람, 수문장 교대식 관람",
    "실내/실외: 실내외 혼합",
    "추천 동반자: 가족, 커플, 혼자",
    "적정 소요시간: 1~2시간",
    "계절/날씨: 사계절",
    "분위기: 고요하고 정제된 역사 공간",
    "설명: 조선 왕조의 법궁이다. 근정전과 경회루가 남아 있다.",
  ].join("\n");
}

describe("STRUCTURE_SYSTEM_INSTRUCTION", () => {
  it("환각 통제와 지역 증폭 금지 규칙을 담는다", () => {
    expect(STRUCTURE_SYSTEM_INSTRUCTION).toContain("정보 없음");
    expect(STRUCTURE_SYSTEM_INSTRUCTION).toContain("지역명·주소를 별도 섹션으로 쓰지 않는다");
    expect(STRUCTURE_SYSTEM_INSTRUCTION).toContain("무엇을 하는 곳:");
  });
});

describe("needsFallback", () => {
  it("overview에 내용이 있으면 false", () => {
    expect(needsFallback(input())).toBe(false);
  });

  it("빈 문자열·공백·개행만이면 true", () => {
    expect(needsFallback(input({ overview: "" }))).toBe(true);
    expect(needsFallback(input({ overview: "   " }))).toBe(true);
    expect(needsFallback(input({ overview: "\n\n" }))).toBe(true);
  });
});

describe("buildStructurePrompt", () => {
  it("제목·타입·분류·지역·주소·원문을 담는다", () => {
    const text = buildStructurePrompt(input());
    expect(text).toContain("제목: 경복궁");
    expect(text).toContain("관광타입: 관광지");
    expect(text).toContain("분류: 인문(문화/예술/역사) > 역사관광지 > 고궁");
    expect(text).toContain("지역: 서울특별시 종로구");
    expect(text).toContain("주소: 서울특별시 종로구 사직로 161");
    expect(text).toContain("설명 원문:");
    expect(text).toContain("조선 왕조의 법궁이다.");
  });

  it("빈 값 줄은 생략한다", () => {
    const text = buildStructurePrompt(
      input({
        contentTypeNm: "",
        lcls1Nm: "",
        lcls2Nm: "",
        lcls3Nm: "",
        regnNm: "",
        signguNm: "",
        addr1: "",
        addr2: "",
      }),
    );
    expect(text).not.toContain("관광타입:");
    expect(text).not.toContain("분류:");
    expect(text).not.toContain("지역:");
    expect(text).not.toContain("주소:");
    expect(text).toContain("제목: 경복궁");
  });

  it("분류 일부만 있으면 있는 레벨만 이어붙인다", () => {
    const text = buildStructurePrompt(input({ lcls3Nm: "" }));
    expect(text).toContain("분류: 인문(문화/예술/역사) > 역사관광지");
    expect(text).not.toContain("역사관광지 > \n");
  });
});

describe("buildMinimalText", () => {
  it("제목·타입·분류만으로 2줄을 만든다", () => {
    expect(buildMinimalText(input({ overview: "" }))).toBe(
      "경복궁 — 관광지\n인문(문화/예술/역사) > 역사관광지 > 고궁",
    );
  });

  it("타입이 없으면 제목만 첫 줄에 둔다", () => {
    expect(buildMinimalText(input({ contentTypeNm: "", lcls1Nm: "", lcls2Nm: "", lcls3Nm: "" }))).toBe(
      "경복궁",
    );
  });
});

describe("validateStructuredText", () => {
  it("포맷을 지킨 텍스트를 통과시킨다", () => {
    expect(() => validateStructuredText(validText())).not.toThrow();
  });

  it("공백이면 throw", () => {
    expect(() => validateStructuredText("   ")).toThrow("비어");
  });

  it("라벨이 빠지면 어떤 라벨인지 알려주며 throw", () => {
    const missing = validText()
      .split("\n")
      .filter((line) => !line.startsWith("분위기:"))
      .join("\n");
    expect(() => validateStructuredText(missing)).toThrow("분위기:");
  });

  it("첫 줄에 구분자가 없으면 throw", () => {
    const noSeparator = validText().replace("경복궁 — 고궁", "경복궁 고궁");
    expect(() => validateStructuredText(noSeparator)).toThrow("구분자");
  });

  it("7개 라벨 전부를 요구한다", () => {
    for (const label of [
      "무엇을 하는 곳:",
      "실내/실외:",
      "추천 동반자:",
      "적정 소요시간:",
      "계절/날씨:",
      "분위기:",
      "설명:",
    ]) {
      const missing = validText()
        .split("\n")
        .filter((line) => !line.startsWith(label))
        .join("\n");
      expect(() => validateStructuredText(missing)).toThrow(label);
    }
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/lib/structuredText.test.ts
```

Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현**

`core/src/lib/structuredText.ts` 생성:

```ts
import type { EnrichInput } from "./tourContentsTable.js";

/** 제목 줄의 구분자. 검증에서 첫 줄 판정에 쓴다. */
const TITLE_SEPARATOR = "—";

const REQUIRED_LABELS = [
  "무엇을 하는 곳:",
  "실내/실외:",
  "추천 동반자:",
  "적정 소요시간:",
  "계절/날씨:",
  "분위기:",
  "설명:",
] as const;

/**
 * Gemini에 매 호출 동일하게 넘기는 시스템 지시문.
 *
 * 규칙 3이 환각을 통제한다 — 속성 추출 방식은 원문에 없는 것을 추론하게 만들므로
 * "확신 없으면 정보 없음"을 명시하지 않으면 전부 그럴듯하게 채워진다.
 * 규칙 5는 지역을 벡터에서 증폭하지 않게 한다 — 지역은 payload 필터로 정확히
 * 걸리는 정형 조건이고, 벡터에 별도 섹션으로 넣으면 의미 축의 해상도를 떨어뜨린다.
 */
export const STRUCTURE_SYSTEM_INSTRUCTION = `당신은 여행 일정 추천 시스템의 검색 색인을 만드는 편집자다.
주어진 관광지 정보를 아래 고정 포맷으로 정규화한다.

규칙:
1. 아래 포맷의 라벨과 순서를 정확히 그대로 쓴다. 라벨을 추가·삭제·변경하지 않는다.
2. '설명 원문'에서 확인되는 사실을 우선한다.
3. 원문에 없지만 장소 유형으로 보아 명확한 것은 추론해도 된다.
   확신이 없으면 "정보 없음"이라고 쓴다. 그럴듯하게 지어내지 않는다.
4. 홍보 문구·과장("꼭 가봐야 할", "최고의", "명실상부")은 버리고 사실만 남긴다.
5. 지역명·주소를 별도 섹션으로 쓰지 않는다. 설명 안에서 필요할 때만 언급한다.
6. 전화번호·URL·요금·운영시간·연도는 쓰지 않는다.
7. 설명은 3문장 이내. 전체 출력은 400자 이내.
8. 포맷 외의 머리말·맺음말·마크다운 기호를 쓰지 않는다.

출력 포맷:
{제목} ${TITLE_SEPARATOR} {분류}
무엇을 하는 곳: {활동 2~4개, 쉼표 구분}
실내/실외: {실내 | 실외 | 실내외 혼합}
추천 동반자: {가족 | 커플 | 친구 | 혼자 | 단체 중 해당하는 것, 쉼표 구분}
적정 소요시간: {1시간 이내 | 1~2시간 | 2~3시간 | 반나절 이상}
계절/날씨: {사계절 | 여름 성수기 | 봄 벚꽃철 | 비 오는 날에도 가능 | ...}
분위기: {짧은 구 하나}
설명: {3문장 이내}`;

/** overview에 실질 내용이 없으면 Gemini에 줄 재료가 없다. */
export function needsFallback(input: EnrichInput): boolean {
  return input.overview.trim() === "";
}

function joinNonEmpty(parts: string[], separator: string): string {
  return parts.filter((s) => s.trim() !== "").join(separator);
}

function classificationPath(input: EnrichInput): string {
  return joinNonEmpty([input.lcls1Nm, input.lcls2Nm, input.lcls3Nm], " > ");
}

/** 항목별 프롬프트를 만든다. 빈 값 줄은 생략해 무의미한 입력을 만들지 않는다. */
export function buildStructurePrompt(input: EnrichInput): string {
  const lines = [`제목: ${input.title}`];
  if (input.contentTypeNm.trim() !== "") lines.push(`관광타입: ${input.contentTypeNm}`);

  const path = classificationPath(input);
  if (path !== "") lines.push(`분류: ${path}`);

  const region = joinNonEmpty([input.regnNm, input.signguNm], " ");
  if (region !== "") lines.push(`지역: ${region}`);

  const address = joinNonEmpty([input.addr1, input.addr2], " ");
  if (address !== "") lines.push(`주소: ${address}`);

  lines.push("설명 원문:", input.overview);
  return lines.join("\n");
}

/**
 * overview가 없을 때 Gemini 없이 조립하는 최소 텍스트.
 *
 * 건너뛰면 그 관광지는 검색 대상에서 빠져 일정 추천에 영구히 등장하지 않는다.
 * 이름과 분류만으로도 검색 가치가 있다.
 * 고정 포맷이 아니므로 validateStructuredText의 대상이 아니다.
 */
export function buildMinimalText(input: EnrichInput): string {
  const head =
    input.contentTypeNm.trim() === ""
      ? input.title
      : `${input.title} ${TITLE_SEPARATOR} ${input.contentTypeNm}`;
  const path = classificationPath(input);
  return path === "" ? head : `${head}\n${path}`;
}

/**
 * Gemini 출력이 고정 포맷을 지켰는지 검증한다. 위반 시 throw — 구조화 실패로 분류된다.
 *
 * 검증이 없으면 포맷 위반을 아무도 모르고 색인 품질이 조용히 썩는다.
 * 100건 테스트에서 포맷 준수율을 측정하는 것이 이 함수의 1차 목적이다.
 */
export function validateStructuredText(text: string): void {
  if (text.trim() === "") {
    throw new Error("구조화 텍스트가 비어 있습니다.");
  }
  const missing = REQUIRED_LABELS.filter((label) => !text.includes(label));
  if (missing.length > 0) {
    throw new Error(`구조화 텍스트에 라벨이 없습니다: ${missing.join(", ")}`);
  }
  const firstLine = text.trimStart().split("\n")[0] ?? "";
  if (!firstLine.includes(TITLE_SEPARATOR)) {
    throw new Error(
      `구조화 텍스트 첫 줄에 '${TITLE_SEPARATOR}' 구분자가 없습니다: ${firstLine}`,
    );
  }
}
```

- [ ] **Step 4: 통과를 확인**

```
npm test -- tests/lib/structuredText.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add core/src/lib/structuredText.ts core/tests/lib/structuredText.test.ts
git commit -m "feat(core): Gemini 구조화 프롬프트·검증·최소 텍스트 폴백

규칙 3이 환각을 통제하고 규칙 5가 지역을 벡터에서 증폭하지 않게 한다.
overview가 빈 항목은 Gemini 없이 최소 텍스트를 조립한다 — 건너뛰면
그 관광지가 일정 추천에 영구히 등장하지 않는다."
```

---

### Task 6: `lib/qdrantCollection.ts` — 컬렉션 보장·point id·payload

**Files:**
- Create: `core/src/lib/qdrantCollection.ts`
- Test: `core/tests/lib/qdrantCollection.test.ts`

**Interfaces:**
- Consumes: `QdrantStore.getCollectionInfo` (Task 1), `EnrichInput` (Task 3)
- Produces:
  - `interface CollectionInfo { name: string; vectorSize: number }`
  - `ensureCollection(qdrant: QdrantStore, tei: TeiEmbeddingClient, name: string): Promise<CollectionInfo>`
  - `toPointId(contentid: string): number | null`
  - `toPayload(input: EnrichInput): Record<string, unknown>`

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/qdrantCollection.test.ts` 생성:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  ensureCollection,
  toPayload,
  toPointId,
} from "../../src/lib/qdrantCollection.js";
import type { QdrantStore } from "../../src/clients/qdrant.js";
import type { TeiEmbeddingClient } from "../../src/clients/tei.js";
import type { EnrichInput } from "../../src/lib/tourContentsTable.js";

function fakeQdrant(existing: { vectorSize: number } | null) {
  const getCollectionInfo = vi.fn().mockResolvedValue(existing);
  const createCollection = vi.fn().mockResolvedValue(undefined);
  const deleteCollection = vi.fn().mockResolvedValue(undefined);
  return {
    store: { getCollectionInfo, createCollection, deleteCollection } as unknown as QdrantStore,
    getCollectionInfo,
    createCollection,
    deleteCollection,
  };
}

function fakeTei(vectorSize: number) {
  const embed = vi.fn().mockResolvedValue([Array.from({ length: vectorSize }, () => 0.1)]);
  return { tei: { embed } as unknown as TeiEmbeddingClient, embed };
}

function input(overrides: Partial<EnrichInput> = {}): EnrichInput {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structuredText: null,
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
    ...overrides,
  };
}

describe("ensureCollection", () => {
  it("TEI를 1회 호출해 차원을 감지한다", async () => {
    const { store } = fakeQdrant({ vectorSize: 1024 });
    const { tei, embed } = fakeTei(1024);
    const info = await ensureCollection(store, tei, "tour_contents");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(info).toEqual({ name: "tour_contents", vectorSize: 1024 });
  });

  it("컬렉션이 없으면 감지한 차원으로 생성한다", async () => {
    const { store, createCollection } = fakeQdrant(null);
    const { tei } = fakeTei(1024);
    const info = await ensureCollection(store, tei, "tour_contents");
    expect(createCollection).toHaveBeenCalledWith("tour_contents", 1024);
    expect(info.vectorSize).toBe(1024);
  });

  it("기존 차원이 같으면 생성하지 않는다", async () => {
    const { store, createCollection } = fakeQdrant({ vectorSize: 1024 });
    const { tei } = fakeTei(1024);
    await ensureCollection(store, tei, "tour_contents");
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("기존 차원이 다르면 throw하고 컬렉션을 삭제하지 않는다", async () => {
    const { store, createCollection, deleteCollection } = fakeQdrant({ vectorSize: 768 });
    const { tei } = fakeTei(1024);
    await expect(ensureCollection(store, tei, "tour_contents")).rejects.toThrow("768");
    await expect(ensureCollection(store, tei, "tour_contents")).rejects.toThrow("1024");
    // 컬렉션을 날리는 것은 파괴적이고 되돌릴 수 없으므로 사람이 결정할 일이다.
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("TEI가 빈 벡터를 주면 throw", async () => {
    const { store } = fakeQdrant(null);
    const tei = { embed: vi.fn().mockResolvedValue([[]]) } as unknown as TeiEmbeddingClient;
    await expect(ensureCollection(store, tei, "c")).rejects.toThrow("차원");
  });
});

describe("toPointId", () => {
  it("숫자 문자열을 숫자로 바꾼다", () => {
    expect(toPointId("126508")).toBe(126508);
  });

  it("숫자가 아니면 null", () => {
    expect(toPointId("abc")).toBeNull();
    expect(toPointId("")).toBeNull();
    expect(toPointId("12.5")).toBeNull();
    expect(toPointId("-1")).toBeNull();
    expect(toPointId(" 12 ")).toBeNull();
  });

  it("안전 정수 범위를 넘으면 null", () => {
    expect(toPointId("99999999999999999999")).toBeNull();
  });
});

describe("toPayload", () => {
  it("필터 키와 최소 표시 필드만 담는다", () => {
    expect(toPayload(input())).toEqual({
      contentid: "126508",
      contenttypeid: "12",
      ldong_regn_cd: "11",
      ldong_signgu_cd: "110",
      lcls_systm1: "AC",
      lcls_systm2: "AC01",
      lcls_systm3: "AC010100",
      title: "경복궁",
      mapx: "126.9769",
      mapy: "37.5796",
    });
  });

  it("본문·이름 필드를 복제하지 않는다", () => {
    const keys = Object.keys(toPayload(input()));
    // Qdrant는 파생 인덱스다 — 원본 진실은 Postgres에 둔다.
    expect(keys).not.toContain("overview");
    expect(keys).not.toContain("structuredText");
    expect(keys).not.toContain("contentTypeNm");
    expect(keys).not.toContain("regnNm");
    expect(keys).not.toContain("addr1");
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/lib/qdrantCollection.test.ts
```

Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현**

`core/src/lib/qdrantCollection.ts` 생성:

```ts
import type { QdrantStore } from "../clients/qdrant.js";
import type { TeiEmbeddingClient } from "../clients/tei.js";
import type { EnrichInput } from "./tourContentsTable.js";

export interface CollectionInfo {
  name: string;
  vectorSize: number;
}

/** 차원 감지용 더미 입력. 저장되지 않으며 실제 데이터와 무관하다. */
const PROBE_TEXT = "차원 확인";

/**
 * TEI로 벡터 차원을 감지하고 컬렉션을 보장한다.
 *
 * 차원을 env에 하드코딩하지 않는 이유: TEI에 뜬 모델과 어긋나면 조용히 틀린 색인이
 * 만들어진다. 시작 시 1회 감지는 fail fast로 첫 항목 처리 전에 문제를 드러낸다.
 *
 * 기존 컬렉션 차원이 다르면 throw한다. 자동 삭제·재생성은 하지 않는다 —
 * 컬렉션을 날리는 것은 파괴적이고 되돌릴 수 없으므로 사람이 결정할 일이다.
 */
export async function ensureCollection(
  qdrant: QdrantStore,
  tei: TeiEmbeddingClient,
  name: string,
): Promise<CollectionInfo> {
  const probe = await tei.embed([PROBE_TEXT]);
  const vectorSize = probe[0]?.length ?? 0;
  if (vectorSize === 0) {
    throw new Error("TEI가 빈 벡터를 반환해 차원을 감지할 수 없습니다.");
  }

  const existing = await qdrant.getCollectionInfo(name);
  if (existing === null) {
    await qdrant.createCollection(name, vectorSize);
    return { name, vectorSize };
  }
  if (existing.vectorSize !== vectorSize) {
    throw new Error(
      `컬렉션 ${name}의 차원(${existing.vectorSize})이 TEI 모델의 차원(${vectorSize})과 다릅니다. ` +
        `임베딩 모델을 바꿨다면 컬렉션을 직접 삭제하거나 QDRANT_COLLECTION으로 다른 이름을 지정하세요.`,
    );
  }
  return { name, vectorSize };
}

/**
 * contentid를 Qdrant point id로 변환한다. 숫자가 아니면 null.
 *
 * Qdrant는 point id로 unsigned integer 또는 UUID만 허용한다. contentid 기반의
 * 결정론적 id라서 재실행이 같은 point를 덮어쓴다 — upsert 성공 후 markEmbedDone이
 * 실패해도 다음 실행이 중복 point를 만들지 않는다.
 */
export function toPointId(contentid: string): number | null {
  if (!/^\d+$/.test(contentid)) return null;
  const id = Number(contentid);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Qdrant payload. 필터 키와 최소 표시 필드만 담는다.
 * Postgres가 원본 진실이고 Qdrant는 파생 인덱스이므로 본문을 복제하지 않는다.
 */
export function toPayload(input: EnrichInput): Record<string, unknown> {
  return {
    contentid: input.contentid,
    contenttypeid: input.contenttypeid,
    ldong_regn_cd: input.ldongRegnCd,
    ldong_signgu_cd: input.ldongSignguCd,
    lcls_systm1: input.lclsSystm1,
    lcls_systm2: input.lclsSystm2,
    lcls_systm3: input.lclsSystm3,
    title: input.title,
    mapx: input.mapx,
    mapy: input.mapy,
  };
}
```

- [ ] **Step 4: 통과를 확인**

```
npm test -- tests/lib/qdrantCollection.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add core/src/lib/qdrantCollection.ts core/tests/lib/qdrantCollection.test.ts
git commit -m "feat(core): 컬렉션 차원 감지·point id·payload 변환

차원은 TEI 응답에서 감지한다 — env 하드코딩은 모델과 어긋나면 조용히
틀린다. 기존 차원 불일치는 throw하고 컬렉션을 삭제하지 않는다.
point id는 contentid 기반 결정론적 값이라 재실행이 덮어쓴다."
```

---

### Task 7: `services/enricher.ts` — 건당 체인과 차단기

계획의 핵심. Gemini → TEI → Qdrant 체인을 수행하고, **DB 쓰기 실패를 제외한 모든 실패를 내부에서 삼킨다.** 임베딩 실패로 예외를 던지면 상세 수집 루프가 죽어 소멸성 자원인 오늘의 TourAPI 예산이 낭비된다.

**Files:**
- Modify: `core/src/lib/logger.ts` (`warn` 추가)
- Create: `core/src/services/enricher.ts`
- Test: `core/tests/services/enricher.test.ts`

**Interfaces:**
- Consumes: `fetchEnrichInput` `markStructureDone` `markStructureFailure` `markEmbedDone` `markEmbedFailure` `EnrichInput` (Task 3·4), `STRUCTURE_SYSTEM_INSTRUCTION` `buildStructurePrompt` `buildMinimalText` `needsFallback` `validateStructuredText` (Task 5), `CollectionInfo` `toPointId` `toPayload` (Task 6)
- Produces:
  - `interface EnrichStats { structured: number; fallback: number; structureRetry: number; structureFailed: number; embedded: number; embedRetry: number; embedFailed: number; geminiRateLimited: number; disabled: boolean }`
  - `interface Enricher { enrich(contentid: string): Promise<void>; stats(): EnrichStats }`
  - `interface EnricherOptions { maxAttempts?: number; geminiRetries?: number; maxConsecutiveFailures?: number; sleep?: (ms: number) => Promise<void> }`
  - `createEnricher(gemini: GeminiClient, tei: TeiEmbeddingClient, qdrant: QdrantStore, pg: PostgresClient, collection: CollectionInfo, opts?: EnricherOptions): Enricher`
  - `isRateLimited(error: unknown): boolean`

- [ ] **Step 1: `logger.warn` 추가**

`core/src/lib/logger.ts`의 `info`와 `error` 사이에 추가:

```ts
  warn(message: string): void {
    console.warn(message);
  },
```

- [ ] **Step 2: 실패하는 테스트 작성**

`core/tests/services/enricher.test.ts` 생성:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEnricher, isRateLimited } from "../../src/services/enricher.js";
import type { GeminiClient } from "../../src/clients/gemini.js";
import type { TeiEmbeddingClient } from "../../src/clients/tei.js";
import type { QdrantStore } from "../../src/clients/qdrant.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
import type { EnrichInput } from "../../src/lib/tourContentsTable.js";
import * as table from "../../src/lib/tourContentsTable.js";
import { logger } from "../../src/lib/logger.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/tourContentsTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof table>();
  return {
    ...actual,
    fetchEnrichInput: vi.fn(),
    markStructureDone: vi.fn().mockResolvedValue(undefined),
    markStructureFailure: vi.fn().mockResolvedValue("pending"),
    markEmbedDone: vi.fn().mockResolvedValue(undefined),
    markEmbedFailure: vi.fn().mockResolvedValue("pending"),
  };
});

const mocked = vi.mocked(table);

/** 테스트 컬렉션은 4차원 — embed mock의 벡터 길이와 맞춘다. */
const COLLECTION = { name: "tour_contents", vectorSize: 4 };
const VECTOR = [0.1, 0.2, 0.3, 0.4];

function input(overrides: Partial<EnrichInput> = {}): EnrichInput {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structuredText: null,
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
    ...overrides,
  };
}

function validText(): string {
  return [
    "경복궁 — 고궁",
    "무엇을 하는 곳: 궁궐 관람, 수문장 교대식 관람",
    "실내/실외: 실내외 혼합",
    "추천 동반자: 가족, 커플, 혼자",
    "적정 소요시간: 1~2시간",
    "계절/날씨: 사계절",
    "분위기: 고요하고 정제된 역사 공간",
    "설명: 조선 왕조의 법궁이다.",
  ].join("\n");
}

function rateLimitError(): Error {
  return Object.assign(new Error("Resource has been exhausted"), { status: 429 });
}

function harness(overrides: {
  generate?: ReturnType<typeof vi.fn>;
  embed?: ReturnType<typeof vi.fn>;
  upsert?: ReturnType<typeof vi.fn>;
  opts?: Parameters<typeof createEnricher>[5];
} = {}) {
  const generate = overrides.generate ?? vi.fn().mockResolvedValue(validText());
  const embed = overrides.embed ?? vi.fn().mockResolvedValue([VECTOR]);
  const upsert = overrides.upsert ?? vi.fn().mockResolvedValue(undefined);
  const pg = {} as PostgresClient;
  const enricher = createEnricher(
    { generate } as unknown as GeminiClient,
    { embed } as unknown as TeiEmbeddingClient,
    { upsert } as unknown as QdrantStore,
    pg,
    COLLECTION,
    { sleep: async () => {}, ...overrides.opts },
  );
  return { enricher, generate, embed, upsert, pg };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchEnrichInput.mockResolvedValue(input());
  mocked.markStructureDone.mockResolvedValue(undefined);
  mocked.markStructureFailure.mockResolvedValue("pending");
  mocked.markEmbedDone.mockResolvedValue(undefined);
  mocked.markEmbedFailure.mockResolvedValue("pending");
});

describe("isRateLimited", () => {
  it("status·code 429와 메시지 패턴을 판별한다", () => {
    expect(isRateLimited(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRateLimited(Object.assign(new Error("x"), { code: 429 }))).toBe(true);
    expect(isRateLimited(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRateLimited(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isRateLimited(new Error("Quota exceeded for model"))).toBe(true);
  });

  it("그 외 오류는 false", () => {
    expect(isRateLimited(new Error("ECONNRESET"))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
    expect(isRateLimited("문자열")).toBe(false);
  });
});

describe("createEnricher 정상 경로", () => {
  it("Gemini → 구조화 저장 → 임베딩 → upsert → 임베딩 저장 순으로 수행한다", async () => {
    const { enricher, generate, embed, upsert, pg } = harness();
    await enricher.enrich("126508");

    expect(generate).toHaveBeenCalledOnce();
    expect(mocked.markStructureDone).toHaveBeenCalledWith(pg, "126508", validText());
    expect(embed).toHaveBeenCalledWith([validText()]);
    expect(upsert).toHaveBeenCalledWith("tour_contents", [
      {
        id: 126508,
        vector: VECTOR,
        payload: expect.objectContaining({ contentid: "126508", title: "경복궁" }),
      },
    ]);
    expect(mocked.markEmbedDone).toHaveBeenCalledWith(pg, "126508");
    expect(enricher.stats()).toMatchObject({ structured: 1, embedded: 1, fallback: 0 });
  });

  it("Gemini에 systemInstruction과 temperature 0을 넘긴다", async () => {
    const { enricher, generate } = harness();
    await enricher.enrich("126508");
    expect(generate).toHaveBeenCalledWith(
      expect.stringContaining("제목: 경복궁"),
      expect.objectContaining({
        temperature: 0,
        systemInstruction: expect.stringContaining("무엇을 하는 곳:"),
      }),
    );
  });

  it("structuredText가 이미 있으면 Gemini를 호출하지 않고 임베딩만 한다", async () => {
    mocked.fetchEnrichInput.mockResolvedValue(input({ structuredText: "기존 텍스트" }));
    const { enricher, generate, embed } = harness();
    await enricher.enrich("126508");
    expect(generate).not.toHaveBeenCalled();
    expect(mocked.markStructureDone).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledWith(["기존 텍스트"]);
    expect(enricher.stats()).toMatchObject({ structured: 0, embedded: 1 });
  });

  it("overview가 비면 Gemini 없이 최소 텍스트로 임베딩한다", async () => {
    mocked.fetchEnrichInput.mockResolvedValue(input({ overview: "   " }));
    const { enricher, generate, embed, pg } = harness();
    await enricher.enrich("126508");
    expect(generate).not.toHaveBeenCalled();
    const minimal = "경복궁 — 관광지\n인문(문화/예술/역사) > 역사관광지 > 고궁";
    expect(mocked.markStructureDone).toHaveBeenCalledWith(pg, "126508", minimal);
    expect(embed).toHaveBeenCalledWith([minimal]);
    expect(enricher.stats()).toMatchObject({ fallback: 1, structured: 1, embedded: 1 });
  });

  it("행이 없으면 경고만 남기고 아무 것도 하지 않는다", async () => {
    mocked.fetchEnrichInput.mockResolvedValue(null);
    const { enricher, generate, embed } = harness();
    await enricher.enrich("없음");
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("없음"));
  });
});

describe("createEnricher Gemini 실패", () => {
  it("429는 백오프 후 재시도하고, 성공하면 정상 진행한다", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce(validText());
    const { enricher } = harness({ generate });
    await enricher.enrich("126508");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(enricher.stats()).toMatchObject({ structured: 1, embedded: 1, geminiRateLimited: 0 });
  });

  it("429가 재시도를 소진하면 상태·시도횟수를 건드리지 않고 임베딩도 건너뛴다", async () => {
    // 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이다. attempt를 올리면
    // 매일 한도 경계의 항목이 실패를 누적해 멀쩡한 데이터가 영구 제외된다.
    const generate = vi.fn().mockRejectedValue(rateLimitError());
    const { enricher, embed } = harness({ generate, opts: { geminiRetries: 2 } });
    await enricher.enrich("126508");
    expect(generate).toHaveBeenCalledTimes(3); // 최초 1 + 재시도 2
    expect(mocked.markStructureFailure).not.toHaveBeenCalled();
    expect(mocked.markStructureDone).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(enricher.stats()).toMatchObject({ geminiRateLimited: 1, structured: 0, embedded: 0 });
  });

  it("기타 오류는 실패로 기록하되 throw하지 않는다", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("500 Internal"));
    const { enricher, embed, pg } = harness({ generate });
    await expect(enricher.enrich("126508")).resolves.toBeUndefined();
    expect(mocked.markStructureFailure).toHaveBeenCalledWith(pg, "126508", "500 Internal", 3);
    expect(embed).not.toHaveBeenCalled();
    expect(enricher.stats()).toMatchObject({ structureRetry: 1, structureFailed: 0 });
  });

  it("maxAttempts 도달로 failed 전이되면 failed로 집계한다", async () => {
    mocked.markStructureFailure.mockResolvedValue("failed");
    const generate = vi.fn().mockRejectedValue(new Error("500 Internal"));
    const { enricher } = harness({ generate });
    await enricher.enrich("126508");
    expect(enricher.stats()).toMatchObject({ structureFailed: 1, structureRetry: 0 });
  });

  it("포맷 검증 실패는 구조화 실패로 분류하고 저장하지 않는다", async () => {
    const generate = vi.fn().mockResolvedValue("라벨 없는 자유 텍스트");
    const { enricher, embed } = harness({ generate });
    await enricher.enrich("126508");
    expect(mocked.markStructureDone).not.toHaveBeenCalled();
    expect(mocked.markStructureFailure).toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("연속 10회 실패하면 스스로를 끄고 이후 호출을 no-op으로 만든다", async () => {
    // 시스템 장애(키 만료·네트워크 단절)가 개별 항목 오류로 위장해 들어오면
    // claim한 전량에 실패가 기록된다. 손상을 10건으로 묶는다.
    const generate = vi.fn().mockRejectedValue(new Error("API key expired"));
    const { enricher, embed } = harness({ generate });
    for (let i = 0; i < 15; i += 1) {
      await enricher.enrich(String(i));
    }
    expect(generate).toHaveBeenCalledTimes(10);
    expect(mocked.markStructureFailure).toHaveBeenCalledTimes(10);
    expect(embed).not.toHaveBeenCalled();
    expect(enricher.stats().disabled).toBe(true);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining("연속"));
  });

  it("성공은 연속 실패 카운터를 초기화한다", async () => {
    const generate = vi.fn(async (prompt: string) => {
      if (prompt.includes("성공")) return validText();
      throw new Error("500 Internal");
    });
    const { enricher } = harness({ generate });
    // 실패 9 → 성공 1 → 실패 9: 연속 10회에 도달하지 않아 19회 모두 호출된다.
    for (let i = 0; i < 19; i += 1) {
      mocked.fetchEnrichInput.mockResolvedValue(
        input({ title: i === 9 ? "성공" : `실패${i}` }),
      );
      await enricher.enrich(String(i));
    }
    expect(generate).toHaveBeenCalledTimes(19);
    expect(enricher.stats().disabled).toBe(false);
  });
});

describe("createEnricher 임베딩 실패", () => {
  it("TEI 실패는 임베딩 실패로 기록하고 upsert하지 않는다", async () => {
    const embed = vi.fn().mockRejectedValue(new Error("TEI 502"));
    const { enricher, upsert, pg } = harness({ embed });
    await expect(enricher.enrich("126508")).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(pg, "126508", "TEI 502", 3);
    expect(mocked.markEmbedDone).not.toHaveBeenCalled();
    // 구조화는 이미 커밋됐으므로 다음 실행이 Gemini를 다시 태우지 않는다.
    expect(mocked.markStructureDone).toHaveBeenCalled();
  });

  it("Qdrant 실패는 임베딩 실패로 기록하고 done을 쓰지 않는다", async () => {
    const upsert = vi.fn().mockRejectedValue(new Error("Qdrant 503"));
    const { enricher, pg } = harness({ upsert });
    await enricher.enrich("126508");
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(pg, "126508", "Qdrant 503", 3);
    expect(mocked.markEmbedDone).not.toHaveBeenCalled();
  });

  it("차원이 다른 벡터가 오면 임베딩 실패로 기록한다", async () => {
    const embed = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const { enricher, upsert } = harness({ embed });
    await enricher.enrich("126508");
    expect(upsert).not.toHaveBeenCalled();
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(
      expect.anything(),
      "126508",
      expect.stringContaining("차원"),
      3,
    );
  });

  it("contentid가 숫자가 아니면 즉시 failed로 종결하고 upsert하지 않는다", async () => {
    // 숫자가 아닌 contentid는 재시도해도 절대 숫자가 되지 않으므로 maxAttempts=1로 종결한다.
    mocked.fetchEnrichInput.mockResolvedValue(input({ contentid: "ABC-1" }));
    mocked.markEmbedFailure.mockResolvedValue("failed");
    const { enricher, upsert, embed } = harness();
    await enricher.enrich("ABC-1");
    expect(embed).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(
      expect.anything(),
      "ABC-1",
      expect.stringContaining("숫자"),
      1,
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    expect(enricher.stats()).toMatchObject({ embedFailed: 1, embedded: 0 });
  });
});

describe("createEnricher DB 쓰기 실패", () => {
  it("markStructureDone 실패는 실패로 세지 않고 전파한다", async () => {
    mocked.markStructureDone.mockRejectedValue(new Error("DB 쓰기 실패"));
    const { enricher } = harness();
    await expect(enricher.enrich("126508")).rejects.toThrow("DB 쓰기 실패");
    expect(mocked.markStructureFailure).not.toHaveBeenCalled();
  });

  it("markEmbedDone 실패는 전파한다", async () => {
    mocked.markEmbedDone.mockRejectedValue(new Error("DB 쓰기 실패"));
    const { enricher } = harness();
    await expect(enricher.enrich("126508")).rejects.toThrow("DB 쓰기 실패");
    expect(mocked.markEmbedFailure).not.toHaveBeenCalled();
  });
});

describe("stats", () => {
  it("스냅샷을 반환해 외부에서 변형할 수 없다", async () => {
    const { enricher } = harness();
    await enricher.enrich("126508");
    const snapshot = enricher.stats();
    snapshot.embedded = 999;
    expect(enricher.stats().embedded).toBe(1);
  });
});
```

- [ ] **Step 3: 실패를 확인**

```
npm test -- tests/services/enricher.test.ts
```

Expected: FAIL — `../../src/services/enricher.js` 모듈을 찾을 수 없음

- [ ] **Step 4: 구현**

`core/src/services/enricher.ts` 생성:

```ts
import type { GeminiClient } from "../clients/gemini.js";
import type { TeiEmbeddingClient } from "../clients/tei.js";
import type { QdrantStore } from "../clients/qdrant.js";
import type { PostgresClient } from "../clients/postgres.js";
import type { CollectionInfo } from "../lib/qdrantCollection.js";
import type { EnrichInput } from "../lib/tourContentsTable.js";
import { toPayload, toPointId } from "../lib/qdrantCollection.js";
import {
  fetchEnrichInput,
  markEmbedDone,
  markEmbedFailure,
  markStructureDone,
  markStructureFailure,
} from "../lib/tourContentsTable.js";
import {
  STRUCTURE_SYSTEM_INSTRUCTION,
  buildMinimalText,
  buildStructurePrompt,
  needsFallback,
  validateStructuredText,
} from "../lib/structuredText.js";
import { logger } from "../lib/logger.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_GEMINI_RETRIES = 3;
/** 연속 실패가 이 횟수에 이르면 개별 항목 문제가 아니라 시스템 장애로 본다. */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;
const RETRY_BASE_DELAY_MS = 2000;

export interface EnrichStats {
  /** 이번 실행에서 새로 구조화한 건수 (폴백 포함). 기존 텍스트 재사용은 세지 않는다. */
  structured: number;
  /** overview가 비어 Gemini 없이 최소 텍스트로 처리한 건수. */
  fallback: number;
  structureRetry: number;
  structureFailed: number;
  embedded: number;
  embedRetry: number;
  embedFailed: number;
  /** Gemini 한도로 구조화를 건너뛴 건수. 상태·시도횟수는 변경하지 않았다. */
  geminiRateLimited: number;
  /** 연속 실패 차단기가 작동해 스스로를 끈 상태. */
  disabled: boolean;
}

export interface Enricher {
  /** 상세 저장 직후 구조화·임베딩 체인을 수행한다. DB 쓰기 실패만 throw한다. */
  enrich(contentid: string): Promise<void>;
  stats(): EnrichStats;
}

export interface EnricherOptions {
  maxAttempts?: number;
  /** 429 백오프 재시도 횟수. 기본 3 (2s → 4s → 8s). */
  geminiRetries?: number;
  maxConsecutiveFailures?: number;
  /** 테스트에서 대기 없이 돌리기 위한 주입점. */
  sleep?: (ms: number) => Promise<void>;
}

function readProp(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

/**
 * Gemini 오류가 rate limit인지 판별한다.
 * SDK가 status를 노출하지 않는 경우가 있어 메시지 패턴도 함께 본다
 * (Gemini는 한도 초과를 RESOURCE_EXHAUSTED / Quota exceeded로 알린다).
 */
export function isRateLimited(error: unknown): boolean {
  if (readProp(error, "status") === 429) return true;
  if (readProp(error, "code") === 429) return true;
  const message = error instanceof Error ? error.message : "";
  return /429|rate limit|RESOURCE_EXHAUSTED|quota/i.test(message);
}

export function createEnricher(
  gemini: GeminiClient,
  tei: TeiEmbeddingClient,
  qdrant: QdrantStore,
  pg: PostgresClient,
  collection: CollectionInfo,
  opts: EnricherOptions = {},
): Enricher {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const geminiRetries = opts.geminiRetries ?? DEFAULT_GEMINI_RETRIES;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const stats: EnrichStats = {
    structured: 0,
    fallback: 0,
    structureRetry: 0,
    structureFailed: 0,
    embedded: 0,
    embedRetry: 0,
    embedFailed: 0,
    geminiRateLimited: 0,
    disabled: false,
  };
  let consecutiveFailures = 0;

  /** 429면 지수 백오프로 재시도한다. 소진하면 원래 오류를 그대로 던진다. */
  async function callGemini(prompt: string): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await gemini.generate(prompt, {
          systemInstruction: STRUCTURE_SYSTEM_INSTRUCTION,
          temperature: 0,
        });
      } catch (error) {
        if (!isRateLimited(error) || attempt >= geminiRetries) throw error;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }

  /**
   * 구조화 텍스트를 확보한다.
   * null 반환 = 이번 실행에서 확보하지 못했다(상태는 이미 기록했거나 의도적으로 건드리지 않았다).
   */
  async function ensureStructuredText(input: EnrichInput): Promise<string | null> {
    if (input.structuredText !== null && input.structuredText !== "") {
      return input.structuredText; // 이미 구조화됨 — Gemini 재호출 없음
    }

    if (needsFallback(input)) {
      // 고정 포맷이 아니므로 validateStructuredText를 적용하지 않는다.
      const text = buildMinimalText(input);
      await markStructureDone(pg, input.contentid, text);
      stats.fallback += 1;
      stats.structured += 1;
      consecutiveFailures = 0;
      return text;
    }

    let text: string;
    try {
      // try는 외부 호출만 감싼다 — DB 쓰기 실패를 데이터 문제로 오분류하지 않기 위해.
      text = await callGemini(buildStructurePrompt(input));
      validateStructuredText(text);
    } catch (error) {
      if (isRateLimited(error)) {
        // 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이다. 항목에 책임을 묻지 않는다.
        stats.geminiRateLimited += 1;
        logger.error(
          `Gemini 한도 초과로 구조화를 건너뜁니다 (contentid=${input.contentid}). ` +
            `상세 수집은 계속됩니다.`,
        );
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`구조화 실패 (contentid=${input.contentid}): ${message}`);
      const status = await markStructureFailure(pg, input.contentid, message, maxAttempts);
      if (status === "failed") stats.structureFailed += 1;
      else stats.structureRetry += 1;
      consecutiveFailures += 1;
      return null;
    }

    await markStructureDone(pg, input.contentid, text);
    stats.structured += 1;
    consecutiveFailures = 0;
    return text;
  }

  async function embedAndUpsert(input: EnrichInput, text: string): Promise<void> {
    const pointId = toPointId(input.contentid);
    if (pointId === null) {
      // 재시도해도 숫자가 되지 않으므로 maxAttempts=1로 즉시 종결한다.
      const message = `contentid가 숫자가 아니어서 Qdrant point id로 쓸 수 없습니다: ${input.contentid}`;
      logger.warn(message);
      await markEmbedFailure(pg, input.contentid, message, 1);
      stats.embedFailed += 1;
      return;
    }

    try {
      const vectors = await tei.embed([text]);
      const vector = vectors[0];
      if (vector === undefined || vector.length !== collection.vectorSize) {
        throw new Error(
          `TEI가 예상 차원(${collection.vectorSize})과 다른 벡터를 반환했습니다: ${vector?.length ?? 0}`,
        );
      }
      await qdrant.upsert(collection.name, [
        { id: pointId, vector, payload: toPayload(input) },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`임베딩 실패 (contentid=${input.contentid}): ${message}`);
      const status = await markEmbedFailure(pg, input.contentid, message, maxAttempts);
      if (status === "failed") stats.embedFailed += 1;
      else stats.embedRetry += 1;
      return;
    }

    await markEmbedDone(pg, input.contentid);
    stats.embedded += 1;
  }

  return {
    async enrich(contentid: string): Promise<void> {
      if (stats.disabled) return;

      const input = await fetchEnrichInput(pg, contentid);
      if (input === null) {
        logger.warn(`구조화 대상 행을 찾을 수 없습니다 (contentid=${contentid})`);
        return;
      }

      const text = await ensureStructuredText(input);
      if (text !== null) {
        await embedAndUpsert(input, text);
      }

      if (consecutiveFailures >= maxConsecutiveFailures) {
        stats.disabled = true;
        logger.error(
          `구조화 연속 ${consecutiveFailures}회 실패로 임베딩을 중단합니다. ` +
            `GEMINI_API_KEY와 네트워크를 확인하세요. 상세 수집은 계속됩니다.`,
        );
      }
    },
    stats(): EnrichStats {
      return { ...stats };
    },
  };
}
```

- [ ] **Step 5: 통과를 확인**

```
npm test -- tests/services/enricher.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add core/src/lib/logger.ts core/src/services/enricher.ts core/tests/services/enricher.test.ts
git commit -m "feat(core): enricher — 건당 Gemini→TEI→Qdrant 체인과 차단기

DB 쓰기 실패를 제외한 모든 실패를 내부에서 삼킨다. 임베딩 실패로 예외를
던지면 상세 수집 루프가 죽어 소멸성 자원인 TourAPI 예산이 낭비된다.

- Gemini 429: 백오프 재시도 → 소진 시 상태·시도횟수 무변경 (함정 1)
- 연속 10회 실패: 스스로를 비활성화, 상세 수집은 계속 (함정 4)
- try는 외부 호출만 감쌈 (함정 5)"
```

---

### Task 8: `services/enrichBacklog.ts` — 백로그 순회

**Files:**
- Create: `core/src/services/enrichBacklog.ts`
- Test: `core/tests/services/enrichBacklog.test.ts`

**Interfaces:**
- Consumes: `createTourContentsTable` `claimStructurePending` `claimEmbedPending` (Task 2·4), `Enricher` `EnrichStats` (Task 7)
- Produces:
  - `interface EnrichBacklogResult { processed: number; stats: EnrichStats }`
  - `enrichBacklog(pg: PostgresClient, enricher: Enricher, limit: number): Promise<EnrichBacklogResult>`

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/services/enrichBacklog.test.ts` 생성:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { enrichBacklog } from "../../src/services/enrichBacklog.js";
import type { Enricher, EnrichStats } from "../../src/services/enricher.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
import * as table from "../../src/lib/tourContentsTable.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/tourContentsTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof table>();
  return {
    ...actual,
    createTourContentsTable: vi.fn().mockResolvedValue(undefined),
    claimStructurePending: vi.fn().mockResolvedValue([]),
    claimEmbedPending: vi.fn().mockResolvedValue([]),
  };
});

const mocked = vi.mocked(table);

const EMPTY_STATS: EnrichStats = {
  structured: 0,
  fallback: 0,
  structureRetry: 0,
  structureFailed: 0,
  embedded: 0,
  embedRetry: 0,
  embedFailed: 0,
  geminiRateLimited: 0,
  disabled: false,
};

function fakePg() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  return {
    transaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as PostgresClient;
}

function fakeEnricher() {
  const enrich = vi.fn().mockResolvedValue(undefined);
  return { enricher: { enrich, stats: () => EMPTY_STATS } as Enricher, enrich };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createTourContentsTable.mockResolvedValue(undefined);
  mocked.claimStructurePending.mockResolvedValue([]);
  mocked.claimEmbedPending.mockResolvedValue([]);
});

describe("enrichBacklog", () => {
  it("컬럼이 없을 수 있으므로 테이블 DDL을 먼저 멱등 실행한다", async () => {
    // collect-detail 경로를 건너뛰면 createTourContentsTable이 호출되지 않아
    // ALTER로 추가한 컬럼이 없는 상태에서 claim 쿼리가 실패한다.
    const pg = fakePg();
    const { enricher } = fakeEnricher();
    await enrichBacklog(pg, enricher, 100);
    expect(mocked.createTourContentsTable).toHaveBeenCalledOnce();
    expect(vi.mocked(pg.transaction)).toHaveBeenCalledOnce();
  });

  it("두 대기 목록을 합쳐 중복 없이 순회한다", async () => {
    mocked.claimStructurePending.mockResolvedValue(["1", "2"]);
    mocked.claimEmbedPending.mockResolvedValue(["2", "3"]);
    const { enricher, enrich } = fakeEnricher();
    const result = await enrichBacklog(fakePg(), enricher, 100);
    expect(enrich.mock.calls.map((c) => c[0])).toEqual(["1", "2", "3"]);
    expect(result.processed).toBe(3);
  });

  it("limit을 넘지 않는다", async () => {
    mocked.claimStructurePending.mockResolvedValue(["1", "2"]);
    mocked.claimEmbedPending.mockResolvedValue(["3", "4"]);
    const { enricher, enrich } = fakeEnricher();
    const result = await enrichBacklog(fakePg(), enricher, 3);
    expect(enrich).toHaveBeenCalledTimes(3);
    expect(result.processed).toBe(3);
  });

  it("limit을 두 claim 쿼리에 그대로 넘긴다", async () => {
    const pg = fakePg();
    const { enricher } = fakeEnricher();
    await enrichBacklog(pg, enricher, 42);
    expect(mocked.claimStructurePending).toHaveBeenCalledWith(pg, 42);
    expect(mocked.claimEmbedPending).toHaveBeenCalledWith(pg, 42);
  });

  it("대상이 없으면 enrich를 호출하지 않는다", async () => {
    const { enricher, enrich } = fakeEnricher();
    const result = await enrichBacklog(fakePg(), enricher, 100);
    expect(enrich).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it("enricher의 최종 stats를 반환한다", async () => {
    mocked.claimStructurePending.mockResolvedValue(["1"]);
    const enrich = vi.fn().mockResolvedValue(undefined);
    const stats: EnrichStats = { ...EMPTY_STATS, structured: 1, embedded: 1 };
    const enricher = { enrich, stats: () => stats } as Enricher;
    const result = await enrichBacklog(fakePg(), enricher, 100);
    expect(result.stats).toEqual(stats);
  });

  it("enrich가 throw하면 전파한다", async () => {
    mocked.claimStructurePending.mockResolvedValue(["1", "2"]);
    const enrich = vi.fn().mockRejectedValue(new Error("DB 쓰기 실패"));
    const enricher = { enrich, stats: () => EMPTY_STATS } as Enricher;
    await expect(enrichBacklog(fakePg(), enricher, 100)).rejects.toThrow("DB 쓰기 실패");
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/services/enrichBacklog.test.ts
```

Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: 구현**

`core/src/services/enrichBacklog.ts` 생성:

```ts
import type { PostgresClient } from "../clients/postgres.js";
import type { Enricher, EnrichStats } from "./enricher.js";
import {
  claimEmbedPending,
  claimStructurePending,
  createTourContentsTable,
} from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";

export interface EnrichBacklogResult {
  processed: number;
  stats: EnrichStats;
}

/**
 * 이미 상세를 받아둔 항목의 구조화·임베딩 백로그를 처리한다.
 *
 * 조회 조건이 detail_status='done'이라 nodata·failed는 자동으로 제외된다.
 * 재개는 상태 조회만으로 성립하므로 별도 커서가 없다.
 */
export async function enrichBacklog(
  pg: PostgresClient,
  enricher: Enricher,
  limit: number,
): Promise<EnrichBacklogResult> {
  // 상세 수집 경로를 건너뛰면 이 함수가 유일한 DDL 실행 지점이다 —
  // 없으면 ALTER로 추가한 컬럼이 없는 상태에서 claim 쿼리가 실패한다.
  await pg.transaction((client) => createTourContentsTable(client));

  const structurePending = await claimStructurePending(pg, limit);
  const embedPending = await claimEmbedPending(pg, limit);

  // 두 목록은 structure_status가 배타적이라 겹치지 않아야 정상이지만,
  // 겹쳐 들어오면 같은 항목을 두 번 처리해 Gemini 쿼터를 낭비한다.
  // 구조화 대기가 먼저 오므로 예산이 부족하면 구조화가 우선된다.
  const targets = [...new Set([...structurePending, ...embedPending])].slice(0, limit);

  logger.info(
    `백로그 — 구조화대기 ${structurePending.length} / 임베딩대기 ${embedPending.length}, ` +
      `이번 실행 ${targets.length}건`,
  );

  let processed = 0;
  for (const contentid of targets) {
    await enricher.enrich(contentid);
    processed += 1;
  }
  return { processed, stats: enricher.stats() };
}
```

- [ ] **Step 4: 통과를 확인**

```
npm test -- tests/services/enrichBacklog.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add core/src/services/enrichBacklog.ts core/tests/services/enrichBacklog.test.ts
git commit -m "feat(core): enrichBacklog — 구조화·임베딩 백로그 순회

상세 수집을 건너뛰는 경로에서는 이 함수가 유일한 DDL 실행 지점이므로
createTourContentsTable을 먼저 호출한다. 두 대기 목록을 합쳐 중복 없이
순회하며 예산이 부족하면 구조화를 우선한다."
```

---

### Task 9: `collectDetail`에 enricher 훅 추가

**Files:**
- Modify: `core/src/services/collectDetail.ts`
- Test: `core/tests/services/collectDetail.test.ts`

**Interfaces:**
- Consumes: `Enricher` `EnrichStats` (Task 7)
- Produces: `collectDetail(tourApi, pg, opts?, enricher?)` — 4번째 인자 추가. `CollectDetailResult`에 `enrichStats?: EnrichStats` 추가.

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/services/collectDetail.test.ts`의 import에 추가:

```ts
import type { Enricher, EnrichStats } from "../../src/services/enricher.js";
```

파일 맨 끝(`describe("collectDetail", ...)` 블록 **안**, 마지막 `it` 다음)에 추가:

```ts
  const EMPTY_STATS: EnrichStats = {
    structured: 0,
    fallback: 0,
    structureRetry: 0,
    structureFailed: 0,
    embedded: 0,
    embedRetry: 0,
    embedFailed: 0,
    geminiRateLimited: 0,
    disabled: false,
  };

  function fakeEnricher(stats: EnrichStats = EMPTY_STATS) {
    const enrich = vi.fn().mockResolvedValue(undefined);
    return { enricher: { enrich, stats: () => stats } as Enricher, enrich };
  }

  it("상세 저장 직후 enrich를 호출한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const getDetailCommon = vi.fn(async (id: string) => ({ contentid: id, overview: "x" }));
    const { enricher, enrich } = fakeEnricher();
    await collectDetail(fakeApi(getDetailCommon), fakePg(), {}, enricher);
    expect(enrich.mock.calls.map((c) => c[0])).toEqual(["1", "2"]);
  });

  it("markDetailDone이 커밋된 뒤에 enrich를 호출한다", async () => {
    // 커밋 순서가 뒤바뀌면 enrich 실패가 이미 소비한 TourAPI 쿼터를 날린다.
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const order: string[] = [];
    mocked.markDetailDone.mockImplementation(async () => {
      order.push("markDetailDone");
    });
    const enrich = vi.fn(async () => {
      order.push("enrich");
    });
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1", overview: "x" });
    await collectDetail(fakeApi(getDetailCommon), fakePg(), {}, {
      enrich,
      stats: () => EMPTY_STATS,
    } as Enricher);
    expect(order).toEqual(["markDetailDone", "enrich"]);
  });

  it("NODATA 항목에는 enrich를 호출하지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["999"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new TourApiError("03", "NODATA_ERROR"));
    const { enricher, enrich } = fakeEnricher();
    await collectDetail(fakeApi(getDetailCommon), fakePg(), {}, enricher);
    expect(enrich).not.toHaveBeenCalled();
  });

  it("한도 초과로 중단되면 enrich를 호출하지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new TourApiError("22", "LIMITED"));
    const { enricher, enrich } = fakeEnricher();
    await collectDetail(fakeApi(getDetailCommon), fakePg(), {}, enricher);
    expect(enrich).not.toHaveBeenCalled();
  });

  it("일반 오류 항목에는 enrich를 호출하지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { enricher, enrich } = fakeEnricher();
    await collectDetail(fakeApi(getDetailCommon), fakePg(), {}, enricher);
    expect(enrich).not.toHaveBeenCalled();
  });

  it("enricher의 stats를 결과에 담는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const stats: EnrichStats = { ...EMPTY_STATS, structured: 1, embedded: 1 };
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1", overview: "x" });
    const { enricher } = fakeEnricher(stats);
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg(), {}, enricher);
    expect(result.enrichStats).toEqual(stats);
  });

  it("enricher를 넘기지 않으면 enrichStats가 undefined다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1", overview: "x" });
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(result.enrichStats).toBeUndefined();
  });

  it("enrich가 throw하면 전파해 실행을 중단한다", async () => {
    // enricher는 DB 쓰기 실패만 던진다. DB가 죽었으면 계속할 수 없다.
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const enrich = vi.fn().mockRejectedValue(new Error("DB 쓰기 실패"));
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1", overview: "x" });
    await expect(
      collectDetail(fakeApi(getDetailCommon), fakePg(), {}, {
        enrich,
        stats: () => EMPTY_STATS,
      } as Enricher),
    ).rejects.toThrow("DB 쓰기 실패");
    expect(getDetailCommon).toHaveBeenCalledTimes(1);
  });
```

`beforeEach`에 `markDetailDone` 재설정이 이미 있으므로, 위 순서 테스트가 `mockImplementation`으로 덮어써도 다음 테스트에 영향을 주지 않는다.

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/services/collectDetail.test.ts
```

Expected: FAIL — `enrich`가 호출되지 않음 / `enrichStats`가 없음

- [ ] **Step 3: 구현**

`core/src/services/collectDetail.ts`를 세 곳 수정한다.

(1) import 추가 (파일 상단, 기존 import 다음):

```ts
import type { Enricher, EnrichStats } from "./enricher.js";
```

(2) `CollectDetailResult`에 필드 추가 (`remainingPending` 다음):

```ts
  /** enricher를 넘긴 경우의 구조화·임베딩 집계. */
  enrichStats?: EnrichStats;
```

(3) 함수 시그니처에 4번째 인자 추가:

```ts
export async function collectDetail(
  tourApi: TourApiClient,
  pg: PostgresClient,
  opts: CollectDetailOptions = {},
  enricher?: Enricher,
): Promise<CollectDetailResult> {
```

(4) 루프 안, `markDetailDone` 블록에 한 줄 추가. 기존 코드

```ts
    await markDetailDone(pg, contentid, detail.overview ?? "");
    done += 1;
    consecutiveFailures = 0;
    processed += 1;
  }
```

를 아래로 교체:

```ts
    await markDetailDone(pg, contentid, detail.overview ?? "");
    done += 1;
    consecutiveFailures = 0;
    processed += 1;

    // 상세 저장을 커밋한 뒤에 구조화·임베딩을 수행한다 — 이 시점에 TourAPI 호출은
    // 이미 영구 보존됐으므로 아래에서 무엇이 실패해도 소비한 쿼터를 잃지 않는다.
    // enricher는 DB 쓰기 실패만 던지며, 그 경우 계속할 수 없으니 전파한다.
    await enricher?.enrich(contentid);
  }
```

(5) 반환문에 필드 추가:

```ts
  return {
    processed,
    done,
    nodata,
    retryScheduled,
    failed,
    stoppedBy,
    remainingPending: after.pending,
    enrichStats: enricher?.stats(),
  };
```

- [ ] **Step 4: 통과를 확인**

```
npm test -- tests/services/collectDetail.test.ts
npm run typecheck
```

Expected: PASS — 기존 테스트 전부 포함 (enricher를 넘기지 않으면 동작이 완전히 동일하다)

- [ ] **Step 5: 커밋**

```bash
git add core/src/services/collectDetail.ts core/tests/services/collectDetail.test.ts
git commit -m "feat(core): collectDetail에 옵셔널 enricher 훅 추가

markDetailDone이 커밋된 뒤에 enrich를 호출한다 — 그 시점에 TourAPI
호출은 이미 영구 보존됐으므로 이후 실패는 전부 복구 가능하다.
enricher를 넘기지 않으면 동작이 완전히 동일해 --skip-embed가 공짜로
구현된다."
```

---

### Task 10: CLI 배선 — 플래그 2개, 클라이언트 조건부 생성, 요약 확장

**Files:**
- Modify: `core/src/commands/collectDetail.ts`
- Modify: `core/.env.example`
- Test: `core/tests/commands/collectDetail.test.ts`

**Interfaces:**
- Consumes: 앞선 모든 태스크
- Produces:
  - `assertSkipFlags(skipDetail: boolean, skipEmbed: boolean): void`
  - `formatEnrichSummary(stats: EnrichStats): string`
  - `formatStageBacklog(counts: StageCounts): string`
  - `formatBacklogSummary(result: EnrichBacklogResult): string`
  - `formatCollectDetailSummary(result: CollectDetailResult): string` — `enrichStats`가 있으면 뒤에 붙인다
  - CLI: `tb collect-detail [--daily-limit <n>] [--max-attempts <n>] [--skip-detail] [--skip-embed]`

- [ ] **Step 1: 실패하는 테스트 작성**

`core/tests/commands/collectDetail.test.ts`의 import를 아래로 교체:

```ts
import { describe, it, expect } from "vitest";
import {
  assertSkipFlags,
  formatBacklogSummary,
  formatCollectDetailSummary,
  formatEnrichSummary,
  formatStageBacklog,
} from "../../src/commands/collectDetail.js";
import type { CollectDetailResult } from "../../src/services/collectDetail.js";
import type { EnrichStats } from "../../src/services/enricher.js";
import type { StageCounts } from "../../src/lib/tourContentsTable.js";
```

파일 맨 끝에 추가:

```ts
function stats(overrides: Partial<EnrichStats> = {}): EnrichStats {
  return {
    structured: 875,
    fallback: 12,
    structureRetry: 5,
    structureFailed: 0,
    embedded: 875,
    embedRetry: 0,
    embedFailed: 0,
    geminiRateLimited: 0,
    disabled: false,
    ...overrides,
  };
}

describe("assertSkipFlags", () => {
  it("둘 다 지정하면 아무 작업도 안 하므로 거부한다", () => {
    expect(() => assertSkipFlags(true, true)).toThrow("--skip-detail");
    expect(() => assertSkipFlags(true, true)).toThrow("--skip-embed");
  });

  it("하나만 또는 둘 다 아니면 통과한다", () => {
    expect(() => assertSkipFlags(true, false)).not.toThrow();
    expect(() => assertSkipFlags(false, true)).not.toThrow();
    expect(() => assertSkipFlags(false, false)).not.toThrow();
  });
});

describe("formatEnrichSummary", () => {
  it("구조화와 임베딩 집계를 담고 폴백을 done의 내역으로 표시한다", () => {
    const text = formatEnrichSummary(stats());
    expect(text).toContain("구조화 880건");
    expect(text).toContain("done 875");
    expect(text).toContain("폴백 12");
    expect(text).toContain("재시도대기 5");
    expect(text).toContain("임베딩 875건 upsert");
  });

  it("Gemini 한도로 건너뛴 건수가 있으면 이어진다고 안내한다", () => {
    const text = formatEnrichSummary(stats({ geminiRateLimited: 20 }));
    expect(text).toContain("Gemini 한도");
    expect(text).toContain("20건");
    expect(text).toContain("다음 실행");
  });

  it("차단기가 작동했으면 키와 네트워크 확인을 안내한다", () => {
    const text = formatEnrichSummary(stats({ disabled: true }));
    expect(text).toContain("GEMINI_API_KEY");
  });

  it("정상 종료면 경고 문구를 넣지 않는다", () => {
    const text = formatEnrichSummary(stats());
    expect(text).not.toContain("GEMINI_API_KEY");
    expect(text).not.toContain("Gemini 한도");
  });
});

describe("formatCollectDetailSummary + enrichStats", () => {
  it("enrichStats가 있으면 상세 요약 뒤에 붙인다", () => {
    const text = formatCollectDetailSummary(result({ enrichStats: stats() }));
    expect(text).toContain("처리 900건");
    expect(text).toContain("구조화 880건");
    expect(text).toContain("임베딩 875건 upsert");
  });

  it("enrichStats가 없으면 상세 요약만 낸다", () => {
    const text = formatCollectDetailSummary(result());
    expect(text).not.toContain("구조화");
    expect(text).not.toContain("임베딩");
  });
});

describe("formatBacklogSummary", () => {
  it("처리 건수와 구조화·임베딩 집계를 담는다", () => {
    const text = formatBacklogSummary({ processed: 100, stats: stats() });
    expect(text).toContain("백로그 100건");
    expect(text).toContain("구조화 880건");
    expect(text).toContain("임베딩 875건 upsert");
  });
});

describe("formatStageBacklog", () => {
  function counts(overrides: Partial<StageCounts> = {}): StageCounts {
    return {
      structure: { pending: 5, done: 875, failed: 2 },
      embed: { pending: 0, done: 875, failed: 1 },
      ...overrides,
    };
  }

  it("남은 스테이지 대기 건수와 failed를 담는다", () => {
    const text = formatStageBacklog(counts());
    expect(text).toContain("구조화대기 5");
    expect(text).toContain("임베딩대기 0");
    expect(text).toContain("구조화 failed 2");
    expect(text).toContain("임베딩 failed 1");
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- tests/commands/collectDetail.test.ts
```

Expected: FAIL — `assertSkipFlags` / `formatEnrichSummary` / `formatBacklogSummary` export 없음

- [ ] **Step 3: 구현 — `core/src/commands/collectDetail.ts` 전체 교체**

```ts
import type { Command } from "commander";
import { TourApiClient } from "../clients/tourApi.js";
import { PostgresClient } from "../clients/postgres.js";
import { GeminiClient } from "../clients/gemini.js";
import { TeiEmbeddingClient } from "../clients/tei.js";
import { QdrantStore } from "../clients/qdrant.js";
import { collectDetail } from "../services/collectDetail.js";
import type { CollectDetailResult } from "../services/collectDetail.js";
import { createEnricher } from "../services/enricher.js";
import type { Enricher, EnrichStats } from "../services/enricher.js";
import { enrichBacklog } from "../services/enrichBacklog.js";
import type { EnrichBacklogResult } from "../services/enrichBacklog.js";
import { ensureCollection } from "../lib/qdrantCollection.js";
import { countStageStatus } from "../lib/tourContentsTable.js";
import type { StageCounts } from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";
import { parsePositiveInt } from "../lib/cliOptions.js";
import { optionalEnv } from "../lib/env.js";

interface CollectDetailCliOptions {
  dailyLimit?: string;
  maxAttempts?: string;
  skipDetail?: boolean;
  skipEmbed?: boolean;
}

const NEXT_STEP: Record<CollectDetailResult["stoppedBy"], string> = {
  budget: "내일 다시 실행하세요.",
  "quota-exceeded":
    "API 일일 한도에 도달했습니다. 다른 작업이 한도를 사용했는지 확인하세요.",
  aborted:
    "연속 실패로 중단했습니다. 서비스 키 만료 여부와 네트워크를 확인한 뒤 다시 실행하세요.",
  "no-pending": "모든 항목 처리 완료.",
};

/** 두 스킵 플래그를 함께 주면 아무 작업도 하지 않으므로 거부한다 (순수 함수). */
export function assertSkipFlags(skipDetail: boolean, skipEmbed: boolean): void {
  if (skipDetail && skipEmbed) {
    throw new Error(
      "--skip-detail과 --skip-embed를 함께 지정하면 아무 작업도 수행하지 않습니다.",
    );
  }
}

/** 구조화·임베딩 집계를 사람이 읽을 여러 줄로 만든다 (순수 함수). */
export function formatEnrichSummary(stats: EnrichStats): string {
  const structureTotal = stats.structured + stats.structureRetry + stats.structureFailed;
  const lines = [
    `       구조화 ${structureTotal}건 (done ${stats.structured} — 그중 폴백 ${stats.fallback}, ` +
      `재시도대기 ${stats.structureRetry}, failed ${stats.structureFailed})`,
    `       임베딩 ${stats.embedded}건 upsert ` +
      `(재시도대기 ${stats.embedRetry}, failed ${stats.embedFailed})`,
  ];
  if (stats.geminiRateLimited > 0) {
    lines.push(
      `       Gemini 한도로 ${stats.geminiRateLimited}건 구조화를 건너뜀 — ` +
        `다음 실행에서 이어집니다.`,
    );
  }
  if (stats.disabled) {
    lines.push(
      "       구조화 연속 실패로 임베딩이 중단됐습니다. " +
        "GEMINI_API_KEY와 네트워크를 확인하세요.",
    );
  }
  return lines.join("\n");
}

/** collect-detail 실행 결과를 사람이 읽을 요약으로 만든다 (순수 함수). */
export function formatCollectDetailSummary(result: CollectDetailResult): string {
  const breakdown = [
    `done ${result.done}`,
    `nodata ${result.nodata}`,
    `재시도대기 ${result.retryScheduled}`,
    `failed ${result.failed}`,
  ].join(", ");
  const head =
    `종료 — 처리 ${result.processed}건 (${breakdown})\n` +
    `       남은 pending ${result.remainingPending}건. ${NEXT_STEP[result.stoppedBy]}`;
  return result.enrichStats === undefined
    ? head
    : `${head}\n${formatEnrichSummary(result.enrichStats)}`;
}

/** 백로그 실행 결과를 사람이 읽을 요약으로 만든다 (순수 함수). */
export function formatBacklogSummary(result: EnrichBacklogResult): string {
  return `종료 — 백로그 ${result.processed}건 처리\n${formatEnrichSummary(result.stats)}`;
}

/**
 * 남은 스테이지 대기 건수를 한 줄로 만든다 (순수 함수).
 * 하루 유입량(상세 done)보다 구조화 처리량이 적으면 이 수치가 늘어난다 —
 * free tier에서 백로그가 쌓이는지 판단하는 유일한 신호다.
 */
export function formatStageBacklog(counts: StageCounts): string {
  return (
    `       구조화대기 ${counts.structure.pending} / 임베딩대기 ${counts.embed.pending}` +
    ` (구조화 failed ${counts.structure.failed}, 임베딩 failed ${counts.embed.failed})`
  );
}

/** commander program에 `collect-detail` 명령을 등록한다. */
export function registerCollectDetail(program: Command): void {
  program
    .command("collect-detail")
    .description(
      "pending 콘텐츠의 overview를 detailCommon2로 채우고 Gemini 구조화 후 Qdrant에 색인 (중단 시 재실행하면 이어서)",
    )
    .option("--daily-limit <n>", "이번 실행에서 처리할 최대 건수", "900")
    .option("--max-attempts <n>", "이 횟수만큼 실패하면 제외", "3")
    .option("--skip-detail", "상세 수집을 건너뛰고 구조화·임베딩 백로그만 처리")
    .option("--skip-embed", "구조화·임베딩을 건너뛰고 상세 수집만 수행")
    .action(async (options: CollectDetailCliOptions) => {
      const dailyLimit = parsePositiveInt("--daily-limit", options.dailyLimit, 900);
      const maxAttempts = parsePositiveInt("--max-attempts", options.maxAttempts, 3);
      const skipDetail = options.skipDetail ?? false;
      const skipEmbed = options.skipEmbed ?? false;
      assertSkipFlags(skipDetail, skipEmbed);

      const pg = new PostgresClient();
      await pg.connect();
      let qdrant: QdrantStore | undefined;
      try {
        let enricher: Enricher | undefined;
        if (!skipEmbed) {
          // 클라이언트 생성자가 requireEnv로 throw하므로 조건부로 만든다 —
          // --skip-embed면 GEMINI_API_KEY·TEI_BASE_URL·QDRANT_URL 없이도 동작해야 한다.
          const gemini = new GeminiClient();
          const tei = new TeiEmbeddingClient();
          qdrant = new QdrantStore();
          await qdrant.connect();
          const collection = await ensureCollection(
            qdrant,
            tei,
            optionalEnv("QDRANT_COLLECTION", "tour_contents"),
          );
          logger.info(
            `컬렉션 ${collection.name} (${collection.vectorSize}차원, Cosine) 확인`,
          );
          enricher = createEnricher(gemini, tei, qdrant, pg, collection, { maxAttempts });
        }

        if (skipDetail) {
          // assertSkipFlags가 통과했고 skipDetail이 참이므로 enricher는 반드시 존재한다.
          const result = await enrichBacklog(pg, enricher as Enricher, dailyLimit);
          logger.info(formatBacklogSummary(result));
        } else {
          const tourApi = new TourApiClient();
          const result = await collectDetail(
            tourApi,
            pg,
            { dailyLimit, maxAttempts },
            enricher,
          );
          logger.info(formatCollectDetailSummary(result));
        }

        if (enricher !== undefined) {
          // --skip-embed면 스테이지 컬럼을 쓰지 않았으므로 출력할 의미가 없다.
          logger.info(formatStageBacklog(await countStageStatus(pg)));
        }
      } finally {
        await qdrant?.close();
        await pg.close();
      }
    });
}
```

- [ ] **Step 4: `.env.example`에 컬렉션 이름 추가**

`core/.env.example`의 Qdrant 절을 아래로 교체:

```
# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=tour_contents
```

- [ ] **Step 5: 통과를 확인**

```
npm test
npm run typecheck
npm run build
```

Expected: 전부 PASS. 기존 `formatCollectDetailSummary` 테스트 6개도 통과해야 한다 (`enrichStats` 없으면 출력이 그대로다).

- [ ] **Step 6: 커밋**

```bash
git add core/src/commands/collectDetail.ts core/tests/commands/collectDetail.test.ts core/.env.example
git commit -m "feat(core): collect-detail에 --skip-detail/--skip-embed와 임베딩 요약 추가

Gemini/TEI/Qdrant 클라이언트를 조건부로 생성한다 — 생성자가 requireEnv로
throw하므로 --skip-embed일 때 해당 env 없이도 동작해야 한다.
컬렉션 이름은 QDRANT_COLLECTION(기본 tour_contents)."
```

---

## 실측 검증 (100건 스모크)

모든 태스크 완료 후 수행한다. **Postgres·TEI·Qdrant가 사내망 전용이므로 사내망에서 실행해야 한다.**

- [ ] **1. 사전 확인**

```bash
cd core
npm run build
node dist/index.js collect-detail --help     # 플래그 4개가 보이는지
```

- [ ] **2. 100건 실행**

```bash
npm run dev -- collect-detail --daily-limit 100
```

기대 출력: 컬렉션 확인 줄(`1024차원`)과 종료 요약 3~4줄.

- [ ] **3. 아래 표를 채운다**

| 확인 항목 | 확인 방법 | 판단 기준 |
|---|---|---|
| 체인 완주 | `SELECT count(*) FROM tour_contents WHERE embed_status='done'` | 100 |
| 컬렉션 차원 | 실행 첫 줄 로그 | `1024차원, Cosine` |
| **Gemini 포맷 준수율** | 종료 요약의 `구조화 ... 재시도대기` 건수 / 100 | 수치를 기록. 10% 넘으면 프롬프트 규칙 1을 강화한다 |
| **환각률** | `SELECT structured_text FROM tour_contents WHERE structure_status='done' LIMIT 20` 을 **직접 읽고** "실내/실외"·"추천 동반자"가 원문·유형과 모순되지 않는지 센다 | 20건 중 모순 건수를 기록. 이 단계의 핵심 산출물이다 |
| 폴백 발생률 | 종료 요약의 `폴백` 건수 | 수치 기록 |
| Gemini 소요 시간 | 실행 시작~종료 벽시계 시간 | free tier 실측값으로 `--daily-limit` 운용값을 정한다 |

- [ ] **4. 재개 확인**

```bash
npm run dev -- collect-detail --daily-limit 20    # 실행 중 Ctrl+C
npm run dev -- collect-detail --daily-limit 20    # 남은 항목부터 이어가는지
```

- [ ] **5. Qdrant 멱등성 확인**

```sql
UPDATE tour_contents SET embed_status = 'pending' WHERE embed_status = 'done';
```

```bash
npm run dev -- collect-detail --skip-detail --daily-limit 100
```

기대: point 수가 **100 유지**(200 아님), 그리고 종료 요약의 `구조화 0건` — `structured_text`를 재사용해 **Gemini를 호출하지 않아야 한다.**

```bash
curl -s http://localhost:6333/collections/tour_contents | grep -o '"points_count":[0-9]*'
```

- [ ] **6. `--skip-embed` 확인**

```bash
GEMINI_API_KEY= TEI_BASE_URL= QDRANT_URL= npm run dev -- collect-detail --skip-embed --daily-limit 5
```

기대: env가 비어 있어도 상세 수집만 정상 동작 (조건부 클라이언트 생성 검증).

- [ ] **7. 유사도 바닥값 측정**

무관한 두 항목(예: 해수욕장 1건 vs 박물관 1건)의 코사인 유사도를 잰다. 라벨이 모든 벡터에 공유되므로 0이 아닌 값(대략 0.5~0.6)이 나올 것이다. **그 값이 "무관함의 바닥"이며, 나중에 검색 임계값을 정할 때의 출발점이다.**

```bash
# 항목 A의 벡터로 검색해 항목 B의 score를 확인한다
curl -s -X POST http://localhost:6333/collections/tour_contents/points/query \
  -H 'Content-Type: application/json' \
  -d '{"query": <항목 A의 point id>, "limit": 100, "with_payload": ["title"]}'
```

**100건으로 검색 임계값을 확정하지 않는다.** 표본이 작아 top-K가 전체의 상당 비율이 되어 score 분포가 운영 환경과 다르다. 임계값은 수천 건 쌓인 뒤에 정한다.

---

## 실행 순서 요약

| Task | 파일 | 의존 |
|---|---|---|
| 1 | `clients/qdrant.ts` | — |
| 2 | `lib/tourContentsTable.ts` (DDL) | — |
| 3 | `lib/tourContentsTable.ts` (`fetchEnrichInput`) | 2 |
| 4 | `lib/tourContentsTable.ts` (mark/claim/count) | 2 |
| 5 | `lib/structuredText.ts` | 3 |
| 6 | `lib/qdrantCollection.ts` | 1, 3 |
| 7 | `lib/logger.ts`, `services/enricher.ts` | 3, 4, 5, 6 |
| 8 | `services/enrichBacklog.ts` | 2, 4, 7 |
| 9 | `services/collectDetail.ts` | 7 |
| 10 | `commands/collectDetail.ts`, `.env.example` | 전부 |

Task 1·2는 서로 독립이라 순서를 바꿔도 된다. 3·4는 둘 다 Task 2 이후여야 한다. 나머지는 표의 순서를 따른다.
