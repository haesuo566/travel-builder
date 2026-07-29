import type { PlaceCategory } from '../dto/itinerary.dto';

/**
 * 의미 축 텍스트의 고정 라벨.
 *
 * core/src/lib/structuredText.ts:6-14의 REQUIRED_LABELS와 문자열·순서가 같아야 한다.
 * 공유 패키지가 없어 복제가 유일한 선택이다(itinerary.dto.ts:13-17과 같은 상황).
 * 어긋나면 query-prompt.spec.ts의 core 소스 대조 테스트가 잡는다.
 *
 * core의 `{제목} — {분류}` 첫 줄은 여기 없다 — 제목은 질의 쪽에 존재하지 않고,
 * 분류는 payload 필터로 정확히 걸리므로 conditions.category로 뺐다.
 */
export const QUERY_LABELS = [
  '무엇을 하는 곳:',
  '실내/실외:',
  '추천 동반자:',
  '적정 소요시간:',
  '계절/날씨:',
  '분위기:',
  '설명:',
] as const;

export type QueryLabel = (typeof QUERY_LABELS)[number];

/** conditions.travelers를 읽어오는 라벨. QUERY_LABELS의 원소여야 한다. */
export const TRAVELERS_LABEL: QueryLabel = '추천 동반자:';

/**
 * 라벨 값의 상한. 초과하면 그 줄을 버린다(절단하지 않는다).
 *
 * core의 전체 상한이 400자이므로(STRUCTURE_SYSTEM_INSTRUCTION 규칙 7) 라벨 하나가
 * 200자를 넘으면 색인 텍스트와 같은 종류의 텍스트가 아니다.
 */
export const QUERY_VALUE_MAX_LENGTH = 200;

/** 조건 값의 상한. 초과하면 그 필드를 버린다(절단하지 않는다). */
export const CONDITION_VALUE_MAX_LENGTH = 30;

/** 여행 일수의 유효 범위. 벗어나면 durationDays를 버린다. */
export const DURATION_DAYS_MIN = 1;
export const DURATION_DAYS_MAX = 30;

/**
 * 정형 조건. 벡터가 아니라 payload 필터와 일정 골격에 쓰인다.
 *
 * 값은 이름 문자열이다. ldong_regn_cd·contenttypeid로의 변환에는 Postgres
 * 코드표가 필요하고 그건 사내망 전용이므로(chat.module.ts의 DatabaseModule 주석)
 * 다음 실행의 몫이다.
 *
 * 표시용 문자열(TripInfoDto.destination·duration)을 여기 두지 않는다 —
 * 같은 사실이 두 컬럼에 있으면 갈린다(two-columns-one-state).
 */
export interface QueryConditions {
  /** 시·도 이름. → ldong_regn_cd (다음 실행) */
  region: string | null;
  /** 시·군·구 이름. → ldong_signgu_cd (다음 실행) */
  district: string | null;
  /** → contenttypeid (다음 실행). PLACE_CATEGORIES 재사용 — 새 어휘를 만들지 않는다 */
  category: PlaceCategory | null;
  /** 여행 일수. DURATION_DAYS_MIN~MAX */
  durationDays: number | null;
  /** QUERY_LABELS의 '추천 동반자:' 값에서 읽는다. [조건]에 별도 줄이 없다 */
  travelers: string | null;
}

/** 파서의 산출물. 폴백 여부는 담지 않는다 — 그건 호출자가 아는 사실이다. */
export interface ParsedQuery {
  /** QUERY_LABELS 순서로 재조립한 텍스트. TEI에 그대로 넘길 값이다 */
  queryText: string;
  conditions: QueryConditions;
  /** 검증에 걸려 버린 라벨·조건 이름. warn 1건의 재료이며 값은 담지 않는다 */
  droppedLabels: string[];
}

/**
 * 소비자(ChatService·다음 실행)가 받는 값.
 *
 * fellBackToRawMessage는 HTTP 응답에 노출하지 않는다 — 폴백의 관측 수단은
 * QueryStructurer의 warn 로그 하나다. ChatResponseDto에 planStatus가 들어온
 * 뒤에도 이 결정은 유효하다: planStatus는 렌더 조건이고 폴백 관측용이 아니다.
 * DTO를 한 번 열었다는 사실이 다른 필드를 실을 근거가 되지 않는다.
 */
export interface StructuredQuery extends ParsedQuery {
  fellBackToRawMessage: boolean;
}

/**
 * 조건이 하나도 없는 상태. 폴백과 '[조건] 섹션 없음' 둘 다 이 값을 쓴다.
 *
 * 읽는 쪽은 반드시 전개(`{ ...EMPTY_CONDITIONS }`)해서 쓴다 — 이 객체를 직접
 * 채우면 공유 상수가 오염되고 다음 요청이 앞 요청의 조건을 물려받는다.
 */
export const EMPTY_CONDITIONS: QueryConditions = {
  region: null,
  district: null,
  category: null,
  durationDays: null,
  travelers: null,
};
