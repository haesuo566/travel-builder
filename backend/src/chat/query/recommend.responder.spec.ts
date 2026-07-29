import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../../clients/external-service.error';
import type { GeminiGenerateOptions } from '../../clients/gemini/gemini.client';
import { GeminiClient } from '../../clients/gemini/gemini.client';
import { buildPlacesTail } from './query-reply';
import type { RecommendPlace } from './recommend-prompt';
import { RECOMMEND_SYSTEM_INSTRUCTION } from './recommend-prompt';
import { RecommendResponder } from './recommend.responder';
import type { StructuredQuery } from './structured-query';
import { EMPTY_CONDITIONS } from './structured-query';

/**
 * 모킹 경계는 GeminiClient다(other.responder.spec.ts와 같다). 프롬프트·검증기는
 * 실물을 태운다 — 그쪽 경계값은 recommend-prompt.spec.ts가 고정한다.
 */

const generate = jest.fn<Promise<string>, [string, GeminiGenerateOptions?]>();

const QUERY: StructuredQuery = {
  queryText: '무엇을 하는 곳: 일출 감상',
  conditions: { ...EMPTY_CONDITIONS, region: '제주', category: '관광지' },
  droppedLabels: [],
  fellBackToRawMessage: false,
};

const PLACES: RecommendPlace[] = [
  {
    title: '성산일출봉',
    addr1: '제주특별자치도 서귀포시 성산읍',
    addr2: '일출로 284-12',
    overview: '유네스코 세계자연유산이다.',
  },
  {
    title: '우도',
    addr1: '제주특별자치도 제주시 우도면',
    addr2: '',
    overview: null,
  },
];

const NORMAL_REPLY =
  '성산일출봉은 분화구 위로 해가 뜨는 걸 볼 수 있어요. 우도는 배를 타고 들어가는 작은 섬이에요.';

async function createResponder(): Promise<RecommendResponder> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RecommendResponder,
      { provide: GeminiClient, useValue: { generate } },
    ],
  }).compile();
  return moduleRef.get(RecommendResponder);
}

let warnLog: jest.SpyInstance;

beforeEach(() => {
  generate.mockReset();
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RecommendResponder — 호출 계약', () => {
  it('systemInstruction·temperature 0.7·model 미지정으로 한 번 호출한다', async () => {
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await responder.describe('제주 일출 명소 추천', QUERY, PLACES);

    expect(generate).toHaveBeenCalledTimes(1);
    const [, opts] = generate.mock.calls[0];
    expect(opts?.systemInstruction).toBe(RECOMMEND_SYSTEM_INSTRUCTION);
    // other 갈래와 같은 값이다. 이쪽도 자유 텍스트이고 재현 가능한 벡터를
    // 만드는 하류 소비자가 없다.
    expect(opts?.temperature).toBe(0.7);
    expect(opts?.model).toBeUndefined();
  });

  it('프롬프트에 사용자 원문과 이해한 조건을 함께 담는다', async () => {
    // 둘 다 필요하다. 조건 요약만 주면 "일출을 보고 싶다"가 사라지고, 원문만
    // 주면 구조화가 뽑아낸 것을 모델이 다시 추측해야 한다.
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await responder.describe('제주 일출 명소 추천', QUERY, PLACES);

    const [prompt] = generate.mock.calls[0];
    expect(prompt).toContain('제주 일출 명소 추천');
    expect(prompt).toContain('지역: 제주 · 분류: 관광지');
  });

  it('프롬프트에 장소의 제목과 주소를 담는다', async () => {
    // 제목만 넘기면 이 갈래를 만든 이유(실제 장소 데이터로 답을 쓴다)가
    // 사라진다 — 모델은 이름만 보고 자기 지식으로 답하게 된다.
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await responder.describe('제주 일출 명소 추천', QUERY, PLACES);

    const [prompt] = generate.mock.calls[0];
    expect(prompt).toContain('성산일출봉');
    expect(prompt).toContain('제주특별자치도 서귀포시 성산읍 일출로 284-12');
    expect(prompt).toContain('유네스코 세계자연유산이다.');
  });

  it('프롬프트에 의미 축 텍스트를 담지 않는다', async () => {
    // queryText는 QUERY_LABELS 포맷이다. 재료로 넘기면 모델이 그 포맷을
    // 되풀이할 여지가 생기고, 그러면 내부 라벨이 화면까지 간다.
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await responder.describe('제주 일출 명소 추천', QUERY, PLACES);

    const [prompt] = generate.mock.calls[0];
    expect(prompt).not.toContain('무엇을 하는 곳:');
  });
});

describe('RecommendResponder — 응답 판정', () => {
  it('정상 응답을 그대로 돌려주고 warn을 남기지 않는다', async () => {
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await expect(
      responder.describe('제주 일출 명소 추천', QUERY, PLACES),
    ).resolves.toBe(NORMAL_REPLY);
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('1001자 응답은 이름 목록으로 대체하고 warn 1건을 남긴다', async () => {
    // 폴백이 발동해도 응답은 200이고 문장 틀도 정상이다 — 등가 단정과 warn
    // 단정이 "모델 응답이 통째로 안 쓰이고 있다"의 유일한 관측 수단이다.
    generate.mockResolvedValue('가'.repeat(1001));
    const responder = await createResponder();

    await expect(
      responder.describe('제주 일출 명소 추천', QUERY, PLACES),
    ).resolves.toBe(buildPlacesTail(['성산일출봉', '우도']));
    expect(warnLog).toHaveBeenCalledTimes(1);
  });

  it('↔ 짝: 1000자 응답은 대체하지 않는다', async () => {
    const exact = '가'.repeat(1000);
    generate.mockResolvedValue(exact);
    const responder = await createResponder();

    await expect(
      responder.describe('제주 일출 명소 추천', QUERY, PLACES),
    ).resolves.toBe(exact);
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('폴백은 검색 순서 그대로의 이름 목록이다', async () => {
    // 결정론적 경로가 안전망으로 남는다는 결정이 여기서 고정된다. 폴백이
    // 기존 문구와 다른 모양이면 안전망이 새 실패 모양을 하나 더 만든다.
    generate.mockResolvedValue('');
    const responder = await createResponder();

    const tail = await responder.describe('추천해줘', QUERY, PLACES);

    expect(tail).toBe('이런 곳은 어때요? 성산일출봉, 우도');
  });
});

describe('RecommendResponder — 폴백의 경계선', () => {
  function quotaFailure(): ExternalServiceError {
    return new ExternalServiceError('gemini', 'quota', '쿼터 소진');
  }

  it('gemini 호출 실패는 같은 인스턴스로 그대로 올라간다', async () => {
    // 여기에 try/catch를 두면 쿼터 소진이 "이런 곳은 어때요?"가 되고 503도
    // Retry-After도 사라진다 — 협력자 다섯에 걸린 것과 같은 규칙이다.
    const failure = quotaFailure();
    generate.mockRejectedValue(failure);
    const responder = await createResponder();

    await expect(responder.describe('추천해줘', QUERY, PLACES)).rejects.toBe(
      failure,
    );
  });

  it('호출 실패에는 폴백 warn을 남기지 않는다', async () => {
    // ↔ 짝. 실패 로그는 callExternal의 몫이다. 여기서 warn을 남기면 검증
    // 실패(우리가 응답을 버렸다)와 호출 실패(응답을 못 받았다)가 로그에서 섞인다.
    generate.mockRejectedValue(quotaFailure());
    const responder = await createResponder();

    await responder.describe('추천해줘', QUERY, PLACES).catch(() => undefined);

    expect(warnLog).not.toHaveBeenCalled();
  });
});
