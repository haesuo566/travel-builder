import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ExternalServiceError } from '../../clients/external-service.error';
import type { GeminiGenerateOptions } from '../../clients/gemini/gemini.client';
import { GeminiClient } from '../../clients/gemini/gemini.client';
import { OTHER_REPLY, OTHER_SYSTEM_INSTRUCTION } from './other-prompt';
import { OtherResponder } from './other.responder';

/**
 * 모킹 경계는 GeminiClient다. 검증기는 실물을 태운다 —
 * 그쪽 경계값은 other-prompt.spec.ts가 고정한다.
 */

const generate = jest.fn<Promise<string>, [string, GeminiGenerateOptions?]>();

const NORMAL_REPLY =
  '제주는 사계절 모두 좋아요. 어느 계절을 생각하고 계신가요?';

async function createResponder(): Promise<OtherResponder> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OtherResponder,
      { provide: GeminiClient, useValue: { generate } },
    ],
  }).compile();
  return moduleRef.get(OtherResponder);
}

let warnLog: jest.SpyInstance;

beforeEach(() => {
  generate.mockReset();
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OtherResponder — 호출 계약', () => {
  it('systemInstruction·temperature 0.7·model 미지정으로 호출하고 프롬프트에 메시지를 담는다', async () => {
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await responder.respond('제주 어때?');

    const [prompt, opts] = generate.mock.calls[0];
    expect(prompt).toContain('제주 어때?');
    expect(opts?.systemInstruction).toBe(OTHER_SYSTEM_INSTRUCTION);
    // 이 저장소의 0 외 첫 temperature다. 미지정으로 되돌리면 움직이는 모델
    // 별칭의 기본값에 위임하게 되고, 움직이는 부분이 둘이 된다.
    expect(opts?.temperature).toBe(0.7);
    expect(opts?.model).toBeUndefined();
  });

  it('generate를 한 번만 호출한다', async () => {
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await responder.respond('안녕');

    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('OtherResponder — 응답 판정', () => {
  it('정상 응답을 그대로 돌려주고 warn을 남기지 않는다', async () => {
    generate.mockResolvedValue(NORMAL_REPLY);
    const responder = await createResponder();

    await expect(responder.respond('제주 어때?')).resolves.toBe(NORMAL_REPLY);
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('501자 응답은 고정 문구로 대체하고 warn 1건을 남긴다', async () => {
    // 긍정 단정이다. 이 폴백은 화면상 직전 실행의 정상 응답과 구별되지 않으므로
    // 등가 단정과 warn 단정이 유일한 관측 수단이다(신규 함정 2).
    generate.mockResolvedValue('가'.repeat(501));
    const responder = await createResponder();

    await expect(responder.respond('안녕')).resolves.toBe(OTHER_REPLY);
    expect(warnLog).toHaveBeenCalledTimes(1);
  });

  it('↔ 짝: 500자 응답은 대체하지 않는다', async () => {
    const exact = '가'.repeat(500);
    generate.mockResolvedValue(exact);
    const responder = await createResponder();

    await expect(responder.respond('안녕')).resolves.toBe(exact);
    expect(warnLog).not.toHaveBeenCalled();
  });
});

describe('OtherResponder — 폴백의 경계선', () => {
  function quotaFailure(): ExternalServiceError {
    return new ExternalServiceError('gemini', 'quota', '쿼터 소진');
  }

  it('gemini 호출 실패는 같은 인스턴스로 그대로 올라간다', async () => {
    // 여기에 try/catch를 두면 쿼터 소진이 안내 문구가 되고 503도 Retry-After도
    // 사라진다 — 게다가 그 문구는 정상 응답과 구별되지 않는다.
    const failure = quotaFailure();
    generate.mockRejectedValue(failure);
    const responder = await createResponder();

    await expect(responder.respond('안녕')).rejects.toBe(failure);
  });

  it('호출 실패에는 폴백 warn을 남기지 않는다', async () => {
    // ↔ 짝. 실패 로그는 callExternal의 몫이다.
    generate.mockRejectedValue(quotaFailure());
    const responder = await createResponder();

    await responder.respond('안녕').catch(() => undefined);

    expect(warnLog).not.toHaveBeenCalled();
  });
});
