// buildRecommendReply를 대조하므로 query-reply → query-prompt → dto/itinerary.dto
// 경로로 class-validator 데코레이터가 평가된다. 폴리필을 직접 들여온다
// (query-reply.spec.ts와 같은 이유).
import 'reflect-metadata';

import { buildRecommendReply } from '../query/query-reply';
import { EMPTY_CONDITIONS } from '../query/structured-query';
import { buildMockItinerary } from './mock-itineraries';
import {
  buildPlanReply,
  PLAN_DESTINATION_UNKNOWN_REPLY,
  PLAN_READY_GUIDE,
} from './plan-reply';

describe('buildPlanReply — 준비된 일정을 알리는 문장', () => {
  it('목적지와 기간을 문장에 그대로 싣는다', () => {
    // 전문 등가로 고정한다. 문구를 고치면 이 한 건이 깨지고, 그게 노출 문구를
    // 바꿨다는 유일한 신호다.
    const reply = buildPlanReply(buildMockItinerary('제주 2박3일 짜줘'));

    expect(reply).toBe(`제주 2박 3일 일정을 준비했어요! ${PLAN_READY_GUIDE}`);
  });

  it('목적지가 바뀌면 문장도 바뀐다', () => {
    // 위 단정이 "항상 같은 문자열을 낸다"는 구현으로도 통과하지 않게 한다.
    expect(buildPlanReply(buildMockItinerary('부산'))).toContain('부산');
    expect(buildPlanReply(buildMockItinerary('부산'))).not.toContain('제주');
  });

  it('화면 배치를 문구에 담지 않는다', () => {
    // 원문(frontend/src/lib/mock/scenarios.ts:18)의 '오른쪽에서'를 뺀 결정을
    // 고정한다. 모바일에서는 오른쪽이 아니라 탭이다.
    expect(buildPlanReply(buildMockItinerary('제주'))).not.toContain('오른쪽');
  });

  it('↔ 짝: 추천 갈래의 문구와 겹치지 않는다', () => {
    // 두 문장 틀이 같아지면 switch의 arm을 바꿔도 경로 스모크가 못 잡는다.
    // 이 짝은 query-reply.spec.ts에 있던 갈래 대조를 대체한다 —
    // 두 갈래의 문구가 이제 서로 다른 모듈에 있으므로 여기서 잇는다.
    const recommend = buildRecommendReply({
      queryText: '무엇을 하는 곳: 일출 감상',
      conditions: { ...EMPTY_CONDITIONS, region: '제주' },
      droppedLabels: [],
      fellBackToRawMessage: false,
    });

    expect(buildPlanReply(buildMockItinerary('제주'))).not.toBe(recommend);
  });
});

describe('buildPlanReply — 목적지를 못 알아들었을 때', () => {
  it('무엇을 알려줘야 하는지 말한다', () => {
    // 일정 요청으로 이해했는데 패널이 뜨지 않는 상태를 설명 없이 두면 사용자는
    // 서비스가 고장난 것과 구별할 수 없다. 이 문구가 유일한 단서다.
    expect(buildPlanReply(null)).toBe(PLAN_DESTINATION_UNKNOWN_REPLY);
  });

  it('↔ 짝: 준비 완료 문구와 겹치지 않는다', () => {
    // 두 문구가 같아지면 매칭 실패가 성공처럼 보인다. 맺음말이 실리지 않는
    // 것까지 센다 — 'Day별 코스를 확인해보세요'는 일정이 있을 때만 참이다.
    expect(buildPlanReply(null)).not.toBe(
      buildPlanReply(buildMockItinerary('제주')),
    );
    expect(buildPlanReply(null)).not.toContain(PLAN_READY_GUIDE);
  });
});
