import type { ItineraryDto } from './itinerary.dto';
import { buildChatResponse, PLAN_STATUSES } from './chat-response.dto';

/**
 * planStatus === 'ready' ⟺ itinerary !== null 불변식이 만들어지는 유일한 지점을
 * 고정한다. 갈래별 라우팅은 chat.service.spec.ts가, HTTP 관통은
 * chat.controller.spec.ts가 따로 본다.
 */

const ITINERARY: ItineraryDto = {
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
};

describe('buildChatResponse — planStatus와 itinerary의 짝', () => {
  it('일정이 있으면 ready이고 그 일정을 참조 그대로 담는다', () => {
    const response = buildChatResponse('준비했어요', ITINERARY);

    expect(response.planStatus).toBe('ready');
    expect(response.itinerary).toBe(ITINERARY);
  });

  it('일정이 null이면 none이고 itinerary가 null이다', () => {
    // 일정을 만드는 갈래가 목적지를 못 알아들었을 때 이 경로를 탄다.
    const response = buildChatResponse('어디로 가고 싶으신가요?', null);

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('일정이 undefined여도 none이고 itinerary가 null이다', () => {
    // ↔ 위 짝. undefined가 그대로 실리면 JSON.stringify가 필드를 지워버리고
    // 프론트의 판별 유니온이 itinerary를 읽을 수 없다. 오늘 undefined를 넘기는
    // 호출자는 없지만, 요청의 itinerary를 다시 읽는 순간 이 경로가 살아난다 —
    // 그때 한쪽만 보면 ready + null이 만들어진다.
    const response = buildChatResponse('어디로 가고 싶으신가요?', undefined);

    expect(response.planStatus).toBe('none');
    expect(response.itinerary).toBeNull();
  });

  it('reply를 손대지 않고 그대로 싣는다', () => {
    expect(buildChatResponse('그대로', null).reply).toBe('그대로');
    expect(buildChatResponse('그대로', ITINERARY).reply).toBe('그대로');
  });

  it('PLAN_STATUSES의 모든 값이 이 팩토리에서 실제로 나온다', () => {
    // 도달 불가능한 상태를 유니온에 미리 넣지 않는다는 결정을 고정한다.
    // drafting을 PLAN_STATUSES에 더하면 이 단정이 그 값을 내는 경로를 요구한다 —
    // 값만 늘고 아무도 만들지 못하는 상태는 소비자에게 죽은 분기가 된다.
    const produced = [
      buildChatResponse('a', null).planStatus,
      buildChatResponse('b', ITINERARY).planStatus,
    ];

    expect([...produced].sort()).toEqual([...PLAN_STATUSES].sort());
  });
});
