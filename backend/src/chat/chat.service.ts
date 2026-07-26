import { Injectable } from '@nestjs/common';

import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';

@Injectable()
export class ChatService {
  /**
   * 아직 LLM을 붙이지 않은 스텁이다. 받은 일정을 그대로 돌려주므로
   * 프론트엔드는 계약만 확인할 수 있고 화면의 일정은 바뀌지 않는다.
   *
   * TODO: 대화 이력과 현재 일정을 LLM에 넘겨 reply와 수정된 itinerary를 받는다.
   * 이때 비동기가 되므로 반환 타입이 Promise로 바뀌고, 컨트롤러도 같이 고쳐야 한다.
   */
  chat(request: ChatRequestDto): ChatResponseDto {
    return {
      reply: `"${request.message}" 라고 말씀하셨네요. 일정을 다듬는 기능은 아직 준비 중이에요.`,
      itinerary: request.itinerary,
    };
  }
}
