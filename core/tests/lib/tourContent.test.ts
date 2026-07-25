import { describe, it, expect } from "vitest";
import { toTourContentRow } from "../../src/lib/tourContent.js";
import type { TourApiSyncItem } from "../../src/clients/tourApi.js";

function syncItem(overrides: Partial<TourApiSyncItem> = {}): TourApiSyncItem {
  return {
    contentid: "126508",
    contenttypeid: "12",
    title: "경복궁",
    mapx: "126.9769",
    mapy: "37.5796",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    zipcode: "03045",
    lDongRegnCd: "11",
    lDongSignguCd: "110",
    lclsSystm1: "AC",
    lclsSystm2: "AC01",
    lclsSystm3: "AC010100",
    createdtime: "20030204092000",
    modifiedtime: "20250101120000",
    showflag: "1",
    ...overrides,
  };
}

describe("toTourContentRow", () => {
  it("필요한 필드만 뽑아 TourContentRow로 투영한다", () => {
    expect(toTourContentRow(syncItem())).toEqual({
      contentid: "126508",
      contenttypeid: "12",
      title: "경복궁",
      mapx: "126.9769",
      mapy: "37.5796",
      addr1: "서울특별시 종로구 사직로 161",
      addr2: "",
      zipcode: "03045",
      ldongRegnCd: "11",
      ldongSignguCd: "110",
      lclsSystm1: "AC",
      lclsSystm2: "AC01",
      lclsSystm3: "AC010100",
      modifiedtime: "20250101120000",
    });
  });

  it("투영 대상이 아닌 필드는 결과에 남지 않는다", () => {
    const row = toTourContentRow(syncItem()) as unknown as Record<string, unknown>;
    expect(row.createdtime).toBeUndefined();
    expect(row.showflag).toBeUndefined();
  });

  it("응답에 없는 필드는 빈 문자열로 채운다", () => {
    const partial = { contentid: "1", contenttypeid: "12", title: "제목" } as TourApiSyncItem;
    const row = toTourContentRow(partial);
    expect(row.addr1).toBe("");
    expect(row.ldongRegnCd).toBe("");
    expect(row.lclsSystm3).toBe("");
    expect(row.modifiedtime).toBe("");
  });
});
