import { describe, expect, it } from "vitest";
import { hasItinerary, resolveMobileTab } from "./plan-view";
import type { Itinerary } from "./types";

const JEJU_ITINERARY: Itinerary = {
  summary: { destination: "제주", duration: "2박 3일", travelers: "성인 2명" },
  days: [{ day: 1, places: [] }],
};

describe("resolveMobileTab", () => {
  it("ready면 itinerary 탭이다", () => {
    expect(resolveMobileTab("ready")).toBe("itinerary");
  });

  it("↔ 짝: none이면 chat 탭이다", () => {
    expect(resolveMobileTab("none")).toBe("chat");
  });
});

describe("hasItinerary", () => {
  it("일정이 있으면 true다", () => {
    expect(hasItinerary(JEJU_ITINERARY)).toBe(true);
  });

  it("↔ 짝: null이면 false다", () => {
    expect(hasItinerary(null)).toBe(false);
  });
});
