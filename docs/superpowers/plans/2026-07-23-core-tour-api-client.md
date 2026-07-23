# TourApiClient(한국관광공사 TourAPI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `core`에 한국관광공사 TourAPI 4.0(KorService2) 연동 클래스 `TourApiClient`를 TDD로 구현한다. 지역기반 목록조회와 상세(공통/소개/이미지) 조회를 지원한다.

**Architecture:** 무상태 HTTP 래퍼(GeminiClient와 동일 패턴). 서비스키는 이미 인코딩된 값이므로 axios `params` 옵션을 쓰지 않고 URL을 문자열로 직접 조립해 이중 인코딩을 피한다. TourAPI 응답 특유의 `items` 모양 불일치(0/1/N건)를 내부 `normalizeItems` 헬퍼로 정규화하고, `resultCode !== "0000"`이면 throw한다.

**Tech Stack:** TypeScript(ESM/NodeNext), axios, Vitest.

---

## File Structure

- `core/src/clients/tourApi.ts` — `TourApiClient` (신규)
- `core/tests/clients/tourApi.test.ts` — 단위 테스트 (신규)
- `core/package.json` — `axios` 의존성 추가 (수정)

> **ESM/NodeNext 규칙:** 상대 import는 `.js` 확장자 사용. **작업 디렉토리:** npm/npx/node는 `core/`에서, git은 저장소 루트 `C:\workspace\travel-buider`에서. 브랜치 `feat/core-cli`.

> **TourAPI 실제 JSON 응답 모양(중요):** `response.body.items`는 결과 0건이면 빈 문자열 `""`, 1건 이상이면 `{ item: T }`(단일 객체) 또는 `{ item: T[] }`(배열)이다. 즉 정규화 대상은 `items.item`이지 `items` 자체가 아니다.

---

## Task 1: axios 의존성 설치

**Files:**
- Modify: `core/package.json` (npm이 자동 갱신)

- [ ] **Step 1: 설치**

Run (in `core/`): `npm install axios`
Expected: 오류 없이 설치, `package.json` dependencies에 `axios` 추가.

- [ ] **Step 2: 타입체크로 확인**

Run (in `core/`): `npm run typecheck`
Expected: exit 0 (기존 코드 영향 없음, axios는 자체 타입 내장).

- [ ] **Step 3: Commit**

```bash
git add core/package.json core/package-lock.json
git commit -m "chore: axios 의존성 추가 (TourApiClient용)"
```

---

## Task 2: TourApiClient (TDD)

**Files:**
- Create: `core/tests/clients/tourApi.test.ts`
- Create: `core/src/clients/tourApi.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`core/tests/clients/tourApi.test.ts`)**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("axios", () => ({
  default: { get: getMock },
}));

import { TourApiClient } from "../../src/clients/tourApi.js";

function envelope(items: unknown, resultCode = "0000", resultMsg = "OK") {
  return {
    data: {
      response: {
        header: { resultCode, resultMsg },
        body: { items, numOfRows: 10, pageNo: 1, totalCount: 0 },
      },
    },
  };
}

beforeEach(() => {
  getMock.mockReset();
  process.env.TOUR_API_SERVICE_KEY = "abc%2Bdef%3D";
  delete process.env.TOUR_API_BASE_URL;
});

afterEach(() => {
  delete process.env.TOUR_API_SERVICE_KEY;
  delete process.env.TOUR_API_BASE_URL;
});

describe("TourApiClient", () => {
  it("TOUR_API_SERVICE_KEY 없으면 생성자에서 throw", () => {
    delete process.env.TOUR_API_SERVICE_KEY;
    expect(() => new TourApiClient()).toThrow("TOUR_API_SERVICE_KEY");
  });

  it("getAreaBasedList가 기본 numOfRows/pageNo로 요청하고 서비스키를 재인코딩하지 않는다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await client.getAreaBasedList();
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("https://apis.data.go.kr/B551011/KorService2/areaBasedList2?");
    expect(url).toContain("serviceKey=abc%2Bdef%3D");
    expect(url).toContain("MobileOS=ETC");
    expect(url).toContain("MobileApp=travel-builder");
    expect(url).toContain("_type=json");
    expect(url).toContain("numOfRows=10");
    expect(url).toContain("pageNo=1");
  });

  it("동적 파라미터는 encodeURIComponent로 인코딩된다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await client.getAreaBasedList({ arrangeType: "A&B" });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain(`arrangeType=${encodeURIComponent("A&B")}`);
  });

  it("undefined인 선택 파라미터는 쿼리에서 생략된다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await client.getAreaBasedList();
    const url = getMock.mock.calls[0][0] as string;
    expect(url).not.toContain("areaCode=");
  });

  it("items가 빈 문자열이면 빈 배열을 반환한다 (0건)", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    const result = await client.getAreaBasedList();
    expect(result).toEqual([]);
  });

  it("items.item이 단일 객체면 배열로 정규화한다 (1건)", async () => {
    const single = { contentid: "1", title: "단일 관광지" };
    getMock.mockResolvedValue(envelope({ item: single }));
    const client = new TourApiClient();
    const result = await client.getAreaBasedList();
    expect(result).toEqual([single]);
  });

  it("items.item이 배열이면 그대로 반환한다 (N건)", async () => {
    const many = [{ contentid: "1" }, { contentid: "2" }];
    getMock.mockResolvedValue(envelope({ item: many }));
    const client = new TourApiClient();
    const result = await client.getAreaBasedList();
    expect(result).toEqual(many);
  });

  it("resultCode가 0000이 아니면 resultMsg를 포함해 throw한다", async () => {
    getMock.mockResolvedValue(envelope("", "3000", "잘못된 요청 파라미터입니다"));
    const client = new TourApiClient();
    await expect(client.getAreaBasedList()).rejects.toThrow("잘못된 요청 파라미터입니다");
  });

  it("getDetailCommon이 단일 객체를 반환한다", async () => {
    const detail = { contentid: "1", title: "상세", overview: "설명" };
    getMock.mockResolvedValue(envelope({ item: detail }));
    const client = new TourApiClient();
    const result = await client.getDetailCommon("1");
    expect(result).toEqual(detail);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("detailCommon2?");
    expect(url).toContain("contentId=1");
  });

  it("getDetailCommon이 결과 없으면 throw한다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await expect(client.getDetailCommon("999")).rejects.toThrow("999");
  });

  it("getDetailIntro가 Record<string,string>를 그대로 반환한다", async () => {
    const intro = { contentid: "1", checkintime: "15:00", checkouttime: "11:00" };
    getMock.mockResolvedValue(envelope({ item: intro }));
    const client = new TourApiClient();
    const result = await client.getDetailIntro("1", "32");
    expect(result).toEqual(intro);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("detailIntro2?");
    expect(url).toContain("contentTypeId=32");
  });

  it("getDetailImages가 이미지가 없으면 빈 배열을 반환한다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    const result = await client.getDetailImages("1");
    expect(result).toEqual([]);
  });

  it("getDetailImages가 여러 이미지를 배열로 반환한다", async () => {
    const images = [
      { contentid: "1", imgname: "a.jpg" },
      { contentid: "1", imgname: "b.jpg" },
    ];
    getMock.mockResolvedValue(envelope({ item: images }));
    const client = new TourApiClient();
    const result = await client.getDetailImages("1");
    expect(result).toEqual(images);
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: FAIL — `../../src/clients/tourApi.js` 없음.

- [ ] **Step 3: 구현 (`core/src/clients/tourApi.ts`)**

```typescript
import axios from "axios";
import { optionalEnv, requireEnv } from "../lib/env.js";

const MOBILE_OS = "ETC";
const MOBILE_APP = "travel-builder";
const DEFAULT_BASE_URL = "https://apis.data.go.kr/B551011/KorService2";

export interface TourApiListParams {
  areaCode?: string;
  sigunguCode?: string;
  cat1?: string;
  cat2?: string;
  cat3?: string;
  contentTypeId?: string;
  numOfRows?: number;
  pageNo?: number;
  arrangeType?: string;
}

export interface TourApiAreaItem {
  contentid: string;
  contenttypeid: string;
  title: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  tel: string;
  firstimage: string;
  firstimage2: string;
  mapx: string;
  mapy: string;
  areacode: string;
  sigungucode: string;
  cat1: string;
  cat2: string;
  cat3: string;
  createdtime: string;
  modifiedtime: string;
}

export interface TourApiDetailCommon {
  contentid: string;
  contenttypeid: string;
  title: string;
  createdtime: string;
  modifiedtime: string;
  tel: string;
  telname: string;
  homepage: string;
  firstimage: string;
  firstimage2: string;
  areacode: string;
  sigungucode: string;
  cat1: string;
  cat2: string;
  cat3: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  mapx: string;
  mapy: string;
  overview: string;
}

export interface TourApiImage {
  contentid: string;
  imgname: string;
  originimgurl: string;
  serialnum: string;
  smallimageurl: string;
  cpyrhtDivCd: string;
}

interface TourApiEnvelope<T> {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: {
      items: { item?: T | T[] } | "";
      numOfRows: number;
      pageNo: number;
      totalCount: number;
    };
  };
}

function normalizeItems<T>(items: { item?: T | T[] } | ""): T[] {
  if (items === "") return [];
  const item = items.item;
  if (item === undefined) return [];
  return Array.isArray(item) ? item : [item];
}

/** 한국관광공사 TourAPI 4.0(KorService2) 연동 클라이언트 (무상태). */
export class TourApiClient {
  private readonly serviceKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.serviceKey = requireEnv("TOUR_API_SERVICE_KEY");
    this.baseUrl = optionalEnv("TOUR_API_BASE_URL", DEFAULT_BASE_URL);
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const fixed = `serviceKey=${this.serviceKey}&MobileOS=${MOBILE_OS}&MobileApp=${MOBILE_APP}&_type=json`;
    const dynamic = Object.entries(params)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("&");
    return dynamic ? `${this.baseUrl}/${path}?${fixed}&${dynamic}` : `${this.baseUrl}/${path}?${fixed}`;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const url = this.buildUrl(path, params);
    const { data } = await axios.get<TourApiEnvelope<T>>(url);
    if (data.response.header.resultCode !== "0000") {
      throw new Error(
        `TourAPI 오류(${data.response.header.resultCode}): ${data.response.header.resultMsg}`,
      );
    }
    return normalizeItems(data.response.body.items);
  }

  /** 지역기반 관광정보 목록을 조회한다. */
  async getAreaBasedList(params: TourApiListParams = {}): Promise<TourApiAreaItem[]> {
    return this.request<TourApiAreaItem>("areaBasedList2", {
      numOfRows: params.numOfRows ?? 10,
      pageNo: params.pageNo ?? 1,
      areaCode: params.areaCode,
      sigunguCode: params.sigunguCode,
      cat1: params.cat1,
      cat2: params.cat2,
      cat3: params.cat3,
      contentTypeId: params.contentTypeId,
      arrangeType: params.arrangeType,
    });
  }

  /** 관광지 공통정보를 조회한다. */
  async getDetailCommon(contentId: string): Promise<TourApiDetailCommon> {
    const items = await this.request<TourApiDetailCommon>("detailCommon2", {
      contentId,
      defaultYN: "Y",
      firstImageYN: "Y",
      areacodeYN: "Y",
      catcodeYN: "Y",
      addrinfoYN: "Y",
      mapinfoYN: "Y",
      overviewYN: "Y",
    });
    if (items.length === 0) {
      throw new Error(`TourAPI: contentId=${contentId}에 대한 공통정보를 찾을 수 없습니다.`);
    }
    return items[0];
  }

  /** 관광지 소개정보를 조회한다. contentTypeId에 따라 필드 구성이 달라 원본 키-값으로 반환한다. */
  async getDetailIntro(contentId: string, contentTypeId: string): Promise<Record<string, string>> {
    const items = await this.request<Record<string, string>>("detailIntro2", {
      contentId,
      contentTypeId,
    });
    if (items.length === 0) {
      throw new Error(
        `TourAPI: contentId=${contentId}, contentTypeId=${contentTypeId}에 대한 소개정보를 찾을 수 없습니다.`,
      );
    }
    return items[0];
  }

  /** 관광지 이미지 목록을 조회한다. 이미지가 없으면 빈 배열을 반환한다. */
  async getDetailImages(contentId: string): Promise<TourApiImage[]> {
    return this.request<TourApiImage>("detailImage2", {
      contentId,
      imageYN: "Y",
      numOfRows: 100,
      pageNo: 1,
    });
  }
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/tourApi.test.ts`
Expected: PASS — 13개 통과.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0. (만약 axios의 실제 `.get<T>` 제네릭 시그니처가 위 코드와 미세하게 달라 오류가 나면, `node_modules/axios`의 실제 타입 선언을 확인해 시그니처만 맞추고 `any`/`as any`는 쓰지 않는다. 공개 메서드 시그니처와 테스트가 기대하는 동작은 그대로 유지한다.)

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/tourApi.ts core/tests/clients/tourApi.test.ts
git commit -m "feat: TourApiClient(한국관광공사 TourAPI) 추가 (TDD)"
```

---

## Task 3: 전체 검증

**Files:**
- (신규 파일 없음 — 통합 검증)

- [ ] **Step 1: 전체 타입체크 (src + tests)**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: 전체 테스트**

Run (in `core/`): `npm test`
Expected: 모든 테스트 PASS (기존 31개 + tourApi 13개 = 44개).

- [ ] **Step 3: 빌드**

Run (in `core/`): `npm run build`
Expected: 오류 없이 `dist/clients/tourApi.js` 생성.

- [ ] **Step 4: (커밋할 신규 소스 없음 — dist는 gitignore, 스킵)**

---

## Self-Review 결과

**Spec coverage:**
- axios 의존성 → Task 1.
- `TourApiClient` 생성자(env 자동 로딩, `TOUR_API_SERVICE_KEY` 필수/`TOUR_API_BASE_URL` 선택) → Task 2.
- 서비스키 재인코딩 방지(URL 직접 조립) → Task 2 `buildUrl`.
- `getAreaBasedList`/`getDetailCommon`/`getDetailIntro`/`getDetailImages` → Task 2.
- `items.item` 정규화(0/1/N건) → Task 2 `normalizeItems` + 테스트 3케이스.
- `resultCode` 에러 처리 → Task 2 `request` + 테스트.
- `getDetailIntro`의 `Record<string,string>` 반환(YAGNI 결정) → Task 2.
- `MobileOS`/`MobileApp` 상수 고정 → Task 2.
- 검증(typecheck/test/build) → Task 3.

**Placeholder scan:** 모든 코드/명령이 실제 내용. 플레이스홀더 없음.

**Type consistency:** `TourApiListParams`/`TourApiAreaItem`/`TourApiDetailCommon`/`TourApiImage`/`TourApiEnvelope<T>` 필드명이 구현·테스트 전반에서 일치. `normalizeItems<T>(items: { item?: T | T[] } | "")` 시그니처가 `request<T>` 내부 호출과 일치. import는 모두 `.js` 확장자 사용.
