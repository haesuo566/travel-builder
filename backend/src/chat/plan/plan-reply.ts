import { buildConditionSummary } from '../query/query-reply';
import type { StructuredQuery } from '../query/structured-query';

/**
 * 일정 갈래의 문구.
 *
 * 노출 문구를 named export 상수로 빼는 이유는 spec이 그것을 import해 단정할 수
 * 있기 때문이다(query-reply.ts:8-14와 같은 이유). 상수가 없으면 테스트가 문구를
 * 복제하고, 문구를 고칠 때 두 곳이 갈린다.
 *
 * 이 머리말은 RECOMMEND_REPLY_HEAD·OTHER_REPLY와 서로 달라야 한다. 두 갈래가
 * 이제 같은 파이프라인을 타고 planStatus도 둘 다 'none'이라, **문구가 갈래를
 * 구별하는 유일한 수단이다** — 경로 스모크가 "세 갈래가 갈린다"를 판정하는
 * 근거도 여기 하나로 좁혀졌다.
 */
export const PLAN_REPLY_HEAD = '여행 일정 요청으로 이해했어요';

/**
 * 이 갈래가 아직 하지 못하는 일. **세 맺음말 모두에 붙는다.**
 *
 * 장소는 찾지만 날짜별 조립은 구현되지 않았다. 이 사실을 빼면 장소를 찾은
 * 사용자는 "곧 패널이 뜨겠지"라고 이해하고 오지 않을 것을 기다리며, 장소를 못
 * 찾은 사용자는 조건만 고치면 일정을 받을 수 있다고 오해한다 — 어느 쪽도
 * 조건을 아무리 고쳐도 일정을 받지 못한다.
 *
 * 조립이 붙으면 이 상수와 그것을 잇는 자리가 함께 사라진다.
 */
export const PLAN_NOT_ASSEMBLED_NOTE =
  '날짜별 일정으로 짜드리는 기능은 아직 없어요.';

/** 찾은 장소가 있을 때의 머리말. 뒤에 이름 목록이 붙는다. */
export const PLAN_PLACES_HEAD = '이런 곳을 찾았어요:';

/**
 * 검색은 돌았는데 보여줄 장소가 없을 때.
 *
 * 아래 NOT_SEARCHED와 반드시 다른 문장이어야 한다 — 사용자가 다음에 무엇을
 * 할지가 갈린다. 이쪽은 조건을 넓히면 되고, 저쪽은 조건을 아무리 고쳐도
 * 같은 답을 받는다(query-reply.ts의 같은 경계).
 */
export const PLAN_NO_HITS_TAIL = '일정에 넣을 만한 장소를 찾지 못했어요.';

/** 검색할 벡터를 만들지 못해 검색 자체를 못 했을 때. */
export const PLAN_NOT_SEARCHED_TAIL =
  '무엇을 찾을지 알아듣지 못해 일정에 넣을 장소를 찾아보지 못했어요. 어디로 떠나고 싶은지 조금 더 알려주세요.';

const PLACE_SEPARATOR = ', ';

/**
 * 검색 결과를 알리는 맺음말을 고른다.
 *
 * null과 빈 배열을 다른 문구로 가른다. null은 "검색을 못 했다"(질의 벡터가
 * 없었다)이고 빈 배열은 "검색했는데 없다"이다 — 뭉개면 사용자가 조건을 고쳐도
 * 원인이 질의 쪽이라 몇 번을 시도해도 같은 답을 받는다.
 *
 * 빈 이름은 버린다. title은 색인·수집 사고로 ''일 수 있고, 그대로 이으면
 * 구분자만 남은 빈 칸이 화면에 나간다. 전부 비어 0개가 되면 hit 0건과 같은
 * 문구를 쓴다 — 사용자가 받는 사실("보여줄 장소가 없다")이 같기 때문이다.
 */
function buildSearchTail(placeNames: string[] | null): string {
  if (placeNames === null) return PLAN_NOT_SEARCHED_TAIL;

  const names = placeNames.filter((name) => name.trim() !== '');

  // 목록 뒤에 마침표를 찍는다. 뒤에 PLAN_NOT_ASSEMBLED_NOTE가 반드시 붙으므로,
  // 없으면 마지막 이름이 다음 문장의 첫 단어와 한 어절로 읽힌다('마라도 날짜별').
  // 다른 두 맺음말은 이미 문장으로 끝나 이 갈래에만 생기는 문제다.
  return names.length === 0
    ? PLAN_NO_HITS_TAIL
    : `${PLAN_PLACES_HEAD} ${names.join(PLACE_SEPARATOR)}.`;
}

/**
 * 구조화 결과와 검색 결과를 한 문장으로 합친다.
 *
 * **모델의 자유 텍스트를 싣지 않는다.** 추천 갈래는 찾은 장소를 Gemini가
 * 소개하게 하지만(composeRecommendReply), 이 갈래는 전부 결정론적이다 —
 * 돌려줄 일정이 없는데 모델에게 문장을 받으면 그 문장이 채울 수 있는 것은
 * 지어낸 일정뿐이고, 왕복의 쿼터 소진이 돌려줄 수 있었던 요청을 503으로 만든다.
 *
 * buildConditionSummary를 추천 갈래와 공유한다. 사본을 만들면 조건 라벨이 두
 * 곳으로 갈리고, 같은 질의가 갈래에 따라 다른 이름의 조건으로 되비친다 —
 * 사용자가 "무엇으로 이해했는지"를 대조하는 근거가 갈래마다 달라진다.
 *
 * 조건 요약은 검색 결과와 무관하게 항상 싣는다. 못 찾았다는 말만 돌려주면
 * 사용자는 무엇을 어떻게 이해했는지 몰라 무엇을 고쳐야 할지 판단할 수 없다.
 *
 * placeNames를 행이 아니라 이름 배열로 받는다 — 이 파일이 TourContent 모양을
 * 알면 문장 서식과 DB 스키마가 한 파일에서 얽힌다.
 */
export function buildPlanReply(
  query: StructuredQuery,
  placeNames: string[] | null,
): string {
  const summary = buildConditionSummary(query.conditions);

  return `${PLAN_REPLY_HEAD} — ${summary}. ${buildSearchTail(placeNames)} ${PLAN_NOT_ASSEMBLED_NOTE}`;
}
