import pg from "pg";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { requireEnv } from "../lib/env.js";

const { Pool: PgPool } = pg;

/** PostgreSQL 연결 클라이언트 (pg Pool 래퍼). */
export class PostgresClient {
  private readonly connectionString: string;
  private pool: Pool | null = null;

  constructor() {
    this.connectionString = requireEnv("DATABASE_URL");
  }

  /** Pool을 생성하고 SELECT 1로 연결을 확인한다. 검증 실패 시 Pool을 정리하고 재-throw한다. */
  async connect(): Promise<void> {
    if (this.pool) return;
    const pool = new PgPool({ connectionString: this.connectionString });
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      await pool.end();
      throw error;
    }
    this.pool = pool;
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error("PostgresClient가 연결되지 않았습니다. 먼저 connect()를 호출하세요.");
    }
    return this.pool;
  }

  /** 쿼리를 실행한다. */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.requirePool().query<T>(text, params);
  }

  /** 트랜잭션 블록을 실행한다. 예외 시 ROLLBACK 후 재-throw. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Pool을 종료한다. 미연결 상태면 no-op. */
  async close(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }
}
