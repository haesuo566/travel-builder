import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../clients/external-service.error';
import {
  ChatService,
  OTHER_REPLY,
  PLAN_ITINERARY_PLACEHOLDER_REPLY,
  RECOMMEND_PLACES_PLACEHOLDER_REPLY,
} from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';

/**
 * 분기 라우팅만 본다. 모킹 경계는 IntentClassifier다 — 분류 자체는
 * intent.classifier.spec.ts가, 파싱은 intent-prompt.spec.ts가 고정한다.
 */

const classify = jest.fn<Promise<ChatIntent>, [string]>();

function createRequest(message: string): ChatRequestDto {
  return {
    message,
    itinerary: {
      summary: {
        destination: '제주',
        duration: '2박 3일',
        travelers: '성인 2명',
      },
      days: [
        {
          day: 1,
          places: [
            {
              id: 'place-1',
              name: '성산일출봉',
              category: '관광지',
              time: '09:00',
              description: '일출 명소',
              pinNumber: 1,
            },
          ],
        },
      ],
    },
  };
}

async function createService(): Promise<ChatService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatService,
      { provide: IntentClassifier, useValue: { classify } },
    ],
  }).compile();
  return moduleRef.get(ChatService);
}

beforeEach(() => {
  classify.mockReset();
});

describe('ChatService', () => {
  const branchCases: Array<[ChatIntent, string]> = [
    ['plan_itinerary', PLAN_ITINERARY_PLACEHOLDER_REPLY],
    ['recommend_places', RECOMMEND_PLACES_PLACEHOLDER_REPLY],
    ['other', OTHER_REPLY],
  ];

  it.each(branchCases)(
    '%s는 그 갈래의 문구를 돌려준다',
    async (intent, expected) => {
      // 세 문구가 서로 다르므로 한 건의 등가 단정이 나머지 두 분기의 부정을 겸한다.
      // arm을 서로 바꾸면 세 케이스 중 둘이 빨간불이 된다.
      classify.mockResolvedValue(intent);
      const service = await createService();

      const response = await service.chat(createRequest('아무 말'));

      expect(response.reply).toBe(expected);
    },
  );

  it.each(branchCases)(
    '%s는 itinerary를 입력 그대로 돌려준다',
    async (intent) => {
      // 참조 동일성까지 본다. 어느 갈래든 지금은 일정을 손대지 않는다.
      classify.mockResolvedValue(intent);
      const service = await createService();
      const request = createRequest('아무 말');

      const response = await service.chat(request);

      expect(response.itinerary).toBe(request.itinerary);
    },
  );

  it('분류기를 message만으로 호출한다', async () => {
    // itinerary·대화 이력을 프롬프트에 싣지 않는다는 결정이 여기서 고정된다.
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 2박3일 일정 짜줘'));

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith('제주 2박3일 일정 짜줘');
  });

  it('분류기가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 여기에 try/catch를 두면 쿼터 소진이 200 + 안내 문구가 되고
    // 전역 필터의 503 + Retry-After가 사라진다.
    const failure = new ExternalServiceError('gemini', 'quota', '쿼터 소진');
    classify.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });
});
