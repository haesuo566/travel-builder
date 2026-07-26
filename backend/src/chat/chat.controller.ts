import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { ChatService } from './chat.service';
// 값 import여야 한다. `import type`으로 바꾸면 emitDecoratorMetadata가 남기는
// 파라미터 타입이 사라지고, ValidationPipe는 metatype이 없으면 검증을 조용히
// 건너뛴다 — 테스트가 아니라 런타임에서만 드러나는 종류의 실수다.
import { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatResponseDto } from './dto/chat-response.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  // @Post는 기본이 201 Created다. 새 리소스에 URI를 부여하는 게 아니라
  // 답변을 계산해 돌려주는 것이므로 200 OK로 맞춘다.
  @Post()
  @HttpCode(HttpStatus.OK)
  chat(@Body() body: ChatRequestDto): ChatResponseDto {
    return this.chatService.chat(body);
  }
}
