import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { In } from 'typeorm';
import type { FindOperator } from 'typeorm';

import { TourContent } from './entities';
import { TourContentLookup } from './tour-content.lookup';

/**
 * 리포지토리를 모킹한다. 실제 Postgres는 사내망에서만 도달하므로 단위 테스트가
 * 붙을 수 없고, 여기서 보는 것은 SQL이 아니라 **순서 재정렬과 누락 처리**다 —
 * 둘 다 DB가 아니라 이 클래스가 책임진다.
 */
interface FindArgs {
  where: { contentid: FindOperator<string> };
}

/**
 * FindManyOptions 대신 좁은 타입을 쓴다. 넓게 받으면 where가 유니온이라
 * contentid를 읽을 때 캐스팅이 필요해지고, 캐스팅은 오타를 그대로 통과시킨다
 * (backend-constraints.md의 typed-lint 절).
 */
const find = jest.fn<Promise<TourContent[]>, [FindArgs]>();

/**
 * 이 클래스가 읽는 필드는 contentid 하나이고 호출자가 읽는 것은 title 하나다.
 * 나머지 25개 컬럼을 채우면 무엇이 이 테스트에 실제로 쓰이는지 흐려진다.
 */
function createRow(contentid: string, title: string): TourContent {
  const row = new TourContent();
  row.contentid = contentid;
  row.title = title;
  return row;
}

function logMessages(spy: jest.SpyInstance): string[] {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls.map((call) => String(call[0]));
}

async function createLookup(): Promise<TourContentLookup> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      TourContentLookup,
      { provide: getRepositoryToken(TourContent), useValue: { find } },
    ],
  }).compile();
  return moduleRef.get(TourContentLookup);
}

let warnLog: jest.SpyInstance;

beforeEach(() => {
  find.mockReset();
  warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TourContentLookup — 요청한 순서를 지킨다', () => {
  it('DB가 다른 순서로 돌려줘도 요청한 contentid 순서로 낸다', async () => {
    // TypeORM의 In() 조회는 입력 배열 순서를 보장하지 않는다. 호출자가 넘기는
    // 순서는 Qdrant의 관련도 순서이므로, 재정렬하지 않으면 1위가 임의의 자리로
    // 밀린다 — 응답은 여전히 200이라 아무도 모른다.
    find.mockResolvedValue([
      createRow('c3', '우도'),
      createRow('c1', '성산일출봉'),
      createRow('c2', '한라산'),
    ]);
    const lookup = await createLookup();

    const rows = await lookup.findByIds(['c1', 'c2', 'c3']);

    expect(rows.map((row) => row.contentid)).toEqual(['c1', 'c2', 'c3']);
    expect(rows.map((row) => row.title)).toEqual([
      '성산일출봉',
      '한라산',
      '우도',
    ]);
  });

  it('요청한 id 전부를 한 번의 조회로 넘긴다', async () => {
    // id마다 한 번씩 조회하면 hit 10건에 왕복 10회가 된다.
    find.mockResolvedValue([createRow('c1', '성산일출봉')]);
    const lookup = await createLookup();

    await lookup.findByIds(['c1', 'c2']);

    expect(find).toHaveBeenCalledTimes(1);
    const [options] = find.mock.calls[0];
    expect(options.where.contentid).toEqual(In(['c1', 'c2']));
  });

  it('빈 배열이면 DB를 조회하지 않는다', async () => {
    // hit 0건이면 여기 빈 배열이 온다. 그대로 In([])을 보내면 조건이 비어
    // "전체 조회"가 되거나 드라이버가 문법 오류를 내며, 어느 쪽이든 왕복이
    // 통째로 낭비된다.
    const lookup = await createLookup();

    const rows = await lookup.findByIds([]);

    expect(rows).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});

describe('TourContentLookup — 없는 id를 버린다', () => {
  it('tour_contents에 없는 contentid는 빼고 나머지를 낸다', async () => {
    // Qdrant 색인과 Postgres 사이에 삭제·미동기화가 있을 수 있다. 한 건이
    // 없다고 통째로 실패시키면 나머지 9건도 화면에서 사라진다.
    find.mockResolvedValue([createRow('c1', '성산일출봉')]);
    const lookup = await createLookup();

    const rows = await lookup.findByIds(['c1', 'c2']);

    expect(rows.map((row) => row.contentid)).toEqual(['c1']);
  });

  it('버린 건수와 contentid를 warn으로 남긴다', async () => {
    // 색인이 어긋났다는 사실을 볼 수 있는 지점이 이 로그 하나다. 건수만 남기면
    // 어느 쪽이 밀렸는지 확인하러 갈 곳이 없으므로 id도 함께 싣는다.
    find.mockResolvedValue([createRow('c1', '성산일출봉')]);
    const lookup = await createLookup();

    await lookup.findByIds(['c1', 'c2', 'c3']);

    expect(warnLog).toHaveBeenCalledTimes(1);
    const message = logMessages(warnLog)[0];
    expect(message).toContain('2건');
    expect(message).toContain('c2');
    expect(message).toContain('c3');
    expect(message).not.toContain('c1');
  });

  it('↔ 짝: 전부 찾으면 warn을 남기지 않는다', async () => {
    // 이 짝이 없으면 항상 경고하는 구현도 통과하고, 그러면 경고가 신호로서
    // 쓸모를 잃어 실제 색인 어긋남이 소음에 묻힌다.
    find.mockResolvedValue([
      createRow('c1', '성산일출봉'),
      createRow('c2', '한라산'),
    ]);
    const lookup = await createLookup();

    await lookup.findByIds(['c1', 'c2']);

    expect(warnLog).not.toHaveBeenCalled();
  });
});

describe('TourContentLookup — 실패를 삼키지 않는다', () => {
  it('조회 실패를 그대로 던진다', async () => {
    // 협력자 다섯에 걸린 규칙과 같은 방향이다. 여기서 빈 배열로 축퇴시키면
    // DB 장애가 "조건에 맞는 장소가 없다"로 둔갑하고 사용자는 자기 조건을
    // 고치려 든다.
    const failure = new Error('연결이 끊겼습니다.');
    find.mockRejectedValue(failure);
    const lookup = await createLookup();

    await expect(lookup.findByIds(['c1'])).rejects.toBe(failure);
  });
});
