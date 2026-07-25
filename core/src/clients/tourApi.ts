import axios from "axios";
import { optionalEnv, requireEnv } from "../lib/env.js";

const MOBILE_OS = "ETC";
const MOBILE_APP = "travel-builder";
const DEFAULT_BASE_URL = "https://apis.data.go.kr/B551011/KorService2";
const MAX_PAGES = 1000;

export interface TourApiListParams {
  areaCode?: string;
  sigunguCode?: string;
  cat1?: string;
  cat2?: string;
  cat3?: string;
  contentTypeId?: string;
  numOfRows?: number;
  pageNo?: number;
  /** 정렬 옵션. TourAPI 실제 쿼리 파라미터명은 arrangeType이 아니라 arrange다. */
  arrange?: string;
}

export interface TourApiAreaItem {
  contentid: string;
  contenttypeid: string;
  title: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  tel: string;
  firstimage: string;
  firstimage2: string;
  mapx: string;
  mapy: string;
  areacode: string;
  sigungucode: string;
  cat1: string;
  cat2: string;
  cat3: string;
  createdtime: string;
  modifiedtime: string;
}

/** areaBasedSyncList2 응답 항목 (KorService2 v4.4). */
export interface TourApiSyncItem {
  contentid: string;
  contenttypeid: string;
  title: string;
  mapx: string;
  mapy: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  lDongRegnCd: string;
  lDongSignguCd: string;
  lclsSystm1: string;
  lclsSystm2: string;
  lclsSystm3: string;
  createdtime: string;
  modifiedtime: string;
  showflag: string;
}

/** 페이지네이션 정보를 포함한 한 페이지 응답. */
export interface TourApiPage<T> {
  items: T[];
  totalCount: number;
  pageNo: number;
  numOfRows: number;
}

export interface TourApiSyncListParams {
  pageNo: number;
  numOfRows: number;
  contentTypeId?: string;
  lDongRegnCd?: string;
  lDongSignguCd?: string;
  lclsSystm1?: string;
  lclsSystm2?: string;
  lclsSystm3?: string;
  showflag?: "0" | "1";
  modifiedtime?: string;
  arrange?: string;
}

export interface TourApiDetailCommon {
  contentid: string;
  contenttypeid: string;
  title: string;
  createdtime: string;
  modifiedtime: string;
  tel: string;
  telname: string;
  homepage: string;
  firstimage: string;
  firstimage2: string;
  areacode: string;
  sigungucode: string;
  cat1: string;
  cat2: string;
  cat3: string;
  addr1: string;
  addr2: string;
  zipcode: string;
  mapx: string;
  mapy: string;
  overview: string;
}

export interface TourApiImage {
  contentid: string;
  imgname: string;
  originimgurl: string;
  serialnum: string;
  smallimageurl: string;
  cpyrhtDivCd: string;
}

export interface TourApiLclsSystmItem {
  lclsSystm1Cd: string;
  lclsSystm1Nm: string;
  lclsSystm2Cd: string;
  lclsSystm2Nm: string;
  lclsSystm3Cd: string;
  lclsSystm3Nm: string;
}

export interface TourApiLdongCodeItem {
  code: string;
  name: string;
}

export interface TourApiLdongItem {
  lDongRegnCd: string;
  lDongRegnNm: string;
  lDongSignguCd: string;
  lDongSignguNm: string;
}

interface TourApiEnvelope<T> {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: {
      items: { item?: T | T[] } | "";
      numOfRows: number;
      pageNo: number;
      totalCount: number;
    };
  };
}

function normalizeItems<T>(items: { item?: T | T[] } | ""): T[] {
  if (items === "") return [];
  const item = items.item;
  if (item === undefined) return [];
  return Array.isArray(item) ? item : [item];
}

const NO_DATA_CODE = "03";
const QUOTA_CODES = new Set(["22", "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"]);
/** data.go.kr이 JSON 봉투 대신 XML 에러를 반환할 때 본문에서 찾을 한도초과 표지. */
const QUOTA_BODY_MARKERS = [
  "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
  "<returnReasonCode>22</returnReasonCode>",
];

/** TourAPI가 반환한 resultCode를 필드로 노출하는 오류. */
export class TourApiError extends Error {
  constructor(
    readonly resultCode: string,
    readonly resultMsg: string,
  ) {
    super(`TourAPI 오류(${resultCode}): ${resultMsg}`);
    this.name = "TourApiError";
  }
}

/** 데이터 없음(03) 여부. 재시도해도 결과가 달라지지 않는다. */
export function isNoData(e: unknown): boolean {
  return e instanceof TourApiError && e.resultCode === NO_DATA_CODE;
}

/**
 * 일일 호출 한도 초과 여부.
 * 데이터의 문제가 아니라 호출자 사정이므로, 호출자는 해당 항목의 상태를 바꾸지 않고 중단해야 한다.
 */
export function isQuotaExceeded(e: unknown): boolean {
  return e instanceof TourApiError && QUOTA_CODES.has(e.resultCode);
}

/**
 * 응답 본문을 검증된 봉투로 변환한다.
 * 한도 초과 시 data.go.kr이 `_type=json`을 무시하고 XML을 반환하는 경우가 있어,
 * 봉투 파싱 실패 경로에서도 한도초과를 반드시 판별해야 한다.
 * (이걸 놓치면 한도초과가 "그 외 오류"로 오분류되어 멀쩡한 항목의 실패 횟수가 누적된다.)
 */
function parseEnvelope<T>(data: unknown): TourApiEnvelope<T> {
  const header = (data as TourApiEnvelope<T> | undefined)?.response?.header;
  if (header?.resultCode === undefined) {
    const body = typeof data === "string" ? data : JSON.stringify(data ?? "");
    if (QUOTA_BODY_MARKERS.some((marker) => body.includes(marker))) {
      throw new TourApiError("22", "일일 호출 한도를 초과했습니다.");
    }
    throw new TourApiError("UNKNOWN", `예상치 못한 응답 형식: ${body.slice(0, 200)}`);
  }
  if (header.resultCode !== "0000") {
    throw new TourApiError(header.resultCode, header.resultMsg);
  }
  return data as TourApiEnvelope<T>;
}

/** 한국관광공사 TourAPI 4.0(KorService2) 연동 클라이언트 (무상태). */
export class TourApiClient {
  private readonly serviceKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.serviceKey = requireEnv("TOUR_API_SERVICE_KEY");
    this.baseUrl = optionalEnv("TOUR_API_BASE_URL", DEFAULT_BASE_URL);
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const fixed = `serviceKey=${this.serviceKey}&MobileOS=${MOBILE_OS}&MobileApp=${MOBILE_APP}&_type=json`;
    const dynamic = Object.entries(params)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("&");
    return dynamic ? `${this.baseUrl}/${path}?${fixed}&${dynamic}` : `${this.baseUrl}/${path}?${fixed}`;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const url = this.buildUrl(path, params);
    const { data } = await axios.get<unknown>(url);
    const envelope = parseEnvelope<T>(data);
    return normalizeItems(envelope.response.body.items);
  }

  private async requestPage<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<TourApiPage<T>> {
    const url = this.buildUrl(path, params);
    const { data } = await axios.get<unknown>(url);
    const envelope = parseEnvelope<T>(data);
    const body = envelope.response.body;
    return {
      items: normalizeItems(body.items),
      totalCount: body.totalCount,
      pageNo: body.pageNo,
      numOfRows: body.numOfRows,
    };
  }

  private async requestAll<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    numOfRows: number,
  ): Promise<T[]> {
    const results: T[] = [];
    let pageNo = 1;
    while (true) {
      if (pageNo > MAX_PAGES) {
        throw new Error(
          `TourAPI: ${path} 페이지네이션이 ${MAX_PAGES}페이지를 초과했습니다.`,
        );
      }
      const { data } = await axios.get<unknown>(
        this.buildUrl(path, { ...params, numOfRows, pageNo }),
      );
      const envelope = parseEnvelope<T>(data);
      const items = normalizeItems(envelope.response.body.items);
      results.push(...items);
      if (items.length === 0 || results.length >= envelope.response.body.totalCount) {
        break;
      }
      pageNo += 1;
    }
    return results;
  }

  /** 지역기반 관광정보 목록을 조회한다. */
  async getAreaBasedList(params: TourApiListParams = {}): Promise<TourApiAreaItem[]> {
    return this.request<TourApiAreaItem>("areaBasedList2", {
      numOfRows: params.numOfRows ?? 10,
      pageNo: params.pageNo ?? 1,
      areaCode: params.areaCode,
      sigunguCode: params.sigunguCode,
      cat1: params.cat1,
      cat2: params.cat2,
      cat3: params.cat3,
      contentTypeId: params.contentTypeId,
      arrange: params.arrange,
    });
  }

  /** 동기화 목록(areaBasedSyncList2) 한 페이지를 조회한다. */
  async getAreaBasedSyncList(params: TourApiSyncListParams): Promise<TourApiPage<TourApiSyncItem>> {
    return this.requestPage<TourApiSyncItem>("areaBasedSyncList2", {
      pageNo: params.pageNo,
      numOfRows: params.numOfRows,
      contentTypeId: params.contentTypeId,
      lDongRegnCd: params.lDongRegnCd,
      lDongSignguCd: params.lDongSignguCd,
      lclsSystm1: params.lclsSystm1,
      lclsSystm2: params.lclsSystm2,
      lclsSystm3: params.lclsSystm3,
      showflag: params.showflag,
      modifiedtime: params.modifiedtime,
      arrange: params.arrange,
    });
  }

  /**
   * 관광지 공통정보를 조회한다.
   * v4.3에서 defaultYN/firstImageYN/areacodeYN/catcodeYN/addrinfoYN/mapinfoYN/overviewYN이
   * 삭제되어 contentId만 전송한다.
   * 결과가 없으면 NODATA(03)로 던져 호출자가 isNoData로 종결 처리할 수 있게 한다.
   */
  async getDetailCommon(contentId: string): Promise<TourApiDetailCommon> {
    const items = await this.request<TourApiDetailCommon>("detailCommon2", { contentId });
    if (items.length === 0) {
      throw new TourApiError(
        "03",
        `contentId=${contentId}에 대한 공통정보를 찾을 수 없습니다.`,
      );
    }
    return items[0];
  }

  /** 관광지 소개정보를 조회한다. contentTypeId에 따라 필드 구성이 달라 원본 키-값으로 반환한다. */
  async getDetailIntro(contentId: string, contentTypeId: string): Promise<Record<string, string>> {
    const items = await this.request<Record<string, string>>("detailIntro2", {
      contentId,
      contentTypeId,
    });
    if (items.length === 0) {
      throw new Error(
        `TourAPI: contentId=${contentId}, contentTypeId=${contentTypeId}에 대한 소개정보를 찾을 수 없습니다.`,
      );
    }
    return items[0];
  }

  /** 관광지 이미지 목록을 조회한다. 이미지가 없으면 빈 배열을 반환한다. */
  async getDetailImages(contentId: string): Promise<TourApiImage[]> {
    return this.request<TourApiImage>("detailImage2", {
      contentId,
      imageYN: "Y",
      numOfRows: 100,
      pageNo: 1,
    });
  }

  /** 분류체계(대/중/소분류) 전체 코드 트리를 조회한다. */
  async getLclsSystmTree(): Promise<TourApiLclsSystmItem[]> {
    return this.requestAll<TourApiLclsSystmItem>("lclsSystmCode2", { lclsSystmListYn: "Y" }, 1000);
  }

  /** 법정동 시도 코드 목록을 조회한다. */
  async getLdongRegionList(): Promise<TourApiLdongCodeItem[]> {
    return this.requestAll<TourApiLdongCodeItem>("ldongCode2", { lDongListYn: "N" }, 100);
  }

  /** 특정 시도의 법정동 시군구 코드 목록을 조회한다. */
  async getLdongSignguList(regnCd: string): Promise<TourApiLdongItem[]> {
    return this.requestAll<TourApiLdongItem>(
      "ldongCode2",
      { lDongRegnCd: regnCd, lDongListYn: "Y" },
      1000,
    );
  }
}
