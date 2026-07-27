# backend 외부 서비스 클라이언트 설계 (Gemini 생성 / TEI 임베딩 / Qdrant 검색)

- 날짜: 2026-07-27
- 위치: `backend/`
- 상태: **승인됨** (2026-07-27, 미해결 질문 4건 해소)
- 선행 문서:
  - `docs/superpowers/specs/2026-07-23-core-integration-clients-design.md`
  - `docs/superpowers/specs/2026-07-23-core-tei-embedding-client-design.md`
  - `docs/superpowers/specs/2026-07-26-collect-detail-inline-embedding-design.md`

## 목적

`backend`가 외부 서비스를 호출할 수 있게 한다. 만드는 것은 **Gemini(텍스트 생성)** · **TEI(질의 임베딩)** · **Qdrant(벡터 검색)** 세 개다. 요구사항은 "여러 개의 client"였으므로, 이 문서의 실질적 산출물은 클라이언트 셋이 아니라 **네 번째 클라이언트가 붙을 때 반복되지 않아야 할 것이 무엇인지에 대한 결정**이다.

셋을 함께 만들면 **검색 경로가 실제로 닫힌다.** 이것이 이번 범위의 핵심 성질이다.

```
질의 텍스트 → TeiClient.embedQuery → number[1024] → QdrantSearchClient.search → TourSearchHit[]
                                                                                      │
                                                                       (이후) GeminiClient.generate
```

```
HTTP 요청 → 서비스 → 클라이언트 → callExternal(공통 통로) → SDK 또는 fetch → 외부 서비스
                                         │
                                    실패 시 ExternalServiceError(service, kind)
                                         │
                              ExternalServiceFilter → HTTP status
```

## 왜 클라이언트가 셋인가 — 검색 경로를 닫는 조건

요구사항 원문은 "gemini, qdrant client를 만들어"였다. 조사 결과 **그 둘만으로는 벡터 검색이 동작하지 않는다**는 사실이 드러났고, 이를 미해결 질문 1로 올려 "TEI를 함께 만든다"는 답을 받았다(아래 "미해결 질문과 답" 참조).

`QdrantStore.search`는 이미 계산된 벡터를 받는다(`core/src/clients/qdrant.ts:116-131`). 질의 텍스트를 벡터로 만드는 것은 TEI의 일이고, 색인은 **TEI의 bge-m3로 만들어졌다** — dense 1024차원, Cosine, `normalize=true`(`2026-07-26-collect-detail-inline-embedding-design.md:54-55`, `core/src/lib/qdrantCollection.ts:15`, `core/src/clients/tei.ts:25`).

Gemini에도 임베딩 API가 있지만 **그것으로 질의 벡터를 만들면 안 된다.** 색인 벡터와 질의 벡터가 다른 모델에서 나오면 코사인 유사도는 의미 없는 숫자가 된다. 차원이 다르면 Qdrant가 400으로 거절하고(에러 표의 `dimension-mismatch`), 우연히 차원이 같으면 **조용히 무작위에 가까운 결과**가 나온다 — 후자가 훨씬 나쁘고, 테스트로는 절대 잡히지 않는다. 검증 계획의 "상위 결과 사람 판정"이 이걸 잡기 위한 항목이다.

### 세 번째 클라이언트가 이 설계의 구조 검증이다

TEI가 이번에 함께 들어오는 것은 범위 확대인 동시에 **공통화 경계가 옳은지 검사할 기회**다. 판정 기준은 명확하다:

> TEI를 붙일 때 **공통 파일에서 수정되는 것은 `external-service.error.ts`의 `ExternalService` 유니온에 `'tei'` 리터럴 한 줄을 더하는 것뿐이어야 한다.** `callExternal`·`classifyCommonFailure`·`ExternalServiceFilter`·`ClientsModule`의 본문에 손을 대야 한다면 공통화 경계가 틀린 것이다.

이 기준은 검증 계획에 판정 항목으로 들어간다. 특히 TEI는 **SDK가 없다** — 자체 호스팅 REST 엔드포인트라 `fetch`로 직접 부른다. SDK 두 개와 생 `fetch` 하나를 같은 `callExternal`이 감쌀 수 있다면 경계가 SDK 모양에 의존하지 않는다는 뜻이고, 그게 네 번째 클라이언트에 대한 최선의 증거다.

## 현행 확인

설계를 제안하기 전에 확인한 사실이다. 여기서 틀리면 아래 결정이 전부 무너진다.

| 확인 항목 | 사실 | 근거 |
|---|---|---|
| backend에 `ConfigModule.forRoot`가 있는가 | **없다** | `src` 전체 grep 결과 `ConfigModule` 참조는 `database.module.ts:2,23`뿐 |
| `validateEnv`를 부르는 곳이 있는가 | **없다 — 죽은 코드다** | `src/config/env.validation.ts:8` 정의, 호출자 0 |
| `validateEnv`가 무엇을 검사하는가 | `DATABASE_URL`이 **비어 있지 않은 문자열인지**. 도달성은 보지 않는다 | `src/config/env.validation.ts:12` |
| `DatabaseModule`이 배선돼 있는가 | **없다.** `AppModule`은 `ChatModule`만 import한다 | `src/app.module.ts:7` |
| `ChatModule`이 DB를 쓰지 않는 이유 | 의도적. "Postgres는 사내망에서만 도달하므로 배선하면 외부망에서 부팅이 매달린다" | `src/chat/chat.module.ts:7-9` |
| `ChatService`가 필요로 하는 LLM 기능 | "대화 이력과 현재 일정을 LLM에 넘겨 **reply와 수정된 itinerary**를 받는다" | `src/chat/chat.service.ts:12-13` |
| e2e 테스트가 `AppModule`을 통째로 띄우는가 | **그렇다** | `test/app.e2e-spec.ts:12` |
| backend가 core를 의존할 수 있는가 | **아니다.** `core/package.json`에 `main`도 `exports`도 없고, 루트에 package.json이 없어 워크스페이스도 아니다 | `core/package.json`, `.claude/skills/tb-tdd-implement/references/workspaces.md` |
| `core/dist`가 저장소에 있는가 | **없다.** `git ls-files core/dist` 결과 0건 (로컬 빌드 산출물) | git |
| core Gemini의 빈 응답 처리 | `response.text ?? ""` — **빈 문자열을 성공으로 반환한다** | `core/src/clients/gemini.ts:31` |
| core Qdrant의 타임아웃 | **설정하지 않는다.** SDK 기본값은 300000ms(5분) | `core/src/clients/qdrant.ts:50`, Qdrant JS 클라이언트 `QdrantClientParams.timeout` 기본 300000 |
| core Qdrant search가 payload를 요청하는가 | `with_payload`를 **보내지 않는다** | `core/src/clients/qdrant.ts:121-125` |
| Qdrant payload 인덱스 | core가 만들지 않는다 (`qdrantCollection.ts`에 `createPayloadIndex` 없음) | `core/src/lib/qdrantCollection.ts` |
| TEI env 키 이름 | **`TEI_BASE_URL`** (필수 1개, 인증 없음) | `core/src/clients/tei.ts:15`, `core/.env.example:18` |
| core TEI의 기본 옵션 | `normalize: true`, `truncate: true`. `prompt_name`은 미지정 시 바디에서 생략 | `core/src/clients/tei.ts:22-30` |
| core가 실제로 배치 임베딩을 하는가 | **아니다.** 모든 호출부가 `embed([단건])`이다 | `core/src/services/enricher.ts:249`, `core/src/lib/qdrantCollection.ts:31` |
| core TEI의 HTTP 수단 | axios (`POST {TEI_BASE_URL}/embed`) | `core/src/clients/tei.ts:1,31` |
| backend에 axios가 있는가 | **없다.** Node 24.15의 전역 `fetch`를 쓸 수 있다 | `backend/package.json` |
| backend tsconfig의 `baseUrl`/`paths` | **없다** (TS7 `TS5102`로 제거됨) → import는 전부 상대 경로 | `backend/tsconfig.json` |

## 결정 사항

| 항목 | 선택 |
|------|------|
| core 클라이언트 | **재사용하지 않는다. NestJS 래핑으로 새로 만든다** (아래 3안 비교) |
| Gemini 용도 | **텍스트 생성 전용.** 임베딩은 만들지 않는다 |
| Gemini 메서드 | `generate(prompt, opts)` — core와 **동일 시그니처** |
| Gemini 빈 응답 | **실패로 분류**한다 (core와 갈라지는 지점) |
| TEI 용도 | **질의 임베딩 전용.** 색인용 배치 임베딩은 만들지 않는다 |
| TEI 메서드 | **`embedQuery(text): Promise<number[]>` 단건 전용** (core는 배치 시그니처) |
| TEI 옵션 노출 | **없음.** `normalize: true` · `truncate: true` 고정, `prompt_name` 미사용 |
| TEI HTTP 수단 | **전역 `fetch`** (axios 추가하지 않음) |
| TEI 차원 검증 | **하지 않는다.** 차원 불일치는 Qdrant가 판정한다 (하드코딩 회피) |
| Qdrant 용도 | **읽기 전용.** `search` + 진단용 `getCollectionInfo`만 |
| Qdrant 쓰기 | **없음.** 컬렉션 생성·upsert·삭제는 core 소유 |
| Qdrant 대상 컬렉션 | **생성자에서 고정.** `search`에 컬렉션 인자를 두지 않는다 |
| Qdrant SDK API | `query()` (현행 통합 API). core는 `search()`를 쓴다 |
| 검색 필터 | **타입 있는 `TourSearchFilter`** → 순수 함수가 Qdrant 필터로 변환 |
| payload | `with_payload: true` **명시**, `with_vector`는 요청하지 않음 |
| 설정 주입 | **`ConfigService`.** 클라이언트가 `process.env`를 직접 읽지 않는다 |
| env 검증 위치 | **`validateEnv` 한 곳** — `ConfigModule.forRoot({ validate })`로 부팅 시 실행 |
| env 키 이름 | **core와 동일** (`GEMINI_API_KEY` · `QDRANT_URL` · `QDRANT_COLLECTION` …) |
| 재시도 | **0회.** 백오프 재시도를 두지 않는다 (core와 갈라지는 지점) |
| 서킷 브레이커 | **없음** |
| 타임아웃 | **SDK/플랫폼 네이티브.** Gemini `abortSignal` 20s / TEI `fetch` + `AbortSignal.timeout` 5s / Qdrant 생성자 `timeout` 5s |
| 오류 표현 | 공통 `ExternalServiceError { service, kind }` |
| HTTP 매핑 | 전역 `ExternalServiceFilter` 한 곳. **어떤 kind도 4xx가 되지 않는다** |
| 외부 호출 통로 | **`callExternal()` 단 하나.** 클라이언트가 SDK·`fetch`를 직접 호출하지 않는다 |
| 모듈 등록 | `ClientsModule` 하나에 모든 클라이언트. **`@Global()`은 쓰지 않는다** |
| `ClientsModule` 배선 | 이번엔 `AppModule`에 넣지 않는다 (소비자가 생길 때 그 모듈이 import) |
| 로거 | Nest 내장 `Logger` (core의 `lib/logger.ts`를 옮겨오지 않는다) |
| 테스트 모킹 경계 | **SDK 모듈 경계** (`jest.mock('@google/genai')` / `jest.mock('@qdrant/js-client-rest')`) · TEI는 **전역 `fetch` 스텁** |
| import 경로 | **상대 경로만.** `baseUrl`/`paths`가 없으므로 `@/` 별칭을 쓰지 않는다 |

## 왜 core 클라이언트를 재사용하지 않는가

세 안을 비교한다.

| | A. core 재사용 (`file:../core`) | B. 소스 이식 (복사) | C. NestJS 래핑 재구현 |
|---|---|---|---|
| 계약 일치 | 코드로 보장 | 복사 시점만 일치 | 문서·테스트로만 보장 |
| 모듈 시스템 | **ESM ↔ CJS 경계를 넘어야 함** | 없음 | 없음 |
| jest 동작 | **깨진다** (아래) | 정상 | 정상 |
| 빌드 결합 | **`core/dist` 선행 빌드 필요 (미추적 산출물)** | 없음 | 없음 |
| DI | 수동 `useFactory`로 감싸야 함 | 데코레이터 추가 필요 | 자연스러움 |
| 설정 | 생성자가 `process.env` 직접 읽음 | 고쳐야 함 | `ConfigService` |
| 불필요한 표면 | upsert·컬렉션 생성·삭제가 딸려옴 | 지워야 함 | 없음 |
| 중복 | 없음 | 최대 | 중간 |

**A를 기각하는 결정적 이유는 jest다.** `core`는 `"type": "module"`이고 `backend`는 CJS다(`backend/package.json`에 `type` 없음). Node 24 자체는 `require(ESM)`을 지원하지만, jest는 CJS 런타임에서 `node_modules` 안의 ESM을 `transformIgnorePatterns` 기본값 때문에 변환하지 않고 `Cannot use import statement outside a module`로 죽는다. 이걸 뚫으려면 backend의 jest 설정을 ESM 모드로 바꾸거나 `transformIgnorePatterns`에 예외를 파야 하는데, 그 순간 `ts-jest` + `emitDecoratorMetadata` + `@nestjs/testing` 조합 전체가 검증 대상이 된다. **클라이언트 두 개를 얻으려고 테스트 인프라를 뒤집는 거래다.**

부차적으로, A는 `core/package.json`에 `exports` 필드를 추가해야 하고(현재 `bin`과 `files: ["dist"]`만 있어 `import "@travel-builder/core"`가 해석되지 않는다), `core/dist`가 git에 없으므로 backend를 빌드하려면 core를 먼저 빌드해야 한다. 저장소에 없던 빌드 순서 의존을 새로 만든다.

**B를 기각하는 이유는 복사가 곧 낡기 때문이다.** 이식한 순간부터 core와 backend의 파일은 같은 이름·다른 내용이 되고, 어느 쪽이 최신인지 판단할 근거가 사라진다. 최소한 C는 "다르게 만든 것"이 의도라는 게 파일 구조에서 드러난다.

**C를 고르는 적극적 이유는 backend가 필요로 하는 것이 core와 실제로 다르기 때문이다.**

- core의 클라이언트는 **무인 배치**용이다. 실패하면 재시도하고, 쿼터가 마르면 다음 날을 기약한다. backend는 **사람이 기다리는 요청**이다. 14초 백오프는 개선이 아니라 장애다.
- core는 Qdrant에 **쓴다**. backend는 **읽기만** 한다. `upsert`·`deleteCollection`을 상속하면 언젠가 누가 부른다.
- core는 TEI를 **배치 시그니처**로 노출한다(`embed(texts: string[])`). backend가 필요한 것은 질의 한 건이고, 배치를 노출하면 누군가 backend에서 색인을 하려 든다 — Qdrant를 읽기 전용으로 고정한 것과 같은 논리다.
- core는 생성자에서 `process.env`를 읽고 throw한다(`core/src/clients/gemini.ts:16`). Nest는 `ConfigService`와 모듈 수명주기를 준다. 두 방식을 섞으면 설정의 진실이 둘이 된다.
- core TEI는 axios를 쓴다(`core/src/clients/tei.ts:1`). backend에는 axios가 없고, 요청 하나를 위해 의존성을 추가하는 대신 Node 24의 전역 `fetch`를 쓴다. `AbortSignal.timeout()`으로 타임아웃 방식이 Gemini와 통일되는 부수 효과도 있다.

**C가 지불하는 대가는 계약이 코드로 연결되지 않는 것이고, 미해결 질문 3의 답("공유 패키지 승격 계획 없음")에 따라 그 대가는 영구적이다.** Qdrant payload 키(`core/src/lib/qdrantCollection.ts:76-89`) · 컬렉션 이름 · 벡터 차원 · distance · Gemini 기본 모델명 · TEI의 `normalize`/`truncate` 기본값 — 이것들이 두 워크스페이스에 각각 적혀 있고 타입 시스템이 어긋남을 잡아주지 않는다. 이 저장소는 같은 문제를 이미 겪었고(엔티티 ↔ DDL, DTO ↔ frontend 타입) 해법도 이미 있다: **`workspaces.md`의 "워크스페이스 경계" 표에 행을 추가하는 것.** 승격이라는 출구가 없어졌으므로 이 등록은 부수 작업이 아니라 **이 설계의 유일한 상시 방어선**이다. 등록할 행은 아래 "이미 알려진 함정의 재현"에 복붙 가능한 형태로 적었다.

### 선행 문서로부터의 변경

| 항목 | 선행 문서 (`2026-07-23-core-integration-clients-design.md`) | 본 문서 |
|------|-----------|---------|
| 대상 | `core` | `backend` (core 결정은 그대로 둔다) |
| 설정 방식 | 생성자가 `process.env` 직접 읽음 (`:24`) | `ConfigService` 주입 |
| Gemini 빈 응답 | `""` 반환 (`core/src/clients/gemini.ts:31`) | **실패로 분류** |
| Qdrant 표면 | 생성·삭제·upsert·search·deletePoints (`:22`) | **search + getCollectionInfo만** |
| 에러 처리 | "래핑 최소화하고 전파" (`:104`) | **`ExternalServiceError`로 분류 후 전파** |
| 추상 베이스 | 기각 (`:35`) | **동일하게 기각** (재평가 결과 아래) |

`2026-07-23-core-tei-embedding-client-design.md`로부터의 변경:

| 항목 | 선행 문서 | 본 문서 |
|------|-----------|---------|
| 메서드 형태 | 배치 우선 `embed(texts[])`, **"별도 `embedOne` 없음"** (`:20`) | **단건 전용 `embedQuery(text)`** |
| 옵션 | `normalize`/`truncate`/`promptName`을 호출 시 지정 가능 (`:17`) | **노출하지 않음** — 색인과 같은 값으로 고정 |
| HTTP 클라이언트 | axios (`:18`) | **전역 `fetch`** |
| 빈 입력 처리 | `texts.length === 0`이면 호출 없이 `[]` (`:54`) | 빈/공백 질의는 **호출자가 거르고**, 클라이언트는 빈 문자열을 `invalid-request`로 거부 |

**"배치 우선, `embedOne` 없음"을 뒤집는 근거.** 선행 문서의 논리는 "단건은 `embed([text])`로 처리하면 되므로 편의 메서드가 불필요하다"였다. 그 전제는 **호출자가 배치를 쓴다**는 것인데, 실제로는 core 자신도 배치를 쓰지 않는다 — 모든 호출부가 `embed([단건])`이다(`core/src/services/enricher.ts:249`, `core/src/lib/qdrantCollection.ts:31`). 그 선택의 근거도 문서에 남아 있다: "속도가 요구사항이 아니다"(`2026-07-26-...:36`).

backend의 호출자는 질의 한 건뿐이므로 배치 시그니처는 순비용이다. `number[][]`를 받아 `[0]`을 꺼내고 `undefined`를 체크하는 코드가 호출부마다 반복되고(core가 실제로 그렇게 한다 — `enricher.ts:250-255`), 그 체크를 빠뜨리면 `undefined`가 Qdrant까지 흘러간다. **단건 반환 타입 `number[]`가 그 실수를 타입에서 없앤다.** 배치가 필요해지면 그때 `embed(texts[])`를 추가한다 — 지금 넣으면 색인을 backend에서 하려는 유혹을 함께 들여온다.

**"옵션 노출"을 뒤집는 근거.** core는 옵션을 열어 뒀지만 실제로는 아무도 덮어쓰지 않는다(전 호출부가 기본값 사용). backend에서 옵션을 열면 **질의를 색인과 다른 설정으로 만들 수 있는 경로**가 생긴다. 컬렉션 이름을 생성자에 고정하고 Qdrant를 읽기 전용으로 만든 것과 같은 계열의 결정이다 — 계약을 깰 수 있는 손잡이를 애초에 만들지 않는다.

**"추상 베이스 기각"은 유지한다.** 선행 문서의 근거는 "세 서비스는 수명주기가 달라(Gemini 무상태 HTTP, PG/Qdrant connect/close) 공통 베이스 클래스를 강제하지 않는다"(`:32`)였다. backend에서 이 근거는 오히려 강해진다 — Nest가 `OnModuleInit`/`OnApplicationShutdown`을 provider별로 주므로, 수명주기를 공통 클래스로 묶을 이유가 하나 더 사라진다. 다만 선행 문서가 **아무것도 공유하지 않기로** 한 부분은 뒤집는다. 아래가 그 결정이다.

## 무엇을 공통화하고 무엇을 반복할 것인가

사용자가 "여러 개"라고 말했으므로 이 표가 이 문서의 핵심이다.

| 관심사 | 공통화 여부 | 근거 |
|---|---|---|
| 모듈 등록 | **공통** — `ClientsModule` 하나 | 3번째 클라이언트는 `providers`/`exports`에 한 줄 |
| kind → HTTP 매핑 | **공통** — 전역 필터 하나 | 클라이언트가 늘어도 매핑표는 하나여야 한다. 클라이언트마다 매핑하면 같은 429가 서비스별로 다른 상태코드가 된다 |
| 오류 타입 | **공통** — `ExternalServiceError` | 이 타입 하나가 "책임이 누구에게 있는가"를 코드에 강제한다 |
| SDK 호출 통로 | **공통** — `callExternal()` | 아래 "차단기 진입 경로" 참조 |
| 공통 실패 판정 | **공통** — `classifyCommonFailure` (중단·네트워크 단절) | 모든 SDK가 같은 모양으로 실패하는 부분 |
| 서비스별 실패 판정 | **반복** — `gemini.errors.ts` / `qdrant.errors.ts` | 429·404 판별 방식이 SDK마다 다르다. 공통 함수에 `if (service === 'gemini')`를 넣는 순간 클라이언트가 늘 때마다 그 함수가 부푼다 |
| 설정 키·기본값 | **반복** (규약만 공통) | 키 이름과 기본값은 서비스마다 다르다. 공통화할 게 없다 |
| HTTP 호출 수단 | **반복** | Gemini SDK · Qdrant SDK · TEI는 SDK가 없어 생 `fetch`. 셋을 하나로 묶으려면 HTTP 추상화를 만들어야 하는데, SDK 두 개가 이미 자기 전송 계층을 갖고 있어 얻는 게 없다 |
| 타임아웃 구현 | **반복** | Gemini는 `config.abortSignal`, TEI는 `fetch(url, { signal })`, Qdrant는 생성자 `timeout` — 형태가 다르다. 억지로 묶으면 `Promise.race` 백스톱을 쓰게 되고, 그건 소켓을 닫지 못한다 |
| SDK 수명주기 | **반복** | 선행 결정 유지 |
| 테스트 더블 | **반복** | SDK마다 mock 모양이 다르고 TEI는 `fetch` 스텁이다. core도 클라이언트별 테스트 파일이다 |

경계선은 **"클라이언트가 늘 때 이 코드가 자라는가"** 다. 자라지 않는 것(오류 타입·매핑표·호출 통로)은 공통화하고, 클라이언트 수만큼 자라는 것(설정·전송 배선·테스트)은 반복한다.

**TEI가 이 경계선의 시험대다.** TEI는 SDK가 없고 인증도 없어(`2026-07-23-core-tei-embedding-client-design.md:16`) 앞의 둘과 가장 다른 클라이언트다. 그런데도 `callExternal`·`ExternalServiceError`·`ExternalServiceFilter`·`ClientsModule`이 본문 수정 없이 그대로 쓰인다면, 공통화한 것들이 "SDK를 감싸는 도구"가 아니라 **"외부 실패를 분류하는 도구"** 였다는 뜻이다. 후자여야 네 번째 클라이언트에서도 성립한다.

TEI가 쓰는 `ExternalFailureKind`는 유니온의 **부분집합**이다 — `auth`도 `quota`도 `not-found`도 쓰지 않는다. 서비스마다 쓰는 kind가 다른 것은 결함이 아니라 이 타입이 서비스별 API가 아니라 **책임 귀속의 어휘**라는 증거다.

## 아키텍처

```
AppModule
 ├ ConfigModule.forRoot({ validate: validateEnv, cache: true })   ★부팅 시 필수 env 전부 확인
 └ ChatModule            (현행 유지 — 이번엔 클라이언트를 주입하지 않는다)

ClientsModule            (이번에 신규. 아직 아무도 import하지 않는다)
 ├ imports:  [ConfigModule]        ← database.module.ts:23과 같은 패턴
 ├ GeminiClient          @Injectable   @google/genai
 ├ TeiClient             @Injectable   전역 fetch
 └ QdrantSearchClient    @Injectable   @qdrant/js-client-rest
        │
        └ 세 클라이언트의 모든 외부 호출 →  callExternal(service, op, classify, fn)
                                              │ 성공 → 값 그대로
                                              │ 실패 → ExternalServiceError(service, kind)
                                              ▼
                              main.ts: app.useGlobalFilters(new ExternalServiceFilter())
                                              │
                                              ▼
                                        kind → HTTP status
```

검색 경로(소비자가 생겼을 때):

```
질의 텍스트
  │ TeiClient.embedQuery(text)          POST {TEI_BASE_URL}/embed   normalize/truncate 고정
  ▼
number[] (bge-m3면 1024)
  │ QdrantSearchClient.search(vector, { limit, filter })
  │   └ 차원이 컬렉션과 다르면 ★여기서 400 → dimension-mismatch → 500
  ▼
TourSearchHit[]  (payload.contentid로 Postgres 재조회 가능)
```

### 생성자와 `onModuleInit`은 네트워크를 만지지 않는다

`ChatModule`이 DB를 배선하지 않은 이유가 문서화돼 있다 — "Postgres는 사내망에서만 도달하므로 배선하면 외부망에서 부팅이 매달린다"(`chat.module.ts:7-9`). Qdrant도 같은 사내망에 있을 가능성이 높다.

따라서 core의 `QdrantStore.connect()`가 `getCollections()`로 연결을 확인하는 패턴(`core/src/clients/qdrant.ts:48-53`)을 **가져오지 않는다.** backend의 클라이언트는 생성자에서 SDK 인스턴스만 만들고, 첫 실제 호출에서 네트워크를 만난다. 부팅은 외부 서비스 도달성과 무관하게 성공한다.

대신 fail-fast는 **설정 계층**이 담당한다. `validateEnv`가 부팅 시 필수 키의 부재를 잡고, 이건 네트워크를 요구하지 않는다(`env.validation.ts:12`는 비어있지 않음만 본다).

### `ClientsModule`을 이번에 `AppModule`에 넣지 않는 이유

소비자가 없다. 지금 배선하면 chat이 클라이언트를 주입하는 시점에 **지워야 할 import**가 된다(Nest에서는 주입하는 모듈이 직접 import해야 하므로 `AppModule`의 import는 그때 무의미해진다). `@Global()`을 붙여 이 문제를 피할 수도 있지만, 전역 모듈은 의존 관계를 모듈 그래프에서 지워버린다 — `DatabaseModule`이 전역이 아닌 것(`database.module.ts:55`)과 같은 이유로 쓰지 않는다.

**대가:** `npm run start:dev`가 성공해도 클라이언트가 동작한다는 증거가 되지 않는다. 그래서 검증 계획의 실측이 선택이 아니라 필수다.

## 설정

### env 키

| 키 | 필수 | 기본값 | 검증 위치 |
|---|---|---|---|
| `DATABASE_URL` | 필수 (현행 유지) | — | `validateEnv` |
| `GEMINI_API_KEY` | **필수 (신규)** | — | `validateEnv` |
| `GEMINI_MODEL` | 선택 | `gemini-2.0-flash` | 클라이언트에서 `\|\|` 폴백 (아래 참조) |
| `TEI_BASE_URL` | **필수 (신규)** | — | `validateEnv` |
| `QDRANT_URL` | **필수 (신규)** | — | `validateEnv` |
| `QDRANT_API_KEY` | 선택 | 없음 = 인증 헤더 미전송 | — |
| `QDRANT_COLLECTION` | 선택 | `tour_contents` | 클라이언트에서 `\|\|` 폴백 (아래 참조) |

**core와 같은 키 이름을 쓴다.** 두 워크스페이스가 같은 Gemini 프로젝트·같은 TEI 서버·같은 Qdrant 컬렉션을 가리키므로, 키 이름이 갈리면 운영자가 같은 값을 두 이름으로 관리하게 된다. 기본값도 core와 같게 맞춘다(`core/.env.example`).

TEI에는 API 키가 없다. 자체 호스팅 TEI는 인증 없이 동작한다는 선행 결정(`2026-07-23-core-tei-embedding-client-design.md:16`)을 그대로 따른다 — 따라서 TEI에는 `auth` 실패 분류 자체가 없다.

### 빈 문자열 env — 키 이름은 같아도 해석이 갈린다

키 이름을 core와 맞추는 것만으로는 부족하다. **`ConfigService.get(key, default)`는 값이 `undefined`일 때만 폴백한다.** core의 `optionalEnv`(`core/src/lib/env.ts:11-17`)는 `undefined`와 `''` **둘 다** 폴백한다. 실측:

```
ConfigService.get('GEMINI_MODEL', 'gemini-2.0-flash')  with GEMINI_MODEL=""  -> ""
ConfigService.get('GEMINI_MODEL', 'gemini-2.0-flash')  with 키 자체가 없음    -> "gemini-2.0-flash"
```

`.env`에 `GEMINI_MODEL=`(키는 있고 값만 빈 줄)이 있으면 **같은 `.env`로 core는 돌고 backend만 죽는다.** 빈 모델명이 그대로 SDK에 실려 나간다. 흔한 편집 실수이고, 증상은 원인에서 멀다.

**규칙: 클라이언트는 `ConfigService.get`의 두 번째 인자(기본값)를 쓰지 않는다.**

```ts
// 금지 — '' 를 유효한 값으로 받는다
config.get<string>('GEMINI_MODEL', 'gemini-2.0-flash')

// 규약 — undefined와 '' 를 같게 다룬다 (core의 optionalEnv와 동일 의미)
config.get<string>('GEMINI_MODEL') || 'gemini-2.0-flash'
config.get<string>('QDRANT_API_KEY') || undefined   // 없으면 인증 헤더 미전송
```

두 번째 인자를 쓰지 않는다는 형태로 규칙을 세운 것은 **리뷰에서 grep으로 찾을 수 있게** 하기 위해서다. "빈 문자열을 조심하라"는 지침은 지켜졌는지 확인할 방법이 없다.

`||`가 여기서 안전한 이유: 이 세 키의 값은 모두 문자열이고, **빈 문자열이 유효한 값인 경우가 없다.** 모델 이름이 `''`이거나 컬렉션 이름이 `''`인 상황은 존재하지 않는다.

**구현 위치는 각 클라이언트다. 공유 헬퍼를 만들지 않는다.** 공통화 표가 "설정 키·기본값 = 반복(규약만 공통)"으로 이미 정한 축이고, 헬퍼를 만들면 공통 파일이 하나 늘어 구조 검증 기준의 기준선이 바뀐다. 대가는 클라이언트마다 같은 관용구를 반복하는 것인데, 위 grep 가능한 규칙과 클라이언트별 테스트가 그 대가를 감당한다.

**필수 키는 이 문제에서 자유롭다.** `validateEnv`가 빈 문자열을 누락으로 취급해(현행 `env.validation.ts:12`와 동일 규칙) 부팅에서 막는다. 다만 `getOrThrow`는 **빈 문자열에 throw하지 않으므로** 두 번째 방어선이 아니다 — 필수 키의 유일한 관문은 `validateEnv`다.

`backend/.env.example`에 위 키를 추가한다. `workspaces.md`가 "`backend/.env.example` ↔ `backend/src/config/env.validation.ts`"를 짝으로 지정하고 있으므로 둘을 함께 바꾼다.

### `validateEnv` 확장

```ts
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'TEI_BASE_URL',
  'QDRANT_URL',
] as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown>;
```

- 누락 키를 **전부 모아 한 번에** throw한다. 현행은 첫 번째에서 멈추므로(`env.validation.ts:11-14`) 네 개가 비어 있으면 네 번 재실행해야 한다.
- 메시지 형식은 core의 `requireEnv`와 같게 유지한다 — `환경 변수 X, Y가 설정되지 않았습니다.` (`core/src/lib/env.ts:5`)
- 값의 **도달성은 검사하지 않는다.** 이 성질이 외부망에서도 부팅을 가능하게 한다.

### 부작용: `ConfigModule.forRoot` 도입이 e2e를 깨뜨린다

`test/app.e2e-spec.ts:12`가 `AppModule`을 통째로 띄운다. `validate`가 붙는 순간 이 테스트는 env 없이 실패한다.

**대응:** `test/jest-e2e.json`에 `setupFiles`를 추가하고 `test/setup-env.ts`에서 더미 값을 세팅한다. e2e가 검증하는 것은 HTTP 라우팅이지 실제 자격증명이 아니다. 더미 값이 실제 오설정을 가리지 않는 이유는, 이 setup 파일이 e2e 실행에만 적용되고 운영 부팅 경로에는 없기 때문이다.

같은 이유로 **단위 테스트도 개발자의 `.env`에 의존하면 안 된다.** 클라이언트 spec은 `ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ ... })] })`로 설정을 명시 주입한다. 이걸 빠뜨리면 키가 설정된 개발자 머신에서만 통과하는 테스트가 된다.

## 인터페이스

### `src/clients/external-service.error.ts` (신규)

```ts
export type ExternalService = 'gemini' | 'qdrant';

/**
 * 실패의 책임 귀속을 타입으로 강제한다.
 * 우리 설정/코드 문제와 외부 서비스 사정을 같은 값으로 표현하지 않는다.
 */
export type ExternalFailureKind =
  // 우리 설정·코드의 문제 → 500
  | 'auth'                // 키가 없거나 무효
  | 'not-found'           // 컬렉션 이름 또는 모델명이 틀림
  | 'dimension-mismatch'  // 질의 벡터 차원이 컬렉션과 다름
  // 외부 서비스 사정 → 502/503/504
  | 'quota'               // 429 / RESOURCE_EXHAUSTED
  | 'unavailable'         // 연결 거부·DNS 실패
  | 'timeout'
  | 'upstream'            // 5xx 및 분류되지 않은 실패
  | 'invalid-request'     // 외부가 우리 요청을 400으로 거절
  | 'empty-response';     // 200인데 쓸 내용이 없음

export class ExternalServiceError extends Error {
  readonly service: ExternalService;
  readonly kind: ExternalFailureKind;
  constructor(
    service: ExternalService,
    kind: ExternalFailureKind,
    message: string,
    options?: { cause?: unknown },
  );
}
```

### `src/clients/call-external.ts` (신규)

```ts
/** 서비스별 판정. 자기가 모르는 오류에는 null을 반환해 공통 판정에 넘긴다. */
export type FailureClassifier = (error: unknown) => ExternalFailureKind | null;

/** 중단·네트워크 단절처럼 모든 SDK가 같은 모양으로 내는 실패만 판정한다. */
export function classifyCommonFailure(error: unknown): ExternalFailureKind | null;

/**
 * 외부 SDK 호출의 유일한 통로.
 * 클라이언트 메서드가 SDK를 직접 호출하는 것을 금지한다.
 */
export async function callExternal<T>(
  service: ExternalService,
  operation: string,
  classify: FailureClassifier,
  fn: () => Promise<T>,
): Promise<T>;
```

동작:
1. `fn()`을 호출한다.
2. 성공하면 값을 그대로 반환한다.
3. 던져진 것이 이미 `ExternalServiceError`면 **그대로 다시 던진다** (이중 래핑 금지 — 안쪽에서 정확히 분류한 kind가 바깥에서 `upstream`으로 덮이면 분류가 무의미해진다).
4. 아니면 `classify(error) ?? classifyCommonFailure(error) ?? 'upstream'`로 kind를 정하고 `ExternalServiceError`로 감싼다.

**`classify` 호출을 `try/catch`로 감싼다.** 분류기 셋은 전부 `unknown`을 받아 프로퍼티를 읽는다. 비-`Error` 값(문자열·`null`·`undefined`)으로 reject되면 분류기 자신이 던질 수 있고, 그러면 **통로가 뚫린다** — `ExternalServiceError`가 아닌 무언가가 필터를 지나쳐 로그 없는 500이 된다. 외부 호출이 실패했다는 사실보다 분류에 실패했다는 사실이 사용자에게 먼저 도달하는 셈이다.

분류기가 던지면:
- kind는 `'upstream'`으로 떨어뜨리고 원래 실패는 정상적으로 `ExternalServiceError`가 된다 — 분류 실패가 원래 실패를 삼키면 안 된다
- 분류기 예외는 **별도 로그로 남긴다.** 원래 실패 로그에 묻으면 분류기 버그가 영원히 드러나지 않는다

같은 이유로 `classifyCommonFailure`도 감싼다. 이건 방어적 코드가 아니라 **`callExternal`이 "무슨 일이 있어도 `ExternalServiceError`만 던진다"는 계약을 지키기 위한 것**이다. 그 계약이 깨지면 전역 필터가 존재할 이유가 없다.
5. 로그는 여기서만 남긴다. `service` · `operation` · `kind` · **마스킹한** 원인 메시지. 프롬프트 전문은 남기지 않는다(길이만).

**원인 메시지는 마스킹 후에 남긴다.** "원인 메시지를 남긴다"와 "로그에 API 키가 없다"는 그냥은 양립하지 않는다 — SDK 오류 메시지에는 요청 URL이 통째로 들어가고, 그 쿼리스트링에 키가 실려 있다. 메시지를 통째로 버리면 무엇이 실패했는지가 사라지므로 **가리고 남긴다.**

```ts
/** call-external.ts 안의 비공개 함수. 새 파일을 만들지 않는다. */
function maskSecrets(text: string): string;
```

가리는 패턴 세 가지:

| 패턴 | 예 | 결과 |
|---|---|---|
| Google API 키 (`AIza` + 35자) | `AIzaSyA1234…` | `AIza***` |
| 쿼리 파라미터 `key` · `api_key` · `api-key` · `access_token` | `?key=abc123` | `?key=***` |
| `Bearer` 토큰 | `Bearer eyJhbG…` | `Bearer ***` |

**별도 파일로 빼지 않는 이유:** 이 함수의 유일한 호출자는 `callExternal`이고, 모든 외부 호출이 그 하나를 통과하므로 재사용 지점이 생길 수 없다. 파일을 나누면 "마스킹하지 않고 로그하는 다른 경로"를 만들 수 있다는 신호가 되고, 그건 `circuit-breaker-entry-paths.md`가 경고하는 두 번째 진입 경로다.

**마스킹은 로그에만 적용된다.** HTTP 응답 본문에는 원인 메시지가 아예 담기지 않는다(아래 필터 참조) — 마스킹은 로그를 위한 방어이지 응답을 위한 방어가 아니다. 두 방어는 독립적이다.

#### 원인 메시지는 `cause` 체인을 펼쳐서 고른다

```ts
/** cause 체인을 따라가며 비어 있지 않은 첫 메시지를 고른 뒤 마스킹한다. */
function causeMessage(error: unknown): string;
```

바깥 오류의 `message`만 읽으면 **`fetch failed` 다섯 글자만 로그에 남는다.** Node의 `fetch`(undici)는 전송 실패를 그 문구로 감싸고, 실제 원인(`ECONNREFUSED 127.0.0.1:8080`)은 `cause`에 들어 있다. 호스트와 포트가 사라지면 "TEI가 안 뜬 것"과 "주소를 잘못 적은 것"을 구분할 수 없다.

- `error.cause`를 따라 내려가며 **비어 있지 않은 첫 `message`** 를 쓴다
- 중간 고리가 `AggregateError`면 `.errors[0]`도 후보에 넣는다 — 듀얼스택 `localhost`(IPv6·IPv4 동시 시도)는 한 겹 벗겨도 `message`가 빈 문자열인 `AggregateError`가 나온다
- 순환 참조와 무한 깊이를 막기 위해 깊이 상한을 둔다
- 고른 메시지에 `maskSecrets`를 적용한다

**TEI에 직결된다.** 셋 중 유일하게 생 `fetch`를 쓰므로 SDK가 원인을 정리해 주지 않는다. 실측의 "TEI 도달 불가 → `unavailable`, 5초 이내" 항목은 이 전개가 없으면 무엇이 잘못됐는지 알려주지 못한다.

### `src/clients/external-service.filter.ts` (신규)

```ts
@Catch(ExternalServiceError)
export class ExternalServiceFilter implements ExceptionFilter {
  catch(exception: ExternalServiceError, host: ArgumentsHost): void;
}
```

`main.ts`에 `app.useGlobalFilters(new ExternalServiceFilter())`를 추가한다.

응답 본문은 `{ statusCode, error: kind, message }`다. 필터 안에 표 두 개를 둔다:

```ts
const STATUS_BY_KIND:  Record<ExternalFailureKind, number>;  // 에러 처리 표의 HTTP 열
const MESSAGE_BY_KIND: Record<ExternalFailureKind, string>;  // kind별 고정 한국어 문구
```

**`message`는 `exception.message`가 아니라 `MESSAGE_BY_KIND[kind]`다.** 예외 인스턴스의 메시지를 응답에 쓰지 않는다.

근거: 예외 메시지에는 업스트림 원문이 들어 있고, 거기에 자격증명이 실려 있을 수 있다. `maskSecrets`를 응답에도 적용하는 방법도 있지만, 그건 **정규식이 모든 누출 형태를 안다는 가정**에 기댄다 — 새 SDK가 새 형태로 키를 담으면 정규식은 그것을 모른다. 예외 메시지를 아예 쓰지 않으면 **누출이 구조적으로 불가능**해진다. 로그는 원인을 알아야 하니 마스킹으로 타협하지만, 응답에는 타협할 이유가 없다.

대가는 응답만 보고는 원인을 좁힐 수 없다는 것이다. `error: kind`가 남으므로 분류는 전달되고, 상세는 같은 요청의 서버 로그에 있다. 외부에 나가는 본문에서 진단 정보를 빼는 것은 의도한 거래다.

`Record<ExternalFailureKind, ...>`로 선언하는 것도 결정이다 — kind를 추가하면 두 표를 채우지 않는 한 컴파일되지 않는다. 매핑 누락이 런타임 `undefined`가 되지 않는다.

### 분류기 공통 원칙 — 상태 코드가 메시지를 이긴다

세 분류기(`classifyGeminiFailure` · `classifyTeiFailure` · `classifyQdrantFailure`)가 모두 따르는 규칙이다. 네 번째 클라이언트도 이 절을 읽고 만든다. **특정 클라이언트의 각주가 아니라 공통 원칙이다.**

#### 초안이 침묵해서 생긴 실제 결함

초안은 판정을 `status가 X 이거나 메시지가 /…/`로만 적고 **둘 중 무엇이 이기는지 정하지 않았다.** 구현은 자연스럽게 "둘 중 하나라도 맞으면"이 됐고, 그 결과:

```
ApiError { status: 400,
  message: '{"error":{"code":400,"message":"The input token count (1429852) exceeds
             the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}' }
→ kind=quota · 503 · Retry-After: 60 · warn
```

**토큰 수 `1429852` 안의 `429`가 걸렸다.** 프롬프트가 너무 길어서 생긴 영구 실패가 "잠시 후 다시 시도하세요"가 되고, 정상 429와 **응답이 바이트 단위로 같아** 호출자가 구별할 방법이 없다. 로그 레벨도 `quota`만 `warn`이라 경보에서 사라진다.

두 번째 입력: `status: 500` + 본문에 `"checking quota service"` → `quota`(503). 에러 표는 "Gemini 5xx → `upstream` → 502"인데 표와 코드가 갈렸다.

원인은 **`message`가 사람이 읽는 문구가 아니라 응답 본문 전문**이라는 것이다. `@google/genai`의 `throwErrorIfNotOK`가 `JSON.stringify(errorBody)`를 통째로 넣는다(`dist/index.cjs:8538-8544`). 정규식은 `code`·`status`·`details`·도움말 URL·**Google이 실어 보내는 임의의 숫자**를 전부 훑는다.

#### 초안의 안전 주장은 절반만 맞았다

초안은 이 정규식을 두고 "모델 출력 원문을 담은 우리 쪽 오류에 적용하면 안 된다"고 경고한 뒤, "분류가 `callExternal` 안 SDK 호출을 감싼 자리에서만 일어나므로 **구조적으로 차단된다**"고 적었다. **틀렸다.** 그 차단은 *우리* 모델 출력만 막는다. **Google 자신의 오류 본문에 든 숫자는 막지 못한다.** 호출 지점을 좁히는 것으로는 부족하고, 정규식이 무엇을 보는지를 좁혀야 한다.

#### 규칙 — 3단계

> **1단계 (상태 확정).** 상태 코드를 정한다. **이 단계에서 메시지 내용을 쓰지 않는다.**
> **2단계 (세부 분기).** 확정된 상태 **안에서** 갈래가 둘 이상일 때만 메시지를 본다.
> **3단계 (안전망).** 상태를 끝내 확정하지 못했을 때만 메시지 전체를 정규식으로 추정한다.

한 줄로: **상태를 정하는 데는 메시지를 쓰지 않는다. 상태가 정해진 뒤 세부를 가르는 데만 쓴다.**

근거:
- `status`는 HTTP 응답 상태 **그 자체**이고, 메시지 정규식은 그걸 **추측하려는 대체 수단**이다. 확정이 추측을 이겨야 한다.
- 메시지 규칙이 **필요한** 경우(상태가 있는데 상태가 틀리고 메시지가 맞는 경우)는 존재하지 않는다.
- 메시지 규칙이 **해로운** 경우는 위 두 입력처럼 실재한다.

#### 2단계와 3단계는 다른 것이다 — 이 구분이 규칙의 전부다

"상태가 이긴다"를 단순하게 적용하면 **이미 검증된 결정 하나가 깨진다.** 실제 Gemini는 무효한 키에 `401`이 아니라 **`400 + "API key not valid"`** 를 낸다. 상태만 보면 `invalid-request`(502)가 되어 만료된 키가 "외부가 우리 요청을 거절했다"로 잘못 청구된다.

이건 규칙의 반례가 아니라 **2단계의 사례**다. 400은 이미 확정됐고, 메시지는 상태를 뒤집는 게 아니라 400 **안에서** `auth`와 `invalid-request`를 가른다. 같은 구조가 Qdrant의 `dimension-mismatch`에도 있다 — 400 안에서 차원 오류와 그 외를 가른다.

두 용법의 차이가 결과를 가른다:

| | 메시지가 하는 일 | 예 | 판정 |
|---|---|---|---|
| **2단계 (허용)** | 확정된 상태 **안에서** 갈래 선택 | `400` + `API key not valid` → `auth` | 상태를 바꾸지 않는다 |
| **1단계 침범 (금지)** | 상태를 **추정**해서 뒤집음 | `400` + 본문의 `1429852` → `quota` | 확정 정보를 버린다 |

`1429852`가 더 이상 문제가 되지 않는 이유가 여기 있다. **`/429/`는 1단계(상태 추정) 영역의 패턴이므로 상태가 확정된 오류에는 아예 적용되지 않는다.** 400 안의 2단계 패턴은 `/API key|PERMISSION_DENIED/i`뿐이고 토큰 수는 거기 걸리지 않는다.

#### 3단계 안전망은 남기되 좁힌다

메시지 규칙을 지우지는 않는다. `status`가 없는 오류가 실재하기 때문이다 — `@google/genai`는 상태가 400~599 **밖**이면 `ApiError`가 아니라 평 `Error(errorMessage)`를 던지고(`dist/index.cjs:8545`), 다른 realm에서 온 오류나 SDK를 거치지 않은 실패도 상태가 없다.

다만 3단계는 이제 **추정임이 명시된 경로**이므로 패턴을 좁힌다:

- **`429`·`quota` 같은 맨 토큰을 쓰지 않는다.** 세 자리 숫자와 흔한 단어는 본문 어디서든 걸린다("checking quota service").
- 서비스가 **고유하게** 쓰는 토큰만 남긴다 — `RESOURCE_EXHAUSTED` · `rate limit` · `quota exceeded`처럼 오분류 표면이 좁은 것.
- **core와 갈라지는 지점이다.** core의 `isRateLimited`는 `/429|rate limit|RESOURCE_EXHAUSTED|quota/i`를 쓴다(`core/src/services/enricher.ts:88`). core에는 같은 잠복 결함이 있지만 backend가 그걸 복사할 이유는 없다. backend는 상태를 손에 쥐고 있어 넓은 패턴이 필요 없다. (core 수정은 이 문서 범위 밖 — 별도 실행.)

3단계의 목표는 정확한 판정이 아니라 **`upstream`보다 나은 추측**이다. 패턴을 넓히려는 변경은 이 절을 근거로 리뷰에서 막는다.

#### 상태를 확정하는 방법은 서비스마다 다르다

1단계가 어디서 상태를 얻는지는 SDK가 정한다. **설치본을 읽고 확인한 결과가 서비스마다 달랐다.**

| 서비스 | 상태의 출처 | 확인 |
|---|---|---|
| Gemini | `ApiError.status` **프로퍼티** (4xx·5xx 전부) | `dist/genai.d.ts:475`, `dist/index.cjs:7914-7921, 8518-8546` |
| TEI | `TeiHttpError.status` — 클라이언트가 `response.status`로 직접 채운다 | 이 문서의 설계 |
| Qdrant | **프로퍼티가 없을 수 있다.** 주 경로는 `message` 머리말에만 있다 | `dist/cjs/errors.js:13-24` |

Qdrant처럼 상태가 메시지 안에만 있는 경우에도 1단계는 유지된다 — **머리말의 정해진 위치에서만 파싱하고, 본문은 보지 않는다.** 자세한 것은 `classifyQdrantFailure` 절에 있다.

### `src/clients/gemini/gemini.client.ts` (신규)

```ts
export interface GeminiGenerateOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
}

@Injectable()
export class GeminiClient {
  constructor(config: ConfigService);
  generate(prompt: string, opts?: GeminiGenerateOptions): Promise<string>;
}
```

메서드 이름과 옵션을 **core의 `GeminiClient`(`core/src/clients/gemini.ts:4-8, 22`)와 일부러 동일하게** 맞춘다. 나중에 공유 패키지로 승격하기로 하면 그 작업이 기계적으로 끝난다.

한 가지만 다르다: **빈 응답을 성공으로 반환하지 않는다.** core는 `response.text ?? ""`를 돌려주지만(`core/src/clients/gemini.ts:31`), core에서도 그 빈 문자열은 결국 `validateStructuredText`가 실패로 잡는다(`2026-07-26-...:325`의 "빈 응답" 행). backend에는 그 뒤에 붙은 검증기가 없고, 빈 문자열은 사용자에게 **빈 채팅 말풍선**으로 렌더된다. 클라이언트에서 `empty-response`로 끊는 편이 정직하다.

타임아웃은 SDK 네이티브를 쓴다 — `config.abortSignal = AbortSignal.timeout(GEMINI_TIMEOUT_MS)` (기본 20000).

### `src/clients/gemini/gemini.errors.ts` (신규, 순수 함수)

```ts
export function classifyGeminiFailure(error: unknown): ExternalFailureKind | null;
```

**위 "분류기 공통 원칙"의 3단계를 그대로 따른다.**

**1단계 — 상태 확정.** `status` 프로퍼티(숫자), 없으면 `code`(숫자). 둘 다 없으면 `null`. **메시지를 보지 않는다.**

**2단계 — 확정된 상태 안에서 세부 분기.**

| 상태 | 세부 분기 | kind |
|---|---|---|
| 400 | 메시지가 `/API key\|PERMISSION_DENIED/i` | `auth` |
| 400 | 그 외 | `invalid-request` |
| 401 · 403 | 없음 | `auth` |
| 404 | 없음 | `not-found` |
| 429 | 없음 | `quota` |
| 500–599 | 없음 | `upstream` |
| 그 외 상태 | 없음 | `null` |

**3단계 — 상태가 `null`일 때만** 메시지 전체를 본다. 위에서 아래로 첫 일치:

1. `/RESOURCE_EXHAUSTED|rate limit|quota exceeded/i` → `quota`
2. `/API key|PERMISSION_DENIED/i` → `auth`
3. `/is not found for API version|NOT_FOUND/i` → `not-found`
4. `/INVALID_ARGUMENT/i` → `invalid-request`
5. 그 외 → `null`

`400 + "API key not valid"`가 `auth`로 가는 것이 2단계의 대표 사례다. 실제 Gemini는 무효한 키에 401이 아니라 **400**을 낸다 — 상태만 보고 끝내면 만료된 키가 `invalid-request`(502)가 되어 "외부가 우리 요청을 거절했다"는 잘못된 귀속이 된다. 메시지는 여기서 상태를 **뒤집는 게 아니라** 400 안에서 갈래를 고른다.

**3단계의 `quota` 패턴이 core와 다르다.** core의 `isRateLimited`는 `/429|rate limit|RESOURCE_EXHAUSTED|quota/i`인데(`core/src/services/enricher.ts:88`), 여기서는 맨 `429`와 맨 `quota`를 뺐다. 맨 `429`는 본문의 아무 숫자에나 걸리고("token count (1429852)"), 맨 `quota`는 흔한 단어라 5xx 본문에도 나타난다("checking quota service"). 3단계는 이미 추측 경로이므로 **오분류 표면이 좁은 토큰만** 남긴다. 근거는 공통 원칙 절에 있다.

#### 404를 `not-found`(500)로 끊는 이유

`GEMINI_MODEL`에 오타(`gemini-2.5-flesh`)가 있거나 미배포 모델을 지정하면 SDK가 404를 던진다. 판정이 없으면 어느 분기에도 걸리지 않아 `upstream`(502) — "외부 서비스에서 오류가 발생했습니다." 가 된다. **Gemini는 멀쩡하고 틀린 것은 우리 `.env`인데**, 그 응답을 받은 사람은 Gemini 장애를 의심한다.

**Qdrant는 컬렉션 이름 오타를 이미 `not-found`(500)로 끊는다.** 모델명 오타와 컬렉션 이름 오타는 같은 종류의 오설정이므로 같은 kind여야 한다. 한쪽만 "외부 서비스 사정"으로 청구하면 `ExternalFailureKind`를 책임 귀속별로 나눈 의미가 없어진다 — `failure-attribution.md`(이 저장소 최다 재발 유형)가 정확히 이 실수를 가리킨다.

`MESSAGE_BY_KIND['not-found']`("외부 서비스에서 대상을 찾을 수 없습니다.")가 이미 맞는 문구라 **공통 파일은 수정하지 않는다.**

#### Gemini의 `status`는 Qdrant와 달리 신뢰할 수 있다

Qdrant에서 한 번 크게 돌아간 지점이라 설치본을 직접 확인했다. `@google/genai@2.13.0`의 `ApiError`는 **`status`를 실제 프로퍼티로 갖는다**(`dist/genai.d.ts:475`, `dist/index.cjs:7914-7921`).

`throwErrorIfNotOK`(`dist/index.cjs:8518-8546`)가 `status: response.status`(HTTP 상태)와 `message: JSON.stringify(errorBody)`로 만들어 던진다. 즉 **상태는 프로퍼티에, 본문 JSON은 메시지에** 둘 다 있다 — Qdrant의 주 경로처럼 상태가 사라지는 shape은 없다.

따라서 `status === 404`만으로 충분하고, 메시지 정규식은 보조 수단이다. 그래도 함께 두는 이유는 스트리밍 경로(`dist/index.cjs:8289-8300`)가 HTTP 상태가 아니라 응답 본문의 `code`로 `ApiError`를 만들기 때문이다. 두 경로의 값이 어긋날 여지가 있고, 정규식은 그 틈을 덮는다.

core의 `isRateLimited`(`core/src/services/enricher.ts:84-89`)에 붙은 경고 — "모델 출력 원문을 담은 우리 쪽 오류에 이 정규식을 적용하면 안 된다. 관광지 설명의 '1429년'이 쿼터 초과로 오분류된다"(`:79-83`) — 는 여전히 유효하다.

**다만 초안이 그 경고에 붙인 안전 주장은 틀렸다.** 초안은 "분류가 `callExternal` 안 SDK 호출을 감싼 자리에서만 일어나므로 **구조적으로 차단된다**"고 적었다. 호출 지점을 좁히는 것은 *우리* 데이터가 분류기에 들어가는 것만 막는다. **Google 자신의 오류 본문에 든 숫자는 막지 못하고**, 실제로 그 경로로 결함이 났다(공통 원칙 절의 `1429852`). 진짜 방어는 호출 지점이 아니라 **3단계 규칙과 좁은 패턴**이다.

`not-found`의 `NOT_FOUND` 토큰에도 같은 위험이 있다. 짧고 흔해서 본문 어디서든 나타날 수 있다. 이 패턴이 3단계에만 있고 **주 판정은 `status === 404`**(1단계)라는 것이 방어다.

### `src/clients/tei/tei.client.ts` (신규)

```ts
@Injectable()
export class TeiClient {
  constructor(config: ConfigService);
  /** 질의 텍스트 한 건을 임베딩 벡터로 만든다. 색인과 같은 설정으로 고정돼 있다. */
  embedQuery(text: string): Promise<number[]>;
}
```

`POST {TEI_BASE_URL}/embed`에 `{ inputs: [text], normalize: true, truncate: true }`를 보낸다. 요청 형태는 core와 동일하다(`core/src/clients/tei.ts:22-31`) — **바디가 갈리면 같은 텍스트가 두 워크스페이스에서 다른 벡터가 된다.**

- `normalize`·`truncate`·`prompt_name`을 **인자로 받지 않는다.** 색인이 만들어진 설정과 다르게 질의할 수 있는 경로를 만들지 않기 위해서다. `prompt_name`은 애초에 쓰지 않는다 — bge-m3는 지시문 프리픽스 없이 동작한다(`2026-07-26-...:315`).
- 빈 문자열·공백만 있는 입력은 TEI를 호출하지 않고 `invalid-request`로 즉시 거부한다. core는 빈 **배열**을 빈 배열로 돌려주지만(`core/src/clients/tei.ts:20`), backend의 입력은 배열이 아니라 질의 한 건이고 빈 질의로 검색하는 것은 호출자의 버그다.
- **`response.ok`를 본문 파싱보다 먼저 확인하고, 아니면 `TeiHttpError`를 던진다.** `fetch`는 4xx·5xx를 정상 반환으로 취급하므로 이 확인이 없으면 에러 JSON이 벡터로 파싱된다. 던지는 것이 분류기가 볼 수 있는 유일한 모양이다 — 아래 `tei.errors.ts` 절 참조.
- 응답 `number[][]`에서 첫 벡터를 꺼내 반환한다. 배열이 비었거나 첫 원소가 빈 배열이면 `empty-response`.
- **차원을 검사하지 않는다.** 아래 참조.
- 타임아웃은 `fetch(url, { signal: AbortSignal.timeout(TEI_TIMEOUT_MS) })`, 기본 5000. 자체 호스팅 서버의 단문 임베딩 한 건이고, TEI는 모델 로딩 중에는 5xx를 내므로 5초를 넘길 정상 경로가 없다.

**왜 TEI 응답의 차원을 검사하지 않는가.** 검사하려면 기대 차원을 어딘가에 적어야 하고, 그 순간 `1024`가 backend 코드에 박힌다. 선행 문서가 정확히 이걸 거부했다 — "차원을 env에 하드코딩하지 않는 이유: TEI에 뜬 모델과 어긋나면 조용히 틀린 색인이 만들어진다"(`2026-07-26-...:311`). backend에는 더 나은 판정자가 이미 있다: **Qdrant가 컬렉션의 실제 차원과 대조해 400을 낸다.** 에러 표의 `dimension-mismatch` 행이 그 자리이며, 하드코딩 없이 실제 계약과 대조하는 유일한 방법이다.

core가 차원을 검사하는 것(`core/src/services/enricher.ts:251-255`)은 core가 `ensureCollection`으로 차원을 **결정한 주체**라 비교 대상을 이미 손에 들고 있기 때문이다. backend는 그 주체가 아니다.

### `src/clients/tei/tei.errors.ts` (신규, 순수 함수)

#### 초안의 결함 — `Response`를 받는 시그니처는 `callExternal`에 넘길 수 없다

초안은 `classifyTeiFailure(response: Response)`로 적었다. `callExternal`이 받는 `FailureClassifier`는 `(error: unknown) => ExternalFailureKind | null`이므로 **타입이 맞지 않아 그대로 넘길 수 없다.**

근본 원인은 TEI만 실패 형태가 둘이라는 것이다. SDK를 쓰는 두 클라이언트는 실패가 언제나 "던져진 오류" 하나지만, 생 `fetch`는 두 갈래로 실패한다:

- **던지는 실패** — 연결 거부·DNS·중단. `unknown` 오류로 도착한다
- **던지지 않는 실패** — 4xx·5xx **응답**. `fetch`는 이걸 정상 반환으로 취급한다

초안의 시그니처는 두 갈래 중 **후자만** 볼 수 있는 모양이었다. 전자를 받을 방법이 없다.

| | (a) 클라이언트가 `!response.ok`에서 throw | (b) `callExternal`의 계약을 넓힌다 |
|---|---|---|
| 분류기 시그니처 | 다른 둘과 **동일** | TEI만 다름 (유니온 인자 또는 오버로드) |
| 공통 파일 변경 | **없음** | `call-external.ts` 본문 수정 |
| 구조 검증 기준 | **통과** | **그 자리에서 깨진다** ("공통 파일 변경은 유니온 한 줄뿐") |
| 네 번째 클라이언트 | 영향 없음 | 계약이 이미 한 번 넓어진 상태에서 시작 |
| TEI 클라이언트 코드 | `!ok`일 때 throw 한 줄 추가 | 변화 없음 |
| 실패 표현 | 전송 계층과 무관하게 "던져진 오류" 하나 | 서비스마다 다름 |

**(a)를 택한다.** (b)는 서비스 하나의 전송 계층 사정 때문에 셋 모두가 통과하는 공통 통로의 계약을 바꾸는 것이고, 그 순간 "공통화한 것은 클라이언트가 늘어도 자라지 않는다"는 이 설계의 근거가 반증된다. 반대로 (a)는 **`fetch`의 특이성을 클라이언트 안에 가둔다** — 밖에서 보면 TEI도 다른 둘과 똑같이 "던지는" 클라이언트다.

부수 효과로 `response.ok` 확인이 **설계상 필수**가 된다. 초안은 그걸 "빠뜨리기 쉬운 실수"로 경고만 했는데, 이제 그 확인을 빼면 분류기에 도달할 오류 자체가 만들어지지 않아 실패가 조용히 성공으로 흐른다. 경고를 구조로 바꾼 것이 이 선택의 실질적 이득이다.

#### 확정 인터페이스

```ts
/** !response.ok일 때 TeiClient가 던진다. 상태와 본문 일부를 분류기에 전달하는 운반체다. */
export class TeiHttpError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
}

export function classifyTeiFailure(error: unknown): ExternalFailureKind | null;
```

공통 원칙의 3단계 중 **1단계만 있는 가장 단순한 형태다.**

**1단계 — 상태 확정.** `TeiHttpError`면 `status`, 아니면 없음.

| 상태 | kind |
|---|---|
| 400 · 413 · 422 | `invalid-request` (입력이 모델 제약을 벗어남. `truncate: true`라 흔치 않다) |
| 5xx | `upstream` (모델 로딩 중·OOM) |
| 그 외 비-2xx | `upstream` |

**2단계 없음.** 어떤 상태 안에서도 갈래가 둘이 아니다.

**3단계 없음.** `TeiHttpError`가 아니면 곧바로 `null` — 연결 거부·중단은 `fetch`가 던지고 `classifyCommonFailure`가 처리한다.

`auth`·`quota`·`not-found`는 TEI에 없다.

**`bodySnippet`은 로그용이며 분류에 쓰지 않는다.** 이 결정은 공통 원칙의 직접적 사례다 — 상태를 `response.status`에서 확정할 수 있으므로 본문을 볼 이유가 없고, 보기 시작하면 TEI 오류 본문의 숫자가 상태 판정에 끼어드는 길이 열린다. Gemini에서 실제로 난 결함이 그것이다.

`TeiHttpError`를 `tei.errors.ts`에 두는 이유: 던지는 쪽(`tei.client.ts`)과 판정하는 쪽이 같은 타입을 봐야 하고, 판정 규칙 옆에 두어야 상태 코드 목록과 타입이 함께 바뀐다.

**세 분류기 중 이것이 가장 단순한 이유는 TEI가 특별해서가 아니라 상태를 우리가 직접 채우기 때문이다.** SDK가 상태를 어디에 숨기든 상관없는 자리에 있다 — 1단계가 깨끗하면 나머지가 따라온다.

#### 세 갈래 실패가 `callExternal`에 도달하는 경로

```
TeiClient.embedQuery(text)
 │
 ├ 빈/공백 질의  → ExternalServiceError('tei','invalid-request')  ★callExternal 밖에서 throw
 │                  (네트워크를 타지 않으므로 통로에 들어갈 이유가 없다)
 │
 └ callExternal('tei', 'embed', classifyTeiFailure, async () => {
     fetch(...)  ─ 던짐  → unknown → classifyTeiFailure → null → classifyCommonFailure → timeout | unavailable
     !response.ok        → throw TeiHttpError(status, snippet) → classifyTeiFailure → invalid-request | upstream
     벡터가 비었음        → throw ExternalServiceError('tei','empty-response')  → 규칙 3으로 그대로 통과
   })
```

`empty-response`를 분류기가 아니라 클라이언트가 직접 던지는 것은 규칙 3(이미 `ExternalServiceError`면 그대로 재던짐)이 있기 때문이다. 이미 kind를 정확히 아는 자리에서 판정을 우회하는 것이 규칙 3의 존재 이유다.

### `src/clients/qdrant/qdrant.client.ts` (신규)

`TourSearchFilter`와 `TourContentPayload`는 이 파일이 아니라 **`tour-content-payload.ts`에 있다**(아래 참조). 둘 다 core의 payload 키에 묶인 타입이므로 한 파일에 모은다 — 경계표가 가리키는 파일도 그쪽 하나여야 하고, 반대로 두면 `qdrant.client.ts` ↔ `tour-content-payload.ts` 순환 import가 된다(`buildQdrantFilter`가 필터 타입을 소비하므로).

```ts
import type { TourSearchFilter, TourContentPayload } from './tour-content-payload';

export interface QdrantSearchOptions {
  limit?: number;          // 기본 10 (core와 동일)
  filter?: TourSearchFilter;
}

export interface TourSearchHit {
  id: string | number;
  score: number;
  payload: TourContentPayload;
}

export interface QdrantCollectionInfo {
  vectorSize: number;
  distance: string;
}

/**
 * 읽기 전용 Qdrant 클라이언트.
 * 이름에 Search가 들어간 것은 의도다 — 쓰기 메서드가 없다는 사실이 타입에 드러난다.
 * SDK의 QdrantClient와 이름이 겹치지 않게 하는 목적도 겸한다(core가 QdrantStore로 피한 것과 같은 이유).
 */
@Injectable()
export class QdrantSearchClient {
  constructor(config: ConfigService);
  search(vector: number[], opts?: QdrantSearchOptions): Promise<TourSearchHit[]>;
  /** 진단용. 컬렉션 차원·distance가 core가 만든 것과 맞는지 확인한다. */
  getCollectionInfo(): Promise<QdrantCollectionInfo>;
}
```

`search`에 **컬렉션 인자를 두지 않는다.** 컬렉션은 생성자에서 `QDRANT_COLLECTION`으로 고정된다. 인자로 열어두면 호출자가 이름을 문자열로 짐작하게 되고, 오타는 빈 결과가 아니라 404가 되어야 하는데 그 판정이 호출자마다 달라진다.

SDK는 `query()`를 쓴다. core는 `search()`를 쓰지만(`core/src/clients/qdrant.ts:121`) Qdrant 서버 1.10 이후 `search`는 `query_points`로 대체됐고, 새로 쓰는 코드를 폐기 예정 API에 묶을 이유가 없다. dense 단일 벡터 조회에서 두 API의 결과는 동일하다. **`query()`의 반환 shape(`{ points: [...] }`인지 배열인지)은 구현 시 context7로 확인한다** — 우리 반환 타입은 `TourSearchHit[]`로 고정이므로 불확실성은 이 함수 하나 안에 갇힌다.

요청에 반드시 포함할 것:
- `with_payload: true` — **payload가 결과의 본체다.** 보내지 않으면 payload가 null로 오고 아래 파서가 전 건을 버려 "정상 200 + 빈 배열"이 된다. core는 이 옵션을 보내지 않는데(`core/src/clients/qdrant.ts:121-125`), core는 쓰기가 주 용도라 드러나지 않았을 수 있다.
- `with_vector`는 요청하지 않는다. hit당 1024개 float를 되받을 이유가 없다.

### `src/clients/qdrant/qdrant.errors.ts` (신규, 순수 함수)

```ts
export function classifyQdrantFailure(error: unknown): ExternalFailureKind | null;
```

#### SDK가 실제로 던지는 것 (`node_modules` 확인 결과)

초안은 "SDK 오류는 `status`·`statusText`·`data`를 갖고 `message`에는 `statusText`만 들어간다"고 적었다. **절반만 맞다.** Qdrant SDK는 오류 shape이 **둘**이고, 그중 주 경로가 정반대다.

`@qdrant/js-client-rest@1.18`의 미들웨어(`dist/cjs/api-client.js:44-62`)를 읽으면:

| 던져지는 것 | 언제 | `status` 프로퍼티 | 상태·본문이 있는 곳 |
|---|---|---|---|
| **`QdrantClientUnexpectedResponseError`** | 비-2xx 응답이 정상 반환됐을 때 (**주 경로**) | **없다** | `message` 하나에 전부 |
| `ApiError` (`@qdrant/openapi-typescript-fetch`) | 내부 fetcher가 던졌을 때 | 있다 | `data`, `message`는 `statusText`뿐 |
| `QdrantClientTimeoutError` | 생성자 `timeout` 초과 | 없다 | 이름으로만 판정 |
| `QdrantClientResourceExhaustedError` | 429 **+ `retry-after` 헤더 있음** | 없다 (`retry_after` 있음) | — |

`QdrantClientUnexpectedResponseError.forResponse`가 만드는 메시지는 이 모양이다(`dist/cjs/errors.js:13-24`):

```
Unexpected Response: 400 (Bad Request)
Raw response content:
{ "status": { "error": "Vector dimension error: expected dim: 1024, got 3" } }
```

즉 **상태 코드도 본문도 `message` 문자열 안에만 있고**, `status` 프로퍼티는 존재하지 않는다. 본문은 200자에서 잘린다(`MAX_CONTENT = 200`).

**초안의 두 진술이 모두 위험했다.** "`status === 404`로 판정"은 주 경로에서 항상 거짓이 되고, "차원 문구는 `data`에만 있다"도 주 경로에서 거짓이다. 초안대로 구현하면 **모든 Qdrant 실패가 `upstream`(502)으로 떨어진다** — `not-found`도 `dimension-mismatch`도 영원히 나오지 않고, 에러 처리 표 4행이 죽은 글자가 된다.

core가 `isCollectionNotFound`에 남긴 주석(`core/src/clients/qdrant.ts:8-14`)이 이걸 이미 경험한 흔적이다 — "SDK 버전에 따라 status를 노출하지 않는 경우가 있어 메시지도 함께 본다." 그때는 이유를 몰랐던 것이고, 이유는 shape이 둘이라는 것이다.

#### 확정 판정 규칙

두 shape을 모두 다루기 위해 **상태 코드와 검색 대상 문자열을 각각 두 곳에서 모은다.**

```ts
export function classifyQdrantFailure(error: unknown): ExternalFailureKind | null;
```

공통 원칙의 3단계를 따르되, **1단계가 Gemini보다 복잡하다.** 주 경로에 `status` 프로퍼티가 없어 상태를 문자열에서 꺼내야 하는데, 그 꺼내는 방식이 곧 1단계의 안전성을 결정한다.

**0단계 — 타임아웃.** 생성자 이름이 `QdrantClientTimeoutError` → `timeout`. (상태가 없는 오류라 먼저 처리한다.)

**1단계 — 상태 확정. 본문을 보지 않는다.**

- `error.status`가 숫자면 그것 (`ApiError` 경로)
- 아니면 `message`의 **머리말**에서만 파싱: `/^Unexpected Response:\s*(\d{3})\b/`
- 둘 다 실패하면 `null`

**`^` 앵커가 이 규칙의 핵심이다.** 앵커 없이 `message` 아무 데서나 세 자리 숫자를 찾으면, `Raw response content:` 뒤에 붙은 본문 JSON의 숫자를 상태 코드로 읽는다 — Gemini의 `1429852`와 **완전히 같은 병**이다. 머리말은 `forResponse`가 항상 첫 줄에 `Unexpected Response: {code} ({reason})` 형태로 만든다(`dist/cjs/errors.js:14-23`). 그 위치에서만 읽는다.

**2단계 — 확정된 상태 안에서 세부 분기.** 여기서만 본문을 본다.

검색 대상 문자열 = `message` + (`data`가 있으면 `JSON.stringify(data)`). 두 shape 중 어느 쪽이 와도 본문이 포함된다.

| 상태 | 세부 분기 | kind |
|---|---|---|
| 400 | 검색 문자열이 `/dimension\|expected dim/i` | `dimension-mismatch` |
| 400 | 그 외 | `invalid-request` |
| 401 · 403 | 없음 | `auth` |
| 404 | 없음 | `not-found` |
| 429 | 없음 | **`null`** (아래 참조) |
| 500–599 | 없음 | `upstream` |
| 그 외 상태 | 없음 | `null` |

**3단계 — 상태가 `null`일 때만** 검색 문자열 전체를 본다:

1. `/not found|doesn't exist|does not exist/i` → `not-found`
2. 그 외 → `null`

#### 본문 검색이 허용되는 자리는 단 하나다

`dimension-mismatch`가 이 함수에서 본문을 보는 유일한 이유다. Qdrant는 차원 오류와 잘못된 필터 문법을 **같은 400**으로 돌려주므로, 상태만으로는 둘을 가를 수 없다.

이건 1단계 침범이 아니다. **상태를 정하는 데는 본문을 쓰지 않고, 상태가 400으로 정해진 뒤 세부를 가르는 데만 쓴다.** 규칙을 이 형태로 적어 두는 이유는, 같은 구조(`상태 || 검색문자열`)를 다시 쓰려는 변경이 리뷰에서 이 문단에 부딪히게 하기 위해서다.

초안은 4번을 "상태 404 **또는** 검색 문자열이 `/not found/i`"로 적었다. 그 `또는`이 본문을 상태 판정에 끌어들인다 — Qdrant가 400 본문에 "collection not found"를 담아 보내면 400이 `not-found`로 둔갑한다. 지금은 404 판정이 1단계 상태에만 걸리고, 문자열 판정은 상태를 못 읽었을 때(3단계)로 내려갔다.

**테스트는 두 shape을 각각 넣어 같은 kind가 나오는지 확인한다** — 한 shape만 테스트하면 다른 쪽에서 통째로 오분류된다.

**타임아웃을 여기서 잡아야 하는 이유.** `classifyCommonFailure`가 `AbortError`를 이름으로 잡지만, Qdrant SDK는 `fetch`의 `AbortError`를 **자기 타입으로 바꿔 다시 던진다**(`api-client.js:31-35`). 그래서 공통 판정에 걸리지 않는다. 여기서 잡지 않으면 에러 처리 표의 "Qdrant 5초 초과 → 504"가 성립하지 않고 조용히 502가 된다 — 표는 그대로인데 동작만 어긋나는 종류의 결함이라 테스트로 못 박아 둔다.

**Qdrant 429는 판정하지 않는다 (결정 유지, 근거 정정).** 초안은 "자체 호스팅 Qdrant에 호출량 쿼터라는 개념이 없기 때문"이라고 적었는데 **이건 사실이 아니다.** SDK에는 `QdrantClientResourceExhaustedError`가 있고 `retry_after` 필드까지 갖는다(`errors.js:33-43`) — Qdrant 서버가 429 + `Retry-After`를 보낼 수 있다는 뜻이다.

그럼에도 이번 범위에서는 `null`을 반환해 `upstream`(502)으로 둔다. 이유는 "개념이 없어서"가 아니라 **`quota`로 올리면 `Retry-After` 값의 출처가 갈리기 때문**이다 — 필터는 지금 고정 60초를 쓰는데, SDK가 실제 값을 손에 쥐여주는 상황에서 그 값을 버리고 60을 보내는 것은 명백히 나쁘고, 값을 살리려면 `ExternalServiceError`가 `retryAfter`를 실어 나르도록 공통 타입을 바꿔야 한다. 그건 구조 검증 기준이 금지한 공통 파일 변경이다.

**이 결정은 미해결 질문으로 올린다**(아래 "추가 미해결 질문"). 관리형 Qdrant Cloud로 옮기거나 쓰기 부하가 생기면 실제로 관측될 수 있고, 그때는 `retryAfter` 전달까지 함께 설계해야 한다. 지금 상태에서 502는 "기다리면 풀린다"는 정보를 잃지만, 잘못된 60초를 단언하지는 않는다.

### `src/clients/qdrant/tour-content-payload.ts` (신규, 순수 함수)

```ts
/**
 * core의 toPayload(core/src/lib/qdrantCollection.ts:76-89)가 쓰는 키와 1:1이어야 한다.
 * 타입 시스템이 두 워크스페이스를 연결하지 못하므로 이 주석과 workspaces.md 경계표가 유일한 연결이다.
 */
export interface TourSearchFilter {
  contenttypeid?: string;
  ldongRegnCd?: string;
  ldongSignguCd?: string;
  lclsSystm1?: string;
  lclsSystm2?: string;
  lclsSystm3?: string;
}

export interface TourContentPayload {
  contentid: string;
  contenttypeid: string;
  ldong_regn_cd: string;
  ldong_signgu_cd: string;
  lcls_systm1: string;
  lcls_systm2: string;
  lcls_systm3: string;
  title: string;
  mapx: string;
  mapy: string;
}

/** contentid가 없으면 PG 재조회가 불가능해 쓸모가 없다 → null. 나머지는 ''로 보정. */
export function parseTourContentPayload(raw: unknown): TourContentPayload | null;

/** 조건이 하나도 없으면 undefined를 반환한다 (빈 must 절을 보내지 않는다). */
export function buildQdrantFilter(filter?: TourSearchFilter): Record<string, unknown> | undefined;
```

필터를 타입으로 받고 순수 함수로 변환하는 이유: **payload 키 문자열이 코드 한 곳에만 존재하게** 하기 위해서다. 서비스 계층이 Qdrant 필터 DSL을 직접 조립하면 `ldong_regn_cd` 같은 키가 호출부마다 흩어지고, core가 키 이름을 바꿨을 때 고쳐야 할 곳을 셀 수 없게 된다.

### `src/clients/clients.module.ts` (신규)

```ts
@Module({
  imports: [ConfigModule],
  providers: [GeminiClient, TeiClient, QdrantSearchClient],
  exports: [GeminiClient, TeiClient, QdrantSearchClient],
})
export class ClientsModule {}
```

`imports: [ConfigModule]`은 `database.module.ts:23`과 같은 패턴이다. **세 번째 클라이언트(TEI)가 이 파일에서 차지한 것은 정확히 두 줄이다** — 위 "구조 검증" 기준의 일부다. 네 번째도 두 줄이어야 한다.

## 에러 처리

축이 core와 다르다. backend에는 루프도 `attempt_count`도 없다. 대신 **책임 귀속 → HTTP 상태**가 축이다.

| 실패 지점 | 책임 | kind | HTTP | 재시도 | 로그 |
|---|---|---|---|---|---|
| 부팅 시 필수 env 누락 | 우리 설정 | — (`validateEnv` throw) | **부팅 실패** | — | Nest 부팅 오류 |
| Gemini 401/403 · 키 무효 | **우리 설정** | `auth` | **500** | 없음 | error (키 값 미기록) |
| **Gemini 404 / 모델명 오설정** | **우리 설정** | `not-found` | **500** | 없음 | error |
| Gemini 429 / RESOURCE_EXHAUSTED | 외부(쿼터) | `quota` | **503** + `Retry-After: 60` | **없음** | warn |
| Gemini 400 / INVALID_ARGUMENT | 외부가 거절 | `invalid-request` | 502 | 없음 | error |
| Gemini 5xx | 외부 | `upstream` | 502 | 없음 | error |
| Gemini 200 + 빈 텍스트 | 외부 | `empty-response` | 502 | 없음 | error |
| Gemini 20초 초과 (`AbortError`) | 외부 | `timeout` | **504** | 없음 | error |
| **TEI 빈/공백 질의** (호출 전) | **우리 코드** | `invalid-request` | 502 | 없음 | error |
| TEI 400/413/422 | 외부가 거절 | `invalid-request` | 502 | 없음 | error |
| TEI 5xx (모델 로딩 중 등) | 외부 | `upstream` | 502 | 없음 | error |
| TEI 200 + 빈 배열 · 빈 벡터 | 외부 | `empty-response` | 502 | 없음 | error |
| TEI 5초 초과 | 외부 | `timeout` | 504 | 없음 | error |
| Qdrant 404 / 컬렉션 없음 | **우리 설정** | `not-found` | **500** | 없음 | error |
| Qdrant 401/403 | **우리 설정** | `auth` | **500** | 없음 | error |
| Qdrant 400 + 차원 불일치 | **우리 코드/설정** | `dimension-mismatch` | **500** | 없음 | error |
| Qdrant 5xx | 외부 | `upstream` | 502 | 없음 | error |
| **Qdrant 429** | 외부 | `upstream` (**`quota` 아님**) | 502 | 없음 | error |
| Qdrant 5초 초과 (`QdrantClientTimeoutError`) | 외부 | `timeout` | 504 | 없음 | error |
| 연결 거부·DNS 실패 (양쪽 공통) | 외부 | `unavailable` | 503 | 없음 | error |
| **Qdrant 정상 응답 · hit 0건** | **데이터** | — (실패 아님) | **200 + `[]`** | — | debug |
| Qdrant hit은 있는데 payload 전 건 파싱 실패 | 외부/계약 위반 | `upstream` | 502 | 없음 | **error** (버린 건수·첫 hit의 키 목록) |
| Qdrant hit 일부만 파싱 실패 | 데이터 | — (실패 아님) | 200 + 남은 건 | — | warn (버린 건수) |
| 요청 DTO 검증 실패 | 사용자 입력 | — (`ValidationPipe`) | **400** | — | — |

**어떤 `ExternalFailureKind`도 4xx가 되지 않는다.** 이 표에서 4xx는 `ValidationPipe`의 400 한 줄뿐이다. 외부 서비스의 실패를 사용자 입력 탓으로 돌리면(예: Gemini 400을 그대로 400으로 내려보내면) 프론트엔드는 "입력을 고치세요"라고 안내하고 사용자는 고칠 게 없는 입력을 고치려 든다.

**재시도가 0인 이유.** core는 Gemini 429에 2s→4s→8s 백오프로 최대 3회 재시도한다(`core/src/services/enricher.ts:141-154`). 그 재시도는 **오늘 안 쓰면 소멸하는 TourAPI 예산**을 지키기 위한 것이고, 기다리는 사람이 없는 배치라서 성립한다. backend에는 지킬 소멸성 자원이 없고 사람이 화면을 보고 있다. 게다가 core 자신이 학습한 결론이 있다 — 연속 3회 429면 이번 실행 동안 Gemini 호출을 아예 멈춘다(`enricher.ts:211-217`, "이미 소진된 쿼터를 향해 항목마다 재시도·대기를 반복하는 것은 낭비"). **쿼터가 마른 상태에서 2초 뒤에도 여전히 말라 있다.** 즉시 503 + `Retry-After`를 주고 판단을 호출자에게 넘긴다.

`Retry-After`는 **고정 60초**로 한다. Gemini 오류 상세의 `retryDelay`를 읽어 반영하는 것은 범위 밖이다.

### 이미 알려진 함정의 재현

**`failure-attribution.md`** — "이 실패의 책임이 데이터에 있는가, 호출자 사정에 있는가, 우리 저장소에 있는가." 세 종류가 위 표에 모두 나타난다: 우리 설정(`auth`·`not-found`·`dimension-mismatch` → 500), 외부 사정(`quota`·`unavailable`·`timeout`·`upstream` → 502/503/504), 데이터(hit 0건 → 200). `ExternalFailureKind`를 이 세 묶음으로 나눠 정의한 것이 이 학습을 타입에 새긴 결과다. 특히 **`auth`를 503이 아니라 500으로 보낸 것**이 핵심이다 — 만료된 키는 기다린다고 낫지 않는다. 503은 "나중에 다시"라는 거짓말이 된다.

같은 원리가 **Gemini 429는 `quota`, Qdrant 429는 `upstream`** 이라는 비대칭을 만든다. 다만 이 비대칭의 근거는 "책임 귀속이 달라서"가 아니라 **`Retry-After` 값의 출처가 달라서**다 — Qdrant SDK도 429를 쿼터로 모델링하고 있고(`QdrantClientResourceExhaustedError.retry_after`), 그 값을 살리려면 공통 타입을 바꿔야 한다. 자세한 재평가는 `classifyQdrantFailure` 절과 미해결 질문 5에 있다. **상태코드가 같다는 이유로 같은 kind를 주지 않는다는 원칙 자체는 유지되지만, 이 사례는 그 원칙의 좋은 예가 아니다.**

**`circuit-breaker-entry-paths.md`** — "같은 로직에 진입 경로를 둘 이상 만들 때는 두 경로가 같은 함수를 재사용하게 만든다." backend는 앞으로 진입 경로가 늘어난다(chat, 검색 엔드포인트, 헬스체크). 그래서 **모든 SDK 호출이 `callExternal` 하나를 통과한다는 규칙을 지금 세운다.** 지금은 차단기가 없지만, 넣게 되면 넣을 자리는 이미 한 곳으로 정해져 있다. 클라이언트 메서드가 SDK를 직접 호출하면 리뷰에서 확정 지적이다.

**`create-table-if-not-exists-is-no-op.md`** — 조용한 no-op의 backend판이 둘 있다: Qdrant 404를 빈 배열로 삼키는 것, `with_payload`를 안 보내 전 건이 버려지는 것. 둘 다 화면에서는 "검색 결과 없음"으로 똑같이 보이고 서버는 200을 찍는다. 위 표가 두 경우를 각각 500·502로 끊는다.

**`two-columns-one-state.md`** — 하나의 사실(컬렉션 이름·모델명·payload 키·임베딩 옵션)이 core와 backend 두 곳에 적힌다. 미해결 질문 3의 답으로 **공유 패키지 승격이라는 출구가 닫혔으므로 이 상태는 영구적이다.** 없앨 수 없으니 **경계표 등록으로 관리**한다 — 이것이 상시로 작동하는 유일한 방어다.

`.claude/skills/tb-tdd-implement/references/workspaces.md`의 "워크스페이스 경계 — 바꿀 때 함께 봐야 하는 짝" 표에 아래 5행을 **그대로** 추가한다:

```markdown
| `core/src/lib/qdrantCollection.ts`의 `toPayload` 키·`EXPECTED_DISTANCE` | `backend/src/clients/qdrant/tour-content-payload.ts`의 `TourContentPayload`·`TourSearchFilter` |
| `core/src/clients/tei.ts`의 `embed` 요청 바디(`normalize`/`truncate`/`prompt_name`) | `backend/src/clients/tei/tei.client.ts`의 `embedQuery` 고정 옵션 |
| TEI 서버에 떠 있는 임베딩 모델 (벡터 차원·distance를 결정한다) | Qdrant 컬렉션의 실제 차원. backend는 코드로 강제하지 않는다 — `getCollectionInfo()` 실측이 유일한 확인 |
| `core/src/clients/gemini.ts`의 기본 모델(`GEMINI_MODEL` fallback) | `backend/src/clients/gemini/gemini.client.ts`의 기본 모델 |
| `core/.env.example`의 `GEMINI_*`·`TEI_BASE_URL`·`QDRANT_*` | `backend/.env.example`, `backend/src/config/env.validation.ts`의 `REQUIRED_KEYS`, `backend/test/setup-env.ts` |
```

**정합성은 코드가 아니라 이 표와 실측으로만 보장된다.** backend의 시그니처를 core와 1:1로 맞춘 것도 이제 승격 대비가 아니라 **두 파일을 나란히 놓고 사람이 대조할 수 있게 하려는 것**으로 목적이 바뀌었다. 그 목적으로도 유지할 값어치가 있으므로 유지한다.

**`test-asymmetry.md`** — 위 에러 표는 24행이다. 테스트 목록도 행마다 짝을 맞춘다. 특히 겉모습이 같아서 한쪽만 테스트하기 쉬운 쌍을 명시적으로 짝짓는다: "hit 0건은 실패가 아니다" ↔ "hit은 있는데 전 건 파싱 실패는 실패다", "TEI 빈 응답은 실패다" ↔ "정상 벡터는 그대로 통과한다".

### 신규 함정

**1. `AbortSignal`은 우리 쪽만 끊는다 — Gemini는 계속 생성하고 과금은 발생한다.** SDK 타입 정의가 이 사실을 명시한다: *"Using it to cancel an operation will not cancel the request in the service. You will still be charged usage for any applicable operations."* 20초 타임아웃으로 504를 돌려준 요청도 Gemini 쪽에서는 완주한다. 타임아웃을 짧게 잡을수록 "돈은 쓰고 응답은 못 받는" 구간이 커진다. 20초는 그 구간을 실용적 범위에서 최소화하려고 고른 값이지 근거 있는 최적값이 아니다 — 실측 후 조정 대상이다.

**2. `with_payload` 누락이 "결과 없음"으로 위장한다.** 위 에러 표의 "전 건 파싱 실패 → 502" 행이 이걸 잡기 위한 것이다. 이 규칙이 없으면 옵션 하나를 빠뜨린 채로 며칠을 보낼 수 있다.

**3. 두 워크스페이스가 같은 컬렉션을 다른 코드로 본다.** core가 payload 키를 바꾸거나 임베딩 모델을 교체하면 backend는 컴파일도 테스트도 통과한 채로 틀린 결과를 낸다. 경계표 등록이 방어책이지만 사람이 표를 읽어야 작동한다. 검증 계획의 `getCollectionInfo` 실측(차원·distance 대조)이 자동화 가능한 유일한 방어선이다.

**4. Qdrant payload 인덱스가 없다.** core는 `createPayloadIndex`를 호출하지 않으므로 `TourSearchFilter`로 필터링하면 인덱스 없는 필터가 된다. 소량에서는 동작하고 수만 건에서 느려진다. 컬렉션 소유자는 core이므로 인덱스 생성은 이 문서 범위 밖이다.

**5. TEI 서버의 모델이 바뀌면 검색이 조용히 무의미해진다.** 이번 범위에서 가장 위험한 항목이다. TEI에 bge-m3가 아닌 다른 모델이 뜨면 두 가지 중 하나가 일어난다.

- **차원이 다르면** Qdrant가 400을 내고 `dimension-mismatch` → 500. 시끄럽게 실패한다. 좋은 경우다.
- **차원이 같으면**(1024차원 모델은 여럿 있다) 검색이 **정상 200으로 성공하고 결과만 무작위에 가깝다.** 상태코드도 로그도 정상이고, 단위 테스트는 전부 통과한다.

두 번째를 잡을 자동 수단이 없다. `getCollectionInfo`의 차원 대조도 통과한다. **그래서 검증 계획에 "상위 결과를 사람이 읽고 질의와 맞는지 본다"와 "서로 다른 두 질의가 서로 다른 상위 결과를 낸다"를 넣었다.** 후자는 임베딩이 사실상 상수이거나 벡터 공간이 어긋난 경우를 값싸게 잡는 대조군이다.

**6. `fetch`는 4xx·5xx에 throw하지 않는다.** `response.ok` 확인을 빠뜨리면 TEI의 에러 JSON이 `number[][]`로 파싱을 시도하다 이상한 곳에서 터지거나, 최악의 경우 파싱에 성공해 쓰레기 벡터가 Qdrant로 간다. SDK를 쓰는 다른 두 클라이언트에는 없는 함정이라 리뷰에서 빠뜨리기 쉽다.

## 파일 구조

```
backend/src/clients/external-service.error.ts          # 신규
backend/src/clients/call-external.ts                   # 신규
backend/src/clients/call-external.spec.ts              # 신규
backend/src/clients/external-service.filter.ts         # 신규
backend/src/clients/external-service.filter.spec.ts    # 신규
backend/src/clients/clients.module.ts                  # 신규
backend/src/clients/clients.module.spec.ts             # 신규
backend/src/clients/gemini/gemini.client.ts            # 신규
backend/src/clients/gemini/gemini.client.spec.ts       # 신규
backend/src/clients/gemini/gemini.errors.ts            # 신규
backend/src/clients/gemini/gemini.errors.spec.ts       # 신규
backend/src/clients/tei/tei.client.ts                  # 신규
backend/src/clients/tei/tei.client.spec.ts             # 신규
backend/src/clients/tei/tei.errors.ts                  # 신규
backend/src/clients/tei/tei.errors.spec.ts             # 신규
backend/src/clients/qdrant/qdrant.client.ts            # 신규
backend/src/clients/qdrant/qdrant.client.spec.ts       # 신규
backend/src/clients/qdrant/qdrant.errors.ts            # 신규
backend/src/clients/qdrant/qdrant.errors.spec.ts       # 신규
backend/src/clients/qdrant/tour-content-payload.ts     # 신규
backend/src/clients/qdrant/tour-content-payload.spec.ts # 신규

backend/src/app.module.ts                              # 수정: ConfigModule.forRoot({ validate })
backend/src/main.ts                                    # 수정: useGlobalFilters
backend/src/config/env.validation.ts                   # 수정: 필수 키 4개, 일괄 보고
backend/src/config/env.validation.spec.ts              # 신규
backend/.env.example                                   # 수정: GEMINI_*·TEI_BASE_URL·QDRANT_* 추가
backend/package.json                                   # 수정: @google/genai, @qdrant/js-client-rest 추가
backend/test/jest-e2e.json                             # 수정: setupFiles
backend/test/setup-env.ts                              # 신규: e2e용 더미 env (필수 키 4개)

backend/src/chat/**                                    # 무수정
backend/src/database/**                                # 무수정
core/**                                                # 무수정

.claude/skills/tb-tdd-implement/references/workspaces.md  # 수정: 경계표 5행 추가 (영구 중복의 유일한 상시 방어선)
```

의존성 추가는 **두 개뿐**이다: `@google/genai`, `@qdrant/js-client-rest`. **버전은 core와 맞춘다**(`core/package.json`: `^2.13.0` / `^1.18.0`) — 같은 서비스에 서로 다른 SDK 메이저를 물리면 동작 차이를 추적할 수 없다. **TEI는 의존성을 추가하지 않는다**(core의 axios 대신 전역 `fetch`).

import는 전부 상대 경로다. `backend/tsconfig.json`에 `baseUrl`·`paths`가 없으므로(TS7의 `TS5102`로 제거됨) `@/` 별칭을 쓰면 컴파일되지 않는다.

> 구현 시 두 SDK의 현행 시그니처를 context7로 확인한다. 특히 `query()`의 반환 shape과 `GenerateContentConfig`의 `abortSignal` 위치.

## 테스트

모킹 경계는 **SDK 모듈**이다. core가 `vi.mock("@qdrant/js-client-rest")`로 하는 것(`core/tests/clients/qdrant.test.ts:41-43`)과 같은 자리를 `jest.mock`으로 잡는다. 우리 클래스를 모킹하면 아무것도 검증하지 않고, HTTP 레벨(nock/msw)로 내리면 검증 대상이 SDK 내부 동작까지 넓어진다.

**TEI만 경계가 다르다** — SDK가 없으므로 전역 `fetch`를 `jest.spyOn(globalThis, 'fetch')`로 스텁한다. 이 경계는 오히려 더 정확하다: 요청 URL·메서드·바디를 문자열 수준에서 단정할 수 있어 "core와 같은 바디를 보내는가"를 직접 검증할 수 있다. **실제 네트워크는 절대 타지 않는다** — spy를 걸지 않은 테스트가 하나라도 있으면 CI에서 TEI 주소로 나간다. `afterEach`에서 복원하고, 스텁이 호출되지 않았어야 하는 케이스에서는 호출 횟수 0을 단정한다.

**`env.validation`**
- 필수 키가 전부 있으면 config를 그대로 반환
- 하나 없으면 throw / **전부 없으면 네 키 이름이 한 메시지에 모두 등장** (일괄 보고 확인)
- 빈 문자열도 누락으로 취급
- 선택 키(`GEMINI_MODEL`·`QDRANT_API_KEY`·`QDRANT_COLLECTION`)가 없어도 통과
- **`TEI_BASE_URL` 누락 단독 케이스** (신규 키가 실제로 필수 목록에 들어갔는지)

**`call-external`**
- 성공 시 값을 그대로 반환하고 감싸지 않음
- 실패 시 `ExternalServiceError`로 감싸고 `service`·`kind`가 채워짐
- **이미 `ExternalServiceError`면 다시 감싸지 않음** (동일 인스턴스 반환)
- `classify`가 `null`을 반환하면 `classifyCommonFailure`로 넘어감 / 그것도 `null`이면 `upstream`
- `AbortError`/`TimeoutError` → `timeout`
- `ECONNREFUSED`·`ENOTFOUND` → `unavailable`
- **로그에 API 키 문자열이 포함되지 않음** — `AIza` + 35자 형태의 가짜 키를 담은 오류를 주입해 확인
- 마스킹 패턴 3종 각각 1건: `AIza…` / `?key=`·`?api_key=`·`?access_token=` / `Bearer …`
- **마스킹이 메시지를 통째로 버리지 않음** ↔ 위 케이스와 짝. 키를 포함하지 않는 원인 메시지는 로그에 **그대로 남는다** (과잉 마스킹으로 진단 정보를 잃지 않는지)
- `cause` 체인: `Error('fetch failed', { cause: Error('ECONNREFUSED 127.0.0.1:8080') })` → 로그에 **`ECONNREFUSED`가 남고 `fetch failed`만 남지 않음**
- `cause`가 `AggregateError`이고 자신의 `message`가 빈 문자열 → `.errors[0].message`를 사용 (듀얼스택 `localhost` 재현)
- `cause`가 없는 평범한 오류 → 바깥 메시지 그대로 (짝)
- 순환 `cause`(`a.cause = b; b.cause = a`) → **무한 루프 없이 반환**
- **`classify`가 던져도 통로가 뚫리지 않음** — 던지는 분류기를 주입해 `ExternalServiceError(kind='upstream')`가 나오는지, 원래 실패가 삼켜지지 않는지
- 분류기 예외가 **원래 실패와 별도로 로그**됨
- 비-`Error` 값(`'문자열'` · `null` · `undefined`)으로 reject → 모두 `ExternalServiceError`로 감싸짐 (계약 "무슨 일이 있어도 `ExternalServiceError`만 던진다")

**`gemini.errors`** — 2단계 표의 각 행마다 1건 + 3단계 5줄 각각 1건 + 아래를 반드시 포함

**상태가 메시지를 이기는지 (공통 원칙 회귀)** — 이 셋이 이 분류기에서 가장 중요한 테스트다:
- **`status: 400` + 본문에 `"The input token count (1429852) exceeds…"` → `invalid-request`** (`quota` 아님). 실제로 결함이 났던 입력 그대로 쓴다
- **`status: 500` + 본문에 `"…while checking quota service."` → `upstream`** (`quota` 아님)
- **`status: 200`대가 아닌 임의 상태 + 본문에 `RESOURCE_EXHAUSTED` → 상태가 이긴다**

**2단계 (상태 안에서 세부 분기)**:
- **`400 + "API key not valid"` → `auth`** ↔ **400 + 그 외 메시지 → `invalid-request`** (짝). 앞이 깨지면 만료된 키가 502가 된다
- 404 → `not-found` / 401 · 403 → `auth` / 429 → `quota` / 503 → `upstream`

**3단계 (상태 없음)**:
- `status`·`code`가 없고 메시지만 `RESOURCE_EXHAUSTED` → `quota`
- 상태 없고 메시지만 `is not found for API version` → `not-found`
- **상태 없고 메시지에 `429`만 있음 → `quota`가 아님** (좁힌 패턴이 실제로 좁아졌는지 — core 규칙을 그대로 복사하면 실패한다)
- **상태 없고 메시지에 `checking quota service`만 있음 → `quota`가 아님**
- 모르는 오류 → `null` (공통 판정으로 넘기는 경로가 살아 있는지)
- 비-`Error` 값 → `null` (**던지지 않는다**)

**`gemini.client`** (`jest.mock('@google/genai')`)
- `generate`가 SDK를 올바른 model·prompt·systemInstruction·temperature로 호출
- `opts.model` 미지정 시 `GEMINI_MODEL` 기본값(`gemini-2.0-flash`) 사용 / 지정 시 그 값 사용
- **`GEMINI_MODEL=''`(빈 문자열)일 때도 기본값으로 폴백** ↔ 키 부재 시 폴백 ↔ 값이 있으면 그 값 (3방향). `ConfigService.get`의 두 번째 인자를 쓰면 첫 번째 케이스가 실패한다
- 응답 텍스트를 그대로 반환
- **빈 문자열 응답 → `empty-response`로 throw** / 공백만 있는 응답도 동일
- `undefined` 텍스트 → `empty-response`
- 429 → `quota` / 401 → `auth` / 500 → `upstream` (각각 별도 케이스)
- **`abortSignal`이 SDK에 전달됨** (누락 회귀 방지)
- 생성자가 네트워크를 호출하지 않음 (SDK 인스턴스 생성만)

**`tei.errors`** (순수 함수)
- `TeiHttpError(400)` · `(413)` · `(422)` → `invalid-request` / `(500)` · `(503)` → `upstream` / 그 외 비-2xx → `upstream`
- **`TeiHttpError`가 아닌 오류 → `null`** (`fetch`가 던진 것을 가로채지 않고 공통 판정에 넘기는지 — 반대 방향 케이스)
- 비-`Error` 값 → `null` (**던지지 않는다**)
- **`bodySnippet`이 판정을 바꾸지 않는다** — 같은 `status`에 서로 다른 `bodySnippet`(빈 문자열 / `RESOURCE_EXHAUSTED` 포함 / 숫자 `429` 포함)을 넣어도 kind가 동일. 나중에 누가 "정확도를 높이려고" 본문을 보기 시작하면 이 테스트가 막는다

**`tei.client`** (전역 `fetch` 스텁)
- `POST {TEI_BASE_URL}/embed`로 나가고, 바디가 **`{ inputs: [text], normalize: true, truncate: true }`** 와 정확히 일치 (core의 요청 형태와 같은지 — 문자열 수준 단정)
- `TEI_BASE_URL`은 필수 키이므로 폴백이 없다. 빈 문자열 케이스는 `validateEnv` 쪽에서 검증한다 (여기서 중복하지 않음)
- 바디에 `prompt_name` 키가 **없음**
- 응답 `[[0.1, 0.2, ...]]` → 첫 벡터를 `number[]`로 반환
- 빈 문자열 / 공백만 있는 입력 → **`fetch` 호출 0회**, `invalid-request` throw ↔ 정상 문자열 → `fetch` 1회 (짝)
- 응답 `[]` → `empty-response` / 응답 `[[]]` → `empty-response`
- `response.ok === false`(400·500) → **`TeiHttpError`를 던지고**, `callExternal`을 거쳐 각각 `invalid-request`·`upstream`이 됨. **본문을 벡터로 파싱하지 않음**
- `!response.ok`인데 body가 유효한 `number[][]`처럼 생긴 경우에도 **throw** (상태 확인이 파싱보다 먼저인지 — 확인을 빼면 조용히 성공으로 흐르는 경로)
- `fetch`가 `AbortError`로 reject → `timeout` (`classifyCommonFailure` 재사용 확인)
- `fetch`가 `ECONNREFUSED`로 reject → `unavailable`
- `signal`이 `fetch` 옵션에 전달됨 (타임아웃 누락 회귀 방지)
- **반환 벡터의 길이를 검사하지 않음** — 3차원 응답도 그대로 반환한다(차원 판정은 Qdrant의 일). 이 케이스가 없으면 나중에 누가 "안전하게" 길이 검사를 넣으면서 `1024`를 하드코딩한다

**`qdrant.errors`** (순수 함수)

**두 shape을 각각 넣어 같은 kind가 나오는지 확인한다.** 한 shape만 테스트하면 다른 쪽이 통째로 오분류돼도 초록불이 켜진다 — 이 함수에서 가장 큰 위험이다. 아래 판정 케이스는 각각 두 벌로 만든다:

- fixture A: `QdrantClientUnexpectedResponseError` 형태 — `status` 프로퍼티 **없음**, `message`가 `` `Unexpected Response: 404 (Not Found)\nRaw response content:\n{...}` ``
- fixture B: `ApiError` 형태 — `status` 숫자 있음, `message`는 `statusText`뿐, 본문은 `data`

판정 케이스:
- 404 → `not-found` (A·B 양쪽) / 상태를 못 읽고 메시지만 `not found`여도 `not-found` (3단계)
- 401 · 403 → `auth` (A·B)
- 400 + 차원 문구 → `dimension-mismatch` ↔ **400 + 그 외 문구 → `invalid-request`** (A·B 각각 짝)
- 5xx → `upstream` (A·B)

**1단계가 본문을 보지 않는지 (공통 원칙 회귀)** — Gemini와 같은 병이 복제되지 않았는지 확인한다:
- **머리말은 `Unexpected Response: 400 (Bad Request)`인데 본문 JSON에 `404`나 `"not found"`가 들어 있음 → `invalid-request` 계열** (`not-found` 아님). 앵커 없는 정규식이면 실패한다
- **머리말은 `Unexpected Response: 500 …`인데 본문에 차원 문구가 있음 → `upstream`** (`dimension-mismatch` 아님)
- 머리말이 없고 `status` 프로퍼티도 없는 오류 → 3단계로만 판정
- `QdrantClientTimeoutError` → `timeout` (**공통 판정에 맡기면 502가 되는 회귀를 못 박는다**)
- **429 → `null`** (Gemini와 달리 `quota`로 판정하지 않음). `QdrantClientResourceExhaustedError`도 `null`
- 모르는 오류 · 비-`Error` 값 → `null` (**던지지 않는다**)

**`tour-content-payload`** (순수 함수)
- 완전한 payload → 전 필드 매핑
- `contentid` 없음 → `null`
- `contentid` 있고 나머지 없음 → `''`로 보정된 객체
- `null`·문자열·배열 입력 → `null`
- `buildQdrantFilter`: 조건 1개 / 여러 개 / **없으면 `undefined`** (빈 `must` 미생성)
- 필터 키가 core의 payload 키와 문자열까지 일치 (`ldong_regn_cd` 등을 리터럴로 단정)

**`qdrant.client`** (`jest.mock('@qdrant/js-client-rest')`)
- 생성자가 `url`·`apiKey`·**`timeout`**을 SDK에 전달 (timeout 누락 회귀 방지)
- `QDRANT_API_KEY`가 없으면 `apiKey`를 넘기지 않음 / **`QDRANT_API_KEY=''`일 때도 넘기지 않음** (짝)
- `search`가 `QDRANT_COLLECTION` 컬렉션을 사용 (기본값 `tour_contents` / env 지정 시 그 값 / **`''`일 때 기본값**)
- 요청에 **`with_payload: true`가 포함되고 `with_vector`는 포함되지 않음**
- `limit` 기본 10 / 지정 시 그 값
- 필터 지정 시 변환된 필터 전달 / **미지정 시 필터 키 자체가 요청에 없음**
- 결과를 `TourSearchHit[]`로 매핑
- **hit 0건 → 빈 배열 반환, throw 없음**
- **hit 3건 중 1건만 payload 불량 → 2건 반환 + warn**
- **hit 3건 전부 payload 불량 → throw (`upstream`)** ← 위 두 케이스와 짝
- 404 → `not-found` (**빈 배열 아님**)
- 차원 불일치 400 → `dimension-mismatch`
- `getCollectionInfo`가 vectorSize·distance를 반환 / 읽을 수 없으면 throw

**`external-service.filter`**
- kind별 상태코드 — 표의 9개 kind 각각 1건
- `quota`일 때만 `Retry-After` 헤더가 붙고 다른 kind에는 붙지 않음 (양방향 짝)
- **`message`가 `MESSAGE_BY_KIND`의 고정 문구와 일치하고, 예외 인스턴스의 `message`와는 다름**
- 자격증명·업스트림 원문을 담은 예외를 넣어도 응답 본문 어디에도 그 문자열이 없음 (`cause`까지 포함)
- 본문의 키가 `statusCode` · `error` · `message` **셋뿐** (진단 정보가 새는 필드가 늘지 않는지)

**`clients.module`**
- `ConfigModule`을 명시 주입한 TestingModule에서 **세 클라이언트가 모두** 해석됨
- **spec이 개발자 `.env`에 의존하지 않음** — `ignoreEnvFile: true`로 구성

## 검증 계획

1. `npx tsc --noEmit -p tsconfig.json` 통과
2. `npm test` — 신규 테스트 전부 통과, **기존 `chat.controller.spec.ts`·`app.controller.spec.ts`도 그대로 통과**
3. `npm run test:e2e` 통과 (`setupFiles` 추가 후에도 `/ (GET)`이 200)
4. `npm run lint` — 자동 수정 결과 확인 후 커밋
5. `npm run build` 성공
6. **구조 검증** — TEI를 추가하면서 공통 파일에 무엇을 했는지 diff로 확인한다.
7. **실측** — `npm run build` 후 `node -e`로 `dist`의 클라이언트를 직접 불러 확인한다. 소비자 모듈이 없어 서버를 띄우는 것으로는 아무것도 증명되지 않으므로 이 단계가 필수다. 전제: 실행 환경에서 `TEI_BASE_URL`·`QDRANT_URL`에 도달할 수 있어야 한다(사내망).

### 구조 검증 — 공통화 경계가 옳았는가

| 확인 항목 | 판단 기준 |
|---|---|
| 공통 파일 수정 범위 | `git diff`에서 `external-service.error.ts`의 변경이 **`ExternalService` 유니온에 `'tei'` 추가 한 줄뿐** |
| `callExternal` 본문 | **무변경** (SDK가 없는 클라이언트에도 그대로 적용됨) |
| `classifyCommonFailure` 본문 | **무변경** (`fetch`의 `AbortError`·`ECONNREFUSED`가 기존 판정으로 잡힘) |
| `ExternalServiceFilter` | **무변경** (TEI가 새 kind를 요구하지 않음) |
| `ClientsModule` | providers·exports에 **한 줄씩, 총 두 줄** |

**하나라도 어긋나면 공통화 경계가 틀린 것이다.** 그 경우 구현을 그대로 두지 말고 무엇이 새어 나왔는지 리뷰에 올린다 — 네 번째 클라이언트에서 같은 비용을 또 낸다.

### 실측

| 확인 항목 | 판단 기준 |
|---|---|
| **컬렉션 계약** | `getCollectionInfo()`의 `vectorSize`·`distance`가 core의 값(`core/src/lib/qdrantCollection.ts:15`, `2026-07-26-...:54` → 1024·`Cosine`)과 일치 |
| **TEI ↔ 컬렉션 차원 대조** | `(await tei.embedQuery('차원 확인')).length === (await qdrant.getCollectionInfo()).vectorSize`. **두 값을 코드로 비교한다** — 어느 쪽도 하드코딩하지 않고 계약을 확인하는 유일한 방법 |
| **검색 왕복 (경로가 닫혔는가)** | `embedQuery('아이랑 갈 실내 관광지')` → `search(vector, { limit: 10 })` → hit 10건, **모든 hit에 `payload.contentid` 존재**, score 내림차순 |
| **상위 결과 사람 판정** | 위 질의의 상위 3건 `payload.title`을 **사람이 읽고** 질의와 그럴듯하게 맞는지 본다. 차원만 맞고 모델이 다르면 검색은 200으로 성공하고 결과만 무의미하다 — 이걸 잡는 자동 수단이 없다 |
| **질의 대조군** | `'바닷가 일출 명소'`와 `'실내 박물관'`의 상위 5건이 **서로 다르다**. 같으면 임베딩이 사실상 상수이거나 벡터 공간이 어긋난 것 |
| 필터 | `filter: { contenttypeid: '12' }` → 반환된 모든 hit의 `payload.contenttypeid === '12'`, 그리고 필터 없는 같은 질의보다 결과가 좁아짐 |
| **차원 불일치** | 3차원 벡터로 `search` → `kind === 'dimension-mismatch'` 또는 `'invalid-request'`. **빈 배열이 아님** |
| **없는 컬렉션** | `QDRANT_COLLECTION=없는이름` → `kind === 'not-found'`. **빈 배열이 아님** |
| Qdrant 도달 불가 | `QDRANT_URL`을 닫힌 포트로 → `kind === 'unavailable'`, 5초 이내 반환 (SDK 기본 300초가 아님을 확인) |
| TEI 도달 불가 | `TEI_BASE_URL`을 닫힌 포트로 → `kind === 'unavailable'`, 5초 이내 반환 |
| Gemini 생성 | `generate('안녕')` → 비어 있지 않은 문자열, 20초 이내 |
| **Gemini 인증 실패** | `GEMINI_API_KEY=invalid` → `kind === 'auth'`, 오류 메시지와 로그 어디에도 키 문자열이 없음 |
| 상태코드 매핑 | 위 각 kind를 필터에 넣어 실제 응답 상태 확인 (단위 테스트로 대체 가능하나 최소 `quota`·`not-found` 2건은 눈으로) |

`quota`(429)는 실측하기 어렵다. 단위 테스트로만 검증하고 실측 항목에서 제외한다 — 억지로 쿼터를 태우는 것은 비용이고, 판정 로직은 core에서 이미 운영 중인 규칙과 같다.

**"상위 결과 사람 판정"과 "질의 대조군"은 형식적 절차가 아니다.** 신규 함정 5가 말하는 실패 모드(차원은 같고 모델이 다름)를 잡는 것이 이 둘뿐이며, 이번 실행에서 검색 경로가 실제로 닫혔는지에 대한 유일한 증거다.

## 알아둘 트레이드오프

**1. 같은 서비스의 클라이언트가 저장소에 두 벌 존재하고, 그 비용은 영구적이다.** 이 설계가 지불하는 가장 큰 값이다. 미해결 질문 3의 답이 "공유 패키지 승격 계획 없음"이었으므로 **중복이 해소되는 미래 시점이 없다.** 두 벌로 갈라지는 것은 Qdrant payload 키 · 컬렉션 이름 · 벡터 차원 · distance · Gemini 기본 모델명 · TEI 요청 바디(`normalize`/`truncate`)이며, 타입 시스템은 어긋남을 전혀 잡지 못한다.

방어는 셋뿐이고 전부 사람 손을 탄다:
- `workspaces.md` 경계표 5행 (사람이 표를 읽어야 작동)
- `getCollectionInfo` ↔ `embedQuery().length` 대조 실측 (사람이 실행해야 작동)
- backend 시그니처를 core와 1:1로 유지 (사람이 두 파일을 나란히 놓고 대조할 때만 이득)

승격이라는 출구가 없어졌으므로 **1:1 시그니처 유지의 목적이 바뀌었다.** 더 이상 "나중에 합칠 때 편하려고"가 아니라 "지금 대조를 가능하게 하려고"다. 목적이 바뀌어도 방침은 유지할 값어치가 있어 유지하되, **정합성이 코드가 아니라 문서와 실측으로만 보장된다**는 사실을 이 문서와 경계표 양쪽에 남긴다.

**2. SDK 경계 모킹은 SDK 옵션 이름의 오타를 잡지 못한다.** `with_payload`를 `withPayload`로 썼어도 mock은 받은 그대로 단정을 통과시킨다. 이 구멍을 메우는 것은 실측뿐이고, 그래서 검증 계획의 7번이 형식적 절차가 아니다. (TEI는 `fetch` 스텁이라 요청 URL·바디를 문자열로 단정할 수 있어 이 구멍이 좁다 — SDK를 쓰지 않아 생긴 뜻밖의 이득이다.)

**3. 재시도 0회는 일시적 5xx 한 번에 사용자 요청을 실패시킨다.** Gemini가 간헐적 500을 낸다면 사용자는 새로고침해야 한다. 자동 재시도 1회가 체감 성공률을 올릴 여지는 있지만, "사람이 다시 누르는 것"이 2초 백오프보다 나은 UX라고 판단했다. 실사용에서 5xx 빈도가 눈에 띄면 이 결정을 다시 본다 — 그때 넣을 자리는 `callExternal` 한 곳으로 이미 정해져 있다.

**4. 타임아웃이 비용을 막지 못한다.** 신규 함정 1과 같은 사실의 다른 얼굴이다. 504를 돌려준 요청도 Gemini에서는 완주하고 과금된다.

**5. 필터 검색이 인덱스 없이 동작한다.** 데이터가 커지면 드러난다. 고치려면 컬렉션 소유자인 core를 건드려야 한다.

**6. core와 backend가 Qdrant의 서로 다른 API(`search` / `query`)를, TEI에 대해 서로 다른 HTTP 수단(axios / `fetch`)을 쓴다.** 같은 결과를 내지만, Qdrant 서버를 업그레이드하거나 TEI 요청 형식이 바뀔 때 확인할 지점이 두 곳이 된다.

**7. `ClientsModule`이 어디에도 배선되지 않은 채 커밋된다.** 소비자가 생길 때까지 이 코드는 테스트와 실측으로만 살아 있다. 배선을 미루는 대신 나중에 지울 코드를 만들지 않는 쪽을 골랐다.

**8. 질의 임베딩이 요청마다 TEI 왕복 한 번을 더한다.** 검색 응답 시간에 TEI 지연이 그대로 더해지고, 캐시가 없으므로 같은 질의를 두 번 보내면 두 번 임베딩한다. 자체 호스팅 단문 임베딩이라 수십 ms 수준일 것으로 보지만 실측 전까지는 추정이다. 질의 캐시는 범위 밖 — 넣더라도 어디에 둘지(클라이언트 내부 vs 서비스 계층)는 실측 후에 정할 일이다.

## 범위 밖 (YAGNI)

- **Gemini 구조화 출력(`responseSchema`)·스트리밍** — `chat.service.ts:12-13`이 결국 필요로 하지만, 스키마 모양과 "스키마는 맞는데 내용이 틀린 일정"에 대한 정책을 함께 정해야 한다. 그건 chat 기능의 결정이지 클라이언트의 결정이 아니다. (미해결 질문 2의 답 = A)
- **Gemini 임베딩 API** — 색인이 TEI bge-m3로 만들어져 있어 섞으면 안 된다. 문서 상단 참조.
- **TEI 배치 임베딩(`embed(texts[])`)** — backend에는 배치 호출자가 없고, 노출하면 색인을 backend에서 하려는 유혹이 생긴다. 필요해지면 `embedQuery` 옆에 추가한다.
- **TEI 옵션 노출(`normalize`/`truncate`/`prompt_name`)·OpenAI 호환 `/v1/embeddings`·TEI 인증** — 색인이 만들어진 조건과 다르게 질의할 수 있는 손잡이를 만들지 않는다. 선행 문서(`2026-07-23-core-tei-embedding-client-design.md:81-85`)도 뒤 두 항목을 범위 밖으로 뒀다.
- **질의 임베딩 캐시** — 트레이드오프 8. 실측 후에 판단한다.
- **backend에서의 재임베딩·재색인** — Qdrant 쓰기와 같은 이유로 core의 일이다.
- **Qdrant 쓰기(upsert·delete·createCollection·ensureCollection)** — 컬렉션 소유권은 core에 있다. `database.module.ts:16-18`이 Postgres 스키마에 대해 정한 것과 같은 원칙이다.
- **Qdrant payload 인덱스 생성** — 같은 이유로 core의 일.
- **재시도·백오프·서킷 브레이커** — 위 근거. 넣게 되면 `callExternal` 한 곳.
- **타임아웃의 env화** — 상수로 둔다. 운영에서 조정이 필요해지면 그때 키를 판다.
- **`ChatModule` 배선 / `ChatService` 스텁 교체** — 이번 요구사항은 클라이언트다. `chat.service.ts:15`의 동기 시그니처를 `Promise`로 바꾸는 변경은 컨트롤러와 계약 테스트까지 함께 봐야 하므로 별도 실행이다.
- **`core`를 공유 패키지로 승격** — 미해결 질문 3의 답으로 **계획 없음이 확정**됐다. 되살리려면 `core/package.json`에 `exports` 추가 + backend의 jest ESM 전환이 함께 필요하다는 것만 기록해 둔다.
- **core의 Qdrant 타임아웃 미설정 수정** — `core/src/clients/qdrant.ts:50`이 SDK 기본값 300초에 노출돼 있다. core 워크스페이스 변경이라 이 문서에서 하지 않는다. 별도 실행에서 다룬다.
- **core의 `isRateLimited` 잠복 결함 수정** — `core/src/services/enricher.ts:88`의 `/429|rate limit|RESOURCE_EXHAUSTED|quota/i`가 Gemini 오류 본문 전문에 적용된다. backend에서 실제로 터진 것과 같은 구조이며(`1429852` → `quota`), core에서는 **쿼터가 아닌 실패를 쿼터로 오분류해 `structure_attempt_count`를 올리지 않고 넘어가게** 만든다 — 영구 실패 항목이 매 실행 재시도되며 제자리걸음한다. 증상이 backend와 다르지만 뿌리는 같다. core 워크스페이스 변경이라 별도 실행에서 다룬다.
- **메트릭·트레이싱** — 로그만 남긴다.
- **`@Global()` 모듈, 커스텀 provider 토큰, 동적 모듈(`forRoot`) 패턴** — 클라이언트가 두 개고 설정이 env 하나뿐인 지금은 전부 순비용이다.

## 미해결 질문과 답 (2026-07-27 해소)

초안에서 임의로 정하지 않고 올린 4건이다. 질문과 선택지를 그대로 남긴다 — 같은 논의가 다시 열릴 때 무엇이 근거였는지가 필요하다.

**1. TEI 클라이언트를 이번에 함께 만드는가?** → **답: A (함께 만든다)**
질문: Qdrant 검색에는 질의 벡터가 필요하고, 색인이 TEI bge-m3(1024차원, Cosine, `normalize=true`)로 만들어져 있어 다른 모델로 만든 벡터는 쓸 수 없다.
- **A. 함께 만든다** → 검색이 실제로 동작한다. 공통 구조(`callExternal`·`ExternalServiceError`·`ClientsModule`)가 세 번째 클라이언트로 검증된다.
- B. 이번엔 gemini·qdrant만 → `QdrantSearchClient`가 호출자 없이 남는다.

**반영 결과:** TEI를 본 범위로 옮겼다. 파일 4개(`tei.client.ts`·`tei.errors.ts`와 각 spec), env 키 `TEI_BASE_URL` 1개, `ClientsModule` 2줄, 에러 표 5행, 테스트 15건, 실측 항목 5개가 추가됐다. 함께 결정한 것: 단건 전용 `embedQuery`(선행 문서의 배치 우선 결정을 뒤집음, 근거는 "선행 문서로부터의 변경" 절), 옵션 미노출, `fetch` 사용, **차원 검사 안 함**. 그리고 "공통 파일이 유니온 한 줄 외에 바뀌지 않는가"가 구조 검증 항목으로 들어갔다.

**2. Gemini 구조화 출력(`responseSchema` / `generateJson<T>`)을 이번에 넣는가?** → **답: A (`generate()`만)**
- **A. `generate()`만** → 스키마 정의는 chat 배선 때 정한다.
- B. 지금 `generateJson`까지 → itinerary 스키마와 "스키마는 맞는데 pinNumber가 중복인 일정" 정책을 지금 확정해야 한다.

**반영 결과:** 변경 없음. 범위 밖 유지.

**3. core 클라이언트를 언젠가 공유 패키지로 승격할 계획이 있는가?** → **답: 계획 없음**
- 있다 → 중복 비용이 한시적.
- **없다** → 두 벌 관리 비용이 **영구적**. 경계표 등록의 중요도가 올라간다.

**반영 결과:** 트레이드오프 1을 "영구적 비용"으로 다시 썼다. `workspaces.md` 경계표에 추가할 5행을 복붙 가능한 형태로 명시했고(에러 처리 절의 `two-columns-one-state` 항목), 그 등록을 **이 설계의 유일한 상시 방어선**으로 격상했다. backend 시그니처를 core와 1:1로 맞추는 방침은 유지하되 **목적이 "승격 대비"에서 "사람이 대조 가능하게"로 바뀌었음**을 기록했다. 정합성은 코드가 아니라 문서와 실측으로만 보장된다.

**4. backend가 Qdrant에 쓸 계획이 있는가?** → **답: 없음 (읽기 전용 확정)**
- **없다** → 읽기 전용.
- 있다 → 컬렉션 소유권 모델을 다시 정해야 한다(컬렉션 분리 vs 공유, 후자면 차원·distance 계약 강제 수단 필요).

**반영 결과:** 변경 없음. `QdrantSearchClient`의 읽기 전용 표면과 범위 밖의 쓰기 항목을 그대로 유지한다.

### 추가 미해결 질문 (2026-07-27, 묶음 A 리뷰 중 발견)

**5. Qdrant 429를 `quota`로 올릴 것인가?**
초안의 "자체 호스팅 Qdrant에 쿼터 개념이 없다"는 근거가 **사실이 아님이 확인됐다** — SDK에 `QdrantClientResourceExhaustedError`가 있고 `retry_after`까지 갖는다(`errors.js:33-43`). 근거는 정정했고 결정은 유지했지만, 결정 자체는 다시 볼 값어치가 있다.
- **A. 현행 유지 (`upstream` → 502)** → 공통 타입 무변경. "기다리면 풀린다"는 정보를 잃지만 틀린 `Retry-After`를 단언하지 않는다.
- **B. `quota`로 올리고 고정 60초** → SDK가 쥐고 있는 실제 값을 버린다. 명백히 나쁘다.
- **C. `quota`로 올리고 `ExternalServiceError`에 `retryAfter?: number` 추가** → 정확하지만 **공통 파일(`external-service.error.ts`)의 본문 변경**이라 구조 검증 기준("유니온 한 줄뿐")과 충돌한다. 기준을 다시 쓸지 함께 정해야 한다.
- 현재 채택: **A.** 자체 호스팅 단일 인스턴스에서 429가 실제로 관측된 적이 없어 지금 C의 비용을 낼 근거가 없다. 관리형 Qdrant Cloud로 옮기거나 쓰기 부하가 생기면 **C로 가고 구조 검증 기준을 개정**한다.

이 항목은 **동작 결함이 아니다** — 502든 503이든 요청은 실패하고 로그에 남는다. 정확도의 문제이므로 실제 관측 후에 정하는 것이 합리적이다.

### 남은 미해결 질문

위 5번 외에는 **없다.** 설계상 갈림길은 모두 닫혔다.

다만 검증 계획의 실측에는 **환경 전제**가 하나 있다: 실행 환경에서 `TEI_BASE_URL`과 `QDRANT_URL`에 도달할 수 있어야 하고, TEI에는 색인을 만든 것과 **같은 모델(bge-m3)** 이 떠 있어야 한다. 도달할 수 없으면 단위 테스트까지만 완료하고 실측을 미완으로 보고한다 — 통과했다고 적지 않는다. 이건 설계 결정이 아니라 실행 시 확인할 사항이다.
