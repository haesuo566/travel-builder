import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 법정동 지역 코드표 (시도 + 시군구). core/src/commands/generateTourCodes.ts가 소유한다.
 *
 * 복합 PK (regn_code, signgu_code). 시도 단위 행은 signgu_code가 ''이며
 * NULL이 아니다 — PK에 NULL을 넣을 수 없어 빈 문자열을 센티널로 쓴다.
 */
@Entity({ name: 'tour_ldong_codes', synchronize: false })
export class TourLdongCode {
  @PrimaryColumn({ type: 'text', name: 'regn_code' })
  regnCode: string;

  @PrimaryColumn({ type: 'text', name: 'signgu_code', default: '' })
  signguCode: string;

  @Column({ type: 'text', name: 'regn_name' })
  regnName: string;

  @Column({ type: 'text', name: 'signgu_name', default: '' })
  signguName: string;
}
