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
