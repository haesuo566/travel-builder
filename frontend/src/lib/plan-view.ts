import type { Itinerary, PlanStatus } from "./types";

export type MobileTab = "chat" | "itinerary";

/**
 * itinerary가 null이 아님을 좁혀준다. boolean 반환으로는 page.tsx에서
 * ItineraryPanel의 non-null props로 타입이 좁혀지지 않아 타입 술어로 둔다.
 */
export function hasItinerary(
  itinerary: Itinerary | null
): itinerary is Itinerary {
  return itinerary !== null;
}

/**
 * 응답의 planStatus로 모바일 탭을 정한다. none으로 되돌리지 않으면 일정이
 * 있던 상태에서 none을 받는 순간 탭 바가 사라지고(hasItinerary가 false가
 * 되므로) 채팅 컬럼은 CSS hidden이라 모바일에서 빈 화면이 된다.
 */
export function resolveMobileTab(planStatus: PlanStatus): MobileTab {
  return planStatus === "ready" ? "itinerary" : "chat";
}
