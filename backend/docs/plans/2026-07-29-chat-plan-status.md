# chat 응답에 planStatus를 붙이고 plan 갈래를 갈라내는 구현 계획

> **For agentic workers:** 이 계획은 `tb-harness`의 work 단계가 태스크 묶음 단위로 실행한다.
> 각 Step의 체크박스(`- [ ]`)를 완료할 때마다 갱신한다.

**Goal:** `POST /chat`이 "화면에 띄울 완성된 계획이 있는가"를 응답으로 말한다 — `planStatus: 'none' | 'ready'`와 nullable `itinerary`. `plan_itinerary` 갈래는 임시 mock 일정을 실제로 돌려주므로 프론트가 두 상태 전환을 실제 HTTP 응답으로 검증할 수 있다.

**Architecture:** 핵심 안전 장치는 **응답 팩토리 하나**다. `planStatus === 'ready' ⟺ itinerary !== null` 불변식을 세 갈래가 각자 세우지 않고 `buildChatResponse` 한 함수가 세운다. 응답 타입은 판별 유니온이라 `{ planStatus: 'ready', itinerary: null }`이 타입 수준에서 표현 불가능하다. `planStatus`는 독립 상태가 아니라 **`itinerary`에서 파생되는 와이어 전용 투영**이다. 두 번째 장치는 `plan_itinerary`를 `replyStructured`에서 갈라내는 것이다 — 직전 실행이 예고한 부채이고, 두 갈래가 처음으로 실제로 갈린다.

---

## 설계

### 현행

**응답 계약 (바꾼다)**

- `src/chat/dto/chat-response.dto.ts:9-12` — `interface ChatResponseDto { reply: string; itinerary: ItineraryDto }`. `:7` 주석: "검증 데코레이터가 없으니 클래스일 필요가 없어 인터페이스로 둔다". `planStatus`·`plan_status`·`isReady` 심볼은 리포 어디에도 없다 — 이 영역은 신규다
- `src/chat/dto/chat-request.dto.ts:31-34` — `itinerary: ItineraryDto`가 **필수**. `@IsObject` + `@ValidateNested` + `@Type`
- `src/chat/chat.controller.ts:21` — `chat(@Body() body: ChatRequestDto): Promise<ChatResponseDto>`. 응답 타입은 `import type`이라 무변경
- `src/app.setup.ts:28-35` — `ValidationPipe({ whitelist: true, transform: true })`. `forbidNonWhitelisted`는 꺼져 있다

**갈래 (갈라낸다)**

- `src/chat/chat.service.ts:31-47` — `switch (intent)`. `plan_itinerary`·`recommend_places`가 **한 case 그룹**이고 `default`에 `const exhaustive: never`
- `src/chat/chat.service.ts:55-65` — `replyStructured(intent, request)`가 `QueryStructurer.structure()` 후 객체 리터럴을 만든다. `:51-53` TODO: "그때 두 갈래가 갈라지므로 이 메서드도 함께 나뉜다"
- `src/chat/chat.service.ts:71-76` — `replyOther(request)`가 **두 번째** 객체 리터럴을 만든다. 불변식을 세울 지점이 지금 둘이다

**문구 (좁힌다)**

- `src/chat/query/query-reply.ts:8-14` — 노출 문구 상수 5개. `PLAN_REPLY_TAIL`이 `'장소를 찾아 일정을 짜는 단계는 다음에 붙습니다.'`
- `src/chat/query/query-reply.ts:66-75` — `buildStructuredReply(intent, query)`. `isPlan` 삼항 2개가 유일한 분기
- `src/chat/query/query-reply.ts:5-6` 파일 doc — "갈래별 잠정 문구 … 실제 검색·조립이 붙으면 이 파일이 사라진다"
- **실측:** `PLAN_REPLY_HEAD`·`PLAN_REPLY_TAIL`의 참조는 `query-reply.ts`(정의)와 `query-reply.spec.ts`(테스트)뿐이다. 프로덕션 소비자는 `chat.service.ts`가 `buildStructuredReply`를 부르는 한 지점뿐이며 `chat.controller.spec.ts`가 그 문구를 HTTP에서 고정한다

**따를 관례 (실측 확인)**

- `src/chat/intent/chat-intent.ts:10-16` — `as const` 배열 + `(typeof X)[number]`. `:5-8`이 enum을 쓰지 않는 이유를 적어 뒀다
- `src/chat/dto/itinerary.dto.ts:20-22` — `PLACE_CATEGORIES`가 DTO 파일 안에 있다. **유니온 상수를 그것을 쓰는 DTO 파일에 두는 선례**
- `src/chat/other/other-prompt.ts` — `OTHER_REPLY`(값)와 `validateOtherReply`(검증기)가 같은 파일. 직전 계획 결정 1: "상수와 검증기가 같은 파일에 있어야 그 사실이 한자리에서 드러난다"
- `src/chat/query/structured-query.ts:86-88` — `EMPTY_CONDITIONS`는 **반드시 전개해서 쓴다**. "이 객체를 직접 채우면 공유 상수가 오염되고 다음 요청이 앞 요청의 조건을 물려받는다"
- `src/chat/query/query-reply.ts:8-14` + `chat.controller.spec.ts:17-22` — 노출 문구를 named export 상수로 빼고 spec이 import해 단정
- **파일 명명 (15/15 예외 없음):** `<topic>-<role>.ts`(하이픈)=순수 모듈, `<topic>.<role>.ts`(점)=`@Injectable`
- **디렉터리:** `intent/`·`query/`·`other/`가 각각 한 갈래. `@Injectable` 하나 + 그것이 쓰는 순수 모듈 1~3개
- `src/chat/chat.module.ts:24-29` — 순수 모듈은 providers에 **등록하지 않는다**

**깨질 테스트 (실측)**

| 파일:줄 | 무엇 | 왜 깨지나 |
|---|---|---|
| `chat.controller.spec.ts:190-195` | `it('itinerary가 없으면 400')` | `itinerary`가 optional이 되면 200이다. **측정한 실패: `expected 200 "OK", got 400 "Bad Request"`** |
| `chat.controller.spec.ts:255-258` | `toContain(PLAN_REPLY_HEAD)` · `toContain('지역: 제주')` | plan 갈래의 reply가 바뀌고 구조화를 거치지 않는다 |
| `chat.controller.spec.ts:292-307` | reply 전문 등가 `PLAN_REPLY_HEAD — … PLAN_REPLY_TAIL` | 같음. `recommend_places`로 옮긴다 |
| `chat.service.spec.ts:97-110` | `it.each(structuredIntents)` | 두 갈래가 다른 문장을 낸다 |
| `chat.service.spec.ts:127-139` | `it.each(allIntents)('itinerary를 입력 그대로')` + `toBe` | plan 갈래가 새 일정을 만든다 |
| `chat.service.spec.ts:153-162`·`:209-220` | `plan_itinerary`로 `structure` 호출·실패를 고정 | plan 갈래가 `QueryStructurer`를 부르지 않는다 |
| `query-reply.spec.ts:44-53`·`:132-137` | plan 전문 등가 · 갈래 대조 | `buildStructuredReply`가 `buildRecommendReply`가 된다 |

**깨지지 않는 것 (실측 확인 — 건드리지 말 것)**

- `chat.controller.spec.ts:350-361` — `expect(generate).toHaveBeenCalledTimes(2)`(other 갈래). `planStatus` 판정에 Gemini를 쓰지 않으므로 무영향
- `chat.controller.spec.ts:197-217` — 잘못된 `category`·중첩 필수 필드 누락 400 2건. `@IsOptional()`은 값이 **없을 때만** 나머지 검증을 건너뛴다. 이 2건이 그 사실의 증거다
- `chat.service.spec.ts:69-79` `createService()` — provider 3개. **새 `@Injectable`을 만들지 않으므로 이 파일이 죽지 않는다**
- `chat.module.ts` — 순수 모듈만 추가하므로 **무변경**
- `test/` e2e 6건 — `POST /chat`을 타지 않는다(`external-service.e2e-spec.ts:22-23`). **실측: 6 passed, 변화 없음**

### 결정

| # | 결정 | 버린 안 | 왜 버렸나 |
|---|---|---|---|
| 1 | `PLAN_STATUSES = ['none','ready'] as const` + `PlanStatus`를 **`dto/chat-response.dto.ts` 안에** 둔다 | (a) 새 파일 `dto/plan-status.ts` | `PLACE_CATEGORIES`가 `itinerary.dto.ts` 안에 있는 선례가 있다. 상수 하나짜리 파일이 늘고 import 한 홉이 생긴다 |
| 1 | ↑ | (b) `boolean planReady` | `drafting`·`failed`가 생길 때 boolean은 새 상태를 조용히 `false`로 흡수한다. 유니온이면 arm이 늘고 분기 지점 전부가 컴파일 에러가 된다 |
| 1 | ↑ | (c) `['none','drafting','ready','failed']`를 미리 넣는다 | 오늘 backend가 `drafting`·`failed`를 만들 수 없다. 도달 불가능한 값은 테스트를 쓸 수 없고 소비자에게 영구히 죽은 분기가 된다 |
| 2 | `ChatResponseDto`를 **판별 유니온**으로 만든다 (`{planStatus:'none', itinerary:null}` \| `{planStatus:'ready', itinerary:ItineraryDto}`) | 독립 필드 2개 (`planStatus: PlanStatus` + `itinerary: ItineraryDto \| null`) | `{planStatus:'ready', itinerary:null}`이 표현 가능해지고, 소비자가 두 조건을 각자 방어적으로 검사한다. 아래 결정 3과 합쳐 조합 불가능을 컴파일러에 맡긴다 |
| 3 | **`buildChatResponse(reply, itinerary)` 하나가 유일한 생성 지점.** `planStatus`는 `itinerary`에서 파생된다 | 갈래마다 객체 리터럴 (현행) | `two-columns-one-state`: *같은 사실을 두 필드가 나눠 가지면 한쪽만 갱신돼 갈린다. 상태만 되돌리자 재사용 분기가 옛 내용을 유효한 것으로 보고 다시 done으로 수렴했고, 재생성이 영구히 일어나지 않았다.* 이 저장소는 그 규칙을 근거로 필드를 **두지 않기로** 한 전례가 둘 있다(`structured-query.ts:51`, `query-prompt.ts:284`). **이번엔 왜 두는가:** `planStatus`가 독립 상태가 아니기 때문이다. 단일 진실 원천은 `itinerary` 하나이고 `planStatus`는 와이어 전용 투영이며 파생 지점이 함수 하나다 — 갈릴 두 번째 원천이 존재하지 않는다. 필드를 안 두는 대안(프론트가 `itinerary !== null`로 판정)은 **판정 책임을 소비자로 미루는 것**이고, 나중에 `drafting`이 생기면 프론트가 판정 규칙을 다시 배워야 한다 |
| 4 | `ChatRequestDto.itinerary`를 `@IsOptional()` + `itinerary?: ItineraryDto \| null` | 필수 유지 | 첫 턴에 일정이 없으면 400이 되고, 그러면 `planStatus: 'none'`이 도달 불가능해져 **필드가 의미를 갖지 못한다** |
| 4 | ↑ 타입에 `null`을 담고 `buildChatResponse`가 `null`·`undefined`를 **함께** 받는다 | (a) `itinerary?: ItineraryDto` + `itinerary === undefined` 판정 | **실측한 결함이다.** `@IsOptional()`은 명시적 `null`을 400으로 막지 않고 값을 `null`로 남긴다. `undefined`만 보면 `{"message":"안녕","itinerary":null}` 요청이 **`200 {"planStatus":"ready","itinerary":null}`을 실제로 낸다** — 이 설계가 막으려는 바로 그 조합이다. HTTP로 재현해 확인했다. **판별 유니온은 이것을 잡지 못한다:** 런타임 `null`이 타입상 `ItineraryDto`인 슬롯을 통과하므로 컴파일러가 볼 것이 없다. 타입 안전이 런타임 경계에서 끝난다는 사실이 이 한 줄에 있다 |
| 4 | ↑ | (b) 명시적 `null`을 400으로 거부한다 (`@ValidateIf` 등) | 프론트가 "일정 없음"을 `null`로 표현하는 것이 자연스럽고(`page.tsx:21`의 상태 타입이 `Itinerary \| null`이다), 거부하면 프론트가 필드를 지우는 코드를 따로 써야 한다. 받아서 `none`으로 수렴시키는 쪽이 계약이 넓고 의미가 같다 |
| 5 | `plan_itinerary`를 `replyPlan`으로 갈라낸다 | 한 case 그룹 유지 | 직전 계획 결정 2·트레이드오프(`:118`)가 "갈라지면 다시 나눈다"고 예고했다. **예고된 부채이므로 이탈이 아니다** |
| 6 | **`replyPlan`은 `QueryStructurer`를 부르지 않는다** | 부른다 (미래 생성기의 입력 seam으로 남긴다) | 목적지를 원문 키워드로 고르므로 구조화 결과를 **아무도 소비하지 않는다.** 결과를 버리는 왕복 하나가 늘고, **그 왕복의 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다** — 사용자에게 보이는 결함이다. seam은 `replyRecommend` + `replyPlan`의 TODO 주석으로 복원된다. 부수 효과: plan 갈래의 Gemini 왕복이 2회→1회로 줄고 `chat.controller.spec.ts:350-361`(other 2회)은 무영향 |
| 7 | `buildStructuredReply(intent, query)` → **`buildRecommendReply(query)`**. `PLAN_REPLY_HEAD`·`PLAN_REPLY_TAIL` 삭제 | 그대로 둔다 (변경 최소) | 그대로 두면 `isPlan` 분기 2개가 도달 불가가 되고 `query-reply.spec.ts`의 3건(`:39`·`:50`·`:132`)이 **죽은 경로에 초록불을 준다** — `test-asymmetry`가 말하는 실패 형태 그대로다. 게다가 `PLAN_REPLY_TAIL`("장소를 찾아 일정을 짜는 단계는 다음에 붙습니다.")은 일정을 실제로 돌려준 뒤에는 **거짓 문장**이다. **단 이것은 직전 계획 `:126`의 "사용자와 확인된 사항"을 건드린다 → 미해결 질문 Q1** |
| 8 | 새 문구는 `plan/plan-reply.ts`의 `PLAN_READY_GUIDE` + `buildPlanReply(itinerary)`. `'{목적지} {기간} 일정을 준비했어요! Day별 코스를 확인해보세요.'` | 원문 그대로 (`'… 오른쪽에서 Day별 코스를 확인해보세요.'`) | 원문(`frontend/src/lib/mock/scenarios.ts:18`)은 **화면 배치를 문구에 박아넣는다.** 모바일에서는 오른쪽이 아니라 탭이다(`frontend/src/app/plan/page.tsx:96-107`). 배치를 바꿀 때 backend 문구까지 따라 움직여야 하는 결합을 만들지 않는다. **→ 미해결 질문 Q2** |
| 9 | mock 데이터는 새 디렉터리 **`src/chat/plan/mock-itineraries.ts`** (순수 모듈, 하이픈 명명) | (a) `src/chat/itinerary/` | `dto/itinerary.dto.ts`와 이름이 겹쳐 두 "itinerary"가 나란히 선다. `plan/`은 갈래 이름이라 `intent/`·`query/`·`other/`와 같은 축이다 |
| 9 | ↑ | (b) `@Injectable` provider | `chat.service.spec.ts:69-79`가 provider 3개만 대체하므로 ChatService 테스트 19건이 전부 주입 실패로 죽고, `chat.module.ts`를 수정해야 해서 직전 계획 `:130`의 `범위 밖` 위반이 된다. 외부 의존이 없으므로 DI가 필요 없다 |
| 9 | ↑ | (c) 파일명에 mock을 담지 않는다 | 다음 실행이 이 데이터를 실제 구현으로 오인하는 것이 이번 변경의 가장 큰 잔여 위험이다. 이름이 첫 방어선이다 |
| 10 | **일정 3개를 전부 옮긴다** (서울·부산·제주, 값 무변경) | 1~2개만 옮긴다 | **근거를 게이트 1 Q4 이후 재판정했다.** 원래 근거("기본값 폴백과 매칭 성공을 구별하려면 기본값 밖에 2개 필요")는 `DEFAULT_DESTINATION_KEY`가 사라져 **무효다.** 테스트 관점만 보면 2개로 충분하다(매칭 2건 + 미매칭 `null` 1건). 그래도 3개를 옮기는 이유는 **키워드 맵과 일정이 짝이기 때문**이다: `Record<DestinationKey, ItineraryDto>`가 세 키를 강제하므로 일정을 빼면 키워드도 빼야 하고, 그러면 **`'서울 일정 짜줘'`가 `planStatus: 'none'`이 된다** — 폴백이 없어진 지금 그것은 정상 요청이 패널을 못 띄우는 것이고 사용자에게는 고장으로 보인다. 부차적으로, frontend mock이 삭제되면 backend가 이 데이터의 유일한 소유자다 — 옮기지 않은 일정은 저장소에서 사라진다 |
| 11 | `buildMockItinerary`가 **`structuredClone`으로 매 호출 새 객체를 만든다** | (a) 모듈 상수를 참조 그대로 응답에 싣는다 | `EMPTY_CONDITIONS` 관례(`structured-query.ts:86-88`)와 같은 위험이다. 누가 한 번 변형하면 이후 **모든 요청이 오염된다** |
| 11 | ↑ | (b) 얕은 전개 `{ ...itinerary }` | `days`·`places`를 그대로 공유한다. **방어처럼 보이기만 하는 것이 참조 공유보다 나쁘다** |
| 11 | ↑ | (c) 목적지별 팩토리 함수 3개 | 같은 효과지만 보장이 3곳으로 흩어지고, 4번째 목적지를 리터럴로 더하면 조용히 보장을 잃는다 |
| 12 | **`recommend_places`·`other`는 요청 일정 유무와 무관하게 항상 `none` + `itinerary: null`** | 요청의 일정을 되돌려준다 (있으면 `ready` + 그 일정) | **사용자 결정(게이트 1 Q3).** 요구가 "실제 계획이 완성되었을 경우에 뜨게"이므로 **패널은 계획을 만든 턴에만 뜬다.** 설계상으로도 이쪽이 결정 3에 더 충실하다 — 되돌려주면 "화면에 띄울 일정이 있다"를 세 갈래가 각자 주장하게 되고 `planStatus`를 만드는 지점이 셋으로 늘어난다. 이제 `itinerary`를 만드는 코드가 `replyPlan` 한 곳뿐이라 단일 원천이 오히려 강화된다. **대가는 트레이드오프 절에 있다** |
| 13 | **`plan_itinerary`는 목적지 매칭 실패 시 `none` + `null`** — `DEFAULT_DESTINATION_KEY` 폴백을 두지 않는다 | 기본 일정(서울)을 낸다 — 항상 `ready` | **사용자 결정(게이트 1 Q4).** 폴백하면 "일정 짜줘" 한 마디에 서울 일정이 패널에 뜨고 사용자는 자기가 요청한 것이라고 믿는다 — **틀린 일정을 자신 있게 보여주는 것이 아무것도 보여주지 않는 것보다 나쁘다.** 이 계획의 초안은 이 답을 "결정론성이 깨져 계획 재작성 규모"로 판정했으나 **그 판정은 틀렸다:** 판정 입력이 `intent` 하나에서 `(intent, 목적지 매칭 여부)` 둘로 늘 뿐이고 **둘 다 Gemini 추가 호출 없이 결정론적**이다(매칭은 원문 키워드 검사다). 표는 행이 늘 뿐 성립하고, 결정 2·3·11·14와 Task 1·2·4·6은 그대로다 |
| 13 | ↑ 매칭 실패 시 문구는 `plan/plan-reply.ts`의 `PLAN_DESTINATION_UNKNOWN_REPLY` | (a) reply 없이 `none`만 낸다 | 설명 없는 `none`은 사용자에게 **서비스 고장과 구별되지 않는다** — 일정 요청으로 이해했는데 패널이 뜨지 않고 이유도 없다. 무엇을 알려주면 되는지 말하는 것이 이 문구의 유일한 일이다. **문구 값 자체는 새 미해결 질문 Q6** |
| 13 | ↑ | (b) `OTHER_REPLY`를 재사용한다 (내용이 거의 같다) | 그 상수는 other 갈래 **안쪽의 폴백**이고, plan에서 import하면 plan → other 방향 결합이 생긴다. 나중에 other 폴백 문구를 고치면 plan 갈래 문구가 함께 움직인다 |
| 13 | ↑ null 분기를 **`buildPlanReply` 안에서** 가른다 (`buildPlanReply(itinerary: ItineraryDto \| null)`) | `ChatService.replyPlan`에서 가른다 | 같은 값이 reply와 `itinerary`를 함께 결정해야 둘이 어긋날 수 없다. 호출자가 가르면 **"일정은 null인데 문구는 준비됐다고 말하는" 조합이 표현 가능해진다** — 결정 3이 응답 필드에 적용한 논리를 문구에도 적용한다 |
| 16 | **`ChatRequestDto.itinerary`를 optional로 남긴다** — 서버가 읽지 않게 됐지만 지우지 않는다 | (a) 필드를 아예 제거한다 | 지우면 `whitelist: true`가 프론트가 보낸 값을 **400도 로그도 없이 조용히 버린다** — 계약을 좁히면서 조용히 좁히는 것이 가장 나쁘다. 그리고 `INTENT_DESCRIPTIONS.plan_itinerary`(`chat-intent.ts:23-24`)가 **"이미 만들어진 일정을 고쳐 달라는 요청(장소 교체·추가·삭제, '맛집 위주로', '1일차만 바꿔줘')도 여기에 넣는다"**고 명시한다 — 그 요청을 처리하려면 직전 일정이 반드시 필요하다. 남겨 두면 `허용되지 않은 category는 400`·`중첩된 일정의 필수 필드 누락도 400`(`chat.controller.spec.ts:197-217`) 2건이 계속 의미를 갖는다. **지우면 두 요청이 200이 되어 그 2건이 죽는다** |
| 16 | ↑ | (b) 데코레이터만 떼어 whitelist가 버리게 한다 | (a)와 같은 조용한 축소인데다 "받는 것처럼 보이지만 검증하지 않는" 상태가 된다 |
| 17 | **whitelist 관측을 `dto/chat-request.dto.spec.ts`(신규)로 옮긴다** — `ValidationPipe`를 직접 불러 제거를 센다 | 손실을 기록만 하고 대체하지 않는다 | 결정 12로 응답 echo가 사라지면서 `DTO에 없는 속성은 제거한다`(`chat.controller.spec.ts:219-235`)의 **관측 창이 닫힌다.** 실측 확인: `whitelist`를 세는 테스트는 저장소에서 그 한 건뿐이고 `app.setup.spec.ts`는 존재하지 않는다. 대체 없이 지우면 계약이 조용히 무보호가 된다. **남는 공백:** 파이프를 직접 만들면 `app.setup.ts`가 같은 옵션을 쓴다는 것은 세지 못한다 — `## 리스크`에 기록했다 |
| 14 | `DestinationKey`를 **인라인 유니온 리터럴**로 쓴다 (`as const` 배열 아님) | `as const` 배열 + `(typeof X)[number]` | **실측:** 런타임 멤버십 검사가 없어 배열이 타입으로만 쓰이면 eslint가 막는다 — `error 'DESTINATION_KEYS' is assigned a value but only used as a type @typescript-eslint/no-unused-vars`. `CHAT_INTENTS`·`PLACE_CATEGORIES`는 각각 `parseIntent`·`@IsIn`이라는 런타임 소비자가 있어서 배열 형태가 성립한다. `Record<DestinationKey, ItineraryDto>` 2개가 세 키를 강제하므로 강제력은 유지된다 |
| 15 | intent 폴백으로 흡수된 일정 요청(`failure-attribution` (b))을 **이번 범위에서 다루지 않는다** | 응답에 폴백 플래그를 노출한다 | 노출하는 순간 직전 계획 `:127`의 `fellBackToRawMessage` 비노출 결정과 같은 문을 여는 것이고, 사용자에게 줄 구제 수단도 없다(고칠 것은 분류기다). **`## 리스크`에 남긴다** |

### 갈래 × planStatus — 전 행에 테스트가 붙는다

**부분 집계를 선언하지 않는다.** 아래 표는 전 행이 리뷰 기준이다(`test-asymmetry` 4회차: 계획이 선언한 범위가 리뷰의 **상한**이 된다).

**규칙은 한 문장이다(게이트 1 Q3·Q4 이후).**

> **`itinerary`는 `plan_itinerary` 갈래가 목적지를 알아들었을 때만 만들어진다. 그 외 전부 `null`.**
> `planStatus`는 여전히 `itinerary`에서 파생된다(결정 3) — 만들지 못했으면 없고, 없으면 `none`이다. **특례가 없다.**

**요청의 `itinerary`는 이 표의 축이 아니다.** 어느 갈래도 그것을 응답에 싣지 않으므로 `planStatus`에 영향을 주지 않는다. 그 사실 자체가 테스트 대상이고 별도 행으로 뒀다(5행).

| # | 갈래 | 목적지 키워드 | `planStatus` | 응답 `itinerary` | 서비스 테스트 | HTTP 테스트 |
|---|---|---|---|---|---|---|
| 1 | `plan_itinerary` | 걸림 | `ready` | **새 mock 일정** | `plan_itinerary는 목적지를 알아들으면 새 일정을 ready로 돌려준다` · `plan_itinerary는 요청에 일정이 있어도 자기가 만든 일정을 낸다` | `갈래별 planStatus와 itinerary가 HTTP를 관통한다`[0] · `plan 갈래는 일정 내용을 채워 돌려준다` |
| 2 | `plan_itinerary` | 안 걸림 | `none` | `null` | `plan_itinerary는 목적지를 못 알아들으면 none이다` · `plan_itinerary는 목적지를 못 알아들으면 무엇을 알려달라고 말한다` | `plan 갈래도 목적지를 못 알아들으면 200 + none이 나간다` |
| 3 | `recommend_places` | 무관 | `none` | `null` | `↔ 짝: recommend_places는 같은 요청에서 none이다` | `갈래별 planStatus…`[1] |
| 4 | `other` | 무관 | `none` | `null` | `other는 none이다` | `갈래별 planStatus…`[2] · `reply와 itinerary를 200으로 돌려준다` |
| 5 | 세 갈래 전부 — 요청에 일정을 실어 보냄 | 무관 | 위 행과 동일 | 위 행과 동일 (**요청 일정은 나타나지 않는다**) | `it.each(allIntents)('%s는 요청의 일정을 응답에 싣지 않는다')` | `요청에 실어 보낸 일정은 어느 갈래에서도 응답에 나타나지 않는다` |
| 6 | intent 파싱 폴백 → `other` | 무관 | `none` | `null` | 4행과 **같은 코드 경로**(폴백은 `IntentClassifier` 안쪽에서 `'other'`로 수렴한다) | `분류를 해석할 수 없으면 200 + other 갈래 응답이 나간다` |

**함정은 세 곳이다.**

1. **1행 ↔ 3행이 같은 요청이다.** 메시지(`'제주 2박3일 일정 짜줘'`)가 완전히 같고 분류값만 다른데 `ready`/`none`으로 갈린다. **과거 stray 변경의 실례가 정확히 이 switch에서 `plan_itinerary`/`recommend_places` 두 case의 핸들러 호출이 뒤바뀐 것이었고, 그 시점에는 분기별 실제 응답이 없어 테스트가 초록불이었다.** 이 짝이 그 stray를 잡는 첫 테스트다.
2. **2·3·4·6행이 모두 `none` + `null`이다.** 네 행이 응답 필드로 구별되지 않는다. 구별되는 것은 **reply**이며, 2행에는 `PLAN_DESTINATION_UNKNOWN_REPLY` 전문 등가 단정이, 3·4행에는 `new Set(replies).size === 3`과 `↔ 짝` 협력자 호출 테스트 4건이 붙는다. **planStatus 축에서 3·4행을 구분하는 테스트를 두지 않는 것은 누락이 아니라 판정이다** — 두 갈래는 그 축에서 설계상 동일하다.
3. **5행이 없으면 어느 갈래가 요청 일정을 되돌려주기 시작해도 아무도 모른다.** 요청과 응답이 둘 다 "일정 있음"이면 `planStatus: 'ready'`가 통과하므로 결정 12가 조용히 뒤집힌다. 테스트는 mock 셋(서울·부산·제주)에 **없는 목적지(강릉)** 를 요청에 실어 응답 어디에도 나타나지 않는 것을 센다 — 목적지가 겹치면 "되돌려준 것"과 "새로 만든 것"이 구별되지 않는다.

**`ready`일 때 일정의 내용도 센다.** "일정 모양이다"를 아무도 세지 않으면 빈 `days`를 내도 `planStatus: 'ready'`가 통과하고 프론트는 빈 패널을 띄운다(`a490424`가 fixture에서 겪은 것과 같은 위험). `mock-itineraries.spec.ts`가 목적지별 `days` 수·`places` 수·`pinNumber` 연속성·요약 3필드 비어있지 않음을 세고, `chat.controller.spec.ts`의 `plan 갈래는 일정 내용을 채워 돌려준다`가 그것을 HTTP에서 다시 센다.

**`ready`일 때 일정의 내용도 센다.** "일정 모양이다"를 아무도 세지 않으면 빈 `days`를 내도 `planStatus: 'ready'`가 통과하고 프론트는 빈 패널을 띄운다(`a490424`가 fixture에서 겪은 것과 같은 위험). `mock-itineraries.spec.ts`가 목적지별 `days` 수·`places` 수·`pinNumber` 연속성·요약 3필드 비어있지 않음을 세고, `chat.controller.spec.ts`의 `plan 갈래는 일정 내용을 채워 돌려준다`가 그것을 HTTP에서 다시 센다.

### 에러 처리

| 실패 지점 | HTTP 응답 | `planStatus` | 상태 변경 | 재시도 | 테스트 |
|---|---|---|---|---|---|
| `IntentClassifier`의 Gemini 실패 | kind별 500/502/503/504 (`external-service.filter.ts:13-23`). `quota`는 `Retry-After: 60` | (응답 본문 없음) | 없음 | 안 함 | `chat.service.spec` `분류기가 던진 …` · `chat.controller.spec` `gemini가 quota로 …`·`upstream으로 …` |
| `QueryStructurer`의 Gemini 실패 (`recommend_places`만) | 동일 | (없음) | 없음 | 안 함 | `chat.service.spec` `QueryStructurer가 던진 …` |
| `OtherResponder`의 Gemini 실패 | 동일 | (없음) | 없음 | 안 함 | `chat.service.spec` `OtherResponder가 던진 …` |
| intent 파싱 실패 | **200** + other 갈래 응답 | `none` (갈래에서 결정 — 표 6행) | 없음 | 안 함 | `chat.controller.spec` `분류를 해석할 수 없으면 …` |
| 질의 구조화 파싱 실패 | **200** + `조건: 미지정` 요약 | `none` (recommend 갈래) | 없음 | 안 함 | `chat.controller.spec` `질의 구조화에 실패하면 …` |
| 질의 조건 **일부** 검증 실패 | **200** + 살아남은 조건만 | `none` | 없음 | 안 함 | `query.structurer.spec`(하위) · `query-reply.spec` `null 필드는 요약에 …` |
| other 응답 검증 실패 (빈 값·501자 이상) | **200** + `OTHER_REPLY` | `none` | 없음 | 안 함 | `chat.controller.spec` `대화 응답이 상한을 넘으면 …` |
| **목적지 키워드 매칭 실패 (`plan_itinerary`)** | **200** + `PLAN_DESTINATION_UNKNOWN_REPLY` | **`none`** + `itinerary: null` | 없음 | 안 함 | `mock-itineraries.spec` `아는 목적지가 없으면 null이다`·`↔ 짝: 목적지가 없는 요청은 어떤 일정도 만들지 않는다` · `plan-reply.spec` `무엇을 알려줘야 하는지 말한다` · `chat.service.spec` 2건 · `chat.controller.spec` `plan 갈래도 목적지를 못 알아들으면 200 + none이 나간다` |
| 입력 검증 실패 — `message` 빈값/1001자 | **400** + `message: string[]` | (없음) | 없음 | 해당 없음 | `chat.controller.spec` `message가 비어 있으면 400` · `1001자면 400 …` |
| 입력 검증 실패 — `itinerary`가 **있는데** 잘못된 모양 | **400** | (없음) | 없음 | 해당 없음 | `chat.controller.spec` `허용되지 않은 category는 400` · `중첩된 일정의 필수 필드 누락도 400` · `chat-request.dto.spec` `↔ 짝: itinerary가 있으면 잘못된 모양을 여전히 거부한다` |
| 입력에 `itinerary`가 **없다** | **200** (400이 아니다 — 이번에 바뀐다) | 갈래가 결정한다 (요청과 무관) | 없음 | 해당 없음 | `chat.controller.spec` `itinerary가 없어도 400이 아니다` · `chat-request.dto.spec` `itinerary가 없어도 통과한다` |
| 입력의 `itinerary`가 **명시적 `null`** | **200** (400이 아니다 — `@IsOptional()`이 통과시킨다) | 갈래가 결정한다 (요청과 무관) | 없음 | 해당 없음 | `chat.controller.spec` `itinerary가 명시적 null이어도 400이 아니다` · `chat-request.dto.spec` `itinerary가 명시적 null이어도 통과하고 값이 null로 남는다` |
| 입력에 **DTO에 없는 속성**이 있다 | **200** (조용히 제거 — `forbidNonWhitelisted`를 켜지 않았다) | 갈래가 결정한다 | 없음 | 해당 없음 | `chat-request.dto.spec` `DTO에 없는 최상위 속성을 제거한다`·`중첩된 일정 안의 속성도 제거한다` · `chat.controller.spec` `DTO에 없는 속성을 실어 보내도 200이다` |
| 4번째 intent 추가 후 switch 미수정 | (도달 불가) 컴파일 에러 | — | — | — | `const exhaustive: never` |
| `PLAN_STATUSES`에 도달 불가능한 값 추가 | (해당 없음) | — | — | — | `chat-response.dto.spec` `PLAN_STATUSES의 모든 값이 이 팩토리에서 실제로 나온다` |

**절대 하지 않는 것 — `chat()`에 try/catch를 두지 않는다.** 협력자 셋 중 누가 던져도 같은 인스턴스가 전역 필터까지 그대로 올라간다.

### 트레이드오프

- **mock 일정이 "기능이 생긴 것처럼" 보이는 정도를 크게 키운다.** 지금까지는 문장만 그럴듯했지만 이제 **일정 패널이 실제로 채워진다.** 그 일정은 사용자의 요청과 목적지 키워드 하나로만 연결되며 기간·동반자·조건을 전혀 반영하지 않는다("제주 5박6일 혼자"에도 `2박 3일 성인 2명` 일정이 나간다). 이 계획이 "일정 생성"이 아니라 **"일정 자리 채우기"** 라는 것을 파일 이름(`mock-itineraries.ts`)·`replyPlan`의 TODO 주석·이 절 셋으로 표시한다
- **backend `src/`에 292줄의 고정 데이터가 들어온다.** 이 저장소에 "큰 데이터 배열 전용 파일"의 선례가 없다. 실제 생성기가 붙을 때 파일 전체를 지우는 것이 회수 계획이다
- **`plan_itinerary`가 조건 추출을 잃는다.** 결정 6의 대가다. 실제 생성기는 `queryText`가 필요하므로 그때 `QueryStructurer` 호출이 `replyPlan`에 되돌아온다 — 다만 그때는 **소비자와 함께** 돌아온다
- **`ChatResponseDto`가 인터페이스에서 판별 유니온 타입 별칭이 된다.** 소비자가 `response.itinerary.summary`를 바로 읽을 수 없고 `planStatus`로 좁히거나 `?.`를 써야 한다. 그것이 이 설계가 사는 이유이지만, 읽는 코드가 한 줄 길어지는 것은 대가다
- **frontend가 반드시 함께 바뀌어야 한다.** `frontend/src/lib/api/itinerary.ts:68`이 `as ScenarioResult` **캐스트**라 shape 불일치를 컴파일러가 잡지 못한다. frontend 타입을 넓히지 않으면 `planStatus`가 `undefined`가 되고 **패널이 영구히 숨는다.** 이 계획은 backend만 바꾼다 — 짝은 frontend 계획이 진다
- **`buildChatResponse`가 `undefined`와 `null`을 함께 받아 `null`을 낸다.** `JSON.stringify`가 `undefined` 필드를 지워버리므로 응답은 `null`이어야 하고, 그 이유가 함수 doc에 있다. 오늘 `undefined`를 넘기는 호출자는 없다(일정을 만드는 갈래가 `null`을 낸다) — 그래도 시그니처에 남긴 이유는 **요청의 `itinerary`를 다시 읽게 되는 순간**(결정 16의 수정 요청 시나리오) `undefined`가 들어오기 때문이다. 그때 한쪽만 보면 아래 항목의 결함이 되살아난다
- **결정 12의 대가: 일정을 받은 직후 "고마워" 한 마디에 패널이 사라진다.** `recommend_places`·`other`가 `itinerary: null`을 내므로 프론트가 그 값을 그대로 상태에 쓰면 패널이 닫힌다. **사용자가 이 결과를 알고 선택했다**(게이트 1 Q3). 되돌리려면 `replyRecommend`·`replyOther`의 `buildChatResponse(reply, null)`에서 `null`을 `request.itinerary`로 바꾸면 된다 — 한 줄씩 둘이고, 그러면 결정 12가 뒤집히며 표 3·4행이 요청 일정 유무로 갈린다. **프론트가 `none`을 "패널을 닫아라"로 읽을지 "이번 턴에 새 일정이 없다"로 읽을지는 frontend 계획의 결정이다** — backend는 사실만 보낸다
- **결정 13의 대가: 일정 수정 요청이 패널을 닫는다.** `INTENT_DESCRIPTIONS.plan_itinerary`가 `"맛집 위주로"`·`"1일차만 바꿔줘"` 같은 **수정 요청도 이 갈래로 분류한다.** 그 메시지에는 목적지 키워드가 없으므로 `none` + `null`이 되고, 방금 뜬 패널이 닫힌다. Q3·Q4 두 결정이 겹쳐서 생기는 결과이며 **어느 한쪽만으로는 나타나지 않는다.** 이번 범위에서 고치지 않는 이유는 고치려면 요청 일정을 읽어야 하고 그것이 곧 결정 12를 부분 뒤집는 것이기 때문이다 — `## 리스크`와 미해결 질문 Q7에 올렸다
- **`whitelist: true`가 `configureApp`에 있다는 것을 아무 테스트도 세지 않게 된다.** 응답 echo가 사라져 관측 창이 닫혔다(결정 17). 대체 spec은 파이프를 직접 만들어 DTO의 whitelist 동작을 세지만, **그 파이프와 `app.setup.ts`의 옵션이 같다는 보장은 세지 못한다.** 두 곳이 갈리면 프로덕션에서만 다르게 동작한다
- **판별 유니온의 보장이 HTTP 경계에서 끝난다.** 타입은 `{ planStatus: 'ready', itinerary: null }`을 표현 불가능하게 만들지만, **런타임에 `null`이 타입상 `ItineraryDto`인 슬롯으로 들어오면 컴파일러가 볼 것이 없다.** 실제로 그 조합이 응답에 나가는 것을 재현했다(결정 4a). 경계에서 들어오는 값은 타입이 아니라 **테스트가** 지킨다 — 그래서 명시적 `null` 행이 에러 처리 표와 두 spec에 모두 있다

### 리스크

| 리스크 | 영향 | 완화 |
|---|---|---|
| **일정 요청이 intent 폴백으로 `other`에 흡수되면 `planStatus: 'none'`이 세 가지를 뭉친다** — (a) 일정 요청이 아니었다, (b) 일정 요청이었는데 분류가 폴백됐다, (c) backend 오류. 사용자에게는 (b)가 (a)와 구별되지 않는다 | 사용자는 일정을 요청했는데 패널이 뜨지 않고 이유를 알 수 없다. **관측 수단은 `IntentClassifier`의 warn 로그 1건뿐이다** | **이번 범위에서 다루지 않는다(결정 15).** 응답에 폴백 플래그를 노출하면 직전 계획 `:127`의 비노출 결정과 같은 문을 열고, 사용자에게 줄 구제 수단도 없다. 분류 정확도가 실제 문제로 드러나면 그때 프롬프트를 고친다 |
| mock 일정이 실제 구현으로 오인된다 | 빈 패널·틀린 기간이 정상으로 굳고, 생성기 작업이 "이미 됐다"로 미뤄진다 | 파일명 `mock-itineraries.ts` · `replyPlan`의 TODO · 트레이드오프 절 · `## 사용자 확인 필요` 4항 |
| frontend가 `planStatus`를 반영하지 않은 채 backend만 배포된다 | `as` 캐스트라 빌드·타입 검사 모두 통과하고 런타임에 패널이 영구히 숨는다 | frontend 계획이 이 배포에 의존한다는 것을 양쪽 계획에 명시. 이 계획의 `## 사용자 확인 필요` 5항 |
| 판별 유니온이 frontend 복제 타입과 어긋난다 | `itinerary.dto.ts:13-17`이 인정한 복제 위험. **새 필드 추가는 어느 테스트도 잡지 않는다** | `chat.controller.spec`의 HTTP 단정이 backend 쪽 shape을 고정한다. frontend 쪽은 frontend 계획의 몫 |
| **일정 수정 요청(`"맛집 위주로"`·`"1일차만 바꿔줘"`)이 패널을 닫는다** — 그 요청은 `plan_itinerary`로 분류되는데(`chat-intent.ts:23-24`) 목적지 키워드가 없어 `none` + `null`이 된다 | 사용자가 방금 받은 일정을 고쳐 달라고 하면 패널이 사라진다. **고치려는 버그와 같은 종류의 결과이며, 이번 변경이 새로 만드는 것이다** | 이번 범위에서 고치지 않는다 — 고치려면 요청 일정을 읽어야 하고 그것이 곧 결정 12의 부분 뒤집기다. **미해결 질문 Q7로 올렸다.** 최소 완화는 프론트가 `none`을 "패널을 닫아라"가 아니라 "이번 턴에 새 일정이 없다"로 읽는 것이며 그 판단은 frontend 계획에 있다 |
| **`whitelist: true`가 `configureApp`에 실제로 설정돼 있다는 것을 세는 테스트가 없어진다** | 옵션이 빠지면 DTO에 없는 필드가 프로덕션에서만 서비스까지 흘러든다. 대체 spec은 자기가 만든 파이프만 센다 | 손실을 명시적으로 기록했다(결정 17 · 트레이드오프). 되살리려면 `app.setup.spec.ts`가 필요하고 그건 이 계획의 범위 밖이다 |

### 범위 밖

- **TEI 임베딩 · Qdrant 검색 · 실제 일정 생성** — 이번은 **일정 자리 채우기**다. 직전 계획 `:125`의 `일정 생성 안 함`을 **부분적으로만** 뒤집는다: 원래 근거의 사실 부분("실제 일정은 아직 못 만든다")은 **여전히 참이다.** 이 구분을 잃으면 다음 실행이 mock을 구현으로 오인한다
- **`fellBackToRawMessage`를 HTTP로 노출하지 않는다** — 직전 계획 `:127`의 결정은 **여전히 유효하다.** `planStatus`는 폴백 관측용이 아니라 렌더 조건이다. **DTO를 여는 순간 "이왕 여니까"로 새는 필드가 정확히 이것이며, 이번에 함께 노출하면 이탈이다**
- **`QUERY_LABELS`(7줄) · `CONDITION_LABELS`(4줄) · `buildRecommendReply`의 문장 틀** — 손대지 않는다. 직전 계획 `:126`의 "사용자와 확인된 사항"이며 `recommend_places` 쪽은 그대로다. **`PLAN_REPLY_*` 삭제만이 그 결정을 건드리는 부분이고 사용자가 게이트 1 Q1에서 "지운다"로 확정했다**
- **요청의 `itinerary`를 읽지 않는다** — 필드는 받되(결정 16) 서버가 소비하지 않는다. 응답의 일정은 `replyPlan`이 만든다. **이 필드를 읽는 코드를 넣으면 결정 12·13이 뒤집히고 미해결 질문 Q7의 범위다**
- **`app.setup.spec.ts` 신설** — `whitelist: true`가 `configureApp`에 있다는 것을 세는 테스트는 만들지 않는다. 손실을 기록하는 데까지가 이번 범위다(결정 17 · 리스크)
- **`chat.module.ts` 변경** — 새 모듈 둘은 순수 모듈이므로 등록이 필요 없다. **이 파일을 건드리면 이탈이다**
- **프롬프트·검증기 변경** — `intent-prompt.ts`·`query-prompt.ts`·`other-prompt.ts`를 손대지 않는다
- **`frontend/src/lib/mock/` 삭제** — backend로 옮기지만 프론트 원본을 이 계획에서 지우지 않는다. `itinerary.test.ts`가 `getDefaultItinerary`를 9곳에서 fixture로 쓰고 `scenarios.test.ts` 5건이 걸려 있다 — frontend 계획의 몫이다. **워크스페이스별로 커밋을 나눈다**
- **`GET /itinerary`류 엔드포인트** — 만들지 않는다. `planStatus`는 `POST /chat` 응답으로만 전달된다
- **대화 이력 · DB** — `ChatModule`은 계속 `DatabaseModule`을 import하지 않는다
- **지역명 → `ldong_regn_cd` 변환** — Postgres 코드표가 필요하고 사내망 전용이다

### 게이트 1 결정 (2026-07-29)

계획 초안이 미해결 질문 5건을 올렸고 사용자가 4건에 답했다. **Q3·Q4는 초안의 가정과 반대다** — 아래가 그 답변과, 답변이 무엇을 바꿨는지의 유일한 기록이다. 다음 실행은 이 절을 근거로 삼는다.

| # | 질문 | 사용자 답변 | 초안 가정과 | 무엇이 바뀌었나 |
|---|---|---|---|---|
| Q1 | `PLAN_REPLY_HEAD`·`PLAN_REPLY_TAIL`을 지워도 되는가? (직전 계획 `:126`이 문장 틀을 "사용자와 확인된 사항"으로 못박았다) | **지운다 — Task 6 진행** | 일치 | 없음. Task 6이 그대로 실행된다 |
| Q2 | plan 갈래 문구에서 `"오른쪽에서"`를 뺀 것이 맞는가? | (묻지 않았다 — 작성자 판단 유지) | 일치 | 없음. `PLAN_READY_GUIDE`가 `'Day별 코스를 확인해보세요.'`로 남는다 |
| Q3 | 장소 추천·잡담 턴에서 이미 받은 패널이 남아야 하는가? | **사라진다 — plan 갈래에서만 뜨게** | **반대** | **결정 12 뒤집힘.** `recommend_places`·`other`가 항상 `none` + `null`. 갈래×상태 표 3·4행, Task 5의 `buildChatResponse` 호출부 2곳, 컨트롤러 spec의 echo 단정 전부. 대가는 트레이드오프 절 |
| Q4 | 목적지를 못 알아들었을 때 서울 일정을 내도 되는가? | **`none`을 낸다 — 서울 일정 내지 않는다** | **반대** | **결정 13 뒤집힘.** `DEFAULT_DESTINATION_KEY` 제거, `buildMockItinerary`가 `ItineraryDto \| null` 반환, `PLAN_DESTINATION_UNKNOWN_REPLY` 신설, `buildPlanReply`가 `null`을 받는다. Task 3·4·5와 표 2행. **결정 10의 근거도 재판정했다** |
| Q5 | `plan_itinerary`가 `QueryStructurer`를 더 이상 부르지 않는 것이 맞는가? | **부르지 않는다** | 일치 | 없음. 결정 6이 그대로 |

**Q4 답변이 "계획 재작성 규모"가 아닌 이유(오케스트레이터 판정).** 초안은 `plan_itinerary`가 `none`을 낼 수 있으면 "갈래가 상태를 결정론적으로 정한다"가 무너진다고 판정했다. 그 판정은 틀렸다. 판정 입력이 `intent` 하나에서 `(intent, 목적지 매칭 여부)` 둘로 늘 뿐이고 **둘 다 Gemini 추가 호출 없이 결정론적**이다. 오히려 규칙이 단순해졌다 — `itinerary`를 만드는 코드가 `replyPlan` 한 곳뿐이고 특례가 없어져 **결정 3(단일 진실 원천)이 강화된다.** 그래서 결정 2·3·11·14와 Task 1·2·4·6의 골격은 그대로다.

### 미해결 질문 — 게이트 1 이후 새로 생긴 것

**Q6. `PLAN_DESTINATION_UNKNOWN_REPLY`의 문구가 이대로 괜찮은가?**
Q4 답변이 이 문구를 **필요하게 만들었다** — plan 갈래가 `none`을 내면 무언가는 말해야 한다. 계획의 값: `"어느 지역으로 떠나고 싶으신가요? '제주 2박3일'처럼 목적지를 알려주시면 일정을 만들어드릴게요."` `OTHER_REPLY`(`other-prompt.ts:9-10`)와 내용이 거의 같지만 재사용하지 않았다(결정 13b). 다르게 하려면 → **Task 4의 상수 한 줄**과 `plan-reply.spec.ts`의 전문 등가 단정 1건.

**Q7. 일정 수정 요청이 패널을 닫는 것을 이번에 다룰 것인가?**
`INTENT_DESCRIPTIONS.plan_itinerary`(`chat-intent.ts:23-24`)가 `"맛집 위주로"`·`"1일차만 바꿔줘"` 같은 **수정 요청도 이 갈래로 분류한다.** 그 메시지에는 목적지 키워드가 없으므로 Q4 답변에 따라 `none` + `null`이 되고, **방금 뜬 패널이 닫힌다.** Q3·Q4 두 답변이 겹쳐서 생기는 결과이며 어느 한쪽만으로는 나타나지 않는다. 계획의 가정: **이번 범위에서 다루지 않고 `## 리스크`에 남긴다** — 고치려면 요청 일정을 읽어야 하고 그것이 곧 결정 12의 부분 뒤집기다. 다루려면 → `replyPlan`이 목적지 매칭 실패 시 `request.itinerary`를 통과시키는 형태가 되고, 표 2행과 5행이 갈리며 Task 5를 다시 쓴다. **최소 완화는 backend가 아니라 frontend에 있다:** 프론트가 `none`을 "패널을 닫아라"가 아니라 "이번 턴에 새 일정이 없다"로 읽으면 이 문제가 사라진다 — 그 판단은 frontend 계획의 몫이다.

---

## Global Constraints

- 작업 디렉터리는 `backend/`. 모든 명령은 거기서 실행한다.
- 주석·로그 메시지·에러 메시지·커밋 메시지는 **한국어**로 쓴다.
- 테스트 파일은 소스 옆 `*.spec.ts` (jest `rootDir`가 `src`).
- 단위 테스트는 전부 모킹이다. **실제 네트워크·DB 호출을 하지 않는다.**
- 테스트: `npm test` / 타입 검사: `npx tsc --noEmit -p tsconfig.json` / 린트: `npx eslint src --max-warnings=0`
- **기준선(측정 완료, `10ffe7b`):** `npm test` **409 passed / 22 suites** · `npx tsc --noEmit` OK · `npx eslint src --max-warnings=0` OK. **전부 초록에서 시작한다.** 첫 태스크 전에 다시 한 번 돌려 확인한다 — 이 워크트리는 하네스 전용이 아니다(`harness-is-not-the-only-git-actor`)
- **작업 트리에 이 세션이 만들지 않은 미추적 파일 3개가 있다**(`backend/.ignore`, `frontend/.ignore`, 루트 `.ignore`). **커밋에 넣지 않는다.**
- **prettier가 `error`다.** 이 문서의 코드 블록은 전부 `npm run lint`(=`--fix`) 통과 형태로 옮겼지만, 삽입 위치가 달라져 줄바꿈이 어긋나면 **손으로 맞추지 말고 `npm run lint`에 맡긴다.**
- **eslint는 `recommendedTypeChecked`다.** `mock.calls[0][0]` 직접 읽기·중첩 `objectContaining`이 막힌다. **추가 실측: 런타임 소비자 없는 `as const` 배열을 `typeof`로만 쓰면 `no-unused-vars`가 error를 낸다**(결정 14).
- **`ts-jest`는 타입 검사를 하지 않는다.** 없는 export를 import하면 컴파일 에러가 아니라 런타임 `undefined`다 — 이 계획의 여러 Step 2가 그 형태의 실패다.
- **`chat.module.ts`를 수정하지 않는다.**
- **`chat()`에 try/catch를 두지 않는다.**
- **`fellBackToRawMessage`를 응답에 노출하지 않는다.**
- **기준은 이 문서의 코드 블록이 아니라 커밋된 코드다.** 블록이 현재 파일과 다르면 이탈로 보고한다.
- **이 계획의 코드 블록은 `backend/`에서 실제로 실행해 검증했다 — 단 측정 범위가 갈린다.** 게이트 1의 Q3·Q4 답변으로 설계가 바뀐 뒤 **최종 상태를 다시 만들어** `tsc` · `eslint --max-warnings=0` · `npm test` · `npm run build` · `npm run test:e2e`를 전부 통과시켰다: **454 passed / 26 suites** · `tsc` OK · `eslint` OK · `build` 성공 · `e2e` **6 passed / 2 suites (변화 없음)**. 스위트별 실측: `chat-response.dto.spec` 5 · `chat-request.dto.spec` 5 · `mock-itineraries.spec` 17 · `plan-reply.spec` 6 · `query-reply.spec` 7(9→7) · `chat.service.spec` 22(14→22) · `chat.controller.spec` 21(15→21).
- **태스크별 중간 누계는 재측정하지 않았다.** 각 태스크의 `Expected: PASS` 줄에 수치가 없는 것은 누락이 아니다 — **측정하지 않은 수치를 적으면 다음 실행이 그것을 검증된 값으로 읽는다**(`plan-summary-table-overstates-measurement`). 구현자는 태스크 경계마다 직접 세고, 최종 상태에서 위 수치와 대조한다.
- **`@IsOptional()`의 실측 동작:** 필드 부재는 `undefined`, **명시적 `null`은 `null`로 남는다 — 둘 다 400이 아니다.** `{"itinerary": null}`을 supertest로 실제로 보내 확인했다. 이 사실을 놓치면 `planStatus: 'ready'` + `itinerary: null`이 응답에 나간다(결정 4a). **`buildChatResponse`가 `null`과 `undefined`를 함께 받는 것이 이 결함의 유일한 방어다.**
- **각 태스크의 통과 확인에 새 테스트의 검출력 확인을 포함한다**(`mutation-check-is-the-implementers-job`). 실패 시나리오를 임시 주입해 **새 테스트 하나만** red가 되는 것을 보고 원복한다. 원복 증명은 `git diff --stat`이 비는 것.

---

### Task 1: `planStatus`와 응답 팩토리를 만든다

불변식을 세울 지점을 둘(`replyStructured`·`replyOther`의 객체 리터럴)에서 하나로 줄인다. 요청의 `itinerary`가 아직 필수이므로 이 태스크 시점에는 모든 응답이 `ready`다.

**Files:**
- Modify: `src/chat/dto/chat-response.dto.ts`, `src/chat/chat.service.ts`
- Test: `src/chat/dto/chat-response.dto.spec.ts`(신규), `src/chat/chat.controller.spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `PLAN_STATUSES` · `PlanStatus` · 판별 유니온 `ChatResponseDto` · `buildChatResponse(reply: string, itinerary: ItineraryDto | null | undefined): ChatResponseDto`

- [ ] **Step 1: 기준선을 확인한다**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: 전부 초록 — **409 passed / 22 suites**. 빨간 것이 있으면 이 계획을 시작하기 전에 복구를 독립 태스크로 먼저 둔다.

- [ ] **Step 2: 실패하는 테스트 작성**

`src/chat/dto/chat-response.dto.spec.ts`를 **새로 만든다**:

```ts
import type { ItineraryDto } from './itinerary.dto';
import { buildChatResponse, PLAN_STATUSES } from './chat-response.dto';

/**
 * planStatus === 'ready' ⟺ itinerary !== null 불변식이 만들어지는 유일한 지점을
 * 고정한다. 갈래별 라우팅은 chat.service.spec.ts가, HTTP 관통은
 * chat.controller.spec.ts가 따로 본다.
 */

const ITINERARY: ItineraryDto = {
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
};

describe('buildChatResponse — planStatus와 itinerary의 짝', () => {
  it('일정이 있으면 ready이고 그 일정을 참조 그대로 담는다', () => {
    const response = buildChatResponse('준비했어요', ITINERARY);

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary).toBe(ITINERARY);
  });

  it('일정이 null이면 none이고 itinerary가 null이다', () => {
    // 일정을 만드는 갈래가 목적지를 못 알아들었을 때 이 경로를 탄다.
    const response = buildChatResponse('어디로 가고 싶으신가요?', null);

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('일정이 undefined여도 none이고 itinerary가 null이다', () => {
    // ↔ 위 짝. undefined가 그대로 실리면 JSON.stringify가 필드를 지워버리고
    // 프론트의 판별 유니온이 itinerary를 읽을 수 없다. 오늘 undefined를 넘기는
    // 호출자는 없지만, 요청의 itinerary를 다시 읽는 순간 이 경로가 살아난다 —
    // 그때 한쪽만 보면 ready + null이 만들어진다.
    const response = buildChatResponse('어디로 가고 싶으신가요?', undefined);

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('reply를 손대지 않고 그대로 싣는다', () => {
    expect(buildChatResponse('그대로', null).reply).toBe('그대로');
    expect(buildChatResponse('그대로', ITINERARY).reply).toBe('그대로');
  });

  it('PLAN_STATUSES의 모든 값이 이 팩토리에서 실제로 나온다', () => {
    // 도달 불가능한 상태를 유니온에 미리 넣지 않는다는 결정을 고정한다.
    // drafting을 PLAN_STATUSES에 더하면 이 단정이 그 값을 내는 경로를 요구한다 —
    // 값만 늘고 아무도 만들지 못하는 상태는 소비자에게 죽은 분기가 된다.
    const produced = [
      buildChatResponse('a', null).planStatus,
      buildChatResponse('b', ITINERARY).planStatus,
    ];

    expect([...produced].sort()).toEqual([...PLAN_STATUSES].sort());
  });
});
```

- [ ] **Step 3: 실패를 확인**

```
npm test -- chat-response.dto
```

Expected: FAIL — **5 failed, 5 total**. 다섯 건 모두 같은 메시지다(`ts-jest`가 타입 검사를 하지 않으므로 `TS2305`가 아니라 런타임 오류가 된다):

```
● buildChatResponse — planStatus와 itinerary의 짝 › 일정이 있으면 ready이고 그 일정을 참조 그대로 담는다

  TypeError: (0 , chat_response_dto_1.buildChatResponse) is not a function
```

- [ ] **Step 4: 구현 — `chat-response.dto.ts` 전문 교체**

`src/chat/dto/chat-response.dto.ts`를 아래 전문으로 **교체한다**:

```ts
import type { ItineraryDto } from './itinerary.dto';

/**
 * 여행계획 패널을 띄울지 결정하는 상태. 오늘 backend가 실제로 만들 수 있는 값만
 * 담는다 — 도달 불가능한 상태를 미리 넣으면 그 상태를 내는 테스트를 쓸 수 없고,
 * 소비자는 영구히 죽은 분기를 갖는다.
 *
 * boolean이 아닌 이유는 drafting·failed가 생길 때다. 유니온에 값을 더하면 아래
 * 판별 유니온의 arm이 하나 늘고, planStatus로 분기하는 지점 전부가 컴파일
 * 에러로 드러난다 — boolean은 새 상태를 조용히 false로 흡수한다.
 *
 * as const 배열 + (typeof X)[number]는 이 저장소의 유니온 상수 관례다
 * (intent/chat-intent.ts:10-16, itinerary.dto.ts:20-22).
 */
export const PLAN_STATUSES = ['none', 'ready'] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * arm 하나의 골격. S를 PlanStatus로 제약하므로 PLAN_STATUSES에 없는 상태를
 * arm에 적으면 컴파일 에러가 된다 — 배열이 상태 어휘의 유일한 원천이 된다.
 */
type PlanStatusResponse<S extends PlanStatus, I> = {
  reply: string;
  planStatus: S;
  itinerary: I;
};

/**
 * POST /chat 응답 본문. 프론트엔드 frontend/src/lib/mock/scenarios.ts의
 * ScenarioResult에서 출발했지만, 그쪽에 없는 planStatus가 붙었다.
 *
 * 검증 데코레이터가 없으니 클래스일 필요가 없어 타입으로 둔다.
 *
 * 판별 유니온이다 — planStatus === 'ready' ⟺ itinerary !== null을 타입이
 * 강제한다. 두 필드를 독립으로 두면 { planStatus: 'ready', itinerary: null }이
 * 표현 가능해지고 소비자가 두 조건을 각자 방어적으로 검사한다. 같은 사실을 두
 * 필드가 나눠 가지면 한쪽만 갱신돼 갈리는데(two-columns-one-state), 여기서는
 * itinerary가 단일 진실 원천이고 planStatus는 buildChatResponse가 그것에서
 * 파생시키는 와이어 전용 투영이다. 파생 지점이 하나라 갈릴 수 없다.
 */
export type ChatResponseDto =
  PlanStatusResponse<'none', null> | PlanStatusResponse<'ready', ItineraryDto>;

/**
 * ChatResponseDto를 만드는 유일한 지점.
 *
 * 세 갈래가 각자 객체 리터럴을 만들면 planStatus와 itinerary의 짝을 세 곳이
 * 각자 세우고, 한 곳만 고쳐도 컴파일이 통과한다. 여기로 모으면 불변식이
 * 코드 한 줄이 된다.
 *
 * 응답은 null을 명시한다 — JSON.stringify가 undefined 필드를 지워버리면
 * 프론트의 판별 유니온이 itinerary를 읽을 수 없다.
 *
 * null과 undefined를 **함께** 받는다. 오늘 undefined를 넘기는 호출자는 없지만
 * (일정을 만드는 갈래가 null을 낸다), 요청의 itinerary를 다시 읽게 되는 순간
 * undefined가 들어온다. 그때 undefined만 보거나 null만 보면
 * planStatus: 'ready' + itinerary: null이 만들어진다 — 이 함수가 막으려는 바로
 * 그 조합이다. 판별 유니온은 그것을 잡지 못한다: 런타임 null이 타입상
 * ItineraryDto인 슬롯을 통과하기 때문이다(HTTP로 재현해 확인했다).
 */
export function buildChatResponse(
  reply: string,
  itinerary: ItineraryDto | null | undefined,
): ChatResponseDto {
  const resolved = itinerary ?? null;

  return resolved === null
    ? { reply, planStatus: 'none', itinerary: null }
    : { reply, planStatus: 'ready', itinerary: resolved };
}
```

- [ ] **Step 5: 구현 — `chat.service.ts`의 두 리터럴을 팩토리로 바꾼다**

**(5-1)** `src/chat/chat.service.ts:4`(`import type { ChatResponseDto } …`) **바로 아래**에 한 줄 추가:

```ts
import { buildChatResponse } from './dto/chat-response.dto';
```

> 값 import를 `import type`과 **별도 줄**로 둔다. `chat.service.spec.ts:11-12`가 같은 모듈에서 타입과 값을 두 줄로 나눠 받는 것과 같은 형태다.

**(5-2)** `replyStructured`의 `return` 블록(`:61-64`)을 **교체**:

```ts
    return buildChatResponse(
      buildStructuredReply(intent, query),
      request.itinerary,
    );
```

**(5-3)** `replyOther`의 `return` 블록(`:72-75`)을 **교체**:

```ts
    return buildChatResponse(
      await this.otherResponder.respond(request.message),
      request.itinerary,
    );
```

- [ ] **Step 6: 컨트롤러 spec에 planStatus 단정을 더한다**

`src/chat/chat.controller.spec.ts`의 `it('reply와 itinerary를 200으로 돌려준다', ...)` 안, `expect(body.reply.length).toBeGreaterThan(0);` **다음 3줄**(`:178-180`)을 아래로 **교체**:

```ts
    // beforeEach가 other로 고정한다. 이 태스크 시점에는 요청 itinerary가 아직
    // 필수이고 세 갈래가 그것을 그대로 되돌려주므로 planStatus는 ready다.
    expect(body.planStatus).toBe('ready');
    expect(body.itinerary).toEqual(itinerary);
```

> **이 단정은 Task 5에서 다시 바뀐다** — 결정 12로 `other` 갈래가 `none` + `null`을 내게 되기 때문이다. 지금 `ready`인 것은 이 태스크의 중간 상태가 그렇기 때문이고, 그 중간 상태에서도 게이트가 초록이어야 태스크가 독립적으로 커밋 가능하다.

- [ ] **Step 7: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — 기존 409건 + `chat-response.dto.spec` **신규 5건**. **누계를 직접 센다** — 이 계획은 최종 상태만 재측정했다(Global Constraints).

**검출력 확인 (커밋에 포함되지 않는다):** `buildChatResponse`의 삼항 한쪽을 `: { reply, planStatus: 'none', itinerary: resolved }`로 임시 변경하면 컴파일 에러가 난다(판별 유니온이 막는다). 대신 아래 둘을 각각 넣어 본다.

| 임시 변경 | red가 되어야 하는 것 |
|---|---|
| `const resolved = itinerary ?? null;` → `const resolved = itinerary === undefined ? null : itinerary;` | `일정이 명시적 null이어도 none이다` **한 건만**. 이것이 결정 4a가 고친 결함 그대로다 |
| `resolved === null` → `resolved !== null` | `일정이 있으면 ready이고 …`와 `일정이 없으면 none이고 …` 등 여러 건 |

원복 후 `git diff --stat`이 `chat-response.dto.ts`를 다시 원래 크기로 보여야 한다.

- [ ] **Step 8: 커밋**

```bash
git add src/chat/dto/chat-response.dto.ts src/chat/dto/chat-response.dto.spec.ts src/chat/chat.service.ts src/chat/chat.controller.spec.ts
git commit -m "feat(backend): 응답에 planStatus를 붙이고 생성 지점을 팩토리 하나로 모은다

planStatus는 독립 상태가 아니라 itinerary에서 파생되는 와이어 전용 투영이다.
같은 사실을 두 필드가 나눠 가지면 한쪽만 갱신돼 갈리는데(two-columns-one-state),
파생 지점이 buildChatResponse 하나뿐이라 갈릴 두 번째 원천이 없다. 그래서
이 저장소가 두 번 필드를 두지 않기로 한 것과 모순되지 않는다.

판별 유니온으로 둔 이유는 { planStatus: 'ready', itinerary: null } 조합을
타입 수준에서 막기 위해서다. 독립 필드 둘이면 소비자가 두 조건을 각자
방어적으로 검사해야 하고, 그 검사가 빠진 곳에서 빈 패널이 뜬다.

boolean을 쓰지 않은 이유는 drafting·failed가 생길 때다. 유니온이면 arm이
늘고 분기 지점 전부가 컴파일 에러가 되지만 boolean은 조용히 false로 흡수한다.
값은 오늘 실제로 만들 수 있는 둘만 넣었다 — 도달 불가능한 상태는 테스트를
쓸 수 없고, PLAN_STATUSES 전수 테스트가 그 규칙을 지킨다.

null과 undefined를 함께 받는다. 판별 유니온의 보장은 HTTP 경계에서 끝난다 —
런타임 null이 타입상 ItineraryDto인 슬롯을 통과하면 컴파일러가 볼 것이 없고,
실제로 {\"itinerary\": null} 요청이 ready + null을 내는 것을 재현했다.
경계에서 들어오는 값은 타입이 아니라 테스트가 지킨다."
```

---

### Task 2: 요청의 `itinerary`를 optional로 만든다

첫 턴에는 일정이 없다. 이 경로가 400이면 `planStatus: 'none'`이 도달 불가능해 필드가 의미를 갖지 못한다.

**Files:**
- Modify: `src/chat/dto/chat-request.dto.ts`
- Test: `src/chat/dto/chat-request.dto.spec.ts`(신규), `src/chat/chat.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1의 `buildChatResponse`
- Produces: `ChatRequestDto.itinerary?: ItineraryDto | null`

> **필드를 지우지 않고 optional로 남기는 근거는 결정 16이다.** 서버가 이 값을 읽지 않게 되지만(결정 12·13), 지우면 whitelist가 프론트가 보낸 값을 400도 로그도 없이 버리고 `허용되지 않은 category는 400` 2건이 죽는다.

- [ ] **Step 1: 실패하는 테스트 작성 — 컨트롤러**

`src/chat/chat.controller.spec.ts`의 `it('itinerary가 없으면 400', ...)` **전체**(`:190-195`)를 아래 **두 테스트로 교체**:

```ts
  it('itinerary가 없어도 400이 아니다', async () => {
    // 첫 턴이 이 요청이다. 400이던 것을 여는 변경이며, 이 경로가 막혀 있으면
    // 프론트가 일정 없이 대화를 시작할 수 없다.
    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '안녕하세요' })
      .expect(200);

    const body = response.body as ChatResponseDto;
    // planStatus가 none인 것은 요청에 일정이 없어서가 아니라 other 갈래여서다.
    // 갈래와 상태의 대응은 아래 '갈래별 planStatus…'가 따로 센다.
    expect(body.planStatus).toBe('none');
    expect(body.itinerary).toBeNull();
  });

  it('itinerary가 명시적 null이어도 400이 아니다', async () => {
    // ↔ 위 짝. @IsOptional()은 명시적 null을 막지 않고 값을 null로 남긴다(실측).
    // 프론트의 일정 상태 타입이 Itinerary | null이므로 이 모양이 실제로 온다.
    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '안녕하세요', itinerary: null })
      .expect(200);

    const body = response.body as ChatResponseDto;
    expect(body.planStatus).toBe('none');
    expect(body.itinerary).toBeNull();
  });
```

> **테스트 이름이 `… 200 + planStatus none이 나간다`가 아닌 이유.** Task 5 이후 `none`은 요청에 일정이 없어서가 아니라 **other 갈래여서** 나온다. 이름이 요청과 상태를 인과로 묶으면 그 테스트는 자기가 증명하지 않는 것을 주장한다 — 이 태스크에서 세는 것은 "400이 아니다"뿐이다.

- [ ] **Step 2: 실패하는 테스트 작성 — whitelist 관측을 옮긴다**

결정 12로 응답 echo가 사라지면서 `DTO에 없는 속성은 제거한다`(`chat.controller.spec.ts:219-235`)가 관측 창을 잃는다. **실측 확인: `whitelist`를 세는 테스트는 저장소에서 그 한 건뿐이고 `app.setup.spec.ts`는 없다.** 파이프를 직접 불러 옮긴다.

`src/chat/dto/chat-request.dto.spec.ts`를 **새로 만든다**:

```ts
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';

import { ChatRequestDto } from './chat-request.dto';

/**
 * whitelist 동작을 고정한다.
 *
 * 이 계약은 예전에 chat.controller.spec.ts가 "요청 itinerary를 그대로 되돌려준
 * 응답에 심어 둔 필드가 없다"로 셌다. 이제 어느 갈래도 요청 일정을 되돌려주지
 * 않으므로 그 관측 창이 닫혔다 — 파이프를 직접 불러 대신 센다.
 *
 * 여기서 만든 파이프가 app.setup.ts의 것과 같은 옵션이어야 한다. 그 두 곳이
 * 어긋나는 것은 이 테스트가 잡지 못한다(리스크 절에 기록).
 */
function createPipe(): ValidationPipe {
  return new ValidationPipe({ whitelist: true, transform: true });
}

async function transformBody(body: object): Promise<unknown> {
  // any 반환을 unknown으로 받는다. 타입 있는 변수에 담으면 no-unsafe-assignment가
  // error다. as 캐스팅은 반대 방향이다 — 오타를 그대로 통과시킨다.
  return createPipe().transform(body, {
    type: 'body',
    metatype: ChatRequestDto,
  });
}

const ITINERARY = {
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
};

describe('ChatRequestDto — whitelist', () => {
  it('DTO에 없는 최상위 속성을 제거한다', async () => {
    const transformed = await transformBody({
      message: '안녕하세요',
      unexpected: '제거돼야 한다',
    });

    expect(transformed).not.toHaveProperty('unexpected');
    // 남아야 하는 것을 함께 센다. 전부 지우는 구현도 위 단정만으로는 통과한다.
    expect(transformed).toHaveProperty('message', '안녕하세요');
  });

  it('중첩된 일정 안의 속성도 제거한다', async () => {
    const transformed = await transformBody({
      message: '제주 2박3일',
      itinerary: { ...ITINERARY, unexpected: '제거돼야 한다' },
    });

    expect(transformed).toHaveProperty('itinerary');
    expect(transformed).not.toHaveProperty('itinerary.unexpected');
    expect(transformed).toHaveProperty('itinerary.summary.destination', '제주');
  });
});

describe('ChatRequestDto — itinerary는 optional이지만 검증은 살아 있다', () => {
  it('itinerary가 없어도 통과한다', async () => {
    await expect(transformBody({ message: '안녕하세요' })).resolves.toEqual({
      message: '안녕하세요',
    });
  });

  it('itinerary가 명시적 null이어도 통과하고 값이 null로 남는다', async () => {
    // @IsOptional()이 null도 통과시킨다(실측). 응답 쪽에서 이 값을 일정이 있는
    // 것으로 취급하면 planStatus가 어긋나므로 buildChatResponse가 둘을 함께 받는다.
    await expect(
      transformBody({ message: '안녕하세요', itinerary: null }),
    ).resolves.toEqual({ message: '안녕하세요', itinerary: null });
  });

  it('↔ 짝: itinerary가 있으면 잘못된 모양을 여전히 거부한다', async () => {
    // @IsOptional()이 값이 있을 때도 검증을 건너뛰면 이 단정이 깨진다.
    await expect(
      transformBody({ message: '제주 2박3일', itinerary: { summary: {} } }),
    ).rejects.toThrow();
  });
});
```

**(2-2)** `src/chat/chat.controller.spec.ts`의 `it('DTO에 없는 속성은 제거한다', ...)` **전체**(`:219-235`)를 아래로 **교체**. 제거 자체를 볼 수 없게 됐으므로 남는 계약만 센다:

```ts
  it('DTO에 없는 속성을 실어 보내도 200이다', async () => {
    // whitelist가 조용히 제거한다(forbidNonWhitelisted를 켜지 않았다).
    //
    // 제거 자체는 여기서 볼 수 없다 — 어느 갈래도 요청 일정을 되돌려주지 않으므로
    // 관측 창이 닫혔다. 제거 동작은 dto/chat-request.dto.spec.ts가 파이프를 직접
    // 불러 센다. 이 케이스가 지키는 것은 "추가 필드가 400을 만들지 않는다"뿐이다.
    await request(app.getHttpServer())
      .post('/chat')
      .send({
        message: '제주 2박3일',
        itinerary: { ...createItinerary(), unexpected: '무시돼야 한다' },
        unexpectedTop: '무시돼야 한다',
      })
      .expect(200);
  });
```

> **이 교체를 Task 5로 미루지 않는다.** `itinerary`가 optional이 되는 이 태스크에서 이미 `unexpectedTop`이 최상위에 실릴 수 있고, 무엇보다 whitelist 대체 spec이 여기서 생겨야 다음 태스크가 관측 공백 없이 진행된다.

- [ ] **Step 3: 실패를 확인**

```
npm test -- chat.controller
npm test -- chat-request.dto
```

Expected:

| 명령 | 결과 |
|---|---|
| `chat.controller` | FAIL — 새 테스트 2건. 둘 다 `expected 200 "OK", got 400 "Bad Request"` (`@IsOptional()`이 없으면 필드 부재도 명시적 `null`도 `@IsObject()`에 걸린다) |
| `chat-request.dto` | FAIL — `itinerary가 없어도 통과한다`·`itinerary가 명시적 null이어도 …` 2건이 `BadRequestException`으로 reject된다. whitelist 2건은 **통과한다**(그 동작은 이미 있다) |

```
● ChatController › itinerary가 없어도 400이 아니다

  expected 200 "OK", got 400 "Bad Request"

● ChatController › itinerary가 명시적 null이어도 400이 아니다

  expected 200 "OK", got 400 "Bad Request"
```

- [ ] **Step 4: 구현**

**(3-1)** `src/chat/dto/chat-request.dto.ts:2-8`의 `class-validator` import 블록을 아래로 **교체**(`IsOptional` 한 줄이 늘어난다):

```ts
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
```

**(3-2)** 같은 파일의 `itinerary` 필드 블록(`:31-34`)을 아래로 **교체**:

```ts
  /**
   * 첫 턴에는 일정이 없다. 필수로 두면 프론트가 일정 없이 대화를 시작할 수 없어
   * 400이 되고, 그러면 응답의 planStatus가 'none'이 되는 경로 자체가 도달
   * 불가능해진다 — 필드가 의미를 갖지 못한다.
   *
   * **서버는 이 값을 아직 읽지 않는다.** 응답의 일정은 plan 갈래가 새로 만든다
   * (게이트 1 Q3). 그래도 받아 두는 이유는 INTENT_DESCRIPTIONS가 "이미 만들어진
   * 일정을 고쳐 달라는 요청"도 plan_itinerary로 분류하기 때문이다 — 그 요청을
   * 실제로 처리하려면 직전 일정이 반드시 필요하고, 그때 계약을 다시 열면
   * 프론트도 함께 고쳐야 한다. 지금 지우면 whitelist가 프론트가 보낸 값을
   * 400도 로그도 없이 조용히 버린다.
   *
   * @IsOptional은 값이 없을 때만 나머지 검증을 건너뛴다. 값이 오면 여전히
   * 중첩 검증이 걸리므로 잘못된 모양의 일정은 그대로 400이다.
   *
   * 타입에 null을 담는 이유는 @IsOptional이 **명시적 null도 통과시키고 값을
   * null로 남기기** 때문이다(실측). undefined만 선언하면 타입이 런타임을 속인다.
   */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ItineraryDto)
  itinerary?: ItineraryDto | null;
```

- [ ] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — 400 테스트 1건이 200 테스트 2건으로 바뀌고(`chat.controller.spec` +1), `chat-request.dto.spec` **신규 5건**, `DTO에 없는 속성은 …` 1:1 교체. **누계를 직접 센다.**

**`@IsOptional`이 중첩 검증을 죽이지 않았다는 증거를 함께 센다.** `허용되지 않은 category는 400`(`:197`)과 `중첩된 일정의 필수 필드 누락도 400으로 잡는다`(`:207`), 그리고 새 `↔ 짝: itinerary가 있으면 잘못된 모양을 여전히 거부한다` 3건이 여전히 통과해야 한다. 이들이 초록이 아니면 `@IsOptional`이 값이 있을 때도 검증을 건너뛴 것이다.

**검출력 확인 (두 갈래):**

| 임시 변경 | red가 되어야 하는 것 |
|---|---|
| `@IsOptional()` 한 줄을 지운다 | 새 컨트롤러 테스트 2건 + `chat-request.dto.spec`의 optional 2건. **중첩 검증 3건은 초록으로 남아야 한다** — 함께 터지면 검증까지 껐다는 뜻이다 |
| `createPipe()`의 `whitelist: true`를 `false`로 바꾼다 | `DTO에 없는 최상위 속성을 제거한다`·`중첩된 일정 안의 속성도 제거한다` **2건만**. 이것이 옮긴 관측이 실제로 작동한다는 증거다 |

- [ ] **Step 6: 커밋**

```bash
git add src/chat/dto/chat-request.dto.ts src/chat/dto/chat-request.dto.spec.ts src/chat/chat.controller.spec.ts
git commit -m "feat(backend): 요청의 itinerary를 optional로 만들고 whitelist 관측을 옮긴다

프론트가 첫 턴에 일정 없이 요청할 수 없으면 400이 되고, 그러면 응답의
planStatus: 'none'이 도달 불가능해져 방금 추가한 필드가 의미를 갖지 못한다.
값이 오면 @IsOptional이 검증을 건너뛰지 않으므로 잘못된 모양의 일정은
그대로 400이다 — category·중첩 필수 필드 400 테스트가 그 증거다.

타입에 null을 담았다. @IsOptional은 명시적 null도 통과시키고 값을 null로
남긴다 — undefined만 선언하면 타입이 런타임을 속이고 응답 팩토리가 null을
일정이 있는 것으로 취급한다.

whitelist 관측을 dto spec으로 옮겼다. 세 갈래가 요청 일정을 되돌려주지
않게 되면서 응답에서 제거를 볼 수 없어졌고, 그 한 건이 저장소에서
whitelist를 세는 유일한 테스트였다. 파이프를 직접 불러 대신 센다 —
app.setup.ts가 같은 옵션을 쓴다는 것은 여전히 아무도 세지 않는다."
```

---

### Task 3: mock 일정 데이터를 backend로 옮긴다

`plan_itinerary`가 돌려줄 일정의 자리를 만든다. 순수 모듈이므로 `chat.module.ts`를 건드리지 않고, 이 태스크 시점에는 소비자가 spec뿐이다.

**Files:**
- Create: `src/chat/plan/mock-itineraries.ts`
- Test: `src/chat/plan/mock-itineraries.spec.ts`

**Interfaces:**
- Consumes: 없음 (`ItineraryDto`는 기존 타입)
- Produces: `buildMockItinerary(message: string): ItineraryDto | null`

> **`null`을 반환한다(게이트 1 Q4).** 기본 목적지 폴백을 두지 않는다 — 폴백하면 "일정 짜줘" 한 마디에 서울 일정이 패널에 뜨고 사용자는 자기가 요청한 것이라고 믿는다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/chat/plan/mock-itineraries.spec.ts`를 **새로 만든다**:

```ts
import { buildMockItinerary } from './mock-itineraries';

/**
 * 목적지 선택과 **일정의 내용**을 함께 센다.
 *
 * 내용을 세지 않으면 빈 days를 돌려주는 데이터로도 planStatus: 'ready'가
 * 통과하고, 프론트는 빈 패널을 띄운다 — fixture가 조용히 썩는 것을 잡을
 * 유일한 방어선이다(a490424와 같은 위험).
 */

describe('buildMockItinerary — 목적지 선택', () => {
  it('제주가 들어오면 제주 일정을 돌려준다', () => {
    expect(buildMockItinerary('제주 2박3일 짜줘')?.summary.destination).toBe(
      '제주',
    );
  });

  it("'제주도'도 같은 제주 일정으로 간다", () => {
    expect(buildMockItinerary('제주도 여행 일정')?.summary.destination).toBe(
      '제주',
    );
  });

  it('부산이 들어오면 부산 일정을 돌려준다', () => {
    expect(buildMockItinerary('부산 2박3일 짜줘')?.summary.destination).toBe(
      '부산',
    );
  });

  it('서울이 들어오면 서울 일정을 돌려준다', () => {
    // 세 목적지를 전부 옮긴 근거가 이 테스트다(결정 10). 키를 빼면 정상 요청이
    // planStatus: 'none'이 되고 사용자에게는 패널이 안 뜨는 것으로 보인다.
    expect(buildMockItinerary('서울 2박3일 짜줘')?.summary.destination).toBe(
      '서울',
    );
  });

  it('아는 목적지가 없으면 null이다', () => {
    // 기본 목적지로 폴백하지 않는다(게이트 1 Q4). 폴백하면 '일정 짜줘' 한 마디에
    // 엉뚱한 도시의 일정이 패널에 뜨고 사용자는 자기가 요청한 것이라고 믿는다.
    expect(buildMockItinerary('울란바토르 일정 짜줘')).toBeNull();
  });

  it('↔ 짝: 목적지가 없는 요청은 어떤 일정도 만들지 않는다', () => {
    // 위 단정이 '울란바토르'라는 특정 단어에만 반응하는 구현으로 통과하지
    // 않게 한다. 목적지 없는 평범한 일정 요청이 같은 결과여야 한다.
    expect(buildMockItinerary('일정 짜줘')).toBeNull();
    expect(buildMockItinerary('여행 계획 만들어줘')).toBeNull();
  });
});

describe('buildMockItinerary — 일정의 내용', () => {
  const messages = ['서울', '부산', '제주'];

  it.each(messages)('%s 일정에 빈 날이 없다', (message) => {
    const itinerary = buildMockItinerary(message);

    expect(itinerary).not.toBeNull();
    expect(itinerary?.days.length).toBeGreaterThan(0);
    for (const day of itinerary?.days ?? []) {
      expect(day.places.length).toBeGreaterThan(0);
    }
  });

  it.each(messages)('%s 일정의 요약 세 필드가 비어 있지 않다', (message) => {
    const summary = buildMockItinerary(message)?.summary;

    expect(summary?.destination.length).toBeGreaterThan(0);
    expect(summary?.duration.length).toBeGreaterThan(0);
    expect(summary?.travelers.length).toBeGreaterThan(0);
  });

  it('제주 일정은 3일이고 날마다 3·4·2개 장소를 갖는다', () => {
    const days = buildMockItinerary('제주')?.days ?? [];

    expect(days.map((day) => day.day)).toEqual([1, 2, 3]);
    expect(days.map((day) => day.places.length)).toEqual([3, 4, 2]);
  });

  it.each(messages)('%s 일정의 핀 번호가 날마다 1부터 이어진다', (message) => {
    // 지도 핀이 이 번호로 찍힌다. 0이나 중복이 섞이면 화면에서만 드러난다.
    const days = buildMockItinerary(message)?.days ?? [];

    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      const expected = day.places.map((_place, index) => index + 1);
      expect(day.places.map((place) => place.pinNumber)).toEqual(expected);
    }
  });
});

describe('buildMockItinerary — 요청 간 오염', () => {
  it('앞 호출의 결과를 변형해도 다음 호출이 원본을 돌려준다', () => {
    // 모듈 스코프 상수를 응답에 참조 그대로 실으면 누군가 한 번 변형하는 순간
    // 이후 모든 요청이 오염된다(structured-query.ts:86-88이 EMPTY_CONDITIONS에
    // 전개를 요구하는 것과 같은 위험). 얕은 전개는 days·places를 공유하므로
    // 이 테스트를 통과하지 못한다.
    const first = buildMockItinerary('제주');
    expect(first).not.toBeNull();
    if (first === null) {
      return;
    }
    first.summary.destination = '오염됨';
    first.days[0].places[0].name = '오염됨';
    first.days.length = 1;

    const second = buildMockItinerary('제주');

    expect(second?.summary.destination).toBe('제주');
    expect(second?.days[0].places[0].name).toBe('성산일출봉');
    expect(second?.days).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- mock-itineraries
```

Expected: FAIL — 스위트가 아예 로드되지 않는다:

```
Cannot find module './mock-itineraries' from 'chat/plan/mock-itineraries.spec.ts'
```

- [ ] **Step 3: 구현 — 파일 골격**

`src/chat/plan/mock-itineraries.ts`를 **새로 만든다.** 아래가 데이터 블록을 뺀 전문이고, `{ /* 데이터 — Step 4 */ }` 자리에 Step 4가 들어간다:

```ts
import type { ItineraryDto } from '../dto/itinerary.dto';

/**
 * 임시 일정 데이터. frontend/src/lib/mock/itineraries.ts에서 그대로 옮겨 왔다.
 *
 * 옮긴 이유는 계약을 만드는 쪽이 backend이기 때문이다 — 프론트에 두면 "일정이
 * 준비됐다"를 프론트가 스스로 판정하게 되고 planStatus가 의미를 갖지 못한다.
 *
 * 이것은 일정 생성이 아니라 **일정 자리 채우기**다. 실제 생성(TEI 임베딩 +
 * Qdrant 검색 + 조립)이 들어오면 이 파일 전체가 사라지고 buildMockItinerary의
 * 호출부만 남는다. 다음 실행이 이 데이터를 실제 구현으로 오인하지 않게
 * 파일 이름에 mock을 담았다.
 */

/**
 * 담고 있는 목적지. 아래 Record 둘이 이 세 키를 강제하므로 목적지를 더하면
 * 일정과 키워드 양쪽을 채우지 않는 한 컴파일되지 않는다.
 *
 * 이 저장소의 유니온 관례인 `as const` 배열 + `(typeof X)[number]`를 쓰지 않는다 —
 * 런타임 멤버십 검사가 없어서 배열이 타입으로만 쓰이고, 그러면 eslint의
 * no-unused-vars가 "assigned a value but only used as a type"으로 막는다(실측).
 * CHAT_INTENTS·PLACE_CATEGORIES는 각각 parseIntent·@IsIn이라는 런타임 소비자가
 * 있어서 배열 형태가 성립한다.
 */
type DestinationKey = 'seoul' | 'busan' | 'jeju';

const ITINERARIES: Record<DestinationKey, ItineraryDto> = {
  /* 데이터 — Step 4 */
};

/**
 * 메시지에 나타나는 목적지 이름. '제주도'를 '제주'보다 앞에 둔 원본 순서를
 * 유지했다 — 둘 다 같은 키로 가므로 결과는 같지만, 키가 갈리는 이름을 나중에
 * 더할 때 긴 이름이 먼저 걸려야 한다.
 *
 * 이 맵에 없는 목적지는 일정을 만들 수 없다. 세 목적지를 전부 옮긴 이유가
 * 여기 있다 — 키를 빼면 '서울 일정 짜줘'가 planStatus: 'none'이 되고,
 * 사용자에게는 정상 요청이 패널을 못 띄우는 것으로 보인다.
 */
const DESTINATION_KEYWORDS: Record<string, DestinationKey> = {
  서울: 'seoul',
  부산: 'busan',
  제주도: 'jeju',
  제주: 'jeju',
};

function findDestinationKey(message: string): DestinationKey | null {
  for (const [keyword, key] of Object.entries(DESTINATION_KEYWORDS)) {
    if (message.includes(keyword)) {
      return key;
    }
  }
  return null;
}

/**
 * 메시지에서 목적지를 골라 일정을 만든다. **아는 목적지가 없으면 null이다.**
 *
 * 기본 목적지로 폴백하지 않는다(사용자 결정, 게이트 1 Q4). 폴백하면 "일정 짜줘"
 * 한 마디에 엉뚱한 도시의 일정이 패널에 뜨고, 사용자는 자기가 요청한 것이라고
 * 믿는다 — 틀린 일정을 자신 있게 보여주는 것이 아무것도 안 보여주는 것보다 나쁘다.
 *
 * structuredClone으로 매 호출마다 새 객체를 만든다. 모듈 스코프 상수를 응답에
 * 참조 그대로 실으면 누군가 그것을 한 번 변형하는 순간 이후 모든 요청이 오염된다
 * (structured-query.ts:86-88의 EMPTY_CONDITIONS가 전개를 요구하는 것과 같은
 * 위험이다). 얕은 전개는 days·places를 그대로 공유하므로 방어처럼 보이기만 한다.
 */
export function buildMockItinerary(message: string): ItineraryDto | null {
  const key = findDestinationKey(message);

  return key === null ? null : structuredClone(ITINERARIES[key]);
}
```

> `findDestinationKey`를 export하지 않는다. 선택 규칙은 `buildMockItinerary`를 통해서만 검증한다 — export하면 테스트 표면이 둘이 되고, 둘 중 하나만 고쳐도 초록불이 나온다.

- [ ] **Step 4: 구현 — 데이터를 **그대로** 옮긴다**

`{ /* 데이터 — Step 4 */ }` 자리에 **`frontend/src/lib/mock/itineraries.ts:4-292`의 `seoul`·`busan`·`jeju` 세 항목을 값 그대로 옮긴다.** 세 키 이름도 그대로 쓴다.

**허용되는 변경은 포맷뿐이다:**
- 큰따옴표 → 홑따옴표 (prettier)
- 긴 `description` 줄의 줄바꿈 (prettier)

**값은 하나도 바꾸지 않는다** — `id`·`name`·`category`·`time`·`description`·`pinNumber`·`summary` 전부. 옮긴 뒤 포맷은 손으로 맞추지 말고 `npm run lint`에 맡긴다(실측: prettier가 여러 `description` 줄을 재배치한다).

Step 1의 내용 단정(제주 `[3, 4, 2]`, `days` 3개, 핀 번호 연속, `'성산일출봉'`)이 옮기다 빠뜨린 것을 잡는다.

- [ ] **Step 5: 통과를 확인**

```
npm run lint
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — `mock-itineraries.spec` **신규 17건**. **누계를 직접 센다.**

**검출력 확인 (두 갈래):**

| 임시 변경 | red가 되어야 하는 것 |
|---|---|
| `structuredClone(ITINERARIES[key])` → `{ ...ITINERARIES[key] }` | `앞 호출의 결과를 변형해도 …` **한 건만**. **이것이 얕은 전개가 방어가 아니라는 실측 증거다** |
| `key === null ? null : …` → `structuredClone(ITINERARIES[key ?? 'seoul'])` (게이트 1 이전의 폴백 형태) | `아는 목적지가 없으면 null이다`·`↔ 짝: 목적지가 없는 요청은 …` **2건만**. 이 뮤테이션이 정확히 사용자가 거부한 동작이다 |

- [ ] **Step 6: 커밋**

```bash
git add src/chat/plan/
git commit -m "feat(backend): mock 일정 데이터를 frontend에서 옮겨 온다

프론트에 두면 '일정이 준비됐다'를 프론트가 스스로 판정하게 되고 planStatus가
의미를 갖지 못한다. 계약을 만드는 쪽이 backend다.

@Injectable이 아닌 순수 모듈이다. 외부 의존이 없고, ChatService 생성자에
넣으면 chat.service.spec의 createService가 provider 셋만 대체하므로 테스트
19건이 주입 실패로 죽는다. chat.module.ts도 건드리지 않게 된다.

structuredClone으로 매 호출 새 객체를 만든다. 모듈 상수를 응답에 참조 그대로
실으면 한 번의 변형이 이후 모든 요청을 오염시킨다 — EMPTY_CONDITIONS가 전개를
요구하는 것과 같은 위험이고, 얕은 전개는 days·places를 공유하므로 방어가 아니다.

아는 목적지가 없으면 null이다. 기본 목적지로 폴백하면 '일정 짜줘' 한 마디에
엉뚱한 도시의 일정이 패널에 뜨고 사용자는 자기가 요청한 것이라고 믿는다 —
틀린 일정을 자신 있게 보여주는 것이 아무것도 안 보여주는 것보다 나쁘다.

세 목적지를 전부 옮긴 이유는 키워드 맵과 일정이 짝이기 때문이다. 일정을 빼면
키워드도 빼야 하고, 그러면 '서울 일정 짜줘'가 none이 되어 정상 요청이 패널을
못 띄운다. 프론트 mock이 삭제되면 이 데이터의 유일한 소유자도 여기다."
```

---

### Task 4: plan 갈래의 노출 문구를 만든다

`plan_itinerary`가 일정을 돌려줄 때의 문장. `query-reply.ts`의 관례를 따라 문구를 named export 상수로 빼서 spec이 고정할 수 있게 한다.

**Files:**
- Create: `src/chat/plan/plan-reply.ts`
- Test: `src/chat/plan/plan-reply.spec.ts`

**Interfaces:**
- Consumes: Task 3의 `buildMockItinerary` (spec에서만)
- Produces: `PLAN_READY_GUIDE: string` · `PLAN_DESTINATION_UNKNOWN_REPLY: string` · `buildPlanReply(itinerary: ItineraryDto | null): string`

> **게이트 1 Q4가 이 태스크를 키웠다.** plan 갈래가 `none`을 낼 수 있게 되면서 **매칭 실패 문구가 필요해졌다** — 설명 없는 `none`은 사용자에게 서비스 고장과 구별되지 않는다. `null` 분기를 호출자가 아니라 이 함수 안에서 가르는 근거는 결정 13이다: 같은 값이 reply와 `itinerary`를 함께 결정해야 둘이 어긋날 수 없다.
>
> **미해결 질문 Q6이 이 태스크에 걸린다.** `PLAN_DESTINATION_UNKNOWN_REPLY`의 값이 확정되지 않았다 — 다르게 정하면 상수 한 줄과 전문 등가 단정 1건을 고친다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/chat/plan/plan-reply.spec.ts`를 **새로 만든다**. (Task 6이 이 파일 맨 위 import 블록에 `buildRecommendReply` 대조를 더한다 — 지금은 그 import를 넣지 않는다. 이 태스크 시점에 쓰이지 않는 import는 `no-unused-vars`로 게이트를 막는다.)

```ts
import { buildMockItinerary } from './mock-itineraries';
import {
  buildPlanReply,
  PLAN_DESTINATION_UNKNOWN_REPLY,
  PLAN_READY_GUIDE,
} from './plan-reply';

describe('buildPlanReply — 준비된 일정을 알리는 문장', () => {
  it('목적지와 기간을 문장에 그대로 싣는다', () => {
    // 전문 등가로 고정한다. 문구를 고치면 이 한 건이 깨지고, 그게 노출 문구를
    // 바꿨다는 유일한 신호다.
    const reply = buildPlanReply(buildMockItinerary('제주 2박3일 짜줘'));

    expect(reply).toBe(`제주 2박 3일 일정을 준비했어요! ${PLAN_READY_GUIDE}`);
  });

  it('목적지가 바뀌면 문장도 바뀐다', () => {
    // 위 단정이 "항상 같은 문자열을 낸다"는 구현으로도 통과하지 않게 한다.
    expect(buildPlanReply(buildMockItinerary('부산'))).toContain('부산');
    expect(buildPlanReply(buildMockItinerary('부산'))).not.toContain('제주');
  });

  it('화면 배치를 문구에 담지 않는다', () => {
    // 원문(frontend/src/lib/mock/scenarios.ts:18)의 '오른쪽에서'를 뺀 결정을
    // 고정한다. 모바일에서는 오른쪽이 아니라 탭이다.
    expect(buildPlanReply(buildMockItinerary('제주'))).not.toContain('오른쪽');
  });
});

describe('buildPlanReply — 목적지를 못 알아들었을 때', () => {
  it('무엇을 알려줘야 하는지 말한다', () => {
    // 일정 요청으로 이해했는데 패널이 뜨지 않는 상태를 설명 없이 두면 사용자는
    // 서비스가 고장난 것과 구별할 수 없다. 이 문구가 유일한 단서다.
    expect(buildPlanReply(null)).toBe(PLAN_DESTINATION_UNKNOWN_REPLY);
  });

  it('↔ 짝: 준비 완료 문구와 겹치지 않는다', () => {
    // 두 문구가 같아지면 매칭 실패가 성공처럼 보인다. 맺음말이 실리지 않는
    // 것까지 센다 — 'Day별 코스를 확인해보세요'는 일정이 있을 때만 참이다.
    expect(buildPlanReply(null)).not.toBe(
      buildPlanReply(buildMockItinerary('제주')),
    );
    expect(buildPlanReply(null)).not.toContain(PLAN_READY_GUIDE);
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- plan-reply
```

Expected: FAIL — 스위트가 로드되지 않는다:

```
Cannot find module './plan-reply' from 'chat/plan/plan-reply.spec.ts'
```

- [ ] **Step 3: 구현**

`src/chat/plan/plan-reply.ts`를 **새로 만든다**:

```ts
import type { ItineraryDto } from '../dto/itinerary.dto';

/**
 * 일정을 돌려주는 갈래의 맺음말.
 *
 * 노출 문구를 named export 상수로 빼는 이유는 spec이 그것을 import해 단정할 수
 * 있기 때문이다(query-reply.ts:8-14와 같은 이유). 상수가 없으면 테스트가 문구를
 * 복제하고, 문구를 고칠 때 두 곳이 갈린다.
 *
 * 화면 배치를 문구에 담지 않는다. 원문(frontend/src/lib/mock/scenarios.ts:18)은
 * '오른쪽에서 Day별 코스를 확인해보세요.'였는데 모바일에서는 오른쪽이 아니라
 * 탭이다 — 배치를 바꿀 때 backend 문구까지 따라 바뀌어야 하는 결합을 만들지 않는다.
 */
export const PLAN_READY_GUIDE = 'Day별 코스를 확인해보세요.';

/**
 * 목적지를 알아듣지 못해 일정을 만들지 못했을 때의 문구.
 *
 * 이 갈래가 planStatus: 'none'을 낼 수 있게 되면서 필요해졌다(게이트 1 Q4).
 * 사용자에게 **무엇을 하면 되는지** 알려주는 것이 이 문구의 유일한 일이다 —
 * 일정 요청으로 이해했는데 패널이 뜨지 않는 상태를 설명 없이 두면, 사용자는
 * 서비스가 고장난 것과 구별할 수 없다.
 *
 * OTHER_REPLY와 내용이 겹치지만 재사용하지 않는다. 그 상수는 other 갈래
 * 안쪽의 폴백이고, 여기서 import하면 plan → other 방향 결합이 생긴다.
 */
export const PLAN_DESTINATION_UNKNOWN_REPLY =
  "어느 지역으로 떠나고 싶으신가요? '제주 2박3일'처럼 목적지를 알려주시면 일정을 만들어드릴게요.";

/**
 * 일정 갈래의 한 문장을 만든다. null이면 목적지를 못 알아들은 것이다.
 *
 * null 분기를 호출자(ChatService)가 아니라 여기서 가른다 — 같은 값이 reply와
 * itinerary를 함께 결정해야 둘이 어긋날 수 없다. 호출자가 갈래를 나누면
 * "일정은 null인데 문구는 준비됐다고 말하는" 조합이 표현 가능해진다.
 *
 * 모델의 자유 텍스트를 싣지 않는다 — 일정의 표시용 필드만 우리 문장 틀에 끼운다
 * (buildRecommendReply와 같은 경계).
 */
export function buildPlanReply(itinerary: ItineraryDto | null): string {
  if (itinerary === null) {
    return PLAN_DESTINATION_UNKNOWN_REPLY;
  }

  const { destination, duration } = itinerary.summary;

  return `${destination} ${duration} 일정을 준비했어요! ${PLAN_READY_GUIDE}`;
}
```

- [ ] **Step 4: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — `plan-reply.spec` **신규 5건**(Task 6이 여기에 1건을 더해 최종 6건이 된다). **누계를 직접 센다.**

**검출력 확인 (두 갈래):**

| 임시 변경 | red가 되어야 하는 것 |
|---|---|
| 템플릿에서 `${duration} `를 지운다 | `목적지와 기간을 …` **한 건만** |
| `if (itinerary === null) return PLAN_DESTINATION_UNKNOWN_REPLY;`를 지우고 `itinerary!.summary`로 읽는다 | `무엇을 알려줘야 하는지 말한다`·`↔ 짝: 준비 완료 문구와 …` 2건이 `TypeError`로 터진다. **null 분기를 호출자에게 미루면 이 두 건이 사라지고 그 조합을 아무도 세지 않는다** |

- [ ] **Step 5: 커밋**

```bash
git add src/chat/plan/plan-reply.ts src/chat/plan/plan-reply.spec.ts
git commit -m "feat(backend): plan 갈래의 문구 둘을 만든다

문구를 named export 상수로 뺀 이유는 spec이 그것을 import해 고정할 수 있게
하려는 것이다 — query-reply.ts가 노출 문구를 상수로 두는 것과 같은 이유다.

원문(frontend mock)의 '오른쪽에서'를 뺐다. 화면 배치를 문구에 박아넣으면
모바일에서 거짓말이 되고(그쪽은 탭이다), 배치를 바꿀 때 backend 문구까지
따라 움직여야 한다.

목적지를 못 알아들었을 때의 문구가 함께 필요해졌다. 설명 없는 none은
사용자에게 서비스 고장과 구별되지 않는다 — 일정 요청으로 이해했는데 패널이
뜨지 않고 이유도 없다. OTHER_REPLY와 내용이 겹치지만 재사용하지 않았다.
그 상수는 other 갈래 안쪽의 폴백이고, 가져오면 plan → other 결합이 생긴다.

null 분기를 호출자가 아니라 이 함수 안에서 가른다. 같은 값이 reply와
itinerary를 함께 결정해야 '일정은 null인데 준비됐다고 말하는' 조합이
표현 불가능해진다."
```

---

### Task 5: switch를 갈라 plan 갈래가 일정을 돌려주게 한다

두 갈래가 처음으로 실제로 갈린다. 직전 실행이 예고한 부채를 갚는 태스크이며, 과거 stray 변경(두 case 핸들러 뒤바뀜)을 잡는 첫 테스트가 여기서 생긴다.

**Files:**
- Modify: `src/chat/chat.service.ts`
- Test: `src/chat/chat.service.spec.ts`, `src/chat/chat.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1의 `buildChatResponse` · Task 3의 `buildMockItinerary` · Task 4의 `buildPlanReply`
- Produces: `ChatService`의 private 메서드 3개 `replyPlan` · `replyRecommend` · `replyOther`

- [ ] **Step 1: 실패하는 테스트 작성 — `chat.service.spec.ts` 전문 교체**

`src/chat/chat.service.spec.ts`를 **아래 전문으로 교체한다**:

```ts
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../clients/external-service.error';
import { ChatService } from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildMockItinerary } from './plan/mock-itineraries';
import { buildPlanReply, PLAN_READY_GUIDE } from './plan/plan-reply';
import { RECOMMEND_REPLY_HEAD } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';
import type { StructuredQuery } from './query/structured-query';
import { EMPTY_CONDITIONS } from './query/structured-query';

/**
 * 갈래 라우팅·위임과 갈래별 planStatus만 본다. 모킹 경계는 협력자다 — 분류는
 * intent.classifier.spec.ts가, 구조화는 query.structurer.spec.ts가, 문장 서식은
 * query-reply.spec.ts·plan/plan-reply.spec.ts가, planStatus와 itinerary의 짝은
 * dto/chat-response.dto.spec.ts가 따로 고정한다.
 */

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

/** plan 갈래가 이 메시지로 만드는 mock 일정의 목적지는 제주다. */
const PLAN_MESSAGE = '제주 2박3일 일정 짜줘';

/**
 * 요청에 실려 오는 일정. 목적지를 강릉으로 둔다 — mock 일정 셋(서울·부산·제주)과
 * 겹치면 "요청을 통과시켰는가"와 "새로 만들었는가"가 목적지로 구별되지 않는다.
 *
 * 호출마다 새 리터럴을 만든다. 모듈 상수를 공유하면 아래 toBe(참조 동일성)
 * 단정이 통과 근거를 잃는다.
 */
function createRequest(message: string): ChatRequestDto {
  return {
    message,
    itinerary: {
      summary: {
        destination: '강릉',
        duration: '1박 2일',
        travelers: '성인 2명',
      },
      days: [
        {
          day: 1,
          places: [
            {
              id: 'place-1',
              name: '경포해변',
              category: '관광지',
              time: '09:00',
              description: '해돋이 명소',
              pinNumber: 1,
            },
          ],
        },
      ],
    },
  };
}

/** 첫 턴의 요청. itinerary가 optional이 된 뒤 프론트가 실제로 보내는 모양이다. */
function createRequestWithoutItinerary(message: string): ChatRequestDto {
  return { message };
}

async function createService(): Promise<ChatService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatService,
      { provide: IntentClassifier, useValue: { classify } },
      { provide: QueryStructurer, useValue: { structure } },
      { provide: OtherResponder, useValue: { respond } },
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
  respond.mockReset().mockResolvedValue(OTHER_RESPONSE);
});

describe('ChatService — 갈래별 planStatus와 itinerary', () => {
  it('plan_itinerary는 요청에 일정이 있어도 새 일정을 ready로 돌려준다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(createRequest(PLAN_MESSAGE));

    expect(response.planStatus).toBe('ready');
    // 목적지가 제주면 요청의 강릉 일정이 아니라 새로 만든 일정이다.
    expect(response.itinerary?.summary.destination).toBe('제주');
    expect(response.itinerary?.days).toHaveLength(3);
  });

  it('plan_itinerary는 요청에 일정이 없어도 ready다', async () => {
    // 첫 턴이 이 경로다. 여기서 none이 나오면 패널이 영구히 뜨지 않는다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary?.summary.destination).toBe('제주');
  });

  it('↔ 짝: recommend_places는 같은 요청에서 none이다', async () => {
    // 위 케이스와 요청이 완전히 같고 분류값만 다르다. 두 갈래의 case 핸들러가
    // 뒤바뀌면 이 짝이 잡는다 — 과거에 정확히 그 뒤바뀜이 미커밋 상태로 있었고,
    // 갈래별 응답이 없어서 테스트가 초록불이었다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('recommend_places는 요청의 일정을 그대로 통과시켜 ready가 된다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();
    const request = createRequest('제주 관광지 추천해줘');

    const response = await service.chat(request);

    expect(response.planStatus).toBe('ready');
    // 참조 동일성까지 본다. 이 갈래는 일정을 손대지 않는다.
    expect(response.itinerary).toBe(request.itinerary);
  });

  it('other는 요청에 일정이 없으면 none이다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequestWithoutItinerary('안녕'));

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('other는 요청의 일정을 그대로 통과시켜 ready가 된다', async () => {
    // 일정을 받은 뒤 인사 한 마디를 하면 패널이 사라지는 회귀를 막는다.
    classify.mockResolvedValue('other');
    const service = await createService();
    const request = createRequest('고마워');

    const response = await service.chat(request);

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary).toBe(request.itinerary);
  });
});

describe('ChatService — 갈래별 reply', () => {
  it('plan_itinerary는 준비된 일정을 알리는 문장을 돌려준다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(createRequest(PLAN_MESSAGE));

    expect(response.reply).toBe(
      buildPlanReply(buildMockItinerary(PLAN_MESSAGE)),
    );
    // 위 단정만으로는 두 함수가 함께 망가져도 통과한다. 문장에 목적지와
    // 맺음말이 실제로 실렸는지 따로 센다.
    expect(response.reply).toContain('제주');
    expect(response.reply).toContain(PLAN_READY_GUIDE);
  });

  it('recommend_places는 구조화 결과를 되비춘 문장을 돌려준다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(createRequest('제주 관광지 추천해줘'));

    // 서식 전문은 query-reply.spec.ts가 고정한다. 여기서 보는 것은 "구조화
    // 결과가 실제로 문장에 실렸는가"다 — STRUCTURED의 region이 문구까지
    // 도달하지 않으면 구조화 폴백이 발동해도 머리말 단정만으로는 통과한다.
    expect(response.reply).toContain(RECOMMEND_REPLY_HEAD);
    expect(response.reply).toContain('지역: 제주');
  });

  it('other는 OtherResponder의 응답을 그대로 돌려준다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequest('안녕'));

    expect(response.reply).toBe(OTHER_RESPONSE);
  });

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
  it('recommend_places는 QueryStructurer를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 가족여행 관광지 추천'));

    expect(structure).toHaveBeenCalledTimes(1);
    expect(structure).toHaveBeenCalledWith('제주 가족여행 관광지 추천');
  });

  const nonStructuringIntents: ChatIntent[] = ['plan_itinerary', 'other'];

  it.each(nonStructuringIntents)(
    '↔ 짝: %s는 QueryStructurer를 호출하지 않는다',
    async (intent) => {
      // plan 갈래는 목적지를 원문 키워드로 고르므로 구조화 결과를 쓰지 않는다.
      // 부르면 결과를 버리는 Gemini 왕복이 하나 늘고, 그 왕복의 쿼터 소진이
      // 돌려줄 수 있었던 요청을 503으로 만든다.
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(structure).not.toHaveBeenCalled();
    },
  );
});

describe('ChatService — 대화 위임', () => {
  it('other 갈래는 OtherResponder를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 어때?'));

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('제주 어때?');
  });

  const nonChattingIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
  ];

  it.each(nonChattingIntents)(
    '↔ 짝: %s는 OtherResponder를 호출하지 않는다',
    async (intent) => {
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(respond).not.toHaveBeenCalled();
    },
  );
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
    classify.mockResolvedValue('recommend_places');
    structure.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 관광지'))).rejects.toBe(
      failure,
    );
  });

  it('OtherResponder가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 세 협력자에 대해 대칭으로 고정한다. other 갈래는 폴백 문구가 정상 응답과
    // 구별되지 않으므로, 여기서 삼키면 쿼터 소진이 평범한 대화로 보인다.
    const failure = quotaFailure();
    classify.mockResolvedValue('other');
    respond.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });
});
```

- [ ] **Step 2: 실패를 확인**

```
npm test -- chat.service
```

Expected: FAIL — **4 failed, 15 passed, 19 total**(실측). 네 건의 이유가 각각 다르므로 전부 확인한다:

| 실패 테스트 | 메시지 |
|---|---|
| `plan_itinerary는 요청에 일정이 있어도 새 일정을 ready로 돌려준다` | `Expected: "제주" / Received: "강릉"` — 요청 일정을 그대로 통과시키고 있다 |
| `plan_itinerary는 요청에 일정이 없어도 ready다` | `Expected: "ready" / Received: "none"` |
| `plan_itinerary는 준비된 일정을 알리는 문장을 돌려준다` | `Received: "일정 요청으로 이해했어요 — 지역: 제주. 장소를 찾아 일정을 짜는 단계는 다음에 붙습니다."` |
| `↔ 짝: plan_itinerary는 QueryStructurer를 호출하지 않는다` | `Expected number of calls: 0 / Received number of calls: 1` |

`↔ 짝: other는 QueryStructurer를 호출하지 않는다`와 `↔ 짝: recommend_places는 같은 요청에서 none이다`는 **통과한다** — 이미 그렇게 동작하기 때문이다. 정상이다.

- [ ] **Step 3: 구현 — `chat.service.ts` 전문 교체**

`src/chat/chat.service.ts`를 **아래 전문으로 교체한다**:

```ts
import { Injectable } from '@nestjs/common';

import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';
import { buildChatResponse } from './dto/chat-response.dto';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildMockItinerary } from './plan/mock-itineraries';
import { buildPlanReply } from './plan/plan-reply';
import { buildStructuredReply } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';

@Injectable()
export class ChatService {
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
  async chat(request: ChatRequestDto): Promise<ChatResponseDto> {
    const intent = await this.intentClassifier.classify(request.message);

    switch (intent) {
      // 두 갈래가 처음으로 실제로 갈린다. plan만 일정을 만들고 recommend는
      // 요청의 일정을 통과시킨다 — 직전 실행이 예고한 대로 묶은 case를 나눈다.
      case 'plan_itinerary':
        return this.replyPlan(request);
      case 'recommend_places':
        return this.replyRecommend(request);
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
   * 일정을 돌려주는 갈래. 이 갈래만 planStatus가 'ready'로 고정된다 — 요청에
   * 일정이 있었는지와 무관하게 새 일정을 만들어 돌려준다.
   *
   * TODO: 일정 생성(TEI 임베딩 + Qdrant 검색 + 조립)이 들어올 자리.
   * buildMockItinerary 호출 하나만 교체된다. 지금 돌려주는 것은 목적지 키워드로
   * 고른 고정 데이터이고 **생성이 아니다.**
   *
   * QueryStructurer를 부르지 않는다 — 목적지를 원문 키워드로 고르므로 구조화
   * 결과를 아무도 쓰지 않는다. 부르면 결과를 버리는 Gemini 왕복이 하나 늘고,
   * 그 왕복의 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다.
   */
  private replyPlan(request: ChatRequestDto): ChatResponseDto {
    const itinerary = buildMockItinerary(request.message);

    return buildChatResponse(buildPlanReply(itinerary), itinerary);
  }

  /**
   * 구조화 결과를 사용자에게 되비춘다. 일정을 만들지 않으므로 요청의 일정을
   * 그대로 통과시키고, planStatus는 그 유무에서 파생된다.
   *
   * TODO: 조건에 맞는 장소 목록을 붙이는 자리. 목록은 일정이 아니므로 이 갈래는
   * 일정이 붙어도 planStatus를 만들지 않는다.
   */
  private async replyRecommend(
    request: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    const query = await this.queryStructurer.structure(request.message);

    return buildChatResponse(
      buildStructuredReply('recommend_places', query),
      request.itinerary,
    );
  }

  /**
   * 대화 응답을 만든다. 이 갈래는 일정을 만들지 않으므로 itinerary가 입력 그대로
   * 나가는 것이 최종 형태다 — 위 두 갈래와 달리 TODO가 없다.
   */
  private async replyOther(request: ChatRequestDto): Promise<ChatResponseDto> {
    return buildChatResponse(
      await this.otherResponder.respond(request.message),
      request.itinerary,
    );
  }
}
```

> `buildStructuredReply`의 시그니처는 이 태스크에서 **바꾸지 않는다.** 이름과 파라미터 정리는 Task 6이다 — 두 태스크를 합치면 커밋 하나가 두 가지 이유로 파일을 건드린다.

- [ ] **Step 4: 컨트롤러 spec을 갈라진 갈래에 맞춘다**

`plan` 갈래의 reply·planStatus·Gemini 호출 수가 모두 바뀐다. 넷을 고치고 셋을 더한다.

**(4-1)** `src/chat/chat.controller.spec.ts:15-23`의 import 블록 중 `OtherResponder` 다음부터 `QueryStructurer` 앞까지를 아래로 **교체**(`PLAN_REPLY_HEAD`·`PLAN_REPLY_TAIL`이 빠지고 `PLAN_READY_GUIDE`·`RECOMMEND_REPLY_TAIL`이 들어온다):

```ts
import { PLAN_READY_GUIDE } from './plan/plan-reply';
import {
  NO_CONDITIONS_SUMMARY,
  RECOMMEND_REPLY_HEAD,
  RECOMMEND_REPLY_TAIL,
} from './query/query-reply';
```

**(4-2)** `it('세 분류값이 각각 다른 reply로 200이 된다', ...)` 끝의 단정 블록(`:255-263`)을 아래로 **교체**하고, **닫는 `});` 뒤에 새 테스트 셋을 이어 붙인다**:

```ts
    expect(replies[0]).toContain(PLAN_READY_GUIDE);
    expect(replies[1]).toContain(RECOMMEND_REPLY_HEAD);
    // fixture의 [조건]이 실제로 파싱돼 화면까지 실렸는지 센다. 이 줄이 없으면
    // 구조화 폴백('조건: 미지정')이 발동해도 위 단정들이 전부 통과한다.
    // plan 갈래는 이제 구조화를 거치지 않으므로 recommend 쪽에서 센다.
    expect(replies[1]).toContain('지역: 제주');
    expect(replies[2]).toBe(OTHER_RESPONSE);
    // 세 문구가 실제로 갈리는지 센다. 위 셋만으로는 두 갈래가 같은 문장이
    // 돼도(머리말만 다르고 나머지가 뭉개져도) 통과할 수 있다.
    expect(new Set(replies).size).toBe(3);
  });

  it('갈래별 planStatus와 itinerary가 HTTP를 관통한다', async () => {
    // 일정을 싣지 않은 요청으로 세 갈래를 태운다. plan만 ready이고 나머지 둘은
    // none이다 — 하위 spec이 각각 고정해도 그 합성이 HTTP를 관통하는지는
    // 별개이며, 그 공백에서 두 갈래가 뒤바뀐 전례가 있다.
    const statuses: string[] = [];
    const destinations: (string | undefined)[] = [];

    for (const intent of ['plan_itinerary', 'recommend_places', 'other']) {
      mockGemini(intent, intent === 'other' ? OTHER_RESPONSE : QUERY_RESPONSE);

      const response = await request(app.getHttpServer())
        .post('/chat')
        .send({ message: '제주 2박3일 일정 짜줘' })
        .expect(200);

      const body = response.body as ChatResponseDto;
      statuses.push(body.planStatus);
      destinations.push(body.itinerary?.summary.destination);
    }

    expect(statuses).toEqual(['ready', 'none', 'none']);
    // plan 갈래만 일정을 만든다. 목적지가 실렸는지까지 봐야 빈 일정으로도
    // ready가 통과하는 상태를 막을 수 있다.
    expect(destinations).toEqual(['제주', undefined, undefined]);
  });

  it('plan 갈래는 일정 내용을 채워 돌려준다', async () => {
    // ready인데 days가 비면 프론트는 빈 패널을 띄운다. 그 상태를 200으로
    // 통과시키지 않도록 내용을 센다.
    mockGemini('plan_itinerary', QUERY_RESPONSE);

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '부산 2박3일 일정 짜줘' })
      .expect(200);

    const body = response.body as ChatResponseDto;
    expect(body.planStatus).toBe('ready');
    expect(body.itinerary?.summary.destination).toBe('부산');
    expect(body.itinerary?.days).toHaveLength(3);
    expect(body.itinerary?.days[0].places.length).toBeGreaterThan(0);
  });

  it('plan 갈래는 gemini를 분류 1회만 호출한다', async () => {
    // ↔ 'message가 1000자면 …' 케이스(other 갈래 2회)의 짝이다. 목적지를 원문
    // 키워드로 고르므로 구조화 왕복이 없다 — 결과를 버리는 왕복이 되살아나면
    // 여기가 깨진다.
    mockGemini('plan_itinerary', QUERY_RESPONSE);

    await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 2박3일 일정 짜줘' })
      .expect(200);

    expect(generate).toHaveBeenCalledTimes(1);
  });
```

**(4-3)** `it('질의 구조화에 실패하면 200 + 조건 미지정 요약이 나간다', ...)`의 본문(주석 마지막 줄 다음부터 끝까지)을 아래로 **교체**. 구조화를 거치는 갈래가 `recommend_places` 하나로 좁혀졌다:

```ts
    // 구조화를 거치는 갈래가 recommend_places 하나로 좁혀졌다.
    mockGemini('recommend_places', '[조건]\n지역: 제주');

    const response = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: '제주 관광지 추천', itinerary: createItinerary() })
      .expect(200);

    const { reply } = response.body as ChatResponseDto;
    expect(reply).toBe(
      `${RECOMMEND_REPLY_HEAD} — ${NO_CONDITIONS_SUMMARY}. ${RECOMMEND_REPLY_TAIL}`,
    );
    expect(reply).not.toContain('제주 관광지 추천');
  });
```

> `message가 1000자면 200이고 gemini를 호출한다`(`:350-361`)의 `toHaveBeenCalledTimes(2)`는 **고치지 않는다.** other 갈래이고 왕복 수가 그대로다. 위 `plan 갈래는 gemini를 분류 1회만 호출한다`가 그 짝이 된다.

- [ ] **Step 5: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
```

Expected: PASS — **441 passed / 25 suites**(실측). 서비스 +5, 컨트롤러 +3.

**검출력 확인 — 이번 태스크의 핵심이다.** `chat()`의 `case 'plan_itinerary'`와 `case 'recommend_places'`의 **핸들러 호출을 서로 바꾼다**(`return this.replyRecommend(request)` / `return this.replyPlan(request)`). 과거에 정확히 이 형태의 stray 변경이 미커밋 상태로 있었고 **당시에는 분기별 응답이 없어 전 스위트가 초록불이었다.** 이제는 `↔ 짝: recommend_places는 같은 요청에서 none이다`를 포함해 여러 건이 red가 되는 것을 확인하고 원복한다. `git diff --stat`으로 원복을 증명한다.

- [ ] **Step 6: 커밋**

```bash
git add src/chat/chat.service.ts src/chat/chat.service.spec.ts src/chat/chat.controller.spec.ts
git commit -m "feat(backend): plan 갈래를 갈라내 mock 일정을 돌려준다

직전 실행이 두 갈래를 한 case로 묶은 것은 차이가 인자 하나뿐이었기 때문이고,
갈라지면 다시 나눈다고 예고했다. 이번이 그 실행이다 — plan만 일정을 만들고
recommend는 요청의 일정을 통과시킨다.

돌려주는 것은 목적지 키워드로 고른 고정 데이터이고 일정 생성이 아니다.
'일정 자리 채우기'다 — 기간·동반자·조건을 전혀 반영하지 않는다.

plan 갈래는 QueryStructurer를 부르지 않는다. 목적지를 원문 키워드로 고르므로
구조화 결과를 아무도 쓰지 않고, 결과를 버리는 왕복의 쿼터 소진이 돌려줄 수
있었던 요청을 503으로 만든다. 실제 생성기가 붙으면 queryText 소비자와 함께
돌아온다.

'plan만 ready, recommend는 none' 짝이 과거 stray 변경(두 case 핸들러
뒤바뀜)을 잡는 첫 테스트다. 그때는 분기별 응답이 없어 전부 초록불이었다.
갈래별 단정을 controller 레벨에도 뒀다 — 하위 spec 양쪽 반쪽이 각각 있어도
합성이 HTTP를 관통하는 테스트가 없으면 전부 초록인 전례가 있다."
```

---

### Task 6: `query-reply`를 추천 갈래 전용으로 좁힌다

`plan_itinerary`가 `buildStructuredReply`를 더 이상 부르지 않으므로 `isPlan` 분기 2개가 도달 불가가 되고, spec 3건이 죽은 경로에 초록불을 준다. `PLAN_REPLY_TAIL`은 일정을 실제로 돌려준 뒤 거짓 문장이기도 하다.

> **미해결 질문 Q1이 이 태스크 전체다.** 사용자가 "문장 틀은 확인된 사항이므로 두라"고 하면 **이 태스크를 삭제한다.** 그 경우 도달 불가 코드 3건이 남고, 그 사실을 `## 리스크`에 옮긴다.

**Files:**
- Modify: `src/chat/query/query-reply.ts`, `src/chat/chat.service.ts`
- Test: `src/chat/query/query-reply.spec.ts`, `src/chat/plan/plan-reply.spec.ts`

**Interfaces:**
- Consumes: Task 5의 `replyRecommend`
- Produces: `buildRecommendReply(query: StructuredQuery): string` (기존 `buildStructuredReply` 대체). `PLAN_REPLY_HEAD`·`PLAN_REPLY_TAIL` 삭제

- [ ] **Step 1: plan 경로가 정말 죽었는지 센다**

```
grep -rn "PLAN_REPLY_HEAD\|PLAN_REPLY_TAIL" src --include=*.ts
```

Expected: 매칭이 `src/chat/query/query-reply.ts`(정의)와 `src/chat/query/query-reply.spec.ts`(테스트)에만 있다. **프로덕션 참조 0건**(실측 확인). 다른 파일이 나오면 그 소비자를 먼저 정리한다.

- [ ] **Step 2: 실패하는 테스트 작성 — `query-reply.spec.ts` 전문 교체**

`src/chat/query/query-reply.spec.ts`를 **아래 전문으로 교체한다**:

```ts
// 순수 spec이다. query-reply → query-prompt → dto/itinerary.dto 경로로
// class-validator 데코레이터가 평가되므로 폴리필을 직접 들여온다
// (query-prompt.spec.ts와 같은 이유).
import 'reflect-metadata';

import {
  buildRecommendReply,
  NO_CONDITIONS_SUMMARY,
  RECOMMEND_REPLY_HEAD,
} from './query-reply';
import type { QueryConditions, StructuredQuery } from './structured-query';
import { EMPTY_CONDITIONS, QUERY_LABELS } from './structured-query';

/**
 * 이 문구가 유일하게 하는 일은 "구조화가 무엇을 뽑았는지"를 사람 눈에 보여주는
 * 것이다. queryText는 이번 실행에서 아무도 소비하지 않으므로, 이 파일과
 * query-prompt.spec.ts가 산출물의 유일한 방어선이다.
 *
 * plan_itinerary 문장 틀은 여기 없다 — 그 갈래는 일정을 실제로 돌려주고
 * plan/plan-reply.spec.ts가 그 문구를 고정한다. 두 갈래 문구가 서로 다르다는
 * 짝도 그쪽으로 옮겼다.
 */

function createQuery(
  conditions: Partial<QueryConditions> = {},
  fellBackToRawMessage = false,
): StructuredQuery {
  return {
    queryText: '무엇을 하는 곳: 산책',
    conditions: { ...EMPTY_CONDITIONS, ...conditions },
    droppedLabels: [],
    fellBackToRawMessage,
  };
}

describe('buildRecommendReply — 문장 틀', () => {
  it('추천 문장 틀로 시작하고 끝난다', () => {
    const reply = buildRecommendReply(
      createQuery({ region: '부산', category: '관광지' }),
    );

    expect(reply).toBe(
      '장소 추천 요청으로 이해했어요 — 지역: 부산 · 분류: 관광지. 조건에 맞는 장소를 찾는 단계는 다음에 붙습니다.',
    );
  });
});

describe('buildRecommendReply — 조건 요약', () => {
  it('다섯 조건이 고정 순서로 나타난다', () => {
    // 전문 등가 단정이 순서와 구분자를 함께 고정한다. 순서가 바뀌면 이 한 건이 깨진다.
    const reply = buildRecommendReply(
      createQuery({
        region: '제주',
        district: '서귀포시',
        category: '관광지',
        durationDays: 3,
        travelers: '가족',
      }),
    );

    expect(reply).toContain(
      '지역: 제주 · 구역: 서귀포시 · 분류: 관광지 · 기간: 3일 · 동반자: 가족',
    );
  });

  it('null 필드는 요약에 나타나지 않는다', () => {
    const reply = buildRecommendReply(createQuery({ category: '음식점' }));

    expect(reply).toContain('분류: 음식점');
    expect(reply).not.toContain('지역:');
    expect(reply).not.toContain('구역:');
    expect(reply).not.toContain('기간:');
    expect(reply).not.toContain('동반자:');
  });

  it('조건이 전부 null이면 미지정 문구가 나타난다', () => {
    const reply = buildRecommendReply(createQuery());

    expect(reply).toBe(
      `${RECOMMEND_REPLY_HEAD} — ${NO_CONDITIONS_SUMMARY}. 조건에 맞는 장소를 찾는 단계는 다음에 붙습니다.`,
    );
  });

  it('색인 라벨이 하나도 나타나지 않는다', () => {
    // 내부 포맷 노출 방어. 7개 라벨이 화면에 나가면 그 포맷이 UI 계약이 되고,
    // core 라벨을 따라 바꾸는 것이 프론트 변경을 요구하게 된다.
    const reply = buildRecommendReply(
      createQuery({ region: '제주', travelers: '가족', durationDays: 2 }),
    );

    for (const label of QUERY_LABELS) {
      expect(reply).not.toContain(label);
    }
  });
});

describe('buildRecommendReply — 폴백을 문구에 싣지 않는다', () => {
  it('fellBackToRawMessage가 true여도 false와 결과가 같다', () => {
    // 폴백의 관측 수단은 warn 로그 하나다. 문구에 실으면 내부 판정이 UI로 새고,
    // 사용자는 자기가 뭘 잘못했는지 알 수 없는 문장을 받는다.
    const conditions = { region: '제주' };

    expect(buildRecommendReply(createQuery(conditions, true))).toBe(
      buildRecommendReply(createQuery(conditions)),
    );
  });

  it('↔ 짝: 조건이 다르면 폴백 여부와 무관하게 결과가 다르다', () => {
    // 위 단정이 "항상 같은 문자열을 낸다"는 구현으로도 통과하지 않게 한다.
    expect(buildRecommendReply(createQuery({ region: '제주' }, true))).not.toBe(
      buildRecommendReply(createQuery({ region: '부산' }, true)),
    );
  });
});
```

> 삭제한 2건과 그 대체를 명시한다. `plan_itinerary는 일정 문장 틀로 시작하고 끝난다`(구 `:44-53`)는 **경로가 사라지므로 대체 없이 삭제**한다. `plan_itinerary와 recommend_places의 결과가 서로 다르다`(구 `:34-42`)와 `↔ 짝: 갈래가 다르면 …`(구 `:132-137`)의 갈래 대조는 **Step 4에서 `plan-reply.spec.ts`로 옮긴다** — 두 갈래 문구가 이제 다른 모듈에 있기 때문이다. 폴백 `↔ 짝`은 "조건이 다르면 결과가 다르다"로 목적(항상 같은 문자열을 내는 구현을 배제)을 유지한다.

- [ ] **Step 3: 실패를 확인**

```
npm test -- query-reply
```

Expected: FAIL — **7 failed, 7 total**(실측). 전부 같은 메시지다:

```
TypeError: (0 , query_reply_1.buildRecommendReply) is not a function
```

- [ ] **Step 4: 구현**

**(4-1)** `src/chat/query/query-reply.ts:4-14`(파일 doc + 상수 5개)를 아래로 **교체**:

```ts
/**
 * 장소 추천 갈래의 잠정 문구. 실제 검색이 붙으면 이 파일이 사라진다.
 *
 * plan_itinerary의 문구였던 PLAN_REPLY_HEAD·PLAN_REPLY_TAIL은 여기 없다 —
 * 그 갈래는 이제 일정을 실제로 돌려주므로 '장소를 찾아 일정을 짜는 단계는
 * 다음에 붙습니다.'가 거짓 문장이 된다. 대체 문구는 plan/plan-reply.ts에 있다.
 *
 * 이 머리말은 plan 갈래의 문구·OTHER_REPLY와 서로 달라야 한다 — 경로 스모크가
 * "세 갈래가 갈린다"를 판정하는 근거다.
 */
export const RECOMMEND_REPLY_HEAD = '장소 추천 요청으로 이해했어요';
export const RECOMMEND_REPLY_TAIL =
  '조건에 맞는 장소를 찾는 단계는 다음에 붙습니다.';
export const NO_CONDITIONS_SUMMARY = '조건: 미지정';
```

**(4-2)** 같은 파일의 `buildStructuredReply` 전체(doc 포함, 구 `:57-75`)를 아래로 **교체**:

```ts
/**
 * 구조화 결과를 사용자에게 되비출 한 문장을 만든다.
 *
 * intent 파라미터가 없다 — 소비자가 recommend_places 갈래 하나뿐이다. 갈래를
 * 받는 시그니처를 남기면 도달 불가능한 분기가 생기고, 그 분기를 검증하는
 * 테스트가 초록불을 주면서 아무것도 지키지 않는다.
 *
 * 모델의 자유 텍스트를 싣지 않는다 — 검증을 통과한 조건 값만 우리 문장 틀에
 * 끼운다. 의미 축 텍스트(QUERY_LABELS 7줄)는 절대 노출하지 않는다.
 *
 * fellBackToRawMessage는 문구에 나타나지 않는다 — 폴백의 관측 수단은 warn
 * 로그다(직전 실행이 intent 폴백에 대해 정한 것과 같은 경계).
 */
export function buildRecommendReply(query: StructuredQuery): string {
  const summary = buildConditionSummary(query.conditions);

  return `${RECOMMEND_REPLY_HEAD} — ${summary}. ${RECOMMEND_REPLY_TAIL}`;
}
```

**(4-3)** `src/chat/chat.service.ts`의 import 한 줄을 **교체**:

```ts
import { buildRecommendReply } from './query/query-reply';
```

**(4-4)** 같은 파일 `replyRecommend`의 `return` 블록을 아래 **한 줄로 교체**:

```ts
    return buildChatResponse(buildRecommendReply(query), request.itinerary);
```

- [ ] **Step 5: 옮겨 온 갈래 대조 짝을 `plan-reply.spec.ts`에 더한다**

`src/chat/plan/plan-reply.spec.ts` 맨 위 import 블록을 아래로 **교체**:

```ts
// buildRecommendReply를 대조하므로 query-reply → query-prompt → dto/itinerary.dto
// 경로로 class-validator 데코레이터가 평가된다. 폴리필을 직접 들여온다
// (query-reply.spec.ts와 같은 이유).
import 'reflect-metadata';

import { buildRecommendReply } from '../query/query-reply';
import { EMPTY_CONDITIONS } from '../query/structured-query';
import { buildMockItinerary } from './mock-itineraries';
import { buildPlanReply, PLAN_READY_GUIDE } from './plan-reply';
```

같은 파일의 마지막 `it('화면 배치를 문구에 담지 않는다', ...)` **뒤에** 추가:

```ts

  it('↔ 짝: 추천 갈래의 문구와 겹치지 않는다', () => {
    // 두 문장 틀이 같아지면 switch의 arm을 바꿔도 경로 스모크가 못 잡는다.
    // 이 짝은 query-reply.spec.ts에 있던 갈래 대조를 대체한다 —
    // 두 갈래의 문구가 이제 서로 다른 모듈에 있으므로 여기서 잇는다.
    const recommend = buildRecommendReply({
      queryText: '무엇을 하는 곳: 일출 감상',
      conditions: { ...EMPTY_CONDITIONS, region: '제주' },
      droppedLabels: [],
      fellBackToRawMessage: false,
    });

    expect(buildPlanReply(buildMockItinerary('제주'))).not.toBe(recommend);
  });
```

- [ ] **Step 6: 통과를 확인**

```
npm test
npx tsc --noEmit -p tsconfig.json
npx eslint src --max-warnings=0
npm run build
npm run test:e2e
```

Expected: PASS — **440 passed / 25 suites**(실측). Task 5 대비 `query-reply.spec`이 9→7로 2건 줄고 `plan-reply.spec`이 3→4로 1건 늘어 순 −1이다. `npm run build` 성공, `npm run test:e2e` **6 passed / 2 suites (변화 없음)**.

**검출력 확인:** `RECOMMEND_REPLY_HEAD`를 `'일정 요청으로 이해했어요'`(삭제한 plan 머리말)로 임시 변경하면 `↔ 짝: 추천 갈래의 문구와 겹치지 않는다`가 red가 되지 않는지 본다 — plan 문구는 완전히 다른 틀이므로 여전히 통과해야 하고, 대신 `추천 문장 틀로 시작하고 끝난다`가 red가 된다. 원복 후 `git diff --stat`을 확인한다.

- [ ] **Step 7: 커밋**

```bash
git add src/chat/query/query-reply.ts src/chat/query/query-reply.spec.ts src/chat/chat.service.ts src/chat/plan/plan-reply.spec.ts
git commit -m "refactor(backend): query-reply를 추천 갈래 전용으로 좁힌다

plan_itinerary가 더 이상 이 함수를 부르지 않으므로 isPlan 분기 2개가 도달
불가가 되고, spec 3건이 죽은 경로에 초록불을 준다 — 커버된 것처럼 보이는
죽은 코드가 그냥 죽은 코드보다 나쁘다.

PLAN_REPLY_TAIL('장소를 찾아 일정을 짜는 단계는 다음에 붙습니다.')은 일정을
실제로 돌려준 뒤에는 거짓 문장이다. 저장소에 남겨 두면 도달 가능해 보이는
거짓 진술이 남는다.

갈래가 다르면 문구도 다르다는 짝은 plan/plan-reply.spec.ts로 옮겼다.
두 갈래의 문구가 이제 서로 다른 모듈에 있으므로 그쪽에서 이어야 한다."
```

---

## 리뷰 묶음

| 묶음 | 태스크 | 논리 단위 |
|---|---|---|
| A | 1~2 | **응답·요청 계약** — `planStatus` 유니온, 판별 유니온, 응답 팩토리, `itinerary` optional |
| B | 3~6 | **plan 갈래 분리** — mock 데이터, 노출 문구, switch 분리, `query-reply` 좁히기 |

묶음을 3+3이 아니라 2+4로 나눈 이유: **묶음 A 하나만으로 프론트가 의존할 계약이 완결된다.** A가 끝나면 `POST /chat`이 `planStatus`를 내고 일정 없는 요청을 받으므로, frontend 작업이 B와 병행될 수 있다. B는 그 계약 위에서 `ready` 상태를 실제로 만드는 작업이라 계약을 바꾸지 않는다.

## 최종 검증

- [ ] `npx tsc --noEmit -p tsconfig.json` 통과
- [ ] `npm test` 전체 통과 — **440 passed / 25 suites** (기준선 409/22 → 테스트 +31, 스위트 +3). 태스크별 실측 누계: T1 **414/23** · T2 **415/23** · T3 **430/24** · T4 **433/25** · T5 **441/25** · T6 **440/25**
- [ ] `npx eslint src --max-warnings=0` 통과
- [ ] `npm run build` 성공
- [ ] `npm run test:e2e` 통과 — **6 passed / 2 suites, 변화 없음**. e2e는 `POST /chat`을 타지 않는다(`test/external-service.e2e-spec.ts:22-23`)
- [ ] `src/chat/chat.module.ts`가 **변경되지 않았다** (`git diff --stat`에 나타나지 않아야 한다)
- [ ] `src/chat/chat.service.ts`에 `try`·`catch`가 **하나도 없다**
- [ ] **응답 객체 리터럴이 `buildChatResponse` 안의 두 개뿐이다** — `grep -rn "planStatus:" src --include=*.ts | grep -v spec`이 `dto/chat-response.dto.ts`의 2줄만 내야 한다. 다른 파일이 나오면 불변식이 다시 여러 곳에서 세워지고 있다
- [ ] **`planStatus: 'ready'` + `itinerary: null` 조합을 만들 수 없다 — 단 방어가 두 겹이고 타입은 그중 한 겹뿐이다.** (1) `buildChatResponse`의 삼항 한쪽을 반대 값으로 바꿔 보면 컴파일 에러가 난다(판별 유니온이 막는다 — 결정 2·3이 작동하는 증거). (2) **타입이 막지 못하는 경로가 하나 있다:** 런타임 `null`이 슬롯을 통과하는 경우다. `curl`/supertest로 `{"message":"안녕","itinerary":null}`을 보내 응답이 `{"planStatus":"none","itinerary":null}`인지 **실제로 확인한다.** `"ready"`가 나오면 결정 4a의 결함이 되살아난 것이다
- [ ] **`grep -n "itinerary ?? null" src/chat/dto/chat-response.dto.ts`가 1건이다** — `=== undefined` 판정으로 되돌아가지 않았는지 센다. 이 한 줄이 위 (2)의 유일한 방어다
- [ ] `PLAN_REPLY_HEAD`·`PLAN_REPLY_TAIL`·`buildStructuredReply`가 저장소에서 **완전히 사라졌다** (`grep -rn` 0건). Task 6을 실행한 경우에만 해당
- [ ] **`fellBackToRawMessage`가 응답 경로에 없다** — `grep -rn "fellBackToRawMessage" src --include=*.ts`가 `structured-query.ts`·`query.structurer.ts`·spec들만 내고 `chat-response.dto.ts`·`chat.service.ts`에는 없다
- [ ] **갈래 × planStatus 표 8행 전부에 짝지은 테스트가 존재한다** — 표의 두 테스트 열을 실제 테스트 제목과 하나씩 대조한다. 3·5행(둘 다 `none`)은 planStatus 축에서 구분 테스트를 두지 않는 것이 **판정**이며 그 근거가 표 아래 2번 항목에 있다
- [ ] **에러 처리 표 14행 전부에 짝지은 테스트가 존재한다** — 행 수와 테스트 수를 센다. 일부 행만 세지 않는다
- [ ] `src/chat/plan/mock-itineraries.ts`의 일정 3개가 `frontend/src/lib/mock/itineraries.ts:4-292`와 **값이 같다** — 따옴표·줄바꿈 외 차이가 없다
- [ ] `frontend/` 파일이 **하나도 변경되지 않았다** — 이 계획은 backend만 바꾼다. 워크스페이스별로 커밋을 나눈다
- [ ] 미추적 `.ignore` 3개가 **커밋되지 않았다** (`git log --stat`에 나타나지 않아야 한다)

## 사용자 확인 필요 (에이전트가 실행할 수 없는 검증)

에이전트는 실제 Gemini 자격증명으로 호출할 수 없고 브라우저를 조작할 수 없다. **체크박스를 두지 않는다.**

- **첫 턴 요청이 일정 없이 200을 받는다** — 절차: `.env`에 유효한 `GEMINI_API_KEY`를 두고 `npm run start:dev` 후 `POST /chat`에 `{"message": "안녕하세요"}`(일정 필드 없음)를 보낸다. 통과 조건: 200이고 본문이 `{"reply": "...", "planStatus": "none", "itinerary": null}`이다. `itinerary` 키가 **응답에 존재하고 값이 `null`**이어야 한다 — 키가 아예 없으면 프론트의 판별 유니온이 읽을 수 없다.

- **명시적 `null`도 같은 결과다** — 절차: 같은 방식으로 `{"message": "안녕하세요", "itinerary": null}`. 통과 조건: 위와 **완전히 같은 모양**이다(`planStatus: "none"`). `"ready"`가 나오면 결정 4a가 고친 결함이 되살아난 것이며 **프론트가 빈 패널을 띄운다.** 단위 테스트 2건이 이 경로를 덮지만, 실제 `ValidationPipe` 설정에서 재현하는 것은 여기서만 확인된다.

- **`plan_itinerary`가 일정과 새 문구를 함께 낸다** — 절차: `{"message": "제주 2박3일 일정 짜줘"}`. 통과 조건: `planStatus`가 `"ready"`, `itinerary.summary.destination`이 `"제주"`, `itinerary.days`가 3개, `reply`가 `제주 2박 3일 일정을 준비했어요! Day별 코스를 확인해보세요.`다. 서버 로그에 `질의 구조화` 관련 호출이 **없어야 한다**(이 갈래는 Gemini를 분류 1회만 부른다).

- **`recommend_places`·`other`가 요청 일정을 통과시킨다** — 절차: 위 응답의 `itinerary`를 그대로 실어 `{"message": "부산 맛집 추천해줘", "itinerary": {…제주 일정…}}`을 보낸다. 통과 조건: `planStatus`가 `"ready"`이고 `itinerary`가 **보낸 것과 동일**하다(제주 일정이 그대로 돌아온다 — 부산 일정으로 바뀌지 **않는다**). 이어서 `{"message": "고마워", "itinerary": {…}}`도 같은 결과여야 한다. 이 두 건이 결정 12(미해결 질문 Q3)가 의도한 동작인지 사용자가 판단한다.

- **mock 일정이 실제 생성으로 오인될 여지를 사용자가 인지한다** — 절차: `{"message": "제주 5박6일 혼자 갈 거야 일정 짜줘"}`. 통과 조건: 응답 일정이 여전히 `2박 3일 · 성인 2명`이고 장소가 위 요청과 동일하다. **이것이 정상 동작이다.** 기간·동반자를 반영하지 않는다는 사실을 사용자가 확인해야 한다 — 반영될 것으로 기대하면 이 단계가 완료로 오인된다.

- **목적지를 못 알아들으면 서울 일정이 나간다** — 절차: `{"message": "여행 일정 짜줘"}`(목적지 없음). 통과 조건: `planStatus`가 `"ready"`이고 `itinerary.summary.destination`이 `"서울"`이다. 미해결 질문 Q4가 이 동작에 대한 것이다.

- **프론트엔드가 아직 이 응답을 소비하지 못한다** — 절차: `frontend`를 현재 상태로 띄우고 채팅을 보낸다. 통과 조건: **패널 동작이 변하지 않는다**(mock 초기 일정이 그대로 뜬다). `frontend/src/lib/api/itinerary.ts:68`이 `as ScenarioResult` 캐스트라 새 필드가 조용히 무시되기 때문이며, 이 상태는 **정상이고 frontend 계획이 처리한다.** 프론트가 깨지면(에러 말풍선·빈 화면) 그건 예상 밖이므로 보고한다.
