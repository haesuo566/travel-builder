---
type: pitfall
first_seen: 2026-07-28
occurrences: 1
promoted_to: .claude/skills/tb-tdd-implement/references/workspaces.md (frontend 제약)
---

# 클라이언트에서 읽는 env는 `process.env.X`를 글자 그대로 써야 하고, 기본값을 두면 설정 누락이 사라진다

**증상**
브라우저에서 도는 코드(`"use client"` 컴포넌트, 그것이 부르는 `src/lib/**`)가 환경변수를 읽는다. 두 가지를 하기 쉽다 — 구조분해로 꺼내기(`const { NEXT_PUBLIC_API_BASE_URL } = process.env`), 동적 접근(`process.env[key]`), 그리고 `?? "http://localhost:3001"` 같은 기본값.

**결과**
- Next.js는 **빌드 시점에 `process.env.NEXT_PUBLIC_*` 표현을 문자열로 치환**한다. 구조분해·동적 접근은 치환 대상이 아니어서 클라이언트 번들에서 `undefined`가 된다(`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md:184-192`). 서버에서 돌려보면 잘 되므로 로컬에서 잡히지 않는다. **문법 취향이 아니라 동작 조건이다.**
- `NEXT_PUBLIC_` 접두사가 없는 키는 클라이언트 번들에 아예 들어가지 않는다(같은 문서 `:156-166`).
- localhost 기본값을 두면 배포 빌드에서 브라우저가 **사용자 PC**를 향해 요청하고, 설정 누락이 "연결 실패"로 위장된다 — `local-env-file-masks-required-key-wiring`의 프론트엔드 판본이다.

**대응**
- 값을 직접 참조하고, 없으면 던진다. **모듈 로드 시점이 아니라 호출 시점에** 던진다 — 로드 시점 throw는 `next build`의 프리렌더를 깨서 빌드가 env를 요구하게 된다(호출 시점 throw는 env 없이 빌드 통과 실측).
- 키는 `.env.example`에 넣는다. `frontend/.gitignore`는 `.env*`를 통째로 무시하므로 `!.env.example` 예외를 함께 넣지 않으면 예시 파일이 커밋되지 않는다.
- 테스트는 `vi.stubEnv` / `vi.unstubAllEnvs`로 양방향(설정/미설정)을 고정한다. **vitest는 `.env.local`을 읽지 않으므로** 이 워크스페이스에서는 로컬 env 파일이 부재 테스트를 마스킹하지 않는다 — backend e2e(`ConfigModule`이 `.env`를 읽는다)와 다른 점이다.

**출처**
`4e123d2`(`.env.example`+gitignore 예외) · `38a3de0`(`resolveApiBaseUrl` 호출 시점 throw) · 계획 `docs/superpowers/plans/2026-07-28-frontend-chat-api.md` D-2
