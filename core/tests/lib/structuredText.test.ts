import { describe, it, expect } from "vitest";
import {
  STRUCTURE_SYSTEM_INSTRUCTION,
  buildMinimalText,
  buildStructurePrompt,
  needsFallback,
  validateStructuredText,
} from "../../src/lib/structuredText.js";
import type { EnrichInput } from "../../src/lib/tourContentsTable.js";

function input(overrides: Partial<EnrichInput> = {}): EnrichInput {
  return {
    contentid: "126508",
    title: "경복궁",
    addr1: "서울특별시 종로구 사직로 161",
    addr2: "",
    overview: "조선 왕조의 법궁이다.",
    structuredText: null,
    structureStatus: "pending",
    contenttypeid: "12",
    ldongRegnCd: "11",
    ldongSignguCd: "110",
    lclsSystm1: "AC",
    lclsSystm2: "AC01",
    lclsSystm3: "AC010100",
    mapx: "126.9769",
    mapy: "37.5796",
    contentTypeNm: "관광지",
    lcls1Nm: "인문(문화/예술/역사)",
    lcls2Nm: "역사관광지",
    lcls3Nm: "고궁",
    regnNm: "서울특별시",
    signguNm: "종로구",
    ...overrides,
  };
}

/** 포맷을 지킨 유효한 구조화 텍스트. */
function validText(): string {
  return [
    "경복궁 — 고궁",
    "무엇을 하는 곳: 궁궐 관람, 수문장 교대식 관람",
    "실내/실외: 실내외 혼합",
    "추천 동반자: 가족, 커플, 혼자",
    "적정 소요시간: 1~2시간",
    "계절/날씨: 사계절",
    "분위기: 고요하고 정제된 역사 공간",
    "설명: 조선 왕조의 법궁이다. 근정전과 경회루가 남아 있다.",
  ].join("\n");
}

describe("STRUCTURE_SYSTEM_INSTRUCTION", () => {
  it("환각 통제와 지역 증폭 금지 규칙을 담는다", () => {
    expect(STRUCTURE_SYSTEM_INSTRUCTION).toContain("정보 없음");
    expect(STRUCTURE_SYSTEM_INSTRUCTION).toContain("지역명·주소를 별도 섹션으로 쓰지 않는다");
    expect(STRUCTURE_SYSTEM_INSTRUCTION).toContain("무엇을 하는 곳:");
  });
});

describe("needsFallback", () => {
  it("overview에 내용이 있으면 false", () => {
    expect(needsFallback(input())).toBe(false);
  });

  it("빈 문자열·공백·개행만이면 true", () => {
    expect(needsFallback(input({ overview: "" }))).toBe(true);
    expect(needsFallback(input({ overview: "   " }))).toBe(true);
    expect(needsFallback(input({ overview: "\n\n" }))).toBe(true);
  });
});

describe("buildStructurePrompt", () => {
  it("제목·타입·분류·지역·주소·원문을 담는다", () => {
    const text = buildStructurePrompt(input());
    expect(text).toContain("제목: 경복궁");
    expect(text).toContain("관광타입: 관광지");
    expect(text).toContain("분류: 인문(문화/예술/역사) > 역사관광지 > 고궁");
    expect(text).toContain("지역: 서울특별시 종로구");
    expect(text).toContain("주소: 서울특별시 종로구 사직로 161");
    expect(text).toContain("설명 원문:");
    expect(text).toContain("조선 왕조의 법궁이다.");
  });

  it("빈 값 줄은 생략한다", () => {
    const text = buildStructurePrompt(
      input({
        contentTypeNm: "",
        lcls1Nm: "",
        lcls2Nm: "",
        lcls3Nm: "",
        regnNm: "",
        signguNm: "",
        addr1: "",
        addr2: "",
      }),
    );
    expect(text).not.toContain("관광타입:");
    expect(text).not.toContain("분류:");
    expect(text).not.toContain("지역:");
    expect(text).not.toContain("주소:");
    expect(text).toContain("제목: 경복궁");
  });

  it("분류 일부만 있으면 있는 레벨만 이어붙인다", () => {
    const text = buildStructurePrompt(input({ lcls3Nm: "" }));
    expect(text).toContain("분류: 인문(문화/예술/역사) > 역사관광지");
    expect(text).not.toContain("역사관광지 > \n");
  });
});

describe("buildMinimalText", () => {
  it("제목·타입·분류만으로 2줄을 만든다", () => {
    expect(buildMinimalText(input({ overview: "" }))).toBe(
      "경복궁 — 관광지\n인문(문화/예술/역사) > 역사관광지 > 고궁",
    );
  });

  it("타입이 없으면 제목만 첫 줄에 둔다", () => {
    expect(buildMinimalText(input({ contentTypeNm: "", lcls1Nm: "", lcls2Nm: "", lcls3Nm: "" }))).toBe(
      "경복궁",
    );
  });
});

describe("validateStructuredText", () => {
  it("포맷을 지킨 텍스트를 통과시킨다", () => {
    expect(() => validateStructuredText(validText())).not.toThrow();
  });

  it("공백이면 throw", () => {
    expect(() => validateStructuredText("   ")).toThrow("비어");
  });

  it("라벨이 빠지면 어떤 라벨인지 알려주며 throw", () => {
    const missing = validText()
      .split("\n")
      .filter((line) => !line.startsWith("분위기:"))
      .join("\n");
    expect(() => validateStructuredText(missing)).toThrow("분위기:");
  });

  it("첫 줄에 구분자가 없으면 throw", () => {
    const noSeparator = validText().replace("경복궁 — 고궁", "경복궁 고궁");
    expect(() => validateStructuredText(noSeparator)).toThrow("구분자");
  });

  it("7개 라벨 전부를 요구한다", () => {
    for (const label of [
      "무엇을 하는 곳:",
      "실내/실외:",
      "추천 동반자:",
      "적정 소요시간:",
      "계절/날씨:",
      "분위기:",
      "설명:",
    ]) {
      const missing = validText()
        .split("\n")
        .filter((line) => !line.startsWith(label))
        .join("\n");
      expect(() => validateStructuredText(missing)).toThrow(label);
    }
  });
});
