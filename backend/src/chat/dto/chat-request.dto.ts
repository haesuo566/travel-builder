import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
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

  @IsObject()
  @ValidateNested()
  @Type(() => ItineraryDto)
  itinerary: ItineraryDto;
}
