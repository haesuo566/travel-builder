---
type: environment
first_seen: 2026-07-27
occurrences: 2
promoted_to: .claude/skills/tb-tdd-implement/references/workspaces.md (backend 제약)
---

# backend eslint는 `recommendedTypeChecked`다 — 계획에 지어 쓴 테스트 코드가 린트를 통과하지 못한다

**증상**
계획이 관용적으로 보이는 테스트 코드를 제시한다. 중첩 `expect.objectContaining({ config: expect.objectContaining({...}) })`, `spy.mock.calls[0][0]`을 그대로 읽는 헬퍼.

**결과**
`no-unsafe-assignment`·`no-unsafe-member-access`가 **error**라서 린트가 막는다(`no-explicit-any`만 off다). 구현자가 매번 계획 이탈을 만들어야 하고, 그 이탈이 리뷰·판정 비용을 낸다. 이 실행에서 두 번 났다.

**대응**
- 타입 있는 mock에는 `toHaveBeenCalledWith(objectContaining(...))` 대신 **`const [params] = fn.mock.calls[0];` + 필드별 단정**을 기본형으로 쓴다. 검증은 더 강해진다 — `.cofnig` 오타가 컴파일에서 잡힌다. `as { … }` 캐스팅으로 우회하는 것은 정확히 반대 방향이다.
- `jest.SpyInstance`의 `mock.calls`는 `any`로 추론되므로 `as unknown as unknown[][]`을 한 번 거쳐 좁힌다.
- 리뷰 게이트는 `--max-warnings=0`으로 돌므로 **warn도 실패다** — 타입 있는 인자 자리의 `expect.anything()`·최상위 `objectContaining`도 쓰지 않는다.
- 계획에 **새로 지어 쓴 코드 예시를 넣지 않는다.** 커밋된 코드에서 가져오거나, 새로 쓸 일이 생기면 먼저 `backend/`에서 컴파일·린트를 통과시킨 뒤 그 형태를 옮긴다.

**효과 확인 (2026-07-28)**
계획 작성 시 전 태스크 코드를 `backend/`에 실제로 만들어 tsc·test·lint·build·e2e를 통과시킨 뒤 원상복구했다(약 55분). 그 실행에서 **typed-lint발 이탈은 0건**이었다 — 선제 검증은 값을 한다. 남은 lint 이탈 1건은 성질이 다르다: 최종 상태만 통과시켜서 태스크 중간 상태의 `no-unused-vars`를 못 봤다(`plan-code-blocks-go-stale.md` 7회차). 검증은 **태스크 경계마다** 해야 한다.

**출처**
`38c5ee9` (규칙 명문화) · `8b72103` 이탈(중첩 objectContaining) · `call-external.spec.ts:17-29`(`allLogMessages` 헬퍼) · 계획 `:71`·`:112-130`
