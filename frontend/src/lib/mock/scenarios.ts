import type { Itinerary } from "../types";
import { findDestinationKeyForMessage, getItineraryByDestinationKey } from "./itineraries";

export interface ScenarioResult {
  reply: string;
  itinerary: Itinerary;
}

export function generateAssistantReply(
  message: string,
  currentItinerary: Itinerary
): ScenarioResult {
  const destinationKey = findDestinationKeyForMessage(message);

  if (destinationKey) {
    const itinerary = getItineraryByDestinationKey(destinationKey);
    return {
      reply: `${itinerary.summary.destination} ${itinerary.summary.duration} 일정을 준비했어요! 오른쪽에서 Day별 코스를 확인해보세요.`,
      itinerary,
    };
  }

  if (message.includes("맛집")) {
    return {
      reply:
        "맛집 위주로 코스를 다시 짜봤어요. Day별 음식점 카드를 확인해보세요. 특정 지역을 알려주시면 더 정확하게 추천해드릴게요.",
      itinerary: currentItinerary,
    };
  }

  if (message.includes("가족")) {
    return {
      reply:
        "가족 여행에 어울리도록 이동 동선을 여유롭게 구성했어요. 아이와 함께라면 오전 일정을 조금 늦게 시작하는 것도 추천해요.",
      itinerary: currentItinerary,
    };
  }

  return {
    reply:
      "어디로 떠나고 싶으신가요? '제주 2박3일'처럼 목적지와 기간을 말씀해주시면 바로 일정을 만들어드릴게요.",
    itinerary: currentItinerary,
  };
}
