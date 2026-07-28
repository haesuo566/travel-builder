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

  it("ValidationPipe 400의 message 배열은 사용자에게 보여주지 않고 입력 안내로 바꾼다", async () => {
    stubFetch(
      jsonResponse(400, {
        statusCode: 400,
        message: ["message must be shorter than or equal to 1000 characters"],
        error: "Bad Request",
      })
    );

    await expect(sendMessage("긴 메시지", getDefaultItinerary())).rejects.toThrow(
      "입력을 확인해주세요. 메시지가 너무 길거나 형식이 올바르지 않습니다."
    );
  });

  it("ExternalServiceFilter 5xx의 message 문자열은 그대로 사용자에게 전달한다", async () => {
    stubFetch(
      jsonResponse(503, {
        statusCode: 503,
        error: "quota",
        message: "외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요.",
      })
    );

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      "외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요."
    );
  });

  it("에러 응답이 JSON이 아니면 폴백 문구로 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("<html>502 Bad Gateway</html>", { status: 502 })
      )
    );

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."
    );
  });

  it("fetch 자체가 실패하면(CORS·네트워크 단절) 폴백 문구로 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"))
    );

    await expect(sendMessage("제주", getDefaultItinerary())).rejects.toThrow(
      "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요."
    );
  });
});
