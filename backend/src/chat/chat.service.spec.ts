import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../clients/external-service.error';
import { ChatService } from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildStructuredReply } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';
import type { StructuredQuery } from './query/structured-query';
import { EMPTY_CONDITIONS } from './query/structured-query';

/**
 * 갈래 라우팅과 위임만 본다. 모킹 경계는 협력자다 — 분류는
 * intent.classifier.spec.ts가, 구조화는 query.structurer.spec.ts가,
 * 문장 서식은 query-reply.spec.ts가 따로 고정한다.
 */

/** buildStructuredReply가 받는 갈래. 두 갈래가 같은 본문을 쓴다. */
type StructuredIntent = 'plan_itinerary' | 'recommend_places';

const classify = jest.fn<Promise<ChatIntent>, [string]>();
const structure = jest.fn<Promise<StructuredQuery>, [string]>();
const respond = jest.fn<Promise<string>, [string]>();

const STRUCTURED: StructuredQuery = {
  queryText: '무엇을 하는 곳: 일출 감상',
  conditions: { ...EMPTY_CONDITIONS, region: '제주' },
  droppedLabels: [],
  fellBackToRawMessage: false,
};

/**
 * OtherResponder가 돌려주는 값. OTHER_REPLY를 쓰지 않는다 — 그 상수는 이제
 * responder 안쪽의 폴백이고, 여기서 쓰면 위임이 끊겨도 값이 같아 통과한다.
 */
const OTHER_RESPONSE =
  '제주는 사계절 모두 좋아요. 어느 계절을 생각하고 계신가요?';

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
      { provide: QueryStructurer, useValue: { structure } },
      { provide: OtherResponder, useValue: { respond } },
    ],
  }).compile();
  return moduleRef.get(ChatService);
}

function quotaFailure(): ExternalServiceError {
  return new ExternalServiceError('gemini', 'quota', '쿼터 소진');
}

beforeEach(() => {
  classify.mockReset();
  structure.mockReset().mockResolvedValue(STRUCTURED);
  respond.mockReset().mockResolvedValue(OTHER_RESPONSE);
});

describe('ChatService — 갈래 라우팅', () => {
  const structuredIntents: StructuredIntent[] = [
    'plan_itinerary',
    'recommend_places',
  ];

  it.each(structuredIntents)(
    '%s는 구조화 결과를 되비춘 문장을 돌려준다',
    async (intent) => {
      classify.mockResolvedValue(intent);
      const service = await createService();

      const response = await service.chat(createRequest('제주 2박3일'));

      // 기대값을 buildStructuredReply로 계산한다. 이 spec이 고정하는 것은 문장
      // 서식이 아니라 "분류된 intent와 구조화 결과를 그대로 넘겼는가"다.
      // 서식 자체는 query-reply.spec.ts가 전문 등가로 고정한다.
      expect(response.reply).toBe(buildStructuredReply(intent, STRUCTURED));
    },
  );

  it('other는 OtherResponder의 응답을 그대로 돌려준다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequest('안녕'));

    expect(response.reply).toBe(OTHER_RESPONSE);
  });

  const allIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
    'other',
  ];

  it.each(allIntents)(
    '%s는 itinerary를 입력 그대로 돌려준다',
    async (intent) => {
      // 참조 동일성까지 본다. 어느 갈래든 아직 일정을 손대지 않는다.
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
});

describe('ChatService — 구조화 위임', () => {
  it('구조화 갈래는 QueryStructurer를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    await service.chat(createRequest('제주 2박3일 가족여행 짜줘'));

    expect(structure).toHaveBeenCalledTimes(1);
    expect(structure).toHaveBeenCalledWith('제주 2박3일 가족여행 짜줘');
  });

  it('↔ 짝: other 갈래는 QueryStructurer를 호출하지 않는다', async () => {
    // 이 케이스가 없으면 분류와 무관하게 늘 구조화하는 구현도 통과한다 —
    // other 한 마디마다 Gemini 왕복이 하나씩 늘어도 아무도 모른다.
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('안녕'));

    expect(structure).not.toHaveBeenCalled();
  });
});

describe('ChatService — 대화 위임', () => {
  it('other 갈래는 OtherResponder를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 어때?'));

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('제주 어때?');
  });

  it('↔ 짝: 구조화 갈래는 OtherResponder를 호출하지 않는다', async () => {
    // 구조화 갈래가 대화 응답까지 부르면 요청 하나에 Gemini 왕복이 셋이 된다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    await service.chat(createRequest('제주 2박3일'));

    expect(respond).not.toHaveBeenCalled();
  });
});

describe('ChatService — 실패를 삼키지 않는다', () => {
  it('분류기가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 여기에 try/catch를 두면 쿼터 소진이 200 + 안내 문구가 되고
    // 전역 필터의 503 + Retry-After가 사라진다.
    const failure = quotaFailure();
    classify.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });

  it('QueryStructurer가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 분류기와 대칭이어야 한다. 한쪽만 고정하면 새로 붙은 호출이 조용히
    // 200 + 조건 미지정 요약으로 축퇴해도 테스트가 초록불을 준다.
    const failure = quotaFailure();
    classify.mockResolvedValue('plan_itinerary');
    structure.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 2박3일'))).rejects.toBe(
      failure,
    );
  });

  it('OtherResponder가 던진 ExternalServiceError를 삼키지 않는다', async () => {
    // 세 협력자에 대해 대칭으로 고정한다. other 갈래는 폴백 문구가 정상 응답과
    // 구별되지 않으므로, 여기서 삼키면 쿼터 소진이 평범한 대화로 보인다.
    const failure = quotaFailure();
    classify.mockResolvedValue('other');
    respond.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('안녕'))).rejects.toBe(failure);
  });
});
