import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../../clients/external-service.error';
import type { GeminiGenerateOptions } from '../../clients/gemini/gemini.client';
import { GeminiClient } from '../../clients/gemini/gemini.client';
import { QUERY_SYSTEM_INSTRUCTION } from './query-prompt';
import { QueryStructurer } from './query.structurer';

/**
 * 모킹 경계는 GeminiClient다. 파서·프롬프트는 실물을 태운다 —
 * 그쪽 검증은 query-prompt.spec.ts의 몫이고, 여기서 반복하면 같은 것을
 * 두 곳에서 검증한다(intent.classifier.spec.ts와 같은 판단).
 */

const generate = jest.fn<Promise<string>, [string, GeminiGenerateOptions?]>();

const FULL_RESPONSE = [
  '[조건]',
  '지역: 제주',
  '기간: 3',
  '[질의]',
  '무엇을 하는 곳: 일출 감상',
  '추천 동반자: 가족',
].join('\n');

async function createStructurer(): Promise<QueryStructurer> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      QueryStructurer,
      { provide: GeminiClient, useValue: { generate } },
    ],
  }).compile();
  return moduleRef.get(QueryStructurer);
}

/**
 * warn 로그 메시지.
 * jest.SpyInstance의 mock.calls 원소는 any로 추론돼 no-unsafe-member-access에
 * 걸린다. unknown을 거쳐 좁힌다(intent.classifier.spec.ts:35-38과 같은 이유).
 */
function firstWarnMessage(spy: jest.SpyInstance): string {
  const calls = spy.mock.calls as unknown as unknown[][];
  return String(calls[0][0]);
}

let warnLog: jest.SpyInstance;

beforeEach(() => {
  generate.mockReset();
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('QueryStructurer — 호출 계약', () => {
  it('systemInstruction·temperature 0·model 미지정으로 호출하고 프롬프트에 메시지를 담는다', async () => {
    generate.mockResolvedValue(FULL_RESPONSE);
    const structurer = await createStructurer();

    await structurer.structure('제주 2박3일 가족여행 짜줘');

    // 기록된 인자를 그대로 읽는다 — 중첩 expect.objectContaining은 any를 반환해
    // opts의 타입을 지운다(eslint no-unsafe-assignment).
    const [prompt, opts] = generate.mock.calls[0];
    expect(prompt).toContain('제주 2박3일 가족여행 짜줘');
    expect(opts?.systemInstruction).toBe(QUERY_SYSTEM_INSTRUCTION);
    // 0이 ??나 ||에 삼켜지면 모델이 기본 temperature로 돈다. 같은 메시지가 같은
    // 질의 벡터를 만들지 않으면 검색 결과의 재현성이 사라진다.
    expect(opts?.temperature).toBe(0);
    expect(opts?.model).toBeUndefined();
  });

  it('generate를 한 번만 호출한다', async () => {
    generate.mockResolvedValue(FULL_RESPONSE);
    const structurer = await createStructurer();

    await structurer.structure('안녕');

    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('QueryStructurer — 정상 판정', () => {
  it('파싱 결과를 그대로 담고 폴백 표시를 켜지 않는다', async () => {
    generate.mockResolvedValue(FULL_RESPONSE);
    const structurer = await createStructurer();

    const query = await structurer.structure('제주 2박3일 가족여행 짜줘');

    expect(query.queryText).toBe(
      ['무엇을 하는 곳: 일출 감상', '추천 동반자: 가족'].join('\n'),
    );
    expect(query.conditions.region).toBe('제주');
    expect(query.conditions.durationDays).toBe(3);
    expect(query.conditions.travelers).toBe('가족');
    expect(query.fellBackToRawMessage).toBe(false);
  });

  it('↔ 짝: 정상 응답에는 warn을 남기지 않는다', async () => {
    // 이 케이스가 없으면 항상 warn을 남기는 구현도 통과하고, 그러면 로그가
    // 폴백의 신호가 아니라 상수가 된다.
    generate.mockResolvedValue(FULL_RESPONSE);
    const structurer = await createStructurer();

    await structurer.structure('제주 2박3일');

    expect(warnLog).not.toHaveBeenCalled();
  });
});

describe('QueryStructurer — 원문 폴백', () => {
  const UNPARSEABLE = '질의를 만들 수 없습니다.';

  it('의미 축을 얻지 못하면 원문을 질의로 쓰고 warn 1건을 남긴다', async () => {
    // 신규 함정 2의 주 방어선. 이 로그가 사라지면 폴백이 늘 발동해도
    // HTTP 응답은 200이고 조건 요약도 정상으로 보인다.
    generate.mockResolvedValue(UNPARSEABLE);
    const structurer = await createStructurer();

    const query = await structurer.structure('제주 2박3일 가족여행 짜줘');

    expect(query.queryText).toBe('제주 2박3일 가족여행 짜줘');
    expect(query.fellBackToRawMessage).toBe(true);
    expect(query.conditions.region).toBeNull();
    expect(query.conditions.travelers).toBeNull();
    expect(query.droppedLabels).toEqual([]);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(firstWarnMessage(warnLog)).toContain(`길이=${UNPARSEABLE.length}`);
  });

  it('폴백 로그가 정규화 결과 40자까지만 남긴다', async () => {
    // 원시 응답을 통째로 흘리는 회귀 방어. 모델이 규칙을 어기고 사용자 문장을
    // 되풀이할 수 있으므로 상한이 노출을 문장 조각 수준으로 묶는다.
    generate.mockResolvedValue('가'.repeat(200));
    const structurer = await createStructurer();

    await structurer.structure('안녕');

    const logged = firstWarnMessage(warnLog);
    expect(logged).toContain('길이=200');
    expect(logged).toContain('가'.repeat(40));
    expect(logged).not.toContain('가'.repeat(41));
  });

  it('EMPTY_CONDITIONS를 오염시키지 않는다', async () => {
    // 폴백이 공유 상수를 직접 채우면 다음 요청이 앞 요청의 조건을 물려받는다.
    generate
      .mockResolvedValueOnce(UNPARSEABLE)
      .mockResolvedValueOnce(UNPARSEABLE);
    const structurer = await createStructurer();

    const first = await structurer.structure('제주');
    first.conditions.region = '오염';
    const second = await structurer.structure('부산');

    expect(second.conditions.region).toBeNull();
  });
});

describe('QueryStructurer — 부분 실패', () => {
  it('버린 항목이 있으면 warn 1건에 라벨 이름을 담고 살아남은 필드는 유지한다', async () => {
    generate.mockResolvedValue(
      [
        '[조건]',
        '지역: 부산',
        '분류: 레포츠',
        '[질의]',
        '무엇을 하는 곳: 등산',
      ].join('\n'),
    );
    const structurer = await createStructurer();

    const query = await structurer.structure('부산 레포츠 추천');

    expect(query.conditions.region).toBe('부산');
    expect(query.conditions.category).toBeNull();
    expect(query.fellBackToRawMessage).toBe(false);
    expect(warnLog).toHaveBeenCalledTimes(1);
    const logged = firstWarnMessage(warnLog);
    expect(logged).toContain('분류:');
    // 값은 담지 않는다 — 사용자 문장에서 온 텍스트다.
    expect(logged).not.toContain('레포츠');
  });

  it('↔ 짝: 버린 항목이 없으면 그 로그가 없다', async () => {
    generate.mockResolvedValue(FULL_RESPONSE);
    const structurer = await createStructurer();

    const query = await structurer.structure('제주 2박3일');

    expect(query.droppedLabels).toEqual([]);
    expect(warnLog).not.toHaveBeenCalled();
  });
});

describe('QueryStructurer — 폴백의 경계선', () => {
  /**
   * 해석 실패는 "모델이 뭐라 했는지 모른다"이고, 쿼터 소진은 "모델이 대답할 수
   * 없었다"는 확정된 사실이다. structure를 try/catch로 감싸면 쿼터 소진이
   * "질의를 이해하지 못했다"가 되고 503도 Retry-After도 사라진다.
   */
  function quotaFailure(): ExternalServiceError {
    return new ExternalServiceError('gemini', 'quota', '쿼터 소진');
  }

  it('gemini 호출 실패는 같은 인스턴스로 그대로 올라간다', async () => {
    const failure = quotaFailure();
    generate.mockRejectedValue(failure);
    const structurer = await createStructurer();

    await expect(structurer.structure('안녕')).rejects.toBe(failure);
  });

  it('호출 실패에는 폴백 warn을 남기지 않는다', async () => {
    // ↔ 짝. 실패 로그는 callExternal의 몫이다. 여기서 warn을 남기면 폴백 로그와
    // 실패 로그가 섞여 "해석 실패 관측"이라는 신호가 오염된다.
    generate.mockRejectedValue(quotaFailure());
    const structurer = await createStructurer();

    await structurer.structure('안녕').catch(() => undefined);

    expect(warnLog).not.toHaveBeenCalled();
  });
});
