import { describe, it, expect, vi } from "vitest";
import {
  ensureCollection,
  toPayload,
  toPointId,
} from "../../src/lib/qdrantCollection.js";
import type { QdrantDistance, QdrantStore } from "../../src/clients/qdrant.js";
import type { TeiEmbeddingClient } from "../../src/clients/tei.js";
import type { EnrichInput } from "../../src/lib/tourContentsTable.js";

function fakeQdrant(existing: { vectorSize: number; distance?: QdrantDistance } | null) {
  const info =
    existing === null ? null : { vectorSize: existing.vectorSize, distance: existing.distance ?? "Cosine" };
  const getCollectionInfo = vi.fn().mockResolvedValue(info);
  const createCollection = vi.fn().mockResolvedValue(undefined);
  const deleteCollection = vi.fn().mockResolvedValue(undefined);
  return {
    store: { getCollectionInfo, createCollection, deleteCollection } as unknown as QdrantStore,
    getCollectionInfo,
    createCollection,
    deleteCollection,
  };
}

function fakeTei(vectorSize: number) {
  const embed = vi.fn().mockResolvedValue([Array.from({ length: vectorSize }, () => 0.1)]);
  return { tei: { embed } as unknown as TeiEmbeddingClient, embed };
}

function input(overrides: Partial<EnrichInput> = {}): EnrichInput {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structuredText: null,
    structureStatus: "pending",
    contenttypeid: "12",
    ldongRegnCd: "11",
    ldongSignguCd: "110",
    lclsSystm1: "AC",
    lclsSystm2: "AC01",
    lclsSystm3: "AC010100",
    mapx: "126.9769",
    mapy: "37.5796",
    contentTypeNm: "관광지",
    lcls1Nm: "인문(문화/예술/역사)",
    lcls2Nm: "역사관광지",
    lcls3Nm: "고궁",
    regnNm: "서울특별시",
    signguNm: "종로구",
    ...overrides,
  };
}

describe("ensureCollection", () => {
  it("TEI를 1회 호출해 차원을 감지한다", async () => {
    const { store } = fakeQdrant({ vectorSize: 1024 });
    const { tei, embed } = fakeTei(1024);
    const info = await ensureCollection(store, tei, "tour_contents");
    expect(embed).toHaveBeenCalledTimes(1);
    expect(info).toEqual({ name: "tour_contents", vectorSize: 1024, distance: "Cosine" });
  });

  it("컬렉션이 없으면 감지한 차원과 Cosine으로 생성한다", async () => {
    const { store, createCollection } = fakeQdrant(null);
    const { tei } = fakeTei(1024);
    const info = await ensureCollection(store, tei, "tour_contents");
    expect(createCollection).toHaveBeenCalledWith("tour_contents", 1024, "Cosine");
    expect(info.vectorSize).toBe(1024);
    expect(info.distance).toBe("Cosine");
  });

  it("기존 차원이 같으면 생성하지 않는다", async () => {
    const { store, createCollection } = fakeQdrant({ vectorSize: 1024 });
    const { tei } = fakeTei(1024);
    await ensureCollection(store, tei, "tour_contents");
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("기존 차원이 다르면 throw하고 컬렉션을 삭제하지 않는다", async () => {
    const { store, createCollection, deleteCollection } = fakeQdrant({ vectorSize: 768 });
    const { tei } = fakeTei(1024);
    await expect(ensureCollection(store, tei, "tour_contents")).rejects.toThrow("768");
    await expect(ensureCollection(store, tei, "tour_contents")).rejects.toThrow("1024");
    // 컬렉션을 날리는 것은 파괴적이고 되돌릴 수 없으므로 사람이 결정할 일이다.
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("기존 distance가 다르면 throw하고 컬렉션을 삭제하지 않는다 (Minor 7)", async () => {
    // Euclid로 만들어진 기존 컬렉션 위에 코사인 정규화 벡터를 쓰면 검색 품질이
    // 조용히 틀어진다 — 차원 불일치와 같은 종류의 오류이므로 같은 방식으로 막는다.
    const { store, createCollection, deleteCollection } = fakeQdrant({
      vectorSize: 1024,
      distance: "Euclid",
    });
    const { tei } = fakeTei(1024);
    await expect(ensureCollection(store, tei, "tour_contents")).rejects.toThrow("Euclid");
    await expect(ensureCollection(store, tei, "tour_contents")).rejects.toThrow("Cosine");
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("TEI가 빈 벡터를 주면 throw", async () => {
    const { store } = fakeQdrant(null);
    const tei = { embed: vi.fn().mockResolvedValue([[]]) } as unknown as TeiEmbeddingClient;
    await expect(ensureCollection(store, tei, "c")).rejects.toThrow("차원");
  });
});

describe("toPointId", () => {
  it("숫자 문자열을 숫자로 바꾼다", () => {
    expect(toPointId("126508")).toBe(126508);
  });

  it("숫자가 아니면 null", () => {
    expect(toPointId("abc")).toBeNull();
    expect(toPointId("")).toBeNull();
    expect(toPointId("12.5")).toBeNull();
    expect(toPointId("-1")).toBeNull();
    expect(toPointId(" 12 ")).toBeNull();
  });

  it("안전 정수 범위를 넘으면 null", () => {
    expect(toPointId("99999999999999999999")).toBeNull();
  });
});

describe("toPayload", () => {
  it("필터 키와 최소 표시 필드만 담는다", () => {
    expect(toPayload(input())).toEqual({
      contentid: "126508",
      contenttypeid: "12",
      ldong_regn_cd: "11",
      ldong_signgu_cd: "110",
      lcls_systm1: "AC",
      lcls_systm2: "AC01",
      lcls_systm3: "AC010100",
      title: "경복궁",
      mapx: "126.9769",
      mapy: "37.5796",
    });
  });

  it("본문·이름 필드를 복제하지 않는다", () => {
    const keys = Object.keys(toPayload(input()));
    // Qdrant는 파생 인덱스다 — 원본 진실은 Postgres에 둔다.
    expect(keys).not.toContain("overview");
    expect(keys).not.toContain("structuredText");
    expect(keys).not.toContain("contentTypeNm");
    expect(keys).not.toContain("regnNm");
    expect(keys).not.toContain("addr1");
  });
});
