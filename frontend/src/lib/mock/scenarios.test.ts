import { describe, expect, it } from "vitest";
import { generateAssistantReply } from "./scenarios";
import { getDefaultItinerary, getItineraryByDestinationKey } from "./itineraries";

describe("generateAssistantReply", () => {
  it("제주 키워드가 있으면 제주 일정으로 전환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("제주 2박3일로 가고 싶어", current);

    expect(result.itinerary).toEqual(getItineraryByDestinationKey("jeju"));
    expect(result.reply).toContain("제주");
  });

  it("부산 키워드가 있으면 부산 일정으로 전환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("부산으로 여행가고 싶어요", current);

    expect(result.itinerary).toEqual(getItineraryByDestinationKey("busan"));
    expect(result.reply).toContain("부산");
  });

  it("맛집 키워드가 있으면 기존 일정을 유지하고 맛집 관련 답변을 반환한다", () => {
    const current = getItineraryByDestinationKey("busan");
    const result = generateAssistantReply("맛집 위주로 알려줘", current);

    expect(result.itinerary).toEqual(current);
    expect(result.reply).toContain("맛집");
  });

  it("가족 키워드가 있으면 기존 일정을 유지하고 가족 관련 답변을 반환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("가족여행으로 준비해줘", current);

    expect(result.itinerary).toEqual(current);
    expect(result.reply).toContain("가족");
  });

  it("인식할 수 없는 메시지는 기존 일정을 유지하고 되묻는 답변을 반환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("안녕하세요", current);

    expect(result.itinerary).toEqual(current);
    expect(result.reply).toContain("목적지");
  });
});
