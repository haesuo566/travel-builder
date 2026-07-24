import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("axios", () => ({
  default: { get: getMock },
}));

import { TourApiClient } from "../../src/clients/tourApi.js";

function envelope(items: unknown, resultCode = "0000", resultMsg = "OK", totalCount = 0) {
  return {
    data: {
      response: {
        header: { resultCode, resultMsg },
        body: { items, numOfRows: 10, pageNo: 1, totalCount },
      },
    },
  };
}

beforeEach(() => {
  getMock.mockReset();
  process.env.TOUR_API_SERVICE_KEY = "abc%2Bdef%3D";
  delete process.env.TOUR_API_BASE_URL;
});

afterEach(() => {
  delete process.env.TOUR_API_SERVICE_KEY;
  delete process.env.TOUR_API_BASE_URL;
});

describe("TourApiClient", () => {
  it("TOUR_API_SERVICE_KEY 없으면 생성자에서 throw", () => {
    delete process.env.TOUR_API_SERVICE_KEY;
    expect(() => new TourApiClient()).toThrow("TOUR_API_SERVICE_KEY");
  });

  it("getAreaBasedList가 기본 numOfRows/pageNo로 요청하고 서비스키를 재인코딩하지 않는다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await client.getAreaBasedList();
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("https://apis.data.go.kr/B551011/KorService2/areaBasedList2?");
    expect(url).toContain("serviceKey=abc%2Bdef%3D");
    expect(url).toContain("MobileOS=ETC");
    expect(url).toContain("MobileApp=travel-builder");
    expect(url).toContain("_type=json");
    expect(url).toContain("numOfRows=10");
    expect(url).toContain("pageNo=1");
  });

  it("동적 파라미터는 encodeURIComponent로 인코딩된다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await client.getAreaBasedList({ arrange: "A&B" });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain(`arrange=${encodeURIComponent("A&B")}`);
  });

  it("numOfRows/pageNo를 옵션으로 덮어쓸 수 있다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await client.getAreaBasedList({ numOfRows: 50, pageNo: 3 });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("numOfRows=50");
    expect(url).toContain("pageNo=3");
  });

  it("undefined인 선택 파라미터는 쿼리에서 생략된다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await client.getAreaBasedList();
    const url = getMock.mock.calls[0][0] as string;
    expect(url).not.toContain("areaCode=");
  });

  it("items가 빈 문자열이면 빈 배열을 반환한다 (0건)", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    const result = await client.getAreaBasedList();
    expect(result).toEqual([]);
  });

  it("items.item이 단일 객체면 배열로 정규화한다 (1건)", async () => {
    const single = { contentid: "1", title: "단일 관광지" };
    getMock.mockResolvedValue(envelope({ item: single }));
    const client = new TourApiClient();
    const result = await client.getAreaBasedList();
    expect(result).toEqual([single]);
  });

  it("items.item이 배열이면 그대로 반환한다 (N건)", async () => {
    const many = [{ contentid: "1" }, { contentid: "2" }];
    getMock.mockResolvedValue(envelope({ item: many }));
    const client = new TourApiClient();
    const result = await client.getAreaBasedList();
    expect(result).toEqual(many);
  });

  it("resultCode가 0000이 아니면 resultMsg를 포함해 throw한다", async () => {
    getMock.mockResolvedValue(envelope("", "3000", "잘못된 요청 파라미터입니다"));
    const client = new TourApiClient();
    await expect(client.getAreaBasedList()).rejects.toThrow("잘못된 요청 파라미터입니다");
  });

  it("getDetailCommon이 단일 객체를 반환한다", async () => {
    const detail = { contentid: "1", title: "상세", overview: "설명" };
    getMock.mockResolvedValue(envelope({ item: detail }));
    const client = new TourApiClient();
    const result = await client.getDetailCommon("1");
    expect(result).toEqual(detail);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("detailCommon2?");
    expect(url).toContain("contentId=1");
  });

  it("getDetailCommon이 결과 없으면 throw한다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await expect(client.getDetailCommon("999")).rejects.toThrow("999");
  });

  it("getDetailIntro가 Record<string,string>를 그대로 반환한다", async () => {
    const intro = { contentid: "1", checkintime: "15:00", checkouttime: "11:00" };
    getMock.mockResolvedValue(envelope({ item: intro }));
    const client = new TourApiClient();
    const result = await client.getDetailIntro("1", "32");
    expect(result).toEqual(intro);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("detailIntro2?");
    expect(url).toContain("contentTypeId=32");
  });

  it("getDetailIntro가 결과 없으면 throw한다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    await expect(client.getDetailIntro("999", "32")).rejects.toThrow("999");
  });

  it("getDetailImages가 이미지가 없으면 빈 배열을 반환한다", async () => {
    getMock.mockResolvedValue(envelope(""));
    const client = new TourApiClient();
    const result = await client.getDetailImages("1");
    expect(result).toEqual([]);
  });

  it("getDetailImages가 여러 이미지를 배열로 반환한다", async () => {
    const images = [
      { contentid: "1", imgname: "a.jpg" },
      { contentid: "1", imgname: "b.jpg" },
    ];
    getMock.mockResolvedValue(envelope({ item: images }));
    const client = new TourApiClient();
    const result = await client.getDetailImages("1");
    expect(result).toEqual(images);
  });

  it("getLclsSystmTree가 lclsSystmListYn=Y로 요청하고 전체 트리를 반환한다 (단일 페이지)", async () => {
    const items = [
      {
        lclsSystm1Cd: "AC",
        lclsSystm1Nm: "숙박",
        lclsSystm2Cd: "AC01",
        lclsSystm2Nm: "호텔",
        lclsSystm3Cd: "AC010100",
        lclsSystm3Nm: "호텔",
      },
    ];
    getMock.mockResolvedValue(envelope({ item: items }, "0000", "OK", items.length));
    const client = new TourApiClient();
    const result = await client.getLclsSystmTree();
    expect(result).toEqual(items);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain("lclsSystmCode2?");
    expect(url).toContain("lclsSystmListYn=Y");
    expect(url).toContain("numOfRows=1000");
    expect(url).toContain("pageNo=1");
  });

  it("getLclsSystmTree가 totalCount보다 적게 받으면 다음 페이지를 이어서 요청한다", async () => {
    const page1 = [
      {
        lclsSystm1Cd: "AC",
        lclsSystm1Nm: "숙박",
        lclsSystm2Cd: "AC01",
        lclsSystm2Nm: "호텔",
        lclsSystm3Cd: "AC010100",
        lclsSystm3Nm: "호텔",
      },
    ];
    const page2 = [
      {
        lclsSystm1Cd: "FD",
        lclsSystm1Nm: "음식",
        lclsSystm2Cd: "FD01",
        lclsSystm2Nm: "한식",
        lclsSystm3Cd: "FD010100",
        lclsSystm3Nm: "한식",
      },
    ];
    getMock
      .mockResolvedValueOnce(envelope({ item: page1 }, "0000", "OK", 2))
      .mockResolvedValueOnce(envelope({ item: page2 }, "0000", "OK", 2));
    const client = new TourApiClient();
    const result = await client.getLclsSystmTree();
    expect(result).toEqual([...page1, ...page2]);
    expect(getMock).toHaveBeenCalledTimes(2);
    const secondUrl = getMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain("pageNo=2");
  });
});
