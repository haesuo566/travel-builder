# backend CORS 설정 구현 계획

> **For agentic workers:** 이 계획은 `tb-harness`의 work 단계가 태스크 묶음 단위로 실행한다.
> 각 Step의 체크박스(`- [ ]`)를 완료할 때마다 갱신한다.

**Goal:** 브라우저의 프론트엔드(`http://localhost:3000`)가 backend의 `POST /chat`을 CORS로 호출할 수 있게 된다.

**Architecture:** 허용 origin을 필수 환경 변수 `CORS_ORIGIN`으로 받고, `configureApp()`이 `app.enableCors()`를 붙인다. `configureApp`은 origin을 **인자로 받는다** — 컨테이너에서 꺼내지 않으므로 호출부 세 곳 전부를 타입 검사가 강제로 짚어주고, ConfigModule을 import하지 않는 프로브 e2e도 계속 이 함수를 태울 수 있다. 안전 장치는 두 개다: 부팅 시 `validateEnv`가 키 부재를 실패로 끊고, e2e가 **허용/비허용 origin 짝**으로 와일드카드 회귀를 막는다.

**Tech Stack:** NestJS 11 · `@nestjs/config` · `cors@2.8.6`(Nest가 번들) · jest + supertest

**설계 문서:** 없음. 하네스 규모 축약 규칙(단일 워크스페이스 · 태스크 3개 이하)에 따라 spec을 생략하고 결정을 아래 절에 인라인했다. 원본은 `.claude/_workspace/2026-07-28-backend-cors/journal.md`의 "사용자 결정" 절이다.

---

## 결정

### 사용자 승인 완료 (재검토 대상 아님)

| 항목 | 결정 | 근거 |
|---|---|---|
| 허용 origin | **필수 env 키 `CORS_ORIGIN`** | 저장소의 ConfigModule + `validateEnv` 관용구를 따른다. "`ConfigService.get`의 두 번째 인자(기본값)를 쓰지 않는다" 규칙 때문에 optional + 기본값이 아니라 필수 키가 된다 |
| 와일드카드 | **채택 안 함** | `origin: true`는 임의 사이트 JS의 호출을 허용하고, 되돌릴 계기가 없어 그대로 배포되기 쉽다 |
| 배선 위치 | `src/app.setup.ts`의 `configureApp` | main.ts와 e2e가 같은 함수를 부르므로 테스트가 그 줄을 태울 수 있다 |
| credentials | **미설정** | 인증·쿠키가 아직 없다. 켜면 와일드카드 금지 등 제약이 따라오므로 필요해질 때 켠다 |
| 로컬 값 | `CORS_ORIGIN=http://localhost:3000` | Next.js 개발 서버의 origin |
| 동기화 지점 | `env.validation.ts`의 `REQUIRED_KEYS` · `.env.example` · `test/setup-env.ts` · `.env`(gitignore) | `workspaces.md` 경계표 122행 |

### 계획 작성 중 확정한 결정 (승인된 결정에 없던 것 — 오케스트레이터가 사용자에게 올릴 항목)

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| D-1 | `configureApp` 시그니처 | **`configureApp(app: INestApplication, corsOrigin: string): void`** — origin을 인자로 받는다. `app.get(ConfigService)`를 쓰지 않는다 | 아래 "D-1 근거" 참조 |
| D-2 | `enableCors`의 `origin` 형태 | **배열 `[corsOrigin]`** — 문자열로 넘기지 않는다 | 아래 "D-2 근거" 참조 |

#### D-1 근거 — `app.get(ConfigService)`는 호출부 하나를 부팅 단계에서 죽인다

`configureApp`의 현재 호출부는 세 곳이다(실측: `grep -rn configureApp --include=*.ts`).

| 호출부 | 컨테이너에 `ConfigService`가 있는가 |
|---|---|
| `src/main.ts:7` | 있음 — `AppModule`이 `ConfigModule.forRoot({ validate })`를 import한다 |
| `src/chat/chat.controller.spec.ts:99` | 있음 — 다만 `load: [() => ENV]`의 `ENV`에 `CORS_ORIGIN`이 없다(`skipProcessEnv: true`, `ignoreEnvFile: true`) |
| `test/external-service.e2e-spec.ts:55` | **없음** — `Test.createTestingModule({ controllers: [WiringProbeController] })`뿐이다 |

즉 `app.get(ConfigService)`를 쓰면 세 번째 호출부가 부팅 단계에서 죽고, 그 파일에 `ConfigModule`을 끼워 넣어야 한다 — 전역 배선만 태우려고 만든 프로브 모듈에 env 배선을 들이는 셈이다. 두 번째 호출부도 `ENV`에 키를 더해야 한다.

인자로 받으면 반대가 된다. 타입 검사가 호출부 **전부**를 열거해준다(실측):

```
src/chat/chat.controller.spec.ts(99,5): error TS2554: Expected 2 arguments, but got 1.
src/main.ts(7,3): error TS2554: Expected 2 arguments, but got 1.
test/external-service.e2e-spec.ts(55,5): error TS2554: Expected 2 arguments, but got 1.
```

`workspaces.md` 경계표의 짝들이 위험한 이유가 "타입 시스템이 연결해주지 않는다"인데, 여기서는 **연결시킬 수 있는** 선택지가 있다. 그쪽을 택한다.

#### D-2 근거 — 문자열로 넘기면 부정 단정이 성립하지 않는다

`cors@2.8.6`의 `configureOrigin`(`node_modules/cors/lib/index.js`)은 `origin`의 타입에 따라 다르게 동작한다.

| `origin` 형태 | 비허용 origin으로 온 요청의 응답 |
|---|---|
| 문자열 `'http://localhost:3000'` | `Access-Control-Allow-Origin: http://localhost:3000` — **요청 Origin과 무관하게 항상 붙는다** |
| 배열 `['http://localhost:3000']` | `isOriginAllowed`를 거쳐 불일치면 헤더가 **아예 빠진다** |

두 형태 모두 브라우저는 결국 차단하므로 보안 결과는 같다. 그러나 **문자열이면 "허용되지 않은 origin에는 헤더가 붙지 않는다"는 테스트를 쓸 수 없다.** 요구된 부정 단정이 성립하려면 배열이어야 한다. 실측으로 확인했다 — 배열 → 문자열 뮤테이션은 부정 케이스를 빨간불로 만든다(Task 2의 "뮤테이션 실측" 참조).

여러 origin 허용은 범위 밖이다. `CORS_ORIGIN`은 단일 값이며 콤마 분리 파싱을 넣지 않는다.

---

## Global Constraints

- 작업 디렉터리는 `backend/`. **모든 명령과 `git add` 경로는 거기서 실행한다** (루트에 package.json이 없다).
- 주석·로그 메시지·에러 메시지·커밋 메시지는 **한국어**로 쓴다.
- 테스트 명령: 단위 `npm test` · e2e `npm run test:e2e`.
- 타입 검사: **`npx tsc --noEmit -p tsconfig.json`** (`npm run typecheck` 스크립트가 없다).
- 린트 게이트: **`npx eslint src test --max-warnings=0`**. warn도 실패다. `npm run lint`는 `--fix`가 붙어 파일을 수정하므로 결과를 확인하고 쓴다.
- eslint가 `recommendedTypeChecked`다 — `no-unsafe-assignment`·`no-unsafe-member-access`가 error. 이 계획의 모든 코드 블록은 `backend/`에서 tsc·lint·test·e2e·build를 실제로 통과시킨 뒤 옮겼다.
- **기준은 이 계획의 코드 블록이 아니라 커밋된 코드다.** 블록을 덮기 전에 현재 파일과 대조한다 — 줄 수·테스트 개수가 다르면 계획이 낡은 것이다.
- `backend/.env`는 **gitignore 대상**이다. 로컬 실행에는 필요하지만 커밋에는 들어가지 않는다.
- 절대 하지 않을 것:
  - `origin: true` / `'*'` 와일드카드
  - `credentials: true` (인증·쿠키가 생길 때 별도 실행으로)
  - `ConfigService.get(key, default)`의 두 번째 인자
  - 프론트엔드 파일 수정 — 이번 범위는 backend의 CORS 설정만이다

## 계획 작성 중 실측한 것

아래는 **검증 명령 단위**의 실측 결과다. 태스크 안의 기대 수치는 각 태스크 본문에 두고 여기로 끌어올리지 않는다.

| 태스크 경계 | `tsc` | `npm test` | `eslint src test --max-warnings=0` | `test:e2e` | `build` |
|---|---|---|---|---|---|
| Task 1 완료 시점 | 통과(실측) | 통과(실측) 17 suites / 319 tests | 통과(실측) | 통과(실측) 2 suites / 3 tests | 통과(실측) |
| Task 2 완료 시점 | 통과(실측) | 통과(실측) 17 suites / 319 tests | 통과(실측) | 통과(실측) 2 suites / 6 tests | 통과(실측) |

각 경계를 **따로** 통과시켰다(최종 상태 하나만 통과시키면 중간 태스크의 `no-unused-vars`를 못 본다). 확인 후 작업 트리는 HEAD로 원복했다.

---

### Task 1: `CORS_ORIGIN`을 필수 env 키로 추가한다

CORS 설정이 읽을 값의 출처를 만든다. 키가 없으면 부팅이 실패해야 한다 — 기본값을 주면 운영에서 localhost가 조용히 허용된다. 이 태스크는 **네 곳의 동기화를 한 커밋 안에서 닫는다**(`workspaces.md` 경계표 122행).

**Files:**
- Modify: `backend/src/config/env.validation.ts`
- Modify: `backend/.env.example`
- Modify: `backend/test/setup-env.ts`
- Modify: `backend/.env` ← **gitignore 대상. 로컬 실행용이며 커밋에 넣지 않는다**
- Test: `backend/src/config/env.validation.spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `REQUIRED_KEYS`에 `'CORS_ORIGIN'` — Task 2의 `main.ts`가 `getOrThrow<string>('CORS_ORIGIN')`으로 소비한다

- [x] **Step 1: 실패하는 테스트 작성**

`backend/src/config/env.validation.spec.ts`에 세 군데를 고친다.

**(1)** `completeEnv()`의 반환 객체 맨 끝에 `CORS_ORIGIN` 한 줄을 추가한다. 교체 후 전문:

```ts
function completeEnv(): Record<string, unknown> {
  return {
    DATABASE_URL: 'postgres://user:pw@db:5432/tb',
    GEMINI_API_KEY: 'key',
    TEI_BASE_URL: 'http://tei:8080',
    QDRANT_URL: 'http://qdrant:6333',
    CORS_ORIGIN: 'http://localhost:3000',
  };
}
```

**(2)** `it('QDRANT_URL 하나만 없어도 throw한다', ...)`와 `it('빈 문자열도 누락으로 본다', ...)` **사이**에 단독 케이스를 추가한다. 기존 단독 케이스들과 같은 형태다:

```ts
  it('CORS_ORIGIN 하나만 없어도 throw한다', () => {
    // 이 키가 없으면 브라우저가 프론트엔드의 POST /chat을 CORS로 막는다.
    // 기본값을 주지 않는 이유는 운영에서 localhost가 조용히 허용되는 편보다
    // 부팅이 실패하는 편이 낫기 때문이다.
    expect(() => validateEnv(envWithout('CORS_ORIGIN'))).toThrow('CORS_ORIGIN');
  });
```

**(3)** 마지막 케이스는 이름과 주석에 "네 키"라는 개수가 박혀 있다. 키를 더할 때마다 낡으므로 개수를 지운다. `it('전부 없으면 네 키 이름이 ...')` 블록 전체의 교체 후 전문:

```ts
  it('전부 없으면 필수 키 이름이 한 메시지에 모두 등장한다', () => {
    // 하나씩 알려주면 여러 개가 비어 있을 때 그 개수만큼 재실행해야 한다.
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
    expect(message).toContain('CORS_ORIGIN');
    // 메시지 형식은 core의 requireEnv(core/src/lib/env.ts:5)와 같게 유지한다.
    expect(message).toContain('설정되지 않았습니다');
  });
```

- [x] **Step 2: 실패를 확인**

```
npx jest src/config/env.validation.spec.ts
```

Expected: FAIL — 2건. 실측 메시지:

```
● validateEnv › CORS_ORIGIN 하나만 없어도 throw한다
  Expected substring: "CORS_ORIGIN"
  Received function did not throw

● validateEnv › 전부 없으면 필수 키 이름이 한 메시지에 모두 등장한다
  Expected substring: "CORS_ORIGIN"
  Received string:    "환경 변수 DATABASE_URL, GEMINI_API_KEY, TEI_BASE_URL, QDRANT_URL가 설정되지 않았습니다."
```

`Tests: 2 failed, 7 passed, 9 total`

- [x] **Step 3: 구현**

`backend/src/config/env.validation.ts`의 `REQUIRED_KEYS`에 키를 더하고, 아래 함수 본문 주석의 "네 개"도 개수 비의존으로 바꾼다.

`REQUIRED_KEYS` 교체 후 전문:

```ts
const REQUIRED_KEYS = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'TEI_BASE_URL',
  'QDRANT_URL',
  'CORS_ORIGIN',
] as const;
```

`validateEnv` 안 `const missing = ...` 바로 위 두 줄 주석의 교체 후 전문:

```ts
  // 누락 키를 전부 모아 한 번에 보고한다. 하나씩 알려주면 여러 개가 비어 있을 때
  // 그 개수만큼 재실행해야 한다.
```

- [x] **Step 4: env 동기화 — 파일 셋을 하나도 빼지 않는다**

`REQUIRED_KEYS`만 고치면 컴파일과 단위 테스트는 통과하고 **e2e 부팅이 죽는다.** 파일별로 처리한다.

**(1)** `backend/.env.example` — `NODE_ENV=development` 다음(파일 맨 끝)에 추가:

```

# CORS — 브라우저에서 이 origin으로 온 요청만 허용한다. 필수 키다.
# 와일드카드(*)를 쓰지 않는다. 값은 Next.js 개발 서버의 origin이다.
CORS_ORIGIN=http://localhost:3000
```

**(2)** `backend/test/setup-env.ts` — `process.env.QDRANT_URL ??= ...` 다음 줄(파일 맨 끝)에 추가:

```ts
process.env.CORS_ORIGIN ??= 'http://localhost:3000';
```

**(3)** `backend/.env` — 로컬 실행용. **gitignore 대상이므로 커밋에 넣지 않는다.** 없으면 `npm run start:dev`가 부팅에 실패한다. 파일 맨 끝에 추가:

```

# CORS — 브라우저에서 이 origin으로 온 요청만 허용한다. 필수 키다.
CORS_ORIGIN=http://localhost:3000
```

- [x] **Step 5: `setup-env.ts` 누락이 로컬에서 가려지지 않는지 확인**

**e2e를 그냥 돌려서는 (2)의 누락을 잡을 수 없다.** `ConfigModule.forRoot`가 `.env` 파일도 읽으므로, (3)만 해두면 `setup-env.ts`가 비어 있어도 e2e가 통과한다 — 계획 작성 중 실측으로 확인한 함정이다. `.env`를 잠시 감춰서 `setup-env.ts` 단독으로 부팅되는지 본다.

```bash
mv .env .env.hidden ; npm run test:e2e ; mv .env.hidden .env
ls -a | grep -c '^\.env$'
```

Expected: e2e PASS (2 suites / 3 tests), 마지막 줄이 `1`(=`.env` 복원됨).

`setup-env.ts`를 빼먹었다면 이 확인에서 이렇게 실패한다(실측):

```
● AppController (e2e) › / (GET)
  환경 변수 CORS_ORIGIN가 설정되지 않았습니다.
```

- [x] **Step 6: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src test --max-warnings=0
npm run test:e2e
```

Expected: PASS 전부. 실측: 단위 `17 suites / 319 tests`, e2e `2 suites / 3 tests`.

- [x] **Step 7: 커밋**

`.env`는 gitignore 대상이라 아래 목록에 없다. 넣으려 하지 않는다.

```bash
git add src/config/env.validation.ts src/config/env.validation.spec.ts .env.example test/setup-env.ts
git commit -m "feat(backend): CORS_ORIGIN을 필수 env 키로 추가한다

기본값을 주지 않는다. 주면 운영에서 localhost가 조용히 허용되고 그 상태를
되돌릴 계기가 없다. 부팅이 실패하는 편이 낫다.

REQUIRED_KEYS·.env.example·test/setup-env.ts를 한 커밋에서 함께 고친다.
setup-env.ts를 빼면 e2e가 부팅 단계에서 죽는데, 로컬에는 .env가 있어
ConfigModule이 그쪽에서 값을 찾아내므로 e2e를 돌려도 드러나지 않는다."
```

---

### Task 2: `configureApp`이 CORS를 붙인다

`POST /chat`이 브라우저에서 호출 가능해지는 지점이다. `configureApp`에 붙이는 이유는 main.ts와 e2e가 같은 함수를 부르기 때문이다 — main.ts 안에만 있으면 어떤 테스트도 그 줄을 태우지 못한다.

**Files:**
- Modify: `backend/src/app.setup.ts`
- Modify: `backend/src/main.ts`
- Modify: `backend/src/chat/chat.controller.spec.ts` ← 시그니처 변경에 따른 호출부 갱신
- Test: `backend/test/external-service.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 필수 키 `CORS_ORIGIN`
- Produces: `configureApp(app: INestApplication, corsOrigin: string): void` — 인자 하나가 늘었다(D-1)

**테스트를 프로브 라우트에 두는 이유:** 요구사항은 "허용 origin으로 온 `POST /chat`(또는 OPTIONS preflight)"이었다. `POST /chat`은 `ChatService`가 `IntentClassifier`를 거쳐 **Gemini를 왕복한다**(`src/chat/chat.service.ts:33`). e2e에는 Gemini 모킹이 없다(모킹은 단위 spec인 `chat.controller.spec.ts`가 `overrideProvider(GeminiClient)`로 한다). `enableCors`는 전역 미들웨어라 라우트를 가리지 않으므로, 이미 존재하는 `WiringProbeController`(외부 의존 없음)에서 확인하면 같은 것을 증명하면서 외부 호출이 0이다. 그래서 **`test/external-service.e2e-spec.ts`의 프로브 라우트를 쓴다** — 이 파일은 이미 "`configureApp`을 부르면 그게 붙는가"를 고정하는 전용 파일이다.

- [x] **Step 1: 실패하는 테스트 작성**

`backend/test/external-service.e2e-spec.ts`를 세 군데 고친다.

**(1)** 파일 상단 docblock의 마지막 문단을 교체한다. `* 필터가 **무엇을 잡는가**는 ...`으로 시작해 `*/`로 끝나는 부분의 교체 후 전문:

```ts
 * 필터가 **무엇을 잡는가**는 external-service.filter.nest.spec.ts가 이미 고정한다.
 * 여기서 보는 것은 **configureApp을 부르면 그게 붙는가** 하나다 — 파이프·필터·CORS
 * 세 쪽을 한 건씩만 태운다.
 *
 * CORS를 POST /chat이 아니라 이 프로브 컨트롤러로 확인하는 이유는, chat 경로가
 * IntentClassifier를 거쳐 Gemini를 왕복하기 때문이다(src/chat/chat.service.ts:33).
 * enableCors는 전역 미들웨어라 라우트를 가리지 않으므로, 외부 의존이 없는
 * 프로브 라우트에서 확인하는 편이 같은 것을 증명하면서 더 싸다.
 */
```

**(2)** `WiringProbeController` 클래스 닫는 `}`와 `describe('configureApp 전역 배선 (e2e)', ...)` **사이**에 상수 두 개를 추가하고, `beforeAll` 안의 `configureApp(app);`을 두 인자 형태로 바꾼다. `describe` 시작부터 `await app.init();`까지의 교체 후 전문:

```ts
/**
 * 이 파일이 configureApp에 넘기는 값. process.env.CORS_ORIGIN을 읽지 않는다 —
 * 읽으면 setup-env.ts와 개발자 .env 중 무엇이 이겼는지에 따라 단정이 흔들린다.
 */
const ALLOWED_ORIGIN = 'http://localhost:3000';
const DISALLOWED_ORIGIN = 'http://evil.test';

describe('configureApp 전역 배선 (e2e)', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WiringProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    // main.ts가 부르는 것과 같은 함수다. 진입 경로가 둘이면 같은 함수를
    // 재사용하게 만든다(circuit-breaker-entry-paths.md).
    configureApp(app, ALLOWED_ORIGIN);
    await app.init();
```

**(3)** `it('configureApp이 ValidationPipe를 붙인다', ...)` 블록 **다음**(`describe` 맨 끝)에 케이스 세 개를 추가한다:

```ts
  it('configureApp이 허용 origin의 preflight를 통과시킨다', async () => {
    // 프론트엔드의 POST /chat은 Content-Type: application/json이라 브라우저가
    // 먼저 OPTIONS를 보낸다. 이게 막히면 본 요청은 아예 나가지 않는다.
    const res = await request(server)
      .options('/wiring/echo')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('허용 origin의 실제 요청 응답에 CORS 헤더가 붙는다', async () => {
    const res = await request(server)
      .post('/wiring/echo')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ name: '테스트' });

    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('허용되지 않은 origin에는 CORS 헤더를 붙이지 않는다', async () => {
    // 위 케이스와 Origin 헤더만 다른 짝이다. 이 단정이 없으면 origin을 true로
    // 바꿔 임의 사이트를 허용해도 전 스위트가 초록불이다.
    //
    // status 201을 함께 단정하는 이유: 헤더 부재만 보면 enableCors를 통째로
    // 지워도 통과한다. cors는 요청을 서버에서 막지 않고 헤더만 뺀다 —
    // 차단은 브라우저가 한다. 그래서 "요청은 처리됐고 헤더만 없다"까지가
    // 이 케이스가 고정하려는 상태다.
    const res = await request(server)
      .post('/wiring/echo')
      .set('Origin', DISALLOWED_ORIGIN)
      .send({ name: '테스트' });

    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
```

- [x] **Step 2: 실패를 확인**

```
npm run test:e2e
```

Expected: FAIL — 2건. 실측 메시지:

```
● configureApp 전역 배선 (e2e) › configureApp이 허용 origin의 preflight를 통과시킨다
  Expected: 204
  Received: 404

● configureApp 전역 배선 (e2e) › 허용 origin의 실제 요청 응답에 CORS 헤더가 붙는다
  Expected: "http://localhost:3000"
  Received: undefined
```

`Tests: 2 failed, 4 passed, 6 total`

**세 번째 케이스(부정 단정)는 이 시점에 통과한다.** CORS가 아예 없으면 헤더도 없으므로 당연하다 — 부정 단정은 아무 일도 하지 않는 구현을 통과시킨다(`negative-assertions-resist-mutation.md`). 그래서 이 케이스의 방어 대상은 "CORS 부재"가 아니라 "**와일드카드로의 회귀**"이며, 그건 Step 5의 뮤테이션 실측이 확인한다. `2 failed`가 나오는지만 보고 3건을 기대하지 않는다.

또한 인자를 2개로 늘린 것 자체는 e2e를 컴파일 단계에서 막지 않는다(ts-jest가 통과시키고 JS는 추가 인자를 무시한다). RED는 컴파일 에러가 아니라 위 두 건의 행동으로 드러난다 — 실측이다.

- [x] **Step 3: 구현**

`backend/src/app.setup.ts`의 docblock 마지막 부분과 함수 시그니처·첫 줄을 고친다. `configureApp`의 닫는 docblock부터 `app.useGlobalPipes(` 직전까지의 교체 후 전문:

```ts
 * corsOrigin을 ConfigService에서 직접 꺼내지 않고 인자로 받는 이유는 두 가지다.
 * (1) 호출부 중 test/external-service.e2e-spec.ts는 ConfigModule을 import하지
 * 않는 프로브 모듈이라 app.get(ConfigService)가 부팅 단계에서 죽는다.
 * (2) 인자로 받으면 키를 더할 때 타입 검사가 호출부 전부를 강제로 짚어준다 —
 * 컨테이너에서 꺼내면 그 연결이 런타임까지 미뤄진다.
 */
export function configureApp(app: INestApplication, corsOrigin: string): void {
  // 배열로 넘긴다. 문자열로 넘기면 cors@2.8.6이 요청 Origin과 무관하게 그 값을
  // 항상 Access-Control-Allow-Origin으로 되돌려주므로(lib/index.js의
  // configureOrigin), 허용되지 않은 origin에 헤더가 붙지 않는다는 사실을
  // 테스트가 고정할 수 없다. 배열이면 isOriginAllowed를 거쳐 불일치 시 헤더가
  // 아예 빠진다.
  //
  // credentials는 켜지 않는다 — 인증·쿠키가 아직 없다. 와일드카드도 쓰지 않는다.
  app.enableCors({ origin: [corsOrigin] });
```

`useGlobalPipes`·`useGlobalFilters` 블록은 **그대로 둔다.** 기존 docblock의 앞 문단(`전역 파이프·필터 배선. ...`부터 `... 통째로 무효가 된다.`까지)도 그대로 둔다.

- [x] **Step 4: 호출부 갱신**

Step 3 직후 `npx tsc --noEmit -p tsconfig.json`은 남은 호출부 두 곳을 `error TS2554: Expected 2 arguments, but got 1.`로 짚는다(`src/main.ts`, `src/chat/chat.controller.spec.ts`). 둘 다 고친다.

**(1)** `backend/src/main.ts` 전문 교체:

```ts
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // ConfigService.get의 두 번째 인자(기본값)를 쓰지 않는다. CORS_ORIGIN은
  // validateEnv의 필수 키이므로 여기 도달하면 이미 존재가 보장돼 있다.
  const corsOrigin = app.get(ConfigService).getOrThrow<string>('CORS_ORIGIN');
  configureApp(app, corsOrigin);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

**(2)** `backend/src/chat/chat.controller.spec.ts`의 `configureApp(app);` 한 줄(주석 포함)의 교체 후 전문:

```ts
    // main.ts와 같은 설정이어야 한다. 어긋나면 이 테스트가 프로덕션 동작을
    // 증명하지 못한다. 직접 ValidationPipe를 붙이면 ExternalServiceFilter가
    // 빠져 모든 kind가 500 + "Internal server error"가 된다.
    // CORS 허용 origin이 실제로 무엇을 붙이는지는 test/external-service.e2e-spec.ts가
    // 고정한다. 여기서는 시그니처를 만족시키는 리터럴이면 된다.
    configureApp(app, 'http://localhost:3000');
```

이 파일의 `ENV` 상수에는 `CORS_ORIGIN`을 **넣지 않는다.** origin이 인자로 오므로 ConfigService를 거치지 않는다(D-1).

- [x] **Step 5: 통과를 확인**

```
npx tsc --noEmit -p tsconfig.json
npm test
npx eslint src test --max-warnings=0
npm run test:e2e
npm run build
```

Expected: PASS 전부. 실측: 단위 `17 suites / 319 tests`, e2e `2 suites / 6 tests`.

**뮤테이션 실측 (계획 작성 중 측정 — 구현자가 다시 돌릴 필요는 없다).** 부정 단정에 실제로 이가 있는지 확인한 결과다. 각각 `origin` 한 줄만 바꿔 `npm run test:e2e`를 돌렸다.

| 뮤테이션 | 실패 건수 | 실패한 케이스 · 실측 메시지 |
|---|---|---|
| `origin: [corsOrigin]` → `origin: true` | **1** | 허용되지 않은 origin에는 CORS 헤더를 붙이지 않는다 — `Received: "http://evil.test"` |
| `origin: [corsOrigin]` → `origin: corsOrigin` (문자열) | **1** | 같은 케이스 — `Received: "http://localhost:3000"` |
| `enableCors` 줄 삭제 | **2** | preflight(`Received: 404`) · 실제 요청(`Received: undefined`). 부정 케이스는 **통과한다** |

와일드카드 회귀(`origin: true`)를 잡는 것은 부정 케이스 **하나뿐**이다. 그 케이스를 지우면 이 계획의 핵심 결정이 무방비가 된다.

- [x] **Step 6: 커밋**

```bash
git add src/app.setup.ts src/main.ts src/chat/chat.controller.spec.ts test/external-service.e2e-spec.ts
git commit -m "feat(backend): configureApp이 CORS_ORIGIN 하나만 허용하도록 CORS를 켠다

origin을 ConfigService에서 꺼내지 않고 인자로 받는다. 호출부 중
test/external-service.e2e-spec.ts는 ConfigModule을 import하지 않는 프로브
모듈이라 app.get(ConfigService)가 부팅 단계에서 죽는다. 인자로 받으면 반대로
타입 검사가 호출부 세 곳을 전부 짚어준다.

origin을 배열로 넘긴다. 문자열로 넘기면 cors가 요청 Origin과 무관하게 그 값을
항상 되돌려주므로, 허용되지 않은 origin에 헤더가 붙지 않는다는 것을 테스트가
고정할 수 없다. 그 부정 단정이 origin: true로의 회귀를 막는 유일한 방어선이다."
```

---

## 리뷰 묶음

이번 실행은 **review 단계를 생략**한다(사용자가 게이트에서 "생략(기본)"을 택했다 — `journal.md` Phase 0). 아래는 나중에 켤 경우의 경계다. 태스크가 둘뿐이고 Task 2가 Task 1의 키를 소비하므로 쪼개지 않는다.

| 묶음 | 태스크 | 논리 단위 |
|---|---|---|
| A | 1~2 | env 필수 키 + CORS 전역 배선 |

## 최종 검증

`backend/`에서 실행한다.

- [x] `npx tsc --noEmit -p tsconfig.json` 통과
- [x] `npm test` 통과 (기대: 17 suites / 319 tests)
- [x] `npx eslint src test --max-warnings=0` 통과 (warn 0건)
- [x] `npm run test:e2e` 통과 (기대: 2 suites / 6 tests)
- [x] `npm run build` 성공
- [x] `mv .env .env.hidden ; npm run test:e2e ; mv .env.hidden .env` — `setup-env.ts` 단독으로 e2e가 부팅되고 `.env`가 복원됐는지
- [x] `grep -rn CORS_ORIGIN src test .env.example .env` — 네 동기화 지점에 모두 있는지 (`.env`는 커밋되지 않았는지도 `git status`로 확인)

## 범위 밖

- 프론트엔드의 mock → 실제 `fetch` 교체, `NEXT_PUBLIC_*` 배선 (`frontend/src/lib/api/itinerary.ts`가 아직 `src/lib/mock/scenarios.ts`를 호출한다)
- `getItinerary()`에 대응하는 backend 엔드포인트
- `credentials: true`와 쿠키·인증
- 여러 origin 허용 (콤마 분리 파싱)
