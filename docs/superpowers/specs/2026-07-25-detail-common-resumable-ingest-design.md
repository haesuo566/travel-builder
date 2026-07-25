# core detailCommon 재개 가능 수집 설계 (Postgres 적재 + 일일 쿼터 분할 실행)

- 날짜: 2026-07-25
- 위치: `core/`
- 상태: 초안 (검토 대기)
- 선행 문서: `2026-07-24-tour-info-ingest-design.md`

## 목적

TourAPI `detailCommon2`로 콘텐츠별 `overview`를 수집해 Postgres에 적재한다. 개발계정 일일 호출 한도(1,000건)를 여러 날에 걸쳐 나눠 쓰며, **중단된 지점부터 자동으로 이어서** 수집한다.

선행 문서는 수집 결과를 저장하지 않고 메모리 배열로 반환하는 설계였고, 그 결과 재개(resume)를 명시적으로 범위 밖에 뒀다(`2026-07-24-tour-info-ingest-design.md:314`). 본 문서는 그 전제를 뒤집는다 — **결과를 Postgres에 저장**하고, 저장된 상태 자체를 재개 지점으로 삼는다.

## 선행 문서로부터의 변경

| 항목 | 선행 문서 | 본 문서 |
|------|-----------|---------|
| 수집 결과 저장 | 없음 (메모리 반환) | **Postgres `tour_contents` 테이블** |
| 재개 | 범위 밖 | **핵심 요구사항** |
| 수집 범위 | 전체 | **지역/타입 필터로 부분 수집** |
| 코드→이름 변환 | 수집 시점에 이름 필드 부착 | **DB엔 코드만 저장, 이름은 읽을 때 코드표 join** |
| `lib/tourCodes.ts` | 수집 파이프라인이 사용 | **이번 스코프에서 불필요 (제외)** |
| 커맨드 구성 | `collectTourContents` 서비스 1개 | **`collect-list` / `collect-detail` 2개 커맨드** |

## 결정 사항

| 항목 | 선택 |
|------|------|
| 저장소 | Postgres `tour_contents` (단일 테이블, 상태 컬럼 내장) |
| 재개 방식 | **별도 커서·체크포인트 없음.** `detail_status='pending'` 조회가 곧 남은 일 목록 |
| 커맨드 분리 | `tb collect-list`(목록 적재) / `tb collect-detail`(상세 채우기) |
| 수집 범위 | 지역(`lDongRegnCd`/`lDongSignguCd`)·타입(`contentTypeId`) 필터로 부분 수집 |
| 쿼터 처리 | `--daily-limit`(기본 900) 온메모리 카운터 + API 한도초과 에러 감지, 둘 다 |
| 실패 관리 | `detail_status` + `attempt_count`, 3회 실패 시 `failed`로 제외 |
| 커밋 단위 | **건당 커밋** (배치 커밋 금지) |
| 실행 방식 | 수동 재실행. 스케줄러·동시실행 방지 없음 |
| Qdrant/TEI | **이번 스코프 밖.** 나중에 별도 스테이지로 추가 가능하도록 컬럼명에 스테이지 접두어만 부여 |

## 아키텍처

```
[1단계] tb collect-list      areaBasedSyncList2  → tour_contents (detail_status=pending)
                             페이지당 1000건, 수 회 호출로 종료

[2단계] tb collect-detail    detailCommon2       → overview 채움, detail_status=done
                             건당 1호출. 희소 자원(1,000건/일), 소비하면 복구 불가
                             매일 재실행 = 재개
────────────────────────────────────────────────────────────────────────────
[3단계] tb embed-contents    TEI + Qdrant        → embed_status=done      (미구현, 추후)
                             배치 호출. 무한 재실행 가능
```

**Postgres가 원본 진실(source of truth), Qdrant는 파생 인덱스.** 2단계와 3단계를 한 루프에 묶지 않는다.

### 왜 스테이지를 분리하는가

1. **소비한 API 쿼터를 보호한다.** detailCommon 수신 직후 임베딩·Qdrant 저장까지 한 트랜잭션으로 처리하면, Qdrant 다운이나 TEI 실패가 *이미 소비한 API 호출*을 날린다. 복구 가능한 실패(Qdrant)가 복구 불가능한 손실(쿼터)을 유발하는 구조는 피한다.
2. **재임베딩 비용을 0으로 만든다.** 임베딩 모델·청킹 전략을 바꾸면 `UPDATE tour_contents SET embed_status='pending'` 한 줄로 재처리한다. 커플링돼 있으면 API 쿼터를 다시 태워야 한다.
3. **호출 성격이 정반대다.** `detailCommon2`는 건당 1호출·희소 쿼터, `TeiEmbeddingClient.embed(texts[])`/`QdrantStore.upsert(collection, points[])`는 배치 API. 한 루프에 넣으면 배치 이점을 버린다.

### 3단계 추가 시 필요한 작업 (본 스코프 아님, 확장성 확인용)

```sql
ALTER TABLE tour_contents
  ADD COLUMN embed_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN embed_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN embedded_at TIMESTAMPTZ;
```

3단계는 `WHERE detail_status='done' AND embed_status='pending'`을 배치로 읽어 처리한다. 재개는 2단계와 동일하게 상태 조회만으로 성립한다. 기존 코드는 수정하지 않는다.

지금 지불하는 확장 비용은 **컬럼명에 스테이지 접두어를 붙이는 것**(`status`가 아니라 `detail_status`) 하나뿐이다. Qdrant point ID 등 3단계 세부는 그 시점에 정한다.

**스테이지 러너 추상화는 지금 만들지 않는다.** 사용처가 하나뿐인 추상화는 두 번째 사용처에서 거의 항상 모양이 안 맞는다. 2단계를 함수 경계 명확하게 구현하고, 3단계 착수 시 실제 공통점을 보고 추출한다.

## 스키마

```sql
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
  detail_status     TEXT NOT NULL DEFAULT 'pending',   -- pending | done | nodata | failed
  attempt_count     INT  NOT NULL DEFAULT 0,
  last_error        TEXT,
  detail_fetched_at TIMESTAMPTZ,
  listed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tour_contents_pending
  ON tour_contents (contentid) WHERE detail_status = 'pending';
```

`generate-tour-codes`와 동일하게 커맨드 내 `CREATE TABLE IF NOT EXISTS`로 생성한다(마이그레이션 프레임워크 미도입).

### 설계 근거

**이름 필드를 저장하지 않는다.** 선행 문서는 `TourContent`에 `lDongRegnNm`·`lclsSystm1Nm` 등을 포함시켰으나(`:39-48`), 그건 *메모리 반환 객체* 기준이었다. DB에는 코드만 두고 조회 시 코드표(`tour_ldong_codes`, `tour_lcls_systm_codes`, `tour_content_types`)와 join한다. 코드 이름이 개정돼도 콘텐츠 행을 갱신할 필요가 없다.

**코드 컬럼의 출처.** `contenttypeid`·`ldong_regn_cd`·`ldong_signgu_cd`·`lcls_systm1/2/3`은 `areaBasedSyncList2` 응답이 콘텐츠별로 내려주는 값이다(선행 문서 `:52`). `generate-tour-codes`가 만드는 코드표는 이 값을 이름으로 바꾸는 **사전**이지, 이 컬럼을 채우는 소스가 아니다. `zipcode`는 실제 우편번호로 분류 코드가 아니다(선행 문서 `:22`).

**FK 제약을 걸지 않는다.** 코드표 적재 이후 TourAPI에 신설된 코드가 내려올 수 있고, FK가 있으면 해당 콘텐츠 INSERT가 통째로 실패한다. "코드표에 없으면 이름 빈 문자열 + 경고 후 계속"이라는 선행 문서 정책(`:144`)에 맞춰 soft reference로 둔다.

**부분 인덱스.** `done`이 수만 행 쌓여도 pending 조회 비용이 남은 건수에만 비례하도록 한다.

**NULL의 의미를 하나로 고정한다.** `overview`는 NULL = 아직 조회 안 함, `''` = 조회했으나 내용 없음(NODATA)으로 구분한다. 목록에서 온 텍스트 컬럼(`mapx`~`modifiedtime`)은 전부 `NOT NULL DEFAULT ''`로 통일해 조회 시 NULL 분기를 없앤다. `last_error`·`detail_fetched_at`은 "해당 사건이 아직 없음"을 뜻하는 NULL을 허용한다.

## 컴포넌트

### 1. TourApiClient (`clients/tourApi.ts`, 수정)

```ts
export class TourApiError extends Error {
  constructor(readonly resultCode: string, readonly resultMsg: string) { ... }
}
export function isNoData(e: unknown): boolean          // resultCode 03
export function isQuotaExceeded(e: unknown): boolean   // 22 / LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS

interface TourApiSyncListParams {
  pageNo: number; numOfRows: number;
  contentTypeId?: string;
  lDongRegnCd?: string; lDongSignguCd?: string;
  lclsSystm1?: string; lclsSystm2?: string; lclsSystm3?: string;
  showflag?: "0" | "1"; modifiedtime?: string; arrange?: string;
}
interface TourApiPage<T> { items: T[]; totalCount: number; pageNo: number; numOfRows: number }

interface TourApiSyncItem {
  contentid: string; contenttypeid: string; title: string;
  mapx: string; mapy: string;
  addr1: string; addr2: string; zipcode: string;
  lDongRegnCd: string; lDongSignguCd: string;
  lclsSystm1: string; lclsSystm2: string; lclsSystm3: string;
  createdtime: string; modifiedtime: string;
  showflag: string;
  // 투영에서 버림: tel, telname, homepage, firstimage, firstimage2, mlevel, cpyrhtDivCd
}

class TourApiClient {
  getAreaBasedSyncList(params: TourApiSyncListParams): Promise<TourApiPage<TourApiSyncItem>>  // 신규
  getDetailCommon(contentId: string): Promise<TourApiDetailCommon>                            // 수정
}
```

- **`TourApiError` 도입 이유:** 현행 `tourApi.ts:141-146`은 resultCode를 에러 메시지 문자열에 묻는다. 그러면 NODATA/한도초과/기타 분기를 문자열 파싱으로 해야 한다. resultCode를 필드로 노출한다.
- **`getDetailCommon` 수정:** v4.3에서 삭제된 파라미터(`defaultYN`/`firstImageYN`/`areacodeYN`/`catcodeYN`/`addrinfoYN`/`mapinfoYN`/`overviewYN`) 제거, `contentId`만 전송(현행 `:196-205`).
- **`TourApiAreaItem` v4.4 정합화:** 현행 `:22-41`은 v4.0 이름(`areacode`/`sigungucode`/`cat1/2/3`)이다. syncList 응답 타입은 `lDongRegnCd`/`lDongSignguCd`/`lclsSystm1~3` 계열로 정의한다.
- **`isQuotaExceeded`는 봉투 파싱 실패도 처리한다.** data.go.kr은 한도 초과 시 `_type=json`을 무시하고 XML 에러를 반환하는 경우가 있다. 그대로 두면 `data.response.header` 접근에서 TypeError가 나 "그 외 에러"로 오분류되고, 아래 "함정 1"이 재현된다. 응답 본문에서 한도초과 코드/문자열을 탐지하는 경로를 함께 둔다.
- 기존 `getAreaBasedList`/`getDetailIntro`/`getDetailImages`/코드표 조회 메서드는 건드리지 않는다.

### 2. tourContent (`lib/tourContent.ts`, 신규)

```ts
export interface TourContentRow {
  contentid: string; contenttypeid: string; title: string;
  mapx: string; mapy: string;
  addr1: string; addr2: string; zipcode: string;
  ldongRegnCd: string; ldongSignguCd: string;
  lclsSystm1: string; lclsSystm2: string; lclsSystm3: string;
  modifiedtime: string;
}

export function toTourContentRow(item: TourApiSyncItem): TourContentRow
```

순수 함수. 네트워크·DB 접근 없음. 응답에 없는 필드는 `''`로 채운다.

### 3. tourContentsTable (`lib/tourContentsTable.ts`, 신규)

```ts
export type DetailStatus = "pending" | "done" | "nodata" | "failed";

export async function createTourContentsTable(client: PoolClient): Promise<void>
export async function upsertListedContents(client: PoolClient, rows: TourContentRow[]): Promise<void>
export async function claimPendingContents(pg: PostgresClient, limit: number): Promise<string[]>
export async function markDetailDone(pg: PostgresClient, contentid: string, overview: string): Promise<void>
export async function markDetailNodata(pg: PostgresClient, contentid: string): Promise<void>
export async function markDetailFailure(
  pg: PostgresClient, contentid: string, error: string, maxAttempts: number,
): Promise<void>
export async function countByStatus(pg: PostgresClient): Promise<Record<DetailStatus, number>>
```

**`upsertListedContents`는 목록 필드만 갱신한다.** 상태 컬럼(`overview`/`detail_status`/`attempt_count`/`detail_fetched_at`)은 `ON CONFLICT DO UPDATE` 대상에서 제외한다:

```sql
INSERT INTO tour_contents (contentid, contenttypeid, title, ..., modifiedtime)
VALUES (...)
ON CONFLICT (contentid) DO UPDATE SET
  contenttypeid = EXCLUDED.contenttypeid,
  title         = EXCLUDED.title,
  ...,
  modifiedtime  = EXCLUDED.modifiedtime
-- overview / detail_status / attempt_count / detail_fetched_at 은 건드리지 않음
```

**`markDetailFailure`는 증가와 상태 전이를 단일 UPDATE로 처리한다.** 읽고-판단하고-쓰기로 나누면 경합이 생긴다:

```sql
UPDATE tour_contents SET
  attempt_count = attempt_count + 1,
  last_error    = $2,
  detail_status = CASE WHEN attempt_count + 1 >= $3 THEN 'failed' ELSE 'pending' END
WHERE contentid = $1
```

`claimPendingContents`는 `SELECT contentid FROM tour_contents WHERE detail_status = 'pending' ORDER BY contentid LIMIT $1`. 단일 프로세스 수동 실행이므로 `FOR UPDATE SKIP LOCKED`는 쓰지 않는다.

**`PoolClient` vs `PostgresClient` 인자 규칙.** 트랜잭션 안에서 실행돼야 하는 함수(`createTourContentsTable`, `upsertListedContents`)는 `PoolClient`를 받아 호출자가 `pg.transaction()`으로 감싸도록 하고, 건당 독립 커밋이 필요한 함수(`mark*`, `claim*`, `countByStatus`)는 `PostgresClient`를 받아 자동 커밋으로 실행한다. 이 구분이 "함정 2 — 커밋은 건당"을 타입 수준에서 강제한다.

### 4. collectList (`services/collectList.ts`, 신규)

```ts
interface CollectListOptions {
  contentTypeId?: string;
  lDongRegnCd?: string;
  lDongSignguCd?: string;
  pageSize?: number;   // 기본 1000
  maxPages?: number;   // 안전장치
}
interface CollectListResult { fetched: number; apiCalls: number }

async function collectList(
  tourApi: TourApiClient, pg: PostgresClient, opts?: CollectListOptions,
): Promise<CollectListResult>
```

흐름:
1. `createTourContentsTable` (멱등).
2. `getAreaBasedSyncList`를 `pageNo=1`부터 순회. `totalCount` 도달 또는 빈 페이지에서 종료.
3. 각 페이지 항목을 `toTourContentRow`로 투영 → `upsertListedContents`로 페이지 단위 적재.
4. 적재 건수·API 호출 수를 `logger`로 출력.

페이지 단위 커밋으로 충분하다 — 목록 호출은 실패해도 같은 페이지를 다시 받으면 그만이라, 상세 호출과 달리 소실 비용이 없다.

### 5. collectDetail (`services/collectDetail.ts`, 신규)

```ts
interface CollectDetailOptions {
  dailyLimit?: number;   // 기본 900
  maxAttempts?: number;  // 기본 3
}
interface CollectDetailResult {
  processed: number;
  done: number;
  nodata: number;
  retryScheduled: number;   // 실패했으나 pending 유지 (재시도 예정)
  failed: number;           // maxAttempts 도달로 제외됨
  stoppedBy: "budget" | "quota-exceeded" | "no-pending";
  remainingPending: number;
}

async function collectDetail(
  tourApi: TourApiClient, pg: PostgresClient, opts?: CollectDetailOptions,
): Promise<CollectDetailResult>
```

흐름:
1. `createTourContentsTable` (멱등) → `countByStatus`로 시작 현황 로깅.
2. `claimPendingContents(pg, dailyLimit)`로 처리 대상 확보.
3. 각 `contentid`에 대해 순차로 `getDetailCommon` 호출 → 결과에 따라 아래 표대로 반영 → **건당 즉시 커밋**.
4. 예산 소진 / 한도초과 / pending 소진 중 하나로 종료. `stoppedBy`에 사유를 담아 반환.
5. 종료 현황을 `logger`로 출력.

## 쿼터·에러 처리

### 에러 분류

| 상황 | `detail_status` | `attempt_count` | 루프 |
|------|-----------------|-----------------|------|
| 정상 | `done` (+ `overview`, `detail_fetched_at`) | — | 계속 |
| `NODATA(03)` | `nodata` (`overview=''`) | 안 올림 | 계속 |
| **한도 초과** | **`pending` 유지 (변경 없음)** | **안 올림** | **즉시 중단** |
| 네트워크/5xx/파싱 오류 | `pending` 유지, `last_error` 기록<br>단 `attempt_count+1 >= maxAttempts`면 `failed` | +1 | 계속 |

### 함정 1 — 쿼터로 끊긴 항목을 실패로 세지 않는다

한도 초과를 다른 에러와 동일하게 처리해 `attempt_count`를 올리면, 매일 쿼터가 끝나는 지점의 항목이 하루 한 번씩 실패를 누적한다. 사흘이면 `failed`로 빠져 **멀쩡한 데이터가 영구 제외**된다.

원칙: 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이므로, 해당 항목에 책임을 묻지 않는다.

### 함정 2 — 커밋은 건당

`PostgresClient.transaction()`으로 수백 건을 한 트랜잭션에 묶으면, 중간에 프로세스가 죽는 순간 **이미 소비한 API 호출이 롤백과 함께 증발한다.** 쿼터는 롤백되지 않는다. 건당 커밋 시 900커밋이 발생하지만 API 대기 시간에 묻히며, 재개 정확도가 성능보다 우선인 구간이다.

### 함정 3 — 목록 재적재가 완료분을 되돌린다

`collect-list`를 필터를 바꿔 재실행할 때 upsert가 상태 컬럼까지 갱신하면 그동안 채운 `overview`가 리셋되고, 소비한 쿼터가 통째로 무효화된다. 컴포넌트 3의 upsert 정의대로 목록 필드만 갱신한다.

### 쿼터 카운팅

- `--daily-limit` 기본 **900**. 여유분 100은 `generate-tour-codes` 재실행·수동 확인용으로 남긴다.
- 실행 중 온메모리 카운터로 세고 도달 시 정상 종료(`stoppedBy: "budget"`).
- 하루에 두 번 실행하면 합산되지 않는다. 이는 API 한도초과 에러 감지가 안전망으로 처리한다(`stoppedBy: "quota-exceeded"`).
- 일 1,000건은 detailCommon 전용이 아니라 **해당 서비스 키의 전체 호출 공유**다. `collect-list` 페이지 호출과 `generate-tour-codes`(~20호출)도 같은 한도에서 차감된다.

## CLI

```
tb collect-list [--content-type <id>] [--ldong-regn <cd>] [--ldong-signgu <cd>]
                [--page-size <n>] [--max-pages <n>]
tb collect-detail [--daily-limit <n>] [--max-attempts <n>]
```

`index.ts`에 `registerCollectList(program)`, `registerCollectDetail(program)`을 등록한다.

`collect-detail` 출력 예:

```
시작 — pending 1,234 / done 500 / nodata 12 / failed 3, 오늘 예산 900
...
종료 — 처리 900건 (done 880, nodata 15, 재시도대기 5)
       남은 pending 334건. 내일 다시 실행하세요.
```

`stoppedBy`에 따라 마지막 줄을 달리 안내한다:
- `budget` — "예산 소진. 내일 다시 실행하세요."
- `quota-exceeded` — "API 일일 한도에 도달했습니다. 다른 작업이 한도를 사용했는지 확인하세요."
- `no-pending` — "모든 항목 처리 완료."

## 파일 구조

```
core/src/clients/tourApi.ts            # 수정: syncList 추가, detailCommon v4.4, TourApiError/isNoData/isQuotaExceeded
core/src/lib/tourContent.ts            # 신규: TourContentRow + toTourContentRow (순수 함수)
core/src/lib/tourContentsTable.ts      # 신규: DDL + upsert/claim/mark/count 쿼리
core/src/services/collectList.ts       # 신규: 페이지 순회 → upsert
core/src/services/collectDetail.ts     # 신규: pending 순회 → detailCommon → 반영 (쿼터·에러)
core/src/commands/collectList.ts       # 신규: CLI 배선
core/src/commands/collectDetail.ts     # 신규: CLI 배선
core/src/index.ts                      # 수정: register 2개 추가

core/tests/clients/tourApi.test.ts             # 수정/추가
core/tests/lib/tourContent.test.ts             # 신규
core/tests/lib/tourContentsTable.test.ts       # 신규
core/tests/services/collectList.test.ts        # 신규
core/tests/services/collectDetail.test.ts      # 신규
```

기존 `logger`(`lib/logger.ts`)·`env` 헬퍼·`PostgresClient`(`clients/postgres.ts`)를 재사용한다.

## 데이터 흐름

```
areaBasedSyncList2 (page 순회)
        │
        ▼  toTourContentRow (순수 함수)
  TourContentRow[]
        │  upsertListedContents (목록 필드만)
        ▼
   tour_contents  (detail_status = 'pending')
        │
        │  claimPendingContents(limit = dailyLimit)
        ▼
   contentid[]
        │  건당 detailCommon2 → 건당 커밋
        ▼
   tour_contents  (overview 채워짐, detail_status = 'done' | 'nodata' | 'failed')
        │
        │  (추후) WHERE detail_status='done' AND embed_status='pending'
        ▼
   TEI → Qdrant   ※ 본 스코프 아님
```

## 테스트 (TDD · 모킹)

- **TourApiClient** (`axios` `vi.mock`)
  - syncList 파싱(0/1/N건), `totalCount`·`pageNo` 반환
  - `getDetailCommon`이 `contentId`만 전송(삭제된 파라미터 미전송)
  - `resultCode != "0000"` 시 `TourApiError`를 던지고 `resultCode` 필드가 노출됨
  - `isNoData`가 `03`을 판별
  - `isQuotaExceeded`가 `22`를 판별하고, **JSON 봉투가 아닌 XML 한도초과 응답도 판별**
- **toTourContentRow** (순수 함수): 필요 필드만 투영, 누락 필드는 `''`
- **tourContentsTable** (`PostgresClient` mock): 발행 SQL 검증
  - `upsertListedContents`의 `ON CONFLICT DO UPDATE`에 `overview`/`detail_status`/`attempt_count`가 **포함되지 않음**
  - `markDetailFailure`가 단일 UPDATE로 증가 + `CASE`로 전이
  - `claimPendingContents`가 `detail_status='pending'`과 `LIMIT`을 사용
- **collectList** (client+pg mock): 페이지 순회 종료 조건(`totalCount` 도달, 빈 페이지), 필터 파라미터 전달, `maxPages` 준수
- **collectDetail** (client+pg mock)
  - `dailyLimit`만큼만 호출하고 `stoppedBy: "budget"` 반환
  - NODATA → `markDetailNodata`, `attempt_count` 미증가
  - **한도초과 → 즉시 중단, 해당 항목에 `markDetailFailure` 미호출, `stoppedBy: "quota-exceeded"`**
  - 일반 오류 → `markDetailFailure` 호출 후 다음 항목 계속
  - 건당 커밋(배치 트랜잭션으로 감싸지 않음)
  - pending 없으면 API 호출 0회 + `stoppedBy: "no-pending"`

## 검증 계획

1. `npm run typecheck` (src + tests) 통과
2. `npm test` — 신규/수정 단위 테스트 전부 통과
3. `npm run build` 성공
4. 실제 API로 소량 스모크: `tb collect-list --content-type 12 --ldong-regn 11` → `tb collect-detail --daily-limit 5` 2회 연속 실행 → 두 번째 실행이 첫 실행이 처리하지 않은 항목부터 이어가는지 확인

## 범위 밖 (YAGNI)

- **Qdrant·TEI 임베딩 저장** — 3단계로 분리. 본 스코프에서는 코드를 작성하지 않으며, 컬럼명 스테이지 접두어로 확장 여지만 남긴다.
- **스테이지 러너 추상화** — 두 번째 사용처(3단계) 등장 시 추출.
- **스케줄러(cron)·동시 실행 방지(advisory lock)** — 수동 실행 전제.
- **일별 호출 수 DB 누적 기록** — 온메모리 카운터 + API 에러 감지로 대체.
- **`modifiedtime` 변경 감지 재수집** — 목록 재적재 시 기존 `done`은 유지하며, 갱신분 재수집은 다루지 않는다.
- **코드→이름 변환(`lib/tourCodes.ts`)** — DB엔 코드만 저장, 이름은 읽는 쪽에서 join.
- **`detailIntro2`·`detailInfo2`·`detailImage2`** — `overview`만 수집.
- **행(row) 조건 필터링** — 지역/타입 필터는 API 파라미터로만 적용, 수신 후 조건 선별은 하지 않는다.
- **마이그레이션 프레임워크** — 커맨드 내 `CREATE TABLE IF NOT EXISTS`.
- **`tour_lcls_systm_codes` 스키마 개편** — 별건으로 논의됨, 본 스코프와 무관.
