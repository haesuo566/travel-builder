import type { QdrantDistance, QdrantStore } from "../clients/qdrant.js";
import type { TeiEmbeddingClient } from "../clients/tei.js";
import type { EnrichInput } from "./tourContentsTable.js";

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  distance: QdrantDistance;
}

/** 차원 감지용 더미 입력. 저장되지 않으며 실제 데이터와 무관하다. */
const PROBE_TEXT = "차원 확인";

/** createCollection이 새로 만들 때 쓰는 거리 계산 방식과 동일해야 한다. */
const EXPECTED_DISTANCE: QdrantDistance = "Cosine";

/**
 * TEI로 벡터 차원을 감지하고 컬렉션을 보장한다.
 *
 * 차원을 env에 하드코딩하지 않는 이유: TEI에 뜬 모델과 어긋나면 조용히 틀린 색인이
 * 만들어진다. 시작 시 1회 감지는 fail fast로 첫 항목 처리 전에 문제를 드러낸다.
 *
 * 기존 컬렉션 차원 또는 distance가 다르면 throw한다. 자동 삭제·재생성은 하지 않는다 —
 * 컬렉션을 날리는 것은 파괴적이고 되돌릴 수 없으므로 사람이 결정할 일이다.
 */
export async function ensureCollection(
  qdrant: QdrantStore,
  tei: TeiEmbeddingClient,
  name: string,
): Promise<CollectionInfo> {
  const probe = await tei.embed([PROBE_TEXT]);
  const vectorSize = probe[0]?.length ?? 0;
  if (vectorSize === 0) {
    throw new Error("TEI가 빈 벡터를 반환해 차원을 감지할 수 없습니다.");
  }

  const existing = await qdrant.getCollectionInfo(name);
  if (existing === null) {
    await qdrant.createCollection(name, vectorSize, EXPECTED_DISTANCE);
    return { name, vectorSize, distance: EXPECTED_DISTANCE };
  }
  if (existing.vectorSize !== vectorSize) {
    throw new Error(
      `컬렉션 ${name}의 차원(${existing.vectorSize})이 TEI 모델의 차원(${vectorSize})과 다릅니다. ` +
        `임베딩 모델을 바꿨다면 컬렉션을 직접 삭제하거나 QDRANT_COLLECTION으로 다른 이름을 지정하세요.`,
    );
  }
  if (existing.distance !== EXPECTED_DISTANCE) {
    // 차원 불일치와 같은 종류의 조용한 오류다 — distance를 버리고 넘어가면 Euclid로
    // 만들어진 기존 컬렉션 위에 코사인 정규화 벡터가 그대로 쓰여 검색 품질이 틀어진다.
    throw new Error(
      `컬렉션 ${name}의 distance(${existing.distance})가 예상값(${EXPECTED_DISTANCE})과 다릅니다. ` +
        `컬렉션을 직접 삭제하거나 QDRANT_COLLECTION으로 다른 이름을 지정하세요.`,
    );
  }
  return { name, vectorSize, distance: existing.distance };
}

/**
 * contentid를 Qdrant point id로 변환한다. 숫자가 아니면 null.
 *
 * Qdrant는 point id로 unsigned integer 또는 UUID만 허용한다. contentid 기반의
 * 결정론적 id라서 재실행이 같은 point를 덮어쓴다 — upsert 성공 후 markEmbedDone이
 * 실패해도 다음 실행이 중복 point를 만들지 않는다.
 */
export function toPointId(contentid: string): number | null {
  if (!/^\d+$/.test(contentid)) return null;
  const id = Number(contentid);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Qdrant payload. 필터 키와 최소 표시 필드만 담는다.
 * Postgres가 원본 진실이고 Qdrant는 파생 인덱스이므로 본문을 복제하지 않는다.
 */
export function toPayload(input: EnrichInput): Record<string, unknown> {
  return {
    contentid: input.contentid,
    contenttypeid: input.contenttypeid,
    ldong_regn_cd: input.ldongRegnCd,
    ldong_signgu_cd: input.ldongSignguCd,
    lcls_systm1: input.lclsSystm1,
    lcls_systm2: input.lclsSystm2,
    lcls_systm3: input.lclsSystm3,
    title: input.title,
    mapx: input.mapx,
    mapy: input.mapy,
  };
}
