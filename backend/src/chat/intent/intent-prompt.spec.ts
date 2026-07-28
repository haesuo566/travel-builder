import type { ChatIntent } from './chat-intent';
import { CHAT_INTENTS, INTENT_DESCRIPTIONS } from './chat-intent';
import {
  buildIntentPrompt,
  INTENT_SYSTEM_INSTRUCTION,
  parseIntent,
} from './intent-prompt';

/**
 * 프롬프트와 파서는 하나의 계약의 양방향이다 — 프롬프트가 "소문자 snake_case
 * 토큰 하나만"을 요구하고 파서가 정확히 그것만 받는다. 같은 파일에 두는 이유가
 * 그것이고, 같은 spec에서 함께 고정하는 이유도 같다.
 */

describe('INTENT_SYSTEM_INSTRUCTION', () => {
  it('세 분류값 토큰이 모두 등장한다', () => {
    for (const intent of CHAT_INTENTS) {
      expect(INTENT_SYSTEM_INSTRUCTION).toContain(intent);
    }
  });

  it('설명을 어휘표에서 조립한다', () => {
    // 사본을 만들면 이 단정이 깨진다. 프롬프트가 INTENT_DESCRIPTIONS의
    // 유일한 소비자라는 사실이 4번째 분류값 추가 시 동기화 항목을 0개로 만든다.
    for (const intent of CHAT_INTENTS) {
      expect(INTENT_SYSTEM_INSTRUCTION).toContain(INTENT_DESCRIPTIONS[intent]);
    }
  });

  it('plan_itinerary 설명이 기존 일정 수정 요청을 명시한다', () => {
    // 확정된 분류 기준(수정 요청도 plan_itinerary)이 프롬프트에서 사라지는
    // 회귀를 막는다. 실측 정확도 평가가 범위 밖이므로 이 기준을 지키는
    // 유일한 자동 방어선이다 — 사라지면 트래픽 최다 요청이 other로 흘러간다.
    expect(INTENT_SYSTEM_INSTRUCTION).toContain('고쳐 달라는 요청');
    expect(INTENT_SYSTEM_INSTRUCTION).toContain('1일차만 바꿔줘');
  });
});

describe('buildIntentPrompt', () => {
  it('사용자 메시지를 구분자 사이에 그대로 담는다', () => {
    const prompt = buildIntentPrompt('제주 2박3일');

    expect(prompt).toContain('제주 2박3일');
    expect(prompt).toContain('<<<\n제주 2박3일\n>>>');
  });

  it('여러 줄 메시지도 구분자 안에 담는다', () => {
    // 구분자가 없으면 줄바꿈이 들어간 입력이 지시문과 섞인다.
    const message = '제주 가고 싶어\n2박3일이면 좋겠어';

    expect(buildIntentPrompt(message)).toContain(`<<<\n${message}\n>>>`);
  });

  it('과업 지시문이 메시지보다 앞에 온다', () => {
    // 프롬프트만 따로 떼어 보내도 최소한의 과업이 전달돼야 한다.
    const prompt = buildIntentPrompt('안녕');

    expect(prompt.indexOf('분류값 하나만 출력하라')).toBeLessThan(
      prompt.indexOf('안녕'),
    );
  });
});

describe('parseIntent', () => {
  it.each(CHAT_INTENTS)('%s 토큰을 그대로 판정한다', (intent: ChatIntent) => {
    expect(parseIntent(intent)).toBe(intent);
  });

  const normalizationCases: Array<[string, string, ChatIntent]> = [
    ['대소문자', ' PLAN_ITINERARY\n', 'plan_itinerary'],
    ['따옴표', '"other"', 'other'],
    ['백틱', '`recommend_places`', 'recommend_places'],
    ['마침표', 'other.', 'other'],
    ['코드펜스', '```\nplan_itinerary\n```', 'plan_itinerary'],
  ];

  it.each(normalizationCases)(
    '%s는 정규화로 걷어낸다',
    (_label, raw, expected) => {
      expect(parseIntent(raw)).toBe(expected);
    },
  );

  const nullCases: Array<[string, string]> = [
    // ↔ 위 정규화 케이스의 짝. 관대해지면 이쪽이 통과해 버린다.
    ['접두어가 붙은 응답', '분류: plan_itinerary'],
    ['조사가 붙은 응답', 'plan_itinerary 입니다'],
    // 신규 함정 2의 유일한 방어선. includes로 바꾸면 이 케이스만 깨진다 —
    // 단순 오분류 케이스로는 절대 잡히지 않는다.
    ['두 분류값이 함께 등장', 'plan_itinerary가 아니라 recommend_places입니다'],
    ['빈 문자열', ''],
    ['공백만', '   \n  '],
    ['관계없는 문장', '무슨 말인지 잘 모르겠습니다'],
    // 접두·부분 토큰이 통과하지 않는다.
    ['부분 토큰 plan', 'plan'],
    ['부분 토큰 recommend', 'recommend'],
    ['부분 토큰 itinerary', 'itinerary'],
  ];

  it.each(nullCases)('%s는 null이다', (_label, raw) => {
    expect(parseIntent(raw)).toBeNull();
  });
});
