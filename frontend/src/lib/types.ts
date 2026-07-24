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
