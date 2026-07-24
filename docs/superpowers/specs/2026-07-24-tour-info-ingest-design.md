# core 관광정보 수집·필드 선별 설계 (TourAPI fetch + projection + 코드 인간화)

- 날짜: 2026-07-24
- 위치: `core/`
- 상태: 초안 (검토 대기)

## 목적

한국관광공사 KorService2(v4.4)에서 전체 관광정보를 가져와, **필요한 필드만 골라낸(projection) 메모리 객체 배열로 반환**한다. 이번 단계에서는 **수집 결과(TourContent) 자체의 DB·파일 저장을 하지 않는다.** 반환된 객체가 이후 단계(저장/임베딩 등)의 입력이 된다.

추가로, 응답에 포함된 분류 코드(`contenttypeid`, `lDongRegnCd`/`lDongSignguCd`, `lclsSystm1/2/3`)는 코드값 그대로 두면 사람이 읽기 어려우므로, **코드는 유지한 채 사람이 읽을 수 있는 이름 필드를 추가**한다. 이름 조회에 필요한 코드표(코드→이름 매핑)는 **최초 1회 별도 CLI 커맨드로 Postgres에 적재**해두고, 수집 파이프라인은 실행 시작 시 이를 읽어와 메모리에서 조회만 한다.

## 결정 사항

| 항목 | 선택 |
|------|------|
| 목록 오퍼레이션 | `areaBasedSyncList2` (동기화 목록) |
| 세부 오퍼레이션 | `detailCommon2`만 — `overview` 확보 목적 (이미지 등 나머지 제외) |
| 걸러내기 방식 | **필드 선별(projection)만.** 행(row) 필터링·조건 선별은 하지 않음 (전 항목 유지) |
| 결과 출력 | **메모리 객체 배열 반환.** `TourContent` 자체는 DB·파일·stdout 저장 없음 |
| 병합 | syncList 항목 + 해당 콘텐츠의 `detailCommon.overview`를 합쳐 `TourContent`로 투영 |
| 분류 코드 인간화 | 코드 필드 유지 + 이름 필드 추가(`contentTypeNm`, `lDongRegnNm`, `lDongSignguNm`, `lclsSystm1/2/3Nm`). `zipcode`는 실제 우편번호라 대상 아님 |
| 코드표 확보 | 최초 1회 `tb generate-tour-codes` 커맨드로 API 전체 조회 → **Postgres에 적재**(종류별 테이블). 수집 파이프라인은 실행 시작 시 1회 로드해 메모리에서만 조회(추가 API 호출 없음) |

## 필요 필드 (projection 결과 `TourContent`)

```ts
interface TourContent {
  contentid: string;      // 기본
  contenttypeid: string;  // 기본
  contentTypeNm: string;  // 신규 — 코드→이름 (하드코딩 매핑, 8종 고정)
  title: string;          // 기본
  overview: string;       // detailCommon2 (이것만 세부에서 옴)
  mapx: string;           // 좌표
  mapy: string;
  addr1: string;          // 주소/지역
  addr2: string;
  zipcode: string;        // 실제 우편번호 — 이름 변환 대상 아님
  lDongRegnCd: string;
  lDongRegnNm: string;    // 신규 — 코드→이름 (Postgres 코드표)
  lDongSignguCd: string;
  lDongSignguNm: string;  // 신규 — 코드→이름 (Postgres 코드표, lDongRegnCd와 조합 키)
  lclsSystm1: string;     // 분류체계
  lclsSystm1Nm: string;   // 신규
  lclsSystm2: string;
  lclsSystm2Nm: string;   // 신규
  lclsSystm3: string;
  lclsSystm3Nm: string;   // 신규
}
```

- `overview`를 제외한 모든 코드/원본 필드는 `areaBasedSyncList2` 응답에 이미 존재한다. `detailCommon2`는 **`overview` 하나를 얻기 위한 콘텐츠당 1호출**이다 → 가장 비싼 부분.
- 제외되는 응답 필드(투영에서 버림): `tel`·`telname`·`homepage`·`firstimage`·`firstimage2`·`mlevel`·`cpyrhtDivCd`·`showflag`·`createdtime`·`modifiedtime` 등.
- 이름 필드 명명은 API 자체가 쓰는 규칙(`lDongRegnNm`, `lclsSystm1Nm` 등, `ldongCode2`/`lclsSystmCode2` 응답 참고)을 그대로 따른다. `contentTypeNm`은 API에 대응 필드가 없어 동일한 명명 스타일로 신설한다.

## 코드 → 이름 변환

### contenttypeid (하드코딩, API 조회 불필요)

관광타입은 8개 고정값이며 명세서에 직접 명시되어 있어 코드 조회 오퍼레이션 없이 상수로 하드코딩한다.

| 코드 | 이름 |
|------|------|
| 12 | 관광지 |
| 14 | 문화시설 |
| 15 | 축제공연행사 |
| 25 | 여행코스 |
| 28 | 레포츠 |
| 32 | 숙박 |
| 38 | 쇼핑 |
| 39 | 음식점 |

### lDongRegnCd/lDongSignguCd, lclsSystm1/2/3 (Postgres 코드표 조회)

두 코드 체계 모두 개수가 많고(법정동 시도 17종 × 시군구 다수, 분류체계 대/중/소 합산 ~243종) API 조회가 필요하므로, 최초 1회 `tb generate-tour-codes` 커맨드로 Postgres에 적재한 뒤 런타임에는 그 테이블만 참조한다(아래 "코드표 저장" 섹션 참고).

## 코드표 저장 (Postgres)

### 적재 커맨드: `tb generate-tour-codes` (신규)

기존 CLI(`core/src/commands/*.ts` + `index.ts`에 `registerX(program)` 등록하는 패턴, 현재 `hello` 커맨드 존재)에 새 커맨드로 추가한다. `PostgresClient`(`core/src/clients/postgres.ts`, 기존 재사용)로 연결한다.

흐름:
1. `CREATE TABLE IF NOT EXISTS`로 아래 3개 테이블 생성(멱등, 별도 마이그레이션 도구 없이 커맨드 내에서 직접 실행).
2. `tour_content_types`: 위 8행을 하드코딩 값으로 upsert(`ON CONFLICT (code) DO UPDATE`).
3. `tour_lcls_systm_codes`: `getLclsSystmCode({ lclsSystmListYn: "Y" })`를 페이지 순회 호출(`lclsSystm1/2/3` 파라미터 미지정 시 전체 대/중/소분류 트리를 한 번에 반환, 명세서 예제 기준 총 243건 → `numOfRows=1000`이면 1페이지로 충분) → 각 행(`lclsSystm1Cd/Nm`, `lclsSystm2Cd/Nm`, `lclsSystm3Cd/Nm`)을 upsert.
4. `tour_ldong_codes`: `getLdongCode({ lDongListYn: "N" })`(`lDongRegnCd` 미지정) → 시도 목록(약 17건) 확보. 시도 코드마다 `getLdongCode({ lDongRegnCd, lDongListYn: "Y" })` 호출 → 해당 시도의 시군구 목록(`lDongRegnCd/Nm`, `lDongSignguCd/Nm`)을 upsert.
5. 각 테이블 적재 건수를 `logger`로 출력.

재실행 가능(멱등) — 코드 개정 시 수동 재실행으로 갱신한다. 스케줄링 등 자동화는 범위 밖.

### 스키마 (종류별 테이블)

```sql
CREATE TABLE IF NOT EXISTS tour_content_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tour_ldong_codes (
  regn_code TEXT NOT NULL,
  regn_name TEXT NOT NULL,
  signgu_code TEXT NOT NULL DEFAULT '',   -- '' = 시도 레벨 자체(시군구 미지정)
  signgu_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (regn_code, signgu_code)
);

CREATE TABLE IF NOT EXISTS tour_lcls_systm_codes (
  lvl1_code TEXT NOT NULL,
  lvl1_name TEXT NOT NULL,
  lvl2_code TEXT NOT NULL DEFAULT '',
  lvl2_name TEXT NOT NULL DEFAULT '',
  lvl3_code TEXT NOT NULL DEFAULT '',
  lvl3_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (lvl1_code, lvl2_code, lvl3_code)
);
```

- `tour_ldong_codes`/`tour_lcls_systm_codes`는 API 응답 형태(`lDongRegnCd/Nm`+`lDongSignguCd/Nm`, `lclsSystm1Cd/Nm`+`lclsSystm2Cd/Nm`+`lclsSystm3Cd/Nm`)를 그대로 반영한 구조라 적재 시 별도 변환이 거의 필요 없다.
- PK가 문자열 조합이라 빈 문자열(`''`)을 "해당 레벨 미지정"의 sentinel로 사용한다(SQL PK는 NULL을 허용하지 않으므로).

### 런타임 조회: 실행 시작 시 1회 로드

`collectTourContents` 실행 시작 시 `loadTourCodeTables(pg: PostgresClient)`(신규, `lib/tourCodes.ts`)가 3개 테이블을 각각 `SELECT *`로 전체 조회해 메모리 맵으로 변환한다. 이후 항목별 투영은 이 메모리 맵만 참조하며 추가 DB·API 호출이 없다.

```ts
interface TourCodeTables {
  contentType: Map<string, string>;        // code -> name
  ldongRegn: Map<string, string>;          // regn_code -> name
  ldongSigngu: Map<string, string>;        // `${regn_code}:${signgu_code}` -> name
  lclsSystm1: Map<string, string>;
  lclsSystm2: Map<string, string>;
  lclsSystm3: Map<string, string>;
}

async function loadTourCodeTables(pg: PostgresClient): Promise<TourCodeTables>

function resolveContentTypeName(tables: TourCodeTables, code: string): string
function resolveLDongNames(tables: TourCodeTables, regnCode: string, signguCode: string): { lDongRegnNm: string; lDongSignguNm: string }
function resolveLclsSystmNames(tables: TourCodeTables, l1: string, l2: string, l3: string): { lclsSystm1Nm: string; lclsSystm2Nm: string; lclsSystm3Nm: string }
```

- 원본 코드 필드가 빈 문자열이면 이름도 빈 문자열(변환 시도 안 함).
- 코드가 있는데 맵에 없으면(적재 이후 신규 코드 추가 등) 이름은 빈 문자열 + `logger.warn`으로 기록하고 계속 진행 — 기존 에러 처리 철학(전체 중단 없이 개별 값만 스킵)과 동일.

## 호출 예산

- 개발계정 일 1,000건 제약. 목록은 페이지당 1000건(`numOfRows`)으로 총 호출 최소화(전체 ~5만 건이면 ~50호출).
- `detailCommon2`는 `contentId` 단수만 받음(배치 불가, 명세 확인됨) → 콘텐츠당 1호출. 대량 수집 시 여기가 병목.
- 저장을 하지 않으므로 재개(resume) 개념은 이번 스코프에 없다. 대량 실행 시 `--limit`류 상한으로 잘라서 부분 수집만 하는 형태(구현 계획에서 확정).
- `tb generate-tour-codes`는 별도 1회성 실행: `lclsSystmCode2` 전체조회 1~2회 + `ldongCode2` 시도 목록 1회 + 시도별(약 17개) 시군구 조회 ~17회 ≈ 총 20회. 일일 예산에 미미하며, 매 수집 실행마다가 아니라 코드 개정 시에만 재실행한다.

## 기존 코드와의 관계: TourApiClient v4.4 정합화

현행 `core/src/clients/tourApi.ts`는 v4.0 형태라 다음을 정합화한다.

- `getAreaBasedSyncList(...)` **신규** — `showflag`, `modifiedtime`, `arrange`, `contentTypeId`, `lDong*`, `lclsSystm*` 지원. 페이지네이션 위해 `{ items, totalCount, pageNo, numOfRows }` 반환.
- `getDetailCommon(contentId)` **수정** — v4.3에서 삭제된 파라미터(`defaultYN`/`firstImageYN`/`areacodeYN`/`catcodeYN`/`addrinfoYN`/`mapinfoYN`/`overviewYN`/`contentTypeId`) 제거, `contentId`만 전송. 응답 인터페이스를 v4.4로 교체.
- `getLclsSystmCode(...)` **신규** — 분류체계 코드 조회(`lclsSystmCode2`). `generate-tour-codes` 커맨드 전용, 수집 파이프라인 런타임 경로에서는 호출하지 않음.
- `getLdongCode(...)` **신규** — 법정동 코드 조회(`ldongCode2`). 마찬가지로 `generate-tour-codes` 전용.
- `areaBasedList`/`detailIntro`/`detailImage`는 이번 스코프 밖 — 건드리지 않음(단, `getDetailCommon` 시그니처/타입 변경이 이들 호출부·테스트에 영향 없는지 확인).

## 파일 구조

```
core/src/clients/tourApi.ts                # 수정: syncList 추가, detailCommon v4.4, lclsSystmCode/ldongCode 추가
core/src/clients/postgres.ts               # 기존 재사용 (수정 없음)
core/src/commands/generateTourCodes.ts     # 신규: tb generate-tour-codes — 코드표 3종 Postgres 적재
core/src/lib/tourCodes.ts                  # 신규: loadTourCodeTables + resolve* 헬퍼 (순수 조회 함수)
core/src/lib/tourContent.ts                # 신규: TourContent 타입 + projection 함수(이름 필드 포함)
core/src/services/collectTourContents.ts   # 신규: 코드표 로드 → fetch(syncList+detailCommon) → project → TourContent[] 반환
core/src/index.ts                          # 수정: registerGenerateTourCodes(program) 등록
core/tests/clients/tourApi.test.ts         # 수정/추가
core/tests/lib/tourCodes.test.ts           # 신규
core/tests/lib/tourContent.test.ts         # 신규
core/tests/commands/generateTourCodes.test.ts  # 신규
core/tests/services/collectTourContents.test.ts  # 신규
```

기존 `logger`(`src/lib/logger.ts`)·`env` 헬퍼·`PostgresClient`(`src/clients/postgres.ts`)를 재사용한다. 별도 마이그레이션 프레임워크는 도입하지 않는다(코드표 테이블은 커맨드 내 `CREATE TABLE IF NOT EXISTS`로 직접 생성).

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

interface TourApiLclsSystmParams {
  lclsSystm1?: string; lclsSystm2?: string; lclsSystm3?: string;
  lclsSystmListYn: "Y" | "N";
  pageNo: number; numOfRows: number;
}
interface TourApiLclsSystmItem {
  lclsSystm1Cd: string; lclsSystm1Nm: string;
  lclsSystm2Cd: string; lclsSystm2Nm: string;
  lclsSystm3Cd: string; lclsSystm3Nm: string;
}
interface TourApiLdongParams {
  lDongRegnCd?: string; lDongListYn: "Y" | "N";
  pageNo: number; numOfRows: number;
}
interface TourApiLdongItem {
  lDongRegnCd: string; lDongRegnNm: string;
  lDongSignguCd: string; lDongSignguNm: string;
}

class TourApiClient {
  getAreaBasedSyncList(params: TourApiSyncListParams): Promise<TourApiPage<TourApiSyncItem>>
  getDetailCommon(contentId: string): Promise<TourApiDetailCommon>
  getLclsSystmCode(params: TourApiLclsSystmParams): Promise<TourApiPage<TourApiLclsSystmItem>>
  getLdongCode(params: TourApiLdongParams): Promise<TourApiPage<TourApiLdongItem>>
}
```

- 내부 `requestPage<T>` 추가 — `totalCount` 포함 반환. 기존 `normalizeItems`/`resultCode` 처리 재사용.

### 2. generateTourCodes (`commands/`, 신규)

```ts
async function generateTourCodes(client: TourApiClient, pg: PostgresClient): Promise<void>
```

- "코드표 저장" 섹션의 적재 흐름(테이블 생성 → contenttype 하드코딩 upsert → lclsSystm 전체조회 upsert → ldong 시도/시군구 순회 upsert)을 수행.
- `index.ts`에 `registerGenerateTourCodes(program)`으로 등록, `tb generate-tour-codes`로 실행.

### 3. tourCodes (`lib/`, 신규)

- `loadTourCodeTables(pg)` — 3개 테이블 전체 조회 후 메모리 맵(`TourCodeTables`) 구성.
- `resolveContentTypeName`/`resolveLDongNames`/`resolveLclsSystmNames` — 순수 조회 함수(네트워크·부수효과 없음), 누락 코드는 빈 문자열 + 경고 로깅.

### 4. projection (`lib/tourContent.ts`, 신규)

```ts
function toTourContent(item: TourApiSyncItem, overview: string, codes: TourCodeTables): TourContent
```

- syncList 항목에서 필요 필드만 뽑고 `overview`를 붙이고, `codes`로 이름 필드를 채워 `TourContent` 생성. 순수 함수(네트워크·부수효과 없음).

### 5. collectTourContents (`services/`, 신규)

```ts
interface CollectOptions {
  pageSize?: number;       // 기본 1000
  contentTypeId?: string;
  modifiedSince?: string;  // YYYYMMDD
  maxItems?: number;       // detailCommon 호출 상한(예산 보호). 미지정 시 전체
}
async function collectTourContents(client: TourApiClient, pg: PostgresClient, opts?: CollectOptions): Promise<TourContent[]>
```

흐름:
1. `loadTourCodeTables(pg)`로 코드표를 메모리에 로드(실행당 1회).
2. `getAreaBasedSyncList`를 `pageNo=1`부터 순회, `totalCount`로 종료 판단. syncList 항목을 모음(또는 `maxItems`까지).
3. 각 항목의 `contentid`로 `getDetailCommon` 호출 → `overview` 확보.
4. `toTourContent(item, overview, codes)`로 투영 → 배열에 누적.
5. `TourContent[]` 반환.

- 콘텐츠별 `getDetailCommon` 실패는 try/catch로 격리 — `NODATA(03)`이면 `overview=""`로 투영하고 계속. 그 외 에러는 로깅 후 계속(전체 중단 X).
- 진행 상황은 `logger`로 출력.

## 데이터 흐름

```
tour_content_types / tour_ldong_codes / tour_lcls_systm_codes (Postgres, 사전 적재됨)
        │ 실행 시작 시 1회 SELECT
        ▼
   TourCodeTables (메모리 맵)
        │
areaBasedSyncList2 (page) ──▶ syncItem[]
        │  각 contentid
        ▼
detailCommon2 (contentId 1건씩) ──▶ overview
        │
        ▼
toTourContent(syncItem, overview, codes) ──▶ TourContent[]  (메모리 반환, 저장 없음)
```

## 에러 처리

- `resultCode != "0000"` → throw(기존 클라이언트 규칙).
- 목록 페이지 호출 실패: 지수 백오프 재시도(간단), 소진 시 로깅 후 중단.
- 세부 조회: 콘텐츠별 try/catch로 격리. `NODATA(03)`는 `overview=""`로 처리, 요청제한(`22`)은 중단·안내, 그 외는 로깅 후 다음 콘텐츠.
- 코드→이름 변환: 코드가 빈 문자열이면 이름도 빈 문자열. 코드는 있는데 코드표에 없으면 이름="" + 경고 로깅 후 계속(전체 중단 X).

## 테스트 (TDD · 모킹)

- **TourApiClient** (`axios` `vi.mock`): syncList 파싱(0/1/N건)·`totalCount` 반환, `detailCommon` v4.4 파싱, `lclsSystmCode`/`ldongCode` 파싱, `contentId`만 전송, `resultCode != 0000` throw.
- **tourCodes** (`PostgresClient` mock): `loadTourCodeTables`가 3개 테이블 조회 결과를 올바른 맵 구조로 변환, `resolve*` 함수의 정상 조회·빈 코드·누락 코드(경고 로깅) 처리.
- **generateTourCodes** (`TourApiClient`+`PostgresClient` mock): `CREATE TABLE IF NOT EXISTS` 실행, contenttype 8행 upsert, lclsSystm/ldong API 응답을 순회하며 upsert 호출 검증.
- **toTourContent** (순수 함수, `TourCodeTables` fixture 사용): 필요 필드만 남기고 `overview`·이름 필드 병합, 불필요 필드 누락 확인.
- **collectTourContents** (client+pg mock): 시작 시 `loadTourCodeTables` 호출, 페이지 순회 종료 조건, `maxItems` 준수, 콘텐츠별 `detailCommon` 호출·투영, `NODATA` 시 `overview=""` 처리.

## 검증 계획

1. `npm run typecheck` (src + tests) 통과.
2. `npm test` — 신규/수정 단위 테스트 전부 통과.
3. `npm run build` 성공.

## 범위 밖 (YAGNI)

- `TourContent` 수집 결과 자체의 저장(DB·파일·stdout) — 메모리 반환만. `PostgresClient`는 코드표(contenttype/lclsSystm/lDong) 저장에 한해 사용한다.
- 별도 마이그레이션 프레임워크 도입 — 코드표 테이블은 커맨드 내 `CREATE TABLE IF NOT EXISTS`로 직접 생성.
- 코드표 자동 최신화(스케줄링) — 수동 재실행만.
- 재개(resume) 로직 — 수집 결과를 저장하지 않으므로 이번 스코프에 없음.
- 행(row) 조건 필터링(showflag/타입/좌표 유무 등).
- 임베딩(TEI)·Qdrant·Gemini.
- `detailIntro2`·`detailInfo2`·`detailImage2`.
- `contentTypeId`별 필드 정규화.
- `zipcode` 변환 — 실제 우편번호라 대상 아님.
