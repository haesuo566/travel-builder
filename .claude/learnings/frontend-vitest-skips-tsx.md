---
type: environment
first_seen: 2026-07-27
occurrences: 1
promoted_to: .claude/skills/tb-tdd-implement/references/workspaces.md (frontend 절)
---

# frontend의 vitest는 `.tsx` 테스트를 조용히 건너뛴다

**증상**
`frontend`에 React 컴포넌트 테스트를 `*.test.tsx`로 추가하고 `npm test`를 돌린다.

**결과**
`frontend/vitest.config.ts`의 `include`가 `["src/**/*.test.ts"]`뿐이라 **파일이 아예 수집되지 않는다.** 실패도 에러도 없이 "통과"로 보인다. 게다가 `environment: "node"`라 DOM API도 없다.

**대응**
컴포넌트 테스트를 도입하려면 `include`에 `.tsx`를 추가하고 `environment`를 `jsdom`(또는 `happy-dom`)으로 바꾸는 **태스크를 계획에 명시적으로 넣는다.** 테스트를 추가했으면 실행 결과에 그 파일명이 실제로 찍히는지 확인한다 — 수집 여부는 통과/실패로 구분되지 않는다.

**출처**
2026-07-27 하네스 구축 시 `frontend/vitest.config.ts` 확인
