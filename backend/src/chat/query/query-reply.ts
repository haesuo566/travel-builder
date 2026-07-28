import { CONDITION_LABELS } from './query-prompt';
import type { QueryConditions, StructuredQuery } from './structured-query';

/**
 * 갈래별 잠정 문구. 두 값이 서로 달라야 경로 스모크가 "세 갈래가 갈린다"를
 * 판정할 수 있다. 실제 검색·조립이 붙으면 이 파일이 사라진다.
 */
export const PLAN_REPLY_HEAD = '일정 요청으로 이해했어요';
export const RECOMMEND_REPLY_HEAD = '장소 추천 요청으로 이해했어요';
export const PLAN_REPLY_TAIL =
  '장소를 찾아 일정을 짜는 단계는 다음에 붙습니다.';
export const RECOMMEND_REPLY_TAIL =
  '조건에 맞는 장소를 찾는 단계는 다음에 붙습니다.';
export const NO_CONDITIONS_SUMMARY = '조건: 미지정';

/**
 * 동반자만 [조건] 라벨이 없다 — 값을 [질의]의 '추천 동반자:'에서 읽기 때문이다.
 * 그래서 표시 라벨을 여기 둔다. 나머지 넷은 CONDITION_LABELS를 그대로 쓴다:
 * 조건 라벨은 사람이 읽는 한국어 단어이므로 요약에 그대로 실을 수 있고,
 * 사본을 만들면 두 곳이 갈린다.
 */
const TRAVELERS_SUMMARY_LABEL = '동반자:';

const SUMMARY_SEPARATOR = ' · ';

/**
 * 검증을 통과한 조건만 고정 순서로 잇는다. null 필드는 나타나지 않는다.
 *
 * 색인 라벨(QUERY_LABELS)은 절대 나타나지 않는다 — 내부 포맷이 UI 계약이 되면
 * 나중에 라벨을 바꿀 수 없다.
 */
function buildConditionSummary(conditions: QueryConditions): string {
  const parts: string[] = [];

  if (conditions.region !== null) {
    parts.push(`${CONDITION_LABELS.region} ${conditions.region}`);
  }
  if (conditions.district !== null) {
    parts.push(`${CONDITION_LABELS.district} ${conditions.district}`);
  }
  if (conditions.category !== null) {
    parts.push(`${CONDITION_LABELS.category} ${conditions.category}`);
  }
  if (conditions.durationDays !== null) {
    // 표시 문자열('2박 3일')을 조건에 두지 않는다 — 숫자 하나에서 파생시킨다.
    parts.push(`${CONDITION_LABELS.durationDays} ${conditions.durationDays}일`);
  }
  if (conditions.travelers !== null) {
    parts.push(`${TRAVELERS_SUMMARY_LABEL} ${conditions.travelers}`);
  }

  return parts.length === 0
    ? NO_CONDITIONS_SUMMARY
    : parts.join(SUMMARY_SEPARATOR);
}

/**
 * 구조화 결과를 사용자에게 되비출 한 문장을 만든다.
 *
 * 모델의 자유 텍스트를 싣지 않는다 — 검증을 통과한 조건 값만 우리 문장 틀에
 * 끼운다. 의미 축 텍스트(QUERY_LABELS 7줄)는 절대 노출하지 않는다.
 *
 * fellBackToRawMessage는 문구에 나타나지 않는다 — 폴백의 관측 수단은 warn
 * 로그다(직전 실행이 intent 폴백에 대해 정한 것과 같은 경계).
 */
export function buildStructuredReply(
  intent: 'plan_itinerary' | 'recommend_places',
  query: StructuredQuery,
): string {
  const isPlan = intent === 'plan_itinerary';
  const head = isPlan ? PLAN_REPLY_HEAD : RECOMMEND_REPLY_HEAD;
  const tail = isPlan ? PLAN_REPLY_TAIL : RECOMMEND_REPLY_TAIL;

  return `${head} — ${buildConditionSummary(query.conditions)}. ${tail}`;
}
