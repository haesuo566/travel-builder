import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ItineraryDto } from './itinerary.dto';

/**
 * POST /chat 요청 본문.
 *
 * 일정 상태는 프론트엔드가 들고 있고 매 요청에 실어 보낸다 —
 * 서버는 무상태다. 서버가 대화 이력을 보관하게 되면 이 계약을 바꿔야 한다.
 */
export class ChatRequestDto {
  /**
   * 상한이 없으면 긴 메시지가 우리 책임에서 외부 책임으로 오청구된다 —
   * 100KB 메시지가 그대로 프롬프트에 실려 Gemini에서 400 INVALID_ARGUMENT를
   * 받고 invalid-request → 502가 된다. 여기서 끊으면 400이 되고 Gemini 호출도
   * 과금도 발생하지 않는다. 채팅 한 턴의 입력이며 프론트엔드 mock의 예시 입력은
   * 모두 20자 이내다 — 실사용을 방해하면 올리는 것은 한 줄이다.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;

  /**
   * 첫 턴에는 일정이 없다. 필수로 두면 프론트가 일정 없이 대화를 시작할 수 없어
   * 400이 되고, 그러면 응답의 planStatus가 'none'이 되는 경로 자체가 도달
   * 불가능해진다 — 필드가 의미를 갖지 못한다.
   *
   * **서버는 이 값을 아직 읽지 않는다.** 응답의 일정은 plan 갈래가 새로 만든다
   * (게이트 1 Q3). 그래도 받아 두는 이유는 INTENT_DESCRIPTIONS가 "이미 만들어진
   * 일정을 고쳐 달라는 요청"도 plan_itinerary로 분류하기 때문이다 — 그 요청을
   * 실제로 처리하려면 직전 일정이 반드시 필요하고, 그때 계약을 다시 열면
   * 프론트도 함께 고쳐야 한다. 지금 지우면 whitelist가 프론트가 보낸 값을
   * 400도 로그도 없이 조용히 버린다.
   *
   * @IsOptional은 값이 없을 때만 나머지 검증을 건너뛴다. 값이 오면 여전히
   * 중첩 검증이 걸리므로 잘못된 모양의 일정은 그대로 400이다.
   *
   * 타입에 null을 담는 이유는 @IsOptional이 **명시적 null도 통과시키고 값을
   * null로 남기기** 때문이다(실측). undefined만 선언하면 타입이 런타임을 속인다.
   */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ItineraryDto)
  itinerary?: ItineraryDto | null;
}
