import { QdrantClient } from "@qdrant/js-client-rest";
import { optionalEnv, requireEnv } from "../lib/env.js";

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
