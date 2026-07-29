import { CONDITION_LABELS } from './query-prompt';
import type { QueryConditions, StructuredQuery } from './structured-query';

/**
 * 장소 추천 갈래의 문구.
 *
 * plan_itinerary의 문구였던 PLAN_REPLY_HEAD·PLAN_REPLY_TAIL은 여기 없다 —
 * 그 갈래는 이제 일정을 실제로 돌려주므로 '장소를 찾아 일정을 짜는 단계는
 * 다음에 붙습니다.'가 거짓 문장이 된다. 대체 문구는 plan/plan-reply.ts에 있다.
 *
 * 이 머리말은 plan 갈래의 문구·OTHER_REPLY와 서로 달라야 한다 — 경로 스모크가
 * "세 갈래가 갈린다"를 판정하는 근거다.
 */
export const RECOMMEND_REPLY_HEAD = '장소 추천 요청으로 이해했어요';
export const NO_CONDITIONS_SUMMARY = '조건: 미지정';

/** 찾은 장소가 있을 때의 머리말. 뒤에 이름 목록이 붙는다. */
export const RECOMMEND_PLACES_HEAD = '이런 곳은 어때요?';

/**
 * 검색은 돌았는데 보여줄 장소가 없을 때.
 *
 * 아래 NOT_SEARCHED와 반드시 다른 문장이어야 한다 — 사용자가 다음에 무엇을
 * 할지가 갈린다. 이쪽은 조건을 넓히면 되고, 저쪽은 조건을 아무리 고쳐도
 * 같은 답을 받는다.
 */
export const RECOMMEND_NO_HITS_TAIL = '조건에 맞는 장소를 찾지 못했어요.';

/** 검색할 벡터를 만들지 못해 검색 자체를 못 했을 때. */
export const RECOMMEND_NOT_SEARCHED_TAIL =
  '무엇을 찾을지 알아듣지 못해 장소를 찾아보지 못했어요. 어떤 곳을 원하는지 조금 더 알려주세요.';

/**
 * 동반자만 [조건] 라벨이 없다 — 값을 [질의]의 '추천 동반자:'에서 읽기 때문이다.
 * 그래서 표시 라벨을 여기 둔다. 나머지 넷은 CONDITION_LABELS를 그대로 쓴다:
 * 조건 라벨은 사람이 읽는 한국어 단어이므로 요약에 그대로 실을 수 있고,
 * 사본을 만들면 두 곳이 갈린다.
 */
const TRAVELERS_SUMMARY_LABEL = '동반자:';

const SUMMARY_SEPARATOR = ' · ';

/**
 * 장소 이름 구분자. 조건 요약과 다른 문자를 쓴다 — 한 문장 안에 두 목록이
 * 들어가므로 같은 구분자면 어디까지가 조건이고 어디부터가 장소인지 흐려진다.
 */
const PLACE_SEPARATOR = ', ';

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
 * 검색 결과를 알리는 맺음말을 고른다.
 *
 * null과 빈 배열을 다른 문구로 가른다. null은 "검색을 못 했다"(질의 벡터가
 * 없었다)이고 빈 배열은 "검색했는데 없다"이다 — 뭉개면 사용자가 조건을 고쳐도
 * 원인이 질의 쪽이라 몇 번을 시도해도 같은 답을 받는다.
 *
 * 빈 이름은 버린다. title은 payload에 없으면 ''로 보정되므로
 * (parseTourContentPayload) 그대로 이으면 구분자만 남은 빈 칸이 화면에 나간다.
 * 전부 비어 결과가 0개가 되면 hit 0건과 같은 문구를 쓴다 — 사용자가 받는
 * 사실("보여줄 장소가 없다")이 같기 때문이다. 검색은 돌았는데 이름이 없었다는
 * 사실은 ChatService의 hit 수 로그에만 남는다.
 */
function buildSearchTail(placeNames: string[] | null): string {
  if (placeNames === null) return RECOMMEND_NOT_SEARCHED_TAIL;

  const names = placeNames.filter((name) => name.trim() !== '');

  return names.length === 0
    ? RECOMMEND_NO_HITS_TAIL
    : `${RECOMMEND_PLACES_HEAD} ${names.join(PLACE_SEPARATOR)}`;
}

/**
 * 구조화 결과와 검색 결과를 한 문장으로 합친다.
 *
 * intent 파라미터가 없다 — 소비자가 recommend_places 갈래 하나뿐이다. 갈래를
 * 받는 시그니처를 남기면 도달 불가능한 분기가 생기고, 그 분기를 검증하는
 * 테스트가 초록불을 주면서 아무것도 지키지 않는다.
 *
 * 모델의 자유 텍스트를 싣지 않는다 — 검증을 통과한 조건 값만 우리 문장 틀에
 * 끼운다. 의미 축 텍스트(QUERY_LABELS 7줄)는 절대 노출하지 않는다.
 *
 * fellBackToRawMessage는 문구에 나타나지 않는다 — 폴백의 관측 수단은 warn
 * 로그다(직전 실행이 intent 폴백에 대해 정한 것과 같은 경계). 폴백이어도
 * 원문으로 검색이 도므로 맺음말은 검색 결과만 보고 갈린다.
 *
 * 조건 요약은 검색 결과와 무관하게 항상 싣는다. 못 찾았다는 말만 돌려주면
 * 사용자는 무엇을 어떻게 이해했는지 몰라 무엇을 고쳐야 할지 판단할 수 없다.
 *
 * placeNames를 TourSearchHit이 아니라 이름 배열로 받는다 — 이 파일이 Qdrant
 * payload 모양을 알면 문장 서식과 검색 스키마가 한 파일에서 얽힌다.
 */
export function buildRecommendReply(
  query: StructuredQuery,
  placeNames: string[] | null,
): string {
  const summary = buildConditionSummary(query.conditions);

  return `${RECOMMEND_REPLY_HEAD} — ${summary}. ${buildSearchTail(placeNames)}`;
}
