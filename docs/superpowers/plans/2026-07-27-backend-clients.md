# backend 외부 서비스 클라이언트(Gemini · TEI · Qdrant) 구현 계획

> **For agentic workers:** 이 계획은 `tb-harness`의 work 단계가 태스크 묶음 단위로 실행한다.
> 각 Step의 체크박스(`- [ ]`)를 완료할 때마다 갱신한다.

**Goal:** backend가 Gemini로 텍스트를 생성하고, TEI로 질의를 임베딩하고, Qdrant에서 벡터 검색을 할 수 있게 된다 — 셋이 함께 들어와 검색 경로(`질의 텍스트 → 벡터 → TourSearchHit[]`)가 실제로 닫힌다.

**Architecture:** 세 클라이언트의 모든 외부 호출이 `callExternal()` 하나를 통과한다. 실패는 `ExternalServiceError { service, kind }`로 분류되고, 전역 `ExternalServiceFilter` 한 곳이 kind를 HTTP 상태로 매핑한다. **어떤 kind도 4xx가 되지 않는다.** 공통화한 것은 "클라이언트가 늘어도 자라지 않는 것"(오류 타입·호출 통로·매핑표·모듈)뿐이고, 서비스별 실패 판정·설정·전송 배선·테스트 더블은 클라이언트마다 반복한다.

**Tech Stack:** NestJS 11 (CJS) · TypeScript 5.7 · jest + ts-jest · `@google/genai@^2.13.0` · `@qdrant/js-client-rest@^1.18.0` · TEI는 SDK 없이 Node 24 전역 `fetch`

**설계 문서:** `docs/superpowers/specs/2026-07-27-backend-clients-design.md`

---

## ⚠ 실행 전 확인이 필요한 spec 미결정 3건

계획을 쓰다 드러난 것이다. 각 태스크에 **[spec 미결정 — 계획 판단]** 표시로 붙여 뒀고, 아래 판단대로 코드를 적었다. 판단이 뒤집히면 해당 태스크의 코드 블록만 바꾸면 된다 — 다른 태스크는 영향받지 않는다.

| # | 어디 | spec이 정하지 않은 것 | 이 계획의 판단 | 걸리는 태스크 |
|---|---|---|---|---|
| 1 | `call-external.ts` 로그 | spec `:347`은 "원인 메시지"를 로그하라 하고, 테스트 `:672`는 "키를 담은 오류를 주입해도 로그에 API 키가 없어야" 한다. 원인 메시지를 그대로 쓰면 두 요구가 충돌한다. 마스킹 규칙이 없다 | 원인 메시지를 **정규식 마스킹**(`AIza…` · `key=`/`api_key=`/`access_token=` 쿼리 · `Bearer …`) 후 로그. `call-external.ts` 안의 지역 함수로 두고 새 파일을 만들지 않는다 | Task 2 |
| 2 | `qdrant.errors.ts` | 파일 구조(`:625`)에는 있는데 **인터페이스 절에 시그니처가 없고 테스트 절에도 항목이 없다**(gemini·tei는 둘 다 있다). 400을 `dimension-mismatch`와 그 외로 가르는 규칙, Qdrant 429 처리, `QdrantClientTimeoutError` 판정 위치가 미정 | `classifyQdrantFailure(error: unknown)`. 400 본문에 `/dimension\|expected dim/i`면 `dimension-mismatch`, 아니면 `invalid-request`. **Qdrant 429는 판정하지 않는다**(에러 표에 행이 없다) → `upstream`. `QdrantClientTimeoutError`는 이름으로 판정해 `timeout` | Task 7 |
| 3 | `external-service.filter.ts` 본문 | 응답 shape은 `{ statusCode, error: kind, message }`로 정해졌지만(`:360`) **`message`가 무엇인지**가 없다. `ExternalServiceError.message`를 그대로 쓰면 업스트림 원문이 샐 수 있다 | **kind별 고정 한국어 문구 표**를 필터 안에 둔다. 예외 인스턴스의 message를 응답에 쓰지 않아 구조적으로 누출이 불가능해진다 | Task 3 |

추가로 **spec 내부 경미한 불일치 2건**을 계획에서 정리했다(구멍은 아니다).

- `TourSearchFilter`가 인터페이스 절에서는 `qdrant.client.ts`에(`:439`), 경계표 행에서는 `tour-content-payload.ts`에(`:576`) 놓여 있다. → **`tour-content-payload.ts`에 둔다.** 경계표와 일치하고, `qdrant.client.ts` ↔ `tour-content-payload.ts` 순환 import를 피한다.
- 파일 구조에 `clients.module.spec.ts`가 없는데 테스트 절(`:730`)에는 `clients.module` 항목이 있다. → **`clients.module.spec.ts`를 만든다.**

---

## Global Constraints

- 작업 디렉터리는 **`backend/`**. Task 13만 저장소 루트에서 실행한다. 모든 명령은 해당 디렉터리에서 실행한다 (루트에 package.json이 없다).
- 테스트 실행: `npm test` · 단건: `npm test -- src/clients/call-external.spec.ts` · e2e: `npm run test:e2e`
- 타입 검사: **`npx tsc --noEmit -p tsconfig.json`** (`npm run typecheck` 스크립트가 없다)
- 린트: `npm run lint` — **`--fix`가 붙어 있어 파일을 수정한다.** 각 태스크의 커밋 직전에 돌리고 결과를 확인한 뒤 `git add` 한다. 포맷을 손으로 맞추지 않는다.
- **테스트 파일은 소스 옆에 `*.spec.ts`로 둔다.** jest `rootDir`가 `src`다. `test/`는 e2e 전용.
- **import는 전부 상대 경로.** `tsconfig.json`에 `baseUrl`·`paths`가 없어 `@/` 별칭은 컴파일되지 않는다. backend는 CJS이므로 `.js` 확장자를 붙이지 않는다 (core 규약과 반대다).
- 주석·로그 메시지·에러 메시지·커밋 메시지는 **한국어**로 쓴다.
- **테스트는 전부 모킹이다. 실제 네트워크·DB 호출을 하지 않는다.** 모킹 경계는 SDK 모듈(`jest.mock('@google/genai')` / `jest.mock('@qdrant/js-client-rest')`)이고, **TEI만 전역 `fetch` 스텁**(`jest.spyOn(globalThis, 'fetch')`)이다. spy를 걸지 않은 테스트가 하나라도 있으면 CI에서 TEI 주소로 나간다 — `afterEach`에서 반드시 복원한다.
- 클라이언트 spec은 `ConfigModule.forRoot({ ignoreEnvFile: true, skipProcessEnv: true, load: [...] })`로 설정을 명시 주입한다. **`skipProcessEnv`까지 켜는 이유:** `ConfigService.get`의 조회 순서가 `validatedEnv → process.env → internalConfig`라 개발자 셸에 `GEMINI_MODEL`이 export돼 있으면 `load` 값이 무시된다.
- eslint가 `recommendedTypeChecked`다. `no-unsafe-assignment`·`no-unsafe-member-access`가 **error**이므로 `unknown`을 다룰 때 `as unknown` 경유 후 좁히기를 지킨다 (`no-explicit-any`만 off다).
- **절대 하지 않을 것**
  - core를 의존성으로 끌어오지 않는다 (`file:../core` 금지). core 파일을 복사해 오지도 않는다.
  - 생성자·`onModuleInit`에서 네트워크를 만지지 않는다. core의 `QdrantStore.connect()` 패턴을 가져오지 않는다.
  - 재시도·백오프·서킷 브레이커를 넣지 않는다.
  - 클라이언트 메서드가 SDK·`fetch`를 **직접** 호출하지 않는다. 반드시 `callExternal`을 통과한다.
  - Qdrant 쓰기 표면(`upsert`·`createCollection`·`delete`)을 만들지 않는다.
  - 벡터 차원(`1024`)을 코드 어디에도 적지 않는다.
  - `@Global()` 모듈·커스텀 provider 토큰·동적 모듈(`forRoot`) 패턴을 쓰지 않는다.
  - 타임아웃을 env로 열지 않는다 (상수로 둔다).
  - `core/**` · `backend/src/chat/**` · `backend/src/database/**`를 수정하지 않는다.
  - 의존성은 `@google/genai`·`@qdrant/js-client-rest` **두 개만** 추가한다. axios를 넣지 않는다.

---

### Task 1: SDK 의존성 추가 (`@google/genai` · `@qdrant/js-client-rest`)

두 클라이언트가 쓸 SDK를 core와 **같은 메이저**로 붙인다. 같은 서비스에 서로 다른 SDK 메이저를 물리면 동작 차이를 추적할 수 없다. backend는 CJS이고 core는 ESM이므로, 설치 직후 **CJS require가 실제로 되는지**부터 확인한다 — 여기서 막히면 이 계획 전체의 전제(core 재사용 대신 재구현)가 흔들린다.

**Files:**
- Modify: `backend/package.json`, `backend/package-lock.json`

**Interfaces:**
- Consumes: 없음
- Produces: `@google/genai@^2.13.0` · `@qdrant/js-client-rest@^1.18.0`

- [x] **Step 1: 실패를 확인**

```
node -e "require('@qdrant/js-client-rest'); require('@google/genai'); console.log('ok')"
```

Expected: FAIL — `Error: Cannot find module '@qdrant/js-client-rest'`

- [x] **Step 2: 설치**

```
npm install @google/genai@^2.13.0 @qdrant/js-client-rest@^1.18.0
```

`core/package.json`과 같은 범위다. 설치 후 `package.json`의 `dependencies`에 두 줄이 들어갔는지 확인한다.

- [x] **Step 3: 통과를 확인**

```
node -e "require('@qdrant/js-client-rest'); require('@google/genai'); console.log('ok')"
npm test
npx tsc --noEmit -p tsconfig.json
```

Expected: `ok` 출력. 기존 테스트(`app.controller.spec.ts` · `chat.controller.spec.ts`) 전부 PASS, 타입 검사 무오류.

`Cannot use import statement outside a module`이 나오면 즉시 멈추고 보고한다 — 두 SDK 모두 `exports`에 `require` 조건을 갖고 있으므로 이 오류는 나오지 않아야 한다.

- [x] **Step 4: 커밋**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(backend): Gemini·Qdrant SDK 추가

core와 같은 메이저(@google/genai ^2.13.0, @qdrant/js-client-rest ^1.18.0)로
맞춘다. 같은 서비스에 다른 메이저를 물리면 두 워크스페이스의 동작 차이를
SDK 탓인지 우리 코드 탓인지 가릴 수 없다. TEI는 SDK가 없어 전역 fetch를 쓰므로
의존성을 추가하지 않는다."
```

---

### Task 2: `ExternalServiceError` · `callExternal` · `classifyCommonFailure`

모든 외부 호출이 지나갈 단 하나의 통로를 만든다. 이 통로가 있어야 실패 분류·로그가 한 곳에 모이고, 나중에 차단기를 넣게 되면 넣을 자리가 이미 정해져 있다(`circuit-breaker-entry-paths.md`).

**`classifyCommonFailure`는 `cause` 체인을 펼쳐야 한다.** Node의 `fetch`는 `ECONNREFUSED`를 `TypeError: fetch failed`의 `cause`에 숨긴다. 이걸 Task 2에서 해두지 않으면 TEI를 붙일 때 이 함수를 고쳐야 하고, 그 순간 구조 검증(Task 11)이 깨진다.

**Files:**
- Create: `backend/src/clients/external-service.error.ts`
- Create: `backend/src/clients/call-external.ts`
- Test: `backend/src/clients/call-external.spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type ExternalService = 'gemini' | 'qdrant'` — **`'tei'`는 Task 11에서 더한다**
  - `type ExternalFailureKind` (9종)
  - `class ExternalServiceError { service, kind }`
  - `type FailureClassifier = (error: unknown) => ExternalFailureKind | null`
  - `classifyCommonFailure(error: unknown): ExternalFailureKind | null`
  - `callExternal<T>(service, operation, classify, fn): Promise<T>`

> **[spec 미결정 — 계획 판단 1]** 로그의 원인 메시지를 `maskSecrets()`로 마스킹한 뒤 남긴다. spec `:347`("원인 메시지를 남긴다")과 테스트 `:672`("키를 담은 오류를 주입해도 로그에 키가 없다")를 동시에 만족시키는 유일한 방법이다. 새 파일을 만들지 않고 `call-external.ts`의 비공개 함수로 둔다.

- [x] **Step 1: 실패하는 테스트 작성**

`backend/src/clients/call-external.spec.ts` 신규 파일 전문:

```ts
import { Logger } from '@nestjs/common';

import {
  callExternal,
  classifyCommonFailure,
} from './call-external';
import { ExternalServiceError } from './external-service.error';

/**
 * 외부 호출의 유일한 통로를 고정한다. 여기서 분류가 무너지면
 * 아래 세 클라이언트의 실패가 전부 upstream 한 덩어리가 된다.
 */

/** 실제 Gemini 키와 같은 형태(AIza + 35자). 로그에 이 문자열이 남으면 안 된다. */
const FAKE_API_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';

const alwaysNull = (): null => null;

describe('classifyCommonFailure', () => {
  it('AbortError를 timeout으로 판정한다', () => {
    const error = Object.assign(new Error('중단됨'), { name: 'AbortError' });
    expect(classifyCommonFailure(error)).toBe('timeout');
  });

  it('TimeoutError를 timeout으로 판정한다', () => {
    const error = Object.assign(new Error('시간 초과'), {
      name: 'TimeoutError',
    });
    expect(classifyCommonFailure(error)).toBe('timeout');
  });

  it('ECONNREFUSED를 unavailable로 판정한다', () => {
    const error = Object.assign(new Error('연결 거부'), {
      code: 'ECONNREFUSED',
    });
    expect(classifyCommonFailure(error)).toBe('unavailable');
  });

  it('ENOTFOUND를 unavailable로 판정한다', () => {
    const error = Object.assign(new Error('DNS 실패'), { code: 'ENOTFOUND' });
    expect(classifyCommonFailure(error)).toBe('unavailable');
  });

  it('cause에 숨은 ECONNREFUSED도 판정한다', () => {
    // Node의 fetch는 ECONNREFUSED를 TypeError: fetch failed의 cause에 넣는다.
    // 이 케이스가 없으면 TEI를 붙일 때 이 함수를 고쳐야 한다.
    const inner = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const outer = new TypeError('fetch failed', { cause: inner });
    expect(classifyCommonFailure(outer)).toBe('unavailable');
  });

  it('모르는 오류에는 null을 반환한다', () => {
    expect(classifyCommonFailure(new Error('그냥 오류'))).toBeNull();
  });
});

describe('callExternal', () => {
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('성공하면 값을 그대로 반환하고 감싸지 않는다', async () => {
    const value = { hits: 3 };
    await expect(
      callExternal('qdrant', 'query', alwaysNull, () => Promise.resolve(value)),
    ).resolves.toBe(value);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('실패를 ExternalServiceError로 감싸고 service·kind를 채운다', async () => {
    const failure = await callExternal('gemini', 'generateContent', alwaysNull, () =>
      Promise.reject(new Error('무슨 일인가 났다')),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExternalServiceError);
    const external = failure as ExternalServiceError;
    expect(external.service).toBe('gemini');
    expect(external.kind).toBe('upstream');
    expect(external.cause).toBeInstanceOf(Error);
  });

  it('이미 ExternalServiceError면 다시 감싸지 않는다', async () => {
    // 안쪽에서 정확히 분류한 kind가 바깥에서 upstream으로 덮이면 분류가 무의미해진다.
    const original = new ExternalServiceError(
      'gemini',
      'empty-response',
      '빈 응답',
    );
    const failure = await callExternal('gemini', 'generateContent', alwaysNull, () =>
      Promise.reject(original),
    ).catch((error: unknown) => error);

    expect(failure).toBe(original);
    expect((failure as ExternalServiceError).kind).toBe('empty-response');
  });

  it('classify가 판정하면 그 kind를 쓴다', async () => {
    const failure = await callExternal(
      'gemini',
      'generateContent',
      () => 'quota',
      () => Promise.reject(new Error('429')),
    ).catch((error: unknown) => error);

    expect((failure as ExternalServiceError).kind).toBe('quota');
  });

  it('classify가 null이면 공통 판정으로 넘어간다', async () => {
    const aborted = Object.assign(new Error('중단됨'), { name: 'AbortError' });
    const failure = await callExternal('gemini', 'generateContent', alwaysNull, () =>
      Promise.reject(aborted),
    ).catch((error: unknown) => error);

    expect((failure as ExternalServiceError).kind).toBe('timeout');
  });

  it('둘 다 판정하지 못하면 upstream이다', async () => {
    const failure = await callExternal('qdrant', 'query', alwaysNull, () =>
      Promise.reject(new Error('정체불명')),
    ).catch((error: unknown) => error);

    expect((failure as ExternalServiceError).kind).toBe('upstream');
  });

  it('quota는 warn으로, 나머지는 error로 남긴다', async () => {
    await callExternal('gemini', 'generateContent', () => 'quota', () =>
      Promise.reject(new Error('쿼터 소진')),
    ).catch(() => undefined);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();

    await callExternal('gemini', 'generateContent', () => 'auth', () =>
      Promise.reject(new Error('키 무효')),
    ).catch(() => undefined);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('로그에 service·operation·kind가 모두 들어간다', async () => {
    await callExternal('qdrant', 'query(tour_contents)', () => 'not-found', () =>
      Promise.reject(new Error('컬렉션 없음')),
    ).catch(() => undefined);

    const logged = String(errorLog.mock.calls[0][0]);
    expect(logged).toContain('qdrant');
    expect(logged).toContain('query(tour_contents)');
    expect(logged).toContain('not-found');
  });

  it('로그에 API 키 문자열이 남지 않는다', async () => {
    const leaky = new Error(
      `요청 실패: https://generativelanguage.googleapis.com/v1beta/models?key=${FAKE_API_KEY}`,
    );
    await callExternal('gemini', 'generateContent', alwaysNull, () =>
      Promise.reject(leaky),
    ).catch(() => undefined);

    const logged = String(errorLog.mock.calls[0][0]);
    expect(logged).not.toContain(FAKE_API_KEY);
    // 원인이 무엇이었는지는 남아야 한다 — 마스킹이 로그를 통째로 지우면 안 된다.
    expect(logged).toContain('요청 실패');
  });

  it('Bearer 토큰도 가린다', async () => {
    const leaky = new Error('인증 거부: Authorization: Bearer sk-live-abcdef123456');
    await callExternal('gemini', 'generateContent', alwaysNull, () =>
      Promise.reject(leaky),
    ).catch(() => undefined);

    const logged = String(errorLog.mock.calls[0][0]);
    expect(logged).not.toContain('sk-live-abcdef123456');
  });
});
```

- [x] **Step 2: 실패를 확인**

```
npm test -- src/clients/call-external.spec.ts
```

Expected: FAIL — `Cannot find module './call-external' from 'src/clients/call-external.spec.ts'`

- [x] **Step 3: 구현**

`backend/src/clients/external-service.error.ts` 신규 파일 전문:

```ts
/**
 * 외부 서비스 식별자.
 * 클라이언트를 추가할 때 이 유니온에 리터럴 한 줄을 더하는 것 외에는
 * 공통 파일(call-external.ts · external-service.filter.ts)이 바뀌지 않아야 한다.
 */
export type ExternalService = 'gemini' | 'qdrant';

/**
 * 실패의 책임 귀속을 타입으로 강제한다.
 * 우리 설정/코드 문제와 외부 서비스 사정을 같은 값으로 표현하지 않는다.
 */
export type ExternalFailureKind =
  // 우리 설정·코드의 문제 → 500
  | 'auth' // 키가 없거나 무효
  | 'not-found' // 컬렉션 이름이 틀림
  | 'dimension-mismatch' // 질의 벡터 차원이 컬렉션과 다름
  // 외부 서비스 사정 → 502/503/504
  | 'quota' // 429 / RESOURCE_EXHAUSTED
  | 'unavailable' // 연결 거부·DNS 실패
  | 'timeout'
  | 'upstream' // 5xx 및 분류되지 않은 실패
  | 'invalid-request' // 외부가 우리 요청을 400으로 거절
  | 'empty-response'; // 200인데 쓸 내용이 없음

/**
 * 외부 호출 실패. service와 kind만으로 HTTP 상태와 로그 레벨이 결정된다.
 * 서비스마다 쓰는 kind가 다른 것은 결함이 아니다 — 이 타입은 서비스별 API가 아니라
 * 책임 귀속의 어휘다.
 */
export class ExternalServiceError extends Error {
  readonly service: ExternalService;
  readonly kind: ExternalFailureKind;

  constructor(
    service: ExternalService,
    kind: ExternalFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ExternalServiceError';
    this.service = service;
    this.kind = kind;
  }
}
```

`backend/src/clients/call-external.ts` 신규 파일 전문:

```ts
import { Logger } from '@nestjs/common';

import {
  ExternalFailureKind,
  ExternalService,
  ExternalServiceError,
} from './external-service.error';

/** 서비스별 판정. 자기가 모르는 오류에는 null을 반환해 공통 판정에 넘긴다. */
export type FailureClassifier = (error: unknown) => ExternalFailureKind | null;

const logger = new Logger('ExternalService');

/** cause 체인 탐색 깊이. 순환 참조에 갇히지 않도록 상한을 둔다. */
const MAX_CAUSE_DEPTH = 5;

/**
 * cause 체인을 펼친다.
 * Node의 fetch는 ECONNREFUSED를 "TypeError: fetch failed"의 cause에 숨기므로
 * 최상위 오류만 보면 네트워크 단절을 upstream으로 오분류한다.
 */
function unwrapCauses(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** 중단·네트워크 단절처럼 모든 SDK가 같은 모양으로 내는 실패만 판정한다. */
export function classifyCommonFailure(
  error: unknown,
): ExternalFailureKind | null {
  for (const item of unwrapCauses(error)) {
    const record = item as { name?: unknown; code?: unknown };
    if (record.name === 'AbortError' || record.name === 'TimeoutError') {
      return 'timeout';
    }
    if (record.code === 'ECONNREFUSED' || record.code === 'ENOTFOUND') {
      return 'unavailable';
    }
  }
  return null;
}

/**
 * 로그에 남기기 전에 자격증명처럼 보이는 문자열을 가린다.
 * 원인 메시지를 통째로 버리면 무엇이 실패했는지가 사라지고,
 * 그대로 남기면 URL 쿼리에 실린 API 키가 로그에 박힌다.
 */
function maskSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{35}/g, 'AIza***')
    .replace(/([?&](?:key|api[_-]?key|access_token)=)[^&\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1***');
}

/** 원인 메시지. API 키와 프롬프트 전문은 여기에 담기지 않는다. */
function causeMessage(error: unknown): string {
  if (error instanceof Error) return maskSecrets(error.message);
  return maskSecrets(typeof error === 'string' ? error : String(error));
}

/**
 * 외부 SDK·fetch 호출의 유일한 통로.
 * 클라이언트 메서드가 SDK를 직접 호출하는 것을 금지한다 —
 * 진입 경로가 둘이 되면 분류도 로그도 한쪽에서만 동작한다.
 *
 * operation에는 프롬프트·질의 전문 대신 길이만 넣는다.
 */
export async function callExternal<T>(
  service: ExternalService,
  operation: string,
  classify: FailureClassifier,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // 안쪽에서 이미 정확히 분류한 kind를 바깥에서 upstream으로 덮지 않는다.
    const failure =
      error instanceof ExternalServiceError
        ? error
        : new ExternalServiceError(
            service,
            classify(error) ?? classifyCommonFailure(error) ?? 'upstream',
            `${service} ${operation} 실패`,
            { cause: error },
          );

    const detail = `${failure.service} ${operation} 실패 (${failure.kind}): ${causeMessage(
      failure.cause ?? failure,
    )}`;
    if (failure.kind === 'quota') {
      logger.warn(detail);
    } else {
      logger.error(detail);
    }
    throw failure;
  }
}
```

- [x] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부). 린트가 파일을 고쳤으면 diff를 확인한 뒤 함께 커밋한다.

- [x] **Step 5: 커밋**

```bash
git add backend/src/clients/external-service.error.ts backend/src/clients/call-external.ts backend/src/clients/call-external.spec.ts
git commit -m "feat(backend): 외부 호출 통로 callExternal과 ExternalServiceError

실패의 책임 귀속(우리 설정 / 외부 사정 / 데이터)을 kind 타입으로 강제한다.
호출 통로를 하나로 묶어야 분류와 로그가 한 곳에 모이고, 나중에 차단기를 넣게
되면 넣을 자리가 이미 정해진다.

classifyCommonFailure가 cause 체인을 펼치는 이유는 Node의 fetch가 ECONNREFUSED를
TypeError: fetch failed 안에 숨기기 때문이다. 최상위만 보면 네트워크 단절이
upstream으로 오분류되고, SDK 없는 클라이언트를 붙일 때 이 함수를 고쳐야 한다.

로그의 원인 메시지를 마스킹하는 것은 설계 문서가 정하지 않은 판단이다 —
'원인 메시지를 남긴다'와 'API 키가 로그에 없다'를 동시에 만족시키려면 필요하다."
```

---

### Task 3: `ExternalServiceFilter` — kind → HTTP 매핑 한 곳

클라이언트가 늘어도 매핑표는 하나여야 한다. 클라이언트마다 매핑하면 같은 429가 서비스별로 다른 상태코드가 된다. 만들자마자 `main.ts`에 배선한다 — 붙이지 않은 필터는 아무 데서도 잡지 않는다.

**Files:**
- Create: `backend/src/clients/external-service.filter.ts`
- Modify: `backend/src/main.ts`
- Test: `backend/src/clients/external-service.filter.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `ExternalServiceError` · `ExternalFailureKind`
- Produces: `class ExternalServiceFilter implements ExceptionFilter`

> **[spec 미결정 — 계획 판단 3]** 응답 본문의 `message`는 **kind별 고정 한국어 문구**다. 예외 인스턴스의 `message`를 응답에 쓰지 않으므로 업스트림 원문·자격증명이 구조적으로 새어 나갈 수 없다. 상세는 서버 로그에만 있다.

- [x] **Step 1: 실패하는 테스트 작성**

`backend/src/clients/external-service.filter.spec.ts` 신규 파일 전문:

```ts
import { ArgumentsHost } from '@nestjs/common';

import { ExternalServiceError } from './external-service.error';
import type { ExternalFailureKind } from './external-service.error';
import { ExternalServiceFilter } from './external-service.filter';

/**
 * kind → HTTP 상태를 한 곳에 고정한다.
 * 어떤 kind도 4xx가 되지 않는다 — 외부 서비스의 실패를 사용자 입력 탓으로 돌리면
 * 프론트엔드가 "입력을 고치세요"라고 안내하고 사용자는 고칠 게 없는 입력을 고치려 든다.
 */

function createHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, setHeader }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json, setHeader };
}

describe('ExternalServiceFilter', () => {
  const filter = new ExternalServiceFilter();

  const cases: Array<[ExternalFailureKind, number]> = [
    ['auth', 500],
    ['not-found', 500],
    ['dimension-mismatch', 500],
    ['quota', 503],
    ['unavailable', 503],
    ['timeout', 504],
    ['upstream', 502],
    ['invalid-request', 502],
    ['empty-response', 502],
  ];

  it.each(cases)('%s는 %i로 매핑된다', (kind, expected) => {
    const { host, status, json } = createHost();
    filter.catch(new ExternalServiceError('gemini', kind, '실패'), host);

    expect(status).toHaveBeenCalledWith(expected);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: expected, error: kind }),
    );
  });

  it('quota에는 Retry-After가 붙는다', () => {
    const { host, setHeader } = createHost();
    filter.catch(new ExternalServiceError('gemini', 'quota', '쿼터'), host);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', 60);
  });

  it('quota가 아니면 Retry-After가 붙지 않는다', () => {
    // 만료된 키는 기다린다고 낫지 않는다. 503과 Retry-After는 "나중에 다시"라는
    // 약속이므로 auth에 붙이면 거짓말이 된다.
    const { host, setHeader } = createHost();
    filter.catch(new ExternalServiceError('gemini', 'auth', '키 무효'), host);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('응답 본문에 업스트림 원문과 자격증명이 담기지 않는다', () => {
    const { host, json } = createHost();
    const cause = new Error('key=AIzaSyA1234567890abcdefghijklmnopqrstuv 무효');
    filter.catch(
      new ExternalServiceError(
        'gemini',
        'auth',
        'gemini generateContent 실패: key=AIzaSyA1234567890abcdefghijklmnopqrstuv',
        { cause },
      ),
      host,
    );

    const body = JSON.stringify(json.mock.calls[0][0]);
    expect(body).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(body).not.toContain('generateContent');
  });

  it('본문 shape은 statusCode·error·message 세 키다', () => {
    const { host, json } = createHost();
    filter.catch(new ExternalServiceError('qdrant', 'timeout', '느림'), host);

    expect(Object.keys(json.mock.calls[0][0] as object).sort()).toEqual([
      'error',
      'message',
      'statusCode',
    ]);
  });
});
```

- [x] **Step 2: 실패를 확인**

```
npm test -- src/clients/external-service.filter.spec.ts
```

Expected: FAIL — `Cannot find module './external-service.filter' from 'src/clients/external-service.filter.spec.ts'`

- [x] **Step 3: 구현**

`backend/src/clients/external-service.filter.ts` 신규 파일 전문:

```ts
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import {
  ExternalFailureKind,
  ExternalServiceError,
} from './external-service.error';

/**
 * kind → HTTP 상태. 어떤 kind도 4xx가 되지 않는다.
 * 우리 설정·코드의 문제는 500, 외부 서비스 사정은 502/503/504다.
 */
const STATUS_BY_KIND: Record<ExternalFailureKind, number> = {
  auth: 500,
  'not-found': 500,
  'dimension-mismatch': 500,
  quota: 503,
  unavailable: 503,
  timeout: 504,
  upstream: 502,
  'invalid-request': 502,
  'empty-response': 502,
};

/**
 * 응답 본문 문구. 예외 인스턴스의 message를 쓰지 않는 이유는
 * 업스트림 원문과 자격증명이 그 안에 있을 수 있기 때문이다.
 * 상세는 서버 로그에만 남는다.
 */
const MESSAGE_BY_KIND: Record<ExternalFailureKind, string> = {
  auth: '외부 서비스 인증에 실패했습니다.',
  'not-found': '외부 서비스에서 대상을 찾을 수 없습니다.',
  'dimension-mismatch': '질의 벡터 차원이 컬렉션과 일치하지 않습니다.',
  quota: '외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요.',
  unavailable: '외부 서비스에 연결할 수 없습니다.',
  timeout: '외부 서비스가 시간 안에 응답하지 않았습니다.',
  upstream: '외부 서비스에서 오류가 발생했습니다.',
  'invalid-request': '외부 서비스가 요청을 거절했습니다.',
  'empty-response': '외부 서비스가 빈 응답을 반환했습니다.',
};

/** 고정값이다. Gemini 오류 상세의 retryDelay를 읽어 반영하는 것은 범위 밖이다. */
const RETRY_AFTER_SECONDS = 60;

@Catch(ExternalServiceError)
export class ExternalServiceFilter implements ExceptionFilter {
  catch(exception: ExternalServiceError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const statusCode = STATUS_BY_KIND[exception.kind];

    if (exception.kind === 'quota') {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }

    response.status(statusCode).json({
      statusCode,
      error: exception.kind,
      message: MESSAGE_BY_KIND[exception.kind],
    });
  }
}
```

`backend/src/main.ts` 교체 후 전문:

```ts
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExternalServiceFilter } from './clients/external-service.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      // DTO에 없는 속성은 조용히 제거한다. forbidNonWhitelisted는 켜지 않는다 —
      // 프론트엔드가 필드를 하나 추가했을 때 400으로 깨지는 편보다 무시하는 편이 낫다.
      whitelist: true,
      // 평문 JSON을 DTO 인스턴스로 변환한다. @Type 기반 중첩 검증에 필요하다.
      transform: true,
    }),
  );
  // 외부 서비스 실패의 HTTP 매핑은 여기 한 곳뿐이다.
  app.useGlobalFilters(new ExternalServiceFilter());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

- [x] **Step 4: 통과를 확인**

```
npm test
npm run test:e2e
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS 전부. e2e도 그대로 통과한다 (`ConfigModule.forRoot`는 아직 없다).

- [x] **Step 5: 커밋**

```bash
git add backend/src/clients/external-service.filter.ts backend/src/clients/external-service.filter.spec.ts backend/src/main.ts
git commit -m "feat(backend): kind→HTTP 매핑을 전역 필터 한 곳으로

클라이언트마다 매핑하면 같은 429가 서비스별로 다른 상태코드가 된다.
auth를 503이 아니라 500으로 보내는 것이 핵심이다 — 만료된 키는 기다린다고
낫지 않으므로 503은 '나중에 다시'라는 거짓말이 된다.

응답 본문 문구를 kind별 고정 문자열로 둔 것은 설계 문서가 정하지 않은 판단이다.
예외의 message를 그대로 쓰면 업스트림 원문이 사용자에게 새어 나간다."
```

---

### Task 4: `classifyGeminiFailure` — Gemini 실패 판정 (순수 함수)

429·401 판별은 SDK마다 다르므로 공통 함수에 넣지 않는다. 넣는 순간 `if (service === 'gemini')`가 생기고 클라이언트가 늘 때마다 그 함수가 부푼다.

**Files:**
- Create: `backend/src/clients/gemini/gemini.errors.ts`
- Test: `backend/src/clients/gemini/gemini.errors.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `ExternalFailureKind`
- Produces: `classifyGeminiFailure(error: unknown): ExternalFailureKind | null`

`@google/genai@2.13.0`의 `ApiError`는 `status: number`를 갖는다 (`dist/genai.d.ts:475-479`).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/clients/gemini/gemini.errors.spec.ts` 신규 파일 전문:

```ts
import { classifyGeminiFailure } from './gemini.errors';

/**
 * 에러 처리 표의 Gemini 행마다 판정 1건씩.
 * 마지막 케이스(모르는 오류 → null)가 공통 판정으로 넘어가는 경로를 지킨다.
 */

function apiError(status: number, message = '오류'): Error {
  return Object.assign(new Error(message), { status });
}

describe('classifyGeminiFailure', () => {
  it('429는 quota다', () => {
    expect(classifyGeminiFailure(apiError(429))).toBe('quota');
  });

  it('RESOURCE_EXHAUSTED 메시지도 quota다', () => {
    expect(
      classifyGeminiFailure(new Error('RESOURCE_EXHAUSTED: 할당량 초과')),
    ).toBe('quota');
  });

  it('401은 auth다', () => {
    expect(classifyGeminiFailure(apiError(401))).toBe('auth');
  });

  it('403은 auth다', () => {
    expect(classifyGeminiFailure(apiError(403))).toBe('auth');
  });

  it('API key 메시지도 auth다', () => {
    expect(classifyGeminiFailure(new Error('API key not valid'))).toBe('auth');
  });

  it('400은 invalid-request다', () => {
    expect(classifyGeminiFailure(apiError(400))).toBe('invalid-request');
  });

  it('INVALID_ARGUMENT 메시지도 invalid-request다', () => {
    expect(classifyGeminiFailure(new Error('INVALID_ARGUMENT: 잘못된 모델'))).toBe(
      'invalid-request',
    );
  });

  it('500은 upstream이다', () => {
    expect(classifyGeminiFailure(apiError(500))).toBe('upstream');
  });

  it('503도 upstream이다', () => {
    expect(classifyGeminiFailure(apiError(503))).toBe('upstream');
  });

  it('모르는 오류에는 null을 반환한다', () => {
    // 이 케이스가 없으면 공통 판정으로 넘어가는 경로가 죽어도 아무도 모른다.
    expect(classifyGeminiFailure(new Error('그냥 오류'))).toBeNull();
    expect(classifyGeminiFailure('문자열')).toBeNull();
    expect(classifyGeminiFailure(null)).toBeNull();
  });

  it('AbortError를 자기 것으로 판정하지 않는다', () => {
    // 중단은 공통 판정의 몫이다. 여기서 잡으면 같은 실패가 두 곳에서 분류된다.
    const aborted = Object.assign(new Error('중단됨'), { name: 'AbortError' });
    expect(classifyGeminiFailure(aborted)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- src/clients/gemini/gemini.errors.spec.ts
```

Expected: FAIL — `Cannot find module './gemini.errors' from 'src/clients/gemini/gemini.errors.spec.ts'`

- [ ] **Step 3: 구현**

`backend/src/clients/gemini/gemini.errors.ts` 신규 파일 전문:

```ts
import { ExternalFailureKind } from '../external-service.error';

/** @google/genai의 ApiError는 status를, 일부 오류는 code에 숫자를 담는다. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { status?: unknown; code?: unknown };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.code === 'number') return record.code;
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * Gemini SDK 오류를 kind로 판정한다. 모르는 오류에는 null을 반환해 공통 판정에 넘긴다.
 *
 * 429 판정은 core의 isRateLimited(core/src/services/enricher.ts:84-89)와 같은 규칙이다.
 * core가 그 함수에 붙여 놓은 경고도 그대로 유효하다 — 모델 출력 원문을 담은 우리 쪽
 * 오류에 이 정규식을 적용하면 안 된다. 관광지 설명의 "1429년"이 쿼터 초과로 오분류된다.
 * 이 함수는 callExternal이 SDK 호출을 감싼 자리에서만 불리므로 구조적으로 차단된다.
 */
export function classifyGeminiFailure(
  error: unknown,
): ExternalFailureKind | null {
  const status = statusOf(error);
  const message = messageOf(error);

  if (status === 429 || /429|rate limit|RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return 'quota';
  }
  if (
    status === 401 ||
    status === 403 ||
    /API key|PERMISSION_DENIED/i.test(message)
  ) {
    return 'auth';
  }
  if (status === 400 || /INVALID_ARGUMENT/i.test(message)) {
    return 'invalid-request';
  }
  if (status !== null && status >= 500 && status <= 599) {
    return 'upstream';
  }
  return null;
}
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/src/clients/gemini/gemini.errors.ts backend/src/clients/gemini/gemini.errors.spec.ts
git commit -m "feat(backend): Gemini 실패 판정 순수 함수

429·401 판별 방식은 SDK마다 다르다. 공통 판정 함수에 넣으면
if (service === 'gemini')가 생기고 클라이언트가 늘 때마다 그 함수가 부푼다.

정규식이 core의 isRateLimited와 같은 규칙인 것은 의도다. 다만 이 함수는
callExternal이 SDK 호출을 감싼 자리에서만 불린다 — 모델 출력 원문에 적용되면
'1429년'이 쿼터 초과가 된다."
```

---

### Task 5: `GeminiClient` — 텍스트 생성

첫 번째 클라이언트가 공통 기반을 실제로 쓴다. core와 시그니처를 1:1로 맞춰 두 파일을 나란히 놓고 사람이 대조할 수 있게 한다 — 공유 패키지 승격 계획이 없으므로 이것이 정합성의 유일한 수단 중 하나다.

**Files:**
- Create: `backend/src/clients/gemini/gemini.client.ts`
- Test: `backend/src/clients/gemini/gemini.client.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `callExternal`·`ExternalServiceError`, Task 4의 `classifyGeminiFailure`
- Produces: `class GeminiClient { generate(prompt: string, opts?: GeminiGenerateOptions): Promise<string> }` · `interface GeminiGenerateOptions { model?, systemInstruction?, temperature? }`

- [ ] **Step 1: SDK 현행 시그니처를 context7로 확인**

spec `:650`이 요구하는 확인이다. context7에서 `@google/genai`(버전 `2.13.x`)를 조회해 아래 둘을 대조한다.

1. `ai.models.generateContent({ model, contents, config })`의 인자 shape
2. **`abortSignal`이 `GenerateContentConfig`의 최상위 필드인지** (`config.abortSignal`이지 `config.httpOptions.abortSignal`이 아닌지)

이 계획을 쓰며 `core/node_modules/@google/genai/dist/genai.d.ts:4969-4989`에서 확인한 결과는 다음과 같다. **다르면 멈추고 보고한다.**

```
export declare interface GenerateContentConfig {   // :4969
    abortSignal?: AbortSignal;                     // :4978  ← 최상위
    systemInstruction?: ContentUnion;              // :4983
    temperature?: number;                          // :4989
}
export declare class ApiError extends Error { status: number; }  // :475
```

SDK 타입 정의가 명시하는 사실도 함께 기록해 둔다 — **`abortSignal`은 우리 쪽만 끊는다. Gemini는 계속 생성하고 과금은 발생한다.**

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/src/clients/gemini/gemini.client.spec.ts` 신규 파일 전문:

```ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('@google/genai', () => ({ GoogleGenAI: jest.fn() }));

import { GoogleGenAI } from '@google/genai';

import { ExternalServiceError } from '../external-service.error';
import { GeminiClient } from './gemini.client';

/**
 * 모킹 경계는 SDK 모듈이다. 우리 클래스를 모킹하면 아무것도 검증하지 않고,
 * HTTP 레벨로 내리면 검증 대상이 SDK 내부 동작까지 넓어진다.
 */

const GoogleGenAIMock = GoogleGenAI as unknown as jest.Mock;
const generateContent = jest.fn();

async function createClient(
  env: Record<string, string> = { GEMINI_API_KEY: 'test-key' },
): Promise<GeminiClient> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      // 개발자의 .env·셸 환경에 의존하면 키가 설정된 머신에서만 통과하는 테스트가 된다.
      // process.env가 load보다 우선하므로 skipProcessEnv까지 켠다.
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => env],
      }),
    ],
    providers: [GeminiClient],
  }).compile();
  return moduleRef.get(GeminiClient);
}

beforeEach(() => {
  generateContent.mockReset().mockResolvedValue({ text: '생성된 답변' });
  GoogleGenAIMock.mockReset().mockImplementation(() => ({
    models: { generateContent },
  }));
});

describe('GeminiClient', () => {
  it('생성자가 네트워크를 만지지 않는다', async () => {
    await createClient();

    expect(GoogleGenAIMock).toHaveBeenCalledWith({ apiKey: 'test-key' });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('model·contents·systemInstruction·temperature를 SDK에 넘긴다', async () => {
    const client = await createClient();
    await client.generate('안녕', {
      model: 'gemini-2.5-pro',
      systemInstruction: '너는 여행 플래너다',
      temperature: 0.3,
    });

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        contents: '안녕',
        config: expect.objectContaining({
          systemInstruction: '너는 여행 플래너다',
          temperature: 0.3,
        }),
      }),
    );
  });

  it('model 미지정이면 GEMINI_MODEL 기본값을 쓴다', async () => {
    const client = await createClient();
    await client.generate('안녕');

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.0-flash' }),
    );
  });

  it('GEMINI_MODEL이 있으면 그 값을 쓴다', async () => {
    const client = await createClient({
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-2.5-flash',
    });
    await client.generate('안녕');

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash' }),
    );
  });

  it('abortSignal을 SDK에 전달한다', async () => {
    // 빠뜨리면 20초 타임아웃이 통째로 사라지고 아무 테스트도 깨지지 않는다.
    const client = await createClient();
    await client.generate('안녕');

    const config = generateContent.mock.calls[0][0].config as {
      abortSignal?: AbortSignal;
    };
    expect(config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(config.abortSignal?.aborted).toBe(false);
  });

  it('응답 텍스트를 그대로 반환한다', async () => {
    generateContent.mockResolvedValue({ text: '  앞뒤 공백 있는 답변  ' });
    const client = await createClient();

    await expect(client.generate('안녕')).resolves.toBe('  앞뒤 공백 있는 답변  ');
  });

  it('빈 문자열 응답은 empty-response로 끊는다', async () => {
    // core는 빈 문자열을 성공으로 돌려주지만(core/src/clients/gemini.ts:31)
    // backend에는 뒤에 붙은 검증기가 없어 빈 채팅 말풍선이 그대로 렌더된다.
    generateContent.mockResolvedValue({ text: '' });
    const client = await createClient();

    const failure = await client
      .generate('안녕')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect((failure as ExternalServiceError).kind).toBe('empty-response');
  });

  it('공백만 있는 응답도 empty-response다', async () => {
    generateContent.mockResolvedValue({ text: '   \n  ' });
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('text가 undefined면 empty-response다', async () => {
    generateContent.mockResolvedValue({});
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('429는 quota로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      service: 'gemini',
      kind: 'quota',
    });
  });

  it('401은 auth로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('unauthorized'), { status: 401 }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('500은 upstream으로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('server error'), { status: 500 }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('중단은 timeout으로 분류된다', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );
    const client = await createClient();

    await expect(client.generate('안녕')).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
```

- [ ] **Step 3: 실패를 확인**

```
npm test -- src/clients/gemini/gemini.client.spec.ts
```

Expected: FAIL — `Cannot find module './gemini.client' from 'src/clients/gemini/gemini.client.spec.ts'`

- [ ] **Step 4: 구현**

`backend/src/clients/gemini/gemini.client.ts` 신규 파일 전문:

```ts
import { GoogleGenAI } from '@google/genai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { callExternal } from '../call-external';
import { ExternalServiceError } from '../external-service.error';
import { classifyGeminiFailure } from './gemini.errors';

/** core의 GenerateOptions(core/src/clients/gemini.ts:4-8)와 같은 모양이다. */
export interface GeminiGenerateOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
}

/**
 * env로 열지 않는다 — 운영에서 조정이 필요해지면 그때 키를 판다.
 *
 * AbortSignal은 우리 쪽만 끊는다. 504를 돌려준 요청도 Gemini에서는 완주하고
 * 과금된다. 짧게 잡을수록 "돈은 쓰고 응답은 못 받는" 구간이 커진다 —
 * 20초는 실측 후 조정 대상이지 근거 있는 최적값이 아니다.
 */
const GEMINI_TIMEOUT_MS = 20000;

/** core의 기본 모델(core/src/clients/gemini.ts:17)과 같은 값을 유지한다. */
const DEFAULT_MODEL = 'gemini-2.0-flash';

/** Gemini 텍스트 생성 클라이언트 (생성 전용). 임베딩은 만들지 않는다. */
@Injectable()
export class GeminiClient {
  private readonly client: GoogleGenAI;
  private readonly defaultModel: string;

  constructor(config: ConfigService) {
    // 생성자는 네트워크를 만지지 않는다. 첫 실제 호출에서 네트워크를 만난다.
    this.client = new GoogleGenAI({
      apiKey: config.getOrThrow<string>('GEMINI_API_KEY'),
    });
    this.defaultModel = config.get<string>('GEMINI_MODEL', DEFAULT_MODEL);
  }

  /** 프롬프트로 텍스트를 생성한다. core의 generate와 같은 시그니처다. */
  generate(prompt: string, opts: GeminiGenerateOptions = {}): Promise<string> {
    // operation에 프롬프트 전문 대신 길이만 넣는다 — 로그에 프롬프트가 남지 않는다.
    return callExternal(
      'gemini',
      `generateContent(prompt=${prompt.length}자)`,
      classifyGeminiFailure,
      async () => {
        const response = await this.client.models.generateContent({
          model: opts.model ?? this.defaultModel,
          contents: prompt,
          config: {
            systemInstruction: opts.systemInstruction,
            temperature: opts.temperature,
            abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          },
        });

        const text = response.text ?? '';
        if (text.trim() === '') {
          // core는 빈 문자열을 성공으로 반환하고 뒤의 validateStructuredText가 잡는다.
          // backend에는 그 검증기가 없고 빈 문자열은 빈 채팅 말풍선으로 렌더된다.
          throw new ExternalServiceError(
            'gemini',
            'empty-response',
            'gemini가 빈 텍스트를 반환했습니다.',
          );
        }
        return text;
      },
    );
  }
}
```

- [ ] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 6: 커밋**

```bash
git add backend/src/clients/gemini/gemini.client.ts backend/src/clients/gemini/gemini.client.spec.ts
git commit -m "feat(backend): Gemini 텍스트 생성 클라이언트

core와 시그니처를 1:1로 맞춘다. 공유 패키지 승격 계획이 없으므로 목적은
'나중에 합칠 때 편하려고'가 아니라 '지금 두 파일을 나란히 놓고 대조 가능하게'다.

core와 갈라지는 지점은 하나다 — 빈 응답을 성공으로 반환하지 않는다.
core에서는 뒤의 validateStructuredText가 잡지만 backend에는 그 검증기가 없고,
빈 문자열은 사용자에게 빈 채팅 말풍선으로 보인다.

생성자에서 네트워크를 만지지 않는 이유는 chat.module.ts:7-9와 같다 —
사내망 서비스를 부팅 시 확인하면 외부망에서 부팅이 매달린다."
```

---

### Task 6: `TourContentPayload` · `parseTourContentPayload` · `buildQdrantFilter` (순수 함수)

payload 키 문자열이 코드 한 곳에만 존재하게 한다. 서비스 계층이 Qdrant 필터 DSL을 직접 조립하면 `ldong_regn_cd` 같은 키가 호출부마다 흩어지고, core가 키 이름을 바꿨을 때 고쳐야 할 곳을 셀 수 없게 된다.

**Files:**
- Create: `backend/src/clients/qdrant/tour-content-payload.ts`
- Test: `backend/src/clients/qdrant/tour-content-payload.spec.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces: `interface TourContentPayload` · `interface TourSearchFilter` · `parseTourContentPayload(raw: unknown): TourContentPayload | null` · `buildQdrantFilter(filter?: TourSearchFilter): Record<string, unknown> | undefined`

> **[계획 판단]** spec은 `TourSearchFilter`를 인터페이스 절(`:439`)에서는 `qdrant.client.ts`에, 경계표 행(`:576`)에서는 `tour-content-payload.ts`에 놓았다. **경계표 쪽을 따른다** — `buildQdrantFilter`가 이 타입을 받으므로 여기 두지 않으면 두 파일이 서로를 import하는 순환이 생긴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/clients/qdrant/tour-content-payload.spec.ts` 신규 파일 전문:

```ts
import {
  buildQdrantFilter,
  parseTourContentPayload,
} from './tour-content-payload';

/**
 * core의 toPayload(core/src/lib/qdrantCollection.ts:76-89)와 키가 1:1이어야 한다.
 * 타입 시스템이 두 워크스페이스를 연결하지 못하므로 여기서 리터럴로 단정한다.
 */

function completePayload(): Record<string, unknown> {
  return {
    contentid: '126508',
    contenttypeid: '12',
    ldong_regn_cd: '50',
    ldong_signgu_cd: '110',
    lcls_systm1: 'NA',
    lcls_systm2: 'NA01',
    lcls_systm3: 'NA0101',
    title: '성산일출봉',
    mapx: '126.9423',
    mapy: '33.4581',
  };
}

describe('parseTourContentPayload', () => {
  it('완전한 payload의 전 필드를 매핑한다', () => {
    expect(parseTourContentPayload(completePayload())).toEqual({
      contentid: '126508',
      contenttypeid: '12',
      ldong_regn_cd: '50',
      ldong_signgu_cd: '110',
      lcls_systm1: 'NA',
      lcls_systm2: 'NA01',
      lcls_systm3: 'NA0101',
      title: '성산일출봉',
      mapx: '126.9423',
      mapy: '33.4581',
    });
  });

  it('contentid가 없으면 null이다', () => {
    // contentid가 없으면 Postgres 재조회가 불가능해 hit 자체가 쓸모없다.
    const { contentid: _ignored, ...rest } = completePayload();
    expect(parseTourContentPayload(rest)).toBeNull();
  });

  it('contentid가 빈 문자열이어도 null이다', () => {
    expect(
      parseTourContentPayload({ ...completePayload(), contentid: '' }),
    ).toBeNull();
  });

  it('contentid만 있으면 나머지를 빈 문자열로 보정한다', () => {
    expect(parseTourContentPayload({ contentid: '126508' })).toEqual({
      contentid: '126508',
      contenttypeid: '',
      ldong_regn_cd: '',
      ldong_signgu_cd: '',
      lcls_systm1: '',
      lcls_systm2: '',
      lcls_systm3: '',
      title: '',
      mapx: '',
      mapy: '',
    });
  });

  it('null·문자열·배열 입력은 null이다', () => {
    expect(parseTourContentPayload(null)).toBeNull();
    expect(parseTourContentPayload(undefined)).toBeNull();
    expect(parseTourContentPayload('126508')).toBeNull();
    expect(parseTourContentPayload([{ contentid: '126508' }])).toBeNull();
  });
});

describe('buildQdrantFilter', () => {
  it('조건이 하나면 must 한 개를 만든다', () => {
    expect(buildQdrantFilter({ contenttypeid: '12' })).toEqual({
      must: [{ key: 'contenttypeid', match: { value: '12' } }],
    });
  });

  it('여러 조건은 must에 모두 들어간다', () => {
    expect(
      buildQdrantFilter({ ldongRegnCd: '50', lclsSystm1: 'NA' }),
    ).toEqual({
      must: [
        { key: 'ldong_regn_cd', match: { value: '50' } },
        { key: 'lcls_systm1', match: { value: 'NA' } },
      ],
    });
  });

  it('필터가 없으면 undefined다', () => {
    // 빈 must 절을 보내면 Qdrant가 조건 없는 필터로 해석해도 요청만 커진다.
    expect(buildQdrantFilter(undefined)).toBeUndefined();
  });

  it('빈 객체도 undefined다', () => {
    expect(buildQdrantFilter({})).toBeUndefined();
  });

  it('필터 키가 core의 payload 키 문자열과 정확히 일치한다', () => {
    // core가 키 이름을 바꾸면 이 단정이 깨져야 한다. 타입은 두 워크스페이스를
    // 연결하지 못하므로 문자열 리터럴이 유일한 대조 지점이다.
    const filter = buildQdrantFilter({
      contenttypeid: 'a',
      ldongRegnCd: 'b',
      ldongSignguCd: 'c',
      lclsSystm1: 'd',
      lclsSystm2: 'e',
      lclsSystm3: 'f',
    }) as { must: Array<{ key: string }> };

    expect(filter.must.map((condition) => condition.key)).toEqual([
      'contenttypeid',
      'ldong_regn_cd',
      'ldong_signgu_cd',
      'lcls_systm1',
      'lcls_systm2',
      'lcls_systm3',
    ]);
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- src/clients/qdrant/tour-content-payload.spec.ts
```

Expected: FAIL — `Cannot find module './tour-content-payload' from 'src/clients/qdrant/tour-content-payload.spec.ts'`

- [ ] **Step 3: 구현**

`backend/src/clients/qdrant/tour-content-payload.ts` 신규 파일 전문:

```ts
/**
 * core의 toPayload(core/src/lib/qdrantCollection.ts:76-89)가 쓰는 키와 1:1이어야 한다.
 * 타입 시스템이 두 워크스페이스를 연결하지 못하므로 이 주석과
 * .claude/skills/tb-tdd-implement/references/workspaces.md의 경계표가 유일한 연결이다.
 */
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

/**
 * 검색 필터. 서비스 계층이 Qdrant 필터 DSL을 직접 조립하지 않게 타입으로 받는다.
 * 이 타입이 qdrant.client.ts가 아니라 여기 있는 이유는 buildQdrantFilter가
 * 이걸 받기 때문이다 — 반대로 두면 두 파일이 서로를 import한다.
 */
export interface TourSearchFilter {
  contenttypeid?: string;
  ldongRegnCd?: string;
  ldongSignguCd?: string;
  lclsSystm1?: string;
  lclsSystm2?: string;
  lclsSystm3?: string;
}

/** payload 키 문자열은 이 표 한 곳에만 존재한다. core의 toPayload와 짝이다. */
const PAYLOAD_KEY_BY_FIELD: Record<keyof TourSearchFilter, string> = {
  contenttypeid: 'contenttypeid',
  ldongRegnCd: 'ldong_regn_cd',
  ldongSignguCd: 'ldong_signgu_cd',
  lclsSystm1: 'lcls_systm1',
  lclsSystm2: 'lcls_systm2',
  lclsSystm3: 'lcls_systm3',
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * contentid가 없으면 Postgres 재조회가 불가능해 쓸모가 없다 → null.
 * 나머지 필드는 ''로 보정한다 — 표시용 필드 하나가 비었다고 hit을 버릴 이유가 없다.
 */
export function parseTourContentPayload(
  raw: unknown,
): TourContentPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const contentid = asString(record.contentid);
  if (contentid === '') return null;

  return {
    contentid,
    contenttypeid: asString(record.contenttypeid),
    ldong_regn_cd: asString(record.ldong_regn_cd),
    ldong_signgu_cd: asString(record.ldong_signgu_cd),
    lcls_systm1: asString(record.lcls_systm1),
    lcls_systm2: asString(record.lcls_systm2),
    lcls_systm3: asString(record.lcls_systm3),
    title: asString(record.title),
    mapx: asString(record.mapx),
    mapy: asString(record.mapy),
  };
}

/** 조건이 하나도 없으면 undefined를 반환한다 — 빈 must 절을 보내지 않는다. */
export function buildQdrantFilter(
  filter?: TourSearchFilter,
): Record<string, unknown> | undefined {
  if (filter === undefined) return undefined;

  const fields = Object.keys(PAYLOAD_KEY_BY_FIELD) as Array<
    keyof TourSearchFilter
  >;
  const must = fields
    .filter((field) => filter[field] !== undefined)
    .map((field) => ({
      key: PAYLOAD_KEY_BY_FIELD[field],
      match: { value: filter[field] },
    }));

  return must.length === 0 ? undefined : { must };
}
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/src/clients/qdrant/tour-content-payload.ts backend/src/clients/qdrant/tour-content-payload.spec.ts
git commit -m "feat(backend): Qdrant payload 파서와 필터 변환 순수 함수

payload 키 문자열이 이 파일 한 곳에만 존재하게 한다. 서비스 계층이 필터 DSL을
직접 조립하면 ldong_regn_cd 같은 키가 호출부마다 흩어지고, core가 키 이름을
바꿨을 때 고쳐야 할 곳을 셀 수 없게 된다.

contentid가 없는 hit을 버리는 이유는 Postgres 재조회가 불가능해서다.
나머지 필드는 ''로 보정한다 — 표시용 필드 하나가 비었다고 버릴 이유가 없다.

TourSearchFilter를 client가 아니라 여기 둔 것은 설계 문서의 경계표 행을
따른 것이다(인터페이스 절과 어긋나 있었다). 반대로 두면 순환 import가 된다."
```

---

### Task 7: `classifyQdrantFailure` — Qdrant 실패 판정 (순수 함수)

404를 빈 배열로 삼키면 "검색 결과 없음"과 구분되지 않는다(`create-table-if-not-exists-is-no-op.md`의 backend판). 판정을 순수 함수로 떼어야 SDK mock 없이 표의 각 행을 직접 검증할 수 있다.

**Files:**
- Create: `backend/src/clients/qdrant/qdrant.errors.ts`
- Test: `backend/src/clients/qdrant/qdrant.errors.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `ExternalFailureKind`
- Produces: `classifyQdrantFailure(error: unknown): ExternalFailureKind | null`

> **[spec 미결정 — 계획 판단 2]** spec에 이 함수의 시그니처도 테스트 목록도 없다. 아래 규칙으로 정했다.
> - `QdrantClientTimeoutError` → `timeout`. **SDK가 fetch의 `AbortError`를 자기 타입으로 바꿔 던지므로**(`dist/cjs/api-client.js:34-37`) `classifyCommonFailure`가 이름으로 잡지 못한다. 여기서 잡지 않으면 에러 표의 "Qdrant 5초 초과 → 504"가 성립하지 않고 502가 된다.
> - 400 본문에 `/dimension|expected dim/i` → `dimension-mismatch`, 아니면 `invalid-request`. spec 실측표(`:766`)가 두 값을 모두 허용한다.
> - **Qdrant 429는 판정하지 않는다.** 에러 표에 Qdrant 429 행이 없다. `null`을 반환해 `upstream`(502)이 된다. 이 선택은 리뷰에 올려 확인받는다.
>
> SDK 오류 shape은 `@qdrant/openapi-typescript-fetch`의 `ApiError`다 — `status`·`statusText`·`data`를 갖고 `message`는 `statusText`뿐이라 **400의 이유는 `data`에만 있다**(`dist/cjs/types.js:5-15`).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/clients/qdrant/qdrant.errors.spec.ts` 신규 파일 전문:

```ts
import { classifyQdrantFailure } from './qdrant.errors';

/**
 * SDK가 던지는 오류는 @qdrant/openapi-typescript-fetch의 ApiError다 —
 * status·statusText·data를 갖고, message에는 statusText만 있다.
 * 400의 이유(차원 불일치 등)는 data에만 실려 온다.
 */

function apiError(status: number, data?: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, data });
}

describe('classifyQdrantFailure', () => {
  it('404는 not-found다', () => {
    // 빈 배열로 삼키면 "검색 결과 없음"과 구분되지 않는다.
    expect(classifyQdrantFailure(apiError(404))).toBe('not-found');
  });

  it("doesn't exist 메시지도 not-found다", () => {
    const error = new Error(
      "Unexpected Response: 404 (Not Found)\nCollection `nope` doesn't exist!",
    );
    expect(classifyQdrantFailure(error)).toBe('not-found');
  });

  it('401은 auth다', () => {
    expect(classifyQdrantFailure(apiError(401))).toBe('auth');
  });

  it('403도 auth다', () => {
    expect(classifyQdrantFailure(apiError(403))).toBe('auth');
  });

  it('차원 불일치 400은 dimension-mismatch다', () => {
    const error = apiError(400, {
      status: {
        error: 'Wrong input: Vector dimension error: expected dim: 1024, got 3',
      },
    });
    expect(classifyQdrantFailure(error)).toBe('dimension-mismatch');
  });

  it('차원과 무관한 400은 invalid-request다', () => {
    const error = apiError(400, { status: { error: 'Format error in JSON body' } });
    expect(classifyQdrantFailure(error)).toBe('invalid-request');
  });

  it('500은 upstream이다', () => {
    expect(classifyQdrantFailure(apiError(500))).toBe('upstream');
  });

  it('QdrantClientTimeoutError는 timeout이다', () => {
    // SDK가 fetch의 AbortError를 자기 타입으로 바꿔 던지므로
    // classifyCommonFailure의 이름 판정으로는 잡히지 않는다.
    const error = Object.assign(new Error('The operation was aborted'), {
      name: 'QdrantClientTimeoutError',
    });
    expect(classifyQdrantFailure(error)).toBe('timeout');
  });

  it('모르는 오류에는 null을 반환한다', () => {
    expect(classifyQdrantFailure(new Error('그냥 오류'))).toBeNull();
    expect(classifyQdrantFailure(null)).toBeNull();
    expect(classifyQdrantFailure('문자열')).toBeNull();
  });

  it('ECONNREFUSED를 자기 것으로 판정하지 않는다', () => {
    // 네트워크 단절은 공통 판정의 몫이다.
    const error = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    expect(classifyQdrantFailure(error)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- src/clients/qdrant/qdrant.errors.spec.ts
```

Expected: FAIL — `Cannot find module './qdrant.errors' from 'src/clients/qdrant/qdrant.errors.spec.ts'`

- [ ] **Step 3: 구현**

`backend/src/clients/qdrant/qdrant.errors.ts` 신규 파일 전문:

```ts
import { ExternalFailureKind } from '../external-service.error';

/**
 * Qdrant는 차원 불일치를 400 본문에 담아 보낸다:
 * "Wrong input: Vector dimension error: expected dim: 1024, got 3"
 */
const DIMENSION_PATTERN = /dimension|expected dim/i;

/** core의 isCollectionNotFound(core/src/clients/qdrant.ts:13)와 같은 규칙이다. */
const NOT_FOUND_PATTERN = /not found|doesn't exist|does not exist/i;

function nameOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const record = error as { name?: unknown };
  return typeof record.name === 'string' ? record.name : '';
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { status?: unknown };
  return typeof record.status === 'number' ? record.status : null;
}

function stringifyData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

/**
 * 판정에 쓸 문자열. ApiError의 message는 statusText뿐이라 400의 이유가 없다 —
 * 본문은 data에 있다. QdrantClientUnexpectedResponseError는 반대로 본문을
 * message에 넣으므로 둘을 합쳐서 본다.
 */
function detailOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return typeof error === 'string' ? error : '';
  }
  const record = error as { message?: unknown; data?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  return `${message} ${stringifyData(record.data)}`;
}

/**
 * Qdrant SDK 오류를 kind로 판정한다. 모르는 오류에는 null을 반환해 공통 판정에 넘긴다.
 *
 * Qdrant 429(QdrantClientResourceExhaustedError)는 일부러 판정하지 않는다 —
 * 설계 문서의 에러 처리 표에 해당 행이 없다. 필요해지면 표에 행을 먼저 추가한다.
 */
export function classifyQdrantFailure(
  error: unknown,
): ExternalFailureKind | null {
  // SDK가 fetch의 AbortError를 자기 타입으로 바꿔 던지므로 공통 판정이 잡지 못한다.
  if (nameOf(error) === 'QdrantClientTimeoutError') return 'timeout';

  const status = statusOf(error);
  const detail = detailOf(error);

  if (status === 404 || NOT_FOUND_PATTERN.test(detail)) return 'not-found';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400) {
    return DIMENSION_PATTERN.test(detail) ? 'dimension-mismatch' : 'invalid-request';
  }
  if (status !== null && status >= 500 && status <= 599) return 'upstream';
  return null;
}
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/src/clients/qdrant/qdrant.errors.ts backend/src/clients/qdrant/qdrant.errors.spec.ts
git commit -m "feat(backend): Qdrant 실패 판정 순수 함수

404를 not-found로 끊는 것이 핵심이다. 빈 배열로 삼키면 '검색 결과 없음'과
화면에서 구분되지 않고 서버는 200을 찍는다.

QdrantClientTimeoutError를 여기서 잡는 이유는 SDK가 fetch의 AbortError를
자기 타입으로 바꿔 던지기 때문이다. 공통 판정은 이름으로 보므로 놓치고,
그러면 5초 타임아웃이 504가 아니라 502가 된다.

설계 문서에 이 함수의 시그니처와 테스트 목록이 없어 400 판별 규칙과
Qdrant 429 미판정은 계획 단계의 결정이다 — 리뷰에서 확인받는다."
```

---

### Task 8: `QdrantSearchClient` — 읽기 전용 벡터 검색

이름에 `Search`가 들어간 것은 의도다 — 쓰기 메서드가 없다는 사실이 타입에 드러난다. 컬렉션 소유권은 core에 있다.

**Files:**
- Create: `backend/src/clients/qdrant/qdrant.client.ts`
- Test: `backend/src/clients/qdrant/qdrant.client.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `callExternal`·`ExternalServiceError`, Task 6의 `parseTourContentPayload`·`buildQdrantFilter`·`TourContentPayload`·`TourSearchFilter`, Task 7의 `classifyQdrantFailure`
- Produces: `class QdrantSearchClient { search(vector, opts?): Promise<TourSearchHit[]>; getCollectionInfo(): Promise<QdrantCollectionInfo> }` · `interface QdrantSearchOptions` · `interface TourSearchHit` · `interface QdrantCollectionInfo`

- [ ] **Step 1: SDK 현행 시그니처를 context7로 확인**

spec `:480`·`:650`이 요구하는 확인이다. context7에서 `@qdrant/js-client-rest`(버전 `1.18.x`)를 조회해 아래를 대조한다.

1. **`query()`의 반환 shape** — 배열인지 `{ points: [...] }`인지
2. `query()` 요청 인자에 `query`(질의 벡터) · `limit` · `filter` · `with_payload`가 있는지
3. `QdrantClientParams`의 `timeout` 단위(초/밀리초)와 기본값

이 계획을 쓰며 `core/node_modules/@qdrant/js-client-rest/dist/types`에서 확인한 결과는 다음과 같다. **다르면 멈추고 보고한다.**

```
query(collection_name, { query, limit, filter, with_payload, with_vector, ... })
  : Promise<Schemas['QueryResponse']>
QueryResponse = { points: ScoredPoint[] }                      // openapi/generated_schema.d.ts:3903
ScoredPoint  = { id, version, score, payload?, vector?, ... }  // openapi/generated_schema.d.ts:1573
QdrantClientParams.timeout  // 밀리초. 기본 300000 (qdrant-client.js:11)
```

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/src/clients/qdrant/qdrant.client.spec.ts` 신규 파일 전문:

```ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn() }));

import { QdrantClient } from '@qdrant/js-client-rest';

import { ExternalServiceError } from '../external-service.error';
import { QdrantSearchClient } from './qdrant.client';

/**
 * core가 vi.mock("@qdrant/js-client-rest")로 잡는 것과 같은 자리를 jest.mock으로 잡는다.
 * 이 경계는 SDK 옵션 이름의 오타를 잡지 못한다(with_payload를 withPayload로 써도
 * mock은 통과시킨다) — 그 구멍은 검증 계획의 실측으로만 메워진다.
 */

const QdrantClientMock = QdrantClient as unknown as jest.Mock;
const query = jest.fn();
const getCollection = jest.fn();

const VECTOR = [0.1, 0.2, 0.3];

function point(contentid: string, score: number) {
  return {
    id: Number(contentid),
    version: 1,
    score,
    payload: {
      contentid,
      contenttypeid: '12',
      ldong_regn_cd: '50',
      ldong_signgu_cd: '110',
      lcls_systm1: 'NA',
      lcls_systm2: 'NA01',
      lcls_systm3: 'NA0101',
      title: `관광지 ${contentid}`,
      mapx: '126.9',
      mapy: '33.4',
    },
  };
}

async function createClient(
  env: Record<string, string> = { QDRANT_URL: 'http://qdrant.test:6333' },
): Promise<QdrantSearchClient> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => env],
      }),
    ],
    providers: [QdrantSearchClient],
  }).compile();
  return moduleRef.get(QdrantSearchClient);
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ points: [] });
  getCollection.mockReset().mockResolvedValue({
    config: { params: { vectors: { size: 1024, distance: 'Cosine' } } },
  });
  QdrantClientMock.mockReset().mockImplementation(() => ({
    query,
    getCollection,
  }));
});

describe('QdrantSearchClient 생성자', () => {
  it('url과 timeout을 SDK에 전달한다', async () => {
    // timeout을 빠뜨리면 SDK 기본값 300초가 적용돼 사용자가 5분을 기다린다.
    await createClient();

    expect(QdrantClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://qdrant.test:6333',
        timeout: 5000,
      }),
    );
  });

  it('QDRANT_API_KEY가 있으면 apiKey를 넘긴다', async () => {
    await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_API_KEY: 'secret',
    });

    expect(QdrantClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'secret' }),
    );
  });

  it('QDRANT_API_KEY가 없으면 apiKey 키 자체를 넘기지 않는다', async () => {
    await createClient();

    const params = QdrantClientMock.mock.calls[0][0] as Record<string, unknown>;
    expect('apiKey' in params).toBe(false);
  });

  it('네트워크를 만지지 않는다', async () => {
    await createClient();

    expect(query).not.toHaveBeenCalled();
    expect(getCollection).not.toHaveBeenCalled();
  });
});

describe('QdrantSearchClient.search', () => {
  it('QDRANT_COLLECTION 기본값 tour_contents를 쓴다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    expect(query).toHaveBeenCalledWith('tour_contents', expect.anything());
  });

  it('QDRANT_COLLECTION이 있으면 그 값을 쓴다', async () => {
    const client = await createClient({
      QDRANT_URL: 'http://qdrant.test:6333',
      QDRANT_COLLECTION: 'tour_v2',
    });
    await client.search(VECTOR);

    expect(query).toHaveBeenCalledWith('tour_v2', expect.anything());
  });

  it('with_payload를 true로 보내고 with_vector는 보내지 않는다', async () => {
    // with_payload를 빠뜨리면 payload가 null로 오고 파서가 전 건을 버려
    // "정상 200 + 빈 배열"이 된다. hit당 1024 float를 되받을 이유도 없다.
    const client = await createClient();
    await client.search(VECTOR);

    const request = query.mock.calls[0][1] as Record<string, unknown>;
    expect(request.with_payload).toBe(true);
    expect('with_vector' in request).toBe(false);
  });

  it('질의 벡터를 query로 보낸다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    expect(query.mock.calls[0][1]).toMatchObject({ query: VECTOR });
  });

  it('limit 기본값은 10이다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    expect(query.mock.calls[0][1]).toMatchObject({ limit: 10 });
  });

  it('limit을 지정하면 그 값을 쓴다', async () => {
    const client = await createClient();
    await client.search(VECTOR, { limit: 3 });

    expect(query.mock.calls[0][1]).toMatchObject({ limit: 3 });
  });

  it('필터를 지정하면 변환해 전달한다', async () => {
    const client = await createClient();
    await client.search(VECTOR, { filter: { contenttypeid: '12' } });

    expect(query.mock.calls[0][1]).toMatchObject({
      filter: { must: [{ key: 'contenttypeid', match: { value: '12' } }] },
    });
  });

  it('필터 미지정이면 filter 키 자체가 요청에 없다', async () => {
    const client = await createClient();
    await client.search(VECTOR);

    const request = query.mock.calls[0][1] as Record<string, unknown>;
    expect('filter' in request).toBe(false);
  });

  it('결과를 TourSearchHit[]로 매핑한다', async () => {
    query.mockResolvedValue({ points: [point('1', 0.9), point('2', 0.8)] });
    const client = await createClient();

    const hits = await client.search(VECTOR);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      id: 1,
      score: 0.9,
      payload: expect.objectContaining({ contentid: '1', title: '관광지 1' }),
    });
  });

  it('hit 0건은 빈 배열을 반환하고 throw하지 않는다', async () => {
    query.mockResolvedValue({ points: [] });
    const client = await createClient();

    await expect(client.search(VECTOR)).resolves.toEqual([]);
  });

  it('일부만 payload 불량이면 나머지를 반환한다', async () => {
    const broken = { ...point('3', 0.7), payload: { title: 'contentid 없음' } };
    query.mockResolvedValue({ points: [point('1', 0.9), broken, point('2', 0.8)] });
    const client = await createClient();

    const hits = await client.search(VECTOR);
    expect(hits.map((hit) => hit.payload.contentid)).toEqual(['1', '2']);
  });

  it('전 건 payload 불량은 upstream으로 throw한다', async () => {
    // 위 두 케이스와 짝이다. 여기서 끊지 않으면 with_payload 누락이
    // "검색 결과 없음"으로 위장한 채 며칠을 간다.
    query.mockResolvedValue({
      points: [
        { ...point('1', 0.9), payload: null },
        { ...point('2', 0.8), payload: null },
      ],
    });
    const client = await createClient();

    const failure = await client.search(VECTOR).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect((failure as ExternalServiceError).kind).toBe('upstream');
  });

  it('404는 not-found로 throw한다 (빈 배열이 아니다)', async () => {
    query.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    const client = await createClient();

    await expect(client.search(VECTOR)).rejects.toMatchObject({
      service: 'qdrant',
      kind: 'not-found',
    });
  });

  it('차원 불일치 400은 dimension-mismatch다', async () => {
    query.mockRejectedValue(
      Object.assign(new Error('Bad Request'), {
        status: 400,
        data: { status: { error: 'Vector dimension error: expected dim: 1024, got 3' } },
      }),
    );
    const client = await createClient();

    await expect(client.search(VECTOR)).rejects.toMatchObject({
      kind: 'dimension-mismatch',
    });
  });

  it('연결 거부는 unavailable이다', async () => {
    query.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    const client = await createClient();

    await expect(client.search(VECTOR)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});

describe('QdrantSearchClient.getCollectionInfo', () => {
  it('vectorSize와 distance를 반환한다', async () => {
    const client = await createClient();

    await expect(client.getCollectionInfo()).resolves.toEqual({
      vectorSize: 1024,
      distance: 'Cosine',
    });
    expect(getCollection).toHaveBeenCalledWith('tour_contents');
  });

  it('벡터 설정을 읽을 수 없으면 throw한다', async () => {
    // 차원과 distance를 버리고 넘어가면 잘못된 컬렉션 위에서 검색이 조용히 돈다.
    getCollection.mockResolvedValue({ config: { params: {} } });
    const client = await createClient();

    await expect(client.getCollectionInfo()).rejects.toMatchObject({
      service: 'qdrant',
      kind: 'upstream',
    });
  });
});
```

- [ ] **Step 3: 실패를 확인**

```
npm test -- src/clients/qdrant/qdrant.client.spec.ts
```

Expected: FAIL — `Cannot find module './qdrant.client' from 'src/clients/qdrant/qdrant.client.spec.ts'`

- [ ] **Step 4: 구현**

`backend/src/clients/qdrant/qdrant.client.ts` 신규 파일 전문:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';

import { callExternal } from '../call-external';
import { ExternalServiceError } from '../external-service.error';
import { classifyQdrantFailure } from './qdrant.errors';
import {
  buildQdrantFilter,
  parseTourContentPayload,
} from './tour-content-payload';
import type {
  TourContentPayload,
  TourSearchFilter,
} from './tour-content-payload';

export interface QdrantSearchOptions {
  limit?: number;
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

/** SDK 기본값은 300000ms(5분)다. 사람이 기다리는 요청에 그대로 두지 않는다. */
const QDRANT_TIMEOUT_MS = 5000;

/** core/.env.example과 같은 기본값을 유지한다. */
const DEFAULT_COLLECTION = 'tour_contents';

/** core의 QdrantStore.search와 같은 기본값(core/src/clients/qdrant.ts:123). */
const DEFAULT_LIMIT = 10;

/**
 * 읽기 전용 Qdrant 클라이언트.
 * 이름에 Search가 들어간 것은 의도다 — 쓰기 메서드가 없다는 사실이 타입에 드러난다.
 * SDK의 QdrantClient와 이름이 겹치지 않게 하는 목적도 겸한다.
 */
@Injectable()
export class QdrantSearchClient {
  private readonly logger = new Logger(QdrantSearchClient.name);
  private readonly client: QdrantClient;
  private readonly collection: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('QDRANT_API_KEY');
    // 생성자는 네트워크를 만지지 않는다. core의 connect()가 하는 getCollections
    // 확인을 가져오지 않는 이유는 Qdrant가 사내망에 있어 외부망에서 부팅이
    // 매달리기 때문이다(chat.module.ts:7-9와 같은 판단).
    this.client = new QdrantClient({
      url: config.getOrThrow<string>('QDRANT_URL'),
      ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
      timeout: QDRANT_TIMEOUT_MS,
    });
    this.collection = config.get<string>(
      'QDRANT_COLLECTION',
      DEFAULT_COLLECTION,
    );
  }

  /**
   * 질의 벡터로 검색한다. 컬렉션 인자를 두지 않는 이유는, 인자로 열면 호출자가
   * 이름을 문자열로 짐작하게 되고 오타 판정이 호출부마다 달라지기 때문이다.
   */
  search(
    vector: number[],
    opts: QdrantSearchOptions = {},
  ): Promise<TourSearchHit[]> {
    const filter = buildQdrantFilter(opts.filter);

    return callExternal(
      'qdrant',
      `query(${this.collection})`,
      classifyQdrantFailure,
      async () => {
        const response = await this.client.query(this.collection, {
          query: vector,
          limit: opts.limit ?? DEFAULT_LIMIT,
          // payload가 결과의 본체다. 보내지 않으면 payload가 null로 오고
          // 아래 파서가 전 건을 버려 "정상 200 + 빈 배열"이 된다.
          with_payload: true,
          // with_vector는 요청하지 않는다 — hit당 float 수백~수천 개를 되받을 이유가 없다.
          ...(filter === undefined ? {} : { filter }),
        });

        const points = response.points;
        const hits: TourSearchHit[] = [];
        for (const point of points) {
          const payload = parseTourContentPayload(point.payload);
          if (payload === null) continue;
          hits.push({ id: point.id, score: point.score, payload });
        }

        if (points.length > 0 && hits.length === 0) {
          // hit 0건과 화면에서 구분되지 않는다. 여기서 끊지 않으면 with_payload
          // 누락이나 core의 payload 키 변경이 "검색 결과 없음"으로 위장한다.
          const firstKeys = Object.keys(
            (points[0].payload ?? {}) as Record<string, unknown>,
          );
          throw new ExternalServiceError(
            'qdrant',
            'upstream',
            `payload를 읽을 수 있는 hit이 없습니다. 버린 건수 ${points.length}, ` +
              `첫 hit의 키: ${firstKeys.length === 0 ? '없음' : firstKeys.join(', ')}`,
          );
        }

        if (hits.length < points.length) {
          this.logger.warn(
            `payload 파싱에 실패한 hit ${points.length - hits.length}건을 버렸습니다.`,
          );
        }
        return hits;
      },
    );
  }

  /** 진단용. 컬렉션 차원·distance가 core가 만든 것과 맞는지 확인한다. */
  getCollectionInfo(): Promise<QdrantCollectionInfo> {
    return callExternal(
      'qdrant',
      `getCollection(${this.collection})`,
      classifyQdrantFailure,
      async () => {
        const info = await this.client.getCollection(this.collection);
        const vectors = info.config?.params?.vectors;
        const isRecord = typeof vectors === 'object' && vectors !== null;
        const size = isRecord
          ? Number((vectors as { size?: unknown }).size)
          : Number.NaN;
        const distance = isRecord
          ? (vectors as { distance?: unknown }).distance
          : undefined;

        if (!Number.isFinite(size) || size <= 0 || typeof distance !== 'string') {
          // 차원과 distance를 버리고 넘어가면 잘못된 컬렉션 위에서 검색이 조용히 돈다.
          throw new ExternalServiceError(
            'qdrant',
            'upstream',
            `컬렉션 ${this.collection}의 벡터 설정을 읽을 수 없습니다.`,
          );
        }
        return { vectorSize: size, distance };
      },
    );
  }
}
```

- [ ] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 6: 커밋**

```bash
git add backend/src/clients/qdrant/qdrant.client.ts backend/src/clients/qdrant/qdrant.client.spec.ts
git commit -m "feat(backend): 읽기 전용 Qdrant 검색 클라이언트

컬렉션 소유권은 core에 있다. upsert·createCollection·delete를 만들지 않고
이름에 Search를 넣어 쓰기 표면이 없다는 사실을 타입에 드러낸다.

search에 컬렉션 인자를 두지 않은 이유는 인자로 열면 호출자가 이름을 문자열로
짐작하게 되고, 오타가 빈 결과가 될지 404가 될지가 호출부마다 달라지기 때문이다.

hit은 있는데 payload를 전 건 버린 경우를 502로 끊는다. hit 0건과 화면에서
구분되지 않으므로 이 분기가 없으면 with_payload 누락을 며칠간 못 알아챈다.

timeout을 명시하는 이유는 SDK 기본값이 300초라서다."
```

---

### Task 9: `ClientsModule` — 클라이언트 두 개 등록

3번째 클라이언트가 이 파일에서 차지할 자리가 몇 줄인지가 다음 태스크의 판정 기준이 된다. **여기서는 Gemini와 Qdrant만 등록한다.**

**Files:**
- Create: `backend/src/clients/clients.module.ts`
- Test: `backend/src/clients/clients.module.spec.ts`

**Interfaces:**
- Consumes: Task 5의 `GeminiClient`, Task 8의 `QdrantSearchClient`
- Produces: `class ClientsModule` (exports: `GeminiClient`, `QdrantSearchClient`)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/clients/clients.module.spec.ts` 신규 파일 전문:

```ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('@google/genai', () => ({ GoogleGenAI: jest.fn() }));
jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn() }));

import { ClientsModule } from './clients.module';
import { GeminiClient } from './gemini/gemini.client';
import { QdrantSearchClient } from './qdrant/qdrant.client';

describe('ClientsModule', () => {
  it('ConfigModule을 명시 주입하면 클라이언트가 모두 해석된다', async () => {
    // 개발자의 .env에 의존하면 키가 설정된 머신에서만 통과하는 테스트가 된다.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [
            () => ({
              GEMINI_API_KEY: 'test-key',
              QDRANT_URL: 'http://qdrant.test:6333',
            }),
          ],
        }),
        ClientsModule,
      ],
    }).compile();

    expect(moduleRef.get(GeminiClient)).toBeInstanceOf(GeminiClient);
    expect(moduleRef.get(QdrantSearchClient)).toBeInstanceOf(
      QdrantSearchClient,
    );
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- src/clients/clients.module.spec.ts
```

Expected: FAIL — `Cannot find module './clients.module' from 'src/clients/clients.module.spec.ts'`

- [ ] **Step 3: 구현**

`backend/src/clients/clients.module.ts` 신규 파일 전문:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { GeminiClient } from './gemini/gemini.client';
import { QdrantSearchClient } from './qdrant/qdrant.client';

/**
 * 외부 서비스 클라이언트 모음.
 *
 * @Global()을 쓰지 않는다 — 전역 모듈은 의존 관계를 모듈 그래프에서 지운다
 * (DatabaseModule이 전역이 아닌 것과 같은 이유). 소비자가 생기면 그 모듈이
 * 이 모듈을 import한다. 이번엔 AppModule에 넣지 않는다 — 지금 배선하면
 * chat이 클라이언트를 주입하는 시점에 지워야 할 import가 된다.
 *
 * imports: [ConfigModule]은 database.module.ts:23과 같은 패턴이다.
 */
@Module({
  imports: [ConfigModule],
  providers: [GeminiClient, QdrantSearchClient],
  exports: [GeminiClient, QdrantSearchClient],
})
export class ClientsModule {}
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 커밋**

```bash
git add backend/src/clients/clients.module.ts backend/src/clients/clients.module.spec.ts
git commit -m "feat(backend): ClientsModule에 Gemini·Qdrant 등록

@Global()을 쓰지 않는다. 전역 모듈은 의존 관계를 모듈 그래프에서 지우므로
누가 무엇을 쓰는지 코드로 추적할 수 없게 된다.

AppModule에 배선하지 않는 이유는 소비자가 없어서다. 지금 넣으면 chat이
클라이언트를 주입하는 시점에 지워야 할 import가 된다. 대가로 start:dev
성공이 클라이언트 동작의 증거가 되지 않으므로 실측이 필수가 된다."
```

---

### Task 10: `classifyTeiFailure` — TEI 실패 판정 (순수 함수)

**여기부터가 이 설계의 구조 검증이다.** TEI는 SDK도 인증도 없어 앞의 둘과 가장 다른 클라이언트다. 그런데도 공통 파일이 유니온 한 줄 외에 바뀌지 않는다면, 공통화한 것들이 "SDK를 감싸는 도구"가 아니라 "외부 실패를 분류하는 도구"였다는 뜻이다.

**Files:**
- Create: `backend/src/clients/tei/tei.errors.ts`
- Test: `backend/src/clients/tei/tei.errors.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `ExternalFailureKind`
- Produces: `classifyTeiFailure(response: Response): ExternalFailureKind | null`

- [ ] **Step 1: 구조 검증의 기준점을 표시**

TEI 태스크 두 개(10·11)의 커밋 diff가 구조 검증의 증거다. 시작 지점을 남긴다.

```bash
git tag tei-base
git rev-parse --short tei-base
```

Task 11의 마지막에 이 태그로 diff를 뜨고 태그를 지운다.

- [ ] **Step 2: 실패하는 테스트 작성**

`backend/src/clients/tei/tei.errors.spec.ts` 신규 파일 전문:

```ts
import { classifyTeiFailure } from './tei.errors';

/**
 * TEI는 SDK가 없어 fetch의 Response를 직접 본다.
 * fetch는 4xx·5xx에 throw하지 않으므로 response.ok 확인을 빠뜨리면
 * 에러 본문이 벡터로 파싱된다 — 이 클라이언트에서 가장 쉬운 실수다.
 */

function response(status: number): Response {
  return new Response(status === 204 ? null : '{}', { status });
}

describe('classifyTeiFailure', () => {
  it('400은 invalid-request다', () => {
    expect(classifyTeiFailure(response(400))).toBe('invalid-request');
  });

  it('413은 invalid-request다', () => {
    expect(classifyTeiFailure(response(413))).toBe('invalid-request');
  });

  it('422는 invalid-request다', () => {
    expect(classifyTeiFailure(response(422))).toBe('invalid-request');
  });

  it('500은 upstream이다', () => {
    expect(classifyTeiFailure(response(500))).toBe('upstream');
  });

  it('503(모델 로딩 중)도 upstream이다', () => {
    expect(classifyTeiFailure(response(503))).toBe('upstream');
  });

  it('분류되지 않은 비-2xx는 upstream이다', () => {
    expect(classifyTeiFailure(response(404))).toBe('upstream');
    expect(classifyTeiFailure(response(418))).toBe('upstream');
  });

  it('2xx에는 null을 반환한다', () => {
    // 성공을 실패로 분류하지 않는지 보는 반대 방향 케이스다.
    expect(classifyTeiFailure(response(200))).toBeNull();
    expect(classifyTeiFailure(response(204))).toBeNull();
  });
});
```

- [ ] **Step 3: 실패를 확인**

```
npm test -- src/clients/tei/tei.errors.spec.ts
```

Expected: FAIL — `Cannot find module './tei.errors' from 'src/clients/tei/tei.errors.spec.ts'`

- [ ] **Step 4: 구현**

`backend/src/clients/tei/tei.errors.ts` 신규 파일 전문:

```ts
import { ExternalFailureKind } from '../external-service.error';

/**
 * TEI는 SDK가 없어 fetch의 Response를 직접 본다.
 * fetch는 4xx·5xx에 throw하지 않으므로 response.ok 확인을 빠뜨리면
 * 에러 JSON이 number[][]로 파싱을 시도하다 이상한 곳에서 터지거나,
 * 최악의 경우 파싱에 성공해 쓰레기 벡터가 Qdrant로 간다.
 *
 * auth·quota·not-found는 TEI에 없다 — 자체 호스팅이고 인증이 없다.
 * 서비스마다 쓰는 kind가 다른 것은 결함이 아니다.
 *
 * 연결 거부·타임아웃은 fetch가 throw하므로 classifyCommonFailure가 처리한다.
 */
export function classifyTeiFailure(
  response: Response,
): ExternalFailureKind | null {
  if (response.ok) return null;

  // 입력이 모델 제약을 벗어난 경우. truncate: true라 흔치 않다.
  if (
    response.status === 400 ||
    response.status === 413 ||
    response.status === 422
  ) {
    return 'invalid-request';
  }

  // 5xx(모델 로딩 중·OOM)와 분류되지 않은 비-2xx는 모두 외부 사정으로 본다.
  return 'upstream';
}
```

- [ ] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 6: 커밋**

```bash
git add backend/src/clients/tei/tei.errors.ts backend/src/clients/tei/tei.errors.spec.ts
git commit -m "feat(backend): TEI 실패 판정 순수 함수

TEI는 SDK가 없어 fetch의 Response를 직접 본다. fetch가 4xx·5xx에 throw하지
않으므로 response.ok 확인이 이 클라이언트의 유일한 방어선이다 — 빠뜨리면
에러 본문이 벡터로 파싱돼 쓰레기 벡터가 Qdrant로 간다.

auth·quota·not-found를 판정하지 않는다. TEI는 자체 호스팅이고 인증이 없다 —
서비스마다 쓰는 kind가 다른 것은 ExternalFailureKind가 서비스별 API가 아니라
책임 귀속의 어휘라는 증거다."
```

---

### Task 11: `TeiClient` — 질의 임베딩 + **구조 검증**

검색 경로를 닫는 마지막 조각이다. 이 태스크가 공통 파일에서 만지는 것은 `ExternalService` 유니온 한 줄과 `ClientsModule`의 두 줄(+ import 한 줄)이어야 한다. **그 이상이면 공통화 경계가 틀린 것이다.**

**Files:**
- Create: `backend/src/clients/tei/tei.client.ts`
- Modify: `backend/src/clients/external-service.error.ts` (유니온 한 줄)
- Modify: `backend/src/clients/clients.module.ts` (import 1줄 + providers·exports 각 1줄)
- Modify: `backend/src/clients/clients.module.spec.ts` (TEI 단정 추가 — 테스트 더블은 공통화 대상이 아니다)
- Test: `backend/src/clients/tei/tei.client.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `callExternal`·`ExternalServiceError`, Task 10의 `classifyTeiFailure`
- Produces: `class TeiClient { embedQuery(text: string): Promise<number[]> }` · `ExternalService`에 `'tei'` 추가

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/clients/tei/tei.client.spec.ts` 신규 파일 전문:

```ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../external-service.error';
import { TeiClient } from './tei.client';

/**
 * TEI만 모킹 경계가 다르다 — SDK가 없으므로 전역 fetch를 스텁한다.
 * 이 경계는 오히려 더 정확하다: 요청 URL·메서드·바디를 문자열 수준에서
 * 단정할 수 있어 "core와 같은 바디를 보내는가"를 직접 검증할 수 있다.
 *
 * spy를 걸지 않은 테스트가 하나라도 있으면 CI에서 실제 TEI 주소로 나간다.
 */

const BASE_URL = 'http://tei.test:8080';

let fetchSpy: jest.SpyInstance;

async function createClient(): Promise<TeiClient> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        skipProcessEnv: true,
        load: [() => ({ TEI_BASE_URL: BASE_URL })],
      }),
    ],
    providers: [TeiClient],
  }).compile();
  return moduleRef.get(TeiClient);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse([[0.1, 0.2, 0.3]]));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TeiClient.embedQuery', () => {
  it('POST {TEI_BASE_URL}/embed로 나간다', async () => {
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://tei.test:8080/embed');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('바디가 core의 요청 형태와 정확히 일치한다', async () => {
    // 바디가 갈리면 같은 텍스트가 두 워크스페이스에서 다른 벡터가 된다.
    // core/src/clients/tei.ts:22-31과 짝이다.
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    const init = fetchSpy.mock.calls[0][1] as { body: string };
    expect(init.body).toBe(
      '{"inputs":["실내 박물관"],"normalize":true,"truncate":true}',
    );
  });

  it('바디에 prompt_name 키가 없다', async () => {
    // bge-m3는 지시문 프리픽스 없이 동작한다. 색인이 만들어진 조건과
    // 다르게 질의할 수 있는 손잡이를 만들지 않는다.
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    const init = fetchSpy.mock.calls[0][1] as { body: string };
    expect(init.body).not.toContain('prompt_name');
  });

  it('signal을 fetch 옵션에 전달한다', async () => {
    // 빠뜨리면 5초 타임아웃이 통째로 사라지고 아무 테스트도 깨지지 않는다.
    const client = await createClient();
    await client.embedQuery('실내 박물관');

    const init = fetchSpy.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('첫 벡터를 number[]로 반환한다', async () => {
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).resolves.toEqual([
      0.1, 0.2, 0.3,
    ]);
  });

  it('반환 벡터의 길이를 검사하지 않는다', async () => {
    // 차원 판정은 Qdrant의 일이다. 여기서 검사하면 1024가 backend에 박히고,
    // TEI에 뜬 모델과 어긋나면 조용히 틀린 검색이 된다.
    fetchSpy.mockResolvedValue(jsonResponse([[1, 2, 3]]));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).resolves.toHaveLength(3);
  });

  it('빈 문자열은 fetch 없이 invalid-request로 거부한다', async () => {
    const client = await createClient();

    const failure = await client.embedQuery('').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect((failure as ExternalServiceError).kind).toBe('invalid-request');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('공백만 있는 입력도 fetch 없이 거부한다', async () => {
    const client = await createClient();

    await expect(client.embedQuery('   \n ')).rejects.toMatchObject({
      service: 'tei',
      kind: 'invalid-request',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('정상 문자열이면 fetch를 한 번 부른다', async () => {
    // 위 두 케이스와 짝이다. 이게 없으면 구현이 항상 거부해도 통과한다.
    const client = await createClient();
    await client.embedQuery('a');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('빈 배열 응답은 empty-response다', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([]));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('빈 벡터 응답도 empty-response다', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([[]]));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'empty-response',
    });
  });

  it('400은 invalid-request이고 본문을 파싱하지 않는다', async () => {
    const body = jsonResponse({ error: '입력이 너무 김' }, 400);
    const jsonSpy = jest.spyOn(body, 'json');
    fetchSpy.mockResolvedValue(body);
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'invalid-request',
    });
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('500은 upstream이다', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: '모델 로딩 중' }, 500));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('중단은 timeout이다 (공통 판정 재사용)', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('시간 초과'), { name: 'TimeoutError' }),
    );
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      service: 'tei',
      kind: 'timeout',
    });
  });

  it('연결 거부는 unavailable이다 (cause에 숨어 있어도)', async () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    fetchSpy.mockRejectedValue(new TypeError('fetch failed', { cause: inner }));
    const client = await createClient();

    await expect(client.embedQuery('실내 박물관')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- src/clients/tei/tei.client.spec.ts
```

Expected: FAIL — `Cannot find module './tei.client' from 'src/clients/tei/tei.client.spec.ts'`

- [ ] **Step 3: 구현**

`backend/src/clients/external-service.error.ts` — **`ExternalService` 유니온 한 줄만 바꾼다.** 교체 전:

```ts
export type ExternalService = 'gemini' | 'qdrant';
```

교체 후:

```ts
export type ExternalService = 'gemini' | 'qdrant' | 'tei';
```

`backend/src/clients/tei/tei.client.ts` 신규 파일 전문:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { callExternal } from '../call-external';
import { ExternalServiceError } from '../external-service.error';
import { classifyTeiFailure } from './tei.errors';

/**
 * 자체 호스팅 서버의 단문 임베딩 한 건이고, TEI는 모델 로딩 중에 5xx를 내므로
 * 5초를 넘길 정상 경로가 없다. env로 열지 않는다.
 */
const TEI_TIMEOUT_MS = 5000;

/**
 * TEI 질의 임베딩 클라이언트.
 *
 * 색인용 배치 임베딩(embed(texts[]))을 노출하지 않는다 — backend에 배치 호출자가
 * 없고, 노출하면 색인을 backend에서 하려는 유혹이 함께 들어온다.
 * 단건 반환 타입 number[]가 "[0]을 꺼내고 undefined를 체크하는" 실수를
 * 타입에서 없앤다(core가 실제로 그 체크를 반복한다 — enricher.ts:250-255).
 */
@Injectable()
export class TeiClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    // 생성자는 네트워크를 만지지 않는다.
    this.baseUrl = config.getOrThrow<string>('TEI_BASE_URL');
  }

  /**
   * 질의 텍스트 한 건을 임베딩 벡터로 만든다. 색인과 같은 설정으로 고정돼 있다.
   *
   * normalize·truncate·prompt_name을 인자로 받지 않는 이유는, 색인이 만들어진
   * 조건과 다르게 질의할 수 있는 경로를 만들지 않기 위해서다. 요청 바디는
   * core/src/clients/tei.ts:22-31과 같아야 한다 — 갈리면 같은 텍스트가
   * 두 워크스페이스에서 다른 벡터가 된다.
   */
  embedQuery(text: string): Promise<number[]> {
    return callExternal(
      'tei',
      `embed(text=${text.length}자)`,
      // TEI는 SDK가 없어 throw되는 오류가 전부 fetch의 것이다 — 공통 판정에 맡긴다.
      () => null,
      async () => {
        if (text.trim() === '') {
          // core는 빈 배열을 빈 배열로 돌려주지만 backend의 입력은 질의 한 건이고,
          // 빈 질의로 검색하는 것은 호출자의 버그다. TEI를 부르지 않고 끊는다.
          throw new ExternalServiceError(
            'tei',
            'invalid-request',
            '빈 질의는 임베딩할 수 없습니다.',
          );
        }

        const response = await fetch(`${this.baseUrl}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: [text],
            normalize: true,
            truncate: true,
          }),
          signal: AbortSignal.timeout(TEI_TIMEOUT_MS),
        });

        const kind = classifyTeiFailure(response);
        if (kind !== null) {
          // 본문을 파싱하지 않는다 — 에러 JSON이 number[][]로 파싱에 성공하면
          // 쓰레기 벡터가 Qdrant로 간다.
          throw new ExternalServiceError(
            'tei',
            kind,
            `TEI가 ${response.status}로 응답했습니다.`,
          );
        }

        const body = (await response.json()) as unknown;
        const first = Array.isArray(body) ? (body[0] as unknown) : undefined;
        if (!Array.isArray(first) || first.length === 0) {
          throw new ExternalServiceError(
            'tei',
            'empty-response',
            'TEI가 빈 임베딩을 반환했습니다.',
          );
        }

        // 길이를 검사하지 않는다. 검사하려면 기대 차원을 어딘가에 적어야 하고,
        // 그 순간 1024가 backend에 박힌다. 차원 판정은 Qdrant의 일이다.
        return first as number[];
      },
    );
  }
}
```

`backend/src/clients/clients.module.ts` 교체 후 전문 (**추가된 것은 import 1줄 + providers·exports 각 1줄**):

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { GeminiClient } from './gemini/gemini.client';
import { QdrantSearchClient } from './qdrant/qdrant.client';
import { TeiClient } from './tei/tei.client';

/**
 * 외부 서비스 클라이언트 모음.
 *
 * @Global()을 쓰지 않는다 — 전역 모듈은 의존 관계를 모듈 그래프에서 지운다
 * (DatabaseModule이 전역이 아닌 것과 같은 이유). 소비자가 생기면 그 모듈이
 * 이 모듈을 import한다. 이번엔 AppModule에 넣지 않는다 — 지금 배선하면
 * chat이 클라이언트를 주입하는 시점에 지워야 할 import가 된다.
 *
 * imports: [ConfigModule]은 database.module.ts:23과 같은 패턴이다.
 */
@Module({
  imports: [ConfigModule],
  providers: [GeminiClient, TeiClient, QdrantSearchClient],
  exports: [GeminiClient, TeiClient, QdrantSearchClient],
})
export class ClientsModule {}
```

`backend/src/clients/clients.module.spec.ts` 교체 후 전문:

```ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

jest.mock('@google/genai', () => ({ GoogleGenAI: jest.fn() }));
jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn() }));

import { ClientsModule } from './clients.module';
import { GeminiClient } from './gemini/gemini.client';
import { QdrantSearchClient } from './qdrant/qdrant.client';
import { TeiClient } from './tei/tei.client';

describe('ClientsModule', () => {
  it('ConfigModule을 명시 주입하면 클라이언트가 모두 해석된다', async () => {
    // 개발자의 .env에 의존하면 키가 설정된 머신에서만 통과하는 테스트가 된다.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [
            () => ({
              GEMINI_API_KEY: 'test-key',
              TEI_BASE_URL: 'http://tei.test:8080',
              QDRANT_URL: 'http://qdrant.test:6333',
            }),
          ],
        }),
        ClientsModule,
      ],
    }).compile();

    expect(moduleRef.get(GeminiClient)).toBeInstanceOf(GeminiClient);
    expect(moduleRef.get(TeiClient)).toBeInstanceOf(TeiClient);
    expect(moduleRef.get(QdrantSearchClient)).toBeInstanceOf(
      QdrantSearchClient,
    );
  });
});
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint
```

Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 5: 구조 검증 — 공통 파일 변경 범위를 diff로 확인**

`backend/`에서 실행한다.

```bash
git diff --stat tei-base -- src/clients/external-service.error.ts src/clients/call-external.ts src/clients/external-service.filter.ts src/clients/clients.module.ts
git diff tei-base -- src/clients/external-service.error.ts src/clients/call-external.ts src/clients/external-service.filter.ts src/clients/clients.module.ts
```

Expected — **아래와 정확히 일치해야 한다.**

| 파일 | 기대 |
|---|---|
| `external-service.error.ts` | `ExternalService` 유니온에 `\| 'tei'`를 더한 **한 줄만** 변경 |
| `call-external.ts` | **무변경** (diff에 나타나지 않음) |
| `external-service.filter.ts` | **무변경** (diff에 나타나지 않음) |
| `clients.module.ts` | import 1줄 추가 + `providers`·`exports` 각 1줄 수정 |

`--stat`에 `call-external.ts` 또는 `external-service.filter.ts`가 등장하면 **커밋하지 말고 멈춘다.** 공통화 경계가 틀렸다는 뜻이고, 무엇이 새어 나왔는지 리뷰에 올린다 — 네 번째 클라이언트에서 같은 비용을 또 낸다.

확인이 끝나면 태그를 지운다.

```bash
git tag -d tei-base
```

- [ ] **Step 6: 커밋**

```bash
git add backend/src/clients/tei/tei.client.ts backend/src/clients/tei/tei.client.spec.ts backend/src/clients/external-service.error.ts backend/src/clients/clients.module.ts backend/src/clients/clients.module.spec.ts
git commit -m "feat(backend): TEI 질의 임베딩 클라이언트 — 검색 경로가 닫힌다

세 번째 클라이언트가 공통화 경계의 시험대다. TEI는 SDK도 인증도 없어 앞의
둘과 가장 다른데, 공통 파일에서 바뀐 것은 ExternalService 유니온 한 줄과
ClientsModule 두 줄뿐이다 — 공통화한 것들이 'SDK를 감싸는 도구'가 아니라
'외부 실패를 분류하는 도구'였다는 증거다.

배치 시그니처(embed(texts[]))를 노출하지 않는다. backend에 배치 호출자가 없고,
노출하면 색인을 backend에서 하려는 유혹이 함께 들어온다. 단건 반환 number[]가
'[0]을 꺼내고 undefined를 체크하는' 실수를 타입에서 없앤다.

응답 벡터의 길이를 검사하지 않는 이유는 검사하려면 기대 차원을 코드에 적어야
하기 때문이다. 차원 판정은 컬렉션의 실제 값과 대조할 수 있는 Qdrant의 일이다."
```

---

### Task 12: 부팅 배선 — `validateEnv` 확장 · `ConfigModule.forRoot` · e2e setupFiles

`ConfigModule.forRoot({ validate })`를 붙이는 순간 `test/app.e2e-spec.ts`가 env 없이 실패한다. **대응(`setup-env.ts` + `jest-e2e.json`)이 같은 커밋에 들어가야 한다** — 나누면 중간 커밋에서 e2e가 빨간 채로 남는다.

`validateEnv`는 지금 **호출자가 0인 죽은 코드**다(`env.validation.ts:8`). 이 태스크가 그것을 되살린다.

**Files:**
- Modify: `backend/src/config/env.validation.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/.env.example`
- Modify: `backend/test/jest-e2e.json`
- Create: `backend/test/setup-env.ts`
- Test: `backend/src/config/env.validation.spec.ts`

**Interfaces:**
- Consumes: 없음 (클라이언트와 독립적이다 — 클라이언트 spec은 설정을 직접 주입한다)
- Produces: `validateEnv(config)` — 필수 4키 일괄 검증 · `AppModule`이 부팅 시 실행

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/src/config/env.validation.spec.ts` 신규 파일 전문:

```ts
import { validateEnv } from './env.validation';

/**
 * 부팅 시 fail-fast를 담당하는 유일한 지점이다.
 * 값의 도달성은 검사하지 않는다 — 그래야 외부망에서도 부팅이 된다.
 */

function completeEnv(): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgres://user:pw@db:5432/tb',
    GEMINI_API_KEY: 'key',
    TEI_BASE_URL: 'http://tei:8080',
    QDRANT_URL: 'http://qdrant:6333',
  };
}

describe('validateEnv', () => {
  it('필수 키가 모두 있으면 config를 그대로 반환한다', () => {
    const config = completeEnv();
    expect(validateEnv(config)).toBe(config);
  });

  it('선택 키가 없어도 통과한다', () => {
    // GEMINI_MODEL·QDRANT_API_KEY·QDRANT_COLLECTION은 기본값이 있다.
    expect(() => validateEnv(completeEnv())).not.toThrow();
  });

  it('DATABASE_URL이 없으면 throw한다', () => {
    const { DATABASE_URL: _omit, ...rest } = completeEnv();
    expect(() => validateEnv(rest)).toThrow('DATABASE_URL');
  });

  it('TEI_BASE_URL 하나만 없어도 throw한다', () => {
    // 신규 키가 실제로 필수 목록에 들어갔는지 보는 단독 케이스다.
    const { TEI_BASE_URL: _omit, ...rest } = completeEnv();
    expect(() => validateEnv(rest)).toThrow('TEI_BASE_URL');
  });

  it('GEMINI_API_KEY 하나만 없어도 throw한다', () => {
    const { GEMINI_API_KEY: _omit, ...rest } = completeEnv();
    expect(() => validateEnv(rest)).toThrow('GEMINI_API_KEY');
  });

  it('QDRANT_URL 하나만 없어도 throw한다', () => {
    const { QDRANT_URL: _omit, ...rest } = completeEnv();
    expect(() => validateEnv(rest)).toThrow('QDRANT_URL');
  });

  it('빈 문자열도 누락으로 본다', () => {
    expect(() => validateEnv({ ...completeEnv(), QDRANT_URL: '' })).toThrow(
      'QDRANT_URL',
    );
  });

  it('전부 없으면 네 키 이름이 한 메시지에 모두 등장한다', () => {
    // 하나씩 알려주면 네 개가 비어 있을 때 네 번 재실행해야 한다.
    let message = '';
    try {
      validateEnv({});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('GEMINI_API_KEY');
    expect(message).toContain('TEI_BASE_URL');
    expect(message).toContain('QDRANT_URL');
    // 메시지 형식은 core의 requireEnv(core/src/lib/env.ts:5)와 같게 유지한다.
    expect(message).toContain('설정되지 않았습니다');
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- src/config/env.validation.spec.ts
```

Expected: FAIL — `TEI_BASE_URL 하나만 없어도 throw한다` 등 4건 실패. 현행 `validateEnv`는 `DATABASE_URL`만 본다.

- [ ] **Step 3: 구현**

`backend/src/config/env.validation.ts` 교체 후 전문:

```ts
/**
 * 필수 환경 변수. 여기에 키를 더하면 .env.example과 test/setup-env.ts도 함께 고친다
 * (.claude/skills/tb-tdd-implement/references/workspaces.md의 경계표 참조).
 */
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'TEI_BASE_URL',
  'QDRANT_URL',
] as const;

/**
 * 환경 변수 검증. core/src/lib/env.ts의 requireEnv와 같은 규칙 —
 * 없거나 빈 문자열이면 throw한다.
 *
 * 부팅 시점에 실패시키는 이유는, DATABASE_URL이 비어 있으면 TypeORM이
 * localhost로 조용히 붙으려 하다 커넥션 단계에서야 터지기 때문이다.
 * 외부 서비스 키도 같다 — 없으면 첫 요청이 올 때까지 문제가 드러나지 않는다.
 *
 * 값의 도달성은 검사하지 않는다. 이 성질이 사내망 밖에서도 부팅을 가능하게 한다.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  // 누락 키를 전부 모아 한 번에 보고한다. 하나씩 알려주면 네 개가 비어 있을 때
  // 네 번 재실행해야 한다.
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value === '';
  });

  if (missing.length > 0) {
    throw new Error(`환경 변수 ${missing.join(', ')}가 설정되지 않았습니다.`);
  }
  return config;
}
```

`backend/src/app.module.ts` 교체 후 전문:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatModule } from './chat/chat.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    // 필수 env를 부팅 시 한 번에 확인한다. 네트워크를 요구하지 않으므로
    // 사내망 밖에서도 부팅이 매달리지 않는다. ClientsModule은 아직 배선하지
    // 않는다 — 소비자가 생길 때 그 모듈이 직접 import한다.
    ConfigModule.forRoot({ validate: validateEnv, cache: true }),
    ChatModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

`backend/test/setup-env.ts` 신규 파일 전문:

```ts
/**
 * e2e 부팅용 더미 env.
 *
 * AppModule의 ConfigModule.forRoot({ validate })가 필수 키의 부재를 부팅 실패로
 * 처리하므로, 이 파일이 없으면 test/app.e2e-spec.ts가 env 없이 죽는다.
 * e2e가 검증하는 것은 HTTP 라우팅이지 실제 자격증명이 아니다.
 *
 * 더미 값이 실제 오설정을 가리지 않는 이유는, 이 파일이 e2e 실행에만 적용되고
 * 운영 부팅 경로에는 없기 때문이다. 주소를 discard 포트(9)로 둔 것은 실수로
 * 외부 호출이 일어나면 조용히 성공하는 대신 즉시 실패하게 하려는 것이다.
 *
 * 키를 더할 때는 src/config/env.validation.ts의 REQUIRED_KEYS와 .env.example을
 * 함께 본다.
 */
process.env.DATABASE_URL ??= 'postgres://e2e:e2e@127.0.0.1:5432/e2e';
process.env.GEMINI_API_KEY ??= 'e2e-dummy-gemini-key';
process.env.TEI_BASE_URL ??= 'http://127.0.0.1:9';
process.env.QDRANT_URL ??= 'http://127.0.0.1:9';
```

`backend/test/jest-e2e.json` 교체 후 전문:

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "setupFiles": ["<rootDir>/setup-env.ts"],
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  }
}
```

`backend/.env.example` 교체 후 전문:

```
# PostgreSQL — core와 같은 DB를 가리킨다 (사내망에서만 도달)
DATABASE_URL=

# Gemini (생성 전용) — core와 같은 키 이름·기본값을 쓴다
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash

# TEI (Text Embeddings Inference) — 질의 임베딩. 인증 없음
TEI_BASE_URL=http://localhost:8080

# Qdrant — 읽기 전용. 컬렉션 소유권은 core에 있다
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=tour_contents

# 앱
# 3000은 Next.js 개발 서버가 쓰므로 비워두고 3001로 띄운다.
PORT=3001
NODE_ENV=development
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npm run test:e2e
npx tsc --noEmit -p tsconfig.json
npm run lint
npm run build
```

Expected: PASS 전부. **e2e의 `/ (GET)`이 200을 유지해야 한다** — `setupFiles`가 붙지 않았거나 더미 값이 부족하면 `환경 변수 ...가 설정되지 않았습니다.`로 부팅 단계에서 죽는다.

- [ ] **Step 5: 커밋**

```bash
git add backend/src/config/env.validation.ts backend/src/config/env.validation.spec.ts backend/src/app.module.ts backend/.env.example backend/test/setup-env.ts backend/test/jest-e2e.json
git commit -m "feat(backend): 필수 env 4개를 부팅 시 일괄 검증

validateEnv는 정의만 있고 호출자가 없는 죽은 코드였다. ConfigModule.forRoot의
validate로 붙여 되살리고 GEMINI_API_KEY·TEI_BASE_URL·QDRANT_URL을 필수에 더한다.
도달성은 검사하지 않는다 — 이 성질이 사내망 밖에서도 부팅을 가능하게 한다.

누락 키를 한 번에 모아 보고하는 이유는, 하나씩 알려주면 네 개가 비어 있을 때
네 번 재실행해야 하기 때문이다.

setup-env.ts와 jest-e2e.json이 같은 커밋에 있는 이유는 validate가 붙는 순간
e2e가 env 없이 죽기 때문이다. 나누면 중간 커밋에서 e2e가 빨간 채로 남는다."
```

---

### Task 13: `workspaces.md` 경계표에 5행 등록

같은 서비스의 클라이언트가 저장소에 두 벌 존재하고, 공유 패키지 승격 계획이 없으므로 **그 비용은 영구적이다.** 타입 시스템이 어긋남을 전혀 잡지 못한다. 이 등록이 상시로 작동하는 유일한 방어선이다(`two-columns-one-state.md`).

**Files:**
- Modify: `.claude/skills/tb-tdd-implement/references/workspaces.md`

**Interfaces:**
- Consumes: Task 1~12가 만든 파일 경로
- Produces: 경계표 5행

- [ ] **Step 1: 현행을 확인**

```bash
git diff --stat
```

`.claude/skills/tb-tdd-implement/references/workspaces.md`의 "워크스페이스 경계 — 바꿀 때 함께 봐야 하는 짝" 표(현재 5행)를 읽는다. 이 태스크는 문서 변경이라 자동 테스트가 없다 — 표의 마지막 행(`backend/.env.example` 행) **바로 아래**에 아래 5행을 추가한다.

- [ ] **Step 2: 구현**

`.claude/skills/tb-tdd-implement/references/workspaces.md`의

```markdown
| `backend/.env.example` | `backend/src/config/env.validation.ts` |
```

바로 아래에 추가:

```markdown
| `core/src/lib/qdrantCollection.ts`의 `toPayload` 키·`EXPECTED_DISTANCE` | `backend/src/clients/qdrant/tour-content-payload.ts`의 `TourContentPayload`·`TourSearchFilter` |
| `core/src/clients/tei.ts`의 `embed` 요청 바디(`normalize`/`truncate`/`prompt_name`) | `backend/src/clients/tei/tei.client.ts`의 `embedQuery` 고정 옵션 |
| TEI 서버에 떠 있는 임베딩 모델 (벡터 차원·distance를 결정한다) | Qdrant 컬렉션의 실제 차원. backend는 코드로 강제하지 않는다 — `getCollectionInfo()` 실측이 유일한 확인 |
| `core/src/clients/gemini.ts`의 기본 모델(`GEMINI_MODEL` fallback) | `backend/src/clients/gemini/gemini.client.ts`의 기본 모델 |
| `core/.env.example`의 `GEMINI_*`·`TEI_BASE_URL`·`QDRANT_*` | `backend/.env.example`, `backend/src/config/env.validation.ts`의 `REQUIRED_KEYS`, `backend/test/setup-env.ts` |
```

- [ ] **Step 3: 통과를 확인**

표가 10행이 됐는지, 위 5행이 참조하는 파일이 **전부 실제로 존재하는지** 확인한다. 저장소 루트에서:

```bash
ls core/src/lib/qdrantCollection.ts core/src/clients/tei.ts core/src/clients/gemini.ts core/.env.example
ls backend/src/clients/qdrant/tour-content-payload.ts backend/src/clients/tei/tei.client.ts backend/src/clients/gemini/gemini.client.ts backend/.env.example backend/src/config/env.validation.ts backend/test/setup-env.ts
```

Expected: 10개 경로 전부 존재. 하나라도 없으면 앞 태스크가 미완이다.

- [ ] **Step 4: 커밋**

```bash
git add .claude/skills/tb-tdd-implement/references/workspaces.md
git commit -m "docs: core↔backend 클라이언트 중복을 경계표에 등록

같은 서비스의 클라이언트가 두 벌 존재하고, 공유 패키지 승격 계획이 없어
그 비용이 영구적이다. payload 키·컬렉션 이름·벡터 차원·distance·Gemini
기본 모델명·TEI 요청 바디가 두 워크스페이스에 각각 적혀 있고 타입 시스템은
어긋남을 전혀 잡지 못한다.

없앨 수 없으니 관리한다 — 이 표가 상시로 작동하는 유일한 방어선이다."
```

---

## 리뷰 묶음

| 묶음 | 태스크 | 논리 단위 | 이렇게 나눈 이유 |
|---|---|---|---|
| **A** | 1~3 | 공통 기반 — 의존성 · 오류 타입 · 호출 통로 · HTTP 매핑 | 뒤의 모든 태스크가 이 위에 쌓인다. 여기서 `kind` 목록이나 `callExternal`의 계약이 틀리면 나머지 10개 태스크가 전부 어긋난 기반 위에 얹힌다. **가장 먼저·가장 세게 봐야 하는 묶음**이다. spec 미결정 1·3이 여기 있다 |
| **B** | 4~5 | Gemini 클라이언트 | 첫 번째 클라이언트가 공통 기반을 실제로 쓴다. "판정 순수 함수 + 클라이언트"라는 서비스별 반복 패턴이 여기서 확정되고, C·D가 그 패턴을 따른다. 두 태스크지만 하나의 완결 단위라 쪼갤 이유가 없다 |
| **C** | 6~9 | Qdrant 클라이언트 + 모듈 등록 | payload 계약(core와의 경계면)·읽기 전용 표면·"0건 vs 전 건 실패" 분기가 한 덩어리다. `ClientsModule`을 여기 넣은 이유는 **D의 판정 기준(두 줄 추가)이 성립하려면 두 클라이언트 상태의 모듈이 먼저 커밋돼 있어야** 하기 때문이다. spec 미결정 2가 여기 있다 |
| **D** | 10~11 | TEI + **구조 검증** | 이 묶음의 리뷰 대상은 코드가 아니라 **판정**이다. "공통 파일에서 유니온 한 줄 외에 아무것도 바뀌지 않았는가"가 통과/불통과를 가른다. 다른 태스크와 섞으면 diff에 잡음이 섞여 증거가 사라진다 — **반드시 독립 묶음이어야 한다** |
| **E** | 12~13 | 부팅 배선 + 경계표 등록 | 클라이언트 코드와 독립적이고(클라이언트 spec은 설정을 직접 주입한다) 검증 방식도 다르다 — e2e 통과 여부와 문서 정합성이다. 12를 쪼개면 중간 커밋에서 e2e가 빨간 채로 남으므로 태스크 내부도 쪼개지 않는다 |

---

## 최종 검증

`backend/`에서 실행한다.

- [ ] `npx tsc --noEmit -p tsconfig.json` 통과
- [ ] `npm test` — 신규 테스트 전부 통과, **기존 `chat.controller.spec.ts`·`app.controller.spec.ts`도 그대로 통과**
- [ ] `npm run test:e2e` 통과 (`setupFiles` 추가 후에도 `/ (GET)`이 200)
- [ ] `npm run lint` — 자동 수정 결과를 확인하고 커밋에 반영
- [ ] `npm run build` 성공
- [ ] **구조 검증** — Task 11 Step 5의 diff 결과가 기대표와 일치 (`call-external.ts`·`external-service.filter.ts` 무변경)
- [ ] **테스트 수 대조** — spec 에러 처리 표 22행 대비 테스트가 짝을 이루는지 확인한다. 특히 겉모습이 같은 쌍: `hit 0건은 실패가 아니다` ↔ `hit은 있는데 전 건 파싱 실패는 실패다`, `TEI 빈 응답은 실패다` ↔ `정상 벡터는 그대로 통과한다`, `빈 질의는 fetch 0회` ↔ `정상 질의는 fetch 1회`

### 실측 (별도 단계 — spec `:756-774`)

**전제:** 실행 환경에서 `TEI_BASE_URL`·`QDRANT_URL`에 도달할 수 있어야 하고, TEI에는 색인을 만든 것과 **같은 모델(bge-m3)** 이 떠 있어야 한다. **도달할 수 없으면 여기까지를 미완으로 보고한다 — 통과했다고 적지 않는다.**

`npm run build` 후 `node -e`로 `dist`의 클라이언트를 직접 불러 확인한다. 소비자 모듈이 없어 서버를 띄우는 것으로는 아무것도 증명되지 않는다.

- [ ] `getCollectionInfo()`의 `vectorSize`·`distance`가 core의 값(1024 · `Cosine`)과 일치
- [ ] `(await tei.embedQuery('차원 확인')).length === (await qdrant.getCollectionInfo()).vectorSize` — **두 값을 코드로 비교한다.** 어느 쪽도 하드코딩하지 않고 계약을 확인하는 유일한 방법
- [ ] `embedQuery('아이랑 갈 실내 관광지')` → `search(vector, { limit: 10 })` → hit 10건, 모든 hit에 `payload.contentid` 존재, score 내림차순
- [ ] **상위 결과 사람 판정** — 위 질의의 상위 3건 `payload.title`을 사람이 읽고 질의와 맞는지 본다
- [ ] **질의 대조군** — `'바닷가 일출 명소'`와 `'실내 박물관'`의 상위 5건이 서로 다르다
- [ ] `filter: { contenttypeid: '12' }` → 모든 hit의 `payload.contenttypeid === '12'`, 필터 없는 같은 질의보다 결과가 좁아짐
- [ ] 3차원 벡터로 `search` → `kind === 'dimension-mismatch'` 또는 `'invalid-request'`. **빈 배열이 아님**
- [ ] `QDRANT_COLLECTION=없는이름` → `kind === 'not-found'`. **빈 배열이 아님**
- [ ] `QDRANT_URL`을 닫힌 포트로 → `kind === 'unavailable'`, **5초 이내** 반환 (SDK 기본 300초가 아님)
- [ ] `TEI_BASE_URL`을 닫힌 포트로 → `kind === 'unavailable'`, 5초 이내 반환
- [ ] `generate('안녕')` → 비어 있지 않은 문자열, 20초 이내
- [ ] `GEMINI_API_KEY=invalid` → `kind === 'auth'`, **오류 메시지와 로그 어디에도 키 문자열이 없음**

`quota`(429)는 실측하지 않는다 — 억지로 쿼터를 태우는 것은 비용이고, 판정 로직은 core에서 이미 운영 중인 규칙과 같다.
