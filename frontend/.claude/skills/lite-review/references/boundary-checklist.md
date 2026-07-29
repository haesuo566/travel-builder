# 경계면 체크리스트 — travel-buider

리뷰어 프롬프트에 넣을 발췌용 체크리스트. **변경된 경계면에 해당하는 절만 골라 넣는다.** 전체를 넣으면 리뷰어가 무관한 경계면까지 훑어 리뷰가 느려진다.

## 목차

1. [백엔드 API 계약](#1-백엔드-api-계약)
2. [도메인 타입](#2-도메인-타입)
3. [라우팅](#3-라우팅)
4. [환경변수](#4-환경변수)
5. [core 패키지](#5-core-패키지)
6. [Next.js 16 버전 경계](#6-nextjs-16-버전-경계)

---

## 1. 백엔드 API 계약

**생산자:** `../backend/src/**` 컨트롤러 return, `../backend/src/**/dto/*.ts`
**소비자:** `frontend/src/lib/api/*.ts`

이 경계면이 가장 위험하다. `frontend/src/lib/api/itinerary.ts:68`은 응답을 `as ScenarioResult`로 캐스팅한다 — **타입 검사와 빌드가 모두 통과하고 런타임에만 깨진다.** 제네릭 캐스팅은 컴파일러의 검증을 우회한다.

- [ ] 요청 본문(`JSON.stringify({...})`)의 필드명·타입이 backend DTO의 필드와 일치하는가
- [ ] backend DTO의 검증 규칙(`class-validator` 데코레이터: 길이 제한, 필수 여부)을 프론트가 위반할 수 있는가
- [ ] 응답 캐스팅 타입(`as T`)의 필드가 실제 컨트롤러 return shape과 일치하는가
- [ ] 래핑 여부가 맞는가 — 백엔드가 `{ data: [...] }`를 주는데 프론트가 배열을 기대하지 않는가
- [ ] 필드 표기가 일치하는가 — snake_case ↔ camelCase 변환 지점이 명확한가
- [ ] 에러 응답 shape 분기가 실제 backend 필터와 일치하는가
  - `itinerary.ts:81-99`는 `message`가 `string[]`이면 ValidationPipe 400, `string`이면 `ExternalServiceFilter` 5xx로 판별한다. 백엔드가 에러 shape을 바꿨으면 이 분기가 조용히 틀린다
- [ ] 옵셔널 필드의 `null`/`undefined` 처리가 양쪽에서 일관되는가
- [ ] 즉시 응답(202 등)과 최종 결과의 shape이 다르면 프론트가 구분하는가

---

## 2. 도메인 타입

**생산자:** `frontend/src/lib/types.ts`
**소비자:** 컴포넌트 props, `src/lib/mock/*`, API 파서

- [ ] 타입에 필드를 추가·제거했을 때 mock 데이터(`src/lib/mock/itineraries.ts`, `scenarios.ts`)가 갱신되었는가
- [ ] 유니온 타입(`PlaceCategory`, `ChatRole`)에 값을 추가했을 때 그 값을 분기하는 모든 지점이 처리하는가 — `switch`의 default, 조건문의 else
- [ ] 유니온에서 값을 제거했을 때 그 값을 참조하는 코드가 남아 있지 않은가
- [ ] 필수 필드를 추가했을 때 그 타입을 생성하는 모든 지점이 값을 채우는가
- [ ] 백엔드가 같은 도메인 개념을 다른 이름·구조로 쓰고 있지 않은가

---

## 3. 라우팅

**생산자:** `src/app/**/page.tsx` 파일 경로
**소비자:** `href=`, `router.push(`, `redirect(`

- [ ] 코드의 모든 링크 값이 실재하는 page 파일 경로와 매칭되는가
  ```bash
  # 실제 라우트 목록
  find src/app -name 'page.tsx'
  # 링크 값 수집
  grep -rnE 'href=|router\.push\(|redirect\(' src/
  ```
- [ ] route group `(group)`은 URL에서 제거된다 — 그룹 디렉토리를 URL에 포함시키지 않았는가
- [ ] 동적 세그먼트 `[param]`에 실제 값이 채워지는가
- [ ] 페이지를 이동·삭제했을 때 그 경로를 가리키는 링크가 전부 갱신되었는가
- [ ] 새 페이지가 기존 레이아웃(`layout.tsx`)의 전제를 깨지 않는가

---

## 4. 환경변수

**생산자:** `.env.example`
**소비자:** `process.env.NEXT_PUBLIC_*` 참조부

이 절의 항목은 문법 취향이 아니라 **동작 조건**이다. 위반하면 서버에서는 동작하고 클라이언트 번들에서만 깨지므로 로컬 확인으로 잡히지 않는다.

- [ ] 새로 참조하는 변수가 `.env.example`에 추가되었는가
  - `frontend/.gitignore`는 `.env*`를 통째로 무시한다. `!.env.example` 예외가 함께 있어야 예시 파일이 커밋된다
- [ ] `process.env.NEXT_PUBLIC_X`를 **글자 그대로** 쓰는가
  - Next.js는 빌드 시점에 이 표현을 문자열로 치환한다. 구조분해(`const { NEXT_PUBLIC_X } = process.env`)와 동적 접근(`process.env[key]`)은 치환 대상이 아니어서 클라이언트 번들에서 `undefined`가 된다 (`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md:184-192`)
- [ ] 미설정 시 던지는가 — 조용한 기본값 폴백은 이 프로젝트에서 금지에 가깝다
  - `localhost` 기본값을 두면 배포 빌드에서 브라우저가 **사용자 PC**를 향해 요청하고, 설정 누락이 "연결 실패"로 위장된다 (`itinerary.ts:26-30`)
- [ ] throw가 **모듈 로드 시점이 아니라 호출 시점**인가
  - 로드 시점 throw는 `next build`의 프리렌더를 깨서 빌드가 env를 요구하게 된다. 호출 시점 throw는 env 없이 빌드가 통과한다 (실측됨)
- [ ] 테스트가 설정·미설정 **양방향**을 고정하는가 (`vi.stubEnv` / `vi.unstubAllEnvs`)
  - vitest는 `.env.local`을 읽지 않으므로 이 워크스페이스에서는 로컬 env 파일이 부재 테스트를 마스킹하지 않는다. backend e2e(`ConfigModule`이 `.env`를 읽는다)와 다른 점이다
- [ ] `NEXT_PUBLIC_` 접두사 없는 변수를 클라이언트 코드에서 읽으려 하지 않는가
  - 접두사 없는 키는 클라이언트 번들에 아예 들어가지 않는다 (같은 문서 `:156-166`)
- [ ] 서버 전용 시크릿에 `NEXT_PUBLIC_`을 붙이지 않았는가 (클라이언트 번들에 노출된다)

---

## 5. core 패키지

**생산자:** `../core/src/**` export
**소비자:** frontend import

- [ ] import 경로가 core의 실제 export와 일치하는가 (`core/package.json`의 exports 필드 확인)
- [ ] core의 타입을 frontend가 재정의하고 있지 않은가 (`src/lib/types.ts`와 중복 정의)
- [ ] core 변경이 backend 쪽 소비자도 깨뜨리지 않는가 — core는 frontend와 backend가 공유한다
- [ ] core가 빌드되어 있는가 (`core/dist/`) — 소스만 바꾸고 빌드하지 않으면 소비자는 옛 코드를 본다

---

## 6. Next.js 16 버전 경계

`frontend/AGENTS.md`: 이 버전(16.2.11)은 학습 데이터와 API·규약·파일 구조가 다를 수 있다.

- [ ] 변경이 Next.js API를 쓰면, `node_modules/next/dist/docs/`의 해당 문서를 실제로 읽고 작성했는가
  - 확인된 문서 위치 예: 환경변수 `01-app/02-guides/environment-variables.md`
- [ ] deprecation 경고를 무시하지 않았는가
- [ ] 기억에 있는 이전 버전 규약(예: 옛 `params` 처리 방식, 옛 metadata API)을 그대로 쓰지 않았는가
- [ ] 서버/클라이언트 컴포넌트 경계(`"use client"`)가 이 버전의 규칙에 맞는가
- [ ] 빌드 시점 인라인·캐싱 동작에 의존하는 코드가 이 버전의 실제 동작과 맞는가

이 절의 항목은 "확인했다"가 아니라 **"어느 문서의 어느 내용을 읽고 확인했다"** 로 보고한다. 문서 근거 없는 통과 판정은 이 경계면에서 무의미하다.
