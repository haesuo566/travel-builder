import axios from "axios";
import { optionalEnv, requireEnv } from "../lib/env.js";

const MOBILE_OS = "ETC";
const MOBILE_APP = "travel-builder";
const DEFAULT_BASE_URL = "https://apis.data.go.kr/B551011/KorService2";

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
    const { data } = await axios.get<TourApiEnvelope<T>>(url);
    if (data.response.header.resultCode !== "0000") {
      throw new Error(
        `TourAPI 오류(${data.response.header.resultCode}): ${data.response.header.resultMsg}`,
      );
    }
    return normalizeItems(data.response.body.items);
  }

  private async requestAll<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    numOfRows: number,
  ): Promise<T[]> {
    const results: T[] = [];
    let pageNo = 1;
    while (true) {
      const url = this.buildUrl(path, { ...params, numOfRows, pageNo });
      const { data } = await axios.get<TourApiEnvelope<T>>(url);
      if (data.response.header.resultCode !== "0000") {
        throw new Error(
          `TourAPI 오류(${data.response.header.resultCode}): ${data.response.header.resultMsg}`,
        );
      }
      const items = normalizeItems(data.response.body.items);
      results.push(...items);
      if (items.length === 0 || results.length >= data.response.body.totalCount) {
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

  /** 관광지 공통정보를 조회한다. */
  async getDetailCommon(contentId: string): Promise<TourApiDetailCommon> {
    const items = await this.request<TourApiDetailCommon>("detailCommon2", {
      contentId,
      defaultYN: "Y",
      firstImageYN: "Y",
      areacodeYN: "Y",
      catcodeYN: "Y",
      addrinfoYN: "Y",
      mapinfoYN: "Y",
      overviewYN: "Y",
    });
    if (items.length === 0) {
      throw new Error(`TourAPI: contentId=${contentId}에 대한 공통정보를 찾을 수 없습니다.`);
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
}
