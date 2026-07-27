# 워크스페이스별 명령과 제약

`travel-builder`는 루트에 package.json이 없는 **독립 npm 프로젝트 3개**다. 워크스페이스 도구(npm workspaces/turbo)를 쓰지 않으므로 **모든 명령은 해당 디렉터리에서 실행한다.** 루트에서 `npm test`를 돌릴 방법은 없다.

## 목차

- [core — CLI](#core--cli)
- [backend — NestJS API](#backend--nestjs-api)
- [frontend — Next.js 웹](#frontend--nextjs-웹)
- [공통 규약](#공통-규약)

---

## core — CLI

`@travel-builder/core`. 관광 데이터 수집·구조화·임베딩 파이프라인 CLI (`tb`).

| 목적 | 명령 (`core/`에서) |
|---|---|
| 테스트 전체 | `npm test` |
| 테스트 단건 | `npm test -- tests/lib/structuredText.test.ts` |
| 감시 모드 | `npm run test:watch` |
| 타입 검사 | `npm run typecheck` |
| 빌드 | `npm run build` |
| 실행 | `npm run dev -- <command> [options]` |

**스택:** TypeScript ESM · Node ≥20 · commander · pg · `@google/genai` · `@qdrant/js-client-rest` · axios · **vitest**

### 제약

- **ESM이다. 상대 import에 `.js` 확장자를 반드시 붙인다** (`import { logger } from "../lib/logger.js"`). 빠뜨리면 타입 검사는 통과하고 런타임에 모듈을 못 찾는다.
- 테스트는 `tests/**/*.test.ts`에만 있다 (`vitest.config.ts`의 `include`). `src/` 안에 테스트를 두면 실행되지 않는다.
- `npm run typecheck`는 `src`와 `tests`를 **모두** 검사한다. 빌드(`tsconfig.build.json`)는 `src`만 emit한다.
- 외부 의존(pg·Gemini·TEI·Qdrant·TourAPI)은 전부 `vi.mock`으로 대체한다. **실제 네트워크·DB 호출을 하지 않는다.**
- **마이그레이션 프레임워크를 도입하지 않는다.** DDL은 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`로 커맨드 안에서 직접 실행한다.
- 출력은 `console.*` 대신 `src/lib/logger.ts`를 쓴다.
- `.env`는 gitignore 대상. `.env.example`에 키를 추가한다.

### 새 커맨드 추가

1. `src/commands/xxx.ts`에 `registerXxx(program: Command)` 함수를 만든다
2. `src/index.ts`에서 import 후 `registerXxx(program)` 호출

---

## backend — NestJS API

`backend`. Postgres(TypeORM) 위의 chat/itinerary API.

| 목적 | 명령 (`backend/`에서) |
|---|---|
| 단위 테스트 | `npm test` |
| 감시 모드 | `npm run test:watch` |
| e2e 테스트 | `npm run test:e2e` |
| 커버리지 | `npm run test:cov` |
| 타입 검사 | `npx tsc --noEmit -p tsconfig.json` |
| 린트 (자동 수정) | `npm run lint` |
| 빌드 | `npm run build` |
| 개발 서버 | `npm run start:dev` |

**스택:** NestJS 11 · TypeORM · pg · class-validator/class-transformer · **jest** · prettier + eslint

### 제약

- **테스트 파일은 소스 옆에 `*.spec.ts`로 둔다.** jest의 `rootDir`가 `src`, `testRegex`가 `.*\.spec\.ts$`다. `test/` 디렉터리는 e2e 전용(`jest-e2e.json`).
- **`npm run typecheck` 스크립트가 없다.** `npx tsc --noEmit -p tsconfig.json`을 쓴다.
- `npm run lint`는 `--fix`가 붙어 있어 **파일을 수정한다.** 커밋 직전에 돌리고 결과를 확인한다.
- prettier 설정(`.prettierrc`)이 eslint에 통합돼 있다. 포맷을 수동으로 맞추지 말고 `npm run lint`에 맡긴다.
- 엔티티(`src/database/entities/`)는 **`core`가 만드는 DDL과 같은 테이블을 가리킨다.** 한쪽만 바꾸면 조용히 어긋난다 — 컬럼 추가 시 양쪽을 함께 본다.
- 환경변수는 `src/config/env.validation.ts`를 거친다. 새 변수는 여기와 `.env.example`에 함께 추가한다.

---

## frontend — Next.js 웹

`frontend`. App Router 기반 여행 플래너 UI.

| 목적 | 명령 (`frontend/`에서) |
|---|---|
| 테스트 | `npm test` |
| 타입 검사 | `npx tsc --noEmit` |
| 린트 | `npm run lint` |
| 빌드 | `npm run build` |
| 개발 서버 | `npm run dev` |

**스택:** Next.js 16 · React 19 · Tailwind CSS 4 · **vitest**

### 제약

- **`frontend/AGENTS.md`를 먼저 읽는다.** 이 Next.js는 학습 데이터와 API·규약·파일 구조가 다를 수 있으니 `node_modules/next/dist/docs/`의 해당 가이드를 읽고 코드를 쓰라고 명시돼 있다.
- **vitest가 `src/**/*.test.ts`만 수집한다** (`vitest.config.ts`). 확장자가 `.tsx`인 테스트는 **조용히 실행되지 않는다.** 컴포넌트 테스트를 추가하려면 `include`와 `environment`(현재 `node`)를 먼저 바꿔야 한다 — 계획에 그 태스크를 명시적으로 넣는다.
- `npm run typecheck` 스크립트가 없다. `npx tsc --noEmit`을 쓴다.
- 경로 별칭 `@/*` → `./src/*`.
- 현재 데이터는 전부 `src/lib/mock/`이다. 실제 API 배선은 `src/lib/api/`가 담당한다 — **backend DTO와 shape을 맞추는 것이 이 워크스페이스의 최대 위험 지점**이다.

---

## 공통 규약

- **주석·로그·에러 메시지·커밋 메시지는 한국어.**
- 커밋: `{type}({scope}): {제목}` + 본문에 **왜**. `scope`는 `core`/`backend`/`frontend`.
- 여러 워크스페이스를 건드리는 변경은 **워크스페이스별로 커밋을 나눈다.** 한 커밋에 묶으면 어느 쪽 테스트가 무엇을 보장하는지 추적이 끊긴다.
- 설계·계획 문서는 `docs/superpowers/{specs,plans}/`.

### 워크스페이스 경계 — 바꿀 때 함께 봐야 하는 짝

| 바꾸는 것 | 함께 봐야 하는 것 |
|---|---|
| `core/src/lib/*Table.ts`의 DDL | `backend/src/database/entities/*.entity.ts` |
| `backend/src/**/dto/*.dto.ts` | `frontend/src/lib/types.ts`, `frontend/src/lib/api/*.ts` |
| `core/src/services/*.ts` 반환 타입 | `core/src/commands/*.ts`의 요약 포매터 |
| `core/.env.example` | `core/src/lib/env.ts` |
| `backend/.env.example` | `backend/src/config/env.validation.ts` |

이 짝들은 **타입 시스템이 연결해주지 않는다.** 한쪽만 고치면 컴파일은 통과하고 런타임에 깨진다.
