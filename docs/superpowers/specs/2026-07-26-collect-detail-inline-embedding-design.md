# core collect-detail 인라인 임베딩 설계 (Gemini 구조화 + TEI + Qdrant)

- 날짜: 2026-07-26
- 위치: `core/`
- 상태: 초안 (검토 대기)
- 선행 문서: `2026-07-25-detail-common-resumable-ingest-design.md`

## 목적

`tb collect-detail` 한 번 실행으로 **Postgres 적재와 Qdrant 벡터 색인이 함께 완료**되게 한다. 한 콘텐츠가 다음 체인을 통과한다:

```
PG 조회 → detailCommon2 → overview PG 저장 → Gemini 구조화 → TEI(bge-m3) 임베딩 → Qdrant 저장
```

선행 문서는 임베딩을 별도 3단계 커맨드(`tb embed-contents`)로 분리하기로 결정했다(`:49-74`). 본 문서는 그 결정을 뒤집고 **건당 인라인 체인**으로 통합한다.

## 선행 문서로부터의 변경

| 항목 | 선행 문서 | 본 문서 |
|------|-----------|---------|
| 임베딩 위치 | 별도 3단계 커맨드 `tb embed-contents` | **`collect-detail` 루프 안에 인라인** |
| Gemini | 범위 밖 (RAG 생성 단계에서만) | **임베딩 입력 텍스트 생성에 사용** |
| 임베딩 입력 | 미정 | **Gemini가 만든 고정 포맷 구조화 텍스트** |
| 코드→이름 변환 | 스코프 밖 (`lib/tourCodes.ts` 제외) | **필요 — Gemini 프롬프트에 분류명·지역명이 들어간다** |
| 상태 컬럼 | `detail_*` 한 벌 | **`detail_*` / `structure_*` / `embed_*` 세 벌** |

### 왜 스테이지 분리를 뒤집는가

선행 문서의 분리 근거 세 가지를 각각 재평가한다.

**근거 1 (쿼터 보호)는 커밋 순서로 해소된다.** 선행 문서의 주장은 "detailCommon 수신 직후 임베딩·Qdrant 저장까지 **한 트랜잭션으로** 처리하면 Qdrant 다운이 이미 소비한 API 호출을 날린다"였다(`:57`). 전제가 "한 트랜잭션"이다. `markDetailDone`을 Gemini 호출보다 **먼저 커밋**하면 그 시점에 TourAPI 호출은 영구 보존되고, 이후 Gemini·TEI·Qdrant의 어떤 실패도 복구 가능한 실패가 된다. 근거 1은 커밋 경계 설계로 무력화된다.

**근거 2 (재임베딩 비용 0)는 `structured_text` 저장으로 유지된다.** Gemini 산출물을 컬럼에 보존하므로 임베딩 모델을 바꿀 때 `UPDATE tour_contents SET embed_status='pending'` 한 줄이면 되고 Gemini 재호출은 0이다. 저장하지 않으면 이 근거가 실제로 깨지므로 **`structured_text` 컬럼은 선택이 아니라 필수다.**

**근거 3 (배치 이점)은 실제로 포기한다.** `TeiEmbeddingClient.embed(texts[])`를 건당 `embed([text])`로 호출해 배치 처리량을 버린다. 수용하는 이유는 (a) Gemini가 어차피 건당 호출이라 루프가 이미 항목 단위다, (b) TEI가 자체 호스팅이라 호출 수에 비용이 없다, (c) **속도가 요구사항이 아니다.**

### 대가: Gemini rate limit이 TourAPI 소비 속도를 지배한다

순차 체인의 한 바퀴 속도는 가장 느린 구간에 맞춰지고, 그것은 Gemini(free tier 분당 호출 제한)다. 문제는 TourAPI 쿼터가 **오늘 쓰지 않으면 소멸하는 자원**이라는 점이다. Gemini 일일 한도가 먼저 바닥났을 때 루프를 중단하면 오늘의 TourAPI 예산 900건을 태우지 못한다.

**따라서 Gemini 실패는 절대 루프를 중단시키지 않는다.** 구조화 단계만 건너뛰고(`structure_status='pending'` 유지) 상세 수집은 예산 끝까지 계속한다. 건너뛴 항목은 백로그 경로가 나중에 처리한다. 두 쿼터를 같은 등급으로 취급하면 희소한 쪽이 손해를 본다.

## 결정 사항

| 항목 | 선택 |
|------|------|
| 결합 방식 | **건당 인라인 체인** (한 커맨드, 한 루프) |
| 커밋 순서 | `markDetailDone` → `markStructureDone` → `markEmbedDone`, **각각 즉시 커밋** |
| detailCommon2 사용 필드 | **`overview`만** (현행과 동일, 변경 없음) |
| 임베딩 텍스트 | Gemini가 만든 **고정 포맷 텍스트** (JSON structured output 아님) |
| Gemini 산출물 저장 | `structured_text TEXT` 컬럼 — 재임베딩 비용을 0으로 유지 |
| Gemini 입력의 코드→이름 | **SQL LEFT JOIN** (인메모리 맵 `loadTourCodeTables` 미도입) |
| 임베딩 모델 | TEI 서버의 **bge-m3** — dense 1024차원 |
| 거리 함수 | Cosine (`QdrantStore` 기본값, `normalize=true`와 정합) |
| 청킹 | **없음.** 1항목 = 1 point |
| Qdrant point id | **`Number(contentid)`** — 결정론적이라 재실행이 덮어쓴다 |
| `overview`가 빈 문자열 | **최소 텍스트 폴백** (Gemini 없이 코드로 조립) |
| Gemini 응답 검증 | 7개 라벨 + 제목 줄 구분자 확인 |
| 동시성 | **없음 (순차 고정).** 속도가 요구사항이 아니다 |
| 백로그 처리 | `--skip-detail`로 체인 뒷부분만 실행 |
| `collect-detail` 진입점 | 기존 `collectDetail()`에 **옵셔널 enricher 훅** 추가 |

## 아키텍처

```
tb collect-detail
│
├ 상세 수집 경로 (기본)
│   claimPendingContents(pg, dailyLimit)          ← detail_status='pending'
│   for each contentid:
│     detailCommon2 ─────────────────────────────── TourAPI 한도초과면 여기서만 루프 중단
│       ├ NODATA → markDetailNodata → continue     (체인 뒷부분 진입 안 함)
│       └ 성공  → markDetailDone(overview)   ★커밋 = TourAPI 쿼터 영구 확보
│                   │
│                   └─ enricher.enrich(contentid)  ← 이 아래는 전부 복구 가능한 실패
│                        (fetchEnrichInput → 구조화 → 임베딩 → upsert)
│
└ 백로그 경로 (--skip-detail)
    enrichBacklog(pg, enricher, limit)
      detail_status='done' AND structure_status='pending'  → Gemini부터
      structure_status='done' AND embed_status='pending'   → TEI부터
      ※ 조회 조건이 detail_status='done'이라 nodata·failed는 자동 제외
```

`enricher.enrich(contentid)` 내부:

```
fetchEnrichInput(pg, contentid)                 -- 코드표 LEFT JOIN 단건 조회
  │                                                (이름 + 코드·좌표 + structured_text)
  ├ structured_text 있음 → 재사용                -- Gemini 미호출
  ├ overview 공백      → buildMinimalText(input) -- Gemini 미호출
  └ 그 외              → gemini.generate(prompt) -- temperature 0
                           → validateStructuredText()
  │
markStructureDone(pg, contentid, text)          ★커밋
  │
tei.embed([text])                               -- bge-m3 → number[1024]
  │
qdrant.upsert(collection, [{ id: toPointId(contentid), vector, payload: toPayload(input) }])
  │
markEmbedDone(pg, contentid)                    ★커밋
```

### enricher 훅으로 기존 함수를 보존한다

인라인이므로 임베딩 체인이 페이즈1 루프 안에 들어가야 하고, `services/collectDetail.ts`를 무수정으로 둘 수는 없다. 다만 수정을 **인자 하나와 호출 한 줄**로 묶는다:

```ts
export interface Enricher {
  /** 상세 저장 직후 구조화·임베딩 체인을 수행한다. DB 쓰기 실패만 throw한다. */
  enrich(contentid: string): Promise<void>;
  stats(): EnrichStats;
}

export async function collectDetail(
  tourApi: TourApiClient,
  pg: PostgresClient,
  opts: CollectDetailOptions = {},
  enricher?: Enricher,          // 신규
): Promise<CollectDetailResult>
```

`markDetailDone` 직후 `await enricher?.enrich(contentid)` 한 줄을 추가한다. 얻는 것:

- `collectDetail`의 기존 책임(쿼터 관리·재개·연속 실패 차단기)이 그대로 유지되고 기존 테스트가 전부 통과한다.
- `enricher`를 넘기지 않으면 현행 동작과 완전히 동일 → **`--skip-embed`가 공짜로 구현된다.**
- 백로그 경로가 **같은 `enricher`를 재사용**한다 → 인라인과 백로그가 동일한 코드로 동일한 결과를 만든다.

**enricher는 자기 실패를 스스로 삼킨다.** 구조화·임베딩 실패로 예외를 던지면 상세 수집 루프가 죽어 TourAPI 예산이 낭비된다. 유일한 예외는 DB 쓰기 실패로, 이건 전파해 실행을 중단시킨다(선행 문서 함정 5와 동일 원리).

**Gemini 연속 실패 차단기는 enricher 내부에 둔다.** 차단기에 걸리면 enricher가 **스스로를 비활성화**해 이후 `enrich()` 호출을 no-op으로 만든다. `collectDetail`은 이 사실을 알 필요가 없고, 상세 수집은 예산 끝까지 계속된다.

## 스키마

```sql
ALTER TABLE tour_contents
  ADD COLUMN IF NOT EXISTS structured_text         TEXT,          -- NULL = 아직 생성 안 함
  ADD COLUMN IF NOT EXISTS structure_status        TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS structure_attempt_count INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS structure_last_error    TEXT,
  ADD COLUMN IF NOT EXISTS structured_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS embed_status            TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS embed_attempt_count     INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embed_last_error        TEXT,
  ADD COLUMN IF NOT EXISTS embedded_at             TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tour_contents_structure_pending
  ON tour_contents (contentid)
  WHERE detail_status = 'done' AND structure_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_tour_contents_embed_pending
  ON tour_contents (contentid)
  WHERE structure_status = 'done' AND embed_status = 'pending';
```

`structure_status` / `embed_status` 값은 `DetailStatus`와 같은 어휘를 쓴다: `pending | done | failed`. (`nodata`는 상세 단계 고유 개념이라 쓰지 않는다.)

### `createTourContentsTable`에 ALTER를 추가해야 한다

현행 함수는 `CREATE TABLE IF NOT EXISTS`뿐이다(`lib/tourContentsTable.ts:29-59`). 테이블이 **이미 존재하므로 그 구문은 통째로 no-op이 되고 신규 컬럼이 절대 생기지 않는다.** `ADD COLUMN IF NOT EXISTS`는 멱등이라 기존 관례(마이그레이션 프레임워크 미도입, 커맨드 내 DDL 직접 실행)를 유지한 채 같은 함수에 붙일 수 있다.

신규 테이블 생성 시에도 정상 동작하도록 `CREATE TABLE` 다음에 `ALTER TABLE`을 배치한다.

### 부분 인덱스 두 개의 조건이 스테이지 진행을 강제한다

`idx_tour_contents_embed_pending`의 조건이 `structure_status='done'`인 것은 의도적이다. 구조화되지 않은 항목은 임베딩 대상이 될 수 없고, 이 조건이 그 순서를 조회 수준에서 보장한다.

## Gemini 구조화

### 입력 조회 — `fetchEnrichInput`

`tour_contents`에는 분류·지역이 **코드로만** 들어 있다(`lcls_systm1='AC'`). 코드 문자열을 프롬프트에 넣으면 의미가 없으므로 코드표를 조인한다.

```sql
SELECT c.contentid, c.title, c.addr1, c.addr2, c.overview, c.structured_text,
       -- payload 구성용 원본 코드·좌표
       c.contenttypeid, c.ldong_regn_cd, c.ldong_signgu_cd,
       c.lcls_systm1, c.lcls_systm2, c.lcls_systm3, c.mapx, c.mapy,
       -- 프롬프트 구성용 이름
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
```

**한 번의 조회가 체인 전체의 입력을 공급한다.** 이름(프롬프트용) · 코드와 좌표(payload용) · `structured_text`(이미 구조화됐는지 판정용)를 함께 가져온다. `structured_text`를 위해 별도 조회 함수를 두지 않는다 — 같은 행을 두 번 읽을 이유가 없다.

**인메모리 맵(`loadTourCodeTables`) 대신 SQL join을 쓰는 이유:** 로드·수명 관리 코드가 없어지고, 무엇보다 인라인 경로와 백로그 경로가 같은 함수로 **같은 입력**을 본다. 재구조화 결과가 달라지지 않는다.

`LEFT JOIN` + `COALESCE`이므로 코드표에 없는 신규 코드는 빈 문자열이 된다(선행 문서의 soft reference 정책 유지, `:115`). 건당 1쿼리이며 100건 규모에서 부담이 없다.

### systemInstruction (고정, 매 호출 동일)

```
당신은 여행 일정 추천 시스템의 검색 색인을 만드는 편집자다.
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
{제목} — {분류}
무엇을 하는 곳: {활동 2~4개, 쉼표 구분}
실내/실외: {실내 | 실외 | 실내외 혼합}
추천 동반자: {가족 | 커플 | 친구 | 혼자 | 단체 중 해당하는 것, 쉼표 구분}
적정 소요시간: {1시간 이내 | 1~2시간 | 2~3시간 | 반나절 이상}
계절/날씨: {사계절 | 여름 성수기 | 봄 벚꽃철 | 비 오는 날에도 가능 | ...}
분위기: {짧은 구 하나}
설명: {3문장 이내}
```

### prompt (항목별)

```
제목: {title}
관광타입: {content_type_nm}
분류: {lcls1_nm} > {lcls2_nm} > {lcls3_nm}
지역: {regn_nm} {signgu_nm}
주소: {addr1} {addr2}
설명 원문:
{overview}
```

`temperature: 0`. 같은 입력에 같은 출력이 나와야 재구조화 시 벡터가 흔들리지 않는다.

빈 값은 해당 줄을 생략한다(`분류: >  >` 같은 무의미한 입력을 만들지 않는다).

### 규칙 5의 의도 — 지역을 벡터에서 증폭하지 않는다

지역·타입은 `ldong_regn_cd` / `contenttypeid`로 **정확히** 필터링되는 정형 조건이다. 이를 벡터에 별도 섹션으로 넣으면 "부산"이 모든 부산 항목의 벡터를 서로 비슷하게 만들어, 정작 "아이랑 갈 실내" 같은 의미 축의 해상도를 떨어뜨린다.

단 `overview` 원문에는 지역명이 원래 들어 있어 완전 차단은 불가능하고 필요도 없다. 규칙 5는 **별도 섹션으로 증폭하지 않는다**는 뜻이며, 프롬프트 입력에 지역을 주는 것은 Gemini의 맥락 파악용이다.

### 응답 검증 — `validateStructuredText`

고정 포맷 텍스트를 택한 대가다. 검증이 없으면 Gemini가 포맷을 어겨도 아무도 모르고 색인 품질이 조용히 썩는다. 최소 검증만 한다:

- **7개 라벨**(`무엇을 하는 곳:`, `실내/실외:`, `추천 동반자:`, `적정 소요시간:`, `계절/날씨:`, `분위기:`, `설명:`)이 모두 존재
- 첫 줄(제목 줄)에 `—` 구분자 존재
- 전체가 공백이 아님

어기면 `Error`를 던져 구조화 실패로 분류된다(재시도 대상). 순수 함수이며 네트워크·DB 접근이 없다.

100건 테스트에서 **포맷 준수율을 측정하는 것이 이 검증의 1차 목적이다.** 검증이 없으면 준수율 자체를 알 수 없다.

### `overview`가 빈 문자열인 항목 — 최소 텍스트 폴백

`nodata`는 체인에 진입하지 않지만, API가 정상 응답하면서 `overview`를 비워 보내는 경우는 생긴다(`markDetailDone`이 `detail.overview ?? ""`를 저장하므로 `done` + `''`). Gemini에 줄 재료가 없다.

**Gemini를 호출하지 않고 코드로 최소 텍스트를 조립한다:**

```
{title} — {content_type_nm}
{lcls1_nm} > {lcls2_nm} > {lcls3_nm}
```

건너뛰지 않는 이유: 검색 대상에서 빠진 관광지는 일정 추천에 **영구히 등장하지 않는다.** 이름과 분류만으로도 "해운대해수욕장 / 해수욕장"은 검색 가치가 있다. `structure_status='done'`으로 기록하고 통계에 폴백 건수를 따로 센다.

## Qdrant 설계

### point id = `Number(contentid)`

Qdrant는 point id로 **unsigned integer 또는 UUID만 허용**한다. `contentid`는 TEXT 컬럼이지만 TourAPI가 주는 값은 숫자 문자열이라 캐스팅이 성립한다. 숫자로 파싱되지 않는 값은 스킵하고 `logger.warn`으로 기록한다.

이 결정론적 id가 안전망을 공짜로 준다: **Qdrant upsert는 성공했는데 직후 `markEmbedDone`이 실패하면**, 다음 실행이 같은 항목을 재임베딩해 **같은 id에 덮어쓴다.** 중복 point가 생기지 않는다. 랜덤 UUID였다면 유령 point가 쌓인다.

### payload — 필터 키 + 최소 표시 필드

Postgres가 원본 진실이고 Qdrant는 파생 인덱스이므로 전체 복제는 하지 않는다.

```
contentid       (원본 문자열 — PG 재조회용)
contenttypeid
ldong_regn_cd
ldong_signgu_cd
lcls_systm1 / lcls_systm2 / lcls_systm3
title
mapx / mapy
```

지역·타입 필터가 여기서 나온다. `overview`·`structured_text`·연락처 등은 넣지 않고 검색 결과의 `contentid`로 PG를 조회한다.

### 컬렉션 — 차원 자동 감지, 불일치는 에러

- 컬렉션 이름: env `QDRANT_COLLECTION`, 기본 `tour_contents`.
- 실행 시작 시 `tei.embed(["차원 확인"])`을 **1회** 호출해 벡터 길이로 차원을 확정한다(bge-m3면 1024).
- 컬렉션이 없으면 그 차원 + Cosine으로 생성한다.
- 컬렉션이 있으면 차원을 비교하고 **불일치 시 즉시 에러로 중단**한다.

**자동 삭제·재생성은 하지 않는다.** 컬렉션을 날리는 것은 파괴적이고 되돌릴 수 없으므로 사람이 결정할 일이다. 에러 메시지에 기존 차원·감지된 차원·컬렉션 이름을 담아 판단 재료를 준다.

차원을 env에 하드코딩하지 않는 이유: TEI에 뜬 모델과 어긋나면 조용히 틀린 색인이 만들어진다. 시작 시 1회 감지는 fail fast로 첫 항목 처리 전에 문제를 드러낸다.

### 청킹 없음

bge-m3의 컨텍스트는 8192 토큰이고 고정 포맷 텍스트는 수백 토큰이다. 1항목 = 1 point로 두고 `TeiEmbeddingClient`의 기본값(`normalize: true`, `truncate: true`)을 그대로 쓴다. `promptName`은 쓰지 않는다 — bge-m3는 지시문 프리픽스 없이 동작한다.

## 에러 처리

| 실패 지점 | 상태 변경 | attempt | 루프 |
|---|---|---|---|
| **TourAPI 한도초과** | **변경 없음** | **미증가** | **즉시 중단** (`quota-exceeded`) |
| TourAPI `NODATA(03)` | `detail_status='nodata'`, `overview=''` | 미증가 | 계속, 체인 미진입 |
| TourAPI 기타 오류 | `markDetailFailure` | +1 | 계속, **연속 10회면 중단** (`aborted`) |
| **Gemini 429 / rate limit** | 백오프 재시도 → 실패 시 **변경 없음** | **미증가** | **계속** (구조화만 건너뜀) |
| Gemini 기타 오류·빈 응답·검증 실패 | `structure_attempt_count`+1, 상한 도달 시 `structure_status='failed'` | +1 | 계속, **연속 10회면 enricher 자기 비활성화** |
| TEI / Qdrant 실패 | `embed_attempt_count`+1, 상한 도달 시 `embed_status='failed'` | +1 | 계속 |
| `Number(contentid)` 파싱 실패 | `embed_status='failed'` + `logger.warn` | — | 계속 |
| **DB 쓰기 실패** | 변경 없음 | 미증가 | **예외 전파 → 중단** |

`--max-attempts`는 세 단계(`detail` / `structure` / `embed`)에 같은 값으로 적용한다.

### 선행 문서의 함정이 두 번 더 재현된다

**함정 1 (쿼터를 데이터 탓으로 돌리지 않기)** — Gemini 429에서 `structure_attempt_count`를 올리면, 매일 Gemini 한도가 끝나는 지점의 항목이 하루 한 번씩 실패를 쌓아 사흘이면 멀쩡한 데이터가 `failed`로 영구 제외된다. 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이다.

**함정 4 (시스템 장애가 개별 항목 오류로 위장)** — Gemini API 키 만료·네트워크 단절은 429도 아니고 정상도 아니어서 일반 오류 분기로 들어온다. 차단기가 없으면 claim한 전량에 실패가 기록된다. 연속 실패 차단기로 손상을 10건으로 묶는다.

**함정 5 (DB 쓰기 실패 오분류)** — `try`는 외부 호출만 감싼다. Gemini는 성공했는데 `markStructureDone`이 실패한 경우가 일반 오류 분기로 흘러가면, 이미 태운 Gemini 쿼터를 버리면서 멀쩡한 항목의 attempt를 올린다.

### 신규 함정 — 임베딩 실패가 상세 수집을 막는 것

인라인 구조가 새로 만드는 위험이다. `enricher.enrich()`가 예외를 던지면 상세 수집 루프가 죽고, **소멸성 자원인 오늘의 TourAPI 예산이 복구 가능한 실패 때문에 낭비된다.**

enricher는 DB 쓰기 실패를 제외한 모든 실패를 내부에서 분류·기록하고 정상 반환한다. 이 계약이 인라인 설계의 안전성을 떠받친다.

## CLI

```
tb collect-detail [--daily-limit <n>]   # 처리 건수 상한 (기본 900)
                  [--max-attempts <n>]  # detail/structure/embed 공통 (기본 3)
                  [--skip-detail]       # 상세 수집 생략 — 백로그만 처리
                  [--skip-embed]        # 구조화·임베딩 생략 — 현행 동작
```

- `--skip-detail` 모드에서 `--daily-limit`은 **백로그 처리 건수 상한**으로 재해석된다(TourAPI 호출이 0이므로).
- `--skip-detail`과 `--skip-embed`를 함께 주면 아무 일도 하지 않으므로 **검증 에러로 거부**한다.
- `--concurrency`는 두지 않는다. 순차 고정.
- `--embed-limit`은 두지 않는다. 인라인이므로 Gemini 호출 수 = 처리 건수이고 `--daily-limit`이 이미 상한이다.

`index.ts`는 수정하지 않는다(`registerCollectDetail`이 이미 등록되어 있다).

출력 예:

```
시작 — pending 1,234 / done 500 / nodata 12 / failed 3, 예산 900
      컬렉션 tour_contents (1024차원, Cosine) 확인
[  1/900] 126508 해운대해수욕장 … 상세 done / 구조화 done / 임베딩 done
...
종료 — 상세 900건 (done 880, nodata 15, 재시도대기 5)
       구조화 880건 (done 875 — 그중 폴백 12, 재시도대기 5)
       임베딩 875건 upsert
       남은 pending 334 / 구조화대기 5 / 임베딩대기 0. 내일 다시 실행하세요.
```

`stoppedBy`별 마지막 줄 안내는 선행 문서(`:347-351`)를 그대로 따른다.

## 컴포넌트

### 1. `lib/tourContentsTable.ts` (수정)

```ts
export type StageStatus = "pending" | "done" | "failed";

// createTourContentsTable 에 ALTER TABLE + 인덱스 2개 추가 (멱등)

export interface EnrichInput {
  contentid: string; title: string; addr1: string; addr2: string; overview: string;
  /** null = 아직 구조화되지 않음 */
  structuredText: string | null;
  // payload 구성용 (원본 코드·좌표)
  contenttypeid: string;
  ldongRegnCd: string; ldongSignguCd: string;
  lclsSystm1: string; lclsSystm2: string; lclsSystm3: string;
  mapx: string; mapy: string;
  // 프롬프트 구성용 (코드표 join 결과)
  contentTypeNm: string;
  lcls1Nm: string; lcls2Nm: string; lcls3Nm: string;
  regnNm: string; signguNm: string;
}

export async function fetchEnrichInput(
  pg: PostgresClient, contentid: string,
): Promise<EnrichInput | null>

export async function markStructureDone(
  pg: PostgresClient, contentid: string, text: string,
): Promise<void>
export async function markStructureFailure(
  pg: PostgresClient, contentid: string, error: string, maxAttempts: number,
): Promise<StageStatus>

export async function markEmbedDone(pg: PostgresClient, contentid: string): Promise<void>
export async function markEmbedFailure(
  pg: PostgresClient, contentid: string, error: string, maxAttempts: number,
): Promise<StageStatus>

/** 구조화 대기 목록. detail_status='done' AND structure_status='pending' */
export async function claimStructurePending(pg: PostgresClient, limit: number): Promise<string[]>
/** 임베딩 대기 목록. structure_status='done' AND embed_status='pending' */
export async function claimEmbedPending(pg: PostgresClient, limit: number): Promise<string[]>

/** 세 스테이지의 상태별 건수 */
export async function countStageStatus(pg: PostgresClient): Promise<StageCounts>
```

`mark*Failure`는 `markDetailFailure`와 동일한 패턴 — 증가와 전이를 단일 UPDATE의 `CASE`로 처리하고 `RETURNING`으로 전이 결과를 돌려준다.

### 2. `lib/structuredText.ts` (신규, 순수 함수)

```ts
export const STRUCTURE_SYSTEM_INSTRUCTION: string

export function buildStructurePrompt(input: EnrichInput): string
export function buildMinimalText(input: EnrichInput): string
export function validateStructuredText(text: string): void   // 위반 시 throw
export function needsFallback(input: EnrichInput): boolean    // overview 공백 판정
```

네트워크·DB 접근 없음.

### 3. `clients/qdrant.ts` (수정 — 조회 메서드 1개 추가)

현행 `QdrantStore`에는 **컬렉션의 존재 여부나 벡터 차원을 읽는 메서드가 없다**(`createCollection`/`deleteCollection`/`upsert`/`search`/`deletePoints`만 있음). 차원 불일치를 감지하려면 조회가 필요하다:

```ts
/** 컬렉션 정보를 조회한다. 없으면 null. */
async getCollectionInfo(name: string): Promise<{ vectorSize: number } | null>
```

SDK의 `getCollection(name)`을 호출하고, 컬렉션이 없을 때의 에러(404)는 `null`로 변환한다. 다른 에러는 전파한다 — 연결 장애를 "컬렉션 없음"으로 오분류하면 기존 컬렉션 위에 다른 차원으로 재생성을 시도하게 된다.

### 4. `lib/qdrantCollection.ts` (신규)

```ts
export interface CollectionInfo { name: string; vectorSize: number }

/** TEI로 차원을 감지하고 컬렉션을 보장한다. 기존 차원과 불일치면 throw. */
export async function ensureCollection(
  qdrant: QdrantStore, tei: TeiEmbeddingClient, name: string,
): Promise<CollectionInfo>

/** contentid를 point id로 변환. 숫자가 아니면 null. */
export function toPointId(contentid: string): number | null

/** payload 구성 (순수 함수) */
export function toPayload(input: EnrichInput): Record<string, unknown>
```

### 5. `services/enricher.ts` (신규)

```ts
export interface EnrichStats {
  structured: number; fallback: number; structureRetry: number; structureFailed: number;
  embedded: number; embedRetry: number; embedFailed: number;
  geminiRateLimited: number; disabled: boolean;
}

export interface EnricherOptions {
  maxAttempts?: number;
  geminiRetries?: number;          // 429 백오프 재시도 횟수 (기본 3, 2s→4s→8s)
  maxConsecutiveFailures?: number; // 기본 10
}

export function createEnricher(
  gemini: GeminiClient, tei: TeiEmbeddingClient, qdrant: QdrantStore,
  pg: PostgresClient, collection: CollectionInfo, opts?: EnricherOptions,
): Enricher
```

`enrich(contentid)` 동작 순서:

1. 자기 비활성화 상태면 즉시 반환.
2. `fetchEnrichInput`. 행이 없으면 경고 후 반환.
3. `input.structuredText`가 이미 있으면 구조화를 건너뛰고 그 값을 쓴다(임베딩만 재실행하는 경로).
4. 아니면 `needsFallback` 판정 → `buildMinimalText` 또는 Gemini 호출 → `validateStructuredText`.
5. `markStructureDone`.
6. `tei.embed([text])` → `qdrant.upsert(collection, [{ id: toPointId(contentid), vector, payload: toPayload(input) }])` → `markEmbedDone`.

각 단계의 실패는 위 에러 처리 표대로 분류하고 정상 반환한다. DB 쓰기 실패만 throw.

### 6. `services/enrichBacklog.ts` (신규)

```ts
export interface EnrichBacklogResult { processed: number; stats: EnrichStats }

export async function enrichBacklog(
  pg: PostgresClient, enricher: Enricher, limit: number,
): Promise<EnrichBacklogResult>
```

`claimStructurePending` + `claimEmbedPending`을 합쳐(중복 제거) `limit`까지 순회하며 같은 `enricher.enrich()`를 호출한다.

### 7. `services/collectDetail.ts` (수정 — 최소)

옵셔널 `enricher?: Enricher` 인자 추가, `markDetailDone` 직후 `await enricher?.enrich(contentid)` 한 줄 추가. 그 외 로직 무변경.

`CollectDetailResult`에 `enrichStats?: EnrichStats`를 추가해 요약 출력에 쓴다.

### 8. `commands/collectDetail.ts` (수정)

```ts
const skipDetail = options.skipDetail ?? false;
const skipEmbed  = options.skipEmbed  ?? false;
if (skipDetail && skipEmbed) throw new Error("--skip-detail과 --skip-embed를 함께 쓸 수 없습니다.");

const pg = new PostgresClient();
await pg.connect();
try {
  let enricher: Enricher | undefined;
  let qdrant: QdrantStore | undefined;
  if (!skipEmbed) {
    const gemini = new GeminiClient();
    const tei = new TeiEmbeddingClient();
    qdrant = new QdrantStore();
    await qdrant.connect();
    const collection = await ensureCollection(qdrant, tei, collectionName);
    enricher = createEnricher(gemini, tei, qdrant, pg, collection, { maxAttempts });
  }

  if (skipDetail) {
    logger.info(formatBacklogSummary(await enrichBacklog(pg, enricher!, dailyLimit)));
  } else {
    const tourApi = new TourApiClient();
    logger.info(formatCollectDetailSummary(
      await collectDetail(tourApi, pg, { dailyLimit, maxAttempts }, enricher)));
  }
} finally {
  await qdrant?.close();
  await pg.close();
}
```

`--skip-embed`일 때 `GEMINI_API_KEY`·`TEI_BASE_URL`·`QDRANT_URL`이 없어도 동작해야 하므로 **클라이언트 생성을 조건부로 둔다**(생성자가 `requireEnv`로 throw하기 때문).

요약 포매터는 순수 함수로 유지해 테스트 가능하게 한다.

## 파일 구조

```
core/src/lib/tourContentsTable.ts      # 수정: ALTER + 인덱스 2개, fetch/mark/claim/count 함수 추가
core/src/lib/structuredText.ts         # 신규: 프롬프트 조립 + 검증 + 폴백 (순수 함수)
core/src/lib/qdrantCollection.ts       # 신규: 컬렉션 보장, point id·payload 변환
core/src/services/enricher.ts          # 신규: 건당 Gemini→TEI→Qdrant 체인 + 차단기
core/src/services/enrichBacklog.ts     # 신규: 백로그 순회
core/src/services/collectDetail.ts     # 수정: enricher? 인자 + 호출 1줄
core/src/commands/collectDetail.ts     # 수정: 조건부 클라이언트 배선, 플래그 2개, 요약 확장
core/src/clients/qdrant.ts             # 수정: getCollectionInfo 추가
core/src/clients/{gemini,tei}.ts       # 무수정 (기존 구현 재사용)
core/src/clients/tourApi.ts            # 무수정
core/src/index.ts                      # 무수정
core/.env.example                      # 수정: QDRANT_COLLECTION 추가

core/tests/lib/tourContentsTable.test.ts    # 수정/추가
core/tests/lib/structuredText.test.ts       # 신규
core/tests/lib/qdrantCollection.test.ts     # 신규
core/tests/clients/qdrant.test.ts           # 수정: getCollectionInfo
core/tests/services/enricher.test.ts        # 신규
core/tests/services/enrichBacklog.test.ts   # 신규
core/tests/services/collectDetail.test.ts   # 수정/추가
core/tests/commands/collectDetail.test.ts   # 수정/추가
```

기존 `logger`·`env` 헬퍼·`PostgresClient`를 재사용한다. 마이그레이션 프레임워크는 도입하지 않는다.

## 데이터 흐름

```
tour_contents (detail_status='pending')
      │ claimPendingContents(dailyLimit)
      ▼
  contentid
      │ detailCommon2 — overview만 사용
      ▼
markDetailDone ★커밋 ─── TourAPI 쿼터 여기서 영구 확보. 이후 실패는 전부 복구 가능
      │
      │ fetchEnrichInput — 코드표 3개 LEFT JOIN
      ▼
EnrichInput {이름(프롬프트용) + 코드·좌표(payload용) + overview + structured_text}
      │
      ├ structured_text 있음 → 재사용              (Gemini 미호출)
      ├ overview 공백       → buildMinimalText     (Gemini 미호출)
      └ 그 외               → Gemini(temp 0) → validateStructuredText
      │
      ▼
structured_text  ── markStructureDone ★커밋 ─── Gemini 쿼터 여기서 확보. 재임베딩 무료
      │
      │ tei.embed([text])  bge-m3 → number[1024]
      ▼
   vector
      │ qdrant.upsert(collection, [{ id: Number(contentid), vector, payload }])
      ▼
Qdrant point ── markEmbedDone ★커밋
```

## 테스트 (TDD · 모킹)

**`structuredText`** (순수 함수)
- `buildStructurePrompt`이 빈 값 줄을 생략
- `validateStructuredText`가 7개 라벨 전부 있는 텍스트를 통과시킴
- 라벨 하나가 빠지면 throw / 첫 줄에 `—`가 없으면 throw / 공백이면 throw
- `needsFallback`이 `''`·공백만·`\n`을 폴백 대상으로 판정
- `buildMinimalText`가 title·분류명으로 2줄 텍스트 생성

**`clients/qdrant`** (SDK `vi.mock`)
- `getCollectionInfo`가 존재하는 컬렉션의 벡터 차원을 반환
- 컬렉션이 없으면(404) `null` 반환
- **404가 아닌 에러는 전파** (연결 장애를 "없음"으로 오분류하지 않음)

**`qdrantCollection`**
- `toPointId`가 숫자 문자열을 숫자로, 비숫자를 `null`로 변환
- `ensureCollection`이 `tei.embed`를 1회 호출해 차원을 감지
- 컬렉션이 없으면 감지한 차원 + Cosine으로 생성
- 기존 컬렉션 차원이 다르면 throw하고 **`deleteCollection`을 호출하지 않음**
- 기존 컬렉션 차원이 같으면 생성하지 않고 통과
- `toPayload`가 지정된 키만 포함(`overview`·`structured_text`·이름 필드 미포함)

**`tourContentsTable`** (`PostgresClient` mock, 발행 SQL 검증)
- `createTourContentsTable`이 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`를 실행
- 인덱스 2개의 `WHERE` 조건이 스테이지 순서를 반영
- `mark*Failure`가 단일 UPDATE + `CASE` 전이 + `RETURNING`
- `claimStructurePending`이 `detail_status='done' AND structure_status='pending'` 사용
- `claimEmbedPending`이 `structure_status='done' AND embed_status='pending'` 사용
- `fetchEnrichInput`이 코드표 3개를 LEFT JOIN하고 `COALESCE`로 빈 문자열 보정
- `fetchEnrichInput`이 프롬프트용 이름과 payload용 코드·좌표·`structured_text`를 **한 쿼리로** 반환
- 행이 없으면 `null` 반환

**`enricher`** (gemini/tei/qdrant/pg mock)
- 정상 경로: Gemini → `markStructureDone` → embed → upsert → `markEmbedDone` 순서
- `overview` 공백 → **Gemini 미호출**, `buildMinimalText` 사용, 폴백 카운트 증가
- `structuredText`가 이미 있으면 **Gemini 미호출**, 임베딩만 수행
- Gemini 429 → 백오프 재시도 → 실패 시 `markStructureFailure` **미호출**(attempt 미증가), 정상 반환
- Gemini 기타 오류 → `markStructureFailure` 호출, 정상 반환(throw 없음)
- 검증 실패 → 구조화 실패로 분류, `markStructureDone` 미호출
- Gemini 연속 10회 실패 → 이후 `enrich()`가 no-op (Gemini·TEI 미호출), `stats().disabled === true`
- TEI 실패 → `markEmbedFailure`, `qdrant.upsert` 미호출
- Qdrant 실패 → `markEmbedFailure`, `markEmbedDone` 미호출
- `Number(contentid)` 파싱 실패 → `embed_status='failed'`, upsert 미호출
- **`markStructureDone` 실패 → 예외 전파** (유일하게 throw하는 경우)
- upsert 성공 후 `markEmbedDone` 실패 → 예외 전파

**`collectDetail`** (기존 테스트 + 추가)
- `enricher` 미전달 시 기존 테스트 전부 통과 (동작 무변경)
- `markDetailDone` **직후** `enrich(contentid)` 호출
- `NODATA` 시 `enrich` **미호출**
- TourAPI 한도초과 시 `enrich` 미호출 후 중단
- `enrich`가 no-op이 되어도 루프가 예산 끝까지 계속됨

**`enrichBacklog`**
- 구조화 대기 + 임베딩 대기를 합쳐 중복 없이 순회
- `limit` 준수
- 대상이 없으면 API 호출 0회

**`commands/collectDetail`**
- `--skip-detail --skip-embed` 동시 지정 → 에러
- `--skip-embed` 시 Gemini/TEI/Qdrant 클라이언트를 **생성하지 않음** (env 없어도 동작)
- 요약 포매터가 세 스테이지 집계를 모두 출력

## 검증 계획

1. `npm run typecheck` (src + tests) 통과
2. `npm test` — 신규/수정 단위 테스트 전부 통과
3. `npm run build` 성공
4. **100건 실측 스모크** — `tb collect-detail --daily-limit 100`

100건 테스트에서 확인할 것:

| 확인 항목 | 판단 기준 |
|---|---|
| 체인 완주 | 100건이 중단 없이 `embed_status='done'`에 도달 |
| 재개 | 중간에 강제 종료 후 재실행이 남은 항목부터 이어감 |
| **Gemini 포맷 준수율** | `validateStructuredText` 실패 건수 / 전체. 이 수치가 검증 로직의 1차 산출물 |
| **환각률** | 구조화 텍스트 20건을 **사람이 직접 읽고** "실내/실외"·"추천 동반자"가 원문·유형과 모순되지 않는지 센다 |
| 폴백 발생률 | `overview` 공백 항목 수 |
| Qdrant 멱등성 | `UPDATE tour_contents SET embed_status='pending'` 후 `tb collect-detail --skip-detail --daily-limit 100` → point 수가 **100 유지**(200 아님). 이때 Gemini는 호출되지 않아야 한다(`structured_text` 재사용) |
| 유사도 바닥값 | 무관한 두 항목(예: 해수욕장 vs 박물관)의 코사인 유사도. 라벨 공유로 0이 아닌 값이 나온다 |
| Gemini 소요 시간 | free tier 분당 제한 실측 → `--daily-limit` 운용값 결정 |

**100건으로 검색 임계값을 확정할 수는 없다.** 표본이 작아 어떤 질의를 던져도 top-K가 전체의 상당 비율이 되어 score 분포가 운영 환경과 다르게 나온다. 임계값은 수천 건 쌓인 뒤에 정한다.

## 알아둘 트레이드오프

**라벨 반복이 유사도 절대값을 끌어올린다.** `실내/실외:`·`추천 동반자:` 같은 라벨 문자열이 모든 벡터에 공유되므로 벡터 간 코사인 유사도의 **절대값이 전반적으로 상승**한다. 상대 순위는 유지되어 검색 품질에는 영향이 없지만, 나중에 "0.7 이상만 채택" 같은 절대 임계값을 쓰면 직관과 다르게 높은 값이 필요해진다.

완화책은 임계값을 쓰지 않는 것이다. `top-K`로 상위 N건을 가져와 Gemini에 넘기는 방식이면 score의 절대값은 아무 의미가 없다. 임계값이 꼭 필요하면 위 "유사도 바닥값" 측정에서 시작한다.

## 범위 밖 (YAGNI)

- **하이브리드 검색(sparse/ColBERT 병용)** — bge-m3는 멀티벡터 모델이지만 TEI `/embed`는 dense만 반환한다. dense 단일 벡터로 시작한다.
- **검색 임계값 확정** — 데이터가 쌓인 뒤 실측으로 정한다.
- **Gemini structured output(`responseSchema`)** — `GeminiClient`를 확장하지 않고 고정 포맷 텍스트로 간다. Gemini가 뽑은 속성(실내/실외 등)은 벡터 안에만 존재하고 payload 필터로는 쓸 수 없다.
- **동시성·배치 임베딩** — 순차 고정. 속도가 요구사항이 아니다.
- **청킹** — bge-m3 컨텍스트 8192에 고정 포맷 텍스트는 한참 미달.
- **`tb embed-contents` 별도 커맨드** — `enricher`/`enrichBacklog`가 독립 서비스라 나중에 배선만 추가하면 노출된다.
- **`firstimage`·`tel`·`homepage` 적재** — `areaBasedSyncList2`가 이미 내려주는데 projection에서 버렸다(`tour-info-ingest-design.md:53`). 필요해지면 `collect-list` projection에 추가해 **API 호출 0회로** 얻는다. detailCommon2를 기다릴 필요가 없다.
- **`detailIntro2`·`detailInfo2`·`detailImage2`** — `overview`만 쓴다.
- **`modifiedtime` 변경 감지 재구조화** — 원문이 갱신돼도 자동 재구조화하지 않는다. 필요 시 수동 `UPDATE`:
  `UPDATE tour_contents SET structured_text = NULL, structure_status = 'pending' WHERE contentid = ...`.
  `structure_status`만 되돌리면 재사용 분기가 남아 있는 (구) `structured_text`를 그대로
  `done`으로 수렴시켜버려 Gemini를 다시 부르지 않는다 — 반드시 두 컬럼을 함께 되돌린다.
- **Qdrant payload 전체 복제** — PG가 원본 진실. 필터 키 + 표시 필드만 둔다.
- **스케줄러·동시 실행 방지(advisory lock)** — 수동 실행 전제.
- **마이그레이션 프레임워크** — 커맨드 내 `CREATE TABLE` / `ALTER TABLE IF NOT EXISTS`.
