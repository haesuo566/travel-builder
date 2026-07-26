import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 관광 콘텐츠 타입 코드표. core/src/commands/generateTourCodes.ts가 소유한다.
 *
 * tour_contents.contenttypeid가 이 code를 참조하지만 FK 제약은 없다 —
 * core가 LEFT JOIN + COALESCE로 다루는 soft reference이므로
 * 코드표에 없는 신규 코드도 적재된다. 관계를 걸지 않고 코드값으로 조인한다.
 */
@Entity({ name: 'tour_content_types', synchronize: false })
export class TourContentType {
  @PrimaryColumn({ type: 'text', name: 'code' })
  code: string;

  @Column({ type: 'text', name: 'name' })
  name: string;
}
