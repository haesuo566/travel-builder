import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEnricher, isRateLimited } from "../../src/services/enricher.js";
import type { GeminiClient } from "../../src/clients/gemini.js";
import type { TeiEmbeddingClient } from "../../src/clients/tei.js";
import type { QdrantStore } from "../../src/clients/qdrant.js";
import type { PostgresClient } from "../../src/clients/postgres.js";
import type { EnrichInput } from "../../src/lib/tourContentsTable.js";
import * as table from "../../src/lib/tourContentsTable.js";
import { logger } from "../../src/lib/logger.js";

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/tourContentsTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof table>();
  return {
    ...actual,
    fetchEnrichInput: vi.fn(),
    markStructureDone: vi.fn().mockResolvedValue(undefined),
    markStructureFailure: vi.fn().mockResolvedValue("pending"),
    markEmbedDone: vi.fn().mockResolvedValue(undefined),
    markEmbedFailure: vi.fn().mockResolvedValue("pending"),
  };
});

const mocked = vi.mocked(table);

/** 테스트 컬렉션은 4차원 — embed mock의 벡터 길이와 맞춘다. */
const COLLECTION = { name: "tour_contents", vectorSize: 4 };
const VECTOR = [0.1, 0.2, 0.3, 0.4];

function input(overrides: Partial<EnrichInput> = {}): EnrichInput {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structuredText: null,
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

function validText(): string {
  return [
    "경복궁 — 고궁",
    "무엇을 하는 곳: 궁궐 관람, 수문장 교대식 관람",
    "실내/실외: 실내외 혼합",
    "추천 동반자: 가족, 커플, 혼자",
    "적정 소요시간: 1~2시간",
    "계절/날씨: 사계절",
    "분위기: 고요하고 정제된 역사 공간",
    "설명: 조선 왕조의 법궁이다.",
  ].join("\n");
}

function rateLimitError(): Error {
  return Object.assign(new Error("Resource has been exhausted"), { status: 429 });
}

function harness(overrides: {
  generate?: ReturnType<typeof vi.fn>;
  embed?: ReturnType<typeof vi.fn>;
  upsert?: ReturnType<typeof vi.fn>;
  opts?: Parameters<typeof createEnricher>[5];
} = {}) {
  const generate = overrides.generate ?? vi.fn().mockResolvedValue(validText());
  const embed = overrides.embed ?? vi.fn().mockResolvedValue([VECTOR]);
  const upsert = overrides.upsert ?? vi.fn().mockResolvedValue(undefined);
  const pg = {} as PostgresClient;
  const enricher = createEnricher(
    { generate } as unknown as GeminiClient,
    { embed } as unknown as TeiEmbeddingClient,
    { upsert } as unknown as QdrantStore,
    pg,
    COLLECTION,
    { sleep: async () => {}, ...overrides.opts },
  );
  return { enricher, generate, embed, upsert, pg };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.fetchEnrichInput.mockResolvedValue(input());
  mocked.markStructureDone.mockResolvedValue(undefined);
  mocked.markStructureFailure.mockResolvedValue("pending");
  mocked.markEmbedDone.mockResolvedValue(undefined);
  mocked.markEmbedFailure.mockResolvedValue("pending");
});

describe("isRateLimited", () => {
  it("status·code 429와 메시지 패턴을 판별한다", () => {
    expect(isRateLimited(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRateLimited(Object.assign(new Error("x"), { code: 429 }))).toBe(true);
    expect(isRateLimited(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRateLimited(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isRateLimited(new Error("Quota exceeded for model"))).toBe(true);
  });

  it("그 외 오류는 false", () => {
    expect(isRateLimited(new Error("ECONNRESET"))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
    expect(isRateLimited("문자열")).toBe(false);
  });
});

describe("createEnricher 정상 경로", () => {
  it("Gemini → 구조화 저장 → 임베딩 → upsert → 임베딩 저장 순으로 수행한다", async () => {
    const { enricher, generate, embed, upsert, pg } = harness();
    await enricher.enrich("126508");

    expect(generate).toHaveBeenCalledOnce();
    expect(mocked.markStructureDone).toHaveBeenCalledWith(pg, "126508", validText());
    expect(embed).toHaveBeenCalledWith([validText()]);
    expect(upsert).toHaveBeenCalledWith("tour_contents", [
      {
        id: 126508,
        vector: VECTOR,
        payload: expect.objectContaining({ contentid: "126508", title: "경복궁" }),
      },
    ]);
    expect(mocked.markEmbedDone).toHaveBeenCalledWith(pg, "126508");
    expect(enricher.stats()).toMatchObject({ structured: 1, embedded: 1, fallback: 0 });
  });

  it("Gemini에 systemInstruction과 temperature 0을 넘긴다", async () => {
    const { enricher, generate } = harness();
    await enricher.enrich("126508");
    expect(generate).toHaveBeenCalledWith(
      expect.stringContaining("제목: 경복궁"),
      expect.objectContaining({
        temperature: 0,
        systemInstruction: expect.stringContaining("무엇을 하는 곳:"),
      }),
    );
  });

  it("structuredText가 이미 있으면 Gemini를 호출하지 않고 임베딩만 한다", async () => {
    mocked.fetchEnrichInput.mockResolvedValue(input({ structuredText: "기존 텍스트" }));
    const { enricher, generate, embed } = harness();
    await enricher.enrich("126508");
    expect(generate).not.toHaveBeenCalled();
    expect(mocked.markStructureDone).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledWith(["기존 텍스트"]);
    expect(enricher.stats()).toMatchObject({ structured: 0, embedded: 1 });
  });

  it("overview가 비면 Gemini 없이 최소 텍스트로 임베딩한다", async () => {
    mocked.fetchEnrichInput.mockResolvedValue(input({ overview: "   " }));
    const { enricher, generate, embed, pg } = harness();
    await enricher.enrich("126508");
    expect(generate).not.toHaveBeenCalled();
    const minimal = "경복궁 — 관광지\n인문(문화/예술/역사) > 역사관광지 > 고궁";
    expect(mocked.markStructureDone).toHaveBeenCalledWith(pg, "126508", minimal);
    expect(embed).toHaveBeenCalledWith([minimal]);
    expect(enricher.stats()).toMatchObject({ fallback: 1, structured: 1, embedded: 1 });
  });

  it("행이 없으면 경고만 남기고 아무 것도 하지 않는다", async () => {
    mocked.fetchEnrichInput.mockResolvedValue(null);
    const { enricher, generate, embed } = harness();
    await enricher.enrich("없음");
    expect(generate).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("없음"));
  });
});

describe("createEnricher Gemini 실패", () => {
  it("429는 백오프 후 재시도하고, 성공하면 정상 진행한다", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce(validText());
    const { enricher } = harness({ generate });
    await enricher.enrich("126508");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(enricher.stats()).toMatchObject({ structured: 1, embedded: 1, geminiRateLimited: 0 });
  });

  it("429가 재시도를 소진하면 상태·시도횟수를 건드리지 않고 임베딩도 건너뛴다", async () => {
    // 쿼터 소진은 데이터의 문제가 아니라 호출자 사정이다. attempt를 올리면
    // 매일 한도 경계의 항목이 실패를 누적해 멀쩡한 데이터가 영구 제외된다.
    const generate = vi.fn().mockRejectedValue(rateLimitError());
    const { enricher, embed } = harness({ generate, opts: { geminiRetries: 2 } });
    await enricher.enrich("126508");
    expect(generate).toHaveBeenCalledTimes(3); // 최초 1 + 재시도 2
    expect(mocked.markStructureFailure).not.toHaveBeenCalled();
    expect(mocked.markStructureDone).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(enricher.stats()).toMatchObject({ geminiRateLimited: 1, structured: 0, embedded: 0 });
  });

  it("기타 오류는 실패로 기록하되 throw하지 않는다", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("500 Internal"));
    const { enricher, embed, pg } = harness({ generate });
    await expect(enricher.enrich("126508")).resolves.toBeUndefined();
    expect(mocked.markStructureFailure).toHaveBeenCalledWith(pg, "126508", "500 Internal", 3);
    expect(embed).not.toHaveBeenCalled();
    expect(enricher.stats()).toMatchObject({ structureRetry: 1, structureFailed: 0 });
  });

  it("maxAttempts 도달로 failed 전이되면 failed로 집계한다", async () => {
    mocked.markStructureFailure.mockResolvedValue("failed");
    const generate = vi.fn().mockRejectedValue(new Error("500 Internal"));
    const { enricher } = harness({ generate });
    await enricher.enrich("126508");
    expect(enricher.stats()).toMatchObject({ structureFailed: 1, structureRetry: 0 });
  });

  it("포맷 검증 실패는 구조화 실패로 분류하고 저장하지 않는다", async () => {
    const generate = vi.fn().mockResolvedValue("라벨 없는 자유 텍스트");
    const { enricher, embed } = harness({ generate });
    await enricher.enrich("126508");
    expect(mocked.markStructureDone).not.toHaveBeenCalled();
    expect(mocked.markStructureFailure).toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("연속 10회 실패하면 스스로를 끄고 이후 호출을 no-op으로 만든다", async () => {
    // 시스템 장애(키 만료·네트워크 단절)가 개별 항목 오류로 위장해 들어오면
    // claim한 전량에 실패가 기록된다. 손상을 10건으로 묶는다.
    const generate = vi.fn().mockRejectedValue(new Error("API key expired"));
    const { enricher, embed } = harness({ generate });
    for (let i = 0; i < 15; i += 1) {
      await enricher.enrich(String(i));
    }
    expect(generate).toHaveBeenCalledTimes(10);
    expect(mocked.markStructureFailure).toHaveBeenCalledTimes(10);
    expect(embed).not.toHaveBeenCalled();
    expect(enricher.stats().disabled).toBe(true);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining("연속"));
  });

  it("성공은 연속 실패 카운터를 초기화한다", async () => {
    const generate = vi.fn(async (prompt: string) => {
      if (prompt.includes("성공")) return validText();
      throw new Error("500 Internal");
    });
    const { enricher } = harness({ generate });
    // 실패 9 → 성공 1 → 실패 9: 연속 10회에 도달하지 않아 19회 모두 호출된다.
    for (let i = 0; i < 19; i += 1) {
      mocked.fetchEnrichInput.mockResolvedValue(
        input({ title: i === 9 ? "성공" : `실패${i}` }),
      );
      await enricher.enrich(String(i));
    }
    expect(generate).toHaveBeenCalledTimes(19);
    expect(enricher.stats().disabled).toBe(false);
  });
});

describe("createEnricher 임베딩 실패", () => {
  it("TEI 실패는 임베딩 실패로 기록하고 upsert하지 않는다", async () => {
    const embed = vi.fn().mockRejectedValue(new Error("TEI 502"));
    const { enricher, upsert, pg } = harness({ embed });
    await expect(enricher.enrich("126508")).resolves.toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(pg, "126508", "TEI 502", 3);
    expect(mocked.markEmbedDone).not.toHaveBeenCalled();
    // 구조화는 이미 커밋됐으므로 다음 실행이 Gemini를 다시 태우지 않는다.
    expect(mocked.markStructureDone).toHaveBeenCalled();
  });

  it("Qdrant 실패는 임베딩 실패로 기록하고 done을 쓰지 않는다", async () => {
    const upsert = vi.fn().mockRejectedValue(new Error("Qdrant 503"));
    const { enricher, pg } = harness({ upsert });
    await enricher.enrich("126508");
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(pg, "126508", "Qdrant 503", 3);
    expect(mocked.markEmbedDone).not.toHaveBeenCalled();
  });

  it("차원이 다른 벡터가 오면 임베딩 실패로 기록한다", async () => {
    const embed = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const { enricher, upsert } = harness({ embed });
    await enricher.enrich("126508");
    expect(upsert).not.toHaveBeenCalled();
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(
      expect.anything(),
      "126508",
      expect.stringContaining("차원"),
      3,
    );
  });

  it("contentid가 숫자가 아니면 즉시 failed로 종결하고 upsert하지 않는다", async () => {
    // 숫자가 아닌 contentid는 재시도해도 절대 숫자가 되지 않으므로 maxAttempts=1로 종결한다.
    mocked.fetchEnrichInput.mockResolvedValue(input({ contentid: "ABC-1" }));
    mocked.markEmbedFailure.mockResolvedValue("failed");
    const { enricher, upsert, embed } = harness();
    await enricher.enrich("ABC-1");
    expect(embed).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(mocked.markEmbedFailure).toHaveBeenCalledWith(
      expect.anything(),
      "ABC-1",
      expect.stringContaining("숫자"),
      1,
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    expect(enricher.stats()).toMatchObject({ embedFailed: 1, embedded: 0 });
  });
});

describe("createEnricher DB 쓰기 실패", () => {
  it("markStructureDone 실패는 실패로 세지 않고 전파한다", async () => {
    mocked.markStructureDone.mockRejectedValue(new Error("DB 쓰기 실패"));
    const { enricher } = harness();
    await expect(enricher.enrich("126508")).rejects.toThrow("DB 쓰기 실패");
    expect(mocked.markStructureFailure).not.toHaveBeenCalled();
  });

  it("markEmbedDone 실패는 전파한다", async () => {
    mocked.markEmbedDone.mockRejectedValue(new Error("DB 쓰기 실패"));
    const { enricher } = harness();
    await expect(enricher.enrich("126508")).rejects.toThrow("DB 쓰기 실패");
    expect(mocked.markEmbedFailure).not.toHaveBeenCalled();
  });
});

describe("stats", () => {
  it("스냅샷을 반환해 외부에서 변형할 수 없다", async () => {
    const { enricher } = harness();
    await enricher.enrich("126508");
    const snapshot = enricher.stats();
    snapshot.embedded = 999;
    expect(enricher.stats().embedded).toBe(1);
  });
});
