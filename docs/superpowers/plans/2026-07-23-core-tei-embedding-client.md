# TeiEmbeddingClient(TEI 임베딩 서버) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `core`에 Hugging Face TEI(Text Embeddings Inference) 서버 연동 클래스 `TeiEmbeddingClient`를 TDD로 구현한다. 텍스트 배열을 받아 임베딩 벡터(`number[][]`)를 반환하며, 이 벡터는 `QdrantStore.upsert`/`search`에 그대로 전달된다.

**Architecture:** 무상태 HTTP 래퍼(GeminiClient/TourApiClient와 동일 패턴). 네이티브 TEI `POST /embed` 엔드포인트를 axios(기존 의존성)로 호출한다. TEI 응답은 이미 `number[][]` 형태로 오므로 별도 정규화가 필요 없다.

**Tech Stack:** TypeScript(ESM/NodeNext), axios(기존 의존성), Vitest.

---

## File Structure

- `core/src/clients/tei.ts` — `TeiEmbeddingClient` (신규)
- `core/tests/clients/tei.test.ts` — 단위 테스트 (신규)

신규 의존성 없음(axios는 이미 설치되어 있음). 기존 `core/src/lib/env.ts`의 `requireEnv`를 재사용한다.

> **ESM/NodeNext 규칙:** 상대 import는 `.js` 확장자 사용. **작업 디렉토리:** npm/npx/node는 `core/`에서, git은 저장소 루트 `C:\workspace\travel-buider`에서. 브랜치 `feat/core-cli`.

---

## Task 1: TeiEmbeddingClient (TDD)

**Files:**
- Create: `core/tests/clients/tei.test.ts`
- Create: `core/src/clients/tei.ts`

- [ ] **Step 1: 실패하는 테스트 작성 (`core/tests/clients/tei.test.ts`)**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("axios", () => ({
  default: { post: postMock },
}));

import { TeiEmbeddingClient } from "../../src/clients/tei.js";

beforeEach(() => {
  postMock.mockReset();
  process.env.TEI_BASE_URL = "http://localhost:8080";
});

afterEach(() => {
  delete process.env.TEI_BASE_URL;
});

describe("TeiEmbeddingClient", () => {
  it("TEI_BASE_URL 없으면 생성자에서 throw", () => {
    delete process.env.TEI_BASE_URL;
    expect(() => new TeiEmbeddingClient()).toThrow("TEI_BASE_URL");
  });

  it("기본 옵션(normalize=true, truncate=true)으로 /embed를 호출한다", async () => {
    postMock.mockResolvedValue({ data: [[0.1, 0.2]] });
    const client = new TeiEmbeddingClient();
    const result = await client.embed(["hello"]);
    expect(postMock).toHaveBeenCalledWith("http://localhost:8080/embed", {
      inputs: ["hello"],
      normalize: true,
      truncate: true,
    });
    expect(result).toEqual([[0.1, 0.2]]);
  });

  it("opts로 normalize/truncate/promptName을 덮어쓸 수 있다", async () => {
    postMock.mockResolvedValue({ data: [[0.1, 0.2]] });
    const client = new TeiEmbeddingClient();
    await client.embed(["hello"], { normalize: false, truncate: false, promptName: "query" });
    expect(postMock).toHaveBeenCalledWith("http://localhost:8080/embed", {
      inputs: ["hello"],
      normalize: false,
      truncate: false,
      prompt_name: "query",
    });
  });

  it("promptName 미지정 시 요청 바디에서 생략된다", async () => {
    postMock.mockResolvedValue({ data: [[0.1, 0.2]] });
    const client = new TeiEmbeddingClient();
    await client.embed(["hello"]);
    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("prompt_name");
  });

  it("배치 입력 시 순서대로 number[][]를 반환한다", async () => {
    postMock.mockResolvedValue({
      data: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    });
    const client = new TeiEmbeddingClient();
    const result = await client.embed(["a", "b"]);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("빈 배열 입력 시 axios를 호출하지 않고 빈 배열을 반환한다", async () => {
    const client = new TeiEmbeddingClient();
    const result = await client.embed([]);
    expect(result).toEqual([]);
    expect(postMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run (in `core/`): `npx vitest run tests/clients/tei.test.ts`
Expected: FAIL — `../../src/clients/tei.js` 없음.

- [ ] **Step 3: 구현 (`core/src/clients/tei.ts`)**

```typescript
import axios from "axios";
import { requireEnv } from "../lib/env.js";

export interface TeiEmbedOptions {
  normalize?: boolean;
  truncate?: boolean;
  promptName?: string;
}

/** Hugging Face TEI(Text Embeddings Inference) 서버 연동 클라이언트 (무상태). */
export class TeiEmbeddingClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = requireEnv("TEI_BASE_URL");
  }

  /** 텍스트 배열을 임베딩 벡터 배열로 변환한다. 입력 순서와 출력 순서가 1:1 대응한다. */
  async embed(texts: string[], opts: TeiEmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body: Record<string, unknown> = {
      inputs: texts,
      normalize: opts.normalize ?? true,
      truncate: opts.truncate ?? true,
    };
    if (opts.promptName !== undefined) {
      body.prompt_name = opts.promptName;
    }

    const { data } = await axios.post<number[][]>(`${this.baseUrl}/embed`, body);
    return data;
  }
}
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run (in `core/`): `npx vitest run tests/clients/tei.test.ts`
Expected: PASS — 6개 통과.

- [ ] **Step 5: 타입체크**

Run (in `core/`): `npm run typecheck`
Expected: exit 0. (axios `.post<T>()`의 실제 제네릭 시그니처가 미세하게 다르면 `node_modules/axios`의 실제 타입 선언을 확인해 시그니처만 맞추고 `any`/`as any`는 쓰지 않는다. 공개 메서드 시그니처와 테스트가 기대하는 동작은 그대로 유지한다.)

- [ ] **Step 6: Commit**

```bash
git add core/src/clients/tei.ts core/tests/clients/tei.test.ts
git commit -m "feat: TeiEmbeddingClient(TEI 임베딩 서버) 추가 (TDD)"
```

---

## Task 2: 전체 검증

**Files:**
- (신규 파일 없음 — 통합 검증)

- [ ] **Step 1: 전체 타입체크 (src + tests)**

Run (in `core/`): `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: 전체 테스트**

Run (in `core/`): `npm test`
Expected: 모든 테스트 PASS (기존 46개 + tei 6개 = 52개).

- [ ] **Step 3: 빌드**

Run (in `core/`): `npm run build`
Expected: 오류 없이 `dist/clients/tei.js` 생성.

- [ ] **Step 4: (커밋할 신규 소스 없음 — dist는 gitignore, 스킵)**

---

## Self-Review 결과

**Spec coverage:**
- `TeiEmbeddingClient` 생성자(env 자동 로딩, `TEI_BASE_URL` 필수) → Task 1.
- `embed(texts, opts?)` — 기본 normalize/truncate, opts 오버라이드, promptName 생략 처리 → Task 1.
- 빈 배열 입력 시 네트워크 호출 없이 즉시 반환 → Task 1.
- 응답 `number[][]` 그대로 반환(순서 보존) → Task 1.
- axios 재사용(신규 의존성 없음) → 확인됨(이미 설치).
- 검증(typecheck/test/build) → Task 2.

**Placeholder scan:** 모든 코드/명령이 실제 내용. 플레이스홀더 없음.

**Type consistency:** `TeiEmbedOptions`/`embed(texts: string[], opts?: TeiEmbedOptions): Promise<number[][]>` 시그니처가 구현·테스트 전반에서 일치. import는 모두 `.js` 확장자 사용.
