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
