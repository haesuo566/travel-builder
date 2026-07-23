# core 통합 클라이언트 3종 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `core`에 RAG 파이프라인용 외부 서비스 연동 클래스 3종(GeminiClient 생성 전용, PostgresClient pg 래퍼, QdrantStore 벡터 저장소)과 공통 env 헬퍼를 TDD로 구현한다.

**Architecture:** 독립 클래스 3개 + 얇은 공통 env 헬퍼. Gemini는 무상태(HTTP), PG/Qdrant는 명시적 `connect()`/`close()` 수명주기. 설정은 생성자에서 `process.env`를 읽어 자동 로딩하며, 필수 변수 누락 시 즉시 throw한다. 외부 SDK는 단위 테스트에서 `vi.mock`으로 모킹한다.

**Tech Stack:** TypeScript(ESM/NodeNext), `@google/genai`, `pg`+`@types/pg`, `@qdrant/js-client-rest`, Vitest.

---

## File Structure

- `core/src/lib/env.ts` — `requireEnv` / `optionalEnv` 헬퍼 (신규)
- `core/src/clients/gemini.ts` — `GeminiClient` (신규)
- `core/src/clients/postgres.ts` — `PostgresClient` (신규)
- `core/src/clients/qdrant.ts` — `QdrantStore` (신규)
- `core/tests/env.test.ts` — env 헬퍼 테스트 (신규)
- `core/tests/clients/gemini.test.ts` — GeminiClient 테스트 (신규)
- `core/tests/clients/postgres.test.ts` — PostgresClient 테스트 (신규)
- `core/tests/clients/qdrant.test.ts` — QdrantStore 테스트 (신규)
- `core/package.json` — 의존성 추가 (수정)

> **ESM/NodeNext 규칙:** TS 소스의 상대 import는 `.js` 확장자를 붙인다 (예: `../lib/env.js`).
> **작업 디렉토리:** npm/npx/node는 `core/`에서, git은 저장소 루트 `C:\workspace\travel-buider`에서 실행. 브랜치 `feat/core-cli`.

---

## Task 1: 의존성 설치

**Files:**
- Modify: `core/package.json` (npm이 자동 갱신)

- [ ] **Step 1: 런타임 의존성 설치**

Run (in `core/`): `npm install @google/genai pg @qdrant/js-client-rest`
Expected: 오류 없이 설치, `package.json` dependencies에 3개 추가.

- [ ] **Step 2: 타입 의존성 설치**

Run (in `core/`): `npm install -D @types/pg`
Expected: `package.json` devDependencies에 `@types/pg` 추가.

- [ ] **Step 3: 타입체크로 설치 확인**

Run (in `core/`): `npm run typecheck`
Expected: exit 0 (기존 코드 영향 없음).

- [ ] **Step 4: Commit**

```bash
git add core/package.json core/package-lock.json
git commit -m "chore: Gemini/pg/Qdrant SDK 의존성 추가"
```

---

## Task 2: env 헬퍼 (TDD)

**Files:**
- Create: `core/tests/env.test.ts`
- Create: `core/src/lib/env.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`core/tests/env.test.ts`)**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { requireEnv, optionalEnv } from "../src/lib/env.js";

const KEY = "TEST_ENV_VAR_X";

afterEach(() => {
  delete process.env[KEY];
});

describe("requireEnv", () => {
  it("설정된 값을 반환한다", () => {
    process.env[KEY] = "hello";
    expect(requireEnv(KEY)).toBe("hello");
  });

  it("미설정이면 throw한다", () => {
    expect(() => requireEnv(KEY)).toThrow(KEY);
  });

  it("빈 문자열이면 throw한다", () => {
    process.env[KEY] = "";
    expect(() => requireEnv(KEY)).toThrow(KEY);
  });
});

describe("optionalEnv", () => {
  it("설정된 값을 반환한다", () => {
    process.env[KEY] = "v";
    expect(optionalEnv(KEY, "fb")).toBe("v");
  });

  it("미설정이면 fallback을 반환한다", () => {
    expect(optionalEnv(KEY, "fb")).toBe("fb");
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/env.test.ts`
Expected: FAIL — `../src/lib/env.js` 모듈/함수 없음.

- [ ] **Step 3: 구현 (`core/src/lib/env.ts`)**

```typescript
/** 필수 환경 변수를 읽는다. 없거나 빈 문자열이면 throw. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`환경 변수 ${name}가 설정되지 않았습니다.`);
  }
  return value;
}

/** 선택 환경 변수를 읽는다. 없거나 빈 문자열이면 fallback을 반환. */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/env.test.ts`
Expected: PASS — 5개 통과.

- [ ] **Step 5: Commit**

```bash
git add core/src/lib/env.ts core/tests/env.test.ts
git commit -m "feat: env 헬퍼(requireEnv/optionalEnv) 추가 (TDD)"
```

---

## Task 3: GeminiClient (TDD)

**Files:**
- Create: `core/tests/clients/gemini.test.ts`
- Create: `core/src/clients/gemini.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`core/tests/clients/gemini.test.ts`)**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { generateContentMock, constructorMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  constructorMock: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
    constructor(opts: unknown) {
      constructorMock(opts);
    }
  },
}));

import { GeminiClient } from "../../src/clients/gemini.js";

beforeEach(() => {
  generateContentMock.mockReset();
  constructorMock.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
});

describe("GeminiClient", () => {
  it("GEMINI_API_KEY 없으면 생성자에서 throw", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => new GeminiClient()).toThrow("GEMINI_API_KEY");
  });

  it("apiKey로 SDK를 초기화한다", () => {
    new GeminiClient();
    expect(constructorMock).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  it("generate가 기본 모델로 generateContent를 호출하고 텍스트를 반환한다", async () => {
    generateContentMock.mockResolvedValue({ text: "안녕" });
    const client = new GeminiClient();
    const result = await client.generate("hi");
    expect(result).toBe("안녕");
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-2.0-flash",
      contents: "hi",
      config: { systemInstruction: undefined, temperature: undefined },
    });
  });

  it("opts의 model/systemInstruction/temperature를 전달한다", async () => {
    generateContentMock.mockResolvedValue({ text: "x" });
    const client = new GeminiClient();
    await client.generate("hi", { model: "gemini-pro", systemInstruction: "sys", temperature: 0.2 });
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-pro",
      contents: "hi",
      config: { systemInstruction: "sys", temperature: 0.2 },
    });
  });

  it("GEMINI_MODEL 환경변수가 기본 모델을 덮어쓴다", async () => {
    process.env.GEMINI_MODEL = "gemini-custom";
    generateContentMock.mockResolvedValue({ text: "x" });
    const client = new GeminiClient();
    await client.generate("hi");
    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-custom" }),
    );
  });

  it("응답 text가 없으면 빈 문자열을 반환한다", async () => {
    generateContentMock.mockResolvedValue({ text: undefined });
    const client = new GeminiClient();
    expect(await client.generate("hi")).toBe("");
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/gemini.test.ts`
Expected: FAIL — `../../src/clients/gemini.js` 없음.

- [ ] **Step 3: 구현 (`core/src/clients/gemini.ts`)**

```typescript
import { GoogleGenAI } from "@google/genai";
import { optionalEnv, requireEnv } from "../lib/env.js";

export interface GenerateOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
}

/** Gemini 텍스트 생성 클라이언트 (생성 전용). */
export class GeminiClient {
  private readonly client: GoogleGenAI;
  private readonly defaultModel: string;

  constructor() {
    const apiKey = requireEnv("GEMINI_API_KEY");
    this.defaultModel = optionalEnv("GEMINI_MODEL", "gemini-2.0-flash");
    this.client = new GoogleGenAI({ apiKey });
  }

  /** 프롬프트로 텍스트를 생성해 문자열로 반환한다. */
  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const response = await this.client.models.generateContent({
      model: opts.model ?? this.defaultModel,
      contents: prompt,
      config: {
        systemInstruction: opts.systemInstruction,
        temperature: opts.temperature,
      },
    });
    return response.text ?? "";
  }
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/gemini.test.ts`
Expected: PASS — 6개 통과.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/gemini.ts core/tests/clients/gemini.test.ts
git commit -m "feat: GeminiClient(생성 전용) 추가 (TDD)"
```

---

## Task 4: PostgresClient (TDD)

**Files:**
- Create: `core/tests/clients/postgres.test.ts`
- Create: `core/src/clients/postgres.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`core/tests/clients/postgres.test.ts`)**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  poolQueryMock,
  poolConnectMock,
  poolEndMock,
  clientQueryMock,
  clientReleaseMock,
  PoolMock,
} = vi.hoisted(() => {
  const poolQueryMock = vi.fn();
  const poolConnectMock = vi.fn();
  const poolEndMock = vi.fn();
  const clientQueryMock = vi.fn();
  const clientReleaseMock = vi.fn();
  const PoolMock = vi.fn(() => ({
    query: poolQueryMock,
    connect: poolConnectMock,
    end: poolEndMock,
  }));
  return { poolQueryMock, poolConnectMock, poolEndMock, clientQueryMock, clientReleaseMock, PoolMock };
});

vi.mock("pg", () => ({
  default: { Pool: PoolMock },
}));

import { PostgresClient } from "../../src/clients/postgres.js";

beforeEach(() => {
  poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  poolConnectMock.mockReset();
  poolEndMock.mockReset().mockResolvedValue(undefined);
  clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  clientReleaseMock.mockReset();
  PoolMock.mockClear();
  process.env.DATABASE_URL = "postgres://localhost/test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("PostgresClient", () => {
  it("DATABASE_URL 없으면 생성자에서 throw", () => {
    delete process.env.DATABASE_URL;
    expect(() => new PostgresClient()).toThrow("DATABASE_URL");
  });

  it("connect 전 query 호출 시 throw", async () => {
    const client = new PostgresClient();
    await expect(client.query("SELECT 1")).rejects.toThrow("연결");
  });

  it("connect가 Pool을 만들고 SELECT 1로 확인한다", async () => {
    const client = new PostgresClient();
    await client.connect();
    expect(PoolMock).toHaveBeenCalledWith({ connectionString: "postgres://localhost/test" });
    expect(poolQueryMock).toHaveBeenCalledWith("SELECT 1");
  });

  it("query가 pool.query에 위임한다", async () => {
    const client = new PostgresClient();
    await client.connect();
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const res = await client.query("SELECT * FROM t WHERE id=$1", [1]);
    expect(res.rows).toEqual([{ id: 1 }]);
    expect(poolQueryMock).toHaveBeenLastCalledWith("SELECT * FROM t WHERE id=$1", [1]);
  });

  it("transaction 성공 시 BEGIN/COMMIT 후 release", async () => {
    poolConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
    const client = new PostgresClient();
    await client.connect();
    const result = await client.transaction(async (c) => {
      await c.query("INSERT ...");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(clientQueryMock.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "INSERT ...", "COMMIT"]);
    expect(clientReleaseMock).toHaveBeenCalledOnce();
  });

  it("transaction 예외 시 ROLLBACK 후 release하고 재-throw", async () => {
    poolConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
    const client = new PostgresClient();
    await client.connect();
    await expect(
      client.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(clientQueryMock.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(clientReleaseMock).toHaveBeenCalledOnce();
  });

  it("close가 pool.end를 호출한다", async () => {
    const client = new PostgresClient();
    await client.connect();
    await client.close();
    expect(poolEndMock).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/postgres.test.ts`
Expected: FAIL — `../../src/clients/postgres.js` 없음.

- [ ] **Step 3: 구현 (`core/src/clients/postgres.ts`)**

```typescript
import pg from "pg";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { requireEnv } from "../lib/env.js";

const { Pool: PgPool } = pg;

/** PostgreSQL 연결 클라이언트 (pg Pool 래퍼). */
export class PostgresClient {
  private readonly connectionString: string;
  private pool: Pool | null = null;

  constructor() {
    this.connectionString = requireEnv("DATABASE_URL");
  }

  /** Pool을 생성하고 SELECT 1로 연결을 확인한다. */
  async connect(): Promise<void> {
    if (this.pool) return;
    const pool = new PgPool({ connectionString: this.connectionString });
    await pool.query("SELECT 1");
    this.pool = pool;
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error("PostgresClient가 연결되지 않았습니다. 먼저 connect()를 호출하세요.");
    }
    return this.pool;
  }

  /** 쿼리를 실행한다. */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.requirePool().query<T>(text, params);
  }

  /** 트랜잭션 블록을 실행한다. 예외 시 ROLLBACK 후 재-throw. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Pool을 종료한다. 미연결 상태면 no-op. */
  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/postgres.test.ts`
Expected: PASS — 7개 통과.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/postgres.ts core/tests/clients/postgres.test.ts
git commit -m "feat: PostgresClient(pg Pool 래퍼) 추가 (TDD)"
```

---

## Task 5: QdrantStore (TDD)

**Files:**
- Create: `core/tests/clients/qdrant.test.ts`
- Create: `core/src/clients/qdrant.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`core/tests/clients/qdrant.test.ts`)**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  getCollectionsMock,
  createCollectionMock,
  deleteCollectionMock,
  upsertMock,
  searchMock,
  deleteMock,
  QdrantClientMock,
} = vi.hoisted(() => {
  const getCollectionsMock = vi.fn();
  const createCollectionMock = vi.fn();
  const deleteCollectionMock = vi.fn();
  const upsertMock = vi.fn();
  const searchMock = vi.fn();
  const deleteMock = vi.fn();
  const QdrantClientMock = vi.fn(() => ({
    getCollections: getCollectionsMock,
    createCollection: createCollectionMock,
    deleteCollection: deleteCollectionMock,
    upsert: upsertMock,
    search: searchMock,
    delete: deleteMock,
  }));
  return {
    getCollectionsMock,
    createCollectionMock,
    deleteCollectionMock,
    upsertMock,
    searchMock,
    deleteMock,
    QdrantClientMock,
  };
});

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: QdrantClientMock,
}));

import { QdrantStore } from "../../src/clients/qdrant.js";

beforeEach(() => {
  getCollectionsMock.mockReset().mockResolvedValue({ collections: [] });
  createCollectionMock.mockReset().mockResolvedValue(true);
  deleteCollectionMock.mockReset().mockResolvedValue(true);
  upsertMock.mockReset().mockResolvedValue({ status: "completed" });
  searchMock.mockReset().mockResolvedValue([]);
  deleteMock.mockReset().mockResolvedValue({ status: "completed" });
  QdrantClientMock.mockClear();
  process.env.QDRANT_URL = "http://localhost:6333";
  delete process.env.QDRANT_API_KEY;
});

afterEach(() => {
  delete process.env.QDRANT_URL;
  delete process.env.QDRANT_API_KEY;
});

describe("QdrantStore", () => {
  it("QDRANT_URL 없으면 생성자에서 throw", () => {
    delete process.env.QDRANT_URL;
    expect(() => new QdrantStore()).toThrow("QDRANT_URL");
  });

  it("connect 전 작업 메서드 호출 시 throw", async () => {
    const store = new QdrantStore();
    await expect(store.upsert("c", [])).rejects.toThrow("연결");
  });

  it("connect가 클라이언트를 만들고 getCollections로 확인한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    expect(QdrantClientMock).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      apiKey: undefined,
    });
    expect(getCollectionsMock).toHaveBeenCalledOnce();
  });

  it("QDRANT_API_KEY가 있으면 전달한다", async () => {
    process.env.QDRANT_API_KEY = "secret";
    const store = new QdrantStore();
    await store.connect();
    expect(QdrantClientMock).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      apiKey: "secret",
    });
  });

  it("createCollection이 기본 Cosine으로 호출한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    await store.createCollection("col", 768);
    expect(createCollectionMock).toHaveBeenCalledWith("col", {
      vectors: { size: 768, distance: "Cosine" },
    });
  });

  it("deleteCollection이 위임한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    await store.deleteCollection("col");
    expect(deleteCollectionMock).toHaveBeenCalledWith("col");
  });

  it("upsert가 wait:true와 points를 전달한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    const points = [{ id: 1, vector: [0.1, 0.2], payload: { a: 1 } }];
    await store.upsert("col", points);
    expect(upsertMock).toHaveBeenCalledWith("col", { wait: true, points });
  });

  it("search가 기본 limit 10으로 호출하고 결과를 매핑한다", async () => {
    searchMock.mockResolvedValue([
      { id: 5, version: 0, score: 0.9, payload: { t: "x" }, vector: [0.1] },
    ]);
    const store = new QdrantStore();
    await store.connect();
    const res = await store.search("col", [0.1, 0.2]);
    expect(searchMock).toHaveBeenCalledWith("col", {
      vector: [0.1, 0.2],
      limit: 10,
      filter: undefined,
    });
    expect(res).toEqual([{ id: 5, score: 0.9, payload: { t: "x" } }]);
  });

  it("search가 opts의 limit/filter를 전달한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    const filter = { must: [{ key: "city", match: { value: "Berlin" } }] };
    await store.search("col", [0.1], { limit: 3, filter });
    expect(searchMock).toHaveBeenCalledWith("col", { vector: [0.1], limit: 3, filter });
  });

  it("deletePoints가 wait:true와 ids를 전달한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    await store.deletePoints("col", [1, 2]);
    expect(deleteMock).toHaveBeenCalledWith("col", { wait: true, points: [1, 2] });
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/qdrant.test.ts`
Expected: FAIL — `../../src/clients/qdrant.js` 없음.

- [ ] **Step 3: 구현 (`core/src/clients/qdrant.ts`)**

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";
import { optionalEnv, requireEnv } from "../lib/env.js";

export type QdrantDistance = "Cosine" | "Euclid" | "Dot";

export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface QdrantSearchOptions {
  limit?: number;
  filter?: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
}

/** Qdrant 벡터 저장소 래퍼. 이미 계산된 벡터를 받아 저장/검색한다. */
export class QdrantStore {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private client: QdrantClient | null = null;

  constructor() {
    this.url = requireEnv("QDRANT_URL");
    const key = optionalEnv("QDRANT_API_KEY", "");
    this.apiKey = key === "" ? undefined : key;
  }

  /** 클라이언트를 생성하고 getCollections로 연결을 확인한다. */
  async connect(): Promise<void> {
    if (this.client) return;
    const client = new QdrantClient({ url: this.url, apiKey: this.apiKey });
    await client.getCollections();
    this.client = client;
  }

  private requireClient(): QdrantClient {
    if (!this.client) {
      throw new Error("QdrantStore가 연결되지 않았습니다. 먼저 connect()를 호출하세요.");
    }
    return this.client;
  }

  async createCollection(
    name: string,
    vectorSize: number,
    distance: QdrantDistance = "Cosine",
  ): Promise<void> {
    await this.requireClient().createCollection(name, {
      vectors: { size: vectorSize, distance },
    });
  }

  async deleteCollection(name: string): Promise<void> {
    await this.requireClient().deleteCollection(name);
  }

  async upsert(collection: string, points: QdrantPoint[]): Promise<void> {
    await this.requireClient().upsert(collection, { wait: true, points });
  }

  async search(
    collection: string,
    vector: number[],
    opts: QdrantSearchOptions = {},
  ): Promise<QdrantSearchResult[]> {
    const results = await this.requireClient().search(collection, {
      vector,
      limit: opts.limit ?? 10,
      filter: opts.filter as Parameters<QdrantClient["search"]>[1]["filter"],
    });
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload,
    }));
  }

  async deletePoints(collection: string, ids: (string | number)[]): Promise<void> {
    await this.requireClient().delete(collection, { wait: true, points: ids });
  }

  /** 내부 클라이언트 참조를 해제한다. */
  async close(): Promise<void> {
    this.client = null;
  }
}
```

> **참고:** `filter`는 공개 API에서 `Record<string, unknown>`로 두고, SDK의 `filter` 타입으로만 국소 캐스팅한다(경계에서의 의도적 불투명 처리). `upsert`/`delete`/`createCollection` 본문은 구조가 일치하므로 캐스팅 불필요. 만약 SDK 버전 차이로 타입 오류가 나면 context7로 현행 시그니처를 확인하고 해당 본문에만 `as Parameters<QdrantClient["<method>"]>[1]`를 적용한다.

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/qdrant.test.ts`
Expected: PASS — 10개 통과.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/qdrant.ts core/tests/clients/qdrant.test.ts
git commit -m "feat: QdrantStore(벡터 저장소 래퍼) 추가 (TDD)"
```

---

## Task 6: 전체 검증

**Files:**
- (신규 파일 없음 — 통합 검증)

- [ ] **Step 1: 전체 타입체크 (src + tests)**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: 전체 테스트**

Run (in `core/`): `npm test`
Expected: 모든 테스트 PASS (hello 2 + env 5 + gemini 6 + postgres 7 + qdrant 10 = 30).

- [ ] **Step 3: 빌드**

Run (in `core/`): `npm run build`
Expected: 오류 없이 `dist/clients/gemini.js`, `dist/clients/postgres.js`, `dist/clients/qdrant.js`, `dist/lib/env.js` 생성.

- [ ] **Step 4: (커밋할 신규 소스 없음 — dist는 gitignore, 스킵)**

---

## Self-Review 결과

**Spec coverage:**
- env 헬퍼(requireEnv/optionalEnv) → Task 2.
- GeminiClient(생성 전용, 기본 모델 gemini-2.0-flash, env 자동 로딩) → Task 3.
- PostgresClient(pg Pool, connect/query/transaction/close, DATABASE_URL) → Task 4.
- QdrantStore(connect/createCollection/deleteCollection/upsert/search/deletePoints/close, QDRANT_URL/API_KEY) → Task 5.
- 단위 테스트(모킹) → 각 Task의 테스트.
- 의존성(@google/genai, pg, @types/pg, @qdrant/js-client-rest) → Task 1.
- 검증(typecheck/test/build) → Task 6.

**Placeholder scan:** 모든 코드/명령이 실제 내용. 플레이스홀더 없음.

**Type consistency:** `requireEnv/optionalEnv(name)→string`; `GeminiClient.generate(prompt, opts?)→Promise<string>` with `GenerateOptions`; `PostgresClient` `connect/query<T>/transaction<T>/close`; `QdrantStore` 메서드 시그니처와 `QdrantPoint`/`QdrantSearchOptions`/`QdrantSearchResult`/`QdrantDistance` 타입이 구현·테스트 전반에서 일치. import는 모두 `.js` 확장자 사용.
