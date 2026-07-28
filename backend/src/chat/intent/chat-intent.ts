/**
 * 분류값. Gemini에 보내는 토큰 문자열과 내부 타입이 같은 값이다 —
 * 와이어 포맷과 내부 표현 사이에 매핑표를 두지 않는다.
 *
 * enum을 쓰지 않는 이유는 이 저장소의 유니온 상수 관례가
 * as const 배열 + (typeof X)[number]이기 때문이다(itinerary.dto.ts:20-22).
 * 부차적으로 enum은 멤버십 검사에 별도 코드가 필요해지는데,
 * parseIntent가 필요한 것이 정확히 그 검사다.
 */
export const CHAT_INTENTS = [
  'plan_itinerary',
  'recommend_places',
  'other',
] as const;

export type ChatIntent = (typeof CHAT_INTENTS)[number];

/**
 * 프롬프트에 그대로 실리는 분류값 설명. 분류 기준의 유일한 원천이다.
 * Record이므로 CHAT_INTENTS에 값을 더하면 여기를 채우지 않는 한 컴파일되지 않는다.
 */
export const INTENT_DESCRIPTIONS: Record<ChatIntent, string> = {
  plan_itinerary:
    '여행 일정(며칠간의 코스·순서·동선)을 새로 만들어 달라는 요청. 이미 만들어진 일정을 고쳐 달라는 요청(장소 교체·추가·삭제, "맛집 위주로", "가족용으로", "1일차만 바꿔줘")도 여기에 넣는다.',
  recommend_places:
    '조건에 맞는 여행지·장소의 목록을 추천해 달라는 요청. 일정 형태(며칠·순서)를 요구하지 않는다.',
  other:
    '위 둘에 해당하지 않는 모든 것 — 인사·잡담·서비스 사용법·여행과 무관한 질문.',
};
