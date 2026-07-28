import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultItinerary } from "../mock/itineraries";
import { sendMessage } from "./itinerary";

const BASE_URL = "http://localhost:3001";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sendMessage", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", BASE_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("메시지와 현재 일정을 POST /chat 본문에 함께 싣는다", async () => {
    const current = getDefaultItinerary();
    const fetchMock = stubFetch(
      jsonResponse(200, { reply: "네", itinerary: current })
    );

    await sendMessage("제주 2박3일", current);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3001/chat");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      message: "제주 2박3일",
      itinerary: current,
    });
  });

  it("200 응답의 reply와 itinerary를 그대로 돌려준다", async () => {
    const current = getDefaultItinerary();
    const next = { ...current, summary: { ...current.summary, destination: "제주" } };
    stubFetch(jsonResponse(200, { reply: "제주 일정이에요", itinerary: next }));

    const result = await sendMessage("제주", current);

    expect(result.reply).toBe("제주 일정이에요");
    expect(result.itinerary).toEqual(next);
  });

  it("NEXT_PUBLIC_API_BASE_URL이 없으면 fetch를 부르지 않고 던진다", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", undefined);
    const fetchMock = stubFetch(jsonResponse(200, { reply: "네", itinerary: null }));

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      /NEXT_PUBLIC_API_BASE_URL/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("200이 아니면 응답 본문을 결과로 쓰지 않고 던진다", async () => {
    stubFetch(jsonResponse(500, { reply: "이건 쓰이면 안 된다", itinerary: null }));

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(Error);
  });
});
