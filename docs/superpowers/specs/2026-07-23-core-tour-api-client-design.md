# core TourApiClient 설계 (한국관광공사 TourAPI 4.0)

- 날짜: 2026-07-23
- 위치: `core/`
- 상태: 승인됨

## 목적

`core`에 한국관광공사 TourAPI 4.0(국문 관광정보 서비스) 연동 클래스를 만든다. travel-builder의 여행 일정 생성/RAG 파이프라인에 실제 관광 데이터를 공급하는 용도다.

## 결정 사항

| 항목 | 선택 |
|------|------|
| 지원 기능 | 지역기반 목록조회(`areaBasedList2`), 상세 공통/소개/이미지 조회(`detailCommon2`/`detailIntro2`/`detailImage2`) |
| HTTP 클라이언트 | axios (신규 의존성) |
| 서비스키 처리 | data.go.kr이 발급하는 인코딩된 키를 그대로 URL에 삽입 (재인코딩 금지) |
| API 버전 | KorService2 (신버전 — KorService1은 종료 예정) |
| Base URL | `https://apis.data.go.kr/B551011/KorService2` |
| 응답 포맷 | JSON (`_type=json`) |
| 수명주기 | 무상태 (GeminiClient와 동일 — connect/close 없음) |
| 테스트 | 단위 테스트, axios `vi.mock` |

## 아키텍처: 쿼리 조립 방식

data.go.kr 서비스키는 이미 URL 인코딩된 값으로 발급된다. axios의 `params` 옵션은 값을 내부적으로 재인코딩하므로 그대로 쓰면 서비스키가 **이중 인코딩**된다.

- **채택**: URL을 문자열로 직접 조립한다. `serviceKey`는 인코딩 없이 그대로 이어붙이고, 나머지 파라미터만 `encodeURIComponent`로 인코딩해 쿼리스트링을 만든 뒤, 완성된 전체 URL을 `axios.get(fullUrl)`로 호출한다(axios `params` 옵션 미사용).
- **기각**: axios `paramsSerializer` 커스터마이징 — 세밀 제어가 필요해 코드가 복잡해지는 데 비해 이점이 적다.

## 파일 구조

```
core/src/clients/tourApi.ts
core/tests/clients/tourApi.test.ts
```

기존 `core/src/lib/env.ts`(`requireEnv`/`optionalEnv`)를 재사용한다.

## 의존성 추가

- `axios`

## 클래스 인터페이스

**env**: `TOUR_API_SERVICE_KEY`(필수, 이미 인코딩된 값) · `TOUR_API_BASE_URL`(선택, 기본 `https://apis.data.go.kr/B551011/KorService2`)

```ts
class TourApiClient {
  constructor()  // env 로딩만. 네트워크 호출 없음.

  getAreaBasedList(params?: TourApiListParams): Promise<TourApiAreaItem[]>
  getDetailCommon(contentId: string): Promise<TourApiDetailCommon>
  getDetailIntro(contentId: string, contentTypeId: string): Promise<Record<string, string>>
  getDetailImages(contentId: string): Promise<TourApiImage[]>
}
```

### 타입

- `TourApiListParams`: `{ areaCode?: string; sigunguCode?: string; cat1?: string; cat2?: string; cat3?: string; contentTypeId?: string; numOfRows?: number; pageNo?: number; arrangeType?: string }`
  - `numOfRows` 기본값 10, `pageNo` 기본값 1 (미지정 시 클라이언트가 채움).
- `TourApiAreaItem`: `{ contentid: string; contenttypeid: string; title: string; addr1: string; addr2: string; zipcode: string; tel: string; firstimage: string; firstimage2: string; mapx: string; mapy: string; areacode: string; sigungucode: string; cat1: string; cat2: string; cat3: string; createdtime: string; modifiedtime: string }`
- `TourApiDetailCommon`: `{ contentid: string; contenttypeid: string; title: string; createdtime: string; modifiedtime: string; tel: string; telname: string; homepage: string; firstimage: string; firstimage2: string; areacode: string; sigungucode: string; cat1: string; cat2: string; cat3: string; addr1: string; addr2: string; zipcode: string; mapx: string; mapy: string; overview: string }`
- `TourApiImage`: `{ contentid: string; imgname: string; originimgurl: string; serialnum: string; smallimageurl: string; cpyrhtDivCd: string }`
- `getDetailIntro`는 **`Record<string, string>`을 반환**한다. `detailIntro2`는 `contentTypeId`(관광지/문화시설/축제공연행사/여행코스/레포츠/숙박/쇼핑/음식점 8종)에 따라 필드 구성이 완전히 달라진다. 8종을 모두 엄격 타입화하는 것은 이 스코프에서 과도하므로(YAGNI), 원본 키-값 쌍을 그대로 반환하고 호출자가 자신이 요청한 `contentTypeId`에 맞춰 해석한다.

### 고정 상수

`MobileOS`/`MobileApp`은 TourAPI 필수 파라미터지만 의미 있게 가변적이지 않으므로 상수로 고정한다: `MobileOS = "ETC"`, `MobileApp = "travel-builder"`. 설정 가능하게 만들지 않는다(YAGNI).

## 응답 처리 / 에러 처리 (TourAPI 특유의 동작)

1. **HTTP 200이어도 API 레벨 에러가 있을 수 있다.** 응답 바디의 `response.header.resultCode !== "0000"`이면 `response.header.resultMsg`를 담아 Error를 throw한다.
2. **`items`의 모양이 결과 개수에 따라 다르다.** 0건이면 빈 문자열(`""`), 1건이면 단일 객체, 여러 건이면 배열로 온다. 내부 헬퍼 `normalizeItems<T>(items: T | T[] | ""): T[]`를 만들어 모든 메서드가 공통으로 사용해 항상 배열을 반환한다.
3. 네트워크/HTTP 레벨 에러(axios가 던지는 것)는 최소한만 래핑하고 그대로 전파한다(기존 클라이언트들과 일관된 최소 에러 처리 원칙).

## 테스트 (단위 · 모킹)

`axios`를 `vi.mock`으로 모킹한다(실제 네트워크 호출 없음, 기존 gemini/postgres/qdrant 테스트와 동일 패턴).

- `TOUR_API_SERVICE_KEY` 누락 시 생성자 throw.
- 각 메서드가 올바른 URL(서비스키는 raw 그대로, 나머지 파라미터는 인코딩됨)로 `axios.get`을 호출하는지.
- `getAreaBasedList`가 `numOfRows`/`pageNo` 기본값을 채우는지, 옵션으로 덮어쓸 수 있는지.
- `normalizeItems`가 0건(빈 문자열)/1건(단일 객체)/N건(배열) 세 케이스를 모두 배열로 정규화하는지.
- `resultCode`가 `"0000"`이 아니면 `resultMsg`를 포함해 throw하는지.
- `getDetailIntro`가 임의의 키-값 객체를 그대로 반환하는지.

## 검증 계획

1. `npm run typecheck` (src + tests) 통과.
2. `npm test` — 신규 단위 테스트 전부 통과.
3. `npm run build` 성공.

## 범위 밖 (YAGNI)

- XML 응답 지원.
- `KorService1`(구버전) 지원.
- 지역/서비스 분류 코드 조회(`areaCode`/`categoryCode`).
- 키워드 검색(`searchKeyword2`), 위치기반 검색(`locationBasedList2`).
- 재시도/캐싱 로직.
