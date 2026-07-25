import type { TourApiSyncItem } from "../clients/tourApi.js";

/**
 * tour_contents 테이블의 목록 유래 컬럼.
 * 코드→이름 변환은 여기서 하지 않는다. DB에는 코드만 저장하고,
 * 이름은 읽는 쪽에서 코드표(tour_ldong_codes 등)와 join해 얻는다.
 */
export interface TourContentRow {
  contentid: string;
  contenttypeid: string;
  title: string;
  mapx: string;
  mapy: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  ldongRegnCd: string;
  ldongSignguCd: string;
  lclsSystm1: string;
  lclsSystm2: string;
  lclsSystm3: string;
  modifiedtime: string;
}

/** 값이 없으면 빈 문자열로 정규화한다. 컬럼이 전부 NOT NULL DEFAULT ''이기 때문. */
function str(value: string | undefined | null): string {
  return value ?? "";
}

/** syncList 항목에서 저장 대상 필드만 뽑는다 (순수 함수). */
export function toTourContentRow(item: TourApiSyncItem): TourContentRow {
  return {
    contentid: str(item.contentid),
    contenttypeid: str(item.contenttypeid),
    title: str(item.title),
    mapx: str(item.mapx),
    mapy: str(item.mapy),
    addr1: str(item.addr1),
    addr2: str(item.addr2),
    zipcode: str(item.zipcode),
    ldongRegnCd: str(item.lDongRegnCd),
    ldongSignguCd: str(item.lDongSignguCd),
    lclsSystm1: str(item.lclsSystm1),
    lclsSystm2: str(item.lclsSystm2),
    lclsSystm3: str(item.lclsSystm3),
    modifiedtime: str(item.modifiedtime),
  };
}
