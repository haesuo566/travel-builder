# frontend 여행 계획 AI 웹 (v1 — UI/UX 프론트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `frontend/`에 목업 데이터 기반 여행 계획 AI 웹 v1을 구현한다. 랜딩(`/`)과 채팅+일정 패널 하이브리드 플래너(`/plan`) 두 화면을, 나중에 core HTTP API가 생기면 `lib/api/` 내부만 교체하면 되도록 데이터 레이어를 분리해서 만든다.

**Architecture:** Next.js 16 App Router. `lib/types.ts`에 core 도메인을 반영한 타입(`Place`, `Itinerary`, `ChatMessage` 등)을 정의하고, `lib/mock/`이 목업 여행 데이터와 "AI 응답 흉내" 시나리오 로직을 담당하며, `lib/api/`는 이 목업을 감싸는 `async` 함수(`getItinerary`, `sendMessage`)를 노출한다. 화면 컴포넌트는 `lib/api/`만 호출하므로 나중에 `fetch`로 바꿔도 컴포넌트는 그대로 둔다. `lib/mock/scenarios.ts`의 키워드 매칭 로직(분기 로직이 있는 유일한 순수 함수)만 Vitest로 TDD하고, 나머지 프레젠테이션 컴포넌트는 타입 체크(`next build`)와 Task 10의 브라우저 실사용 검증으로 확인한다 — 이 프로젝트에 별도 컴포넌트 테스트 러너가 없고 시각적 UI 목업이 목적이기 때문에, 로직이 있는 부분만 자동화 테스트로 고정하는 쪽을 택했다. 장소 카드의 "사진"은 실제 이미지 API 없이 카테고리별 그라데이션 + 이니셜로 대체한다(범위 밖: 실제 이미지/지도 API).

**Tech Stack:** Next.js 16 (App Router, Turbopack) + React 19 + TypeScript + Tailwind CSS 4 (CSS 기반 `@theme` 토큰) + Vitest 4 (순수 로직 테스트만)

---

## 작업 디렉토리 주의사항

- 모든 `npm` 명령은 `frontend/` 안에서 실행한다.
- 모든 `git` 명령은 저장소 루트(`C:\workspace\travel-buider`)에서 실행한다.
- 파일 경로는 저장소 루트 기준으로 표기한다 (예: `frontend/src/lib/types.ts`).

## File Structure

```
frontend/
├── package.json                              # vitest devDependency + test 스크립트 추가
├── vitest.config.ts                          # 신규
└── src/
    ├── app/
    │   ├── globals.css                       # 다크모드 제거, 틸 브랜드 토큰 추가
    │   ├── layout.tsx                        # 메타데이터를 브랜드 상수로 교체
    │   ├── page.tsx                          # 랜딩 페이지 재작성
    │   └── plan/
    │       └── page.tsx                      # 신규 — 플래너 페이지 (client)
    ├── components/
    │   ├── ui/
    │   │   ├── Button.tsx                    # 신규
    │   │   ├── Card.tsx                      # 신규
    │   │   └── Badge.tsx                     # 신규
    │   ├── landing/
    │   │   ├── Hero.tsx                      # 신규
    │   │   ├── HowItWorks.tsx                # 신규
    │   │   ├── Features.tsx                  # 신규
    │   │   └── Footer.tsx                    # 신규
    │   └── planner/
    │       ├── MessageBubble.tsx             # 신규
    │       ├── SuggestionChips.tsx           # 신규
    │       ├── ChatPanel.tsx                 # 신규 (client)
    │       ├── PlaceCard.tsx                 # 신규
    │       ├── MapPlaceholder.tsx            # 신규
    │       ├── TripSummary.tsx               # 신규
    │       ├── DayTimeline.tsx               # 신규
    │       └── ItineraryPanel.tsx            # 신규 (client)
    └── lib/
        ├── constants.ts                      # 신규 — 브랜드명, 제안 칩 목록
        ├── types.ts                          # 신규 — Place, Itinerary, ChatMessage 등
        ├── mock/
        │   ├── itineraries.ts                # 신규 — 서울/부산/제주 목업 데이터
        │   ├── scenarios.ts                  # 신규 — "AI 응답" 시나리오 로직
        │   └── scenarios.test.ts             # 신규 — scenarios.ts 단위 테스트
        └── api/
            └── itinerary.ts                  # 신규 — getItinerary(), sendMessage()
```

---

## Task 1: 기반 설정 — 타입, 브랜드 상수, 디자인 토큰, Vitest

**Files:**
- Create: `frontend/src/lib/constants.ts`
- Create: `frontend/src/lib/types.ts`
- Modify: `frontend/package.json`
- Create: `frontend/vitest.config.ts`
- Modify: `frontend/src/app/globals.css`
- Modify: `frontend/src/app/layout.tsx`

- [ ] **Step 1: 브랜드 상수 작성**

`frontend/src/lib/constants.ts`:

```ts
export const BRAND_NAME = "여로";
export const BRAND_NAME_EN = "Yeoro";
export const BRAND_TAGLINE = "대화만으로 완성되는 여행 일정";
export const SUGGESTION_CHIPS = ["제주 2박3일", "맛집 위주로", "가족여행"];
```

- [ ] **Step 2: 도메인 타입 작성**

`frontend/src/lib/types.ts`:

```ts
export type PlaceCategory = "관광지" | "음식점" | "숙박";

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  time: string;
  description: string;
  pinNumber: number;
}

export interface ItineraryDay {
  day: number;
  places: Place[];
}

export interface TripInfo {
  destination: string;
  duration: string;
  travelers: string;
}

export interface Itinerary {
  summary: TripInfo;
  days: ItineraryDay[];
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}
```

- [ ] **Step 3: `package.json`에 Vitest 추가**

`frontend/package.json` 전체를 아래로 교체:

```json
{
  "name": "frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "16.2.11",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.2.11",
    "tailwindcss": "^4",
    "typescript": "^5",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 4: 의존성 설치**

Run (in `frontend/`): `npm install`
Expected: `added N packages` (vitest 및 하위 의존성 설치), 에러 없음

- [ ] **Step 5: Vitest 설정 작성**

`frontend/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 6: Vitest 설치 확인**

Run (in `frontend/`): `npx vitest --version`
Expected: `vitest/4.x.x ...` 형태로 버전 출력 (테스트 파일이 아직 없으므로 `npm run test`는 이 시점에 실행하지 않는다)

- [ ] **Step 7: 다크모드 제거 + 브랜드 컬러 토큰 추가**

`frontend/src/app/globals.css` 전체를 아래로 교체:

```css
@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #0f172a;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-brand: #0d9488;
  --color-brand-hover: #0f766e;
  --color-brand-light: #f0fdfa;
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans), Arial, Helvetica, sans-serif;
}
```

- [ ] **Step 8: 루트 레이아웃 메타데이터를 브랜드 상수로 교체**

`frontend/src/app/layout.tsx` 전체를 아래로 교체:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { BRAND_NAME, BRAND_NAME_EN, BRAND_TAGLINE } from "@/lib/constants";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${BRAND_NAME} (${BRAND_NAME_EN}) — ${BRAND_TAGLINE}`,
  description: BRAND_TAGLINE,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
```

- [ ] **Step 9: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공 (`page.tsx`가 아직 이전 스캐폴딩 콘텐츠를 담고 있어도 타입 에러 없이 통과해야 함). 이 실행으로 `next-env.d.ts`가 자동 생성된다.

- [ ] **Step 10: 커밋**

```bash
git add frontend/src/lib/constants.ts frontend/src/lib/types.ts frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/app/globals.css frontend/src/app/layout.tsx
git commit -m "feat: 여로 브랜드 상수, 도메인 타입, 디자인 토큰, Vitest 설정 추가"
```

---

## Task 2: UI 프리미티브 — Button, Card, Badge

**Files:**
- Create: `frontend/src/components/ui/Button.tsx`
- Create: `frontend/src/components/ui/Card.tsx`
- Create: `frontend/src/components/ui/Badge.tsx`

- [ ] **Step 1: Button 작성**

`frontend/src/components/ui/Button.tsx`:

```tsx
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover",
  secondary: "bg-white text-brand border border-brand hover:bg-brand-light",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-100",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "px-5 py-2.5 text-sm",
  lg: "px-7 py-3.5 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  href,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const classes = `inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;

  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }

  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Card 작성**

`frontend/src/components/ui/Card.tsx`:

```tsx
import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className = "", ...rest }: CardProps) {
  return (
    <div
      className={`rounded-2xl bg-white shadow-sm shadow-slate-200/60 ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Badge 작성**

`frontend/src/components/ui/Badge.tsx`:

```tsx
import type { PlaceCategory } from "@/lib/types";

const CATEGORY_CLASSES: Record<PlaceCategory, string> = {
  관광지: "bg-teal-50 text-teal-700",
  음식점: "bg-amber-50 text-amber-700",
  숙박: "bg-sky-50 text-sky-700",
};

interface BadgeProps {
  category: PlaceCategory;
}

export function Badge({ category }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${CATEGORY_CLASSES[category]}`}
    >
      {category}
    </span>
  );
}
```

- [ ] **Step 4: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/ui
git commit -m "feat: UI 프리미티브 컴포넌트(Button, Card, Badge) 추가"
```

---

## Task 3: 목업 여행 데이터 — 서울/부산/제주

**Files:**
- Create: `frontend/src/lib/mock/itineraries.ts`

- [ ] **Step 1: 목업 일정 데이터 작성**

`frontend/src/lib/mock/itineraries.ts`:

```ts
import type { Itinerary } from "../types";

export const itinerariesByDestination: Record<string, Itinerary> = {
  seoul: {
    summary: {
      destination: "서울",
      duration: "2박 3일",
      travelers: "성인 2명",
    },
    days: [
      {
        day: 1,
        places: [
          {
            id: "seoul-1-1",
            name: "경복궁",
            category: "관광지",
            time: "10:00",
            description: "조선 왕조의 정궁으로, 수문장 교대식이 볼거리예요.",
            pinNumber: 1,
          },
          {
            id: "seoul-1-2",
            name: "광장시장",
            category: "음식점",
            time: "12:30",
            description: "빈대떡과 마약김밥으로 유명한 전통시장 먹거리 골목이에요.",
            pinNumber: 2,
          },
          {
            id: "seoul-1-3",
            name: "신라스테이 명동",
            category: "숙박",
            time: "20:00",
            description: "명동 중심가에서 도보로 이동하기 좋은 숙소예요.",
            pinNumber: 3,
          },
        ],
      },
      {
        day: 2,
        places: [
          {
            id: "seoul-2-1",
            name: "북촌한옥마을",
            category: "관광지",
            time: "09:30",
            description: "전통 한옥이 모여있는 골목을 산책하며 사진 찍기 좋아요.",
            pinNumber: 1,
          },
          {
            id: "seoul-2-2",
            name: "을지로 노포 골목",
            category: "음식점",
            time: "13:00",
            description: "노가리와 계란말이로 유명한 오래된 노포들이 모여있어요.",
            pinNumber: 2,
          },
          {
            id: "seoul-2-3",
            name: "남산서울타워",
            category: "관광지",
            time: "18:00",
            description: "서울 시내 전망과 야경을 한눈에 볼 수 있어요.",
            pinNumber: 3,
          },
          {
            id: "seoul-2-4",
            name: "신라스테이 명동",
            category: "숙박",
            time: "21:30",
            description: "둘째 날도 같은 숙소에서 편하게 머물러요.",
            pinNumber: 4,
          },
        ],
      },
      {
        day: 3,
        places: [
          {
            id: "seoul-3-1",
            name: "인사동 쌈지길",
            category: "관광지",
            time: "10:00",
            description: "전통 공예품과 기념품을 구경하기 좋은 거리예요.",
            pinNumber: 1,
          },
          {
            id: "seoul-3-2",
            name: "명동교자",
            category: "음식점",
            time: "12:00",
            description: "칼국수와 만두로 유명한 명동 대표 맛집이에요.",
            pinNumber: 2,
          },
        ],
      },
    ],
  },
  busan: {
    summary: {
      destination: "부산",
      duration: "2박 3일",
      travelers: "성인 2명",
    },
    days: [
      {
        day: 1,
        places: [
          {
            id: "busan-1-1",
            name: "해운대해수욕장",
            category: "관광지",
            time: "11:00",
            description: "부산을 대표하는 해변으로 산책하기 좋아요.",
            pinNumber: 1,
          },
          {
            id: "busan-1-2",
            name: "해운대 포장마차촌",
            category: "음식점",
            time: "18:00",
            description: "해산물과 부산 대표 포장마차 감성을 즐길 수 있어요.",
            pinNumber: 2,
          },
          {
            id: "busan-1-3",
            name: "파라다이스 호텔 부산",
            category: "숙박",
            time: "21:00",
            description: "해운대 해변 바로 앞에 위치한 숙소예요.",
            pinNumber: 3,
          },
        ],
      },
      {
        day: 2,
        places: [
          {
            id: "busan-2-1",
            name: "자갈치시장",
            category: "관광지",
            time: "09:30",
            description: "부산의 대표 수산시장으로 신선한 해산물을 구경할 수 있어요.",
            pinNumber: 1,
          },
          {
            id: "busan-2-2",
            name: "부평깡통시장",
            category: "음식점",
            time: "12:30",
            description: "다양한 길거리 음식을 즐길 수 있는 야시장으로 유명해요.",
            pinNumber: 2,
          },
          {
            id: "busan-2-3",
            name: "감천문화마을",
            category: "관광지",
            time: "15:30",
            description: "알록달록한 계단식 마을로 사진 명소로 유명해요.",
            pinNumber: 3,
          },
          {
            id: "busan-2-4",
            name: "파라다이스 호텔 부산",
            category: "숙박",
            time: "21:00",
            description: "둘째 날도 같은 숙소에서 편하게 머물러요.",
            pinNumber: 4,
          },
        ],
      },
      {
        day: 3,
        places: [
          {
            id: "busan-3-1",
            name: "광안리해수욕장",
            category: "관광지",
            time: "10:00",
            description: "광안대교 전망이 아름다운 해변이에요.",
            pinNumber: 1,
          },
          {
            id: "busan-3-2",
            name: "삼진어묵 본점",
            category: "음식점",
            time: "12:00",
            description: "부산 대표 어묵 맛집으로 다양한 어묵 요리를 맛볼 수 있어요.",
            pinNumber: 2,
          },
        ],
      },
    ],
  },
  jeju: {
    summary: {
      destination: "제주",
      duration: "2박 3일",
      travelers: "성인 2명",
    },
    days: [
      {
        day: 1,
        places: [
          {
            id: "jeju-1-1",
            name: "성산일출봉",
            category: "관광지",
            time: "09:00",
            description: "유네스코 세계자연유산으로 일출 명소로 유명해요.",
            pinNumber: 1,
          },
          {
            id: "jeju-1-2",
            name: "성산포 해녀의 집",
            category: "음식점",
            time: "12:00",
            description: "해녀가 직접 잡은 신선한 해산물을 맛볼 수 있어요.",
            pinNumber: 2,
          },
          {
            id: "jeju-1-3",
            name: "제주신라호텔",
            category: "숙박",
            time: "20:00",
            description: "중문관광단지에 위치한 리조트형 숙소예요.",
            pinNumber: 3,
          },
        ],
      },
      {
        day: 2,
        places: [
          {
            id: "jeju-2-1",
            name: "주상절리대",
            category: "관광지",
            time: "09:30",
            description: "육각형 돌기둥이 절경을 이루는 해안 명소예요.",
            pinNumber: 1,
          },
          {
            id: "jeju-2-2",
            name: "흑돼지거리",
            category: "음식점",
            time: "12:30",
            description: "제주 흑돼지 구이로 유명한 맛집 거리예요.",
            pinNumber: 2,
          },
          {
            id: "jeju-2-3",
            name: "협재해수욕장",
            category: "관광지",
            time: "16:00",
            description: "에메랄드빛 바다와 백사장이 아름다운 해변이에요.",
            pinNumber: 3,
          },
          {
            id: "jeju-2-4",
            name: "제주신라호텔",
            category: "숙박",
            time: "20:30",
            description: "둘째 날도 같은 숙소에서 편하게 머물러요.",
            pinNumber: 4,
          },
        ],
      },
      {
        day: 3,
        places: [
          {
            id: "jeju-3-1",
            name: "한라산 어리목 탐방로",
            category: "관광지",
            time: "09:00",
            description: "가볍게 걸을 수 있는 한라산 초입 탐방로예요.",
            pinNumber: 1,
          },
          {
            id: "jeju-3-2",
            name: "올레국수",
            category: "음식점",
            time: "12:00",
            description: "제주 멸치국수로 유명한 로컬 맛집이에요.",
            pinNumber: 2,
          },
        ],
      },
    ],
  },
};

const DEFAULT_DESTINATION_KEY = "seoul";

const DESTINATION_KEYWORDS: Record<string, string> = {
  서울: "seoul",
  부산: "busan",
  제주도: "jeju",
  제주: "jeju",
};

export function getDefaultItinerary(): Itinerary {
  return itinerariesByDestination[DEFAULT_DESTINATION_KEY];
}

export function getItineraryByDestinationKey(key: string): Itinerary {
  return itinerariesByDestination[key];
}

export function findDestinationKeyForMessage(message: string): string | null {
  for (const [keyword, key] of Object.entries(DESTINATION_KEYWORDS)) {
    if (message.includes(keyword)) {
      return key;
    }
  }
  return null;
}
```

- [ ] **Step 2: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/lib/mock/itineraries.ts
git commit -m "feat: 서울/부산/제주 목업 여행 일정 데이터 추가"
```

---

## Task 4: "AI 응답" 시나리오 로직 (TDD)

**Files:**
- Create: `frontend/src/lib/mock/scenarios.test.ts`
- Create: `frontend/src/lib/mock/scenarios.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/lib/mock/scenarios.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateAssistantReply } from "./scenarios";
import { getDefaultItinerary, getItineraryByDestinationKey } from "./itineraries";

describe("generateAssistantReply", () => {
  it("제주 키워드가 있으면 제주 일정으로 전환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("제주 2박3일로 가고 싶어", current);

    expect(result.itinerary).toEqual(getItineraryByDestinationKey("jeju"));
    expect(result.reply).toContain("제주");
  });

  it("부산 키워드가 있으면 부산 일정으로 전환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("부산으로 여행가고 싶어요", current);

    expect(result.itinerary).toEqual(getItineraryByDestinationKey("busan"));
    expect(result.reply).toContain("부산");
  });

  it("맛집 키워드가 있으면 기존 일정을 유지하고 맛집 관련 답변을 반환한다", () => {
    const current = getItineraryByDestinationKey("busan");
    const result = generateAssistantReply("맛집 위주로 알려줘", current);

    expect(result.itinerary).toEqual(current);
    expect(result.reply).toContain("맛집");
  });

  it("가족 키워드가 있으면 기존 일정을 유지하고 가족 관련 답변을 반환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("가족여행으로 준비해줘", current);

    expect(result.itinerary).toEqual(current);
    expect(result.reply).toContain("가족");
  });

  it("인식할 수 없는 메시지는 기존 일정을 유지하고 되묻는 답변을 반환한다", () => {
    const current = getDefaultItinerary();
    const result = generateAssistantReply("안녕하세요", current);

    expect(result.itinerary).toEqual(current);
    expect(result.reply).toContain("목적지");
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run (in `frontend/`): `npm run test`
Expected: FAIL — `Cannot find module './scenarios'` (또는 유사한 모듈 미존재 에러)

- [ ] **Step 3: 시나리오 로직 구현**

`frontend/src/lib/mock/scenarios.ts`:

```ts
import type { Itinerary } from "../types";
import { findDestinationKeyForMessage, getItineraryByDestinationKey } from "./itineraries";

const DESTINATION_LABELS: Record<string, string> = {
  seoul: "서울",
  busan: "부산",
  jeju: "제주",
};

export interface ScenarioResult {
  reply: string;
  itinerary: Itinerary;
}

export function generateAssistantReply(
  message: string,
  currentItinerary: Itinerary
): ScenarioResult {
  const destinationKey = findDestinationKeyForMessage(message);

  if (destinationKey) {
    const itinerary = getItineraryByDestinationKey(destinationKey);
    return {
      reply: `${DESTINATION_LABELS[destinationKey]} ${itinerary.summary.duration} 일정을 준비했어요! 오른쪽에서 Day별 코스를 확인해보세요.`,
      itinerary,
    };
  }

  if (message.includes("맛집")) {
    return {
      reply:
        "맛집 위주로 코스를 다시 짜봤어요. Day별 음식점 카드를 확인해보세요. 특정 지역을 알려주시면 더 정확하게 추천해드릴게요.",
      itinerary: currentItinerary,
    };
  }

  if (message.includes("가족")) {
    return {
      reply:
        "가족 여행에 어울리도록 이동 동선을 여유롭게 구성했어요. 아이와 함께라면 오전 일정을 조금 늦게 시작하는 것도 추천해요.",
      itinerary: currentItinerary,
    };
  }

  return {
    reply:
      "어디로 떠나고 싶으신가요? '제주 2박3일'처럼 목적지와 기간을 말씀해주시면 바로 일정을 만들어드릴게요.",
    itinerary: currentItinerary,
  };
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run (in `frontend/`): `npm run test`
Expected: PASS — 5개 테스트 모두 통과

- [ ] **Step 5: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/lib/mock/scenarios.ts frontend/src/lib/mock/scenarios.test.ts
git commit -m "feat: AI 응답 흉내 시나리오 로직 추가 (TDD)"
```

---

## Task 5: 데이터 API 레이어

**Files:**
- Create: `frontend/src/lib/api/itinerary.ts`

- [ ] **Step 1: async 인터페이스 작성**

`frontend/src/lib/api/itinerary.ts`:

```ts
import type { Itinerary } from "../types";
import { getDefaultItinerary } from "../mock/itineraries";
import { generateAssistantReply, type ScenarioResult } from "../mock/scenarios";

export async function getItinerary(): Promise<Itinerary> {
  return getDefaultItinerary();
}

export async function sendMessage(
  message: string,
  currentItinerary: Itinerary
): Promise<ScenarioResult> {
  return generateAssistantReply(message, currentItinerary);
}
```

- [ ] **Step 2: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/lib/api/itinerary.ts
git commit -m "feat: getItinerary/sendMessage async 데이터 API 레이어 추가"
```

---

## Task 6: 랜딩 페이지 컴포넌트

**Files:**
- Create: `frontend/src/components/landing/Hero.tsx`
- Create: `frontend/src/components/landing/HowItWorks.tsx`
- Create: `frontend/src/components/landing/Features.tsx`
- Create: `frontend/src/components/landing/Footer.tsx`
- Modify: `frontend/src/app/page.tsx`

- [ ] **Step 1: Hero 작성**

`frontend/src/components/landing/Hero.tsx`:

```tsx
import { Button } from "@/components/ui/Button";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/constants";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-brand-light to-white px-6 py-24 sm:py-32">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <span className="mb-4 inline-flex items-center rounded-full bg-white px-4 py-1.5 text-sm font-medium text-brand shadow-sm">
          {BRAND_NAME}
        </span>
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          {BRAND_TAGLINE}
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">
          대화 몇 마디로 목적지, 기간, 취향에 맞는 여행 일정을 AI가 바로
          만들어드려요.
        </p>
        <div className="mt-10">
          <Button href="/plan" size="lg">
            여행 계획 시작하기
          </Button>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: HowItWorks 작성**

`frontend/src/components/landing/HowItWorks.tsx`:

```tsx
import { Card } from "@/components/ui/Card";

const STEPS = [
  {
    number: "01",
    title: "대화로 취향 알려주기",
    description: "목적지, 기간, 인원, 취향을 채팅으로 편하게 이야기해주세요.",
  },
  {
    number: "02",
    title: "AI가 실데이터로 일정 생성",
    description: "한국관광공사 공공 데이터를 바탕으로 맞춤 일정을 만들어드려요.",
  },
  {
    number: "03",
    title: "지도·타임라인으로 확인/수정",
    description: "Day별 타임라인과 지도로 동선을 확인하고 자유롭게 수정하세요.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-20">
      <h2 className="text-center text-3xl font-semibold text-slate-900">
        이렇게 만들어져요
      </h2>
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
        {STEPS.map((step) => (
          <Card key={step.number} className="p-8">
            <span className="text-sm font-semibold text-brand">
              {step.number}
            </span>
            <h3 className="mt-3 text-lg font-semibold text-slate-900">
              {step.title}
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {step.description}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Features 작성**

`frontend/src/components/landing/Features.tsx`:

```tsx
import { Card } from "@/components/ui/Card";

const FEATURES = [
  {
    title: "공공 관광 실데이터 기반",
    description: "한국관광공사 TourAPI 데이터로 신뢰할 수 있는 정보를 제공해요.",
  },
  {
    title: "AI 맞춤 추천",
    description: "대화 맥락을 이해해 취향에 맞는 장소를 추천해요.",
  },
  {
    title: "지도 중심 동선",
    description: "Day별 동선을 지도와 타임라인으로 한눈에 확인해요.",
  },
];

export function Features() {
  return (
    <section className="bg-slate-50 px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold text-slate-900">
          여로만의 특징
        </h2>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="p-8">
              <h3 className="text-lg font-semibold text-slate-900">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {feature.description}
              </p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Footer 작성**

`frontend/src/components/landing/Footer.tsx`:

```tsx
import { BRAND_NAME, BRAND_NAME_EN } from "@/lib/constants";

export function Footer() {
  return (
    <footer className="border-t border-slate-100 px-6 py-10 text-center text-sm text-slate-500">
      <p>
        {BRAND_NAME} ({BRAND_NAME_EN}) — 대화만으로 완성되는 여행 일정
      </p>
    </footer>
  );
}
```

- [ ] **Step 5: 랜딩 페이지 조립**

`frontend/src/app/page.tsx` 전체를 아래로 교체:

```tsx
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Features } from "@/components/landing/Features";
import { Footer } from "@/components/landing/Footer";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-white">
      <Hero />
      <HowItWorks />
      <Features />
      <Footer />
    </div>
  );
}
```

- [ ] **Step 6: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/components/landing frontend/src/app/page.tsx
git commit -m "feat: 랜딩 페이지(Hero, HowItWorks, Features, Footer) 구현"
```

---

## Task 7: 플래너 채팅 컴포넌트

**Files:**
- Create: `frontend/src/components/planner/MessageBubble.tsx`
- Create: `frontend/src/components/planner/SuggestionChips.tsx`
- Create: `frontend/src/components/planner/ChatPanel.tsx`

- [ ] **Step 1: MessageBubble 작성**

`frontend/src/components/planner/MessageBubble.tsx`:

```tsx
import type { ChatMessage } from "@/lib/types";

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 ${
          isUser ? "bg-brand text-white" : "bg-slate-100 text-slate-800"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: SuggestionChips 작성**

`frontend/src/components/planner/SuggestionChips.tsx`:

```tsx
interface SuggestionChipsProps {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
  disabled?: boolean;
}

export function SuggestionChips({
  suggestions,
  onSelect,
  disabled = false,
}: SuggestionChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(suggestion)}
          className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-brand hover:text-brand disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: ChatPanel 작성**

`frontend/src/components/planner/ChatPanel.tsx`:

```tsx
"use client";

import { useState, type FormEvent } from "react";
import type { ChatMessage } from "@/lib/types";
import { SUGGESTION_CHIPS } from "@/lib/constants";
import { MessageBubble } from "./MessageBubble";
import { SuggestionChips } from "./SuggestionChips";

interface ChatPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  onSend: (message: string) => void;
}

export function ChatPanel({ messages, isLoading, onSend }: ChatPanelProps) {
  const [input, setInput] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setInput("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-6">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-400">
              입력 중...
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-slate-100 px-5 py-4">
        <div className="mb-3">
          <SuggestionChips
            suggestions={SUGGESTION_CHIPS}
            onSelect={onSend}
            disabled={isLoading}
          />
        </div>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="여행 취향을 말씀해주세요"
            disabled={isLoading}
            className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 outline-none focus:border-brand disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            보내기
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/planner/MessageBubble.tsx frontend/src/components/planner/SuggestionChips.tsx frontend/src/components/planner/ChatPanel.tsx
git commit -m "feat: 플래너 채팅 패널(MessageBubble, SuggestionChips, ChatPanel) 구현"
```

---

## Task 8: 플래너 일정 컴포넌트

**Files:**
- Create: `frontend/src/components/planner/PlaceCard.tsx`
- Create: `frontend/src/components/planner/MapPlaceholder.tsx`
- Create: `frontend/src/components/planner/TripSummary.tsx`
- Create: `frontend/src/components/planner/DayTimeline.tsx`
- Create: `frontend/src/components/planner/ItineraryPanel.tsx`

- [ ] **Step 1: PlaceCard 작성**

`frontend/src/components/planner/PlaceCard.tsx`:

```tsx
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { Place, PlaceCategory } from "@/lib/types";

const CATEGORY_GRADIENTS: Record<PlaceCategory, string> = {
  관광지: "from-teal-400 to-teal-600",
  음식점: "from-amber-400 to-amber-600",
  숙박: "from-sky-400 to-sky-600",
};

interface PlaceCardProps {
  place: Place;
}

export function PlaceCard({ place }: PlaceCardProps) {
  return (
    <Card className="flex gap-4 p-4">
      <div
        className={`relative flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-lg font-semibold text-white ${CATEGORY_GRADIENTS[place.category]}`}
      >
        {place.name.slice(0, 1)}
        <span className="absolute -bottom-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-700 shadow">
          {place.pinNumber}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="truncate font-semibold text-slate-900">
            {place.name}
          </h4>
          <span className="shrink-0 text-xs text-slate-400">{place.time}</span>
        </div>
        <div className="mt-1.5">
          <Badge category={place.category} />
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {place.description}
        </p>
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: MapPlaceholder 작성**

`frontend/src/components/planner/MapPlaceholder.tsx`:

```tsx
import type { Place } from "@/lib/types";

interface MapPlaceholderProps {
  places: Place[];
}

export function MapPlaceholder({ places }: MapPlaceholderProps) {
  return (
    <div className="relative h-56 w-full overflow-hidden rounded-2xl bg-teal-50">
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: "radial-gradient(circle, #0d9488 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      />
      <div className="relative flex h-full flex-wrap items-center justify-center gap-6 p-6">
        {places.map((place) => (
          <div key={place.id} className="flex flex-col items-center gap-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white shadow-md">
              {place.pinNumber}
            </div>
            <span className="max-w-[72px] truncate text-xs text-slate-600">
              {place.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: TripSummary 작성**

`frontend/src/components/planner/TripSummary.tsx`:

```tsx
import { Card } from "@/components/ui/Card";
import type { TripInfo } from "@/lib/types";

interface TripSummaryProps {
  summary: TripInfo;
}

export function TripSummary({ summary }: TripSummaryProps) {
  return (
    <Card className="flex flex-wrap items-center gap-x-8 gap-y-3 p-5">
      <div>
        <p className="text-xs text-slate-400">목적지</p>
        <p className="mt-0.5 font-semibold text-slate-900">
          {summary.destination}
        </p>
      </div>
      <div>
        <p className="text-xs text-slate-400">기간</p>
        <p className="mt-0.5 font-semibold text-slate-900">
          {summary.duration}
        </p>
      </div>
      <div>
        <p className="text-xs text-slate-400">인원</p>
        <p className="mt-0.5 font-semibold text-slate-900">
          {summary.travelers}
        </p>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: DayTimeline 작성**

`frontend/src/components/planner/DayTimeline.tsx`:

```tsx
import { PlaceCard } from "./PlaceCard";
import type { Place } from "@/lib/types";

interface DayTimelineProps {
  places: Place[];
}

export function DayTimeline({ places }: DayTimelineProps) {
  return (
    <ol className="relative space-y-4 border-l-2 border-teal-100 pl-6">
      {places.map((place) => (
        <li key={place.id} className="relative">
          <span className="absolute -left-[31px] top-5 h-2.5 w-2.5 rounded-full bg-brand" />
          <PlaceCard place={place} />
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 5: ItineraryPanel 작성**

`frontend/src/components/planner/ItineraryPanel.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { Itinerary } from "@/lib/types";
import { TripSummary } from "./TripSummary";
import { DayTimeline } from "./DayTimeline";
import { MapPlaceholder } from "./MapPlaceholder";

interface ItineraryPanelProps {
  itinerary: Itinerary;
}

export function ItineraryPanel({ itinerary }: ItineraryPanelProps) {
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);

  const days = itinerary.days;
  const activeDay = days[Math.min(selectedDayIndex, days.length - 1)];

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-6">
      <TripSummary summary={itinerary.summary} />

      <div className="flex gap-2">
        {days.map((day, index) => (
          <button
            key={day.day}
            type="button"
            onClick={() => setSelectedDayIndex(index)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              index === selectedDayIndex
                ? "bg-brand text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Day {day.day}
          </button>
        ))}
      </div>

      <MapPlaceholder places={activeDay.places} />
      <DayTimeline places={activeDay.places} />
    </div>
  );
}
```

- [ ] **Step 6: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/components/planner/PlaceCard.tsx frontend/src/components/planner/MapPlaceholder.tsx frontend/src/components/planner/TripSummary.tsx frontend/src/components/planner/DayTimeline.tsx frontend/src/components/planner/ItineraryPanel.tsx
git commit -m "feat: 플래너 일정 패널(TripSummary, DayTimeline, PlaceCard, MapPlaceholder, ItineraryPanel) 구현"
```

---

## Task 9: `/plan` 페이지 조립

**Files:**
- Create: `frontend/src/app/plan/page.tsx`

- [ ] **Step 1: 플래너 페이지 작성**

`frontend/src/app/plan/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { ChatPanel } from "@/components/planner/ChatPanel";
import { ItineraryPanel } from "@/components/planner/ItineraryPanel";
import { getItinerary, sendMessage } from "@/lib/api/itinerary";
import type { ChatMessage, Itinerary } from "@/lib/types";

const INITIAL_ASSISTANT_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "안녕하세요! 여로예요. 어디로, 며칠 일정으로 떠나고 싶으신가요? '제주 2박3일'처럼 말씀해주셔도 좋아요.",
};

function createMessageId(): string {
  return crypto.randomUUID();
}

export default function PlanPage() {
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    INITIAL_ASSISTANT_MESSAGE,
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeMobileTab, setActiveMobileTab] = useState<"chat" | "itinerary">(
    "chat"
  );

  useEffect(() => {
    getItinerary().then(setItinerary);
  }, []);

  async function handleSend(content: string) {
    if (!itinerary) return;

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content,
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    const result = await sendMessage(content, itinerary);

    const assistantMessage: ChatMessage = {
      id: createMessageId(),
      role: "assistant",
      content: result.reply,
    };
    setMessages((prev) => [...prev, assistantMessage]);
    setItinerary(result.itinerary);
    setIsLoading(false);
    setActiveMobileTab("itinerary");
  }

  if (!itinerary) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        불러오는 중...
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex gap-2 border-b border-slate-100 px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={() => setActiveMobileTab("chat")}
          className={`flex-1 rounded-xl py-2 text-sm font-medium ${
            activeMobileTab === "chat"
              ? "bg-brand text-white"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          채팅
        </button>
        <button
          type="button"
          onClick={() => setActiveMobileTab("itinerary")}
          className={`flex-1 rounded-xl py-2 text-sm font-medium ${
            activeMobileTab === "itinerary"
              ? "bg-brand text-white"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          일정
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          className={`w-full flex-col border-r border-slate-100 md:flex md:w-[40%] ${
            activeMobileTab === "chat" ? "flex" : "hidden"
          }`}
        >
          <ChatPanel messages={messages} isLoading={isLoading} onSend={handleSend} />
        </div>
        <div
          className={`w-full flex-col md:flex md:w-[60%] ${
            activeMobileTab === "itinerary" ? "flex" : "hidden"
          }`}
        >
          <ItineraryPanel itinerary={itinerary} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 빌드로 타입 확인**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/app/plan/page.tsx
git commit -m "feat: /plan 플래너 페이지 조립 (채팅+일정 하이브리드, 모바일 탭 전환)"
```

---

## Task 10: 전체 검증

**Files:** 없음 (검증 전용)

- [ ] **Step 1: 린트 실행**

Run (in `frontend/`): `npm run lint`
Expected: 에러 없음 (경고는 확인 후 판단)

- [ ] **Step 2: 전체 테스트 실행**

Run (in `frontend/`): `npm run test`
Expected: PASS — `scenarios.test.ts`의 5개 테스트 모두 통과

- [ ] **Step 3: 프로덕션 빌드 실행**

Run (in `frontend/`): `npm run build`
Expected: 컴파일 성공, 라우트 `/`와 `/plan` 모두 빌드 결과에 표시됨

- [ ] **Step 4: 개발 서버 백그라운드 실행**

Run (in `frontend/`, background): `npm run dev`
Expected: `Local: http://localhost:3000` 형태로 서버 시작 로그 출력

- [ ] **Step 5: 랜딩 페이지 브라우저 확인**

Playwright MCP 도구로 `http://localhost:3000/`을 열고 스크린샷을 찍는다.
Expected: Hero 헤드라인("대화만으로 완성되는 여행 일정"), 3단계 안내, 3가지 특징, 푸터가 틸 포인트 컬러와 함께 정상 렌더링됨. "여행 계획 시작하기" 버튼이 보임.

- [ ] **Step 6: 랜딩 → 플래너 이동 확인**

Playwright MCP 도구로 "여행 계획 시작하기" 버튼을 클릭한다.
Expected: URL이 `http://localhost:3000/plan`으로 이동하고, 좌측 채팅 패널(40%)과 우측 일정 패널(60%)이 나란히 보임. 초기 인사말 메시지와 서울 2박 3일 기본 일정이 보임.

- [ ] **Step 7: 채팅 → 일정 갱신 인터랙션 확인**

Playwright MCP 도구로 채팅 입력창에 "제주 2박3일"을 입력하고 전송 버튼을 클릭한다.
Expected: 사용자 메시지 말풍선이 추가되고, 잠시 후 "제주"를 언급하는 AI 답변 말풍선이 추가되며, 우측 일정 패널의 여행 요약 카드 목적지가 "제주"로 바뀜.

- [ ] **Step 8: Day 탭 전환 확인**

Playwright MCP 도구로 일정 패널의 "Day 2" 탭을 클릭한다.
Expected: 지도 자리의 핀 번호와 아래 타임라인의 장소 카드가 Day 2 장소들로 바뀜.

- [ ] **Step 9: 모바일 레이아웃 탭 전환 확인**

Playwright MCP 도구로 뷰포트를 375x812(모바일 크기)로 변경한 뒤 `/plan` 페이지를 다시 확인한다.
Expected: 상단에 "채팅"/"일정" 탭 버튼이 보이고, 채팅 탭이 기본 선택됨. "일정" 탭을 클릭하면 채팅 패널이 숨겨지고 일정 패널만 보임.

- [ ] **Step 10: 개발 서버 종료**

실행 중인 `npm run dev` 프로세스를 종료한다.

- [ ] **Step 11: 문제 발견 시 수정 후 재검증**

Step 1~9에서 발견된 문제가 있다면 해당 컴포넌트 파일을 수정하고, Step 1(`npm run lint`)부터 다시 실행해 모두 통과하는지 확인한다. 수정이 있었다면 아래처럼 커밋한다:

```bash
git add frontend/src
git commit -m "fix: 전체 검증 중 발견된 UI 이슈 수정"
```

문제가 없었다면 이 태스크는 커밋 없이 종료한다.

---

## Self-Review 요약

- **스펙 커버리지:** 라우트(`/`, `/plan`), 랜딩 구성(Hero/3단계/3특징/푸터), 플래너 2패널(채팅 40%/일정 60%), 채팅 패널(말풍선/제안칩/입력창), 일정 패널(요약카드/Day타임라인/장소카드[사진 대체/이름/카테고리뱃지/시간/설명/핀번호]/지도), 모바일 탭 전환, `lib/api`+`lib/mock` 데이터 레이어 분리, `components/ui`·`landing`·`planner` 구조, 틸 브랜드 토큰, 라이트 모드 전용 — 모두 Task 1~9에서 구현됨.
- **범위 밖 항목**(실제 지도 API, 실제 LLM/core 연동, 로그인, 저장/DB, 마이페이지)은 구현하지 않았으며, `lib/api/itinerary.ts`가 나중에 이 값들을 실제 API 호출로 바꿔 끼울 수 있는 유일한 교체 지점이다.
- **타입 일관성:** `Itinerary`/`ItineraryDay`/`Place`/`TripInfo`/`ChatMessage`/`ScenarioResult` 이름과 필드가 `lib/types.ts` → `lib/mock/*` → `lib/api/*` → 컴포넌트 전체에서 동일하게 사용됨.
- **플레이스홀더 없음:** 모든 스텝에 실행 가능한 완전한 코드가 포함되어 있으며 "TODO"나 생략된 구현이 없음.
