export type PlaceCategory = "관광지" | "음식점" | "숙박";

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  time: string;
  description: string;
  pinNumber: number;
}

export interface ItineraryDay {
  day: number;
  places: Place[];
}

export interface TripInfo {
  destination: string;
  duration: string;
  travelers: string;
}

export interface Itinerary {
  summary: TripInfo;
  days: ItineraryDay[];
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

export type PlanStatus = "none" | "ready";

/**
 * POST /chat 응답. planStatus === "ready" ⟺ itinerary가 존재한다는 불변식을
 * 독립 필드 대신 판별 유니온으로 표현한다 — { planStatus: "ready", itinerary: null }
 * 조합이 타입 수준에서 만들어지지 않는다(backend chat-response.dto.ts와 같은 형태).
 */
export type ChatResponse =
  | { reply: string; planStatus: "none"; itinerary: null }
  | { reply: string; planStatus: "ready"; itinerary: Itinerary };
