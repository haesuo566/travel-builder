// 순수 spec이다. query-reply → query-prompt → dto/itinerary.dto 경로로
// class-validator 데코레이터가 평가되므로 폴리필을 직접 들여온다
// (query-prompt.spec.ts와 같은 이유).
import 'reflect-metadata';

import {
  buildStructuredReply,
  NO_CONDITIONS_SUMMARY,
  PLAN_REPLY_HEAD,
  RECOMMEND_REPLY_HEAD,
} from './query-reply';
import type { QueryConditions, StructuredQuery } from './structured-query';
import { EMPTY_CONDITIONS, QUERY_LABELS } from './structured-query';

/**
 * 이 문구가 유일하게 하는 일은 "구조화가 무엇을 뽑았는지"를 사람 눈에 보여주는
 * 것이다. queryText는 이번 실행에서 아무도 소비하지 않으므로, 이 파일과
 * query-prompt.spec.ts가 산출물의 유일한 방어선이다.
 */

function createQuery(
  conditions: Partial<QueryConditions> = {},
  fellBackToRawMessage = false,
): StructuredQuery {
  return {
    queryText: '무엇을 하는 곳: 산책',
    conditions: { ...EMPTY_CONDITIONS, ...conditions },
    droppedLabels: [],
    fellBackToRawMessage,
  };
}

describe('buildStructuredReply — 갈래별 문장 틀', () => {
  it('plan_itinerary와 recommend_places의 결과가 서로 다르다', () => {
    // 경로 스모크가 "세 갈래가 갈린다"를 판정하는 근거다. 두 문장 틀이 같아지면
    // switch의 arm을 바꿔도 아무 테스트가 깨지지 않는다.
    const query = createQuery({ region: '제주' });

    expect(buildStructuredReply('plan_itinerary', query)).not.toBe(
      buildStructuredReply('recommend_places', query),
    );
  });

  it('plan_itinerary는 일정 문장 틀로 시작하고 끝난다', () => {
    const reply = buildStructuredReply(
      'plan_itinerary',
      createQuery({ region: '제주', durationDays: 3, travelers: '가족' }),
    );

    expect(reply).toBe(
      '일정 요청으로 이해했어요 — 지역: 제주 · 기간: 3일 · 동반자: 가족. 장소를 찾아 일정을 짜는 단계는 다음에 붙습니다.',
    );
  });

  it('recommend_places는 추천 문장 틀로 시작하고 끝난다', () => {
    const reply = buildStructuredReply(
      'recommend_places',
      createQuery({ region: '부산', category: '관광지' }),
    );

    expect(reply).toBe(
      '장소 추천 요청으로 이해했어요 — 지역: 부산 · 분류: 관광지. 조건에 맞는 장소를 찾는 단계는 다음에 붙습니다.',
    );
  });
});

describe('buildStructuredReply — 조건 요약', () => {
  it('다섯 조건이 고정 순서로 나타난다', () => {
    // 전문 등가 단정이 순서와 구분자를 함께 고정한다. 순서가 바뀌면 이 한 건이 깨진다.
    const reply = buildStructuredReply(
      'plan_itinerary',
      createQuery({
        region: '제주',
        district: '서귀포시',
        category: '관광지',
        durationDays: 3,
        travelers: '가족',
      }),
    );

    expect(reply).toContain(
      '지역: 제주 · 구역: 서귀포시 · 분류: 관광지 · 기간: 3일 · 동반자: 가족',
    );
  });

  it('null 필드는 요약에 나타나지 않는다', () => {
    const reply = buildStructuredReply(
      'recommend_places',
      createQuery({ category: '음식점' }),
    );

    expect(reply).toContain('분류: 음식점');
    expect(reply).not.toContain('지역:');
    expect(reply).not.toContain('구역:');
    expect(reply).not.toContain('기간:');
    expect(reply).not.toContain('동반자:');
  });

  it('조건이 전부 null이면 미지정 문구가 나타난다', () => {
    const reply = buildStructuredReply('plan_itinerary', createQuery());

    expect(reply).toBe(
      `${PLAN_REPLY_HEAD} — ${NO_CONDITIONS_SUMMARY}. 장소를 찾아 일정을 짜는 단계는 다음에 붙습니다.`,
    );
  });

  it('색인 라벨이 하나도 나타나지 않는다', () => {
    // 내부 포맷 노출 방어. 7개 라벨이 화면에 나가면 그 포맷이 UI 계약이 되고,
    // core 라벨을 따라 바꾸는 것이 프론트 변경을 요구하게 된다.
    const reply = buildStructuredReply(
      'plan_itinerary',
      createQuery({ region: '제주', travelers: '가족', durationDays: 2 }),
    );

    for (const label of QUERY_LABELS) {
      expect(reply).not.toContain(label);
    }
  });
});

describe('buildStructuredReply — 폴백을 문구에 싣지 않는다', () => {
  it('fellBackToRawMessage가 true여도 false와 결과가 같다', () => {
    // 폴백의 관측 수단은 warn 로그 하나다. 문구에 실으면 내부 판정이 UI로 새고,
    // 사용자는 자기가 뭘 잘못했는지 알 수 없는 문장을 받는다.
    const conditions = { region: '제주' };

    expect(
      buildStructuredReply('plan_itinerary', createQuery(conditions, true)),
    ).toBe(buildStructuredReply('plan_itinerary', createQuery(conditions)));
  });

  it('↔ 짝: 갈래가 다르면 폴백 여부와 무관하게 결과가 다르다', () => {
    // 위 단정이 "항상 같은 문자열을 낸다"는 구현으로도 통과하지 않게 한다.
    expect(
      buildStructuredReply('plan_itinerary', createQuery({}, true)),
    ).not.toBe(buildStructuredReply('recommend_places', createQuery({}, true)));
    expect(RECOMMEND_REPLY_HEAD).not.toBe(PLAN_REPLY_HEAD);
  });
});
