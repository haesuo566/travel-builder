# backend 워크스페이스 — 명령과 제약

`travel-builder`는 루트에 package.json이 없는 **독립 npm 프로젝트 3개**(`core` · `backend` · `frontend`)다. 워크스페이스 도구(npm workspaces/turbo)를 쓰지 않으므로 **모든 명령은 `backend/`에서 실행한다.** 루트에서 `npm test`를 돌릴 방법은 없다.

## 목차

- [명령](#명령)
- [제약](#제약)
- [typed-lint — 관용적 테스트 코드가 error가 된다](#typed-lint--관용적-테스트-코드가-error가-된다)
- [환경변수는 네 곳이다](#환경변수는-네-곳이다)
- [워크스페이스 경계 — 함께 봐야 하는 짝](#워크스페이스-경계--함께-봐야-하는-짝)

---

## 명령

| 목적 | 명령 (`backend/`에서) |
|---|---|
| 단위 테스트 전체 | `npm test` |
| 단위 테스트 단건 | `npm test -- chat.service` |
| 감시 모드 | `npm run test:watch` |
| e2e 테스트 | `npm run test:e2e` |
| 커버리지 | `npm run test:cov` |
| **타입 검사** | `npx tsc --noEmit -p tsconfig.json` — **`npm run typecheck` 스크립트가 없다** |
| **린트 (확인용)** | `npx eslint src --max-warnings=0` — **warn도 실패다** |
| 린트 (자동 수정) | `npm run lint` — `--fix`가 붙어 **파일을 수정한다** |
| 빌드 | `npm run build` |
| 개발 서버 | `npm run start:dev` |

**스택:** NestJS 11 · TypeORM · pg · class-validator/class-transformer · `@google/genai` · `@qdrant/js-client-rest` · **jest 30** · prettier + eslint 9

## 제약

- **테스트 파일은 소스 옆에 `*.spec.ts`로 둔다.** jest의 `rootDir`가 `src`, `testRegex`가 `.*\.spec\.ts$`다(`package.json`의 `jest` 절). `test/` 디렉터리는 e2e 전용(`test/jest-e2e.json`).
- prettier 설정(`.prettierrc`)이 eslint에 `eslint-plugin-prettier/recommended`로 통합돼 있고 `prettier/prettier`가 **error**다. 포맷을 수동으로 맞추지 말고 `npm run lint`에 맡긴다.
- 엔티티(`src/database/entities/`)는 **`core`가 만드는 DDL과 같은 테이블을 가리킨다.** 한쪽만 바꾸면 조용히 어긋난다 — 컬럼 추가 시 양쪽을 함께 본다.
- 단위 테스트는 전부 모킹이다. Postgres·Gemini·TEI·Qdrant를 실제로 호출하지 않는다. **Postgres는 외부망에서 타임아웃**이므로 실접속이 필요한 검증은 에이전트가 할 수 없다.
- 마이그레이션 프레임워크를 도입하지 않는다. DDL은 `core`의 커맨드가 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`로 직접 실행한다. **`CREATE TABLE IF NOT EXISTS`는 기존 테이블에 no-op이라 컬럼이 생기지 않는다.**

## typed-lint — 관용적 테스트 코드가 error가 된다

eslint가 `tseslint.configs.recommendedTypeChecked`다(`eslint.config.mjs`). 즉 `no-unsafe-assignment`·`no-unsafe-member-access`·`no-unsafe-call`이 **error**이고, 끈 것은 `no-explicit-any`뿐이다. `no-floating-promises`·`no-unsafe-argument`는 `warn`이지만 게이트가 `--max-warnings=0`이므로 **warn도 실패다.**

그래서 다른 프로젝트에서 관용적인 테스트 코드가 여기서는 통과하지 못한다.

**1. 타입 있는 mock에는 `objectContaining` 대신 필드별 단정을 쓴다.**

`jest.fn<반환, [인자]>()`에 `toHaveBeenCalledWith(expect.objectContaining({...}))`를 쓰면, 중첩 `objectContaining`이 `any`를 반환해 속성 대입에서 error가 된다. 대신:

```ts
const [params] = fn.mock.calls[0];
expect(params.collectionName).toBe('tour_contents');
expect(params.limit).toBe(10);
```

검증도 이쪽이 강하다 — `.cofnig` 오타가 컴파일에서 잡힌다.

**`as { … }` 캐스팅으로 우회하는 것은 반대 방향이다.** 오타를 그대로 통과시키므로 검증을 없애는 셈이다.

**2. `jest.SpyInstance`의 `mock.calls` 원소는 `any`로 추론된다.**

`as unknown as unknown[][]`을 한 번 거쳐 좁히는 지역 헬퍼를 파일마다 하나 둔다. 기존 예시: `src/clients/call-external.spec.ts`.

**3. 구조분해로 키를 빼는 관용구는 error다.**

`const { key: _omit, ...rest } = obj`는 `no-unused-vars`의 `ignoreRestSiblings` 기본값이 `false`라 걸린다 — **`_` 접두사도 안 봐준다.** 헬퍼 함수로 뺀다.

**계획에 코드 블록을 쓸 때는 이 절을 먼저 읽는다.** 지어 쓴 테스트 코드가 린트를 통과하지 못하면 구현자가 이탈을 만들어야 하고, 그 이탈이 매번 리뷰·판정 비용을 낸다.

## 환경변수는 네 곳이다

새 환경변수를 추가할 때 **함께 봐야 하는 곳이 넷**이다. 하나라도 빠뜨리면 조용히 어긋난다.

1. `.env.example` — 키 문서화
2. `src/config/env.validation.ts` — `REQUIRED_KEYS` 등 검증
3. `test/setup-env.ts` — e2e가 읽는 값
4. (해당하면) `core/.env.example` — 같은 외부 서비스를 쓰는 짝

**로컬 `.env`가 누락을 가린다.** `test/setup-env.ts`에 키를 안 넣어도 로컬 `.env`가 있으면 e2e가 그대로 통과한다 — **통과 로그는 등록됐다는 증거가 아니다.** 부재를 실제로 확인하려면 `.env`를 잠시 옮기고 e2e가 env 부재로 실패하는 것을 본다.

## 워크스페이스 경계 — 함께 봐야 하는 짝

backend는 `core`와 DB 스키마·외부 서비스 설정을, `frontend`와 API 계약을 공유한다. **타입 시스템이 이 짝들을 연결해주지 않는다** — 한쪽만 고치면 컴파일은 통과하고 런타임에 깨진다.

| 바꾸는 것 | 함께 봐야 하는 것 |
|---|---|
| `backend/src/database/entities/*.entity.ts` | `core/src/lib/*Table.ts`의 DDL |
| `backend/src/**/dto/*.dto.ts` | `frontend/src/lib/types.ts`, `frontend/src/lib/api/*.ts` |
| `backend/src/clients/qdrant/tour-content-payload.ts`의 `TourContentPayload`·`TourSearchFilter` | `core/src/lib/qdrantCollection.ts`의 `toPayload` 키·거리 함수 |
| `backend/src/clients/tei/tei.client.ts`의 `embedQuery` 고정 옵션 | `core/src/clients/tei.ts`의 `embed` 요청 바디(`normalize`/`truncate`/`prompt_name`) |
| `backend/src/clients/gemini/gemini.client.ts`의 기본 모델 | `core/src/clients/gemini.ts`의 `GEMINI_MODEL` fallback |
| `backend/.env.example` | `backend/src/config/env.validation.ts`, `backend/test/setup-env.ts`, `core/.env.example` |
| `backend/src/clients/external-service.filter.ts`의 응답 본문 | `frontend`의 에러 처리 |

**임베딩 차원은 코드가 강제하지 않는다.** TEI 서버에 떠 있는 모델이 벡터 차원과 거리 함수를 결정하고, Qdrant 컬렉션의 실제 차원은 `getCollectionInfo()` 실측이 유일한 확인 수단이다. 계획에서 차원을 전제한다면 그 전제를 명시한다.

**에러 바디가 두 형태다.** `external-service.filter.ts`는 `error`=kind, `message`=고정 문구를 내지만, 같은 API가 `ValidationPipe` 400도 내며 그쪽은 `error`=`"Bad Request"`, `message`=`string[]`다. frontend는 **두 shape을 함께 다뤄야 한다** — 한쪽만 처리하면 다른 쪽에서 에러 표시가 깨진다.

## 공통 규약

- **주석·로그·에러 메시지·커밋 메시지는 한국어.**
- 커밋: `{type}(backend): {제목}` + 본문에 **왜**.
- 여러 워크스페이스를 건드리는 변경은 **워크스페이스별로 커밋을 나눈다.** 한 커밋에 묶으면 어느 쪽 테스트가 무엇을 보장하는지 추적이 끊긴다.
- 계획 문서는 `backend/docs/plans/`.
