import { QdrantClient } from "@qdrant/js-client-rest";
import { optionalEnv, requireEnv } from "../lib/env.js";

/**
 * 컬렉션 부재(404)인지 판별한다.
 * SDK 버전에 따라 status를 노출하지 않는 경우가 있어 메시지도 함께 본다.
 */
function isCollectionNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record.status === 404) return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /not found|doesn't exist|does not exist/i.test(message);
}

export type QdrantDistance = "Cosine" | "Euclid" | "Dot";

export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface QdrantSearchOptions {
  limit?: number;
  filter?: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
}

/** Qdrant 벡터 저장소 래퍼. 이미 계산된 벡터를 받아 저장/검색한다. */
export class QdrantStore {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private client: QdrantClient | null = null;

  constructor() {
    this.url = requireEnv("QDRANT_URL");
    const key = optionalEnv("QDRANT_API_KEY", "");
    this.apiKey = key === "" ? undefined : key;
  }

  /** 클라이언트를 생성하고 getCollections로 연결을 확인한다. */
  async connect(): Promise<void> {
    if (this.client) return;
    const client = new QdrantClient({ url: this.url, apiKey: this.apiKey });
    await client.getCollections();
    this.client = client;
  }

  private requireClient(): QdrantClient {
    if (!this.client) {
      throw new Error("QdrantStore가 연결되지 않았습니다. 먼저 connect()를 호출하세요.");
    }
    return this.client;
  }

  /**
   * 컬렉션 정보를 조회한다. 컬렉션이 없으면 null.
   * 404가 아닌 에러는 전파한다 — 연결 장애를 "없음"으로 오분류하면
   * 기존 컬렉션 위에 다른 차원으로 재생성을 시도하게 된다.
   */
  async getCollectionInfo(name: string): Promise<{ vectorSize: number } | null> {
    const client = this.requireClient();
    let info: Awaited<ReturnType<QdrantClient["getCollection"]>>;
    try {
      info = await client.getCollection(name);
    } catch (error) {
      if (isCollectionNotFound(error)) return null;
      throw error;
    }
    const vectors = info.config?.params?.vectors;
    const size =
      typeof vectors === "object" && vectors !== null && "size" in vectors
        ? Number((vectors as { size: unknown }).size)
        : Number.NaN;
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`컬렉션 ${name}의 벡터 크기를 읽을 수 없습니다.`);
    }
    return { vectorSize: size };
  }

  async createCollection(
    name: string,
    vectorSize: number,
    distance: QdrantDistance = "Cosine",
  ): Promise<void> {
    await this.requireClient().createCollection(name, {
      vectors: { size: vectorSize, distance },
    });
  }

  async deleteCollection(name: string): Promise<void> {
    await this.requireClient().deleteCollection(name);
  }

  async upsert(collection: string, points: QdrantPoint[]): Promise<void> {
    await this.requireClient().upsert(collection, { wait: true, points });
  }

  async search(
    collection: string,
    vector: number[],
    opts: QdrantSearchOptions = {},
  ): Promise<QdrantSearchResult[]> {
    const results = await this.requireClient().search(collection, {
      vector,
      limit: opts.limit ?? 10,
      filter: opts.filter,
    });
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload,
    }));
  }

  async deletePoints(collection: string, ids: (string | number)[]): Promise<void> {
    await this.requireClient().delete(collection, { wait: true, points: ids });
  }

  /** 내부 클라이언트 참조를 해제한다. */
  async close(): Promise<void> {
    this.client = null;
  }
}
