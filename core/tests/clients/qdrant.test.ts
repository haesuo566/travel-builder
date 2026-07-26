import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  getCollectionsMock,
  getCollectionMock,
  createCollectionMock,
  deleteCollectionMock,
  upsertMock,
  searchMock,
  deleteMock,
  QdrantClientMock,
} = vi.hoisted(() => {
  const getCollectionsMock = vi.fn();
  const getCollectionMock = vi.fn();
  const createCollectionMock = vi.fn();
  const deleteCollectionMock = vi.fn();
  const upsertMock = vi.fn();
  const searchMock = vi.fn();
  const deleteMock = vi.fn();
  const QdrantClientMock = vi.fn(() => ({
    getCollections: getCollectionsMock,
    getCollection: getCollectionMock,
    createCollection: createCollectionMock,
    deleteCollection: deleteCollectionMock,
    upsert: upsertMock,
    search: searchMock,
    delete: deleteMock,
  }));
  return {
    getCollectionsMock,
    getCollectionMock,
    createCollectionMock,
    deleteCollectionMock,
    upsertMock,
    searchMock,
    deleteMock,
    QdrantClientMock,
  };
});

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: QdrantClientMock,
}));

import { QdrantStore } from "../../src/clients/qdrant.js";

beforeEach(() => {
  getCollectionsMock.mockReset().mockResolvedValue({ collections: [] });
  getCollectionMock.mockReset();
  createCollectionMock.mockReset().mockResolvedValue(true);
  deleteCollectionMock.mockReset().mockResolvedValue(true);
  upsertMock.mockReset().mockResolvedValue({ status: "completed" });
  searchMock.mockReset().mockResolvedValue([]);
  deleteMock.mockReset().mockResolvedValue({ status: "completed" });
  QdrantClientMock.mockClear();
  process.env.QDRANT_URL = "http://localhost:6333";
  delete process.env.QDRANT_API_KEY;
});

afterEach(() => {
  delete process.env.QDRANT_URL;
  delete process.env.QDRANT_API_KEY;
});

describe("QdrantStore", () => {
  it("QDRANT_URL 없으면 생성자에서 throw", () => {
    delete process.env.QDRANT_URL;
    expect(() => new QdrantStore()).toThrow("QDRANT_URL");
  });

  it("connect 전 작업 메서드 호출 시 throw", async () => {
    const store = new QdrantStore();
    await expect(store.upsert("c", [])).rejects.toThrow("연결");
  });

  it("connect가 클라이언트를 만들고 getCollections로 확인한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    expect(QdrantClientMock).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      apiKey: undefined,
    });
    expect(getCollectionsMock).toHaveBeenCalledOnce();
  });

  it("QDRANT_API_KEY가 있으면 전달한다", async () => {
    process.env.QDRANT_API_KEY = "secret";
    const store = new QdrantStore();
    await store.connect();
    expect(QdrantClientMock).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      apiKey: "secret",
    });
  });

  it("createCollection이 기본 Cosine으로 호출한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    await store.createCollection("col", 768);
    expect(createCollectionMock).toHaveBeenCalledWith("col", {
      vectors: { size: 768, distance: "Cosine" },
    });
  });

  it("deleteCollection이 위임한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    await store.deleteCollection("col");
    expect(deleteCollectionMock).toHaveBeenCalledWith("col");
  });

  it("upsert가 wait:true와 points를 전달한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    const points = [{ id: 1, vector: [0.1, 0.2], payload: { a: 1 } }];
    await store.upsert("col", points);
    expect(upsertMock).toHaveBeenCalledWith("col", { wait: true, points });
  });

  it("search가 기본 limit 10으로 호출하고 결과를 매핑한다", async () => {
    searchMock.mockResolvedValue([
      { id: 5, version: 0, score: 0.9, payload: { t: "x" }, vector: [0.1] },
    ]);
    const store = new QdrantStore();
    await store.connect();
    const res = await store.search("col", [0.1, 0.2]);
    expect(searchMock).toHaveBeenCalledWith("col", {
      vector: [0.1, 0.2],
      limit: 10,
      filter: undefined,
    });
    expect(res).toEqual([{ id: 5, score: 0.9, payload: { t: "x" } }]);
  });

  it("search가 opts의 limit/filter를 전달한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    const filter = { must: [{ key: "city", match: { value: "Berlin" } }] };
    await store.search("col", [0.1], { limit: 3, filter });
    expect(searchMock).toHaveBeenCalledWith("col", { vector: [0.1], limit: 3, filter });
  });

  it("deletePoints가 wait:true와 ids를 전달한다", async () => {
    const store = new QdrantStore();
    await store.connect();
    await store.deletePoints("col", [1, 2]);
    expect(deleteMock).toHaveBeenCalledWith("col", { wait: true, points: [1, 2] });
  });

  it("getCollectionInfo가 벡터 차원을 반환한다", async () => {
    getCollectionMock.mockResolvedValue({
      config: { params: { vectors: { size: 1024, distance: "Cosine" } } },
    });
    const store = new QdrantStore();
    await store.connect();
    expect(await store.getCollectionInfo("col")).toEqual({ vectorSize: 1024 });
    expect(getCollectionMock).toHaveBeenCalledWith("col");
  });

  it("컬렉션이 없으면(404) null을 반환한다", async () => {
    getCollectionMock.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    const store = new QdrantStore();
    await store.connect();
    expect(await store.getCollectionInfo("없는컬렉션")).toBeNull();
  });

  it("404가 아닌 에러는 전파한다", async () => {
    // 연결 장애를 "컬렉션 없음"으로 오분류하면, 기존 컬렉션 위에
    // 다른 차원으로 재생성을 시도하게 된다.
    getCollectionMock.mockRejectedValue(Object.assign(new Error("ECONNREFUSED"), { status: 500 }));
    const store = new QdrantStore();
    await store.connect();
    await expect(store.getCollectionInfo("col")).rejects.toThrow("ECONNREFUSED");
  });

  it("차원을 읽을 수 없는 응답이면 throw", async () => {
    getCollectionMock.mockResolvedValue({ config: { params: {} } });
    const store = new QdrantStore();
    await store.connect();
    await expect(store.getCollectionInfo("col")).rejects.toThrow("벡터 크기");
  });

  it("connect 전 getCollectionInfo 호출 시 throw", async () => {
    const store = new QdrantStore();
    await expect(store.getCollectionInfo("col")).rejects.toThrow("연결");
  });
});
