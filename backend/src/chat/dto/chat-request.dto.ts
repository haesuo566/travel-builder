import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsString,
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
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsObject()
  @ValidateNested()
  @Type(() => ItineraryDto)
  itinerary: ItineraryDto;
}
