import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  poolQueryMock,
  poolConnectMock,
  poolEndMock,
  clientQueryMock,
  clientReleaseMock,
  PoolMock,
} = vi.hoisted(() => {
  const poolQueryMock = vi.fn();
  const poolConnectMock = vi.fn();
  const poolEndMock = vi.fn();
  const clientQueryMock = vi.fn();
  const clientReleaseMock = vi.fn();
  const PoolMock = vi.fn(() => ({
    query: poolQueryMock,
    connect: poolConnectMock,
    end: poolEndMock,
  }));
  return { poolQueryMock, poolConnectMock, poolEndMock, clientQueryMock, clientReleaseMock, PoolMock };
});

vi.mock("pg", () => ({
  default: { Pool: PoolMock },
}));

import { PostgresClient } from "../../src/clients/postgres.js";

beforeEach(() => {
  poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
  poolConnectMock.mockReset();
  poolEndMock.mockReset().mockResolvedValue(undefined);
  clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  clientReleaseMock.mockReset();
  PoolMock.mockClear();
  process.env.DATABASE_URL = "postgres://localhost/test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("PostgresClient", () => {
  it("DATABASE_URL 없으면 생성자에서 throw", () => {
    delete process.env.DATABASE_URL;
    expect(() => new PostgresClient()).toThrow("DATABASE_URL");
  });

  it("connect 전 query 호출 시 throw", async () => {
    const client = new PostgresClient();
    await expect(client.query("SELECT 1")).rejects.toThrow("연결");
  });

  it("connect가 Pool을 만들고 SELECT 1로 확인한다", async () => {
    const client = new PostgresClient();
    await client.connect();
    expect(PoolMock).toHaveBeenCalledWith({ connectionString: "postgres://localhost/test" });
    expect(poolQueryMock).toHaveBeenCalledWith("SELECT 1");
  });

  it("query가 pool.query에 위임한다", async () => {
    const client = new PostgresClient();
    await client.connect();
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const res = await client.query("SELECT * FROM t WHERE id=$1", [1]);
    expect(res.rows).toEqual([{ id: 1 }]);
    expect(poolQueryMock).toHaveBeenLastCalledWith("SELECT * FROM t WHERE id=$1", [1]);
  });

  it("transaction 성공 시 BEGIN/COMMIT 후 release", async () => {
    poolConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
    const client = new PostgresClient();
    await client.connect();
    const result = await client.transaction(async (c) => {
      await c.query("INSERT ...");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(clientQueryMock.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "INSERT ...", "COMMIT"]);
    expect(clientReleaseMock).toHaveBeenCalledOnce();
  });

  it("transaction 예외 시 ROLLBACK 후 release하고 재-throw", async () => {
    poolConnectMock.mockResolvedValue({ query: clientQueryMock, release: clientReleaseMock });
    const client = new PostgresClient();
    await client.connect();
    await expect(
      client.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(clientQueryMock.mock.calls.map((c) => c[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(clientReleaseMock).toHaveBeenCalledOnce();
  });

  it("close가 pool.end를 호출한다", async () => {
    const client = new PostgresClient();
    await client.connect();
    await client.close();
    expect(poolEndMock).toHaveBeenCalledOnce();
  });

  it("connect 검증(SELECT 1) 실패 시 Pool을 end()하고 재-throw한다", async () => {
    poolQueryMock.mockRejectedValueOnce(new Error("connection refused"));
    const client = new PostgresClient();
    await expect(client.connect()).rejects.toThrow("connection refused");
    expect(poolEndMock).toHaveBeenCalledOnce();
    await expect(client.query("SELECT 1")).rejects.toThrow("연결");
  });
});
