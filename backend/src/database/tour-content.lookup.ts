import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TourContent } from './entities';

/**
 * contentid로 tour_contents를 읽는 조회 전용 클래스.
 *
 * 이름에 Lookup이 들어간 것은 의도다 — 쓰기 메서드가 없다는 사실이 타입에
 * 드러난다(QdrantSearchClient의 Search와 같은 판단). 스키마 소유권은 core에
 * 있으므로 이 방향으로만 쓴다.
 *
 * 실패를 kind로 분류하지 않는다. clients/의 세 HTTP 클라이언트는 callExternal로
 * ExternalServiceError를 만들지만 여기서는 TypeORM 오류를 그대로 던진다 —
 * 전역 필터가 잡지 않으므로 Nest 기본 처리로 500이 된다. 삼키지 않는다는
 * 원칙은 지키면서 분류 체계를 새로 세우지는 않는 선택이다.
 */
@Injectable()
export class TourContentLookup {
  private readonly logger = new Logger(TourContentLookup.name);

  constructor(
    @InjectRepository(TourContent)
    private readonly repository: Repository<TourContent>,
  ) {}

  /**
   * 요청한 contentid 순서를 그대로 유지해 돌려준다.
   *
   * **재정렬이 이 메서드의 핵심이다.** In() 조회는 입력 배열 순서를 보장하지
   * 않는데, 호출자가 넘기는 순서는 Qdrant의 관련도 순서이자 사용자에게 보여줄
   * 순서다. DB가 준 순서를 그대로 쓰면 관련도 1위가 임의의 자리로 밀리고,
   * 응답은 정상 200이라 아무도 알아채지 못한다.
   *
   * 없는 id는 버린다. Qdrant 색인과 Postgres 사이에 삭제·미동기화가 있을 수
   * 있고, 한 건 때문에 통째로 실패시키면 나머지도 화면에서 사라진다
   * (parseTourContentPayload가 파싱 실패 hit을 버리는 것과 같은 판단).
   */
  async findByIds(contentids: string[]): Promise<TourContent[]> {
    // In([])은 조건이 비어 전체 조회가 되거나 드라이버가 문법 오류를 낸다.
    if (contentids.length === 0) return [];

    const rows = await this.repository.find({
      where: { contentid: In(contentids) },
    });

    const rowById = new Map(rows.map((row) => [row.contentid, row]));
    const missing = contentids.filter((id) => !rowById.has(id));

    if (missing.length > 0) {
      // 건수만으로는 확인하러 갈 곳이 없다. 색인이 어긋난 id를 함께 싣는다.
      this.logger.warn(
        `tour_contents에서 찾지 못한 contentid ${missing.length}건을 버렸습니다: ${missing.join(', ')}`,
      );
    }

    return contentids
      .map((id) => rowById.get(id))
      .filter((row): row is TourContent => row !== undefined);
  }
}
