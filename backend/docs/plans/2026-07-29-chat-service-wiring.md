# chat 세 갈래를 기존 부품에 배선하는 구현 계획

> **For agentic workers:** 이 계획은 `tb-harness`의 work 단계가 태스크 묶음 단위로 실행한다.
> 각 Step의 체크박스(`- [ ]`)를 완료할 때마다 갱신한다.

**Goal:** `POST /chat`이 세 갈래 모두에서 하드코딩 문구 대신 Gemini를 실제로 태운다 — `other`는 대화 응답을, `plan_itinerary`·`recommend_places`는 구조화된 질의를 되비춘 문장을 돌려준다.

**Architecture:** **새 부품을 만들지 않는다.** `OtherResponder`·`QueryStructurer`·`buildStructuredReply` 셋 다 이미 구현·테스트가 끝나 있고 `ChatModule`에 등록까지 돼 있다. 이번 변경은 `ChatService.chat()`이 그 셋을 부르게 하는 배선이다. 핵심 안전 장치는 하나다: **`chat()`에 try/catch를 두지 않는다.** 세 협력자 중 누가 `ExternalServiceError`를 던져도 같은 인스턴스가 전역 필터까지 그대로 올라가야 한다.

---

## 설계

### 현행

**배선 대상 (전부 구현 완료 · 변경하지 않는다)**

- `src/chat/other/other.responder.ts:31-51` — `respond(message): Promise<string>`. Gemini `temperature: 0.7`, 검증 실패 시 `OTHER_REPLY` 폴백 + warn 1건. 호출 실패는 삼키지 않는다
- `src/chat/query/query.structurer.ts:41-72` — `structure(message): Promise<StructuredQuery>`. Gemini `temperature: 0`, 파싱 실패 시 원문 폴백 + warn 1건. 호출 실패는 삼키지 않는다
- `src/chat/query/query-reply.ts:66-75` — `buildStructuredReply(intent: 'plan_itinerary' | 'recommend_places', query: StructuredQuery): string`
- `src/chat/chat.module.ts:24-28` — **`providers`에 `ChatService`·`IntentClassifier`·`QueryStructurer`·`OtherResponder` 넷이 이미 등록돼 있다. 직접 확인했고, 모듈 변경은 불필요하다**

**배선할 곳**

- `src/chat/chat.service.ts:32-50` — `chat()`이 `IntentClassifier.classify()`로 분류만 하고 세 갈래를 각각 동기 private 메서드로 보낸다
- `src/chat/chat.service.ts:11-19` — placeholder 상수 3개. 주석(`:8-9`)이 "실제 구현이 들어오면 해당 상수와 메서드 본문이 함께 사라진다"고 예고해 뒀다
- `src/chat/chat.service.ts:56-77` — `planItinerary`·`recommendPlaces`·`replyOther` 세 private 메서드가 **전부 동기**다. `chat()`이 `async`라 반환은 그대로 흡수된다

**순환 참조의 씨앗**

- `src/chat/other/other.responder.ts:4` — `import { OTHER_REPLY } from '../chat.service'`. `chat.service.ts`가 `OtherResponder`를 import하면 `chat.service → other.responder → chat.service` 순환이 된다

**다시 쓰여야 하는 테스트**

- `src/chat/chat.service.spec.ts:53` — 테스트 모듈이 provider로 `IntentClassifier`만 주입한다
- `src/chat/chat.service.spec.ts:64-96` — `branchCases`가 세 갈래 각각이 placeholder 상수를 반환하는 것을 고정한다. 배선하면 통째로 무효가 된다
- `src/chat/chat.service.spec.ts:109-117` — 분류기의 `ExternalServiceError` 비삼킴 계약. **새로 붙는 두 호출에도 대칭으로 있어야 한다**(`test-asymmetry`)
- `src/chat/chat.controller.spec.ts:56` — `generate` mock **하나**가 모든 Gemini 호출을 받는다. 배선 후 구조화·other 갈래는 **요청당 2회**가 되므로 이 mock을 호출 지점별로 갈라야 한다
- `src/chat/chat.controller.spec.ts:79` — `beforeEach`가 `generate.mockReset().mockResolvedValue('other')`
- `src/chat/chat.controller.spec.ts:203-224` · `:226-237` · `:280-290` — 배선하면 깨지는 세 건 (아래 표)
- `src/chat/chat.controller.spec.ts:84-105` — 이 파일은 실제 `ChatModule`을 부팅한다. provider가 빠지면 여기서 죽는다

**함께 봐야 하는 경계**

- `src/clients/external-service.filter.ts:13-23` — `kind` → HTTP 매핑. **어떤 kind도 4xx가 되지 않는다**. `quota`는 `Retry-After: 60`
- `test/` e2e는 `POST /chat`을 타지 않는다 — `test/external-service.e2e-spec.ts:22-23`이 "chat 경로가 Gemini를 왕복하기 때문"이라고 이유를 적어 뒀다. **e2e는 이번 변경의 영향을 받지 않는다**(실측 확인)

### 발견 — 린트 게이트가 이미 깨져 있다

`main`(`9a9c392`)에서 `npx eslint src --max-warnings=0`이 **이미 실패한다.**

```
src/chat/chat.controller.spec.ts
  19:10  error  'OtherResponder' is defined but never used   @typescript-eslint/no-unused-vars
  20:10  error  'QueryStructurer' is defined but never used  @typescript-eslint/no-unused-vars
```

`it('ChatModule이 세 협력자와 Gemini 주입 경로를 제공한다')`가 제목과 달리 `IntentClassifier` 하나만 단정한다. import 둘은 그 단정을 쓰려다 만 흔적이다. **Task 1에서 먼저 복구한다** — 게이트가 빨간 채로 시작하면 이후 태스크마다 "원래 있던 2건인가 내가 만든 건가"를 판정해야 하고, 리뷰어도 같은 비용을 낸다.

### 결정

| # | 결정 | 버린 안 | 왜 버렸나 |
|---|---|---|---|
| 1 | `OTHER_REPLY`를 `src/chat/other/other-prompt.ts`로 옮긴다 | (a) 순환을 그대로 둔다 | CommonJS가 property 접근을 호출 시점까지 미뤄 **우연히** 동작한다. 모듈 초기화 순서에 기댄 동작이고, 어느 한쪽이 `import type`이 되거나 번들러가 바뀌면 런타임에 `undefined`가 된다 |
| 1 | ↑ | (b) 새 파일 `src/chat/chat-replies.ts`를 만든다 | 상수 하나짜리 파일이 늘고, other 갈래의 고정 문자열(지시문·상한·검증기)이 **이미 전부** `other-prompt.ts`에 있다 |
| 1 | ↑ | (c) `forwardRef`로 DI 순환을 푼다 | Nest DI만 덮고 **import 순환은 그대로 남는다.** 문제를 옮길 뿐이다 |
| 2 | `plan_itinerary`·`recommend_places`를 하나의 `case` 그룹 + `replyStructured` 하나로 묶는다 | 두 private 메서드를 유지하고 공용 헬퍼에 위임 | 오늘 두 본문이 **인자 리터럴 하나만** 다르다. 묶으면 그 사실이 주석이 아니라 구조가 되고, 묶인 case에서 `intent`가 `buildStructuredReply`의 파라미터 타입으로 정확히 좁혀져 리터럴 재기입도 사라진다. 대가는 트레이드오프 절에 적었다 |
| 3 | `chat.service.spec`의 모킹 경계는 **협력자 셋**(`IntentClassifier`·`QueryStructurer`·`OtherResponder`) | `GeminiClient`만 모킹하고 실물 협력자를 태운다 | 구조화 파싱·응답 검증은 `query.structurer.spec`·`other.responder.spec`이 이미 고정한다. 같은 것을 두 곳에서 검증하면 프롬프트를 고칠 때마다 라우팅 spec이 함께 빨간불이 된다 |
| 4 | `chat.controller.spec`의 `generate` mock을 `systemInstruction`으로 분기시킨다 | `mockResolvedValueOnce` 사슬 | 호출 **순서**가 테스트마다 암묵 계약이 되고, 갈래별 호출 수가 바뀔 때 전부 다시 세어야 한다 |
| 5 | placeholder 2개를 **배선과 같은 커밋에서** 지운다 | 별도 정리 커밋으로 미룬다 | 마지막 소비자가 바로 그 커밋에서 사라지는 테스트다. 미루면 한 커밋 동안 아무도 안 쓰는 export가 남는다 |
| 6 | 깨진 린트 게이트를 **첫 태스크**로 복구한다 | 배선 태스크에 끼워 넣는다 / 무시한다 | 위 "발견" 절 참조. 끼워 넣으면 커밋 하나가 두 가지 이유로 파일을 건드린다 |
| 7 | `chat.controller.spec`에 "대화 응답 상한 초과 → `OTHER_REPLY`" HTTP 케이스를 **더한다** | responder 단위 테스트로 충분하다고 본다 | `OtherResponder`의 폴백이 HTTP까지 관통하는지는 아무도 안 보고 있었다. 배선 후 이 경로가 502로 새거나 빈 말풍선이 되는 회귀를 잡을 유일한 테스트다 |

### 에러 처리

| 실패 지점 | HTTP 응답 | 상태 변경 | 재시도 | 관측 |
|---|---|---|---|---|
| `IntentClassifier`의 Gemini 실패 (`ExternalServiceError`) | 필터가 kind별 **500/502/503/504** (`external-service.filter.ts:13-23`). `quota`는 `Retry-After: 60` | 없음 | 안 함 | `callExternal`의 ERROR 로그 |
| `QueryStructurer`의 Gemini 실패 | 동일 | 없음 | 안 함 | 동일 |
| `OtherResponder`의 Gemini 실패 | 동일 | 없음 | 안 함 | 동일 |
| intent 파싱 실패 | **200** + other 갈래 응답 (폴백) | 없음 | 안 함 | `IntentClassifier` warn 1건 |
| 질의 구조화 파싱 실패 | **200** + 원문 폴백 기반 요약(`조건: 미지정`) | 없음 | 안 함 | `QueryStructurer` warn 1건 |
| 질의 조건 **일부** 검증 실패 | **200** + 살아남은 조건만 담은 요약 | 없음 | 안 함 | `QueryStructurer` warn 1건 (라벨 이름만, 값은 담지 않는다) |
| other 응답 검증 실패 (빈 값 · 501자 이상) | **200** + `OTHER_REPLY` | 없음 | 안 함 | `OtherResponder` warn 1건 |
| 입력 검증 실패 (`message` 빈값/1001자, `itinerary` 누락·잘못된 category) | **400** + `message: string[]` (`ValidationPipe`) | 없음 | 해당 없음 | **Gemini 호출 0건** |
| 4번째 intent 추가 후 switch 미수정 | (런타임 도달 불가) 컴파일 에러 | — | — | `const exhaustive: never` 대입 |

**절대 하지 않는 것 — `chat()`에 try/catch를 두지 않는다.** 세 협력자 중 누가 던져도 같은 인스턴스가 그대로 올라간다. 삼키면 쿼터 소진이 200 + 평범한 응답이 되고, **other 갈래는 특히 폴백 문구가 정상 응답과 구별되지 않아 장애가 눈에 보이지 않는다**(`failure-attribution`). 표의 세 "Gemini 실패" 행에 각각 테스트가 하나씩 붙는다 — 행 수와 테스트 수를 대조하는 것이 리뷰 기준이다(`test-asymmetry`).

### placeholder 상수 3개의 운명 — 비대칭이다

| 상수 | 배선 후 | 어디서 |
|---|---|---|
| `PLAN_ITINERARY_PLACEHOLDER_REPLY` | **죽는다.** `buildStructuredReply`가 대체 | Task 3에서 삭제 |
| `RECOMMEND_PLACES_PLACEHOLDER_REPLY` | **죽는다.** 동상 | Task 3에서 삭제 |
| `OTHER_REPLY` | **산다.** `OtherResponder`의 검증 실패 폴백으로 계속 쓰인다 | Task 2에서 `other/other-prompt.ts`로 이사 |

셋을 같은 종류로 다루면 안 된다. 앞의 둘은 "아직 구현이 없다"는 표시였고, `OTHER_REPLY`는 **정상 운영 중에도 발동하는 폴백 값**이다. 이사 후 `chat.service.ts`는 이 상수를 더 이상 참조하지 않는다.

### `plan_itinerary`와 `recommend_places`의 차이 — 오늘은 없다

두 갈래가 하는 일을 실제로 대조했다.

| | `plan_itinerary` | `recommend_places` |
|---|---|---|
| 호출하는 것 | `QueryStructurer.structure(message)` | 같음 |
| 넘기는 인자 | `request.message` | 같음 |
| 문장 조립 | `buildStructuredReply('plan_itinerary', query)` | `buildStructuredReply('recommend_places', query)` |
| `itinerary` | 입력 그대로 | 같음 |

**유일한 차이는 `buildStructuredReply`에 넘기는 intent이고**, 그 함수 안에서 머리말·맺음말 두 쌍이 갈린다(`query-reply.ts:70-74`). 그래서 결정 2로 케이스를 묶었다. TEI+Qdrant가 붙으면 실제로 갈라진다 — 그때 다시 나눈다.

### 트레이드오프

- **모든 갈래에서 Gemini 왕복이 요청당 1회 → 2회가 된다.** 인사·잡담 한 마디도 이제 두 번 왕복한다. 체감 지연이 대략 두 배, 쿼터 소비도 두 배. 요청당 상한은 2회이며 그 이상 늘리지 않는다 — `↔ 짝` 테스트 둘(`other는 structure를 안 부른다` / `구조화 갈래는 respond를 안 부른다`)이 그 상한을 지킨다.
- **응답이 비결정적이 된다.** `other` 갈래는 `temperature: 0.7`이라 같은 입력이 같은 문장을 내지 않는다. 그래서 `chat.controller.spec`은 문구 자체가 아니라 **위임 경로**를 고정한다. 구조화 갈래는 `temperature: 0`이지만 모델 별칭이 움직이므로 여전히 재현이 보장되지 않는다.
- **모델 출력이 사용자 화면에 그대로 나가는 첫 경로가 열린다.** 방어선은 프롬프트 규칙 셋(확률적) + 길이 상한 하나(결정론적)뿐이다(`other-prompt.ts:23-35`, `:66-71`). 이 배선은 그 위험을 **활성화**한다.
- **`replyStructured` 통합은 다음 실행에서 되돌려야 한다.** TEI+Qdrant와 일정 조립이 붙으면 두 갈래가 실제로 갈리고, 이 메서드를 다시 쪼개는 커밋이 필요하다. 오늘 미리 쪼개 두는 대가(같은 본문 둘)보다 낫다고 판단했다.
- **`chat.controller.spec`의 `mockGemini`가 `INTENT_SYSTEM_INSTRUCTION`에 결합된다.** 지시문 상수가 바뀌면 이 헬퍼도 함께 움직인다. 순서 기반 사슬보다 낫다고 봤지만 공짜는 아니다.
- **화면상 "기능이 생긴 것처럼" 보이는 정도가 커진다.** `준비 중이에요` 대신 `일정 요청으로 이해했어요 — 지역: 제주. 장소를 찾아 일정을 짜는 단계는 다음에 붙습니다.`가 나간다. 여전히 일정은 만들어지지 않는다.

### 범위 밖

- **TEI 임베딩 · Qdrant 검색** — 이번엔 질의 텍스트를 만드는 데까지다. `StructuredQuery.queryText`는 배선 후에도 **아무도 소비하지 않는다**
- **일정 생성 · `itinerary` 변경** — 세 갈래 모두 입력 `itinerary`를 **참조 그대로** 돌려준다
- **포맷 변경** — `QUERY_LABELS` 7줄(`structured-query.ts:13-21`) · `CONDITION_LABELS` 4줄(`query-prompt.ts:26-31`) · `buildStructuredReply`의 문장 틀을 손대지 않는다. 사용자와 확인된 사항
- **`ChatResponseDto` 변경** — `fellBackToRawMessage`를 HTTP로 노출하지 않는다. 폴백의 관측 수단은 warn 로그 하나다
- **대화 이력 · DB** — `ChatModule`은 계속 `DatabaseModule`을 import하지 않는다
- **지역명 → `ldong_regn_cd` 변환** — Postgres 코드표가 필요하고 사내망 전용이다
- **`chat.module.ts` 변경** — 확인 결과 provider 넷이 이미 등록돼 있다. **이 파일을 건드리면 이탈이다**
- **프롬프트·검증기 변경** — `other-prompt.ts`·`query-prompt.ts`의 지시문과 파서를 손대지 않는다 (Task 2의 상수 이사 제외)

---

## Global Constraints

- 작업 디렉터리는 `backend/`. 모든 명령은 거기서 실행한다.
- 주석·로그 메시지·에러 메시지·커밋 메시지는 **한국어**로 쓴다.
- 테스트 파일은 소스 옆 `*.spec.ts` (jest `rootDir`가 `src`).
- 단위 테스트는 전부 모킹이다. **실제 네트워크·DB 호출을 하지 않는다.**
- 테스트: `npm test` / 타입 검사: `npx tsc --noEmit -p tsconfig.json` / 린트: `npx eslint src --max-warnings=0`
- **prettier가 `error`다.** 이 문서의 코드 블록은 전부 `npm run lint`(=`--fix`) 통과 형태로 옮겼지만, 삽입 위치가 달라져 줄바꿈이 어긋나면 **손으로 맞추지 말고 `npm run lint`에 맡긴다.**
- **`ts-jest`는 타입 검사를 하지 않는다.** 없는 export를 import하면 컴파일 에러가 아니라 런타임 `undefined`가 된다(Task 2 Step 2에서 실측). 타입 오류는 `npx tsc --noEmit`에서만 드러난다.
- **기준은 이 문서의 코드 블록이 아니라 커밋된 코드다.** 블록이 현재 파일과 다르면 이탈로 보고한다.
- **이 계획의 코드 블록은 전부 `backend/`에서 실제로 실행해 검증했다** (tsc · eslint · `npm test` · `npm run build` · `npm run test:e2e`). 태스크 경계마다 따로 돌렸다.
- **`chat.module.ts`를 수정하지 않는다.** 필요한 provider가 전부 등록돼 있다.
- **`chat()`에 try/catch를 두지 않는다.**

---

### Task 1: 깨진 린트 게이트를 복구한다

`main`에서 `npx eslint src --max-warnings=0`이 이미 실패한다. 배선을 시작하기 전에 초록으로 만들어야 이후 태스크의 게이트가 신호를 준다.

**Files:**
- Test: `src/chat/chat.controller.spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

> **이 태스크에는 "실패하는 테스트 작성" Step이 없다.** 실패가 이미 게이트에 떠 있고, 새 테스트를 지어내면 그것은 즉시 통과해서 red를 볼 수 없다. 아래 Step 1이 그 red다.

- [ ] **Step 1: 실패를 확인**

```
npx eslint src --max-warnings=0
```

Expected: FAIL — 정확히 2건
```
src/chat/chat.controller.spec.ts
  19:10  error  'OtherResponder' is defined but never used   @typescript-eslint/no-unused-vars
  20:10  error  'QueryStructurer' is defined but never used  @typescript-eslint/no-unused-vars
```

- [ ] **Step 2: 단정을 제목대로 채운다**

`src/chat/chat.controller.spec.ts`의 `it('ChatModule이 세 협력자와 Gemini 주입 경로를 제공한다', ...)` 안, 마지막 `expect(...)` 블록(`:128-130`)을 아래로 **교체**:

```ts
    // 셋을 모두 센다. 하나라도 provider에서 빠지면 ChatService 주입이 부팅
    // 단계에서 죽으므로, 제목이 말하는 "세 협력자"를 여기서 그대로 단정한다.
    expect(moduleFixture.get(IntentClassifier)).toBeInstanceOf(
      IntentClassifier,
    );
    expect(moduleFixture.get(QueryStructurer)).toBeInstanceOf(QueryStructurer);
    expect(moduleFixture.get(OtherResponder)).toBeInstanceOf(OtherResponder);
```

- [ ] **Step 3: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — **테스트 수는 변하지 않는다**(단정만 늘었다). 린트가 처음으로 초록이 된다.

- [ ] **Step 4: 커밋**

```bash
git add src/chat/chat.controller.spec.ts
git commit -m "test(backend): ChatModule 협력자 단정을 제목대로 셋으로 채운다

import 둘이 쓰이지 않아 npx eslint src --max-warnings=0이 main에서
이미 실패하고 있었다. 게이트가 빨간 채로 배선을 시작하면 이후 태스크마다
'원래 있던 2건인가 내가 만든 건가'를 판정해야 한다. 미사용 import를
지우는 대신 단정을 채운 이유는 테스트 제목이 이미 셋을 약속하기 때문이다."
```

---

### Task 2: `OTHER_REPLY`를 `other/other-prompt.ts`로 옮긴다

`chat.service.ts`가 `OtherResponder`를 import하기 전에 순환의 씨앗을 없앤다. **동작 변경이 없는 순수 이사**다.

**Files:**
- Modify: `src/chat/other/other-prompt.ts`, `src/chat/other/other.responder.ts`, `src/chat/chat.service.ts`
- Test: `src/chat/other/other-prompt.spec.ts`, `src/chat/other/other.responder.spec.ts`, `src/chat/chat.service.spec.ts`, `src/chat/chat.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 (린트 초록)
- Produces: `OTHER_REPLY: string` — `src/chat/other/other-prompt.ts`에서 export

- [ ] **Step 1: 실패하는 테스트 작성**

`src/chat/other/other-prompt.spec.ts` 맨 위 import 블록을 아래로 **교체**:

```ts
import {
  buildOtherPrompt,
  OTHER_REPLY,
  OTHER_SYSTEM_INSTRUCTION,
  validateOtherReply,
} from './other-prompt';
```

같은 파일의 `describe('buildOtherPrompt', ...)` **바로 앞**에 추가:

```ts
describe('OTHER_REPLY', () => {
  it('검증기를 그대로 통과한다', () => {
    // 폴백 문구 자체가 상한에 걸리면 이 갈래는 검증 실패 시 돌려줄 값이 없다.
    // 상수와 검증기가 같은 파일에 있어야 그 사실이 한자리에서 드러난다 —
    // chat.service.ts에 두면 other.responder → chat.service 순환도 함께 생긴다.
    expect(validateOtherReply(OTHER_REPLY)).toBe(OTHER_REPLY);
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- other-prompt
```

Expected: FAIL — **1 failed, 11 passed**. 실측한 메시지는 아래다. `ts-jest`가 타입 검사를 하지 않으므로 `TS2305`가 아니라 런타임 `undefined`로 터진다:

```
● OTHER_REPLY › 검증기를 그대로 통과한다

  TypeError: Cannot read properties of undefined (reading 'trim')

    at validateOtherReply (chat/other/other-prompt.ts:67:23)
    at Object.<anonymous> (chat/other/other-prompt.spec.ts:47:30)
```

- [ ] **Step 3: 구현 — 상수를 옮기고 참조 넷을 고친다**

**(1)** `src/chat/other/other-prompt.ts` **맨 앞**(`/** 응답 길이 상한.` 블록 바로 위)에 삽입:

```ts
/**
 * 검증에 걸린 응답을 대체하는 고정 문구. 프론트엔드 mock의 폴백 문구
 * (frontend/src/lib/mock/scenarios.ts:39-43)와 같은 값이다.
 *
 * chat.service.ts에 있던 것을 옮겼다. ChatService가 OtherResponder를 주입받으면
 * chat.service → other.responder → chat.service 순환이 생기는데, 이 값은
 * other 갈래의 폴백일 뿐이고 그 갈래의 고정 문자열이 전부 이 파일에 있다.
 */
export const OTHER_REPLY =
  "어디로 떠나고 싶으신가요? '제주 2박3일'처럼 목적지와 기간을 말씀해주시면 바로 일정을 만들어드릴게요.";

```

**(2)** `src/chat/other/other.responder.ts:1-10`의 import 블록을 아래로 **교체**:

```ts
import { Injectable, Logger } from '@nestjs/common';

import { GeminiClient } from '../../clients/gemini/gemini.client';
import {
  buildOtherPrompt,
  OTHER_REPLY,
  OTHER_REPLY_MAX_LENGTH,
  OTHER_SYSTEM_INSTRUCTION,
  validateOtherReply,
} from './other-prompt';
```

**(3)** `src/chat/chat.service.ts:5-19`(import `IntentClassifier` 줄부터 `OTHER_REPLY` 정의 끝까지)를 아래로 **교체**. `OTHER_REPLY` 정의가 사라지고 import가 그 자리를 받는다:

```ts
import { IntentClassifier } from './intent/intent.classifier';
import { OTHER_REPLY } from './other/other-prompt';

/**
 * 분기별 임시 문구. 실제 구현이 들어오면 해당 상수와 메서드 본문이 함께 사라진다.
 * export하는 것은 테스트 때문이지 공개 계약이기 때문이 아니다.
 */
export const PLAN_ITINERARY_PLACEHOLDER_REPLY =
  '일정을 새로 짜 드리는 기능은 아직 준비 중이에요. 조금만 기다려 주세요.';

export const RECOMMEND_PLACES_PLACEHOLDER_REPLY =
  '여행지를 추천해 드리는 기능은 아직 준비 중이에요. 조금만 기다려 주세요.';
```

**(4)** `src/chat/other/other.responder.spec.ts:7-8` 두 줄을 한 줄로 **교체**:

```ts
import { OTHER_REPLY, OTHER_SYSTEM_INSTRUCTION } from './other-prompt';
```

**(5)** `src/chat/chat.service.spec.ts:4-12`의 import 블록을 아래로 **교체**:

```ts
import {
  ChatService,
  PLAN_ITINERARY_PLACEHOLDER_REPLY,
  RECOMMEND_PLACES_PLACEHOLDER_REPLY,
} from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';
import { OTHER_REPLY } from './other/other-prompt';
```

**(6)** `src/chat/chat.controller.spec.ts:12-19`의 import 블록을 아래로 **교체**:

```ts
import {
  PLAN_ITINERARY_PLACEHOLDER_REPLY,
  RECOMMEND_PLACES_PLACEHOLDER_REPLY,
} from './chat.service';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';
import { OTHER_REPLY } from './other/other-prompt';
import { OtherResponder } from './other/other.responder';
import { QueryStructurer } from './query/query.structurer';
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — **401건**(실측). 동작은 하나도 바뀌지 않았다.

- [ ] **Step 5: 커밋**

```bash
git add src/chat/chat.controller.spec.ts src/chat/chat.service.spec.ts src/chat/chat.service.ts src/chat/other/
git commit -m "refactor(backend): OTHER_REPLY를 other-prompt로 옮겨 순환 참조를 막는다

ChatService가 OtherResponder를 주입받으면 chat.service → other.responder
→ chat.service 순환이 된다. CommonJS라 우연히 동작하지만 모듈 초기화
순서에 기댄 동작이고, import type이나 번들러 변경 한 번에 undefined가 된다.
forwardRef는 DI만 덮고 import 순환은 남기므로 기각했다. 이 값은 other 갈래의
폴백일 뿐이고 그 갈래의 고정 문자열이 이미 전부 other-prompt.ts에 있다."
```

---

### Task 3: `plan_itinerary`·`recommend_places`를 `QueryStructurer`에 배선한다

두 갈래가 placeholder 대신 구조화 결과를 되비춘 문장을 돌려주게 한다. placeholder 상수 둘은 여기서 죽는다.

**Files:**
- Modify: `src/chat/chat.service.ts`
- Test: `src/chat/chat.service.spec.ts`, `src/chat/chat.controller.spec.ts`

**Interfaces:**
- Consumes: Task 2의 `OTHER_REPLY` (`other/other-prompt.ts`) · 기존 `QueryStructurer.structure` · 기존 `buildStructuredReply`
- Produces: `ChatService` 생성자가 `(IntentClassifier, QueryStructurer)`를 받는다

- [ ] **Step 1: 실패하는 테스트 작성**

`src/chat/chat.service.spec.ts`를 **아래 전문으로 교체한다**(기존 파일을 통째로 대체):

```ts
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../clients/external-service.error';
import { ChatService } from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';
import { OTHER_REPLY } from './other/other-prompt';
import { buildStructuredReply } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';
import type { StructuredQuery } from './query/structured-query';
import { EMPTY_CONDITIONS } from './query/structured-query';

/**
 * 갈래 라우팅과 위임만 본다. 모킹 경계는 협력자다 — 분류는
 * intent.classifier.spec.ts가, 구조화는 query.structurer.spec.ts가,
 * 문장 서식은 query-reply.spec.ts가 따로 고정한다.
 */

/** buildStructuredReply가 받는 갈래. 두 갈래가 같은 본문을 쓴다. */
type StructuredIntent = 'plan_itinerary' | 'recommend_places';

const classify = jest.fn<Promise<ChatIntent>, [string]>();
const structure = jest.fn<Promise<StructuredQuery>, [string]>();

const STRUCTURED: StructuredQuery = {
  queryText: '무엇을 하는 곳: 일출 감상',
  conditions: { ...EMPTY_CONDITIONS, region: '제주' },
  droppedLabels: [],
  fellBackToRawMessage: false,
};

function createRequest(message: string): ChatRequestDto {
  return {
    message,
    itinerary: {
      summary: {
        destination: '제주',
        duration: '2박 3일',
        travelers: '성인 2명',
      },
      days: [
        {
          day: 1,
          places: [
            {
              id: 'place-1',
              name: '성산일출봉',
              category: '관광지',
              time: '09:00',
              description: '일출 명소',
              pinNumber: 1,
            },
          ],
        },
      ],
    },
  };
}

async function createService(): Promise<ChatService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatService,
      { provide: IntentClassifier, useValue: { classify } },
      { provide: QueryStructurer, useValue: { structure } },
    ],
  }).compile();
  return moduleRef.get(ChatService);
}

function quotaFailure(): ExternalServiceError {
  return new ExternalServiceError('gemini', 'quota', '쿼터 소진');
}

beforeEach(() => {
  classify.mockReset();
  structure.mockReset().mockResolvedValue(STRUCTURED);
});

describe('ChatService — 갈래 라우팅', () => {
  const structuredIntents: StructuredIntent[] = [
    'plan_itinerary',
    'recommend_places',
  ];

  it.each(structuredIntents)(
    '%s는 구조화 결과를 되비춘 문장을 돌려준다',
    async (intent) => {
      classify.mockResolvedValue(intent);
      const service = await createService();

      const response = await service.chat(createRequest('제주 2박3일'));

      // 기대값을 buildStructuredReply로 계산한다. 이 spec이 고정하는 것은 문장
      // 서식이 아니라 "분류된 intent와 구조화 결과를 그대로 넘겼는가"다.
      // 서식 자체는 query-reply.spec.ts가 전문 등가로 고정한다.
      expect(response.reply).toBe(buildStructuredReply(intent, STRUCTURED));
    },
  );

  it('other는 안내 문구를 돌려준다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequest('안녕'));

    expect(response.reply).toBe(OTHER_REPLY);
  });

  const allIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
    'other',
  ];

  it.each(allIntents)(
    '%s는 itinerary를 입력 그대로 돌려준다',
    async (intent) => {
      // 참조 동일성까지 본다. 어느 갈래든 아직 일정을 손대지 않는다.
      classify.mockResolvedValue(intent);
      const service = await createService();
      const request = createRequest('아무 말');

      const response = await service.chat(request);

      expect(response.itinerary).toBe(request.itinerary);
    },
  );

  it('분류기를 message만으로 호출한다', async () => {
    // itinerary·대화 이력을 프롬프트에 싣지 않는다는 결정이 여기서 고정된다.
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 2박3일 일정 짜줘'));

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith('제주 2박3일 일정 짜줘');
  });
});

describe('ChatService — 구조화 위임', () => {
  it('구조화 갈래는 QueryStructurer를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    await service.chat(createRequest('제주 2박3일 가족여행 짜줘'));

    expect(structure).toHaveBeenCalledTimes(1);
    expect(structure).toHaveBeenCalledWith('제주 2박3일 가족여행 짜줘');
  });

  it('↔ 짝: other 갈래는 QueryStructurer를 호출하지 않는다', async () => {
    // 이 케이스가 없으면 분류와 무관하게 늘 구조화하는 구현도 통과한다 —
    // other 한 마디마다 Gemini 왕복이 하나씩 늘어도 아무도 모른다.
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('안녕'));

    expect(structure).not.toHaveBeenCalled();
  });
});

describe('ChatService — 실패를 삼키지 않는다', () => {
  it('분류기가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 여기에 try/catch를 두면 쿼터 소진이 200 + 안내 문구가 되고
    // 전역 필터의 503 + Retry-After가 사라진다.
    const failure = quotaFailure();
    classify.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });

  it('QueryStructurer가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 분류기와 대칭이어야 한다. 한쪽만 고정하면 새로 붙은 호출이 조용히
    // 200 + 조건 미지정 요약으로 축퇴해도 테스트가 초록불을 준다.
    const failure = quotaFailure();
    classify.mockResolvedValue('plan_itinerary');
    structure.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 2박3일'))).rejects.toBe(
      failure,
    );
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- chat.service
```

Expected: FAIL — **4건**. 각각의 이유가 다르므로 넷을 모두 확인한다:

| 실패 테스트 | 메시지 |
|---|---|
| `plan_itinerary는 구조화 결과를 되비춘 문장을 돌려준다` | `expect(received).toBe(expected)` — received가 `"일정을 새로 짜 드리는 기능은 아직 준비 중이에요. 조금만 기다려 주세요."` |
| `recommend_places는 구조화 결과를 되비춘 문장을 돌려준다` | 동상, received가 `"여행지를 추천해 드리는 기능은 아직 준비 중이에요. ..."` |
| `구조화 갈래는 QueryStructurer를 message만으로 한 번 호출한다` | `Expected number of calls: 1 / Received number of calls: 0` |
| `QueryStructurer가 던진 ExternalServiceError를 삼키지 않는다` | `Received promise resolved instead of rejected` |

`↔ 짝: other 갈래는 QueryStructurer를 호출하지 않는다`는 **통과한다** — 아직 아무 데서도 안 부르기 때문이다. 정상이다.

- [ ] **Step 3: 구현**

`src/chat/chat.service.ts`를 **아래 전문으로 교체한다**. placeholder 상수 둘이 여기서 사라진다:

```ts
import { Injectable } from '@nestjs/common';

import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';
import { OTHER_REPLY } from './other/other-prompt';
import { buildStructuredReply } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';

@Injectable()
export class ChatService {
  constructor(
    private readonly intentClassifier: IntentClassifier,
    private readonly queryStructurer: QueryStructurer,
  ) {}

  /**
   * 메시지를 분류해 갈래로 보낸다.
   *
   * 협력자가 던진 ExternalServiceError를 잡지 않는다 — 전역 필터가
   * kind별로 500/502/503/504로 매핑한다. 여기서 삼키면 쿼터 소진이
   * "여행과 무관한 메시지"로 둔갑한다.
   */
  async chat(request: ChatRequestDto): Promise<ChatResponseDto> {
    const intent = await this.intentClassifier.classify(request.message);

    switch (intent) {
      // 두 갈래를 묶는다. 오늘 유일한 차이는 buildStructuredReply에 넘기는
      // intent이고, 케이스를 묶으면 그 사실이 주석이 아니라 구조가 된다.
      // 묶인 케이스에서 intent가 buildStructuredReply의 파라미터 타입으로
      // 정확히 좁혀지므로 리터럴을 다시 적지도 않는다.
      case 'plan_itinerary':
      case 'recommend_places':
        return this.replyStructured(intent, request);
      case 'other':
        return this.replyOther(request);
      default: {
        // 컴파일 타임 exhaustiveness 확인 수단이다. parseIntent가 CHAT_INTENTS
        // 멤버십을 이미 확인하므로 런타임에 도달하지 않는다. 4번째 분류값을
        // 더하면 이 대입이 컴파일 에러를 낸다.
        const exhaustive: never = intent;
        throw new Error(`분류되지 않은 intent: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * 구조화 결과를 사용자에게 되비춘다.
   *
   * TODO: TEI 임베딩 + Qdrant 검색과 일정 조립을 붙이는 자리. 그때 두 갈래가
   * 갈라지므로 이 메서드도 함께 나뉜다 — 지금 나눠 두면 같은 본문이 둘이 된다.
   * itinerary는 아직 손대지 않는다.
   */
  private async replyStructured(
    intent: 'plan_itinerary' | 'recommend_places',
    request: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    const query = await this.queryStructurer.structure(request.message);

    return {
      reply: buildStructuredReply(intent, query),
      itinerary: request.itinerary,
    };
  }

  /** TODO: OtherResponder에 위임하는 자리. 지금은 안내 문구만 돌려준다. */
  private replyOther(request: ChatRequestDto): ChatResponseDto {
    return {
      reply: OTHER_REPLY,
      itinerary: request.itinerary,
    };
  }
}
```

- [ ] **Step 4: 컨트롤러 spec을 배선에 맞춘다**

`chat.service`는 초록이 됐지만 `chat.controller.spec`이 아직 placeholder 상수를 import한다. 아래 넷을 고친다.

**(4-1)** `src/chat/chat.controller.spec.ts:11-19`의 import 블록을 아래로 **교체**(placeholder 둘이 빠지고 셋이 들어온다):

```ts
import { ChatModule } from './chat.module';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { INTENT_SYSTEM_INSTRUCTION } from './intent/intent-prompt';
import { IntentClassifier } from './intent/intent.classifier';
import { OTHER_REPLY } from './other/other-prompt';
import { OtherResponder } from './other/other.responder';
import { PLAN_REPLY_HEAD, RECOMMEND_REPLY_HEAD } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';
```

**(4-2)** `const generate = jest.fn<...>();` 줄 **바로 아래**에 추가:

```ts

/** 파싱에 성공하는 구조화 응답. 조건 하나만 담아 요약이 '미지정'이 되지 않게 한다. */
const QUERY_RESPONSE = [
  '[조건]',
  '지역: 제주',
  '[질의]',
  '무엇을 하는 곳: 일출 감상',
].join('\n');

/**
 * 구조화 갈래는 요청 하나에 generate를 두 번 부른다 — 분류 1회 + 갈래별 1회.
 * 그래서 호출 지점을 systemInstruction으로 가른다. mockResolvedValueOnce 사슬을
 * 쓰면 호출 순서가 테스트마다 암묵 계약이 되고, 갈래가 늘 때 전부 다시 세어야 한다.
 */
function mockGemini(intentResponse: string, branchResponse: string): void {
  generate.mockImplementation((_prompt, opts) =>
    Promise.resolve(
      opts?.systemInstruction === INTENT_SYSTEM_INSTRUCTION
        ? intentResponse
        : branchResponse,
    ),
  );
}
```

**(4-3)** `it('세 분류값이 각각 다른 reply로 200이 된다', ...)` 안의 `generate.mockResolvedValue(intent);` 한 줄을 아래로 **교체**:

```ts
      mockGemini(intent, QUERY_RESPONSE);
```

**(4-4)** 같은 테스트 끝의 `expect(replies).toEqual([...]);` 블록을 아래로 **교체**:

```ts
    expect(replies[0]).toContain(PLAN_REPLY_HEAD);
    expect(replies[1]).toContain(RECOMMEND_REPLY_HEAD);
    expect(replies[2]).toBe(OTHER_REPLY);
    // 세 문구가 실제로 갈리는지 센다. 위 셋만으로는 두 구조화 갈래가 같은
    // 문장이 돼도(머리말만 다르고 나머지가 뭉개져도) 통과할 수 있다.
    expect(new Set(replies).size).toBe(3);
```

- [ ] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — **404건**(실측). prettier가 걸리면 `npm run lint`로 맞춘다.

- [ ] **Step 6: 커밋**

```bash
git add src/chat/chat.service.ts src/chat/chat.service.spec.ts src/chat/chat.controller.spec.ts
git commit -m "feat(backend): 구조화 두 갈래를 QueryStructurer에 배선한다

두 갈래의 본문이 buildStructuredReply에 넘기는 intent 하나만 다르므로
case를 묶었다. 묶인 case에서 intent가 그 함수의 파라미터 타입으로
정확히 좁혀져 리터럴을 다시 적지 않아도 된다. TEI+Qdrant가 붙으면
실제로 갈라지고 그때 다시 나눈다 — 지금 나눠 두면 같은 본문이 둘이 된다.

컨트롤러 spec의 generate mock은 요청당 두 번 불리게 됐다. 순서 기반
mockResolvedValueOnce 사슬 대신 systemInstruction으로 호출 지점을
가른다 — 순서를 계약으로 삼으면 갈래가 늘 때 전부 다시 세어야 한다."
```

---

### Task 4: `other`를 `OtherResponder`에 배선한다

마지막 갈래. 이 커밋으로 세 갈래 모두 Gemini를 실제로 태운다.

**Files:**
- Modify: `src/chat/chat.service.ts`
- Test: `src/chat/chat.service.spec.ts`, `src/chat/chat.controller.spec.ts`

**Interfaces:**
- Consumes: Task 3의 `ChatService(IntentClassifier, QueryStructurer)` · 기존 `OtherResponder.respond`
- Produces: `ChatService` 생성자가 `(IntentClassifier, QueryStructurer, OtherResponder)`를 받는다

- [ ] **Step 1: 실패하는 테스트 작성 — `chat.service.spec.ts`**

**(1-1)** import 중 `import { OTHER_REPLY } from './other/other-prompt';` 한 줄을 아래로 **교체**:

```ts
import { OtherResponder } from './other/other.responder';
```

**(1-2)** `const structure = jest.fn<...>();` 줄 **바로 아래**에 추가하고, `STRUCTURED` 상수 **아래**에 `OTHER_RESPONSE`를 둔다 — 교체 후 전문:

```ts
const classify = jest.fn<Promise<ChatIntent>, [string]>();
const structure = jest.fn<Promise<StructuredQuery>, [string]>();
const respond = jest.fn<Promise<string>, [string]>();

const STRUCTURED: StructuredQuery = {
  queryText: '무엇을 하는 곳: 일출 감상',
  conditions: { ...EMPTY_CONDITIONS, region: '제주' },
  droppedLabels: [],
  fellBackToRawMessage: false,
};

/**
 * OtherResponder가 돌려주는 값. OTHER_REPLY를 쓰지 않는다 — 그 상수는 이제
 * responder 안쪽의 폴백이고, 여기서 쓰면 위임이 끊겨도 값이 같아 통과한다.
 */
const OTHER_RESPONSE =
  '제주는 사계절 모두 좋아요. 어느 계절을 생각하고 계신가요?';
```

**(1-3)** `createService`의 providers 배열에 한 줄 추가 — 교체 후 전문:

```ts
    providers: [
      ChatService,
      { provide: IntentClassifier, useValue: { classify } },
      { provide: QueryStructurer, useValue: { structure } },
      { provide: OtherResponder, useValue: { respond } },
    ],
```

**(1-4)** `beforeEach` 블록을 아래로 **교체**:

```ts
beforeEach(() => {
  classify.mockReset();
  structure.mockReset().mockResolvedValue(STRUCTURED);
  respond.mockReset().mockResolvedValue(OTHER_RESPONSE);
});
```

**(1-5)** `it('other는 안내 문구를 돌려준다', ...)` 전체를 아래로 **교체**:

```ts
  it('other는 OtherResponder의 응답을 그대로 돌려준다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequest('안녕'));

    expect(response.reply).toBe(OTHER_RESPONSE);
  });
```

**(1-6)** `describe('ChatService — 구조화 위임', ...)`가 닫히는 `});` **바로 뒤**에 새 describe를 추가:

```ts

describe('ChatService — 대화 위임', () => {
  it('other 갈래는 OtherResponder를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 어때?'));

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('제주 어때?');
  });

  it('↔ 짝: 구조화 갈래는 OtherResponder를 호출하지 않는다', async () => {
    // 구조화 갈래가 대화 응답까지 부르면 요청 하나에 Gemini 왕복이 셋이 된다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    await service.chat(createRequest('제주 2박3일'));

    expect(respond).not.toHaveBeenCalled();
  });
});
```

**(1-7)** 파일 맨 끝 `describe('ChatService — 실패를 삼키지 않는다', ...)` 안, 마지막 `it` 뒤에 추가:

```ts

  it('OtherResponder가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 세 협력자에 대해 대칭으로 고정한다. other 갈래는 폴백 문구가 정상 응답과
    // 구별되지 않으므로, 여기서 삼키면 쿼터 소진이 평범한 대화로 보인다.
    const failure = quotaFailure();
    classify.mockResolvedValue('other');
    respond.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- chat.service
```

Expected: FAIL — **3건**:

| 실패 테스트 | 메시지 |
|---|---|
| `other는 OtherResponder의 응답을 그대로 돌려준다` | `expect(received).toBe(expected)` — received가 `OTHER_REPLY`("어디로 떠나고 싶으신가요? ...") |
| `other 갈래는 OtherResponder를 message만으로 한 번 호출한다` | `Expected number of calls: 1 / Received number of calls: 0` |
| `OtherResponder가 던진 ExternalServiceError를 삼키지 않는다` | `Received promise resolved instead of rejected` |

`↔ 짝: 구조화 갈래는 OtherResponder를 호출하지 않는다`는 **통과한다**. 정상이다.

- [ ] **Step 3: 구현**

`src/chat/chat.service.ts`에서 세 곳을 고친다.

**(3-1)** import 중 `import { OTHER_REPLY } from './other/other-prompt';` 를 아래로 **교체**:

```ts
import { OtherResponder } from './other/other.responder';
```

**(3-2)** 생성자와 `chat()`의 doc 첫 줄을 아래로 **교체**:

```ts
  constructor(
    private readonly intentClassifier: IntentClassifier,
    private readonly queryStructurer: QueryStructurer,
    private readonly otherResponder: OtherResponder,
  ) {}

  /**
   * 메시지를 분류해 갈래로 보낸다.
   *
   * 협력자 셋이 던진 ExternalServiceError를 잡지 않는다 — 전역 필터가
   * kind별로 500/502/503/504로 매핑한다. 여기서 삼키면 쿼터 소진이
   * "여행과 무관한 메시지"로 둔갑한다.
   */
```

**(3-3)** `replyOther` 메서드 전체(주석 포함)를 아래로 **교체**:

```ts
  /**
   * 대화 응답을 만든다. 이 갈래는 일정을 만들지 않으므로 itinerary가
   * 입력 그대로 나가는 것이 최종 형태다 — 위 두 갈래와 달리 TODO가 없다.
   */
  private async replyOther(request: ChatRequestDto): Promise<ChatResponseDto> {
    return {
      reply: await this.otherResponder.respond(request.message),
      itinerary: request.itinerary,
    };
  }
```

- [ ] **Step 4: 컨트롤러 spec을 배선에 맞춘다**

`other` 갈래도 `generate`를 두 번 부르게 되어 세 건이 깨진다. 넷을 고치고 하나를 더한다.

**(4-1)** `QUERY_RESPONSE` 상수 **바로 아래**에 추가:

```ts

/** 검증을 통과하는 대화 응답. OTHER_REPLY와 달라야 폴백과 정상을 구별할 수 있다. */
const OTHER_RESPONSE = '제주는 사계절 모두 좋아요. 어느 계절이 좋으세요?';
```

**(4-2)** `beforeEach` 안의 `generate.mockReset().mockResolvedValue('other');` 한 줄을 아래로 **교체**:

```ts
    generate.mockReset();
    mockGemini('other', OTHER_RESPONSE);
```

**(4-3)** `it('세 분류값이 각각 다른 reply로 200이 된다', ...)` 안의 `mockGemini(intent, QUERY_RESPONSE);`(Task 3에서 넣은 줄)를 아래로 **교체**:

```ts
      // 구조화 갈래는 QUERY_RESPONSE를, other 갈래는 그 문자열을 그대로 대화
      // 응답으로 받는다 — 검증을 통과하므로 셋이 서로 다른 문구가 된다.
      mockGemini(intent, intent === 'other' ? OTHER_RESPONSE : QUERY_RESPONSE);
```

같은 테스트의 `expect(replies[2]).toBe(OTHER_REPLY);` 한 줄을 아래로 **교체**:

```ts
    expect(replies[2]).toBe(OTHER_RESPONSE);
```

**(4-4)** `it('해석할 수 없는 응답이면 200 + other 문구가 나간다', ...)` 전체를 아래로 **교체**(테스트 이름이 바뀌고, 뒤에 새 테스트가 하나 붙는다):

```ts
  it('분류를 해석할 수 없으면 200 + other 갈래 응답이 나간다', async () => {
    // 폴백이 HTTP까지 관통한다. 진짜 other와 바이트 단위로 같은 응답이며
    // 구별은 IntentClassifier의 warn 로그에만 존재한다.
    mockGemini('분류: plan_itinerary 입니다', OTHER_RESPONSE);

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일 일정 짜줘', itinerary: createItinerary() })
      .expect(200);

    expect((response.body as ChatResponseDto).reply).toBe(OTHER_RESPONSE);
  });

  it('대화 응답이 상한을 넘으면 200 + 고정 문구가 나간다', async () => {
    // OtherResponder의 폴백이 HTTP까지 관통한다. 이 경로가 없으면 상한
    // 초과가 502로 새거나 빈 말풍선이 되는 회귀를 아무도 잡지 못한다.
    mockGemini('other', '가'.repeat(501));

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '안녕', itinerary: createItinerary() })
      .expect(200);

    expect((response.body as ChatResponseDto).reply).toBe(OTHER_REPLY);
  });
```

**(4-5)** `it('message가 1000자면 200이고 gemini를 호출한다', ...)` 끝의 두 단정을 아래로 **교체**:

```ts
    expect((response.body as ChatResponseDto).reply).toBe(OTHER_RESPONSE);
    // 2회다 — 분류 1회 + other 갈래 1회. 갈래 호출이 사라지면 여기가 깨진다.
    expect(generate).toHaveBeenCalledTimes(2);
```

> `message가 1001자면 400이고 gemini를 호출하지 않는다`는 **고치지 않는다.** 호출 0건이라는 ↔ 짝의 의미가 그대로다.

- [ ] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — **408건**(실측). prettier가 걸리면 `npm run lint`로 맞춘다.

- [ ] **Step 6: 커밋**

```bash
git add src/chat/chat.service.ts src/chat/chat.service.spec.ts src/chat/chat.controller.spec.ts
git commit -m "feat(backend): other 갈래를 OtherResponder에 배선한다

세 갈래가 모두 Gemini를 실제로 태우게 됐다. 대가는 요청당 왕복 2회다 —
인사 한 마디도 분류 1회 + 응답 1회를 쓴다. 그 상한을 ↔ 짝 테스트 둘이
지킨다(other는 structure를 안 부르고, 구조화 갈래는 respond를 안 부른다).

협력자 셋 각각에 대해 ExternalServiceError 비삼킴을 대칭으로 고정했다.
other 갈래는 폴백 문구가 정상 응답과 구별되지 않으므로, 여기서 삼키면
쿼터 소진이 평범한 대화로 보이고 503도 Retry-After도 사라진다."
```

---

## 리뷰 묶음

| 묶음 | 태스크 | 논리 단위 |
|---|---|---|
| A | 1~4 | 게이트 복구 · 순환 제거 · 세 갈래 배선 |

태스크가 4개라 묶음 하나로 합친다(`tb-plan-writing`: 5개 이하면 1개). 네 커밋이 하나의 논리적 완결 단위 — "chat이 실제로 Gemini를 태운다" — 를 이룬다.

## 최종 검증

- [ ] `npx tsc --noEmit -p tsconfig.json` 통과
- [ ] `npm test` 전체 통과 — **408건**
- [ ] `npx eslint src --max-warnings=0` 통과 (**main에서는 실패하던 게이트다**)
- [ ] `npm run build` 성공
- [ ] `npm run test:e2e` 통과 — **6건, 변화 없음**. e2e는 `POST /chat`을 타지 않는다(`test/external-service.e2e-spec.ts:22-23`)
- [ ] `src/chat/chat.module.ts`가 **변경되지 않았다** (`git diff --stat`에 나타나지 않아야 한다)
- [ ] `src/chat/chat.service.ts`에 `try`·`catch`가 **하나도 없다**
- [ ] `PLAN_ITINERARY_PLACEHOLDER_REPLY`·`RECOMMEND_PLACES_PLACEHOLDER_REPLY`가 저장소에서 **완전히 사라졌다**
- [ ] `OTHER_REPLY`를 `chat.service`에서 import하는 곳이 **하나도 없다** (순환이 되살아나지 않았다)
- [ ] 에러 처리 표의 "Gemini 실패" 3행에 각각 테스트가 하나씩 있다 — 행 수와 테스트 수를 센다

## 사용자 확인 필요 (에이전트가 실행할 수 없는 검증)

에이전트는 실제 Gemini 자격증명으로 호출할 수 없다. 아래는 사람이 확인한다.

- **`other` 갈래가 진짜 대화 응답을 낸다** — 절차: `.env`에 유효한 `GEMINI_API_KEY`를 두고 `npm run start:dev` 후 `POST /chat`에 `{"message": "안녕하세요", "itinerary": {...}}`를 보낸다. 통과 조건: `reply`가 `OTHER_REPLY`(`"어디로 떠나고 싶으신가요? ..."`)가 **아닌** 자연스러운 한국어 문장이고, 서버 로그에 `other 응답 폴백` warn이 **없다**. 폴백 문구가 그대로 나오면 검증기가 매번 걸리고 있다는 뜻이다.
- **`plan_itinerary` 갈래가 조건을 실제로 뽑는다** — 절차: 같은 방식으로 `{"message": "제주 2박3일 가족여행 일정 짜줘"}`. 통과 조건: `reply`가 `일정 요청으로 이해했어요 — 지역: 제주 · 기간: 3일 · 동반자: 가족. 장소를 찾아...` 형태이고 `조건: 미지정`이 **아니다**. `미지정`이 나오면 `질의 구조화 폴백` warn이 함께 있는지 로그를 본다.
- **`recommend_places`가 다른 문장 틀로 나온다** — 절차: `{"message": "부산 관광지 추천해줘"}`. 통과 조건: `reply`가 `장소 추천 요청으로 이해했어요 — ...`로 시작한다.
- **응답 지연이 수용 가능한 범위인가** — 절차: 위 세 요청의 왕복 시간을 잰다. 통과 조건: 사람이 판단한다. 배선 전 대비 **약 2배**가 예상값이며, 그보다 크게 느리면 갈래별 호출이 2회를 넘고 있는지 서버 로그의 Gemini 호출 수를 센다.
- **프론트엔드가 새 응답 문구를 깨뜨리지 않는다** — 절차: `frontend`를 띄우고 세 종류 메시지를 보낸다. 통과 조건: `reply`가 화면에 그대로 렌더되고, `itinerary`가 입력과 동일해 지도·일정 패널이 변하지 않는다. `ChatResponseDto`는 변경하지 않았으므로 계약 자체는 그대로다.
