import type { EnrichInput } from "./tourContentsTable.js";

/** 제목 줄의 구분자. 검증에서 첫 줄 판정에 쓴다. */
const TITLE_SEPARATOR = "—";

const REQUIRED_LABELS = [
  "무엇을 하는 곳:",
  "실내/실외:",
  "추천 동반자:",
  "적정 소요시간:",
  "계절/날씨:",
  "분위기:",
  "설명:",
] as const;

/**
 * Gemini에 매 호출 동일하게 넘기는 시스템 지시문.
 *
 * 규칙 3이 환각을 통제한다 — 속성 추출 방식은 원문에 없는 것을 추론하게 만들므로
 * "확신 없으면 정보 없음"을 명시하지 않으면 전부 그럴듯하게 채워진다.
 * 규칙 5는 지역을 벡터에서 증폭하지 않게 한다 — 지역은 payload 필터로 정확히
 * 걸리는 정형 조건이고, 벡터에 별도 섹션으로 넣으면 의미 축의 해상도를 떨어뜨린다.
 */
export const STRUCTURE_SYSTEM_INSTRUCTION = `당신은 여행 일정 추천 시스템의 검색 색인을 만드는 편집자다.
주어진 관광지 정보를 아래 고정 포맷으로 정규화한다.

규칙:
1. 아래 포맷의 라벨과 순서를 정확히 그대로 쓴다. 라벨을 추가·삭제·변경하지 않는다.
2. '설명 원문'에서 확인되는 사실을 우선한다.
3. 원문에 없지만 장소 유형으로 보아 명확한 것은 추론해도 된다.
   확신이 없으면 "정보 없음"이라고 쓴다. 그럴듯하게 지어내지 않는다.
4. 홍보 문구·과장("꼭 가봐야 할", "최고의", "명실상부")은 버리고 사실만 남긴다.
5. 지역명·주소를 별도 섹션으로 쓰지 않는다. 설명 안에서 필요할 때만 언급한다.
6. 전화번호·URL·요금·운영시간·연도는 쓰지 않는다.
7. 설명은 3문장 이내. 전체 출력은 400자 이내.
8. 포맷 외의 머리말·맺음말·마크다운 기호를 쓰지 않는다.

출력 포맷:
{제목} ${TITLE_SEPARATOR} {분류}
무엇을 하는 곳: {활동 2~4개, 쉼표 구분}
실내/실외: {실내 | 실외 | 실내외 혼합}
추천 동반자: {가족 | 커플 | 친구 | 혼자 | 단체 중 해당하는 것, 쉼표 구분}
적정 소요시간: {1시간 이내 | 1~2시간 | 2~3시간 | 반나절 이상}
계절/날씨: {사계절 | 여름 성수기 | 봄 벚꽃철 | 비 오는 날에도 가능 | ...}
분위기: {짧은 구 하나}
설명: {3문장 이내}`;

/** overview에 실질 내용이 없으면 Gemini에 줄 재료가 없다. */
export function needsFallback(input: EnrichInput): boolean {
  return input.overview.trim() === "";
}

function joinNonEmpty(parts: string[], separator: string): string {
  return parts.filter((s) => s.trim() !== "").join(separator);
}

function classificationPath(input: EnrichInput): string {
  return joinNonEmpty([input.lcls1Nm, input.lcls2Nm, input.lcls3Nm], " > ");
}

/** 항목별 프롬프트를 만든다. 빈 값 줄은 생략해 무의미한 입력을 만들지 않는다. */
export function buildStructurePrompt(input: EnrichInput): string {
  const lines = [`제목: ${input.title}`];
  if (input.contentTypeNm.trim() !== "") lines.push(`관광타입: ${input.contentTypeNm}`);

  const path = classificationPath(input);
  if (path !== "") lines.push(`분류: ${path}`);

  const region = joinNonEmpty([input.regnNm, input.signguNm], " ");
  if (region !== "") lines.push(`지역: ${region}`);

  const address = joinNonEmpty([input.addr1, input.addr2], " ");
  if (address !== "") lines.push(`주소: ${address}`);

  lines.push("설명 원문:", input.overview);
  return lines.join("\n");
}

/**
 * overview가 없을 때 Gemini 없이 조립하는 최소 텍스트.
 *
 * 건너뛰면 그 관광지는 검색 대상에서 빠져 일정 추천에 영구히 등장하지 않는다.
 * 이름과 분류만으로도 검색 가치가 있다.
 * 고정 포맷이 아니므로 validateStructuredText의 대상이 아니다.
 */
export function buildMinimalText(input: EnrichInput): string {
  const head =
    input.contentTypeNm.trim() === ""
      ? input.title
      : `${input.title} ${TITLE_SEPARATOR} ${input.contentTypeNm}`;
  const path = classificationPath(input);
  return path === "" ? head : `${head}\n${path}`;
}

/**
 * Gemini 출력이 고정 포맷을 지켰는지 검증한다. 위반 시 throw — 구조화 실패로 분류된다.
 *
 * 검증이 없으면 포맷 위반을 아무도 모르고 색인 품질이 조용히 썩는다.
 * 100건 테스트에서 포맷 준수율을 측정하는 것이 이 함수의 1차 목적이다.
 */
export function validateStructuredText(text: string): void {
  if (text.trim() === "") {
    throw new Error("구조화 텍스트가 비어 있습니다.");
  }
  const missing = REQUIRED_LABELS.filter((label) => !text.includes(label));
  if (missing.length > 0) {
    throw new Error(`구조화 텍스트에 라벨이 없습니다: ${missing.join(", ")}`);
  }
  const firstLine = text.trimStart().split("\n")[0] ?? "";
  if (!firstLine.includes(TITLE_SEPARATOR)) {
    throw new Error(
      `구조화 텍스트 첫 줄에 '${TITLE_SEPARATOR}' 구분자가 없습니다: ${firstLine}`,
    );
  }
}
