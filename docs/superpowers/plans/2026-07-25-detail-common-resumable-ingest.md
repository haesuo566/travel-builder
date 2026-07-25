# detailCommon 재개 가능 수집 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TourAPI `detailCommon2`로 콘텐츠별 `overview`를 Postgres에 적재하되, 일 1,000건 API 한도를 여러 날에 나눠 쓰며 중단 지점부터 자동으로 이어서 수집한다.

**Architecture:** 커맨드를 둘로 나눈다. `tb collect-list`가 `areaBasedSyncList2`로 콘텐츠 목록을 `tour_contents` 테이블에 `detail_status='pending'`으로 적재하고, `tb collect-detail`이 pending 행을 골라 `detailCommon2`를 건당 호출해 `overview`를 채운다. **별도의 커서나 체크포인트 파일이 없다** — `detail_status='pending'` 조회 자체가 남은 일 목록이므로, 프로세스가 어떻게 죽든 다음 실행이 이어받는다. 임베딩/Qdrant는 이번 스코프 밖이며, 나중에 `embed_status` 컬럼을 추가한 별도 스테이지로 붙인다.

**Tech Stack:** TypeScript(ESM, NodeNext), commander, pg, axios, vitest

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-25-detail-common-resumable-ingest-design.md`. 충돌 시 스펙이 우선.
- 모든 import는 **`.js` 확장자**를 붙인다 (NodeNext ESM). 예: `import { logger } from "../lib/logger.js"`.
- 사용자 대상 출력은 `console.*`이 아니라 `logger`(`src/lib/logger.ts`)를 쓴다. **`logger`에는 `info`와 `error`만 있다 — `logger.warn`은 존재하지 않는다.**
- 테스트는 `core/tests/`에 소스 구조를 그대로 미러링한다. axios 모킹은 `vi.hoisted` + `vi.mock("axios", () => ({ default: { get: getMock } }))` 패턴을 따른다(`core/tests/clients/tourApi.test.ts:3-7`).
- DB 스키마는 마이그레이션 도구 없이 커맨드 내 `CREATE TABLE IF NOT EXISTS`로 만든다(`generateTourCodes.ts:25-52`와 동일).
- 모든 명령은 `core/` 디렉터리에서 실행한다.
- 기본값: `dailyLimit = 900`, `maxAttempts = 3`, `pageSize = 1000`, `maxPages = 100`.
- `detail_status` 허용값은 `'pending' | 'done' | 'nodata' | 'failed'` 네 가지뿐이다.
- **API 쿼터를 소비하는 코드는 이 계획의 Task 9(스모크 테스트)에서만 실행한다.** Task 1~8은 전부 모킹된 단위 테스트다.

---

### Task 1: TourApiError와 에러 분류 헬퍼

TourAPI 응답의 `resultCode`를 에러 메시지 문자열이 아니라 **타입 필드**로 노출한다. `collectDetail`이 NODATA / 한도초과 / 기타 오류를 분기하려면 이게 선행돼야 한다.

**Files:**
- Modify: `core/src/clients/tourApi.ts:135-177` (`request`/`requestAll`의 에러 처리)
- Test: `core/tests/clients/tourApi.test.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `export class TourApiError extends Error { readonly resultCode: string; readonly resultMsg: string }`
  - `export function isNoData(e: unknown): boolean`
  - `export function isQuotaExceeded(e: unknown): boolean`

- [x] **Step 1: 실패하는 테스트 작성**

`core/tests/clients/tourApi.test.ts`의 마지막 `});` 앞에 추가:

```ts
  it("resultCode가 0000이 아니면 TourApiError를 던지고 resultCode를 노출한다", async () => {
    getMock.mockResolvedValue(envelope("", "03", "NODATA_ERROR"));
    const client = new TourApiClient();
    await expect(client.getAreaBasedList()).rejects.toBeInstanceOf(TourApiError);
    await expect(client.getAreaBasedList()).rejects.toMatchObject({ resultCode: "03" });
  });

  it("isNoData가 resultCode 03만 판별한다", () => {
    expect(isNoData(new TourApiError("03", "NODATA_ERROR"))).toBe(true);
    expect(isNoData(new TourApiError("22", "LIMITED"))).toBe(false);
    expect(isNoData(new Error("그냥 에러"))).toBe(false);
    expect(isNoData(undefined)).toBe(false);
  });

  it("isQuotaExceeded가 resultCode 22와 한도초과 문자열을 판별한다", () => {
    expect(isQuotaExceeded(new TourApiError("22", "LIMITED"))).toBe(true);
    expect(
      isQuotaExceeded(
        new TourApiError("LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR", "한도초과"),
      ),
    ).toBe(true);
    expect(isQuotaExceeded(new TourApiError("03", "NODATA_ERROR"))).toBe(false);
    expect(isQuotaExceeded(new Error("그냥 에러"))).toBe(false);
  });

  it("JSON 봉투가 아닌 XML 한도초과 응답도 TourApiError(22)로 변환한다", async () => {
    getMock.mockResolvedValue({
      data:
        "<OpenAPI_ServiceResponse><cmmMsgHeader>" +
        "<returnAuthMsg>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR</returnAuthMsg>" +
        "<returnReasonCode>22</returnReasonCode>" +
        "</cmmMsgHeader></OpenAPI_ServiceResponse>",
    });
    const client = new TourApiClient();
    await expect(client.getAreaBasedList()).rejects.toSatisfy((e: unknown) =>
      isQuotaExceeded(e),
    );
  });

  it("정체불명의 응답 형식은 UNKNOWN 코드의 TourApiError가 된다", async () => {
    getMock.mockResolvedValue({ data: { unexpected: true } });
    const client = new TourApiClient();
    await expect(client.getAreaBasedList()).rejects.toMatchObject({ resultCode: "UNKNOWN" });
  });
```

같은 파일 상단의 import를 수정한다:

```ts
import { TourApiClient, TourApiError, isNoData, isQuotaExceeded } from "../../src/clients/tourApi.js";
```

> `toSatisfy`는 vitest 2.x의 표준 matcher다. 없다는 오류가 나면 `.rejects.toMatchObject({ resultCode: "22" })`로 바꾼다.

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/clients/tourApi.test.ts`
Expected: FAIL — `TourApiError`, `isNoData`, `isQuotaExceeded`가 export되지 않아 import 에러 또는 `is not defined`

- [x] **Step 3: 구현**

`core/src/clients/tourApi.ts`의 `normalizeItems` 함수(`:109-114`) 바로 뒤에 추가:

```ts
const NO_DATA_CODE = "03";
const QUOTA_CODES = new Set(["22", "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"]);
/** data.go.kr이 JSON 봉투 대신 XML 에러를 반환할 때 본문에서 찾을 한도초과 표지. */
const QUOTA_BODY_MARKERS = [
  "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
  "<returnReasonCode>22</returnReasonCode>",
];

/** TourAPI가 반환한 resultCode를 필드로 노출하는 오류. */
export class TourApiError extends Error {
  constructor(
    readonly resultCode: string,
    readonly resultMsg: string,
  ) {
    super(`TourAPI 오류(${resultCode}): ${resultMsg}`);
    this.name = "TourApiError";
  }
}

/** 데이터 없음(03) 여부. 재시도해도 결과가 달라지지 않는다. */
export function isNoData(e: unknown): boolean {
  return e instanceof TourApiError && e.resultCode === NO_DATA_CODE;
}

/**
 * 일일 호출 한도 초과 여부.
 * 데이터의 문제가 아니라 호출자 사정이므로, 호출자는 해당 항목의 상태를 바꾸지 않고 중단해야 한다.
 */
export function isQuotaExceeded(e: unknown): boolean {
  return e instanceof TourApiError && QUOTA_CODES.has(e.resultCode);
}

/**
 * 응답 본문을 검증된 봉투로 변환한다.
 * 한도 초과 시 data.go.kr이 `_type=json`을 무시하고 XML을 반환하는 경우가 있어,
 * 봉투 파싱 실패 경로에서도 한도초과를 반드시 판별해야 한다.
 * (이걸 놓치면 한도초과가 "그 외 오류"로 오분류되어 멀쩡한 항목의 실패 횟수가 누적된다.)
 */
function parseEnvelope<T>(data: unknown): TourApiEnvelope<T> {
  const header = (data as TourApiEnvelope<T> | undefined)?.response?.header;
  if (header?.resultCode === undefined) {
    const body = typeof data === "string" ? data : JSON.stringify(data ?? "");
    if (QUOTA_BODY_MARKERS.some((marker) => body.includes(marker))) {
      throw new TourApiError("22", "일일 호출 한도를 초과했습니다.");
    }
    throw new TourApiError("UNKNOWN", `예상치 못한 응답 형식: ${body.slice(0, 200)}`);
  }
  if (header.resultCode !== "0000") {
    throw new TourApiError(header.resultCode, header.resultMsg);
  }
  return data as TourApiEnvelope<T>;
}
```

이어서 `request`(`:135-147`)를 통째로 교체:

```ts
  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const url = this.buildUrl(path, params);
    const { data } = await axios.get<unknown>(url);
    const envelope = parseEnvelope<T>(data);
    return normalizeItems(envelope.response.body.items);
  }
```

`requestAll`(`:149-177`)의 본문에서 인라인 에러 처리를 `parseEnvelope`로 교체:

```ts
  private async requestAll<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    numOfRows: number,
  ): Promise<T[]> {
    const results: T[] = [];
    let pageNo = 1;
    while (true) {
      if (pageNo > MAX_PAGES) {
        throw new Error(
          `TourAPI: ${path} 페이지네이션이 ${MAX_PAGES}페이지를 초과했습니다.`,
        );
      }
      const { data } = await axios.get<unknown>(
        this.buildUrl(path, { ...params, numOfRows, pageNo }),
      );
      const envelope = parseEnvelope<T>(data);
      const items = normalizeItems(envelope.response.body.items);
      results.push(...items);
      if (items.length === 0 || results.length >= envelope.response.body.totalCount) {
        break;
      }
      pageNo += 1;
    }
    return results;
  }
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/clients/tourApi.test.ts`
Expected: PASS — 신규 5개 + 기존 테스트 전부. 기존 `rejects.toThrow("TourAPI 오류(...)")` 검증은 메시지 형식을 그대로 유지했으므로 계속 통과한다.

- [x] **Step 5: 타입체크**

Run: `cd core && npm run typecheck`
Expected: 오류 없음

- [x] **Step 6: 커밋**

```bash
git add core/src/clients/tourApi.ts core/tests/clients/tourApi.test.ts
git commit -m "feat(core): TourApiError로 resultCode를 타입 필드로 노출

한도초과/NODATA를 문자열 파싱 없이 분기할 수 있게 한다. 한도초과 시
data.go.kr이 XML을 반환하는 경우도 parseEnvelope에서 판별한다."
```

---

### Task 2: getAreaBasedSyncList 추가 + getDetailCommon v4.4 정합화

목록 조회(`areaBasedSyncList2`)를 추가하고, `getDetailCommon`에서 v4.3에 삭제된 파라미터를 제거한다. 결과 없음을 `TourApiError("03")`으로 던져 Task 7이 `isNoData`로 잡을 수 있게 한다.

**Files:**
- Modify: `core/src/clients/tourApi.ts` (`TourApiAreaItem` 뒤에 타입 추가, `getDetailCommon:194-210` 교체, 클래스에 메서드 추가)
- Test: `core/tests/clients/tourApi.test.ts`

**Interfaces:**
- Consumes: Task 1의 `TourApiError`, `parseEnvelope`
- Produces:
  - `export interface TourApiSyncItem` — 아래 Step 3의 필드 정의
  - `export interface TourApiPage<T> { items: T[]; totalCount: number; pageNo: number; numOfRows: number }`
  - `export interface TourApiSyncListParams`
  - `TourApiClient.getAreaBasedSyncList(params: TourApiSyncListParams): Promise<TourApiPage<TourApiSyncItem>>`
  - `TourApiClient.getDetailCommon(contentId: string): Promise<TourApiDetailCommon>` (시그니처 동일, 동작 변경)

- [x] **Step 1: 실패하는 테스트 작성**

`core/tests/clients/tourApi.test.ts`에 추가:

```ts
  it("getAreaBasedSyncList가 필터와 페이지 정보를 전송하고 TourApiPage를 반환한다", async () => {
    const item = {
      contentid: "126508",
      contenttypeid: "12",
      title: "경복궁",
      mapx: "126.9769",
      mapy: "37.5796",
      addr1: "서울특별시 종로구 사직로 161",
      addr2: "",
      zipcode: "03045",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
      lclsSystm1: "AC",
      lclsSystm2: "AC01",
      lclsSystm3: "AC010100",
      createdtime: "20030204092000",
      modifiedtime: "20250101120000",
      showflag: "1",
    };
    getMock.mockResolvedValue({
      data: {
        response: {
          header: { resultCode: "0000", resultMsg: "OK" },
          body: { items: { item: [item] }, numOfRows: 1000, pageNo: 2, totalCount: 1500 },
        },
      },
    });
    const client = new TourApiClient();
    const page = await client.getAreaBasedSyncList({
      pageNo: 2,
      numOfRows: 1000,
      contentTypeId: "12",
      lDongRegnCd: "11",
    });
    expect(page.items).toEqual([item]);
    expect(page.totalCount).toBe(1500);
    expect(page.pageNo).toBe(2);
    expect(page.numOfRows).toBe(1000);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("areaBasedSyncList2?");
    expect(url).toContain("pageNo=2");
    expect(url).toContain("numOfRows=1000");
    expect(url).toContain("contentTypeId=12");
    expect(url).toContain("lDongRegnCd=11");
    expect(url).not.toContain("lDongSignguCd=");
  });

  it("getAreaBasedSyncList가 빈 items를 빈 배열로 정규화한다", async () => {
    getMock.mockResolvedValue({
      data: {
        response: {
          header: { resultCode: "0000", resultMsg: "OK" },
          body: { items: "", numOfRows: 1000, pageNo: 1, totalCount: 0 },
        },
      },
    });
    const client = new TourApiClient();
    const page = await client.getAreaBasedSyncList({ pageNo: 1, numOfRows: 1000 });
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
  });

  it("getDetailCommon이 v4.3에서 삭제된 파라미터를 전송하지 않는다", async () => {
    getMock.mockResolvedValue(envelope({ item: { contentid: "1", overview: "설명" } }));
    const client = new TourApiClient();
    await client.getDetailCommon("1");
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("contentId=1");
    for (const removed of [
      "defaultYN",
      "firstImageYN",
      "areacodeYN",
      "catcodeYN",
      "addrinfoYN",
      "mapinfoYN",
      "overviewYN",
    ]) {
      expect(url).not.toContain(removed);
    }
  });

  it("getDetailCommon이 결과 없으면 isNoData로 판별되는 오류를 던진다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await expect(client.getDetailCommon("999")).rejects.toMatchObject({ resultCode: "03" });
  });
```

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/clients/tourApi.test.ts`
Expected: FAIL — `getAreaBasedSyncList is not a function`, 그리고 삭제 파라미터 검증 실패

- [x] **Step 3: 구현**

`core/src/clients/tourApi.ts`의 `TourApiAreaItem` 인터페이스(`:22-41`) **뒤에** 추가:

```ts
/** areaBasedSyncList2 응답 항목 (KorService2 v4.4). */
export interface TourApiSyncItem {
  contentid: string;
  contenttypeid: string;
  title: string;
  mapx: string;
  mapy: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  lDongRegnCd: string;
  lDongSignguCd: string;
  lclsSystm1: string;
  lclsSystm2: string;
  lclsSystm3: string;
  createdtime: string;
  modifiedtime: string;
  showflag: string;
}

/** 페이지네이션 정보를 포함한 한 페이지 응답. */
export interface TourApiPage<T> {
  items: T[];
  totalCount: number;
  pageNo: number;
  numOfRows: number;
}

export interface TourApiSyncListParams {
  pageNo: number;
  numOfRows: number;
  contentTypeId?: string;
  lDongRegnCd?: string;
  lDongSignguCd?: string;
  lclsSystm1?: string;
  lclsSystm2?: string;
  lclsSystm3?: string;
  showflag?: "0" | "1";
  modifiedtime?: string;
  arrange?: string;
}
```

`TourApiClient` 클래스 안, `request` 메서드 뒤에 추가:

```ts
  private async requestPage<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<TourApiPage<T>> {
    const url = this.buildUrl(path, params);
    const { data } = await axios.get<unknown>(url);
    const envelope = parseEnvelope<T>(data);
    const body = envelope.response.body;
    return {
      items: normalizeItems(body.items),
      totalCount: body.totalCount,
      pageNo: body.pageNo,
      numOfRows: body.numOfRows,
    };
  }
```

`getAreaBasedList`(`:180-192`) 뒤에 추가:

```ts
  /** 동기화 목록(areaBasedSyncList2) 한 페이지를 조회한다. */
  async getAreaBasedSyncList(params: TourApiSyncListParams): Promise<TourApiPage<TourApiSyncItem>> {
    return this.requestPage<TourApiSyncItem>("areaBasedSyncList2", {
      pageNo: params.pageNo,
      numOfRows: params.numOfRows,
      contentTypeId: params.contentTypeId,
      lDongRegnCd: params.lDongRegnCd,
      lDongSignguCd: params.lDongSignguCd,
      lclsSystm1: params.lclsSystm1,
      lclsSystm2: params.lclsSystm2,
      lclsSystm3: params.lclsSystm3,
      showflag: params.showflag,
      modifiedtime: params.modifiedtime,
      arrange: params.arrange,
    });
  }
```

`getDetailCommon`(`:194-210`)을 통째로 교체:

```ts
  /**
   * 관광지 공통정보를 조회한다.
   * v4.3에서 defaultYN/firstImageYN/areacodeYN/catcodeYN/addrinfoYN/mapinfoYN/overviewYN이
   * 삭제되어 contentId만 전송한다.
   * 결과가 없으면 NODATA(03)로 던져 호출자가 isNoData로 종결 처리할 수 있게 한다.
   */
  async getDetailCommon(contentId: string): Promise<TourApiDetailCommon> {
    const items = await this.request<TourApiDetailCommon>("detailCommon2", { contentId });
    if (items.length === 0) {
      throw new TourApiError(
        "03",
        `contentId=${contentId}에 대한 공통정보를 찾을 수 없습니다.`,
      );
    }
    return items[0];
  }
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/clients/tourApi.test.ts`
Expected: PASS — 전부. 기존 `getDetailCommon이 결과 없으면 throw한다`(`:118-122`)는 메시지에 `999`가 남아 있어 계속 통과한다.

- [x] **Step 5: 타입체크**

Run: `cd core && npm run typecheck`
Expected: 오류 없음

- [x] **Step 6: 커밋**

```bash
git add core/src/clients/tourApi.ts core/tests/clients/tourApi.test.ts
git commit -m "feat(core): areaBasedSyncList2 조회 추가, detailCommon v4.4 정합화

detailCommon2에서 v4.3 삭제 파라미터를 제거하고, 결과 없음을
TourApiError(03)으로 던져 호출자가 종결 처리할 수 있게 한다."
```

---

### Task 3: TourContentRow 타입과 투영 함수

syncList 응답 항목에서 DB에 저장할 필드만 뽑는 순수 함수. 네트워크·DB 접근 없음.

**Files:**
- Create: `core/src/lib/tourContent.ts`
- Test: `core/tests/lib/tourContent.test.ts`

**Interfaces:**
- Consumes: Task 2의 `TourApiSyncItem`
- Produces:
  - `export interface TourContentRow` — 아래 Step 3 정의
  - `export function toTourContentRow(item: TourApiSyncItem): TourContentRow`

- [x] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/tourContent.test.ts` 생성:

```ts
import { describe, it, expect } from "vitest";
import { toTourContentRow } from "../../src/lib/tourContent.js";
import type { TourApiSyncItem } from "../../src/clients/tourApi.js";

function syncItem(overrides: Partial<TourApiSyncItem> = {}): TourApiSyncItem {
  return {
    contentid: "126508",
    contenttypeid: "12",
    title: "경복궁",
    mapx: "126.9769",
    mapy: "37.5796",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    zipcode: "03045",
    lDongRegnCd: "11",
    lDongSignguCd: "110",
    lclsSystm1: "AC",
    lclsSystm2: "AC01",
    lclsSystm3: "AC010100",
    createdtime: "20030204092000",
    modifiedtime: "20250101120000",
    showflag: "1",
    ...overrides,
  };
}

describe("toTourContentRow", () => {
  it("필요한 필드만 뽑아 TourContentRow로 투영한다", () => {
    expect(toTourContentRow(syncItem())).toEqual({
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
    });
  });

  it("투영 대상이 아닌 필드는 결과에 남지 않는다", () => {
    const row = toTourContentRow(syncItem()) as Record<string, unknown>;
    expect(row.createdtime).toBeUndefined();
    expect(row.showflag).toBeUndefined();
  });

  it("응답에 없는 필드는 빈 문자열로 채운다", () => {
    const partial = { contentid: "1", contenttypeid: "12", title: "제목" } as TourApiSyncItem;
    const row = toTourContentRow(partial);
    expect(row.addr1).toBe("");
    expect(row.ldongRegnCd).toBe("");
    expect(row.lclsSystm3).toBe("");
    expect(row.modifiedtime).toBe("");
  });
});
```

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/lib/tourContent.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/tourContent.js'`

- [x] **Step 3: 구현**

`core/src/lib/tourContent.ts` 생성:

```ts
import type { TourApiSyncItem } from "../clients/tourApi.js";

/**
 * tour_contents 테이블의 목록 유래 컬럼.
 * 코드→이름 변환은 여기서 하지 않는다. DB에는 코드만 저장하고,
 * 이름은 읽는 쪽에서 코드표(tour_ldong_codes 등)와 join해 얻는다.
 */
export interface TourContentRow {
  contentid: string;
  contenttypeid: string;
  title: string;
  mapx: string;
  mapy: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  ldongRegnCd: string;
  ldongSignguCd: string;
  lclsSystm1: string;
  lclsSystm2: string;
  lclsSystm3: string;
  modifiedtime: string;
}

/** 값이 없으면 빈 문자열로 정규화한다. 컬럼이 전부 NOT NULL DEFAULT ''이기 때문. */
function str(value: string | undefined | null): string {
  return value ?? "";
}

/** syncList 항목에서 저장 대상 필드만 뽑는다 (순수 함수). */
export function toTourContentRow(item: TourApiSyncItem): TourContentRow {
  return {
    contentid: str(item.contentid),
    contenttypeid: str(item.contenttypeid),
    title: str(item.title),
    mapx: str(item.mapx),
    mapy: str(item.mapy),
    addr1: str(item.addr1),
    addr2: str(item.addr2),
    zipcode: str(item.zipcode),
    ldongRegnCd: str(item.lDongRegnCd),
    ldongSignguCd: str(item.lDongSignguCd),
    lclsSystm1: str(item.lclsSystm1),
    lclsSystm2: str(item.lclsSystm2),
    lclsSystm3: str(item.lclsSystm3),
    modifiedtime: str(item.modifiedtime),
  };
}
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/lib/tourContent.test.ts`
Expected: PASS — 3개

- [x] **Step 5: 커밋**

```bash
git add core/src/lib/tourContent.ts core/tests/lib/tourContent.test.ts
git commit -m "feat(core): TourContentRow 투영 함수 추가"
```

---

### Task 4: tour_contents DDL과 목록 upsert

테이블을 만들고 목록 항목을 적재한다. **`ON CONFLICT DO UPDATE`가 상태 컬럼을 건드리지 않는 것**이 이 태스크의 핵심 — 건드리면 `collect-list` 재실행 시 지금까지 소비한 API 쿼터가 통째로 무효화된다.

**Files:**
- Create: `core/src/lib/tourContentsTable.ts`
- Test: `core/tests/lib/tourContentsTable.test.ts`

**Interfaces:**
- Consumes: Task 3의 `TourContentRow`
- Produces:
  - `export type DetailStatus = "pending" | "done" | "nodata" | "failed"`
  - `export async function createTourContentsTable(client: PoolClient): Promise<void>`
  - `export async function upsertListedContents(client: PoolClient, rows: TourContentRow[]): Promise<void>`

> **인자 타입 규칙:** 트랜잭션 안에서 실행돼야 하는 함수는 `PoolClient`를, 건당 독립 커밋이 필요한 함수(Task 5)는 `PostgresClient`를 받는다. 이 구분이 "커밋은 건당" 원칙을 타입 수준에서 강제한다.

- [x] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/tourContentsTable.test.ts` 생성:

```ts
import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  createTourContentsTable,
  upsertListedContents,
} from "../../src/lib/tourContentsTable.js";
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
```

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/lib/tourContentsTable.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/tourContentsTable.js'`

- [x] **Step 3: 구현**

`core/src/lib/tourContentsTable.ts` 생성:

```ts
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
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/lib/tourContentsTable.test.ts`
Expected: PASS — 4개

- [x] **Step 5: 커밋**

```bash
git add core/src/lib/tourContentsTable.ts core/tests/lib/tourContentsTable.test.ts
git commit -m "feat(core): tour_contents DDL과 목록 upsert 추가

ON CONFLICT DO UPDATE에서 상태 컬럼을 제외해, collect-list 재실행이
이미 채운 overview를 리셋하지 않도록 한다."
```

---

### Task 5: 상태 조회·전이 쿼리

pending 선택과 처리 결과 반영. `markDetailFailure`가 증가와 전이를 단일 UPDATE로 처리하고 전이 결과를 반환한다.

**Files:**
- Modify: `core/src/lib/tourContentsTable.ts` (함수 추가)
- Test: `core/tests/lib/tourContentsTable.test.ts` (describe 블록 추가)

**Interfaces:**
- Consumes: Task 4의 `DetailStatus`
- Produces:
  - `export async function claimPendingContents(pg: PostgresClient, limit: number): Promise<string[]>`
  - `export async function markDetailDone(pg: PostgresClient, contentid: string, overview: string): Promise<void>`
  - `export async function markDetailNodata(pg: PostgresClient, contentid: string): Promise<void>`
  - `export async function markDetailFailure(pg: PostgresClient, contentid: string, error: string, maxAttempts: number): Promise<DetailStatus>`
  - `export async function countByStatus(pg: PostgresClient): Promise<Record<DetailStatus, number>>`

- [x] **Step 1: 실패하는 테스트 작성**

`core/tests/lib/tourContentsTable.test.ts`에 추가. 파일 상단 import에 함수들을 더한다:

```ts
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
```

파일 끝에 추가:

```ts
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
  it("집계 결과를 채우고 없는 상태는 0으로 만든다", async () => {
    const { pg } = fakePg([
      { detail_status: "pending", count: 10 },
      { detail_status: "done", count: 5 },
    ]);
    expect(await countByStatus(pg)).toEqual({ pending: 10, done: 5, nodata: 0, failed: 0 });
  });
});
```

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/lib/tourContentsTable.test.ts`
Expected: FAIL — `claimPendingContents is not a function` 등

- [x] **Step 3: 구현**

`core/src/lib/tourContentsTable.ts` 상단 import에 추가:

```ts
import type { PostgresClient } from "../clients/postgres.js";
```

파일 끝에 추가:

```ts
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
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/lib/tourContentsTable.test.ts`
Expected: PASS — 10개

- [x] **Step 5: 타입체크**

Run: `cd core && npm run typecheck`
Expected: 오류 없음

- [x] **Step 6: 커밋**

```bash
git add core/src/lib/tourContentsTable.ts core/tests/lib/tourContentsTable.test.ts
git commit -m "feat(core): tour_contents 상태 조회·전이 쿼리 추가

markDetailFailure는 증가와 전이를 단일 UPDATE로 처리하고 RETURNING으로
전이 결과를 돌려줘, 호출자가 재시도 대기와 영구 제외를 구분해 집계한다."
```

---

### Task 6: collectList 서비스

`areaBasedSyncList2`를 페이지 순회하며 `tour_contents`에 적재한다.

**Files:**
- Create: `core/src/services/collectList.ts`
- Test: `core/tests/services/collectList.test.ts`

**Interfaces:**
- Consumes: Task 2의 `getAreaBasedSyncList`/`TourApiPage`, Task 3의 `toTourContentRow`, Task 4의 `createTourContentsTable`/`upsertListedContents`
- Produces:
  - `export interface CollectListOptions { contentTypeId?: string; lDongRegnCd?: string; lDongSignguCd?: string; pageSize?: number; maxPages?: number }`
  - `export interface CollectListResult { fetched: number; apiCalls: number }`
  - `export async function collectList(tourApi: TourApiClient, pg: PostgresClient, opts?: CollectListOptions): Promise<CollectListResult>`

- [x] **Step 1: 실패하는 테스트 작성**

`core/tests/services/collectList.test.ts` 생성:

```ts
import { describe, it, expect, vi } from "vitest";
import { collectList } from "../../src/services/collectList.js";
import type { TourApiClient, TourApiSyncItem, TourApiPage } from "../../src/clients/tourApi.js";
import type { PostgresClient } from "../../src/clients/postgres.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

function syncItem(contentid: string): TourApiSyncItem {
  return {
    contentid,
    contenttypeid: "12",
    title: `제목${contentid}`,
    mapx: "126.9",
    mapy: "37.5",
    addr1: "주소",
    addr2: "",
    zipcode: "03045",
    lDongRegnCd: "11",
    lDongSignguCd: "110",
    lclsSystm1: "AC",
    lclsSystm2: "AC01",
    lclsSystm3: "AC010100",
    createdtime: "20030204092000",
    modifiedtime: "20250101120000",
    showflag: "1",
  };
}

function page(items: TourApiSyncItem[], totalCount: number, pageNo = 1): TourApiPage<TourApiSyncItem> {
  return { items, totalCount, pageNo, numOfRows: 1000 };
}

function fakePg() {
  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  const client = { query: queryMock };
  const pg = {
    transaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
  } as unknown as PostgresClient;
  return { pg, queryMock };
}

describe("collectList", () => {
  it("totalCount에 도달할 때까지 페이지를 순회하고 전부 적재한다", async () => {
    const getAreaBasedSyncList = vi
      .fn()
      .mockResolvedValueOnce(page([syncItem("1"), syncItem("2")], 3, 1))
      .mockResolvedValueOnce(page([syncItem("3")], 3, 2));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg, queryMock } = fakePg();

    const result = await collectList(tourApi, pg, { pageSize: 2 });

    expect(result).toEqual({ fetched: 3, apiCalls: 2 });
    expect(getAreaBasedSyncList).toHaveBeenCalledTimes(2);
    expect(getAreaBasedSyncList.mock.calls[0][0]).toMatchObject({ pageNo: 1, numOfRows: 2 });
    expect(getAreaBasedSyncList.mock.calls[1][0]).toMatchObject({ pageNo: 2 });
    const inserts = queryMock.mock.calls.filter((c) =>
      (c[0] as string).includes("INSERT INTO tour_contents"),
    );
    expect(inserts).toHaveLength(3);
  });

  it("빈 페이지를 만나면 즉시 멈춘다", async () => {
    const getAreaBasedSyncList = vi.fn().mockResolvedValue(page([], 999, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg } = fakePg();

    const result = await collectList(tourApi, pg);

    expect(result).toEqual({ fetched: 0, apiCalls: 1 });
    expect(getAreaBasedSyncList).toHaveBeenCalledTimes(1);
  });

  it("maxPages를 넘기지 않는다", async () => {
    const getAreaBasedSyncList = vi.fn(async () => page([syncItem("1")], 99999, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg } = fakePg();

    const result = await collectList(tourApi, pg, { pageSize: 1, maxPages: 3 });

    expect(result.apiCalls).toBe(3);
    expect(result.fetched).toBe(3);
  });

  it("필터 옵션을 API 파라미터로 전달한다", async () => {
    const getAreaBasedSyncList = vi.fn().mockResolvedValue(page([], 0, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg } = fakePg();

    await collectList(tourApi, pg, {
      contentTypeId: "12",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
    });

    expect(getAreaBasedSyncList.mock.calls[0][0]).toMatchObject({
      contentTypeId: "12",
      lDongRegnCd: "11",
      lDongSignguCd: "110",
    });
  });

  it("테이블 생성을 트랜잭션 안에서 먼저 수행한다", async () => {
    const getAreaBasedSyncList = vi.fn().mockResolvedValue(page([], 0, 1));
    const tourApi = { getAreaBasedSyncList } as unknown as TourApiClient;
    const { pg, queryMock } = fakePg();

    await collectList(tourApi, pg);

    expect((queryMock.mock.calls[0][0] as string)).toContain(
      "CREATE TABLE IF NOT EXISTS tour_contents",
    );
  });
});
```

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/services/collectList.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/collectList.js'`

- [x] **Step 3: 구현**

`core/src/services/collectList.ts` 생성:

```ts
import type { TourApiClient } from "../clients/tourApi.js";
import type { PostgresClient } from "../clients/postgres.js";
import { toTourContentRow } from "../lib/tourContent.js";
import { createTourContentsTable, upsertListedContents } from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 100;

export interface CollectListOptions {
  contentTypeId?: string;
  lDongRegnCd?: string;
  lDongSignguCd?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface CollectListResult {
  fetched: number;
  apiCalls: number;
}

/**
 * areaBasedSyncList2를 페이지 순회하며 tour_contents에 목록을 적재한다.
 * 페이지 단위로 커밋한다 — 목록 호출은 실패해도 같은 페이지를 다시 받으면 그만이라
 * 상세 호출과 달리 소실 비용이 없다.
 */
export async function collectList(
  tourApi: TourApiClient,
  pg: PostgresClient,
  opts: CollectListOptions = {},
): Promise<CollectListResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  await pg.transaction((client) => createTourContentsTable(client));

  let fetched = 0;
  let apiCalls = 0;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const page = await tourApi.getAreaBasedSyncList({
      pageNo,
      numOfRows: pageSize,
      contentTypeId: opts.contentTypeId,
      lDongRegnCd: opts.lDongRegnCd,
      lDongSignguCd: opts.lDongSignguCd,
    });
    apiCalls += 1;

    if (page.items.length === 0) break;

    const rows = page.items.map(toTourContentRow);
    await pg.transaction((client) => upsertListedContents(client, rows));
    fetched += rows.length;
    logger.info(`목록 적재 — ${pageNo}페이지, 누적 ${fetched}/${page.totalCount}건`);

    if (fetched >= page.totalCount) break;
  }

  return { fetched, apiCalls };
}
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/services/collectList.test.ts`
Expected: PASS — 5개

- [x] **Step 5: 커밋**

```bash
git add core/src/services/collectList.ts core/tests/services/collectList.test.ts
git commit -m "feat(core): collectList 서비스 추가 (syncList 페이지 순회 적재)"
```

---

### Task 7: collectDetail 서비스

이 계획의 핵심. 쿼터 예산 내에서 pending을 소진하고, 에러를 성격별로 분기한다.

> **개정 (실행 중 리뷰 반영).** 아래 Step 3의 코드는 **초안이며 실제 구현과 다르다.** 리뷰에서 Critical 1건이 나와 다음이 추가·수정됐다. 현재 상태는 `core/src/services/collectDetail.ts`와 스펙 문서를 보라.
> - `stoppedBy`에 **`"aborted"`** 추가 — 아래 초안의 3값 union은 4값이다
> - **연속 실패 차단기(임계 10)** — 아래 초안에는 없다. 서비스 키 만료·상위 5xx·네트워크 단절은 `isQuotaExceeded`도 `isNoData`도 아니라 일반 오류로 들어오는데, 초안대로면 claim한 900건 전부에 `markDetailFailure`가 호출되어 사흘이면 멀쩡한 콘텐츠 2,700건이 영구 제외된다
> - **`try` 범위를 API 호출로 축소** — 초안은 DB 쓰기까지 감싸 `markDetailDone` 실패를 데이터 문제로 오분류했다
> - **`logger.error` 추가** — 초안은 실패를 전혀 로깅하지 않았다
> - **예산 미소진으로 끝나면 `stoppedBy`를 `"no-pending"`으로 정정** — 초안은 항상 `"budget"`을 반환했다

**세 가지 불변식:**
1. **한도 초과 시 해당 항목의 상태를 절대 바꾸지 않고 즉시 중단한다.** 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이다. 실패로 세면 매일 쿼터가 끝나는 지점의 항목이 사흘 만에 `failed`로 영구 제외된다.
2. **건당 커밋.** 배치 트랜잭션으로 감싸면 중간에 죽을 때 이미 소비한 API 호출이 롤백과 함께 증발한다. 쿼터는 롤백되지 않는다.
3. **NODATA는 재시도하지 않고 종결한다.**

**Files:**
- Create: `core/src/services/collectDetail.ts`
- Test: `core/tests/services/collectDetail.test.ts`

**Interfaces:**
- Consumes: Task 1의 `isNoData`/`isQuotaExceeded`/`TourApiError`, Task 2의 `getDetailCommon`, Task 4의 `createTourContentsTable`, Task 5의 `claimPendingContents`/`markDetailDone`/`markDetailNodata`/`markDetailFailure`/`countByStatus`
- Produces:
  - `export interface CollectDetailOptions { dailyLimit?: number; maxAttempts?: number }`
  - `export interface CollectDetailResult { processed: number; done: number; nodata: number; retryScheduled: number; failed: number; stoppedBy: "budget" | "quota-exceeded" | "no-pending"; remainingPending: number }`
  - `export async function collectDetail(tourApi: TourApiClient, pg: PostgresClient, opts?: CollectDetailOptions): Promise<CollectDetailResult>`

- [x] **Step 1: 실패하는 테스트 작성**

`core/tests/services/collectDetail.test.ts` 생성:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectDetail } from "../../src/services/collectDetail.js";
import { TourApiError } from "../../src/clients/tourApi.js";
import type { TourApiClient } from "../../src/clients/tourApi.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
import * as table from "../../src/lib/tourContentsTable.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/tourContentsTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof table>();
  return {
    ...actual,
    createTourContentsTable: vi.fn().mockResolvedValue(undefined),
    claimPendingContents: vi.fn().mockResolvedValue([]),
    markDetailDone: vi.fn().mockResolvedValue(undefined),
    markDetailNodata: vi.fn().mockResolvedValue(undefined),
    markDetailFailure: vi.fn().mockResolvedValue("pending"),
    countByStatus: vi.fn().mockResolvedValue({ pending: 0, done: 0, nodata: 0, failed: 0 }),
  };
});

const mocked = vi.mocked(table);

function fakePg() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  return {
    transaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as PostgresClient;
}

function fakeApi(getDetailCommon: ReturnType<typeof vi.fn>): TourApiClient {
  return { getDetailCommon } as unknown as TourApiClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createTourContentsTable.mockResolvedValue(undefined);
  mocked.claimPendingContents.mockResolvedValue([]);
  mocked.markDetailFailure.mockResolvedValue("pending");
  mocked.countByStatus.mockResolvedValue({ pending: 0, done: 0, nodata: 0, failed: 0 });
});

describe("collectDetail", () => {
  it("pending이 없으면 API를 호출하지 않고 no-pending으로 끝낸다", async () => {
    const getDetailCommon = vi.fn();
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(getDetailCommon).not.toHaveBeenCalled();
    expect(result.stoppedBy).toBe("no-pending");
    expect(result.processed).toBe(0);
  });

  it("성공 항목마다 overview를 저장하고 done으로 집계한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const getDetailCommon = vi.fn(async (id: string) => ({ contentid: id, overview: `설명${id}` }));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(getDetailCommon).toHaveBeenCalledTimes(2);
    expect(mocked.markDetailDone).toHaveBeenCalledWith(expect.anything(), "1", "설명1");
    expect(mocked.markDetailDone).toHaveBeenCalledWith(expect.anything(), "2", "설명2");
    expect(result).toMatchObject({ processed: 2, done: 2, stoppedBy: "budget" });
  });

  it("dailyLimit을 claimPendingContents에 그대로 전달한다", async () => {
    await collectDetail(fakeApi(vi.fn()), fakePg(), { dailyLimit: 42 });
    expect(mocked.claimPendingContents).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it("기본 dailyLimit은 900이다", async () => {
    await collectDetail(fakeApi(vi.fn()), fakePg());
    expect(mocked.claimPendingContents).toHaveBeenCalledWith(expect.anything(), 900);
  });

  it("NODATA는 nodata로 종결하고 실패 횟수를 올리지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["999"]);
    const getDetailCommon = vi.fn().mockRejectedValue(new TourApiError("03", "NODATA_ERROR"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(mocked.markDetailNodata).toHaveBeenCalledWith(expect.anything(), "999");
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 1, nodata: 1, done: 0 });
  });

  it("한도 초과면 즉시 중단하고 해당 항목의 상태를 바꾸지 않는다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2", "3"]);
    const getDetailCommon = vi
      .fn()
      .mockResolvedValueOnce({ contentid: "1", overview: "설명1" })
      .mockRejectedValueOnce(new TourApiError("22", "LIMITED"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());

    expect(getDetailCommon).toHaveBeenCalledTimes(2);
    expect(mocked.markDetailFailure).not.toHaveBeenCalled();
    expect(mocked.markDetailNodata).not.toHaveBeenCalled();
    expect(mocked.markDetailDone).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      processed: 1,
      done: 1,
      stoppedBy: "quota-exceeded",
    });
  });

  it("일반 오류는 실패로 기록하고 다음 항목을 계속 처리한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2"]);
    const getDetailCommon = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ contentid: "2", overview: "설명2" });
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg(), { maxAttempts: 3 });

    expect(mocked.markDetailFailure).toHaveBeenCalledWith(
      expect.anything(),
      "1",
      "ECONNRESET",
      3,
    );
    expect(result).toMatchObject({ processed: 2, done: 1, retryScheduled: 1, failed: 0 });
  });

  it("maxAttempts 도달로 failed 전이되면 failed로 집계한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    mocked.markDetailFailure.mockResolvedValue("failed");
    const getDetailCommon = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(result).toMatchObject({ failed: 1, retryScheduled: 0 });
  });

  it("배치 트랜잭션으로 감싸지 않는다 (테이블 생성 1회만 트랜잭션 사용)", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1", "2", "3"]);
    const getDetailCommon = vi.fn(async (id: string) => ({ contentid: id, overview: "x" }));
    const pg = fakePg();
    await collectDetail(fakeApi(getDetailCommon), pg);
    expect(vi.mocked(pg.transaction)).toHaveBeenCalledTimes(1);
  });

  it("overview가 없는 응답은 빈 문자열로 저장한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1" });
    await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(mocked.markDetailDone).toHaveBeenCalledWith(expect.anything(), "1", "");
  });

  it("종료 후 남은 pending 건수를 재조회해 반환한다", async () => {
    mocked.claimPendingContents.mockResolvedValue(["1"]);
    mocked.countByStatus
      .mockResolvedValueOnce({ pending: 10, done: 0, nodata: 0, failed: 0 })
      .mockResolvedValueOnce({ pending: 9, done: 1, nodata: 0, failed: 0 });
    const getDetailCommon = vi.fn().mockResolvedValue({ contentid: "1", overview: "설명" });
    const result = await collectDetail(fakeApi(getDetailCommon), fakePg());
    expect(result.remainingPending).toBe(9);
  });
});
```

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/services/collectDetail.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/collectDetail.js'`

- [x] **Step 3: 구현**

`core/src/services/collectDetail.ts` 생성:

```ts
import type { TourApiClient } from "../clients/tourApi.js";
import type { PostgresClient } from "../clients/postgres.js";
import { isNoData, isQuotaExceeded } from "../clients/tourApi.js";
import {
  claimPendingContents,
  countByStatus,
  createTourContentsTable,
  markDetailDone,
  markDetailFailure,
  markDetailNodata,
} from "../lib/tourContentsTable.js";
import { logger } from "../lib/logger.js";

const DEFAULT_DAILY_LIMIT = 900;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface CollectDetailOptions {
  /** 이번 실행에서 소비할 최대 API 호출 수. 기본 900 (일 1,000건 중 여유분 100 확보). */
  dailyLimit?: number;
  /** 이 횟수만큼 실패하면 failed로 제외한다. 기본 3. */
  maxAttempts?: number;
}

export interface CollectDetailResult {
  processed: number;
  done: number;
  nodata: number;
  /** 실패했으나 pending 유지 — 다음 실행에서 재시도된다. */
  retryScheduled: number;
  /** maxAttempts 도달로 제외됨. */
  failed: number;
  stoppedBy: "budget" | "quota-exceeded" | "no-pending";
  remainingPending: number;
}

/**
 * pending 항목의 overview를 detailCommon2로 채운다.
 *
 * 재개는 별도 커서 없이 성립한다 — detail_status='pending' 조회 자체가 남은 일 목록이므로,
 * 프로세스가 어떻게 종료되든 다음 실행이 이어받는다.
 */
export async function collectDetail(
  tourApi: TourApiClient,
  pg: PostgresClient,
  opts: CollectDetailOptions = {},
): Promise<CollectDetailResult> {
  const dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  await pg.transaction((client) => createTourContentsTable(client));

  const before = await countByStatus(pg);
  logger.info(
    `시작 — pending ${before.pending} / done ${before.done} / ` +
      `nodata ${before.nodata} / failed ${before.failed}, 오늘 예산 ${dailyLimit}`,
  );

  const contentIds = await claimPendingContents(pg, dailyLimit);

  let processed = 0;
  let done = 0;
  let nodata = 0;
  let retryScheduled = 0;
  let failed = 0;
  let stoppedBy: CollectDetailResult["stoppedBy"] =
    contentIds.length === 0 ? "no-pending" : "budget";

  for (const contentid of contentIds) {
    try {
      const detail = await tourApi.getDetailCommon(contentid);
      await markDetailDone(pg, contentid, detail.overview ?? "");
      done += 1;
    } catch (error) {
      // 한도 초과는 데이터의 문제가 아니라 호출자 사정이다.
      // 항목의 상태를 바꾸지 않고 중단해야, 매일 예산 경계의 항목이 실패를 누적하지 않는다.
      if (isQuotaExceeded(error)) {
        stoppedBy = "quota-exceeded";
        break;
      }
      if (isNoData(error)) {
        await markDetailNodata(pg, contentid);
        nodata += 1;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const status = await markDetailFailure(pg, contentid, message, maxAttempts);
        if (status === "failed") {
          failed += 1;
        } else {
          retryScheduled += 1;
        }
      }
    }
    processed += 1;
  }

  const after = await countByStatus(pg);
  return {
    processed,
    done,
    nodata,
    retryScheduled,
    failed,
    stoppedBy,
    remainingPending: after.pending,
  };
}
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/services/collectDetail.test.ts`
Expected: PASS — 11개

- [x] **Step 5: 타입체크**

Run: `cd core && npm run typecheck`
Expected: 오류 없음

- [x] **Step 6: 커밋**

```bash
git add core/src/services/collectDetail.ts core/tests/services/collectDetail.test.ts
git commit -m "feat(core): collectDetail 서비스 추가 (쿼터 예산 + 에러 분기)

한도 초과 시 해당 항목의 상태를 바꾸지 않고 중단한다. 실패로 세면 매일
예산 경계의 항목이 사흘 만에 failed로 영구 제외되기 때문이다.
건당 커밋으로 중단 시 소비한 호출이 롤백과 함께 사라지지 않게 한다."
```

---

### Task 8: CLI 커맨드 배선

두 서비스를 `tb` CLI에 연결한다.

**Files:**
- Create: `core/src/commands/collectList.ts`
- Create: `core/src/commands/collectDetail.ts`
- Modify: `core/src/index.ts`
- Test: `core/tests/commands/collectDetail.test.ts`

**Interfaces:**
- Consumes: Task 6의 `collectList`/`CollectListOptions`, Task 7의 `collectDetail`/`CollectDetailResult`
- Produces:
  - `export function registerCollectList(program: Command): void`
  - `export function registerCollectDetail(program: Command): void`
  - `export function formatCollectDetailSummary(result: CollectDetailResult): string`

- [x] **Step 1: 실패하는 테스트 작성**

출력 요약은 `stoppedBy`에 따라 안내가 갈리므로 순수 함수로 분리해 테스트한다.

`core/tests/commands/collectDetail.test.ts` 생성:

```ts
import { describe, it, expect } from "vitest";
import { formatCollectDetailSummary } from "../../src/commands/collectDetail.js";
import type { CollectDetailResult } from "../../src/services/collectDetail.js";

function result(overrides: Partial<CollectDetailResult> = {}): CollectDetailResult {
  return {
    processed: 900,
    done: 880,
    nodata: 15,
    retryScheduled: 5,
    failed: 0,
    stoppedBy: "budget",
    remainingPending: 334,
    ...overrides,
  };
}

describe("formatCollectDetailSummary", () => {
  it("처리 내역과 남은 건수를 담는다", () => {
    const text = formatCollectDetailSummary(result());
    expect(text).toContain("처리 900건");
    expect(text).toContain("done 880");
    expect(text).toContain("nodata 15");
    expect(text).toContain("재시도대기 5");
    expect(text).toContain("남은 pending 334건");
  });

  it("예산 소진이면 내일 재실행을 안내한다", () => {
    expect(formatCollectDetailSummary(result({ stoppedBy: "budget" }))).toContain(
      "내일 다시 실행하세요",
    );
  });

  it("API 한도 초과면 다른 작업의 소비를 확인하라고 안내한다", () => {
    const text = formatCollectDetailSummary(result({ stoppedBy: "quota-exceeded" }));
    expect(text).toContain("API 일일 한도");
    expect(text).toContain("다른 작업");
  });

  it("연속 실패 중단이면 서비스 키와 네트워크를 확인하라고 안내한다", () => {
    const text = formatCollectDetailSummary(result({ stoppedBy: "aborted" }));
    expect(text).toContain("연속 실패");
    expect(text).toContain("서비스 키");
  });

  it("pending이 없으면 완료를 알린다", () => {
    const text = formatCollectDetailSummary(
      result({ stoppedBy: "no-pending", processed: 0, done: 0, nodata: 0, retryScheduled: 0, remainingPending: 0 }),
    );
    expect(text).toContain("모든 항목 처리 완료");
  });

  it("failed가 있으면 건수를 함께 알린다", () => {
    expect(formatCollectDetailSummary(result({ failed: 3 }))).toContain("failed 3");
  });
});
```

- [x] **Step 2: 테스트 실패 확인**

Run: `cd core && npx vitest run tests/commands/collectDetail.test.ts`
Expected: FAIL — `Cannot find module '../../src/commands/collectDetail.js'`

- [x] **Step 3: 구현**

`core/src/commands/collectList.ts` 생성:

```ts
import type { Command } from "commander";
import { TourApiClient } from "../clients/tourApi.js";
import { PostgresClient } from "../clients/postgres.js";
import { collectList } from "../services/collectList.js";
import { logger } from "../lib/logger.js";

interface CollectListCliOptions {
  contentType?: string;
  ldongRegn?: string;
  ldongSigngu?: string;
  pageSize?: string;
  maxPages?: string;
}

/** commander program에 `collect-list` 명령을 등록한다. */
export function registerCollectList(program: Command): void {
  program
    .command("collect-list")
    .description("TourAPI 동기화 목록을 tour_contents에 적재 (detail_status=pending)")
    .option("--content-type <id>", "관광타입 코드 (예: 12)")
    .option("--ldong-regn <cd>", "법정동 시도 코드 (예: 11)")
    .option("--ldong-signgu <cd>", "법정동 시군구 코드 (예: 110)")
    .option("--page-size <n>", "페이지당 건수", "1000")
    .option("--max-pages <n>", "최대 페이지 수", "100")
    .action(async (options: CollectListCliOptions) => {
      const tourApi = new TourApiClient();
      const pg = new PostgresClient();
      await pg.connect();
      try {
        const result = await collectList(tourApi, pg, {
          contentTypeId: options.contentType,
          lDongRegnCd: options.ldongRegn,
          lDongSignguCd: options.ldongSigngu,
          pageSize: Number(options.pageSize ?? 1000),
          maxPages: Number(options.maxPages ?? 100),
        });
        logger.info(
          `목록 적재 완료 — ${result.fetched}건, API 호출 ${result.apiCalls}회`,
        );
      } finally {
        await pg.close();
      }
    });
}
```

`core/src/commands/collectDetail.ts` 생성:

```ts
import type { Command } from "commander";
import { TourApiClient } from "../clients/tourApi.js";
import { PostgresClient } from "../clients/postgres.js";
import { collectDetail } from "../services/collectDetail.js";
import type { CollectDetailResult } from "../services/collectDetail.js";
import { logger } from "../lib/logger.js";

interface CollectDetailCliOptions {
  dailyLimit?: string;
  maxAttempts?: string;
}

const NEXT_STEP: Record<CollectDetailResult["stoppedBy"], string> = {
  budget: "내일 다시 실행하세요.",
  "quota-exceeded":
    "API 일일 한도에 도달했습니다. 다른 작업이 한도를 사용했는지 확인하세요.",
  aborted:
    "연속 실패로 중단했습니다. 서비스 키 만료 여부와 네트워크를 확인한 뒤 다시 실행하세요.",
  "no-pending": "모든 항목 처리 완료.",
};

/** collect-detail 실행 결과를 사람이 읽을 요약으로 만든다 (순수 함수). */
export function formatCollectDetailSummary(result: CollectDetailResult): string {
  const breakdown = [
    `done ${result.done}`,
    `nodata ${result.nodata}`,
    `재시도대기 ${result.retryScheduled}`,
    `failed ${result.failed}`,
  ].join(", ");
  return (
    `종료 — 처리 ${result.processed}건 (${breakdown})\n` +
    `       남은 pending ${result.remainingPending}건. ${NEXT_STEP[result.stoppedBy]}`
  );
}

/** commander program에 `collect-detail` 명령을 등록한다. */
export function registerCollectDetail(program: Command): void {
  program
    .command("collect-detail")
    .description("pending 콘텐츠의 overview를 detailCommon2로 채움 (중단 시 재실행하면 이어서)")
    .option("--daily-limit <n>", "이번 실행에서 소비할 최대 API 호출 수", "900")
    .option("--max-attempts <n>", "이 횟수만큼 실패하면 제외", "3")
    .action(async (options: CollectDetailCliOptions) => {
      const tourApi = new TourApiClient();
      const pg = new PostgresClient();
      await pg.connect();
      try {
        const result = await collectDetail(tourApi, pg, {
          dailyLimit: Number(options.dailyLimit ?? 900),
          maxAttempts: Number(options.maxAttempts ?? 3),
        });
        logger.info(formatCollectDetailSummary(result));
      } finally {
        await pg.close();
      }
    });
}
```

`core/src/index.ts`를 수정 — import 두 줄과 register 두 줄을 추가:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { registerHello } from "./commands/hello.js";
import { registerGenerateTourCodes } from "./commands/generateTourCodes.js";
import { registerCollectList } from "./commands/collectList.js";
import { registerCollectDetail } from "./commands/collectDetail.js";

const program = new Command();

program
  .name("tb")
  .description("travel-builder 개발/운영 보조 CLI")
  .version("0.1.0");

registerHello(program);
registerGenerateTourCodes(program);
registerCollectList(program);
registerCollectDetail(program);

await program.parseAsync();
```

- [x] **Step 4: 테스트 통과 확인**

Run: `cd core && npx vitest run tests/commands/collectDetail.test.ts`
Expected: PASS — 5개

- [x] **Step 5: 전체 검증**

Run: `cd core && npm run typecheck && npm test && npm run build`
Expected: 타입 오류 없음, 전체 테스트 통과, 빌드 성공

- [x] **Step 6: CLI 등록 확인 (API 호출 없음)**

Run: `cd core && npx tsx src/index.ts --help`
Expected: 출력에 `collect-list`와 `collect-detail`이 보인다

Run: `cd core && npx tsx src/index.ts collect-detail --help`
Expected: `--daily-limit`, `--max-attempts` 옵션이 보인다

> 이 두 명령은 `--help`만 실행하므로 `.env`나 DB 연결이 필요 없다.

- [x] **Step 7: 커밋**

```bash
git add core/src/commands/collectList.ts core/src/commands/collectDetail.ts \
        core/src/index.ts core/tests/commands/collectDetail.test.ts
git commit -m "feat(core): tb collect-list / collect-detail 커맨드 추가"
```

---

### Task 9: 실제 API 스모크 테스트 (쿼터 소비 주의)

**⚠️ 이 태스크만 실제 TourAPI 쿼터를 소비한다 (약 12~15건).** 앞의 모든 태스크가 통과한 뒤에만 실행한다.

> **⛔ 2026-07-25 현재 네트워크 차단으로 미실행.** `DATABASE_URL`의 호스트가 사내망(`10.173.71.108:5432`)인데
> 실행 환경은 외부망(`192.168.219.0/24`)이라 ping·TCP 5432 모두 무응답이다. TourAPI(`apis.data.go.kr:443`)는 도달 가능하므로
> 남은 조건은 DB 접근뿐이다. **사내망 또는 VPN에서 Step 3부터 그대로 재개하면 된다.**
> 코드·테스트는 전부 통과 상태이므로 이 태스크 외에 남은 작업은 없다.

**Files:**
- 코드 변경 없음. 검증만 수행.

**Interfaces:**
- Consumes: Task 8의 CLI 커맨드 전체
- Produces: 없음

- [x] **Step 1: 사전 조건 확인**

Run: `cd core && grep -c "TOUR_API_SERVICE_KEY\|DATABASE_URL" .env`
Expected: `2` — 둘 다 설정돼 있어야 한다. 아니면 여기서 멈추고 사용자에게 알린다.

> 확인 완료 — `2`. 다만 `DATABASE_URL`의 호스트가 현재 망에서 도달 불가(위 ⛔ 참고).

- [x] **Step 2: 코드표 적재 여부 확인**

`generate-tour-codes`를 아직 실행하지 않았다면 이번 스코프에서는 실행하지 않아도 된다 — `collect-list`/`collect-detail`은 코드표를 참조하지 않는다. 이 단계는 건너뛴다.

- [ ] **Step 3: 소량 목록 적재 (API 호출 1회)**

Run: `cd core && npx tsx --env-file=.env src/index.ts collect-list --content-type 12 --ldong-regn 11 --page-size 10 --max-pages 1`
Expected: `목록 적재 완료 — 10건, API 호출 1회`

- [ ] **Step 4: 1차 상세 수집 (API 호출 5회)**

Run: `cd core && npx tsx --env-file=.env src/index.ts collect-detail --daily-limit 5`
Expected: 출력에 `시작 — pending 10`, 그리고 `종료 — 처리 5건 (done 5, ...)` 와 `남은 pending 5건. 내일 다시 실행하세요.`

- [ ] **Step 5: 2차 상세 수집으로 재개 검증 (API 호출 5회)**

Run: `cd core && npx tsx --env-file=.env src/index.ts collect-detail --daily-limit 5`
Expected: `시작 — pending 5 / done 5 ...` 로 시작하고 `종료 — 처리 5건`, `남은 pending 0건. 내일 다시 실행하세요.`

**이 단계가 재개의 핵심 검증이다** — 2차 실행이 1차가 이미 처리한 5건을 건너뛰고 나머지 5건만 처리해야 한다. 만약 2차가 다시 10건을 대상으로 잡거나 `pending 10`으로 시작하면 `markDetailDone`이나 `claimPendingContents`가 잘못된 것이다.

- [ ] **Step 6: 세 번째 실행으로 종료 조건 검증 (API 호출 0회)**

Run: `cd core && npx tsx --env-file=.env src/index.ts collect-detail --daily-limit 5`
Expected: `종료 — 처리 0건 ...` 와 `모든 항목 처리 완료.` — **API를 한 번도 호출하지 않아야 한다.**

- [ ] **Step 7: 목록 재적재가 완료분을 밟지 않는지 검증 (API 호출 1회)**

Run: `cd core && npx tsx --env-file=.env src/index.ts collect-list --content-type 12 --ldong-regn 11 --page-size 10 --max-pages 1`
Run: `cd core && npx tsx --env-file=.env src/index.ts collect-detail --daily-limit 5`
Expected: 두 번째 명령이 `모든 항목 처리 완료.`로 끝난다 — 목록 재적재가 `done`을 `pending`으로 되돌리지 않았다는 뜻이다. 만약 `처리 5건`이 나오면 Task 4의 `ON CONFLICT DO UPDATE`에 상태 컬럼이 새어 들어간 것이다.

- [ ] **Step 8: 결과 보고**

스모크 테스트에서 소비한 총 API 호출 수(약 12회)와 각 단계 결과를 사용자에게 보고한다. 코드 변경이 없으므로 커밋하지 않는다.

---

## 완료 기준

- [x] `cd core && npm run typecheck` 통과
- [x] `cd core && npm test` 전체 통과
- [x] `cd core && npm run build` 성공
- [ ] Task 9 Step 5에서 2차 실행이 1차 처리분을 건너뛰는 것을 확인
- [ ] Task 9 Step 7에서 목록 재적재가 `done`을 되돌리지 않는 것을 확인
