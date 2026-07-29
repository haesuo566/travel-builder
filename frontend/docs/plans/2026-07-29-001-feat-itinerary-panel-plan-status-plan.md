---
plan_type: feat
created: 2026-07-29
status: ready
---

# feat: 여행계획 패널을 planStatus가 ready일 때만 띄운다

## 문제와 범위

`/plan`에 들어가면 `page.tsx:30-32`의 `useEffect`가 `getItinerary()`로 mock 일정을 상태에 채우기 때문에 오른쪽 여행계획 패널이 **항상** 떠 있다. 실제 계획이 없는데 있는 것처럼 보인다. backend는 이미 짝을 배포했다 — 브랜치 `feat/chat-plan-status`의 `ChatResponseDto`가 `{reply, planStatus:'none', itinerary:null}`과 `{reply, planStatus:'ready', itinerary:ItineraryDto}`의 **판별 유니온**이고, `buildChatResponse`가 유일한 생성 지점이다(`backend/src/chat/dto/chat-response.dto.ts:42-71`). 이 계획은 frontend가 그 계약을 **타입과 런타임 양쪽에서** 받아, 패널 표시를 응답이 결정하게 만든다.

짝이 되는 backend 계획: `backend/docs/plans/2026-07-29-chat-plan-status.md` (완료·배포됨).

**기준선(측정 완료):** `npm test` 13 passed / 2 files · `npx tsc --noEmit` OK · `npm run lint` OK. 전부 초록에서 시작한다.

**범위 밖:**

- **backend 파일 변경 일체.** 워크스페이스별로 커밋을 나눈다. mock 삭제로 생기는 backend 주석 dangling 3곳도 이번에 고치지 않는다(리스크 R5)
- **vitest 설정 변경 · 컴포넌트 테스트 도입.** `jsdom`·`@testing-library/*`·`@vitejs/plugin-react`가 전부 미설치이고 `include`가 `src/**/*.test.ts`다. 복원 계획 D-6 판단이 그대로 유효하다 — 이 계획은 `vitest.config.ts`를 건드리지 않는다
- **일정 수정 요청에서 패널 유지.** `"맛집 위주로"`도 `planStatus: 'none'`이라 패널이 닫힌다. 사용자가 추후 기능으로 미루기로 명시적으로 결정했다(2026-07-29). **프론트에서 우회하지 않는다** — 리스크 R2
- **`GET /itinerary`류 엔드포인트** — 만들지 않는다. `planStatus`는 `POST /chat` 응답으로만 온다
- **`fellBackToRawMessage` 노출** — backend 직전 계획 `:127`의 결정은 여전히 유효하다
- **`ChatPanel`·`SUGGESTION_CHIPS`·`INITIAL_ASSISTANT_MESSAGE` 문구 변경** — 사용자와 확인된 문구다
- **`resolveApiBaseUrl` 수정** — env 축을 건드리지 않는다

## 결정

| 결정 | 선택 | 이유 |
|------|------|------|
| 프론트가 `planStatus`를 상태로 갖는가 | **아니오.** `itinerary` 하나만 `useState`로 갖고, 렌더 조건은 `itinerary !== null`. `planStatus`는 파서의 계약 검증과 모바일 탭 결정에만 쓰고 상태에 남기지 않는다 | 지금은 같은 사실을 세 곳이 나눠 갖는다 — `planStatus` · `itinerary !== null` · `getItinerary()`가 채운 초기값. 같은 사실을 두 곳에 두면 한쪽만 갱신돼 갈린다(two-columns-one-state). backend가 판별 유니온과 단일 팩토리로 원천을 하나로 모은 것과 같은 방향이다 |
| `planStatus: 'none'`일 때 마지막 `ready` 일정을 붙들 것인가 | **아니오. 패널을 닫는다** | backend 계획의 `게이트 1 이후 새로 생긴 질문` 절이 frontend 계획을 향해 못 박았다 — 붙들면 (1) `planStatus`가 렌더 조건이라는 계약 전제가 무너지고 (2) 두 번째 진실 원천이 프론트에 생긴다. 게이트 1 Q3의 사용자 결정("사라진다 — plan 갈래에서만 뜨게")을 조용히 뒤집는 것이다 |
| 응답 타입을 어디에 두는가 | `src/lib/types.ts`에 `PlanStatus`와 `ChatResponse`를 추가하고, **`ChatResponse`를 판별 유니온으로** 정의한다 | 지금 `sendMessage`의 반환 타입이 mock 모듈의 `ScenarioResult`다(`api/itinerary.ts:3,48`) — mock을 지우는 순간 깨진다. 두 필드를 독립으로 두면 `{planStatus:'ready', itinerary:null}`이 타입상 표현 가능해지고 소비자가 두 조건을 방어적으로 둘 다 검사한다. 유니온이면 그 조합이 컴파일 에러다. `Itinerary`가 이미 `types.ts`에 있으니 도메인 타입의 자리도 거기다 |
| `as ScenarioResult` 캐스트를 어떻게 없애는가 | 런타임 파서 `parseChatResponse(body: unknown): ChatResponse`로 교체한다 | **이 계획의 최대 위험이 `api/itinerary.ts:68`의 캐스트다.** 캐스트는 shape 불일치를 컴파일러가 잡지 못하므로 타입만 넓히면 `npx tsc --noEmit`·`npm run build`가 모두 통과하고 런타임에 `planStatus`가 `undefined`가 되어 **패널이 영구히 안 뜬다.** 하네스 문서 2곳(`boundary-checklist.md:21`, `boundary-reviewer.md:42`)과 backend 계획 리스크 표가 이미 같은 지점을 지목했다 |
| 파서가 계약 위반을 만나면 | **throw한다.** 노출 문구를 named export 상수로 두고 테스트가 그 상수를 import해 단정한다 | `page.tsx:56-68`의 catch가 이미 에러를 말풍선으로 바꾼다 — 계약 위반이 **사용자에게 보이는 실패**가 되고, 조용한 패널 미표시가 되지 않는다. 문구를 상수로 빼는 이유는 테스트가 문구를 고정할 수 있게 하는 것이다(backend `query-reply.ts:8-14` 관례) |
| 파서의 검증 깊이 | `reply`가 문자열 · `planStatus`가 `'none'\|'ready'` · `ready`면 `itinerary`가 객체이고 `summary`가 객체이며 `days`가 **비어 있지 않은** 배열. 그 아래(각 `Place` 필드)는 검증하지 않는다 | 깊은 검증은 복제 스키마의 두 번째 원천을 프론트에 만든다(`itinerary.dto.ts:13-17`이 복제 위험을 이미 인정). 얕은 가드로 충분한 이유는 **렌더 크래시 지점이 하나뿐**이기 때문이다 — `ItineraryPanel.tsx:16-17`이 `days`가 `[]`면 `days[-1]`을 읽어 `:40`에서 TypeError로 죽는다. `days` 비지 않음 하나가 그 지점을 막는다. 동시에 "일정 모양이다"를 아무도 세지 않아 빈 일정이 정상으로 굳는 과거 실수(`a490424`)도 여기서 막힌다 |
| `planStatus: 'none'`인데 `itinerary`가 non-null이면 | throw한다. 반대로 `itinerary` 키가 **부재**하면 `null`로 정규화해 통과시킨다 | backend `buildChatResponse`는 `none`⟹`null`을 보장하므로 non-null이 오면 계약이 갈린 것이고 조용히 흡수하면 갈린 사실이 숨는다. 키 부재는 "일정이 없다"와 같은 뜻이며, 프록시·직렬화가 `null` 키를 지우는 경로를 파서가 흡수하는 편이 안전하다 |
| 빈 상태와 레이아웃 | 오른쪽 자리에 "대화를 시작하면 여기에 일정이 나타나요" 빈 상태를 두고 **40/60 분할을 유지한다.** 모바일 탭 바는 일정이 없으면 렌더하지 않는다 | 사용자와 합의된 결정. 첫 일정이 생길 때 레이아웃이 흔들리지 않는다. 빈 `Itinerary` 객체를 넣어 빈 패널을 그리는 접근은 **불가능하다** — 위 `ItineraryPanel.tsx:16-17` 크래시 |
| 응답이 `none`일 때 모바일 탭 | `activeMobileTab`을 `"chat"`으로 되돌린다 | `page.tsx:55`가 지금은 성공 응답마다 무조건 `"itinerary"`로 바꾼다. 탭 바를 조건부로 렌더하면서 이 줄을 그대로 두면 **일정이 있던 상태에서 `none`을 받는 순간 탭 바가 사라지고 채팅 컬럼은 `hidden`이라 모바일에서 빈 화면이 된다.** 판정을 순수 함수로 빼서 테스트한다 |
| 좌우 컬럼의 CSS `hidden` 토글 | **유지한다.** 조건부 렌더로 바꾸지 않는다 | 바꾸면 `ItineraryPanel.tsx:14`의 `selectedDayIndex`가 재마운트마다 0으로 초기화된다. 이번 변경으로 패널 내용이 `ItineraryPanel`↔빈 상태로 갈리는 것과는 별개 축이다 |
| `getItinerary()`와 `src/lib/mock/`의 운명 | **전부 삭제한다** | 과거 결정 D-1(`c90e45a^:docs/superpowers/plans/2026-07-28-frontend-chat-api.md`)의 근거 (3)이 "최초 일정은 서버 상태가 아니라 화면 초기값이라 mock으로도 기능이 성립한다"였는데, **그 화면 초기값이 지금 사용자 불만의 직접 원인이다.** (1)(2)(엔드포인트 없음·워크스페이스 분리)는 여전히 참이지만 결론이 무효다. `generateAssistantReply`는 이미 프로덕션 호출 0곳의 죽은 코드다(테스트 5건만 살아 있다) — 옮기는 것이 아니라 죽은 코드를 지우는 것이다. mock을 남기면 일정 데이터의 원천이 프론트와 backend 두 곳이 된다 |
| `itinerary.test.ts`의 fixture | `getDefaultItinerary` 9곳을 **로컬 fixture 함수**로 대체한다 | mock을 지우면 이 파일이 컴파일되지 않는다. backend `chat.service.spec.ts:41-67`의 `createRequest`가 같은 역할의 선례다 |
| `PlanStatus` 타입 표기 | frontend는 **인라인 유니온 리터럴**(`"none" \| "ready"`). backend의 `as const` 배열 + `(typeof X)[number]` 관례를 옮기지 않는다 | `types.ts:1`의 `PlaceCategory`, `:28`의 `ChatRole`, `page.tsx:26`이 모두 인라인 리터럴이다. 두 워크스페이스의 관례가 다르므로 한쪽을 다른 쪽에 옮기지 않는다. 프론트에는 런타임 멤버십 검사가 필요한 지점이 파서 하나뿐이고 거기서는 리터럴 비교로 충분하다 |
| 새 lib 파일명 | kebab-case (`chat-response.ts`, `plan-view.ts`) | frontend `src/lib/`에 다단어 파일 선례가 없다(`types.ts`·`constants.ts`·`itineraries.ts`·`scenarios.ts` 전부 한 단어). 컴포넌트만 PascalCase다. 새 관례를 세우는 자리이며, backend 순수 모듈이 하이픈을 쓰는 것과 어긋나지 않는 쪽을 택한다 |
| 요청 본문의 `itinerary` | 일정이 없어도 **키를 보내고 값을 `null`로 둔다.** 조건부로 키를 빼지 않는다 | backend `@IsOptional()`이 명시적 `null`도 통과시키고 값을 `null`로 남기는 것이 실측됐다(backend 계획 Global Constraints). 조건부로 키를 빼면 body 조립에 분기가 하나 늘고, 두 경로 중 한쪽만 테스트되는 형태가 된다 |
| 일정 요청이 intent 폴백으로 흡수된 경우 | **이번에 다루지 않는다** | `planStatus: 'none'`은 (a) 일정 요청이 아니었다 (b) 일정 요청이었는데 intent 분류가 폴백돼 `other`로 흡수됐다 (c) backend 오류를 뭉친다. (c)는 기존 에러 말풍선이 이미 가른다. (b)를 가르려면 backend가 새 정보를 실어야 하고 그건 계약 변경이다 — 리스크 R3에 남긴다. 근거 없이 표에서 빠지면 판단이 아니라 누락이다 |

> 아래 유닛의 타입·함수 이름은 **방향 제시**이며 구현 지시가 아니다. 이름과 시그니처가 더 나은 형태로 바뀌는 것은 구현자의 재량이고, 바꿀 때는 계획의 어느 결정을 유지하는지만 지키면 된다.

## 경계면 영향

| 경계면 | 변경 여부 | 내용 |
|--------|----------|------|
| 백엔드 API 계약 | **예** | 생산: `backend/src/chat/dto/chat-response.dto.ts:42-71`(판별 유니온 + `buildChatResponse`), `backend/src/chat/dto/chat-request.dto.ts:50-54`(`itinerary`가 `@IsOptional()`). 소비: `frontend/src/lib/api/itinerary.ts:45-69`(반환 타입·`:68` 캐스트·`:56` 요청 본문), 신규 `frontend/src/lib/api/chat-response.ts`. **backend는 이미 배포됐고 이 계획은 소비 측만 바꾼다** |
| 도메인 타입 | **예** | `frontend/src/lib/types.ts`에 `PlanStatus`·`ChatResponse` 추가. `ScenarioResult`(`src/lib/mock/scenarios.ts:4-7`) 소멸. `Itinerary`·`ItineraryDay`·`Place`·`TripInfo`는 **바꾸지 않는다** — backend `itinerary.dto.ts:20-87`과의 복제 짝이 그대로 유지된다. mock 삭제로 fixture 생산자가 `mock/itineraries.ts`에서 각 테스트의 로컬 fixture로 바뀐다 |
| 라우팅 | 아니오 | `src/app/**/page.tsx` 파일 경로 변경 없음. `href`·`router.push`·`redirect` 신규 없음 |
| 환경변수 | 아니오 | 새 키 없음. `resolveApiBaseUrl`(`api/itinerary.ts:31-39`)과 `.env.example`을 건드리지 않는다 |
| core 패키지 | 아니오 | frontend는 `core/src/**`를 import하지 않고 이번에도 하지 않는다 |

## 구현 유닛

### U1. 응답 판별 유니온 타입과 런타임 파서를 만든다

- **목표:** `ChatResponse` 판별 유니온과, 알 수 없는 본문을 그 타입으로 좁히거나 throw하는 순수 파서가 생긴다. 이 유닛이 끝나면 `planStatus` 누락을 **테스트가 잡는다.**
- **파일:** 수정 `src/lib/types.ts`(`PlanStatus`, `ChatResponse` 추가) / 생성 `src/lib/api/chat-response.ts`(`parseChatResponse`, 노출 문구 상수) / 테스트 생성 `src/lib/api/chat-response.test.ts`
- **따를 패턴:**
  - `src/lib/types.ts:1,28` — 인라인 유니온 리터럴. `as const` 배열을 쓰지 않는다
  - `backend/src/chat/dto/chat-response.dto.ts:23-43` — 판별 유니온의 arm 구성. **타입만 모방하고 backend 파일을 건드리지 않는다**
  - `backend/src/chat/query/query-reply.ts:8-14` — 사용자 노출 문구를 named export 상수로 빼고 테스트가 그 상수를 import해 단정하는 형태
  - `src/lib/api/itinerary.ts:71-99` `readErrorMessage` — 알 수 없는 본문을 좁힐 때 `unknown`에서 필드 타입을 하나씩 확인하는 기존 방식(`Array.isArray`, `typeof ... === "string"`)
- **테스트 시나리오:**
  - 정상(ready): `{reply:"제주 2박 3일 일정을 준비했어요! Day별 코스를 확인해보세요.", planStatus:"ready", itinerary:<제주 3일 fixture>}` → 반환값의 `planStatus`가 `"ready"`, `itinerary.summary.destination`이 `"제주"`, `itinerary.days`가 3개. **일정의 내용을 센다** — "일정 모양이다"를 아무도 세지 않으면 빈 일정이 통과한다
  - 정상(none): `{reply:"어느 지역으로 떠나고 싶으신가요? ...", planStatus:"none", itinerary:null}` → `planStatus`가 `"none"`, `itinerary`가 `null` (↔ 짝: 위 ready 케이스와 대칭)
  - 경계: `{reply, planStatus:"none"}` — `itinerary` 키 부재 → throw하지 않고 `itinerary`가 `null`로 정규화된다
  - 경계: `{reply, planStatus:"ready", itinerary:{summary:{...}, days:[]}}` — 빈 `days` → throw. `ItineraryPanel`의 TypeError 지점을 파서가 막는 것을 고정한다
  - 실패: `{reply, itinerary:null}` — `planStatus` 필드 부재(구버전 backend) → 노출 문구 상수로 throw. **이것이 `as` 캐스트 회귀를 잡는 테스트다**
  - 실패: `{reply, planStatus:"drafting", itinerary:null}` — 유니온에 없는 값 → throw
  - 실패: `{reply, planStatus:"ready", itinerary:null}` → throw (`ready`⟹일정 있음 불변식)
  - 실패: `{reply, planStatus:"none", itinerary:<fixture>}` → throw (`none`⟹일정 없음 불변식, 위와 ↔ 짝)
  - 실패: 본문이 `null` / 배열 / 문자열 → throw
- **검증:** `npm test` 통과 + `npx tsc --noEmit` + `npm run lint` + **`npm test` 출력에 `chat-response.test.ts` 파일명이 찍히는지 확인**(수집 여부는 통과/실패로 구분되지 않는다) + 새 테스트의 검출력 확인 — `planStatus` 검사를 임시로 제거해 **해당 테스트만** red가 되는 것을 보고 원복하며, 원복 증명은 `git diff --stat`이 비는 것
- **의존:** 없음

### U2. 화면 판정을 순수 함수로 뽑는다

- **목표:** "패널을 띄우는가"와 "응답 후 모바일 탭이 무엇이 되는가"가 `.ts` 순수 함수의 반환값이 되어 **긍정 단정으로** 테스트된다. `page.tsx`는 이 결과를 소비하는 조건만 갖는다.
- **파일:** 생성 `src/lib/plan-view.ts`(`MobileTab` 타입, `hasItinerary`, `resolveMobileTab`) / 테스트 생성 `src/lib/plan-view.test.ts`
- **따를 패턴:**
  - `src/lib/types.ts:1,28` — 인라인 유니온 리터럴. `MobileTab`은 `page.tsx:26`에 인라인으로 있는 `"chat" | "itinerary"`를 이름 있는 타입으로 옮긴 것이다
  - `src/lib/api/itinerary.test.ts` — 테스트 제목을 한국어 서술문("~한다")으로 쓰는 관례
  - `hasItinerary`는 **타입 술어**(`itinerary is Itinerary`)로 선언한다 — boolean 반환으로는 `page.tsx`에서 `ItineraryPanel`의 non-null props로 좁혀지지 않아 함수가 쓰이지 못한다
- **테스트 시나리오:**
  - 정상: `resolveMobileTab("ready")`가 `"itinerary"`다
  - 정상: `resolveMobileTab("none")`이 `"chat"`이다 (↔ 짝. 이 한 줄이 없으면 일정이 있던 상태에서 `none`을 받을 때 모바일이 빈 화면이 된다)
  - 경계: `PlanStatus`의 값이 둘뿐이므로 위 두 테스트가 **전수**다. 유니온에 값이 늘면 함수 시그니처가 컴파일 에러로 드러난다
  - 정상: `hasItinerary(<fixture>)`가 `true`다
  - 실패: `hasItinerary(null)`이 `false`다 (↔ 짝. `expect(...).toBe(false)`는 긍정 단정이다 — `not.to*`를 쓰지 않는다)
- **검증:** `npm test` 통과 + `npx tsc --noEmit` + `npm run lint` + **`npm test` 출력에 `plan-view.test.ts` 파일명이 찍히는지 확인**
- **의존:** U1 (`PlanStatus` 타입)

### U3. `sendMessage`를 파서에 배선하고 일정 없는 전송을 허용한다

- **목표:** `as ScenarioResult` 캐스트가 사라지고, `sendMessage`가 `ChatResponse`를 돌려주며 `itinerary`가 없어도 전송된다. `itinerary.test.ts`가 mock에서 독립한다.
- **파일:** 수정 `src/lib/api/itinerary.ts`(`:48` 반환 타입 → `Promise<ChatResponse>`, `:68` 캐스트 → `parseChatResponse` 호출, `:47` `currentItinerary: Itinerary | null`) / 수정 `src/lib/api/itinerary.test.ts`(`getDefaultItinerary` 9곳 → 로컬 fixture, 성공 응답 본문에 `planStatus` 추가, 일정 null 전송 케이스 추가)
- **따를 패턴:**
  - `src/lib/api/itinerary.test.ts:7-28` — `stubFetch` 헬퍼, 실제 `new Response(JSON.stringify(body), ...)`, `vi.stubEnv`/`vi.unstubAllEnvs`, `vi.stubGlobal`/`vi.unstubAllGlobals`
  - `src/lib/api/itinerary.test.ts:38` — `const [url, init] = fetchMock.mock.calls[0];`로 요청 인자를 읽는 형태
  - `backend/src/chat/chat.service.spec.ts:41-67` `createRequest` — 로컬 fixture 함수를 테스트 파일 안에 두는 선례
- **`getItinerary`는 이 유닛에서 남긴다.** 여기서 지우면 `page.tsx:6,31`이 컴파일되지 않아 유닛 경계에서 `tsc`가 빨개진다. 삭제는 U6이다
- **테스트 시나리오:**
  - 정상: ready 본문 응답 → 반환값의 `planStatus`가 `"ready"`이고 `itinerary.days`가 3개
  - 정상: none 본문 응답 → `planStatus`가 `"none"`, `itinerary`가 `null` (↔ 짝)
  - 경계: `currentItinerary`가 `null` → 요청 본문을 `JSON.parse`했을 때 `itinerary` **키가 존재하고 값이 `null`**이다. 키 부재와 구분해 센다(키를 조건부로 빼지 않기로 한 결정을 고정)
  - 경계: `planStatus`가 없는 성공 본문 → U1의 노출 문구 상수로 rejects. 파서가 실제로 이 경로에 꽂혔는지를 이 테스트만 센다
  - 실패: 기존 케이스 전부 유지 — 400 + `message: string[]` → 검증 문구 / 5xx + `message: string` → 그 문구 / JSON 아님 → 폴백 문구 / fetch throw → 폴백 문구 / env 미설정 → 설정 문구
- **검증:** `npm test` 통과 + `npx tsc --noEmit` + `npm run lint` + `itinerary.test.ts`가 `npm test` 출력에 계속 찍힌다 + 이 파일에 `lib/mock` import가 0건이다
- **의존:** U1

### U4. 일정이 없을 때 오른쪽 자리를 채우는 빈 상태 컴포넌트를 만든다

- **목표:** 40/60 분할을 유지한 채 오른쪽에 "대화를 시작하면 여기에 일정이 나타나요"를 보여주는 컴포넌트가 생긴다.
- **파일:** 생성 `src/components/planner/ItineraryEmptyState.tsx`
- **따를 패턴:**
  - `src/components/planner/MapPlaceholder.tsx:1-31` — `"use client"` 없는 서버 컴포넌트, named export function, 인라인 className. 이 프로젝트에서 "아직 실물이 없는 자리"를 채우는 유일한 기존 컴포넌트다. props가 없으므로 `interface XxxProps`는 만들지 않는다(관례는 props가 있을 때 적용)
  - `src/app/plan/page.tsx:76` — 비활성 문구 색 `text-sm text-slate-400`. `TripSummary.tsx:12`, `ChatPanel.tsx:34`도 같다
  - `src/app/globals.css:8-16` — 색은 `bg-brand`/`bg-brand-light`/`teal-*`/`slate-*`에서 고른다. 카드 라운딩은 `rounded-2xl`
  - 문구는 **합의된 한 줄만** 둔다. 보조 문구·아이콘을 늘리는 것은 합의 밖이다
- **테스트 시나리오:** 없음. `.tsx`는 `vitest.config.ts`의 `include: ["src/**/*.test.ts"]`에 걸리지 않아 **조용히 미수집**되고 `environment: "node"`라 DOM도 없다. **`.test.tsx`를 만들지 않는다** — 만들면 초록불이 나오지만 실행되지 않는다. 이 컴포넌트의 증거는 U5의 타입 검사와 사람 확인이다
- **검증:** `npx tsc --noEmit` + `npm run lint` + `npm test`가 U3 시점과 동수(테스트가 늘지도 줄지도 않는다)
- **의존:** 없음

### U5. `page.tsx`의 네 지점을 한 번에 재배선한다

- **목표:** 마운트 시 mock seed가 사라지고, 일정이 없어도 채팅을 쓸 수 있고, 패널은 응답이 일정을 줄 때만 뜬다.
- **파일:** 수정 `src/app/plan/page.tsx`
- **한 유닛인 이유:** 네 지점이 서로의 전제다 — `:30-32`(mock seed) · `:35`(`if (!itinerary) return` 전송 가드) · `:74-80`(`!itinerary`면 페이지 전체가 "불러오는 중...") · `:122`(패널 조건). **넷을 갈라 놓으면 중간 유닛에서 페이지가 동작하지 않는 상태가 커밋된다** — seed만 지우면 페이지가 "불러오는 중..."에서 멈추고 메시지도 보낼 수 없다
- **바꿀 지점(전부 이 유닛):**
  - `:30-32` `useEffect` + `:6`의 `getItinerary` import 제거 → 초기 상태가 `null`로 남는다
  - `:35` 전송 가드 제거 → 첫 턴을 일정 없이 보낸다(`ChatRequestDto`의 `itinerary`가 `@IsOptional()`이다)
  - `:74-80` 조기 반환 제거 → 일정 없음이 로딩이 아니라 정상 상태가 된다
  - `:122` → `hasItinerary(itinerary)`로 좁혀 `ItineraryPanel`과 `ItineraryEmptyState`를 가른다. 감싸는 `div`의 `md:w-[60%]`는 그대로 둬 40/60을 유지한다
  - `:55` `setActiveMobileTab("itinerary")` → `resolveMobileTab(result.planStatus)`
  - `:84-107` 모바일 탭 바 → `hasItinerary(itinerary)`일 때만 렌더
  - `:26` `useState<"chat" | "itinerary">` → `MobileTab`
  - `:110-120` 좌우 컬럼의 `hidden`/`flex` 토글은 **그대로 둔다**
- **따를 패턴:** 같은 파일의 기존 형태 — `:88-92`의 템플릿 리터럴 className 조립, `:9-14`의 모듈 스코프 상수, `:46-55`의 성공 경로 순서(말풍선 추가 → 상태 갱신)
- **테스트 시나리오:** 없음. 위 U4와 같은 이유로 `.tsx`는 수집되지 않는다. **판정은 U1·U2가 덮는다** — `page.tsx`에 남는 것은 순수 함수 결과를 소비하는 조건뿐이어야 한다. 조건 안에 새 판정 로직(`&&` 사슬, 상태 비교)을 늘리면 그만큼 테스트 밖으로 나간다
- **검증:** `npx tsc --noEmit` + `npm run lint` + `npm test` 동수 + `npm run build` 통과하고 `/plan`이 여전히 `○ (Static)`이다(초기값이 `null`이 되며 프리렌더가 깨질 수 있고 그건 build에서만 드러난다)
- **의존:** U2, U3, U4

### U6. mock 모듈과 `getItinerary`를 삭제한다

- **목표:** 일정 데이터의 원천이 backend 하나가 된다. 죽은 코드가 사라진다.
- **파일:** 삭제 `src/lib/mock/itineraries.ts`, `src/lib/mock/scenarios.ts`, `src/lib/mock/scenarios.test.ts` / 수정 `src/lib/api/itinerary.ts`(`:1-3` import 중 mock 2줄과 `:5-11` `getItinerary` 제거)
- **따를 패턴:** 없음(삭제). `getItinerary`의 유일한 소비자가 U5에서 사라졌고, `getDefaultItinerary`의 나머지 소비자는 U3에서 로컬 fixture로 갈아탔다. `generateAssistantReply`는 프로덕션 호출이 처음부터 0곳이었다
- **테스트 시나리오:** 없음(삭제). `scenarios.test.ts`의 5건이 함께 사라진다 — 죽은 코드의 테스트이므로 대체하지 않는다. 대체가 필요한 fixture 역할은 U3에서 이미 옮겼다
- **검증:** `npm test` 통과 + `npx tsc --noEmit` + `npm run lint` + `npm run build` + **`npm test` 출력에서 `scenarios.test.ts`가 사라졌는지 확인** + `src/`에 `lib/mock` import가 0건, `ScenarioResult` 참조가 0건 + `src/lib/mock/`이 비었다
- **의존:** U3, U5

## 리스크

| 리스크 | 영향 | 완화 |
|--------|------|------|
| **U1~U6은 `planStatus`를 내는 backend에서만 동작한다** | 구버전 backend(`planStatus` 없음)를 향하면 파서가 throw해 **모든 채팅 턴이 에러 말풍선**이 된다 | 의도된 실패 모드다 — 조용한 패널 미표시보다 즉시 드러나는 실패를 택한 것이 결정 5. backend가 `feat/chat-plan-status`를 포함한 상태인지 확인하는 것이 `사람이 확인해야 하는 항목` 1항의 전제이며, 6항이 이 경로 자체를 실측한다 |
| **일정 수정 요청도 `planStatus: 'none'`이라 패널이 닫힌다** | `"맛집 위주로 바꿔줘"`를 보내면 방금 받은 일정이 화면에서 사라진다 | **사용자가 추후 기능으로 미루기로 명시적으로 결정했다**(2026-07-29: "이건 추후에 추가할 기능임. 지금은 건들지마"). **프론트에서 우회하지 않는다** — 마지막 `ready` 일정을 프론트 상태로 붙들면 게이트 1 Q3 결정을 조용히 뒤집고, 같은 사실을 두 곳이 나눠 갖는 구조가 프론트에 생겨 backend가 판별 유니온과 단일 팩토리로 원천을 하나로 모은 것이 무의미해진다. 되돌릴 때의 정본 경로는 backend `replyPlan`을 고치는 것이다. `사람이 확인해야 하는 항목` 5항이 이 동작을 "정상"으로 못 박는다 |
| 일정 요청이 intent 폴백으로 흡수되면 사용자에게 **패널 부재로만** 나타난다 | 사용자는 일정을 요청했는데 패널이 안 뜨고 이유를 알 수 없다. `none`이 "일정 요청이 아니었다"와 "분류가 폴백됐다"를 뭉친다 | 이번 범위 밖(결정 14). **관측 수단은 backend warn 로그 1건뿐이다.** 가르려면 backend가 새 정보를 실어야 하고 그건 계약 변경이다 |
| `.tsx` 렌더 분기에 자동 테스트가 없다 | U4·U5의 사용자 가시 동작이 검증 없이 커밋될 수 있다. 과거 3회 모두 구현자가 수동 검증 체크박스를 닫았고, 닫힌 체크박스는 다음 실행에서 "검증됨"으로 읽혔다 | 판정을 U1·U2의 순수 함수로 뽑아 자동 테스트 가능한 면적을 최대화했다. 남는 구간의 **유일한 증거는 사람 손에 남는다** — `사람이 확인해야 하는 항목`에 체크박스 없이 절차와 통과 조건으로 적었다. `.test.tsx`를 만들지 않는다 |
| mock 삭제로 backend 주석 3곳이 dangling 참조가 된다 | `chat-response.dto.ts:30-31`(계약의 출발점), `other-prompt.ts:2-3`(`OTHER_REPLY` 복제 짝), `other-prompt.ts:16-18`(**500자 상한의 유일한 근거인 58·67·69자**), `chat-request.dto.ts:23-24`(1000자 상한 근거 일부) | 이번에 고치지 않는다 — 워크스페이스별로 커밋을 나눈다는 원칙이 우선이고, backend는 자체 하네스·자체 게이트를 갖는다. **이 표가 그 목록이다.** backend 쪽 후속 작업에서 주석을 자기 파일 안 근거로 옮기는 것이 정본 경로다 |
| `ready`→`none`→`ready` 흐름에서 `ItineraryPanel`이 재마운트돼 `selectedDayIndex`가 0으로 초기화된다 | 사용자가 Day 3을 보던 중 잡담을 하면 다음 일정에서 Day 1로 돌아간다 | 허용한다 — 재마운트 사이에 일정 자체가 바뀌므로 이전 선택을 유지하는 것이 오히려 틀린 화면이다. 좌우 컬럼의 CSS `hidden` 토글은 유지하므로 **탭 전환으로 인한** 초기화는 생기지 않는다 |
| 미추적 `.ignore` 3개(루트·`backend/`·`frontend/`)가 커밋에 섞인다 | 근거를 못 찾은 파일이 이 작업의 커밋에 들어간다 | 커밋에 넣지 않는다. `최종 검증`의 실측 항목에 포함 |

## 구현 시점에 결정할 것

- **`parseChatResponse`의 얕은 가드 하한을 어디까지 올릴지.** 계획은 `summary`가 객체 + `days`가 비지 않은 배열까지를 하한으로 정했다. `days[n].places`가 배열인지까지 볼지는 실제 코드를 쓰면서 판단한다 — `DayTimeline.tsx:11`과 `MapPlaceholder.tsx:19`는 `[].map`이라 빈 배열에 안전하므로 크래시 근거는 없다
- **로컬 fixture를 각 테스트 파일 안에 둘지 공용 헬퍼로 뺄지.** `chat-response.test.ts`(U1)와 `itinerary.test.ts`(U3) 둘 다 일정 fixture가 필요하다. 두 파일의 fixture가 실제로 같은 모양을 원하는지는 U3을 쓸 때 드러난다. 공용으로 뺄 경우 파일명을 `*.test.ts`로 두면 vitest가 테스트 파일로 수집하려 하므로 다른 이름이어야 한다
- **파서의 노출 문구 최종 표현.** `readErrorMessage`의 기존 문구(`api/itinerary.ts:14-22`)와 톤을 맞추되, "서버 응답 형식" 계열과 "연결 실패" 계열이 사용자에게 구분되어야 하는지는 문구를 나란히 놓고 판단한다
- **`ItineraryEmptyState`의 여백과 배경.** `MapPlaceholder`의 radial-gradient 점 패턴을 재사용할지, 문구만 중앙 정렬할지. 오른쪽 컬럼 전체 높이를 채워야 40/60이 흔들리지 않는다는 제약만 지킨다
- **`MobileTab` 타입을 `plan-view.ts`에 둘지 `types.ts`에 둘지.** 계획은 `plan-view.ts`를 택했다(화면 판정의 소유자). `types.ts`가 도메인 타입만 담는다는 성격을 지키는 쪽이지만, 실제로 import 그래프가 어색해지면 옮긴다

## 최종 검증

- **게이트 명령:** (`C:\workspace\travel-buider\frontend`에서) `npm test` · `npx tsc --noEmit` · `npm run lint` · `npm run build`

- **이 계획만 아는 실측 항목:**
  - `src/lib/api/chat-response.test.ts`와 `src/lib/plan-view.test.ts`의 **파일명이 `npm test` 출력에 실제로 찍혔는지** — `.test.ts`는 수집되지만 수집 여부는 통과/실패로 구분되지 않는다. 파일명이 없으면 그 유닛은 검증되지 않았다
  - `npm test` 출력에서 `scenarios.test.ts`가 **사라졌는지**, 그리고 수집된 테스트 **파일 수가 기준선 2개에서 3개로** 바뀌었는지(`itinerary.test.ts` + 새 2개, `scenarios.test.ts` 제거). 총 테스트 건수는 기준선 13에서 바뀌며, **바뀐 수치를 여기에 미리 적지 않는다** — 측정하지 않은 수치를 적으면 다음 실행이 그것을 검증된 값으로 읽는다
  - `npm run build`에서 `/plan`이 여전히 `○ (Static)`으로 프리렌더되는지 — `itinerary` 초기값이 `null`이 되고 `page.tsx:74-80` 게이트가 사라지므로 프리렌더 시점의 null 역참조가 생길 수 있고, 그건 build에서만 드러난다
  - `src/` 전체에서 `as ScenarioResult`가 **0건**, `lib/mock` import가 **0건**, `ScenarioResult` 참조가 **0건**인지. 이 캐스트가 남아 있으면 타입 검사와 빌드를 모두 통과하고 런타임에만 패널이 영구히 숨는다 — 하네스 문서 2곳이 지목한 지점이다
  - `planStatus` 검사를 임시로 제거하면 **U1의 해당 테스트 하나만** red가 되는지 확인하고 원복. 원복 증명은 `git diff --stat`이 비는 것 — 리더가 `git status`로 재확인한다
  - diff에 `.test.tsx` 파일이 **없는지**, `vitest.config.ts`·`package.json`이 **변경되지 않았는지**
  - `backend/` 파일이 **하나도 변경되지 않았는지**(`git status`) — 이 계획은 frontend만 바꾼다
  - 미추적 `.ignore` 3개(루트 · `backend/` · `frontend/`)가 **커밋에 들어가지 않았는지**
  - `src/lib/mock/` 디렉토리가 비었는지

- **사람이 확인해야 하는 항목:**

  브라우저 조작 도구가 이 세션에 없고, U4·U5의 렌더 분기는 현재 vitest 설정으로 테스트할 수 없다. **이 구간의 유일한 증거는 사람 손에 남는다.**

  1. **첫 진입 — 패널은 없고 채팅은 쓸 수 있다.** 절차: backend를 `feat/chat-plan-status`가 포함된 상태로 띄우고, `frontend/.env.local`에 `NEXT_PUBLIC_API_BASE_URL`을 backend origin으로 두고 `npm run dev` 후 `/plan`에 들어간다. 통과 조건: 데스크톱 폭에서 왼쪽 40%에 채팅, 오른쪽 60%에 "대화를 시작하면 여기에 일정이 나타나요"가 보이고 **입력창에 글을 써서 보낼 수 있다** — "불러오는 중..." 한 줄에서 멈추지 않는다. 모바일 폭에서는 채팅만 보이고 상단 탭 바가 **없다**.
  2. **목적지를 못 알아듣는 일정 요청 — 패널이 여전히 없다.** 절차: `"여행 일정 짜줘"`를 보낸다. 통과 조건: 목적지를 묻는 답변 말풍선이 오고, 오른쪽은 여전히 빈 상태이며 **좌우 폭이 변하지 않는다**.
  3. **잡담 — 패널이 여전히 없다.** 절차: `"안녕"`을 보낸다. 통과 조건: 2와 같다.
  4. **일정 생성 — 패널이 나타난다.** 절차: `"제주 2박3일 일정 짜줘"`를 보낸다. 통과 조건: 답변이 `제주 2박 3일 일정을 준비했어요! Day별 코스를 확인해보세요.`이고 오른쪽에 Day 1~3 버튼과 장소 목록이 보인다. 모바일 폭에서는 상단 탭 바가 나타나고 **자동으로 "일정" 탭이 선택된다**.
  5. **일정 후 잡담 — 패널이 닫힌다(대가의 실측).** 절차: 4 직후 `"맛집 위주로 바꿔줘"`를 보낸다. 통과 조건: 패널이 닫히고 빈 상태로 돌아간다. 모바일 폭에서는 탭이 채팅으로 돌아오고 탭 바가 사라진다. **이것이 지금 확정된 정상 동작이다** — 사용자가 추후 기능으로 미룬 항목이며 버그로 보고하지 않는다. 되돌리려면 backend `replyPlan`을 고치는 것이 정본 경로다.
  6. **구버전 backend 대조 — 조용한 실패가 아니다.** 절차: `planStatus`를 내지 않는 backend(예: `main`)를 향해 아무 메시지를 보낸다. 통과 조건: 응답 형식 오류를 알리는 **에러 말풍선이 뜬다**. 아무 일도 일어나지 않거나 패널만 안 뜨는 것은 실패다 — 결정 5가 막으려는 상태다.
