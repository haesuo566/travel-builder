// 순수 spec이다. query-reply → query-prompt → dto/itinerary.dto 경로로
// class-validator 데코레이터가 평가되므로 폴리필을 직접 들여온다
// (query-prompt.spec.ts와 같은 이유).
import 'reflect-metadata';

import {
  buildRecommendReply,
  NO_CONDITIONS_SUMMARY,
  RECOMMEND_NO_HITS_TAIL,
  RECOMMEND_NOT_SEARCHED_TAIL,
  RECOMMEND_PLACES_HEAD,
  RECOMMEND_REPLY_HEAD,
} from './query-reply';
import type { QueryConditions, StructuredQuery } from './structured-query';
import { EMPTY_CONDITIONS, QUERY_LABELS } from './structured-query';

/**
 * 이 문구가 유일하게 하는 일은 "구조화가 무엇을 뽑았는지"를 사람 눈에 보여주는
 * 것이다. queryText는 이번 실행에서 아무도 소비하지 않으므로, 이 파일과
 * query-prompt.spec.ts가 산출물의 유일한 방어선이다.
 *
 * plan_itinerary 문장 틀은 여기 없다 — 그 갈래는 일정을 실제로 돌려주고
 * plan/plan-reply.spec.ts가 그 문구를 고정한다. 두 갈래 문구가 서로 다르다는
 * 짝도 그쪽으로 옮겼다.
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

describe('buildRecommendReply — 문장 틀', () => {
  it('추천 문장 틀로 시작하고 끝난다', () => {
    const reply = buildRecommendReply(
      createQuery({ region: '부산', category: '관광지' }),
      ['해운대해수욕장', '감천문화마을'],
    );

    expect(reply).toBe(
      '장소 추천 요청으로 이해했어요 — 지역: 부산 · 분류: 관광지. 이런 곳은 어때요? 해운대해수욕장, 감천문화마을',
    );
  });
});

describe('buildRecommendReply — 조건 요약', () => {
  it('다섯 조건이 고정 순서로 나타난다', () => {
    // 전문 등가 단정이 순서와 구분자를 함께 고정한다. 순서가 바뀌면 이 한 건이 깨진다.
    const reply = buildRecommendReply(
      createQuery({
        region: '제주',
        district: '서귀포시',
        category: '관광지',
        durationDays: 3,
        travelers: '가족',
      }),
      [],
    );

    expect(reply).toContain(
      '지역: 제주 · 구역: 서귀포시 · 분류: 관광지 · 기간: 3일 · 동반자: 가족',
    );
  });

  it('null 필드는 요약에 나타나지 않는다', () => {
    const reply = buildRecommendReply(createQuery({ category: '음식점' }), []);

    expect(reply).toContain('분류: 음식점');
    expect(reply).not.toContain('지역:');
    expect(reply).not.toContain('구역:');
    expect(reply).not.toContain('기간:');
    expect(reply).not.toContain('동반자:');
  });

  it('조건이 전부 null이면 미지정 문구가 나타난다', () => {
    const reply = buildRecommendReply(createQuery(), []);

    expect(reply).toBe(
      `${RECOMMEND_REPLY_HEAD} — ${NO_CONDITIONS_SUMMARY}. ${RECOMMEND_NO_HITS_TAIL}`,
    );
  });

  it('색인 라벨이 하나도 나타나지 않는다', () => {
    // 내부 포맷 노출 방어. 7개 라벨이 화면에 나가면 그 포맷이 UI 계약이 되고,
    // core 라벨을 따라 바꾸는 것이 프론트 변경을 요구하게 된다.
    const reply = buildRecommendReply(
      createQuery({ region: '제주', travelers: '가족', durationDays: 2 }),
      [],
    );

    for (const label of QUERY_LABELS) {
      expect(reply).not.toContain(label);
    }
  });
});

describe('buildRecommendReply — 폴백을 문구에 싣지 않는다', () => {
  it('fellBackToRawMessage가 true여도 false와 결과가 같다', () => {
    // 폴백의 관측 수단은 warn 로그 하나다. 문구에 실으면 내부 판정이 UI로 새고,
    // 사용자는 자기가 뭘 잘못했는지 알 수 없는 문장을 받는다.
    const conditions = { region: '제주' };

    expect(buildRecommendReply(createQuery(conditions, true), ['우도'])).toBe(
      buildRecommendReply(createQuery(conditions), ['우도']),
    );
  });

  it('↔ 짝: 조건이 다르면 폴백 여부와 무관하게 결과가 다르다', () => {
    // 위 단정이 "항상 같은 문자열을 낸다"는 구현으로도 통과하지 않게 한다.
    expect(
      buildRecommendReply(createQuery({ region: '제주' }, true), ['우도']),
    ).not.toBe(
      buildRecommendReply(createQuery({ region: '부산' }, true), ['우도']),
    );
  });
});

describe('buildRecommendReply — 검색 결과', () => {
  it('찾은 장소 이름을 순서대로 싣는다', () => {
    // Qdrant가 점수 내림차순으로 돌려주므로 순서 자체가 정보다. 정렬하거나
    // 뒤집으면 가장 가까운 장소가 목록 끝으로 밀린다.
    const reply = buildRecommendReply(createQuery({ region: '제주' }), [
      '성산일출봉',
      '우도',
      '협재해변',
    ]);

    expect(reply).toContain(
      `${RECOMMEND_PLACES_HEAD} 성산일출봉, 우도, 협재해변`,
    );
  });

  it('hit이 없으면 찾지 못했다고 말한다', () => {
    const reply = buildRecommendReply(createQuery({ region: '제주' }), []);

    expect(reply).toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('검색을 못 한 경우는 hit 0건과 다른 문구다', () => {
    // ↔ 위 짝. 둘을 같은 문구로 뭉개면 "검색 재료를 못 만들었다"가 "조건에 맞는
    // 장소가 없다"로 둔갑한다 — 사용자는 조건을 바꿔 보지만 원인은 질의 쪽이라
    // 몇 번을 고쳐도 같은 답을 받는다.
    const notSearched = buildRecommendReply(
      createQuery({ region: '제주' }),
      null,
    );
    const noHits = buildRecommendReply(createQuery({ region: '제주' }), []);

    expect(notSearched).toContain(RECOMMEND_NOT_SEARCHED_TAIL);
    expect(notSearched).not.toBe(noHits);
    expect(notSearched).not.toContain(RECOMMEND_NO_HITS_TAIL);
  });

  it('검색을 못 해도 조건 요약은 그대로 싣는다', () => {
    // 검색이 없었다는 사실이 "무엇으로 이해했는지"까지 지우면 안 된다 —
    // 사용자가 다시 물을 때 무엇을 고쳐야 할지 판단할 재료가 사라진다.
    const reply = buildRecommendReply(
      createQuery({ region: '제주', category: '음식점' }),
      null,
    );

    expect(reply).toContain('지역: 제주 · 분류: 음식점');
  });

  it('빈 이름은 목록에서 빠진다', () => {
    // title은 payload에 없으면 ''로 보정된다(parseTourContentPayload). 그대로
    // 이으면 화면에 구분자만 남은 빈 칸이 생긴다.
    const reply = buildRecommendReply(createQuery({ region: '제주' }), [
      '성산일출봉',
      '   ',
      '우도',
    ]);

    expect(reply).toContain(`${RECOMMEND_PLACES_HEAD} 성산일출봉, 우도`);
  });

  it('이름이 전부 비어 있으면 hit 0건과 같은 문구다', () => {
    // 보여줄 이름이 하나도 없다는 점에서 사용자가 받는 사실은 같다. 검색을
    // 돌렸다는 사실과 어긋나는지는 hit 수 로그로 대조한다(ChatService).
    const reply = buildRecommendReply(createQuery({ region: '제주' }), [
      '',
      ' ',
    ]);

    expect(reply).toContain(RECOMMEND_NO_HITS_TAIL);
  });
});
