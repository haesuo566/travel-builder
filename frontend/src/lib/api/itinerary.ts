import type { Itinerary } from "../types";
import { getDefaultItinerary } from "../mock/itineraries";
import type { ScenarioResult } from "../mock/scenarios";

/**
 * 최초 일정은 아직 mock이다. 백엔드에 대응 엔드포인트(GET /itinerary류)가 없고,
 * 만드는 것은 backend 워크스페이스 작업이라 이번 범위 밖이다.
 */
export async function getItinerary(): Promise<Itinerary> {
  return getDefaultItinerary();
}

/** 서버가 사용자에게 보여줄 문구를 주지 못했을 때 쓴다. */
const FALLBACK_ERROR_MESSAGE =
  "서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.";

/**
 * 백엔드 origin. `process.env.NEXT_PUBLIC_API_BASE_URL`을 구조분해 없이 직접
 * 참조해야 Next.js가 빌드 시점에 값을 인라인한다.
 *
 * 기본값을 두지 않는 이유: `http://localhost:3001`로 조용히 폴백하면 배포 빌드에서
 * 브라우저가 사용자 PC를 향해 요청을 보내고, 설정 누락이 "연결 실패"로 위장된다.
 */
function resolveApiBaseUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL이 설정되지 않았습니다. frontend/.env.local에 백엔드 origin을 지정하세요."
    );
  }
  return baseUrl;
}

/**
 * 한 턴의 대화를 백엔드에 넘긴다. 서버는 무상태이므로 현재 일정을 매번 함께 보낸다
 * (backend/src/chat/dto/chat-request.dto.ts).
 */
export async function sendMessage(
  message: string,
  currentItinerary: Itinerary
): Promise<ScenarioResult> {
  const baseUrl = resolveApiBaseUrl();

  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, itinerary: currentItinerary }),
  });

  if (!response.ok) {
    throw new Error(FALLBACK_ERROR_MESSAGE);
  }

  return (await response.json()) as ScenarioResult;
}
