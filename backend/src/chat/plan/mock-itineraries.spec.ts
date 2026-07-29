import { buildMockItinerary } from './mock-itineraries';

/**
 * 목적지 선택과 **일정의 내용**을 함께 센다.
 *
 * 내용을 세지 않으면 빈 days를 돌려주는 데이터로도 planStatus: 'ready'가
 * 통과하고, 프론트는 빈 패널을 띄운다 — fixture가 조용히 썩는 것을 잡을
 * 유일한 방어선이다(a490424와 같은 위험).
 */

describe('buildMockItinerary — 목적지 선택', () => {
  it('제주가 들어오면 제주 일정을 돌려준다', () => {
    expect(buildMockItinerary('제주 2박3일 짜줘')?.summary.destination).toBe(
      '제주',
    );
  });

  it("'제주도'도 같은 제주 일정으로 간다", () => {
    expect(buildMockItinerary('제주도 여행 일정')?.summary.destination).toBe(
      '제주',
    );
  });

  it('부산이 들어오면 부산 일정을 돌려준다', () => {
    expect(buildMockItinerary('부산 2박3일 짜줘')?.summary.destination).toBe(
      '부산',
    );
  });

  it('서울이 들어오면 서울 일정을 돌려준다', () => {
    // 세 목적지를 전부 옮긴 근거가 이 테스트다. 키를 빼면 정상 요청이
    // planStatus: 'none'이 되고 사용자에게는 패널이 안 뜨는 것으로 보인다.
    expect(buildMockItinerary('서울 2박3일 짜줘')?.summary.destination).toBe(
      '서울',
    );
  });

  it('아는 목적지가 없으면 null이다', () => {
    // 기본 목적지로 폴백하지 않는다(게이트 1 Q4). 폴백하면 '일정 짜줘' 한 마디에
    // 엉뚱한 도시의 일정이 패널에 뜨고 사용자는 자기가 요청한 것이라고 믿는다.
    expect(buildMockItinerary('울란바토르 일정 짜줘')).toBeNull();
  });

  it('↔ 짝: 목적지가 없는 요청은 어떤 일정도 만들지 않는다', () => {
    // 위 단정이 '울란바토르'라는 특정 단어에만 반응하는 구현으로 통과하지
    // 않게 한다. 목적지 없는 평범한 일정 요청이 같은 결과여야 한다.
    expect(buildMockItinerary('일정 짜줘')).toBeNull();
    expect(buildMockItinerary('여행 계획 만들어줘')).toBeNull();
  });
});

describe('buildMockItinerary — 일정의 내용', () => {
  const messages = ['서울', '부산', '제주'];

  it.each(messages)('%s 일정에 빈 날이 없다', (message) => {
    const itinerary = buildMockItinerary(message);

    expect(itinerary).not.toBeNull();
    expect(itinerary?.days.length).toBeGreaterThan(0);
    for (const day of itinerary?.days ?? []) {
      expect(day.places.length).toBeGreaterThan(0);
    }
  });

  it.each(messages)('%s 일정의 요약 세 필드가 비어 있지 않다', (message) => {
    const summary = buildMockItinerary(message)?.summary;

    expect(summary?.destination.length).toBeGreaterThan(0);
    expect(summary?.duration.length).toBeGreaterThan(0);
    expect(summary?.travelers.length).toBeGreaterThan(0);
  });

  it('제주 일정은 3일이고 날마다 3·4·2개 장소를 갖는다', () => {
    const days = buildMockItinerary('제주')?.days ?? [];

    expect(days.map((day) => day.day)).toEqual([1, 2, 3]);
    expect(days.map((day) => day.places.length)).toEqual([3, 4, 2]);
  });

  it.each(messages)('%s 일정의 핀 번호가 날마다 1부터 이어진다', (message) => {
    // 지도 핀이 이 번호로 찍힌다. 0이나 중복이 섞이면 화면에서만 드러난다.
    const days = buildMockItinerary(message)?.days ?? [];

    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      const expected = day.places.map((_place, index) => index + 1);
      expect(day.places.map((place) => place.pinNumber)).toEqual(expected);
    }
  });
});

describe('buildMockItinerary — 요청 간 오염', () => {
  it('앞 호출의 결과를 변형해도 다음 호출이 원본을 돌려준다', () => {
    // 모듈 스코프 상수를 응답에 참조 그대로 실으면 누군가 한 번 변형하는 순간
    // 이후 모든 요청이 오염된다(structured-query.ts:86-88이 EMPTY_CONDITIONS에
    // 전개를 요구하는 것과 같은 위험). 얕은 전개는 days·places를 공유하므로
    // 이 테스트를 통과하지 못한다.
    const first = buildMockItinerary('제주');
    expect(first).not.toBeNull();
    if (first === null) {
      return;
    }
    first.summary.destination = '오염됨';
    first.days[0].places[0].name = '오염됨';
    first.days.length = 1;

    const second = buildMockItinerary('제주');

    expect(second?.summary.destination).toBe('제주');
    expect(second?.days[0].places[0].name).toBe('성산일출봉');
    expect(second?.days).toHaveLength(3);
  });
});
