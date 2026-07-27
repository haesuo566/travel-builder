/**
 * core의 toPayload(core/src/lib/qdrantCollection.ts:76-89)가 쓰는 키와 1:1이어야 한다.
 * 타입 시스템이 두 워크스페이스를 연결하지 못하므로 이 주석과
 * .claude/skills/tb-tdd-implement/references/workspaces.md의 경계표가 유일한 연결이다.
 */
export interface TourContentPayload {
  contentid: string;
  contenttypeid: string;
  ldong_regn_cd: string;
  ldong_signgu_cd: string;
  lcls_systm1: string;
  lcls_systm2: string;
  lcls_systm3: string;
  title: string;
  mapx: string;
  mapy: string;
}

/**
 * 검색 필터. 서비스 계층이 Qdrant 필터 DSL을 직접 조립하지 않게 타입으로 받는다.
 * 이 타입이 qdrant.client.ts가 아니라 여기 있는 이유는 buildQdrantFilter가
 * 이걸 받기 때문이다 — 반대로 두면 두 파일이 서로를 import한다.
 */
export interface TourSearchFilter {
  contenttypeid?: string;
  ldongRegnCd?: string;
  ldongSignguCd?: string;
  lclsSystm1?: string;
  lclsSystm2?: string;
  lclsSystm3?: string;
}

/** payload 키 문자열은 이 표 한 곳에만 존재한다. core의 toPayload와 짝이다. */
const PAYLOAD_KEY_BY_FIELD: Record<keyof TourSearchFilter, string> = {
  contenttypeid: 'contenttypeid',
  ldongRegnCd: 'ldong_regn_cd',
  ldongSignguCd: 'ldong_signgu_cd',
  lclsSystm1: 'lcls_systm1',
  lclsSystm2: 'lcls_systm2',
  lclsSystm3: 'lcls_systm3',
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * contentid가 없으면 Postgres 재조회가 불가능해 쓸모가 없다 → null.
 * 나머지 필드는 ''로 보정한다 — 표시용 필드 하나가 비었다고 hit을 버릴 이유가 없다.
 */
export function parseTourContentPayload(
  raw: unknown,
): TourContentPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const record = raw as Record<string, unknown>;

  const contentid = asString(record.contentid);
  if (contentid === '') return null;

  return {
    contentid,
    contenttypeid: asString(record.contenttypeid),
    ldong_regn_cd: asString(record.ldong_regn_cd),
    ldong_signgu_cd: asString(record.ldong_signgu_cd),
    lcls_systm1: asString(record.lcls_systm1),
    lcls_systm2: asString(record.lcls_systm2),
    lcls_systm3: asString(record.lcls_systm3),
    title: asString(record.title),
    mapx: asString(record.mapx),
    mapy: asString(record.mapy),
  };
}

/**
 * 조건이 하나도 없으면 undefined를 반환한다 — 빈 must 절을 보내지 않는다.
 *
 * 빈 문자열·공백뿐인 조건은 넣지 않고, 남기는 조건은 trim한 값을 쓴다
 * (spec "빈 문자열 env" 절의 C 행). ''로 필터하면 payload의 어떤 값과도 매치되지
 * 않아 예외 없이 "정상 200 + 결과 없음"이 되고, ' 12 '도 payload의 '12'와 안 맞아
 * 같은 결과가 된다 — 원인에서 가장 먼 종류의 실패다.
 * ??가 아니라 ?.trim()인 이유는 ||가 공백 문자열을 truthy로 보기 때문이다
 * (gemini.client.ts:46과 같은 관용구).
 */
export function buildQdrantFilter(
  filter?: TourSearchFilter,
): Record<string, unknown> | undefined {
  if (filter === undefined) return undefined;

  const fields = Object.keys(PAYLOAD_KEY_BY_FIELD) as Array<
    keyof TourSearchFilter
  >;
  const must = fields
    .map((field) => ({
      key: PAYLOAD_KEY_BY_FIELD[field],
      value: filter[field]?.trim() ?? '',
    }))
    .filter(({ value }) => value !== '')
    .map(({ key, value }) => ({ key, match: { value } }));

  return must.length === 0 ? undefined : { must };
}
