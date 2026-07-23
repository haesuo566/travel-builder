import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("axios", () => ({
  default: { post: postMock },
}));

import { TeiEmbeddingClient } from "../../src/clients/tei.js";

beforeEach(() => {
  postMock.mockReset();
  process.env.TEI_BASE_URL = "http://localhost:8080";
});

afterEach(() => {
  delete process.env.TEI_BASE_URL;
});

describe("TeiEmbeddingClient", () => {
  it("TEI_BASE_URL 없으면 생성자에서 throw", () => {
    delete process.env.TEI_BASE_URL;
    expect(() => new TeiEmbeddingClient()).toThrow("TEI_BASE_URL");
  });

  it("기본 옵션(normalize=true, truncate=true)으로 /embed를 호출한다", async () => {
    postMock.mockResolvedValue({ data: [[0.1, 0.2]] });
    const client = new TeiEmbeddingClient();
    const result = await client.embed(["hello"]);
    expect(postMock).toHaveBeenCalledWith("http://localhost:8080/embed", {
      inputs: ["hello"],
      normalize: true,
      truncate: true,
    });
    expect(result).toEqual([[0.1, 0.2]]);
  });

  it("opts로 normalize/truncate/promptName을 덮어쓸 수 있다", async () => {
    postMock.mockResolvedValue({ data: [[0.1, 0.2]] });
    const client = new TeiEmbeddingClient();
    await client.embed(["hello"], { normalize: false, truncate: false, promptName: "query" });
    expect(postMock).toHaveBeenCalledWith("http://localhost:8080/embed", {
      inputs: ["hello"],
      normalize: false,
      truncate: false,
      prompt_name: "query",
    });
  });

  it("promptName 미지정 시 요청 바디에서 생략된다", async () => {
    postMock.mockResolvedValue({ data: [[0.1, 0.2]] });
    const client = new TeiEmbeddingClient();
    await client.embed(["hello"]);
    const body = postMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("prompt_name");
  });

  it("배치 입력 시 순서대로 number[][]를 반환한다", async () => {
    postMock.mockResolvedValue({
      data: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    });
    const client = new TeiEmbeddingClient();
    const result = await client.embed(["a", "b"]);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("빈 배열 입력 시 axios를 호출하지 않고 빈 배열을 반환한다", async () => {
    const client = new TeiEmbeddingClient();
    const result = await client.embed([]);
    expect(result).toEqual([]);
    expect(postMock).not.toHaveBeenCalled();
  });
});
