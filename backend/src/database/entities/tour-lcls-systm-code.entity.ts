import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 관광 분류체계 코드표 (3단계). core/src/commands/generateTourCodes.ts가 소유한다.
 *
 * 복합 PK (lvl1_code, lvl2_code, lvl3_code). 상위 레벨만 있는 행은
 * 하위 코드가 ''다 — tour_ldong_codes와 같은 센티널 규칙.
 */
@Entity({ name: 'tour_lcls_systm_codes', synchronize: false })
export class TourLclsSystmCode {
  @PrimaryColumn({ type: 'text', name: 'lvl1_code' })
  lvl1Code: string;

  @PrimaryColumn({ type: 'text', name: 'lvl2_code', default: '' })
  lvl2Code: string;

  @PrimaryColumn({ type: 'text', name: 'lvl3_code', default: '' })
  lvl3Code: string;

  @Column({ type: 'text', name: 'lvl1_name' })
  lvl1Name: string;

  @Column({ type: 'text', name: 'lvl2_name', default: '' })
  lvl2Name: string;

  @Column({ type: 'text', name: 'lvl3_name', default: '' })
  lvl3Name: string;
}
