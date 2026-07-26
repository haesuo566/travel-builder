import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 상세 수집 단계의 상태. core의 DetailStatus와 동일한 값 집합. */
export type DetailStatus = 'pending' | 'done' | 'nodata' | 'failed';

/** 구조화·임베딩 스테이지의 상태. nodata는 상세 단계 고유 개념이라 쓰지 않는다. */
export type StageStatus = 'pending' | 'done' | 'failed';

/**
 * core가 소유하는 tour_contents 테이블의 읽기 매핑.
 *
 * DDL은 core/src/lib/tourContentsTable.ts가 CREATE TABLE IF NOT EXISTS와
 * ADD COLUMN IF NOT EXISTS로 관리한다. 이 엔티티는 그 스키마를 따라가는 쪽이므로
 * 컬럼을 추가·변경할 때는 core를 먼저 고치고 여기에 반영한다.
 *
 * 상태 컬럼은 pg enum이 아니라 TEXT다 — type: 'enum'으로 바꾸면 실제 스키마와 어긋난다.
 */
@Entity({ name: 'tour_contents', synchronize: false })
export class TourContent {
  @PrimaryColumn({ type: 'text', name: 'contentid' })
  contentid: string;

  @Column({ type: 'text', name: 'contenttypeid' })
  contenttypeid: string;

  @Column({ type: 'text', name: 'title' })
  title: string;

  @Column({ type: 'text', name: 'mapx', default: '' })
  mapx: string;

  @Column({ type: 'text', name: 'mapy', default: '' })
  mapy: string;

  @Column({ type: 'text', name: 'addr1', default: '' })
  addr1: string;

  @Column({ type: 'text', name: 'addr2', default: '' })
  addr2: string;

  @Column({ type: 'text', name: 'zipcode', default: '' })
  zipcode: string;

  @Column({ type: 'text', name: 'ldong_regn_cd', default: '' })
  ldongRegnCd: string;

  @Column({ type: 'text', name: 'ldong_signgu_cd', default: '' })
  ldongSignguCd: string;

  @Column({ type: 'text', name: 'lcls_systm1', default: '' })
  lclsSystm1: string;

  @Column({ type: 'text', name: 'lcls_systm2', default: '' })
  lclsSystm2: string;

  @Column({ type: 'text', name: 'lcls_systm3', default: '' })
  lclsSystm3: string;

  @Column({ type: 'text', name: 'modifiedtime', default: '' })
  modifiedtime: string;

  /** null = 아직 상세를 조회하지 않음, '' = 조회했으나 내용 없음(nodata). */
  @Column({ type: 'text', name: 'overview', nullable: true })
  overview: string | null;

  @Column({ type: 'text', name: 'detail_status', default: 'pending' })
  detailStatus: DetailStatus;

  @Column({ type: 'int', name: 'attempt_count', default: 0 })
  attemptCount: number;

  @Column({ type: 'text', name: 'last_error', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', name: 'detail_fetched_at', nullable: true })
  detailFetchedAt: Date | null;

  @Column({ type: 'timestamptz', name: 'listed_at', default: () => 'now()' })
  listedAt: Date;

  @Column({ type: 'text', name: 'structured_text', nullable: true })
  structuredText: string | null;

  @Column({ type: 'text', name: 'structure_status', default: 'pending' })
  structureStatus: StageStatus;

  @Column({ type: 'int', name: 'structure_attempt_count', default: 0 })
  structureAttemptCount: number;

  @Column({ type: 'text', name: 'structure_last_error', nullable: true })
  structureLastError: string | null;

  @Column({ type: 'timestamptz', name: 'structured_at', nullable: true })
  structuredAt: Date | null;

  @Column({ type: 'text', name: 'embed_status', default: 'pending' })
  embedStatus: StageStatus;

  @Column({ type: 'int', name: 'embed_attempt_count', default: 0 })
  embedAttemptCount: number;

  @Column({ type: 'text', name: 'embed_last_error', nullable: true })
  embedLastError: string | null;

  @Column({ type: 'timestamptz', name: 'embedded_at', nullable: true })
  embeddedAt: Date | null;
}
