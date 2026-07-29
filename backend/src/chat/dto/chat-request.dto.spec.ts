import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';

import { ChatRequestDto } from './chat-request.dto';

/**
 * whitelist 동작을 고정한다.
 *
 * 이 계약은 예전에 chat.controller.spec.ts가 "요청 itinerary를 그대로 되돌려준
 * 응답에 심어 둔 필드가 없다"로 셌다. 이제 어느 갈래도 요청 일정을 되돌려주지
 * 않으므로 그 관측 창이 닫혔다 — 파이프를 직접 불러 대신 센다.
 *
 * 여기서 만든 파이프가 app.setup.ts의 것과 같은 옵션이어야 한다. 그 두 곳이
 * 어긋나는 것은 이 테스트가 잡지 못한다(리스크 절에 기록).
 */
function createPipe(): ValidationPipe {
  return new ValidationPipe({ whitelist: true, transform: true });
}

async function transformBody(body: object): Promise<unknown> {
  // any 반환을 unknown으로 받는다. 타입 있는 변수에 담으면 no-unsafe-assignment가
  // error다. as 캐스팅은 반대 방향이다 — 오타를 그대로 통과시킨다.
  return createPipe().transform(body, {
    type: 'body',
    metatype: ChatRequestDto,
  });
}

const ITINERARY = {
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

describe('ChatRequestDto — whitelist', () => {
  it('DTO에 없는 최상위 속성을 제거한다', async () => {
    const transformed = await transformBody({
      message: '안녕하세요',
      unexpected: '제거돼야 한다',
    });

    expect(transformed).not.toHaveProperty('unexpected');
    // 남아야 하는 것을 함께 센다. 전부 지우는 구현도 위 단정만으로는 통과한다.
    expect(transformed).toHaveProperty('message', '안녕하세요');
  });

  it('중첩된 일정 안의 속성도 제거한다', async () => {
    const transformed = await transformBody({
      message: '제주 2박3일',
      itinerary: { ...ITINERARY, unexpected: '제거돼야 한다' },
    });

    expect(transformed).toHaveProperty('itinerary');
    expect(transformed).not.toHaveProperty('itinerary.unexpected');
    expect(transformed).toHaveProperty('itinerary.summary.destination', '제주');
  });
});

describe('ChatRequestDto — itinerary는 optional이지만 검증은 살아 있다', () => {
  it('itinerary가 없어도 통과한다', async () => {
    await expect(transformBody({ message: '안녕하세요' })).resolves.toEqual({
      message: '안녕하세요',
    });
  });

  it('itinerary가 명시적 null이어도 통과하고 값이 null로 남는다', async () => {
    // @IsOptional()이 null도 통과시킨다(실측). 응답 쪽에서 이 값을 일정이 있는
    // 것으로 취급하면 planStatus가 어긋나므로 buildChatResponse가 둘을 함께 받는다.
    await expect(
      transformBody({ message: '안녕하세요', itinerary: null }),
    ).resolves.toEqual({ message: '안녕하세요', itinerary: null });
  });

  it('↔ 짝: itinerary가 있으면 잘못된 모양을 여전히 거부한다', async () => {
    // @IsOptional()이 값이 있을 때도 검증을 건너뛰면 이 단정이 깨진다.
    await expect(
      transformBody({ message: '제주 2박3일', itinerary: { summary: {} } }),
    ).rejects.toThrow();
  });
});
