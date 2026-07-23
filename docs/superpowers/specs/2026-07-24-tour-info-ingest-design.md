# core 관광정보 수집·필드 선별 설계 (TourAPI fetch + projection)

- 날짜: 2026-07-24
- 위치: `core/`
- 상태: 초안 (검토 대기)

## 목적

한국관광공사 KorService2(v4.4)에서 전체 관광정보를 가져와, **필요한 필드만 골라낸(projection) 메모리 객체 배열로 반환**한다. 이번 단계에서는 **DB·파일 저장을 하지 않는다.** 반환된 객체가 이후 단계(저장/임베딩 등)의 입력이 된다.

## 결정 사항

| 항목 | 선택 |
|------|------|
| 목록 오퍼레이션 | `areaBasedSyncList2` (동기화 목록) |
| 세부 오퍼레이션 | `detailCommon2`만 — `overview` 확보 목적 (이미지 등 나머지 제외) |
| 걸러내기 방식 | **필드 선별(projection)만.** 행(row) 필터링·조건 선별은 하지 않음 (전 항목 유지) |
| 결과 출력 | **메모리 객체 배열 반환.** DB·파일·stdout 저장 없음 |
| 병합 | syncList 항목 + 해당 콘텐츠의 `detailCommon.overview`를 합쳐 `TourContent`로 투영 |

## 필요 필드 (projection 결과 `TourContent`)

```ts
interface TourContent {
  contentid: string;      // 기본
  contenttypeid: string;  // 기본
  title: string;          // 기본
  overview: string;       // detailCommon2 (이것만 세부에서 옴)
  mapx: string;           // 좌표
  mapy: string;
  addr1: string;          // 주소/지역
  addr2: string;
  zipcode: string;
  lDongRegnCd: string;
  lDongSignguCd: string;
  lclsSystm1: string;     // 분류체계
  lclsSystm2: string;
  lclsSystm3: string;
}
```

- `overview`를 제외한 모든 필드는 `areaBasedSyncList2` 응답에 이미 존재한다. `detailCommon2`는 **`overview` 하나를 얻기 위한 콘텐츠당 1호출**이다 → 가장 비싼 부분.
- 제외되는 응답 필드(투영에서 버림): `tel`·`telname`·`homepage`·`firstimage`·`firstimage2`·`mlevel`·`cpyrhtDivCd`·`showflag`·`createdtime`·`modifiedtime` 등.

## 호출 예산

- 개발계정 일 1,000건 제약. 목록은 페이지당 1000건(`numOfRows`)으로 총 호출 최소화(전체 ~5만 건이면 ~50호출).
- `detailCommon2`는 `contentId` 단수만 받음(배치 불가, 명세 확인됨) → 콘텐츠당 1호출. 대량 수집 시 여기가 병목.
- 저장을 하지 않으므로 재개(resume) 개념은 이번 스코프에 없다. 대량 실행 시 `--limit`류 상한으로 잘라서 부분 수집만 하는 형태(구현 계획에서 확정).

## 기존 코드와의 관계: TourApiClient v4.4 정합화

현행 `core/src/clients/tourApi.ts`는 v4.0 형태라 다음을 정합화한다.

- `getAreaBasedSyncList(...)` **신규** — `showflag`, `modifiedtime`, `arrange`, `contentTypeId`, `lDong*`, `lclsSystm*` 지원. 페이지네이션 위해 `{ items, totalCount, pageNo, numOfRows }` 반환.
- `getDetailCommon(contentId)` **수정** — v4.3에서 삭제된 파라미터(`defaultYN`/`firstImageYN`/`areacodeYN`/`catcodeYN`/`addrinfoYN`/`mapinfoYN`/`overviewYN`/`contentTypeId`) 제거, `contentId`만 전송. 응답 인터페이스를 v4.4로 교체.
- `areaBasedList`/`detailIntro`/`detailImage`는 이번 스코프 밖 — 건드리지 않음(단, `getDetailCommon` 시그니처/타입 변경이 이들 호출부·테스트에 영향 없는지 확인).

## 파일 구조

```
core/src/clients/tourApi.ts          # 수정: syncList 추가, detailCommon v4.4, page 반환 경로
core/src/lib/tourContent.ts          # 신규: TourContent 타입 + projection 함수
core/src/services/collectTourContents.ts  # 신규: fetch(syncList+detailCommon) → project → TourContent[] 반환
core/tests/clients/tourApi.test.ts   # 수정/추가
core/tests/lib/tourContent.test.ts   # 신규
core/tests/services/collectTourContents.test.ts  # 신규
```

기존 `logger`(`src/lib/logger.ts`)·`env` 헬퍼를 재사용한다. `PostgresClient`·저장소·마이그레이션은 이번 스코프에 없다.

## 컴포넌트

### 1. TourApiClient (수정)

```ts
interface TourApiSyncListParams {
  pageNo: number; numOfRows: number;
  showflag?: "0" | "1"; modifiedtime?: string; arrange?: string;
  contentTypeId?: string;
  lDongRegnCd?: string; lDongSignguCd?: string;
  lclsSystm1?: string; lclsSystm2?: string; lclsSystm3?: string;
}
interface TourApiPage<T> { items: T[]; totalCount: number; pageNo: number; numOfRows: number; }
interface TourApiSyncItem { /* contentid..lclsSystm3, showflag, createdtime, modifiedtime 등 원본 필드 */ }
interface TourApiDetailCommon { /* v4.4 응답: overview/homepage/telname 포함 */ }

class TourApiClient {
  getAreaBasedSyncList(params: TourApiSyncListParams): Promise<TourApiPage<TourApiSyncItem>>
  getDetailCommon(contentId: string): Promise<TourApiDetailCommon>
}
```

- 내부 `requestPage<T>` 추가 — `totalCount` 포함 반환. 기존 `normalizeItems`/`resultCode` 처리 재사용.

### 2. projection (`lib/tourContent.ts`, 신규)

```ts
function toTourContent(item: TourApiSyncItem, overview: string): TourContent
```

- syncList 항목에서 필요 필드만 뽑고 `overview`를 붙여 `TourContent` 생성. 순수 함수(네트워크·부수효과 없음).

### 3. collectTourContents (`services/`, 신규)

```ts
interface CollectOptions {
  pageSize?: number;       // 기본 1000
  contentTypeId?: string;
  modifiedSince?: string;  // YYYYMMDD
  maxItems?: number;       // detailCommon 호출 상한(예산 보호). 미지정 시 전체
}
async function collectTourContents(client: TourApiClient, opts?: CollectOptions): Promise<TourContent[]>
```

흐름:
1. `getAreaBasedSyncList`를 `pageNo=1`부터 순회, `totalCount`로 종료 판단. syncList 항목을 모음(또는 `maxItems`까지).
2. 각 항목의 `contentid`로 `getDetailCommon` 호출 → `overview` 확보.
3. `toTourContent(item, overview)`로 투영 → 배열에 누적.
4. `TourContent[]` 반환.

- 콘텐츠별 `getDetailCommon` 실패는 try/catch로 격리 — `NODATA(03)`이면 `overview=""`로 투영하고 계속. 그 외 에러는 로깅 후 계속(전체 중단 X).
- 진행 상황은 `logger`로 출력.

## 데이터 흐름

```
areaBasedSyncList2 (page) ──▶ syncItem[]
        │  각 contentid
        ▼
detailCommon2 (contentId 1건씩) ──▶ overview
        │
        ▼
toTourContent(syncItem, overview) ──▶ TourContent[]  (메모리 반환, 저장 없음)
```

## 에러 처리

- `resultCode != "0000"` → throw(기존 클라이언트 규칙).
- 목록 페이지 호출 실패: 지수 백오프 재시도(간단), 소진 시 로깅 후 중단.
- 세부 조회: 콘텐츠별 try/catch로 격리. `NODATA(03)`는 `overview=""`로 처리, 요청제한(`22`)은 중단·안내, 그 외는 로깅 후 다음 콘텐츠.

## 테스트 (TDD · 모킹)

- **TourApiClient** (`axios` `vi.mock`): syncList 파싱(0/1/N건)·`totalCount` 반환, `detailCommon` v4.4 파싱, `contentId`만 전송, `resultCode != 0000` throw.
- **toTourContent** (순수 함수): 필요 필드만 남기고 `overview` 병합, 불필요 필드 누락 확인.
- **collectTourContents** (client mock): 페이지 순회 종료 조건, `maxItems` 준수, 콘텐츠별 `detailCommon` 호출·투영, `NODATA` 시 `overview=""` 처리.

## 검증 계획

1. `npm run typecheck` (src + tests) 통과.
2. `npm test` — 신규/수정 단위 테스트 전부 통과.
3. `npm run build` 성공.

## 범위 밖 (YAGNI)

- DB·파일·stdout 저장, 저장소 계층, 마이그레이션, 재개(resume) 로직.
- 행(row) 조건 필터링(showflag/타입/좌표 유무 등).
- 임베딩(TEI)·Qdrant·Gemini.
- `detailIntro2`·`detailInfo2`·`detailImage2`.
- `contentTypeId`별 필드 정규화.
