// buildConditionSummary를 거쳐 query-prompt → dto/itinerary.dto 경로로
// class-validator 데코레이터가 평가된다. 폴리필을 직접 들여온다
// (query-reply.spec.ts와 같은 이유).
import 'reflect-metadata';

import { buildRecommendReply } from '../query/query-reply';
import type { StructuredQuery } from '../query/structured-query';
import { EMPTY_CONDITIONS } from '../query/structured-query';
import {
  buildPlanReply,
  PLAN_NO_HITS_TAIL,
  PLAN_NOT_ASSEMBLED_NOTE,
  PLAN_NOT_SEARCHED_TAIL,
  PLAN_PLACES_HEAD,
  PLAN_REPLY_HEAD,
} from './plan-reply';

function createQuery(
  conditions: Partial<StructuredQuery['conditions']> = {},
): StructuredQuery {
  return {
    queryText: '무엇을 하는 곳: 일출 감상',
    conditions: { ...EMPTY_CONDITIONS, ...conditions },
    droppedLabels: [],
    fellBackToRawMessage: false,
  };
}

const JEJU = createQuery({ region: '제주' });

describe('buildPlanReply — 찾은 장소를 알리는 문장', () => {
  it('조건 요약과 장소 이름을 한 문장으로 잇는다', () => {
    // 전문 등가로 고정한다. 문구를 고치면 이 한 건이 깨지고, 그게 노출 문구를
    // 바꿨다는 유일한 신호다.
    const reply = buildPlanReply(JEJU, ['한라산', '성산일출봉']);

    expect(reply).toBe(
      `${PLAN_REPLY_HEAD} — 지역: 제주. ${PLAN_PLACES_HEAD} 한라산, 성산일출봉 ${PLAN_NOT_ASSEMBLED_NOTE}`,
    );
  });

  it('조건이 바뀌면 요약도 바뀐다', () => {
    // 위 단정이 "항상 같은 문자열을 낸다"는 구현으로도 통과하지 않게 한다.
    const reply = buildPlanReply(createQuery({ region: '부산' }), ['해운대']);

    expect(reply).toContain('지역: 부산');
    expect(reply).not.toContain('제주');
  });

  it('조건이 하나도 없으면 미지정으로 적는다', () => {
    // 못 알아들었다는 사실을 숨기지 않는다. 요약이 통째로 사라지면 사용자는
    // 무엇을 고쳐야 하는지 판단할 근거를 잃는다.
    expect(buildPlanReply(createQuery(), ['한라산'])).toContain('조건: 미지정');
  });
});

describe('buildPlanReply — 장소를 찾지 못했을 때', () => {
  it('hit이 0건이면 찾지 못했다고 말한다', () => {
    expect(buildPlanReply(JEJU, [])).toContain(PLAN_NO_HITS_TAIL);
  });

  it('↔ 짝: 검색을 못 했으면 0건과 다른 문구를 쓴다', () => {
    // null은 "검색을 못 했다"(질의 벡터가 없었다)이고 빈 배열은 "검색했는데
    // 없다"이다 — 뭉개면 사용자가 조건을 고쳐도 원인이 질의 쪽이라 몇 번을
    // 시도해도 같은 답을 받는다(query-reply.ts의 같은 경계).
    const notSearched = buildPlanReply(JEJU, null);

    expect(notSearched).toContain(PLAN_NOT_SEARCHED_TAIL);
    expect(notSearched).not.toContain(PLAN_NO_HITS_TAIL);
  });

  it('이름이 빈 장소는 버리고 나머지만 싣는다', () => {
    // title은 색인 사고로 ''일 수 있다. 그대로 이으면 구분자만 남은 빈 칸이
    // 화면에 나간다.
    const reply = buildPlanReply(JEJU, ['한라산', '', '   ']);

    expect(reply).toContain(`${PLAN_PLACES_HEAD} 한라산`);
    expect(reply).not.toContain(PLAN_NO_HITS_TAIL);
  });

  it('↔ 짝: 이름이 전부 비면 hit 0건과 같은 문구를 쓴다', () => {
    // 사용자가 받는 사실("보여줄 장소가 없다")이 같으므로 문구도 같다.
    const reply = buildPlanReply(JEJU, ['', '   ']);

    expect(reply).toContain(PLAN_NO_HITS_TAIL);
    expect(reply).not.toContain(PLAN_PLACES_HEAD);
  });
});

describe('buildPlanReply — 일정을 조립하지 못한다는 사실', () => {
  const everyBranch: [string, string[] | null][] = [
    ['장소를 찾았을 때', ['한라산']],
    ['hit이 0건일 때', []],
    ['검색을 못 했을 때', null],
  ];

  it.each(everyBranch)(
    '%s에도 일정을 짜지 못한다는 사실을 함께 말한다',
    (_label, placeNames) => {
      // 세 갈래 전부에 깔린 사실이다. 한 갈래라도 빠지면 그 경로의 사용자는
      // "장소를 찾았으니 곧 일정이 뜨겠지"라고 이해하고 오지 않을 패널을
      // 기다린다 — 조립은 아직 구현되지 않았다.
      expect(buildPlanReply(JEJU, placeNames)).toContain(
        PLAN_NOT_ASSEMBLED_NOTE,
      );
    },
  );

  it('일정이 준비됐다고 말하지 않는다', () => {
    // 이 갈래는 itinerary를 항상 null로 낸다. 준비됐다는 말이 섞이면 패널이
    // 뜨지 않는 화면과 문구가 정면으로 어긋난다.
    expect(buildPlanReply(JEJU, ['한라산'])).not.toContain('준비했어요');
  });

  it('목적지를 못 알아들었다고 말하지 않는다', () => {
    // 조건을 정확히 읽어낸 요청에도 이 문장이 나가던 것이 이번 변경 전의
    // 동작이다. 조건 요약이 '지역: 제주'인데 "어느 지역으로 떠나고 싶으신가요"를
    // 함께 내보내면 같은 문장 안에서 두 말이 서로를 부정한다.
    expect(buildPlanReply(JEJU, ['한라산'])).not.toContain(
      '어느 지역으로 떠나고 싶으신가요',
    );
  });
});

describe('buildPlanReply — 추천 갈래와의 대조', () => {
  it('↔ 짝: 추천 갈래의 문구와 겹치지 않는다', () => {
    // 두 갈래가 이제 같은 파이프라인을 타므로 문구가 유일한 구별 수단이다.
    // 문장 틀이 같아지면 switch의 arm을 바꿔도 경로 스모크가 못 잡는다.
    const recommend = buildRecommendReply(JEJU, ['한라산']);

    expect(buildPlanReply(JEJU, ['한라산'])).not.toBe(recommend);
  });

  it('머리말이 추천 갈래와 다르다', () => {
    // 위 단정은 맺음말만 달라도 통과한다. 머리말이 갈리는 것이 사용자가 두
    // 갈래를 구별하는 첫 단서다.
    expect(buildRecommendReply(JEJU, ['한라산'])).not.toContain(
      PLAN_REPLY_HEAD,
    );
  });
});
