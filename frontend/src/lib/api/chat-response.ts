import type { ChatResponse, Itinerary, PlanStatus } from "../types";

/**
 * 백엔드가 응답에 planStatus를 담지 못했을 때(구버전) 뜬다. 조용히 패널을
 * 숨기는 대신 사용자에게 보이는 실패로 만든다 — page.tsx의 catch가 이 문구를
 * 말풍선으로 띄운다.
 */
export const INVALID_RESPONSE_MESSAGE =
  "서버 응답 형식이 올바르지 않습니다. 관리자에게 문의해주세요.";

const PLAN_STATUSES: readonly PlanStatus[] = ["none", "ready"];

function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

function isItineraryShape(value: unknown): value is Itinerary {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const summary = record.summary;
  if (typeof summary !== "object" || summary === null) return false;
  return Array.isArray(record.days) && record.days.length > 0;
}

/**
 * 알 수 없는 본문을 ChatResponse로 좁힌다. 계약 위반은 throw한다 — 조용한
 * 패널 미표시보다 즉시 드러나는 실패를 택했다(as ScenarioResult 캐스트가
 * 만들던 회귀를 여기서 막는다).
 *
 * itinerary 키 부재는 null로 정규화해 통과시킨다. planStatus가 "ready"인데
 * itinerary가 없거나, "none"인데 itinerary가 있으면 불변식 위반이므로 throw한다.
 * 얕은 가드(summary 객체 + days 비지 않은 배열)만 본다 — 그 아래 필드까지
 * 검증하면 복제 스키마의 두 번째 원천이 프론트에 생긴다. ItineraryPanel의
 * 유일한 크래시 지점(빈 days)은 이 가드로 막힌다.
 */
export function parseChatResponse(body: unknown): ChatResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }

  const record = body as Record<string, unknown>;

  if (typeof record.reply !== "string") {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
  const reply = record.reply;

  if (!isPlanStatus(record.planStatus)) {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
  const planStatus = record.planStatus;

  const itineraryField = record.itinerary;
  const itinerary = itineraryField === undefined ? null : itineraryField;

  if (planStatus === "ready") {
    if (!isItineraryShape(itinerary)) {
      throw new Error(INVALID_RESPONSE_MESSAGE);
    }
    return { reply, planStatus: "ready", itinerary };
  }

  if (itinerary !== null) {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
  return { reply, planStatus: "none", itinerary: null };
}
