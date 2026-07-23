# core 관광정보 수집 파이프라인 설계 (TourAPI → PostgreSQL 미러)

- 날짜: 2026-07-24
- 위치: `core/`
- 상태: 초안 (검토 대기)

## 목적

한국관광공사 KorService2(v4.4)에서 **전체 관광정보를 로컬 PostgreSQL로 미러링**한다. 먼저 동기화 목록으로 전체 목록을 수집·저장하고, 이어서 각 콘텐츠의 공통 세부정보(`overview` 등)를 조회해 같은 행에 채운다. 이 미러가 이후 임베딩/RAG 파이프라인의 입력이 된다.

## 결정 사항

| 항목 | 선택 | 근거 |
|------|------|------|
| 목록 오퍼레이션 | `areaBasedSyncList2` (동기화 목록) | `showflag`(표출/비표출=소프트삭제), `modifiedtime`(증분), `oldContentid`(이전 키 추적) 제공 — DB 미러 전용 설계 |
| 세부 오퍼레이션 | `detailCommon2`만 | 이미지(`detailImage2`) 제외. 목록 대비 추가로 얻는 값은 `overview`·`homepage`·`telname` |
| 세부 범위 | `overview` 필요 → Phase 2 유지 | 개요 텍스트가 다운스트림 임베딩에 중요 |
| 저장소 | PostgreSQL `tour_content` 단일 테이블 | 목록 필드 + common 필드를 한 행에 병합 |
| 스키마 확정 | **주요 컬럼안 제시, 최종 컬럼은 사용자가 추후 확정** | 저장소 계층으로 스키마 변경 영향 격리 |
| 키/재개 | 운영키 가정 + 재개 가능 설계 | 세부정보가 콘텐츠당 1호출이라 대량 → 중단·재개 필수 |
| 실행 구조 | 2단계 분리 (`list` / `detail`) | 목록은 싸고(페이지당 1호출), 세부는 비쌈(콘텐츠당 1호출) → 예산·재개 관리 분리 |
| 페이지 크기 | 기본 1000, `--page-size`로 조정 | 총 호출 수 최소화(공공데이터포털 안정 상한) |

## 핵심 제약: 호출 예산

- 개발계정은 일 1,000건 트래픽. **운영키를 가정**하되 파이프라인은 재개 가능하게 설계한다.
- 목록(Phase 1): 페이지당 1000건 → 전체 ~5만 건이면 **약 50호출**.
- 세부(Phase 2): `detailCommon2`는 `contentId` 단수만 받음(배치 불가, 명세 확인됨) → **콘텐츠당 1호출**, 전체 ~5만 건이면 ~5만 호출. 가장 비싼 부분.

## 기존 코드와의 관계: TourApiClient v4.4 정합화

현행 `core/src/clients/tourApi.ts`는 구버전(v4.0) 형태라 다음이 어긋난다. 이번 작업에서 정합화한다.

- 목록 파라미터가 `areaCode`/`sigunguCode`/`cat1~3` → v4.4는 `lDongRegnCd`/`lDongSignguCd` + `lclsSystm1~3`.
- `getDetailCommon`이 v4.3에서 **삭제된 파라미터**(`defaultYN`/`firstImageYN`/`areacodeYN`/`catcodeYN`/`addrinfoYN`/`mapinfoYN`/`overviewYN`/`contentTypeId`)를 전송 중 → `contentId`만 보내도록 수정, 응답 인터페이스도 v4.4로 교체.
- 목록/세부 미러에 필요한 `areaBasedSyncList2`, 그리고 페이지네이션용 `totalCount` 반환 경로가 없음.

`areaBasedList`/`detailIntro`/`detailImage`는 이번 스코프 밖 — 건드리지 않는다(단, `getDetailCommon` 시그니처/타입 변경이 이들 호출부·테스트에 영향 없는지 확인).

## 파일 구조

```
core/src/clients/tourApi.ts                    # 수정: syncList 추가, detailCommon v4.4, page 반환 경로
core/src/repositories/tourContentRepository.ts # 신규: tour_content 접근 캡슐화
core/src/commands/ingest.ts                    # 신규: tb ingest list / detail 오케스트레이션
core/db/migrations/0001_tour_content.sql       # 신규: 테이블 DDL
core/tests/clients/tourApi.test.ts             # 수정/추가
core/tests/repositories/tourContentRepository.test.ts  # 신규
core/tests/commands/ingest.test.ts             # 신규
core/src/index.ts                              # 수정: registerIngest 등록
```

기존 `PostgresClient`(`src/clients/postgres.ts`), `logger`(`src/lib/logger.ts`), `env` 헬퍼를 재사용한다.

## 컴포넌트

### 1. TourApiClient (수정)

```ts
interface TourApiSyncListParams {
  pageNo: number;
  numOfRows: number;
  showflag?: "0" | "1";
  modifiedtime?: string;      // YYYYMMDD
  arrange?: string;           // 기본 "D"(생성일순, 안정 정렬)
  contentTypeId?: string;
  lDongRegnCd?: string;
  lDongSignguCd?: string;
  lclsSystm1?: string;
  lclsSystm2?: string;
  lclsSystm3?: string;
}

interface TourApiPage<T> { items: T[]; totalCount: number; pageNo: number; numOfRows: number; }

interface TourApiSyncItem {
  contentid: string; contenttypeid: string; title: string;
  addr1: string; addr2: string; zipcode: string; tel: string;
  firstimage: string; firstimage2: string; cpyrhtDivCd: string;
  mapx: string; mapy: string; mlevel: string;
  showflag: string; createdtime: string; modifiedtime: string;
  lDongRegnCd: string; lDongSignguCd: string;
  lclsSystm1: string; lclsSystm2: string; lclsSystm3: string;
}

// v4.4 응답 형태로 교체
interface TourApiDetailCommon {
  contentid: string; contenttypeid: string; title: string;
  createdtime: string; modifiedtime: string;
  tel: string; telname: string; homepage: string;
  firstimage: string; firstimage2: string; cpyrhtDivCd: string;
  addr1: string; addr2: string; zipcode: string;
  mapx: string; mapy: string; mlevel: string; overview: string;
  lDongRegnCd: string; lDongSignguCd: string;
  lclsSystm1: string; lclsSystm2: string; lclsSystm3: string;
}

class TourApiClient {
  getAreaBasedSyncList(params: TourApiSyncListParams): Promise<TourApiPage<TourApiSyncItem>>
  getDetailCommon(contentId: string): Promise<TourApiDetailCommon>  // contentId만 전송
}
```

- 내부에 `requestPage<T>(path, params): Promise<TourApiPage<T>>` 추가 — `totalCount`/`pageNo`/`numOfRows`까지 반환(페이지네이션용). 기존 `normalizeItems`/`resultCode` 처리 재사용.
- URL 조립·서비스키 raw 삽입 규칙은 기존과 동일.

### 2. tourContentRepository (신규)

`tour_content` 테이블 접근을 한 파일에 가둔다. 스키마가 바뀌어도 여기만 고치면 된다.

```ts
class TourContentRepository {
  constructor(pg: PostgresClient)
  upsertListItems(items: TourApiSyncItem[]): Promise<void>       // contentid PK 멱등 upsert (한 트랜잭션/페이지)
  countPendingDetail(): Promise<number>
  findPendingDetail(limit: number): Promise<string[]>            // detail_fetched_at IS NULL 인 contentid
  updateDetail(contentId: string, common: TourApiDetailCommon): Promise<void>  // overview 등 + detail_fetched_at=now()
  markDetailDone(contentId: string): Promise<void>               // NODATA 등 정상 스킵 시 재조회 방지
}
```

### 3. ingest 커맨드 (신규)

- `tb ingest list [--page-size 1000] [--content-type 12] [--modified-since YYYYMMDD] [--showflag 1]`
  1. `pageNo=1`로 첫 호출 → `totalCount`로 총 페이지 수 계산
  2. 페이지마다 받는 즉시 `upsertListItems`(트랜잭션) → 다음 페이지. 전체를 메모리에 쌓지 않음
- `tb ingest detail [--limit N]`
  1. `findPendingDetail(batch)`로 미수집 `contentid` 조회
  2. 각 `contentId`로 `getDetailCommon` → `updateDetail`. `--limit`로 이번 실행 처리 상한(일 예산 분할)
- 진행 상황은 `logger`로 출력(페이지 n/total, 처리 건수).

## 데이터 흐름

```
[Phase 1] areaBasedSyncList2 (page 1000) ──▶ upsertListItems ──▶ tour_content (detail_fetched_at=NULL)
[Phase 2] findPendingDetail ──▶ detailCommon2 (contentId 1건씩) ──▶ updateDetail (overview 등 + detail_fetched_at=now)
```

재개: 두 페이즈 모두 멱등. Phase 1은 재실행 시 upsert로 갱신, Phase 2는 `detail_fetched_at` 플래그로 이미 받은 건 스킵. 중단돼도 재실행하면 남은 것부터 이어감.

## 초기 컬럼안 (추후 사용자 확정)

`tour_content`:

| 컬럼 | 타입 | 출처 |
|------|------|------|
| `contentid` | text PK | 목록 |
| `contenttypeid` | text | 목록 |
| `title` | text | 목록 |
| `addr1`, `addr2`, `zipcode` | text | 목록 |
| `tel` | text | 목록 |
| `telname` | text | common |
| `firstimage`, `firstimage2`, `cpyrht_div_cd` | text | 목록 |
| `mapx`, `mapy` | double precision | 목록 |
| `mlevel` | text | 목록 |
| `ldong_regn_cd`, `ldong_signgu_cd` | text | 목록 |
| `lcls_systm1`, `lcls_systm2`, `lcls_systm3` | text | 목록 |
| `overview` | text | common |
| `homepage` | text | common |
| `showflag` | smallint | 목록 |
| `createdtime`, `modifiedtime` | text (YYYYMMDDHHMMSS) | 목록 |
| `detail_fetched_at` | timestamptz null | 파이프라인(재개 플래그) |
| `updated_at` | timestamptz | 파이프라인 |

- `mapx`/`mapy`는 API가 문자열로 주지만 저장 시 숫자 캐스팅(좌표 쿼리 대비). 확정 전까지는 무손실 위해 text 유지도 가능 — 사용자 결정 사항.
- `showflag=0`(비표출)은 삭제하지 않고 플래그만 유지(소프트삭제).

## 에러 처리

- `resultCode != "0000"` → throw(기존 클라이언트 규칙).
- Phase 1 목록: 페이지 호출 실패 시 지수 백오프 재시도(간단), 재시도 소진 시 해당 페이지 로깅 후 중단(부분 진행분은 이미 커밋됨).
- Phase 2 세부: 콘텐츠별 try/catch로 격리 — 한 건 실패가 전체를 멈추지 않음.
  - `NODATA(03)`: 정상 스킵. `markDetailDone`으로 플래그 세팅(없는 데이터 무한 재조회 방지).
  - 요청제한 초과(`22`): 즉시 중단하고 안내(운영키 가정이나 방어).
  - 그 외: 로깅 후 다음 콘텐츠 계속.

## 테스트 (TDD · 모킹)

- **TourApiClient** (`axios` `vi.mock`): syncList 파싱(0/1/N건), `totalCount` 반환, `detailCommon` v4.4 파싱, `contentId`만 전송하는지, `resultCode != 0000` throw.
- **TourContentRepository** (`PostgresClient` mock 또는 쿼리 검증): upsert 멱등 SQL, `findPendingDetail` 필터, `updateDetail`/`markDetailDone`가 `detail_fetched_at` 세팅.
- **ingest 커맨드** (client·repo mock): 페이지 순회 종료 조건(`totalCount` 기반), `--limit` 준수, NODATA 스킵, 재개 시 pending만 처리.

## 검증 계획

1. `npm run typecheck` (src + tests) 통과.
2. `npm test` — 신규/수정 단위 테스트 전부 통과.
3. `npm run build` 성공.
4. (수동) 로컬 PostgreSQL + 실제 키로 `tb ingest list --page-size 10`(소량) → 행 생성 확인, `tb ingest detail --limit 5` → `overview`/`detail_fetched_at` 채워짐 확인.

## 범위 밖 (YAGNI)

- 임베딩(TEI)·Qdrant 색인·Gemini 가공 (다음 단계).
- 세부정보 중 `detailIntro2`(소개)·`detailInfo2`(반복)·`detailImage2`(이미지).
- `contentTypeId`별 필드 정규화(별도 테이블).
- 실시간/스케줄 동기화, 삭제 감지(`oldContentid` 기반) — 증분 재실행으로 대체.
