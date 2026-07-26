import type { ItineraryDto } from './itinerary.dto';

/**
 * POST /chat 응답 본문. 프론트엔드 frontend/src/lib/mock/scenarios.ts의
 * ScenarioResult와 같은 모양이라, mock을 이 엔드포인트로 바로 교체할 수 있다.
 *
 * 검증 데코레이터가 없으니 클래스일 필요가 없어 인터페이스로 둔다.
 */
export interface ChatResponseDto {
  reply: string;
  itinerary: ItineraryDto;
}
