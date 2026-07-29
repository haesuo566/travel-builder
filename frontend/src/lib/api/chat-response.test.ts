import { describe, expect, it } from "vitest";
import { INVALID_RESPONSE_MESSAGE, parseChatResponse } from "./chat-response";
import type { Itinerary } from "../types";

const JEJU_ITINERARY: Itinerary = {
  summary: { destination: "제주", duration: "2박 3일", travelers: "성인 2명" },
  days: [
    { day: 1, places: [] },
    { day: 2, places: [] },
    { day: 3, places: [] },
  ],
};

describe("parseChatResponse", () => {
  it("planStatus가 ready면 일정을 그대로 반환한다", () => {
    const result = parseChatResponse({
      reply: "제주 2박 3일 일정을 준비했어요! Day별 코스를 확인해보세요.",
      planStatus: "ready",
      itinerary: JEJU_ITINERARY,
    });

    expect(result.planStatus).toBe("ready");
    expect(result.itinerary?.summary.destination).toBe("제주");
    expect(result.itinerary?.days).toHaveLength(3);
  });

  it("↔ 짝: planStatus가 none이면 itinerary가 null이다", () => {
    const result = parseChatResponse({
      reply: "어느 지역으로 떠나고 싶으신가요?",
      planStatus: "none",
      itinerary: null,
    });

    expect(result.planStatus).toBe("none");
    expect(result.itinerary).toBeNull();
  });

  it("itinerary 키가 없으면 null로 정규화한다", () => {
    const result = parseChatResponse({
      reply: "어느 지역으로 떠나고 싶으신가요?",
      planStatus: "none",
    });

    expect(result.itinerary).toBeNull();
  });

  it("ready인데 days가 비어 있으면 던진다", () => {
    expect(() =>
      parseChatResponse({
        reply: "제주 일정을 준비했어요!",
        planStatus: "ready",
        itinerary: { summary: JEJU_ITINERARY.summary, days: [] },
      })
    ).toThrow(INVALID_RESPONSE_MESSAGE);
  });

  it("planStatus 필드가 없으면 던진다 — as 캐스트 회귀를 잡는 테스트", () => {
    expect(() =>
      parseChatResponse({ reply: "안녕하세요", itinerary: null })
    ).toThrow(INVALID_RESPONSE_MESSAGE);
  });

  it("planStatus가 유니온 밖 값이면 던진다", () => {
    expect(() =>
      parseChatResponse({
        reply: "안녕하세요",
        planStatus: "drafting",
        itinerary: null,
      })
    ).toThrow(INVALID_RESPONSE_MESSAGE);
  });

  it("ready인데 itinerary가 null이면 던진다", () => {
    expect(() =>
      parseChatResponse({
        reply: "제주 일정을 준비했어요!",
        planStatus: "ready",
        itinerary: null,
      })
    ).toThrow(INVALID_RESPONSE_MESSAGE);
  });

  it("↔ 짝: none인데 itinerary가 있으면 던진다", () => {
    expect(() =>
      parseChatResponse({
        reply: "안녕하세요",
        planStatus: "none",
        itinerary: JEJU_ITINERARY,
      })
    ).toThrow(INVALID_RESPONSE_MESSAGE);
  });

  it("본문이 null이면 던진다", () => {
    expect(() => parseChatResponse(null)).toThrow(INVALID_RESPONSE_MESSAGE);
  });

  it("본문이 배열이면 던진다", () => {
    expect(() => parseChatResponse([])).toThrow(INVALID_RESPONSE_MESSAGE);
  });

  it("본문이 문자열이면 던진다", () => {
    expect(() => parseChatResponse("안녕")).toThrow(INVALID_RESPONSE_MESSAGE);
  });
});
