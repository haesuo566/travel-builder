import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../clients/external-service.error';
import { ChatService } from './chat.service';
import type { ChatRequestDto } from './dto/chat-request.dto';
import type { ChatIntent } from './intent/chat-intent';
import { IntentClassifier } from './intent/intent.classifier';
import { OtherResponder } from './other/other.responder';
import { buildMockItinerary } from './plan/mock-itineraries';
import {
  buildPlanReply,
  PLAN_DESTINATION_UNKNOWN_REPLY,
  PLAN_READY_GUIDE,
} from './plan/plan-reply';
import { RECOMMEND_REPLY_HEAD } from './query/query-reply';
import { QueryStructurer } from './query/query.structurer';
import type { StructuredQuery } from './query/structured-query';
import { EMPTY_CONDITIONS } from './query/structured-query';

/**
 * 갈래 라우팅·위임과 갈래별 planStatus만 본다. 모킹 경계는 협력자다 — 분류는
 * intent.classifier.spec.ts가, 구조화는 query.structurer.spec.ts가, 문장 서식은
 * query-reply.spec.ts·plan/plan-reply.spec.ts가, planStatus와 itinerary의 짝은
 * dto/chat-response.dto.spec.ts가 따로 고정한다.
 */

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

/** 목적지 키워드가 걸리는 메시지. mock 일정의 목적지는 제주다. */
const PLAN_MESSAGE = '제주 2박3일 일정 짜줘';

/** 목적지 키워드가 하나도 걸리지 않는 일정 요청. */
const PLAN_MESSAGE_WITHOUT_DESTINATION = '일정 짜줘';

/**
 * 요청에 실려 오는 일정. 목적지를 강릉으로 둔다 — mock 일정 셋(서울·부산·제주)과
 * 겹치면 "요청을 되돌려줬는가"와 "새로 만들었는가"가 목적지로 구별되지 않는다.
 *
 * 호출마다 새 리터럴을 만든다. 모듈 상수를 공유하면 참조 동일성 단정이 통과
 * 근거를 잃는다.
 */
function createRequest(message: string): ChatRequestDto {
  return {
    message,
    itinerary: {
      summary: {
        destination: '강릉',
        duration: '1박 2일',
        travelers: '성인 2명',
      },
      days: [
        {
          day: 1,
          places: [
            {
              id: 'place-1',
              name: '경포해변',
              category: '관광지',
              time: '09:00',
              description: '해돋이 명소',
              pinNumber: 1,
            },
          ],
        },
      ],
    },
  };
}

/** 첫 턴의 요청. itinerary가 optional이 된 뒤 프론트가 실제로 보내는 모양이다. */
function createRequestWithoutItinerary(message: string): ChatRequestDto {
  return { message };
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

describe('ChatService — 갈래별 planStatus와 itinerary', () => {
  it('plan_itinerary는 목적지를 알아들으면 새 일정을 ready로 돌려준다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary?.summary.destination).toBe('제주');
    expect(response.itinerary?.days).toHaveLength(3);
  });

  it('↔ 짝: recommend_places는 같은 요청에서 none이다', async () => {
    // 위 케이스와 요청이 완전히 같고 분류값만 다르다. 두 갈래의 case 핸들러가
    // 뒤바뀌면 이 짝이 잡는다 — 과거에 정확히 그 뒤바뀜이 미커밋 상태로 있었고,
    // 갈래별 응답이 없어서 테스트가 초록불이었다.
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('plan_itinerary는 목적지를 못 알아들으면 none이다', async () => {
    // 기본 목적지로 폴백하지 않는다(게이트 1 Q4). 같은 intent가 메시지에 따라
    // ready/none으로 갈리며, 판정 입력은 (intent, 목적지 매칭 여부) 둘이고
    // 둘 다 Gemini 추가 호출 없이 결정론적이다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE_WITHOUT_DESTINATION),
    );

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('other는 none이다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequestWithoutItinerary('안녕'));

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  const allIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
    'other',
  ];

  it.each(allIntents)(
    '%s는 요청의 일정을 응답에 싣지 않는다',
    async (intent) => {
      // 게이트 1 Q3의 결정이다. 요청에 강릉 일정을 실어 보내도 응답에 강릉이
      // 나타나지 않는다 — plan 갈래는 자기가 만든 일정을, 나머지 둘은 null을 낸다.
      // 이 단정이 없으면 어느 갈래가 요청을 되돌려주기 시작해도 아무도 모르고,
      // planStatus를 만드는 지점이 조용히 둘로 늘어난다.
      classify.mockResolvedValue(intent);
      const service = await createService();
      const request = createRequest(PLAN_MESSAGE);

      const response = await service.chat(request);

      expect(response.itinerary).not.toBe(request.itinerary);
      expect(response.itinerary?.summary.destination).not.toBe('강릉');
    },
  );

  it('plan_itinerary는 요청에 일정이 있어도 자기가 만든 일정을 낸다', async () => {
    // ↔ 위 짝의 긍정형. "요청 일정이 아니다"만으로는 null을 내는 구현도 통과한다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(createRequest(PLAN_MESSAGE));

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary?.summary.destination).toBe('제주');
  });
});

describe('ChatService — 갈래별 reply', () => {
  it('plan_itinerary는 준비된 일정을 알리는 문장을 돌려준다', async () => {
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE),
    );

    expect(response.reply).toBe(
      buildPlanReply(buildMockItinerary(PLAN_MESSAGE)),
    );
    // 위 단정만으로는 두 함수가 함께 망가져도 통과한다. 문장에 목적지와
    // 맺음말이 실제로 실렸는지 따로 센다.
    expect(response.reply).toContain('제주');
    expect(response.reply).toContain(PLAN_READY_GUIDE);
  });

  it('plan_itinerary는 목적지를 못 알아들으면 무엇을 알려달라고 말한다', async () => {
    // none이면서 아무 설명이 없으면 사용자는 서비스가 고장난 것과 구별할 수 없다.
    classify.mockResolvedValue('plan_itinerary');
    const service = await createService();

    const response = await service.chat(
      createRequestWithoutItinerary(PLAN_MESSAGE_WITHOUT_DESTINATION),
    );

    expect(response.reply).toBe(PLAN_DESTINATION_UNKNOWN_REPLY);
  });

  it('recommend_places는 구조화 결과를 되비춘 문장을 돌려준다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    const response = await service.chat(createRequest('제주 관광지 추천해줘'));

    // 서식 전문은 query-reply.spec.ts가 고정한다. 여기서 보는 것은 "구조화
    // 결과가 실제로 문장에 실렸는가"다 — STRUCTURED의 region이 문구까지
    // 도달하지 않으면 구조화 폴백이 발동해도 머리말 단정만으로는 통과한다.
    expect(response.reply).toContain(RECOMMEND_REPLY_HEAD);
    expect(response.reply).toContain('지역: 제주');
  });

  it('other는 OtherResponder의 응답을 그대로 돌려준다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    const response = await service.chat(createRequest('안녕'));

    expect(response.reply).toBe(OTHER_RESPONSE);
  });

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
  it('recommend_places는 QueryStructurer를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('recommend_places');
    const service = await createService();

    await service.chat(createRequest('제주 가족여행 관광지 추천'));

    expect(structure).toHaveBeenCalledTimes(1);
    expect(structure).toHaveBeenCalledWith('제주 가족여행 관광지 추천');
  });

  const nonStructuringIntents: ChatIntent[] = ['plan_itinerary', 'other'];

  it.each(nonStructuringIntents)(
    '↔ 짝: %s는 QueryStructurer를 호출하지 않는다',
    async (intent) => {
      // plan 갈래는 목적지를 원문 키워드로 고르므로 구조화 결과를 쓰지 않는다.
      // 부르면 결과를 버리는 Gemini 왕복이 하나 늘고, 그 왕복의 쿼터 소진이
      // 돌려줄 수 있었던 요청을 503으로 만든다.
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(structure).not.toHaveBeenCalled();
    },
  );
});

describe('ChatService — 대화 위임', () => {
  it('other 갈래는 OtherResponder를 message만으로 한 번 호출한다', async () => {
    classify.mockResolvedValue('other');
    const service = await createService();

    await service.chat(createRequest('제주 어때?'));

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('제주 어때?');
  });

  const nonChattingIntents: ChatIntent[] = [
    'plan_itinerary',
    'recommend_places',
  ];

  it.each(nonChattingIntents)(
    '↔ 짝: %s는 OtherResponder를 호출하지 않는다',
    async (intent) => {
      classify.mockResolvedValue(intent);
      const service = await createService();

      await service.chat(createRequest(PLAN_MESSAGE));

      expect(respond).not.toHaveBeenCalled();
    },
  );
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
    classify.mockResolvedValue('recommend_places');
    structure.mockRejectedValue(failure);
    const service = await createService();

    await expect(service.chat(createRequest('제주 관광지'))).rejects.toBe(
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
