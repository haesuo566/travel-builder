import { CHAT_INTENTS, INTENT_DESCRIPTIONS } from './chat-intent';
import { buildIntentPrompt, INTENT_SYSTEM_INSTRUCTION } from './intent-prompt';

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
