# core 통합 클라이언트 3종 설계 (Gemini / PostgreSQL / Qdrant)

- 날짜: 2026-07-23
- 위치: `core/`
- 상태: 승인됨

## 목적

travel-builder의 RAG 파이프라인을 위한 외부 서비스 연동 클래스 3종을 `core`에 만든다.

RAG 흐름: **텍스트 → TEI(외부, 범위 밖)에서 임베딩 → Qdrant 저장/검색 → 검색 컨텍스트 + 질의 → Gemini 생성.**

이번 작업은 아래 3개 클래스와 공통 env 헬퍼만 만든다. TEI 임베딩 클라이언트와 RAG 오케스트레이션 Facade는 범위 밖이다. **Qdrant 클래스는 이미 계산된 벡터(`number[]`)를 받아** 저장/검색한다(임베딩 생성 안 함).

## 결정 사항

| 항목 | 선택 |
|------|------|
| 사용 목적 | RAG 파이프라인 |
| Gemini 기능 | 생성 전용 (generateContent) |
| PostgreSQL | `pg` (node-postgres) Pool 래퍼 |
| Qdrant | 컬렉션 생성/삭제 + upsert + search + point 삭제 |
| 설정 방식 | 내부 env 자동 로딩 (생성자에서 process.env 읽음) |
| 테스트 | 단위 테스트, 외부 SDK 모킹(`vi.mock`) |
| PG/Qdrant 수명주기 | 명시적 `connect()` / `close()` |
| Qdrant 래퍼 이름 | `QdrantStore` (SDK의 `QdrantClient`와 충돌 회피) |
| Gemini 기본 모델 | `gemini-2.0-flash` |
| PG 설정 | `DATABASE_URL` 단일 변수 |

## 아키텍처

**독립 클래스 3개 + 얇은 공통 env 헬퍼.** 세 서비스는 수명주기가 달라(Gemini 무상태 HTTP, PG/Qdrant connect/close) 공통 베이스 클래스를 강제하지 않는다.

- 대안 A(단일 Facade): RAG 오케스트레이션이 확정되면 상위에 추가 — 지금은 YAGNI.
- 대안 B(추상 베이스 상속): 수명주기가 제각각이라 공통화 이득이 적음 — 기각.

## 파일 구조

```
core/src/
├── lib/
│   ├── logger.ts            # (기존)
│   └── env.ts               # requireEnv / optionalEnv 헬퍼
└── clients/
    ├── gemini.ts            # GeminiClient (생성 전용)
    ├── postgres.ts          # PostgresClient (pg Pool 래퍼)
    └── qdrant.ts            # QdrantStore (Qdrant REST 래퍼)
core/tests/clients/
├── gemini.test.ts
├── postgres.test.ts
└── qdrant.test.ts
```

## 의존성 추가

- `@google/genai` — 현행 통합 Gemini SDK
- `pg` + `@types/pg` — PostgreSQL 드라이버
- `@qdrant/js-client-rest` — Qdrant REST 클라이언트

> 구현 시 각 SDK의 현행 API를 context7로 확인해 정확한 시그니처를 사용한다.

## 공통 env 헬퍼 (`src/lib/env.ts`)

- `requireEnv(name: string): string` — `process.env[name]`를 읽어 반환, 없거나 빈 문자열이면 명확한 메시지로 throw.
- `optionalEnv(name: string, fallback: string): string` — 있으면 그 값, 없으면 fallback.

## 클래스 인터페이스

### `GeminiClient` (무상태 — connect/close 없음)

- env: `GEMINI_API_KEY`(필수), `GEMINI_MODEL`(선택, 기본 `gemini-2.0-flash`)
- `constructor()` — env 읽음. `GEMINI_API_KEY` 없으면 즉시 throw.
- `generate(prompt: string, opts?: { model?: string; systemInstruction?: string; temperature?: number }): Promise<string>`
  - `@google/genai`의 generateContent 호출 후 생성 텍스트를 문자열로 반환.
  - `opts.model` 미지정 시 기본 모델 사용.

### `PostgresClient` (pg `Pool`, 명시적 수명주기)

- env: `DATABASE_URL`(필수)
- `constructor()` — env 캡처. 연결은 하지 않음. `DATABASE_URL` 없으면 throw.
- `connect(): Promise<void>` — `Pool` 생성 후 `SELECT 1`로 연결 확인.
- `query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>>` — 연결 전 호출 시 throw.
- `transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>` — 전용 클라이언트로 `BEGIN` → `fn` → `COMMIT`, 예외 시 `ROLLBACK` 후 재-throw, finally에서 `client.release()`.
- `close(): Promise<void>` — `pool.end()`. 미연결 상태면 no-op.

### `QdrantStore` (`@qdrant/js-client-rest`, 명시적 수명주기)

- env: `QDRANT_URL`(필수), `QDRANT_API_KEY`(선택)
- `constructor()` — env 캡처. `QDRANT_URL` 없으면 throw.
- `connect(): Promise<void>` — 내부 `QdrantClient` 생성 후 `getCollections()`로 연결 확인.
- `createCollection(name: string, vectorSize: number, distance?: "Cosine" | "Euclid" | "Dot"): Promise<void>` — 기본 `Cosine`.
- `deleteCollection(name: string): Promise<void>`
- `upsert(collection: string, points: { id: string | number; vector: number[]; payload?: Record<string, unknown> }[]): Promise<void>`
- `search(collection: string, vector: number[], opts?: { limit?: number; filter?: Record<string, unknown> }): Promise<QdrantSearchResult[]>`
  - `QdrantSearchResult`: `{ id: string | number; score: number; payload?: Record<string, unknown> | null }`
  - `opts.limit` 기본 10.
- `deletePoints(collection: string, ids: (string | number)[]): Promise<void>`
- `close(): Promise<void>` — 내부 클라이언트 참조 해제. 연결 전 메서드 호출 시 throw.

## 에러 처리

- 필수 env 누락 → 생성자에서 명확한 메시지로 throw (fail-fast).
- PG/Qdrant에서 `connect()` 전 작업 메서드 호출 → "not connected" 취지의 throw.
- SDK/네트워크 에러는 래핑 최소화하고 전파. 연결 확인 실패는 `connect()`에서 throw.

## 테스트 (단위 · 모킹)

외부 SDK를 `vi.mock`으로 모킹하여 네트워크 없이 로직만 검증한다.

- **env**: `requireEnv` 누락 throw / 존재 시 반환, `optionalEnv` fallback.
- **GeminiClient**: `GEMINI_API_KEY` 누락 시 생성자 throw; `generate()`가 SDK를 올바른 model/prompt로 호출하고 텍스트를 반환; `opts` 전달.
- **PostgresClient**: `DATABASE_URL` 누락 throw; `connect()` 미호출 시 `query()` throw; `query()`가 pool.query에 위임; `transaction()`의 commit 경로와 예외 시 rollback 경로; `close()`가 pool.end 호출.
- **QdrantStore**: `QDRANT_URL` 누락 throw; `connect()` 미호출 시 작업 메서드 throw; `createCollection`/`upsert`/`search`/`deletePoints`가 SDK를 올바른 인자로 호출; `search`가 결과를 `QdrantSearchResult`로 매핑; 기본값(distance=Cosine, limit=10) 적용.

## 검증 계획

1. `npm run typecheck` (src + tests) 통과.
2. `npm test` — 신규 단위 테스트 전부 통과.
3. `npm run build` 성공.

## 범위 밖 (YAGNI)

- TEI 임베딩 클라이언트.
- RAG 오케스트레이션 Facade.
- 실제 DB 마이그레이션/스키마 정의.
- 통합 테스트(실서비스 연결).
