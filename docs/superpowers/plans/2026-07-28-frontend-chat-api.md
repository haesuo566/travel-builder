# frontend `sendMessage`를 실제 `POST /chat`으로 교체

run-id: `2026-07-28-frontend-chat-api`
대상 워크스페이스: **frontend 단일**
spec: **없음**(하네스 규모 축약). 아래 "결정" 절이 spec을 대신한다 — 구현자는 여기서 벗어나면 계획 이탈로 기록한다.

---

## 결정 (spec 대체)

| # | 결정 | 근거 |
|---|---|---|
| D-1 | **`getItinerary()`는 mock으로 유지한다.** `getDefaultItinerary()` 호출을 그대로 두고, 왜 남는지 주석만 붙인다. | 백엔드에 대응 엔드포인트(`GET /itinerary`류)가 없다. 만들면 `backend` 워크스페이스를 건드려 "frontend 단일" 전제가 깨지고 커밋을 워크스페이스별로 나눠야 한다(`workspaces.md` 공통 규약). 최초 일정은 서버 상태가 아니라 화면 초기값이라 mock으로도 기능이 성립한다 — `POST /chat`이 매 턴 일정 전량을 돌려주므로 첫 턴 이후에는 서버 값으로 덮인다. |
| D-2 | **base URL은 `NEXT_PUBLIC_API_BASE_URL` 하나로 주입한다. 기본값을 두지 않는다.** 값이 없으면 `sendMessage` **호출 시점**에 던진다(모듈 로드 시점 throw 아님). | (a) `plan/page.tsx`는 `"use client"`이고 fetch가 브라우저에서 돈다 — `NEXT_PUBLIC_` 접두사가 없으면 클라이언트 번들에 값이 아예 들어가지 않는다(`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md:156-166`). (b) 기본값 `http://localhost:3001`을 두면 배포 빌드에서 브라우저가 **사용자 PC**를 향해 요청하고, 설정 누락이 "연결 실패"로 위장된다 — `local-env-file-masks-required-key-wiring.md`가 말하는 조용한 마스킹의 프론트엔드 판본이다. (c) 모듈 로드 시점 throw는 `/plan`의 프리렌더(`next build`)를 깨뜨려 빌드가 env를 요구하게 된다. 호출 시점 throw는 **실측으로 빌드가 통과했고**(env 없이 `npm run build` OK) 단위 테스트로 양방향(설정/미설정)을 고정할 수 있다. |
| D-3 | **에러 shape 두 개를 구분한다.** `message`가 배열이면(ValidationPipe 400) 우리 문구로 바꾸고, 문자열이면(ExternalServiceFilter 5xx) **그대로** 사용자에게 보여준다. 그 외(JSON 아님·`message` 없음·fetch 자체 실패)는 폴백 문구. | 구분 기준을 상태코드가 아니라 `message`의 타입으로 잡는다 — 그게 두 shape의 실제 차이다(`workspaces.md:123` 경계표). 400의 `message`는 class-validator가 만든 **영문 원문**(`message must be shorter than or equal to 1000 characters`)이라 사용자에게 보여줄 수 없다. 5xx의 `message`는 `MESSAGE_BY_KIND`에 우리가 쓴 한국어 문구이고 자격증명·업스트림 원문이 제거된 상태라 그대로 전달해도 안전하다(`backend/src/clients/external-service.filter.ts` 주석). |
| D-4 | **UI 처리는 최소 침습.** 실패한 사용자 메시지는 목록에 **그대로 남기고**, 에러 문구를 assistant 말풍선으로 덧붙인다. `finally`의 `setIsLoading(false)`는 이미 있으므로 스피너 무한 회전은 발생하지 않는다 — `catch`만 추가한다. | 사용자 메시지를 되돌리려면 id로 제거해야 하고(상태 조작 증가), 무엇을 보냈는지가 화면에서 사라진다. 남겨두면 입력창이 다시 열리므로(로딩 해제) 같은 내용을 다시 타이핑해 재전송할 수 있다. 재전송 버튼·에러 배너는 컴포넌트 추가가 필요해 이번 범위 밖. |
| D-5 | **`fetch`는 `itinerary.ts` 안에 직접 넣는다.** `client.ts`/`http.ts`를 새로 만들지 않는다. | 호출부가 `plan/page.tsx` 하나, 엔드포인트가 `POST /chat` 하나다. 공용 HTTP 계층은 두 번째 엔드포인트가 생길 때 만든다 — 지금 만들면 추상화 한 겹이 사용처 없이 남는다. |
| D-6 | **테스트는 `sendMessage` 순수 로직만.** `src/lib/api/itinerary.test.ts`에 vitest 단위 테스트를 쓰고, `page.tsx`의 UI는 **테스트 없이 수동 확인**한다. | `@testing-library/react`·`jsdom`이 **설치돼 있지 않다**(`package.json` devDependencies 실측: `vitest`뿐). 게다가 vitest는 `src/**/*.test.ts`만 수집하고 `environment: "node"`라 `.tsx` 테스트는 조용히 건너뛴다(`frontend-vitest-skips-tsx.md`). 컴포넌트 테스트 셋업 도입은 의존성 추가 + `vitest.config.ts` 변경이라 이번 요구사항보다 크다. `page.tsx` 변경은 `catch` 블록 하나로 최소화하고 Task 4에서 수동 확인 절차를 밟는다. |
| D-7 | fetch 모킹은 **`vi.stubGlobal("fetch", vi.fn<typeof fetch>()...)`**, env 모킹은 **`vi.stubEnv` / `vi.unstubAllEnvs`**. | 실측: vitest 4.1.10에서 둘 다 동작하고 `vi.fn<typeof fetch>()`가 `mock.calls[0]`을 `[input, init?]`로 타입 좁혀준다 — 캐스팅 없이 필드별 단정이 된다. 전역 `Response` 생성자도 `environment: "node"`에서 쓸 수 있다(Node 20 undici). |

### 범위 밖

- `GET /itinerary` 엔드포인트 신설(backend 작업)
- `getItinerary()`의 실제 API 교체
- 컴포넌트/hook 테스트 셋업(`jsdom`, `@testing-library/react`) 도입
- 재시도·타임아웃·AbortController, 에러 배너·재전송 버튼 UI
- `src/lib/mock/`의 `generateAssistantReply` 제거 (자체 테스트가 있고 참조 제거만으로 충분)

---

## Global Constraints

- **작업 디렉터리는 `frontend/`.** 모든 명령을 여기서 실행한다. 루트에 package.json이 없다.
- **선행 조건: `npm install`을 먼저 돌린다.** 실측 시점에 `frontend/node_modules`에 **`vitest`가 없었다**(devDependencies에는 선언돼 있다). 이 상태에서는 `npx tsc --noEmit`이 `TS2307: Cannot find module 'vitest'`로, `npm test`가 vitest 미존재로 실패한다. `npm install` 후 `package-lock.json`은 변하지 않았다(`git status` 실측) — **lock 파일을 커밋에 넣지 않는다.**
- 검증 명령 (태스크마다 Step 4에서 이 세 개를 돌린다):
  - 테스트: `npm test`
  - 타입 검사: `npx tsc --noEmit` (`npm run typecheck` 스크립트는 없다)
  - 린트: `npm run lint`
- `npm run build`는 Task 4에서만 돌린다(`.tsx` 변경이 있는 태스크).
- **주석·에러 메시지·커밋 메시지는 한국어.** 커밋은 `{type}(frontend): {제목}` + 본문에 **왜**.
- 경로 별칭 `@/*` → `./src/*`. `src/lib/api/` 안에서는 기존 파일 관용에 따라 상대 경로(`../types`)를 쓴다.
- **`frontend/AGENTS.md` 규약**: 이 Next.js는 학습 데이터와 다를 수 있다. env 관련 판단은 `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`를 읽고 확인했다(D-2). 그 밖의 Next API를 새로 쓰게 되면 같은 방식으로 문서를 먼저 읽는다.
- **`process.env.NEXT_PUBLIC_API_BASE_URL`은 구조분해·동적 접근 없이 직접 참조한다.** `const env = process.env; env.NEXT_PUBLIC_...`이나 `process.env[name]`은 **인라인되지 않는다**(위 문서 `:184-192`). 이건 문법 취향이 아니라 동작 조건이다.
- eslint는 `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`다 — **backend와 달리 `recommendedTypeChecked`가 아니다.** `no-unsafe-assignment`류가 없어서 backend에서 막혔던 관용구가 여기서는 통과한다. 그래도 이 계획의 테스트 코드는 캐스팅 없이 타입이 서는 형태로 이미 실측했으니 형태를 유지한다.
- **절대 하지 않을 것**
  - `client.ts`/`http.ts` 같은 공용 HTTP 계층을 새로 만들지 않는다(D-5).
  - base URL에 기본값을 넣지 않는다(D-2). `?? "http://localhost:3001"`은 이 계획의 반대 방향이다.
  - `vitest.config.ts`의 `include`·`environment`를 건드리지 않는다(D-6).
  - `backend/` 아래 파일을 수정하지 않는다.
  - `getItinerary()`의 mock 호출을 제거하지 않는다(D-1).
- **기준은 계획 블록이 아니라 커밋된 코드다.** 아래 코드 블록은 2026-07-28에 실제로 `frontend/`에서 만들어 `npm test`·`npx tsc --noEmit`·`npm run lint`(Task 4는 `npm run build`까지) 통과를 확인한 뒤 원복한 스냅샷이다. 파일 현재 상태와 다르면 계획이 낡은 것이니 덮기 전에 대조한다.

### 실측 범위

| 항목 | 실측 여부 |
|---|---|
| Task 1~4 전 코드 블록의 `npm test` 통과 | 실측 (태스크 경계마다 따로 — Task 2 시점 테스트 파일 상태로 lint까지 돌렸다) |
| `npx tsc --noEmit` | 실측 (Task 2·3·4 각 경계) |
| `npm run lint` | 실측 (Task 2·3·4 각 경계) |
| `npm run build` | 실측 (Task 4 경계, **env 미설정 상태에서 통과**) |
| 각 Step 2의 RED 메시지 | 실측 (Task 2는 4건 실패, Task 3은 **3건 실패 / 1건은 RED에서 이미 통과** — 본문 참조) |
| 뮤테이션 3건의 실패 건수 | 실측 (Task 3 Step 6) |
| 브라우저에서의 실제 왕복(backend 기동 + CORS) | **미실측** — Task 4 수동 확인 절차에서 처음 확인한다 |

---

## 태스크

### Task 1: `NEXT_PUBLIC_API_BASE_URL`을 `.env.example`에 문서화한다

코드보다 먼저 키를 저장소에 남긴다. `frontend/`에는 `.env.example`이 아예 없고 `.gitignore`가 `.env*`를 통째로 무시하므로, 예시 파일을 만들어도 **커밋되지 않는다** — `core`/`backend`처럼 `!.env.example` 예외를 함께 넣어야 한다. 이 태스크는 코드 변경이 없어 테스트도 없다.

**Files:**
- Create: `frontend/.env.example`
- Modify: `frontend/.gitignore`

**Interfaces:**
- Consumes: 없음
- Produces: env 키 이름 `NEXT_PUBLIC_API_BASE_URL` (Task 2가 읽는다)

- [x] **Step 1: `frontend/.env.example` 생성**

파일 전문:

```
# 백엔드 API origin. 브라우저에서 fetch하므로 NEXT_PUBLIC_ 접두사가 필수다
# (접두사가 없으면 클라이언트 번들에 값이 들어가지 않는다).
# 빌드 시점에 인라인되므로 배포 환경마다 build 전에 설정해야 한다.
# 기본값을 코드에 두지 않는다 — 값이 없으면 sendMessage가 즉시 던진다.
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

- [x] **Step 2: `.gitignore`에 예외 추가**

`frontend/.gitignore`의 아래 두 줄을

```
# env files (can opt-in for committing if needed)
.env*
```

이렇게 교체(한 줄 추가):

```
# env files (can opt-in for committing if needed)
.env*
!.env.example
```

- [x] **Step 3: 무시되지 않는지 확인**

```
git status --short frontend/
```

Expected: `?? frontend/.env.example`가 **보인다**. 안 보이면 예외 줄이 안 먹은 것이다(실측: 이 형태로 `??`로 나왔다).

- [x] **Step 4: 로컬 개발용 값 준비 (커밋하지 않는다)**

```bash
cp frontend/.env.example frontend/.env.local
```

`.env.local`은 `.gitignore` 대상이며 **vitest는 이 파일을 읽지 않는다**(테스트는 `vi.stubEnv`로 값을 주입한다). 따라서 `local-env-file-masks-required-key-wiring.md`의 마스킹 문제는 이 워크스페이스 테스트에는 없다 — Task 2의 "env 없으면 던진다" 테스트가 로컬 파일 존재와 무관하게 성립한다.

- [x] **Step 5: 기존 게이트가 그대로인지 확인**

```
npm test
npx tsc --noEmit
npm run lint
```

Expected: PASS — `Tests 5 passed (5)` (아직 새 테스트가 없다)

- [x] **Step 6: 커밋**

```bash
git add frontend/.env.example frontend/.gitignore
git commit -m "docs(frontend): NEXT_PUBLIC_API_BASE_URL 키를 .env.example에 문서화한다

브라우저에서 fetch하므로 NEXT_PUBLIC_ 접두사가 필수고, 값은 빌드 시점에
인라인된다. frontend의 .gitignore는 .env*를 통째로 무시하고 있어서 예시
파일이 커밋되지 않았다 — core/backend와 같은 !.env.example 예외를 넣는다."
```

---

### Task 2: `sendMessage`를 `POST /chat` 호출로 교체한다 (성공 경로 + base URL 필수화)

mock `generateAssistantReply` 호출을 실제 fetch로 바꾼다. 이 태스크는 **성공 경로와 env 계약만** 고정한다 — 에러 응답은 일단 폴백 문구 하나로 던지고, shape별 구분은 Task 3에서 붙인다. 200이 아닐 때 응답 본문을 결과로 쓰지 않는다는 것만 여기서 못 박는다(그게 없으면 500 본문이 `ScenarioResult`로 파싱돼 `reply`가 `undefined`인 말풍선이 뜬다).

**Files:**
- Modify: `frontend/src/lib/api/itinerary.ts`
- Create: `frontend/src/lib/api/itinerary.test.ts`

**Interfaces:**
- Consumes: Task 1의 `NEXT_PUBLIC_API_BASE_URL` 키 · backend `ChatRequestDto`(`{ message: string, itinerary: ItineraryDto }`) · `ChatResponseDto`(`{ reply: string, itinerary: ItineraryDto }`)
- Produces: `sendMessage(message: string, currentItinerary: Itinerary): Promise<ScenarioResult>` — 시그니처는 **바뀌지 않는다**(호출부 `plan/page.tsx` 무수정) · `getItinerary(): Promise<Itinerary>` 유지

- [x] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/api/itinerary.test.ts` **신규 파일** 전문:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultItinerary } from "../mock/itineraries";
import { sendMessage } from "./itinerary";

const BASE_URL = "http://localhost:3001";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sendMessage", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", BASE_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("메시지와 현재 일정을 POST /chat 본문에 함께 싣는다", async () => {
    const current = getDefaultItinerary();
    const fetchMock = stubFetch(
      jsonResponse(200, { reply: "네", itinerary: current })
    );

    await sendMessage("제주 2박3일", current);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3001/chat");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      message: "제주 2박3일",
      itinerary: current,
    });
  });

  it("200 응답의 reply와 itinerary를 그대로 돌려준다", async () => {
    const current = getDefaultItinerary();
    const next = { ...current, summary: { ...current.summary, destination: "제주" } };
    stubFetch(jsonResponse(200, { reply: "제주 일정이에요", itinerary: next }));

    const result = await sendMessage("제주", current);

    expect(result.reply).toBe("제주 일정이에요");
    expect(result.itinerary).toEqual(next);
  });

  it("NEXT_PUBLIC_API_BASE_URL이 없으면 fetch를 부르지 않고 던진다", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", undefined);
    const fetchMock = stubFetch(jsonResponse(200, { reply: "네", itinerary: null }));

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      /NEXT_PUBLIC_API_BASE_URL/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200이 아니면 응답 본문을 결과로 쓰지 않고 던진다", async () => {
    stubFetch(jsonResponse(500, { reply: "이건 쓰이면 안 된다", itinerary: null }));

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(Error);
  });
});
```

세 번째 테스트의 `expect(fetchMock).not.toHaveBeenCalled()`는 **보조 가드다** — 부정 단정은 아무 일도 하지 않는 구현에서도 만족되므로 방어선 개수에 세지 않는다(`negative-assertions-resist-mutation.md`). 실효는 같은 테스트의 `rejects.toThrow(/NEXT_PUBLIC_API_BASE_URL/)`(긍정 단정)이 담당하고, Step 6 뮤테이션 M3에서 그것이 실제로 죽는 것을 확인한다.

- [x] **Step 2: 실패를 확인**

```
npm test
```

Expected: FAIL — `src/lib/api/itinerary.test.ts (4 tests | 4 failed)`, 실측 메시지 4건:
- `TypeError: undefined is not iterable (cannot read property Symbol(Symbol.iterator))` (`fetchMock.mock.calls[0]` 구조분해 — fetch가 아예 안 불렸다)
- `AssertionError: expected '제주 2박 3일 일정을 준비했어요! …' to be '제주 일정이에요'` (mock 시나리오 응답이 온다)
- `AssertionError: promise resolved "{ …(2) }" instead of rejecting` × 2

- [x] **Step 3: 구현**

`frontend/src/lib/api/itinerary.ts` **파일 전문 교체**(현재 14줄 mock 전문. 덮기 전에 현재 파일이 그 14줄인지 대조한다):

```ts
import type { Itinerary } from "../types";
import { getDefaultItinerary } from "../mock/itineraries";
import type { ScenarioResult } from "../mock/scenarios";

/**
 * 최초 일정은 아직 mock이다. 백엔드에 대응 엔드포인트(GET /itinerary류)가 없고,
 * 만드는 것은 backend 워크스페이스 작업이라 이번 범위 밖이다.
 */
export async function getItinerary(): Promise<Itinerary> {
  return getDefaultItinerary();
}

/** 서버가 사용자에게 보여줄 문구를 주지 못했을 때 쓴다. */
const FALLBACK_ERROR_MESSAGE =
  "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.";

/**
 * 백엔드 origin. `process.env.NEXT_PUBLIC_API_BASE_URL`을 구조분해 없이 직접
 * 참조해야 Next.js가 빌드 시점에 값을 인라인한다.
 *
 * 기본값을 두지 않는 이유: `http://localhost:3001`로 조용히 폴백하면 배포 빌드에서
 * 브라우저가 사용자 PC를 향해 요청을 보내고, 설정 누락이 "연결 실패"로 위장된다.
 */
function resolveApiBaseUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL이 설정되지 않았습니다. frontend/.env.local에 백엔드 origin을 지정하세요."
    );
  }
  return baseUrl;
}

/**
 * 한 턴의 대화를 백엔드에 넘긴다. 서버는 무상태이므로 현재 일정을 매번 함께 보낸다
 * (backend/src/chat/dto/chat-request.dto.ts).
 */
export async function sendMessage(
  message: string,
  currentItinerary: Itinerary
): Promise<ScenarioResult> {
  const baseUrl = resolveApiBaseUrl();

  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, itinerary: currentItinerary }),
  });

  if (!response.ok) {
    throw new Error(FALLBACK_ERROR_MESSAGE);
  }

  return (await response.json()) as ScenarioResult;
}
```

`generateAssistantReply` import가 사라지고 `ScenarioResult`만 **타입 import**로 남는다. `ScenarioResult`를 계속 반환 타입으로 쓰는 이유: backend `ChatResponseDto`와 같은 모양이며(`{ reply, itinerary }`) 호출부 `page.tsx`가 이미 그 타입에 맞춰 있다 — 타입을 새로 만들면 호출부까지 손대야 한다.

- [x] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit
npm run lint
```

Expected: PASS — `Test Files 2 passed (2)` / `Tests 9 passed (9)` (기존 scenarios 5건 + 새 4건), tsc·lint 무출력

- [x] **Step 5: 커밋**

```bash
git add frontend/src/lib/api/itinerary.ts frontend/src/lib/api/itinerary.test.ts
git commit -m "feat(frontend): sendMessage를 실제 POST /chat 호출로 교체한다

서버가 무상태이므로 현재 일정을 매 요청에 함께 싣는다(ChatRequestDto).
base URL은 NEXT_PUBLIC_API_BASE_URL로만 받고 기본값을 두지 않는다 —
localhost로 조용히 폴백하면 배포 빌드에서 브라우저가 사용자 PC를 향하고
설정 누락이 연결 실패로 위장된다. 200이 아닌 응답의 본문은 결과로 쓰지
않는다. shape별 에러 문구는 다음 커밋에서 붙인다."
```

---

### Task 3: 에러 응답 두 shape을 사용자 문구로 매핑한다

백엔드는 성공 200 외에 **두 가지 다른 shape**을 낸다(`workspaces.md:123` 경계표). Task 2는 둘을 구분 없이 폴백 문구로 뭉갰다 — 그러면 "메시지가 1000자를 넘었다"와 "Gemini 쿼터가 터졌다"가 사용자에게 같은 말로 보인다. `message`의 타입으로 갈라 처리한다.

**Files:**
- Modify: `frontend/src/lib/api/itinerary.ts`
- Modify: `frontend/src/lib/api/itinerary.test.ts`

**Interfaces:**
- Consumes: Task 2의 `sendMessage`·`FALLBACK_ERROR_MESSAGE`
- Produces: `sendMessage`가 던지는 `Error.message`가 **사용자에게 그대로 보여도 되는 한국어 한 줄**이라는 계약 (Task 4가 이 계약에 기댄다)

- [x] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/api/itinerary.test.ts`의 `describe("sendMessage", ...)` 블록 **맨 끝**(`"200이 아니면 응답 본문을 결과로 쓰지 않고 던진다"` 테스트 다음, 닫는 `});` 앞)에 추가:

```ts
  it("ValidationPipe 400의 message 배열은 사용자에게 보여주지 않고 입력 안내로 바꾼다", async () => {
    stubFetch(
      jsonResponse(400, {
        statusCode: 400,
        message: ["message must be shorter than or equal to 1000 characters"],
        error: "Bad Request",
      })
    );

    await expect(sendMessage("긴 메시지", getDefaultItinerary())).rejects.toThrow(
      "입력을 확인해주세요. 메시지가 너무 길거나 형식이 올바르지 않습니다."
    );
  });

  it("ExternalServiceFilter 5xx의 message 문자열은 그대로 사용자에게 전달한다", async () => {
    stubFetch(
      jsonResponse(503, {
        statusCode: 503,
        error: "quota",
        message: "외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요.",
      })
    );

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      "외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요."
    );
  });

  it("에러 응답이 JSON이 아니면 폴백 문구로 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("<html>502 Bad Gateway</html>", { status: 502 })
      )
    );

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."
    );
  });

  it("fetch 자체가 실패하면(CORS·네트워크 단절) 폴백 문구로 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."
    );
  });
```

400 fixture의 `message` 문구는 backend `ChatRequestDto`의 `@MaxLength(1000)`가 실제로 만드는 class-validator 기본 문구다. 4건 중 **`"에러 응답이 JSON이 아니면"`은 Task 2 구현에서도 이미 통과한다**(Task 2가 모든 non-ok를 같은 폴백 문구로 던지므로) — 회귀 가드로 남기되 RED 개수에는 넣지 않는다.

- [x] **Step 2: 실패를 확인**

```
npm test
```

Expected: FAIL — **3건 실패 / 10건 통과** (실측). 메시지:
- `AssertionError: expected [Function] to throw error including '입력을 확인해주세요. …' but got '서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.'`
- `AssertionError: expected [Function] to throw error including '외부 서비스 사용량이 초과되었습니다. …' but got '서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.'`
- `AssertionError: expected [Function] to throw error including '서버에 연결할 수 없습니다. …' but got 'Failed to fetch'`

세 번째가 `Failed to fetch` 원문으로 뜨는 것이 Task 2 구현에 fetch 자체 실패 처리가 없다는 증거다. 이것 말고 다른 이유로 실패하면 계획을 의심한다.

- [x] **Step 3: 구현 (1/2) — 문구 상수 추가**

`itinerary.ts`의 `FALLBACK_ERROR_MESSAGE` 선언 **바로 다음**에 추가:

```ts
/**
 * ValidationPipe 400의 message는 class-validator가 만든 영문 배열이라
 * 사용자에게 그대로 보여줄 수 없다. 우리 문구로 바꿔서 내보낸다.
 */
const VALIDATION_ERROR_MESSAGE =
  "입력을 확인해주세요. 메시지가 너무 길거나 형식이 올바르지 않습니다.";
```

- [x] **Step 4: 구현 (2/2) — fetch 호출부 교체 + `readErrorMessage` 추가**

`itinerary.ts`에서 Task 2가 넣은 아래 블록을

```ts
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, itinerary: currentItinerary }),
  });

  if (!response.ok) {
    throw new Error(FALLBACK_ERROR_MESSAGE);
  }

  return (await response.json()) as ScenarioResult;
}
```

아래로 교체한다(`}`까지 포함. `readErrorMessage`와 `ErrorResponseBody`가 뒤에 붙어 파일 끝이 된다):

```ts
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, itinerary: currentItinerary }),
    });
  } catch {
    // 네트워크 단절·CORS 차단은 fetch가 TypeError로 던진다. 원문("Failed to
    // fetch")은 사용자에게 아무 정보도 주지 않으므로 우리 문구로 바꾼다.
    throw new Error(FALLBACK_ERROR_MESSAGE);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ScenarioResult;
}

/** 백엔드가 내는 두 에러 shape이 공유하는 부분만 본다. */
interface ErrorResponseBody {
  message?: unknown;
}

/**
 * 에러 응답을 사용자에게 보여줄 한 줄로 바꾼다. 두 shape을 `message`의 타입으로
 * 구분한다 — ValidationPipe 400은 `string[]`, ExternalServiceFilter의 5xx는
 * 우리가 쓴 한국어 `string`이다(backend/src/clients/external-service.filter.ts).
 */
async function readErrorMessage(response: Response): Promise<string> {
  let body: ErrorResponseBody;
  try {
    body = (await response.json()) as ErrorResponseBody;
  } catch {
    // 프록시·게이트웨이가 HTML 오류 페이지를 돌려주는 경우가 있다.
    return FALLBACK_ERROR_MESSAGE;
  }

  if (Array.isArray(body.message)) {
    return VALIDATION_ERROR_MESSAGE;
  }

  if (typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }

  return FALLBACK_ERROR_MESSAGE;
}
```

- [x] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit
npm run lint
```

Expected: PASS — `Test Files 2 passed (2)` / `Tests 13 passed (13)`

- [x] **Step 6: 뮤테이션으로 방어선을 확인**

계획이 주장하는 방어선이 실제로 있는지 본다. 각 뮤테이션 후 `npm test`, 확인하면 **즉시 원복**한다. 아래 숫자는 실측값이다 — 어긋나면 코드가 계획과 다른 것이다.

| 뮤테이션 | 실측 결과 |
|---|---|
| M1: `if (Array.isArray(body.message)) { return VALIDATION_ERROR_MESSAGE; }` 블록 삭제 | `Tests 1 failed / 12 passed` — 400 테스트가 죽는다 |
| M2: `if (!response.ok) { throw new Error(await readErrorMessage(response)); }` 블록 삭제 | `Tests 4 failed / 9 passed` |
| M3: `resolveApiBaseUrl`의 throw를 `return baseUrl ?? "http://localhost:3001";`로 (= D-2를 뒤집기) | `Tests 1 failed / 12 passed` — 죽는 것은 `rejects.toThrow(/NEXT_PUBLIC_API_BASE_URL/)`(긍정 단정)이다. 같은 테스트의 `not.toHaveBeenCalled()`는 폴백 상태에서도 fetch가 불리므로 함께 죽지만, 이 확인의 근거는 긍정 단정 쪽이다 |

원복 후 `npm test`가 다시 `13 passed`인 것을 확인하고 다음 Step으로 간다.

- [x] **Step 7: 커밋**

```bash
git add frontend/src/lib/api/itinerary.ts frontend/src/lib/api/itinerary.test.ts
git commit -m "feat(frontend): 백엔드 에러 두 shape을 message 타입으로 갈라 문구를 만든다

ValidationPipe 400은 message가 class-validator 영문 배열이라 사용자에게
보여줄 수 없어 우리 안내 문구로 바꾸고, ExternalServiceFilter의 5xx는
message가 자격증명·업스트림 원문이 제거된 한국어 문구라 그대로 전달한다.
상태코드가 아니라 message의 타입으로 구분하는 이유는 그것이 두 shape의
실제 차이이기 때문이다. JSON이 아닌 응답과 fetch 자체 실패는 폴백 문구다."
```

---

### Task 4: `handleSend` 실패 시 에러 말풍선을 띄운다

지금 `handleSend`는 `try/finally`만 있어 `sendMessage`가 던지면 **미처리 rejection이 되고 화면에는 아무 변화가 없다** — 사용자는 왜 답이 안 오는지 알 수 없다. `catch`를 붙여 Task 3이 만든 문구를 말풍선으로 보여준다. `setIsLoading(false)`는 이미 `finally`에 있으므로 스피너는 원래도 멈춘다(D-4).

**Files:**
- Modify: `frontend/src/app/plan/page.tsx`

**Interfaces:**
- Consumes: Task 3의 "던지는 `Error.message`는 사용자에게 보여도 되는 한국어 한 줄" 계약
- Produces: 없음 (UI 종단)

**테스트 없음.** `.tsx`는 vitest가 수집하지 않고(`include: ["src/**/*.test.ts"]`) `environment: "node"`라 DOM도 없다. `@testing-library/react`·`jsdom`도 미설치다(D-6). 셋업 도입은 별도 작업으로 남긴다 — 대신 이 태스크는 변경을 `catch` 블록 하나로 묶고 Step 3의 수동 확인을 밟는다.

- [x] **Step 1: 구현**

`frontend/src/app/plan/page.tsx`의 `handleSend` 안에서

```tsx
      setMessages((prev) => [...prev, assistantMessage]);
      setItinerary(result.itinerary);
      setActiveMobileTab("itinerary");
    } finally {
```

를 아래로 교체:

```tsx
      setMessages((prev) => [...prev, assistantMessage]);
      setItinerary(result.itinerary);
      setActiveMobileTab("itinerary");
    } catch (error) {
      // 실패한 사용자 메시지는 목록에 그대로 둔다 — 되돌리면 사용자가 무엇을
      // 보냈는지 사라진다. 안내는 말풍선으로 덧붙이고 입력창은 finally에서
      // 다시 열리므로 그대로 다시 보낼 수 있다.
      const errorMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content:
          error instanceof Error
            ? error.message
            : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
```

`ChatMessage` 타입은 파일 상단에서 이미 import돼 있다(`import type { ChatMessage, Itinerary } from "@/lib/types";`) — import를 추가하지 않는다.

- [x] **Step 2: 게이트 확인**

```
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: PASS — `Tests 13 passed (13)`, tsc·lint 무출력, build는 `✓ Compiled successfully` + `/plan`이 `○ (Static)`. **`npm run build`는 `NEXT_PUBLIC_API_BASE_URL`이 없어도 통과한다**(실측) — base URL 확인이 호출 시점이라 프리렌더를 깨지 않는다.

- [x] **Step 3: 수동 확인 (테스트 없는 구간의 유일한 증거) — 부분 실측**

> **[구현 이탈 — 2026-07-28]** implementer 에이전트에는 브라우저 조작 도구가 없다. 대신 backend를 `npm run start:dev`로 띄우고 `curl -i -X POST http://localhost:3001/chat -H "Origin: http://localhost:3000"`로 확인한 것:
> - CORS: 응답에 `Access-Control-Allow-Origin: http://localhost:3000` — origin 허용 확인.
> - 잘못된 필드(`duration`/`travelers` 누락)로 400을 유도해 응답 본문이 `{"message":["...must be a string", ...], "error":"Bad Request","statusCode":400}` 형태임을 확인 — Task 3의 `Array.isArray(body.message)` 분기가 실제 백엔드 응답과 일치.
> - **200 성공 왕복(Gemini/Qdrant/Postgres 경유)은 시도하지 않았다** — `postgres-is-office-network-only.md`(사내망 전용, 외부망에서는 타임아웃) 때문에 실제 채팅 처리 호출은 무한 대기 위험이 있어 생략.
> - **케이스 1(정상 왕복 UI)·케이스 3(env 미설정 시 말풍선 문구)은 브라우저가 필요해 미실측으로 남는다.** 사용자가 직접 브라우저로 확인해야 한다.
> 확인 후 backend 프로세스는 종료했다(`lsof -i :3001` 포트 비어있음 확인).

터미널 3개로 확인하고 **결과를 저널에 적는다.** 세 케이스 모두 "스피너가 멈추고 말풍선이 뜬다"를 본다.

1. **정상 왕복**: `backend/`에서 `npm run start:dev`(3001), `frontend/`에서 `npm run dev`(3000) → `http://localhost:3000/plan`에서 "제주 2박3일" 전송 → 답변 말풍선 + 오른쪽 일정 갱신. 브라우저 네트워크 탭에서 `POST http://localhost:3001/chat`이 200인지 확인한다.
2. **백엔드 미기동**: backend를 끄고 전송 → `서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.` 말풍선. (CORS 차단도 같은 경로다 — `backend/.env`의 `CORS_ORIGIN`이 `http://localhost:3000`인지 함께 확인한다.)
3. **env 미설정**: `frontend/.env.local`을 임시로 옮기고 `npm run dev` 재시작 → 전송 시 `NEXT_PUBLIC_API_BASE_URL이 설정되지 않았습니다. …` 말풍선. 확인 후 되돌린다. 이 케이스가 D-2의 "조용한 폴백 금지"가 실제로 눈에 보이는지 확인하는 유일한 지점이다.

1000자 초과(케이스 4)는 입력창에 1001자를 붙여넣어 확인할 수 있으면 하고, 번거로우면 건너뛴다 — 단위 테스트가 그 shape을 이미 고정한다.

- [x] **Step 4: 커밋**

```bash
git add frontend/src/app/plan/page.tsx
git commit -m "fix(frontend): 채팅 전송이 실패하면 에러 말풍선으로 알린다

지금은 try/finally만 있어서 sendMessage가 던지면 미처리 rejection이 되고
화면에는 아무 변화가 없었다. 실패한 사용자 메시지는 목록에 그대로 두고
안내만 덧붙인다 — 되돌리면 무엇을 보냈는지 사라지고, 로딩이 풀리므로
같은 내용을 다시 보낼 수 있다. .tsx는 vitest가 수집하지 않아 이 변경은
수동 확인으로만 검증했다(저널 참조)."
```

---

## 리뷰 묶음

| 묶음 | 태스크 | 논리 단위 |
|---|---|---|
| A | 1~2 | env 배선 + 성공 경로 교체 |
| B | 3~4 | 에러 계약 + UI 종단 |

review는 기본 생략이다(`tb-harness`). 돌린다면 묶음 B가 더 중요하다 — 에러 분류가 `failure-attribution.md`·`test-asymmetry.md`가 반복적으로 잡아온 지점이고, Task 4는 자동 테스트가 없다.

---

## 열린 항목 (사용자 확인이 필요할 수 있음)

1. **`frontend/node_modules`에 `vitest`가 없었다.** `npm install`이 선행 조건이며 `package-lock.json`은 변하지 않았으므로 커밋 대상이 아니다. 이 계획은 그 전제로 쓰였다.
2. **`getItinerary()`는 mock으로 남는다**(D-1). 첫 화면 일정이 항상 서울 기본값이라는 뜻이다. 실제 API로 바꾸려면 backend에 엔드포인트를 만드는 별도 실행이 필요하다.
3. **`.env.local`은 커밋되지 않는다.** 다른 개발자·CI·배포 환경에서는 `NEXT_PUBLIC_API_BASE_URL`을 **빌드 전에** 설정해야 하고, 안 하면 채팅 전송 시 에러 말풍선이 뜬다(빌드는 통과한다). 빌드 시점에 키를 강제하고 싶다면 `next.config.ts`나 CI 스크립트에서 검사하는 태스크를 추가해야 하는데, 배포 파이프라인이 아직 없어 이번 범위에서 뺐다.
