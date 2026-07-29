---
type: environment
first_seen: 2026-07-29
occurrences: 2
promoted_to: 없음
---

# 이 워크스페이스는 하네스 전용이 아니다 — main의 상태를 전제하지 말고 잰다

**증상**
`travel-builder`는 `backend`·`frontend`·`core`가 **`.git` 하나를 공유하는 단일 워크트리**다. 하네스를 거치지 않은 커밋과 다른 세션의 브랜치 조작이 같은 저장소에 섞인다. 2026-07-29 실행에서 두 형태로 나타났다.

1. **시작 시점의 게이트가 이미 빨갛다.** `main`(`9a9c392`)에서 `npx eslint src --max-warnings=0`이 이미 실패하고 있었다(`chat.controller.spec.ts`의 미사용 import 2건). 계획 작성 중 우연히 발견했다.
2. **구현 중간에 HEAD가 옮겨간다.** Task 3~4 사이에 HEAD가 `feat/chat-service-wiring`으로 바뀌어 있었다. implementer는 만든 적이 없고 커스텀 git hook도 없었다(`*.sample` 외 없음). `feat/frontend-dev-flow-harness`가 이미 존재하는 것과 같은 패턴이라 다른 세션이 같은 워크트리에서 브랜치를 만든 것으로 보인다 — **확정 증거는 없다.**

**결과**
1. 태스크마다 "원래 있던 실패인가 내가 만든 것인가"를 판정해야 한다. 구현자와 리뷰어가 같은 비용을 각각 낸다. 최악은 **기존 빨간불이 새로 만든 실패를 가리는 것**이다.
2. 이번엔 `main`이 그 브랜치의 조상(0/2)이라 `--ff-only`로 무손실 복구됐다. **diverge였다면 그렇지 않다.**

**대응**
- **첫 태스크 전에 게이트 3종을 기준선으로 한 번 돌린다** (`npm test` · `npx tsc --noEmit -p tsconfig.json` · `npx eslint src --max-warnings=0`). 빨간 것이 있으면 복구를 **독립 태스크로 먼저** 둔다 — 배선 태스크에 끼워 넣으면 커밋 하나가 두 가지 이유로 파일을 건드린다.
- HEAD가 예상과 다르면 **되돌리기 전에 조상 관계부터 잰다**: `git rev-list --left-right --count main...<브랜치>`. fast-forward 가능하면 `git merge --ff-only`, 브랜치 제거는 `git branch -d`(fully-merged만 허용하는 안전 모드). **`-D`·`reset --hard`로 지우지 않는다** — 다른 세션의 진행 중 작업일 수 있다.
- 이 저장소에서 git 상태를 "이 세션이 만든 것"으로 전제하지 않는다.

**승급 보류 근거**
두 증상은 뿌리가 같지만 실행 가능한 규칙이 다르고(기준선 측정 / 동시 actor 대응) **각각은 1회**다. `occurrences: 2`는 같은 실행 안의 두 형태를 센 값이지 두 실행에 걸친 재발이 아니다. 어느 한쪽이 다시 나면 그때 `tb-harness` Phase 0으로 승급한다.

**출처**
2026-07-29 `_workspace/2026-07-29-chat-service-wiring/journal.md` "묶음 A" 환경 이상 절 · `docs/plans/2026-07-29-chat-service-wiring.md` "발견 — 린트 게이트가 이미 깨져 있다"(결정 6 → Task 1 `0581346` test(backend): ChatModule 협력자 단정을 제목대로 셋으로 채운다)
