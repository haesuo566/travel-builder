---
name: tb-harness
description: travel-builder의 개발 파이프라인 오케스트레이터. plan(설계·계획) → work(TDD 구현) → review(reviewer-lite 단일 패스 기본, 고위험/명시 요청 시 정확성·계약·테스트품질 3축 병렬) → compound(학습 축적·하네스 갱신) 4단계를 전문 에이전트에게 분배해 조율한다. core/backend/frontend 어디든 기능 추가·변경·리팩터링·버그 수정 요청이 오면 반드시 이 스킬을 사용할 것. "이거 만들어줘", "기능 추가", "구현해줘", "고쳐줘", "리팩터링", "파이프라인 돌려줘" 같은 요청은 물론, "다시 실행", "재실행", "이어서 해줘", "리뷰만 다시", "계획만 수정", "이전 결과 기반으로 보완" 같은 후속 요청에도 이 스킬을 쓴다. 단순 질문·조회·설명 요청은 직접 답해도 된다.
---

# tb-harness — plan → work → review → compound

travel-builder의 모든 코드 변경이 지나가는 파이프라인. 이 스킬을 읽은 세션이 **오케스트레이터**다. 직접 구현하지 않는다 — 각 단계를 전문 에이전트에게 맡기고, 산출물을 잇고, 사용자 승인을 받는다.

## 실행 모드: 서브 에이전트

**이 환경에는 `TeamCreate`가 없다.** 에이전트 팀 모드는 사용할 수 없다. 조율은 다음 조합으로 한다.

| 수단 | 용도 |
|---|---|
| `Agent` 도구 | 단계별 전문 에이전트 호출. **모든 호출에 `model: "opus"`를 명시한다** |
| 반환값 | 에이전트 → 오케스트레이터 결과 수집 |
| 파일 (`.claude/_workspace/{run-id}/`) | 대용량 산출물·리뷰 보고서·저널 |
| `TaskCreate` / `TaskUpdate` | 태스크 진행 상황을 사용자에게 노출 |
| `SendMessage` | 이미 띄운 명명 에이전트를 컨텍스트 유지한 채 재호출 |

`subagent_type`에는 `.claude/agents/`의 에이전트 이름을 넣는다(예: `"spec-architect"`). 이름이 해석되지 않으면 `"general-purpose"`로 띄우고, 프롬프트 첫 줄에 **`.claude/agents/{name}.md`를 먼저 읽으라**고 지시한다.

## 다른 스킬과의 관계

이 저장소의 `docs/superpowers/`는 `superpowers` 플러그인 워크플로로 만들어졌고, 전역에는 `superpowers:*`와 `compound-engineering:ce-*`처럼 같은 영역을 다루는 스킬이 있다. 우선순위는 다음과 같다.

| 상황 | 사용 |
|---|---|
| travel-builder 코드 변경 (기본) | **`tb-harness`** — 저장소 규약·워크스페이스 제약·누적 학습을 아는 것은 이쪽뿐이다 |
| 사용자가 `/ce-plan`·`/superpowers:*`를 **직접 호출** | 사용자 지시가 우선. 그대로 따른다 |
| 요구사항 자체가 불명확해 발산이 필요 | Phase 1 앞에 `superpowers:brainstorming`을 붙이고, 결론을 `spec-architect`의 입력으로 넘긴다 |
| travel-builder 밖의 작업 | 이 스킬을 쓰지 않는다 |

산출물 경로(`docs/superpowers/{specs,plans}/`)는 기존 자산과 이어지도록 그대로 유지한다 — 디렉터리 이름이 `superpowers`일 뿐, 어느 워크플로로 만들었든 같은 곳에 쌓는다.

## Phase 0: 컨텍스트 확인 — 항상 먼저

`.claude/_workspace/`를 확인해 실행 모드를 정한다.

| 상황 | 모드 | 행동 |
|---|---|---|
| 해당 작업의 `_workspace/{run-id}/`가 없음 | **초기 실행** | Phase 1부터 |
| `_workspace/{run-id}/` 있음 + 사용자가 부분 수정 요청 | **부분 재실행** | 해당 Phase만. 아래 매트릭스 참조 |
| `_workspace/{run-id}/` 있음 + 새 요구사항 | **새 실행** | 기존을 `_workspace/{run-id}_prev/`로 옮기고 Phase 1부터 |
| 계획 문서에 미완료 체크박스가 남음 | **이어서 실행** | 남은 태스크 묶음부터 Phase 2 |

**부분 재실행 매트릭스**

| 요청 | 실행할 Phase |
|---|---|
| "설계 다시" / "spec 고쳐줘" | 1 → (사용자 판단) 2~4 |
| "계획만 수정" | 1 후반(plan-writer)만 |
| "리뷰만 다시" | 3 |
| "지적 고쳐줘" | 3의 수정 루프 |
| "학습 정리해줘" | 4 |

**run-id**는 `{YYYY-MM-DD}-{slug}`. slug는 spec/plan 파일명과 동일하게 맞춘다.

작업 디렉터리를 만든다: `.claude/_workspace/{run-id}/` — `journal.md`를 여기에 append한다.

---

## Phase 1: plan

**실행 모드:** 서브 에이전트 순차 (spec → plan). 두 산출물 사이에 **사용자 승인 게이트**가 있다.

### 1-1. spec-architect

```
Agent({
  subagent_type: "spec-architect",
  model: "opus",
  name: "spec-architect",
  run_in_background: false,
  prompt: `요구사항: {사용자 요청 원문}

대상 워크스페이스: {core | backend | frontend | 미정}
선행 spec: {경로 또는 없음}
run-id: {run-id}

.claude/learnings/ 전체를 먼저 읽어라.
docs/superpowers/specs/{run-id}-design.md 를 작성하고,
문서 경로·핵심 결정 요약·미해결 질문을 반환하라.`
})
```

**미해결 질문이 반환되면 사용자에게 묻는다.** 임의로 정하고 진행하지 않는다 — 잘못된 전제 위의 계획은 전부 폐기된다.

**게이트 1:** spec 경로와 핵심 결정을 사용자에게 제시하고 승인을 받는다. 승인 없이 1-2로 넘어가지 않는다.

### 1-2. plan-writer

```
Agent({
  subagent_type: "plan-writer",
  model: "opus",
  name: "plan-writer",
  run_in_background: false,
  prompt: `설계 문서: docs/superpowers/specs/{run-id}-design.md
run-id: {run-id}

.claude/learnings/ 와 .claude/skills/tb-tdd-implement/references/workspaces.md 를 읽어라.
docs/superpowers/plans/{run-id}.md 를 작성하고,
태스크 목록·리뷰 묶음 경계·spec 구멍 목록을 반환하라.`
})
```

**spec 구멍이 반환되면 1-1로 되돌린다.** 구멍이 있는 채로 구현에 들어가면 리뷰 단계에서 spec 이탈로 다시 잡혀 두 번 일한다.

**게이트 2:** 태스크 목록과 리뷰 묶음 경계를 사용자에게 제시하고 승인을 받는다.

승인되면 태스크 목록을 `TaskCreate`로 등록해 진행 상황이 보이게 한다.

`journal.md`에 기록: spec 경로 · plan 경로 · 태스크 수 · 리뷰 묶음 · 사용자가 답한 미해결 질문.

---

## Phase 2 ⇄ Phase 3: work / review 증분 루프

**전체를 다 만든 뒤 한 번에 리뷰하지 않는다.** 지적이 뭉쳐 나오고 되돌릴 거리가 멀어진다. 계획이 제안한 **리뷰 묶음마다** 다음 사이클을 돈다.

```
묶음 A: work → review(reviewer-lite) → 정리 → 수정 → 다음 묶음 (재검증 없음, 기본)
묶음 B: work → review → ...
```

### Phase 2: work — implementer

묶음 하나당 `implementer` 하나. 컨텍스트 격리를 위해 **묶음마다 새 에이전트**를 띄운다.

```
Agent({
  subagent_type: "implementer",
  model: "opus",
  name: "implementer-{group}",
  run_in_background: false,
  prompt: `계획: docs/superpowers/plans/{run-id}.md
담당 태스크: Task {n}~{m} (리뷰 묶음 {group})
run-id: {run-id}

.claude/learnings/ 를 먼저 읽어라.
태스크당 다섯 Step(실패 테스트→실패 확인→구현→통과 확인→커밋)을 지키고,
태스크당 커밋 하나를 만들어라.
계획을 벗어나야 하는 상황이면 임의로 고치지 말고 멈추고 보고하라.
커밋 목록·계획 이탈·테스트/타입 검사 결과·발견 사항을 반환하라.`
})
```

**계획 이탈이 보고되면 멈춘다.** 오케스트레이터가 판단한다:
- 계획이 틀렸다 → `plan-writer`를 재호출해 해당 태스크만 고친다
- spec이 틀렸다 → `spec-architect`까지 되돌린다
- 사소한 차이다 → 이탈을 저널에 기록하고 진행 (리뷰어가 이 기록을 본다)

묶음 시작 커밋 해시(`base`)를 기록해둔다. 리뷰 범위가 된다.

### Phase 3: review — reviewer-lite 단일 패스 (기본, 2026-07-27부터)

**`Agent` 호출 하나면 된다.** 과거엔 correctness·contract·test 3축이 병렬로 돌며 spec·plan·learnings·diff를 각자 처음부터 읽었다 — 정확도는 높지만 같은 컨텍스트를 3번 중복 로딩하는 비용이 review 단계 시간·토큰의 대부분을 차지했다. `reviewer-lite`는 세 체크리스트를 한 패스에서 함께 보아 이 중복을 없앤다.

**이것은 속도를 우선한 절충이며, 사용자가 버그 리스크 증가를 이미 승인했다.** 축 간 교차검증(서로 다른 눈으로 같은 코드를 봄)과 실행 기반 증명(임시 테스트·뮤테이션)과 재검증 사이클, 이 세 가지를 포기하고 review 비용을 약 80%+ 줄인다. 상세 트레이드오프는 `reviewer-lite` 에이전트 정의의 "이 모드가 놓칠 수 있는 것" 참조.

```
Agent({ subagent_type: "reviewer-lite", model: "opus", run_in_background: false, prompt: {아래 프롬프트} })
```

프롬프트:

```
리뷰 대상: git diff {base}..HEAD  (리뷰 묶음 {group}, Task {n}~{m})
계획: docs/superpowers/plans/{run-id}.md
설계: docs/superpowers/specs/{run-id}-design.md
구현자가 보고한 계획 이탈: {있으면 그대로 전달}
run-id: {run-id}

.claude/learnings/ 와 .claude/skills/tb-code-review/references/known-pitfalls.md 를 먼저 읽어라.
모든 지적에 실패 시나리오를 붙여라 — 못 만들면 그 지적은 버려라.
Critical·Major를 우선한다. 시간이 부족하면 Minor·Note는 생략해도 된다.
보고서를 .claude/_workspace/{run-id}/review-{group}.md 에 쓰고,
심각도별 건수와 제목 목록을 반환하라.
```

**예외 — 3축 병렬로 전환하는 경우:** 결제·인증·삭제처럼 고위험 변경이거나, 사용자가 "전체 리뷰로", "꼼꼼하게 봐줘", "3축 다 돌려줘"라고 명시하면 이 Phase를 기존 방식(`reviewer-correctness`+`reviewer-contract`+`reviewer-test` 병렬, `tb-code-review`의 병합·재검증 규칙 그대로)으로 전환한다. 세 에이전트 정의는 삭제하지 않았으니 그대로 쓴다.

### 3-1. 정리 — 오케스트레이터가 직접 한다

`review-{group}.md`를 읽고 `.claude/_workspace/{run-id}/findings-{group}.md`로 옮긴다. 축이 하나뿐이라 교차 병합은 없다 — `[범위 밖]` 표시된 지적만 수정 대상에서 빼서 Phase 4 입력으로 남긴다.

**게이트 3 (Critical이 있을 때만):** Critical 지적은 사용자에게 보고하고 수정 방향을 확인받는다. Major 이하는 바로 수정 루프로 넘어간다.

### 3-2. 수정 — implementer 재호출

같은 묶음의 `implementer-{group}`을 `SendMessage`로 재호출한다(컨텍스트가 살아 있어 맥락 설명이 필요 없다). 죽었으면 새로 띄운다.

```
지적 목록: .claude/_workspace/{run-id}/findings-{group}.md
지적 하나당 커밋 하나. 지적을 재현하는 테스트를 먼저 추가하라.
동의하지 않는 지적은 고치지 말고 반박 근거와 함께 반환하라.
지적별로 수정함/반박/보류를 빠짐없이 명시하라.
```

### 3-3. 재검증 — 기본적으로 하지 않는다

**이게 이번 축소의 핵심 트레이드오프다.** 이전에는 Critical·Major가 있으면 해당 축을 다시 불러 `해소/미해소/부분 해소`를 판정했다. 기본 흐름에서는 이 호출을 생략하고 **implementer의 수정 보고를 그대로 신뢰한다** — 수정이 실제로 지적을 해소했는지 아무도 다시 확인하지 않는다. 이건 실수가 아니라 사용자가 동의한 절충이다.

- 반박이 올라오면 오케스트레이터가 코드를 직접 읽고 판정한다(리뷰어를 다시 부르지 않는다). 판단이 갈리면 사용자에게 올린다.
- 사용자가 "다시 확인해줘"/"재검증해줘"라고 명시적으로 요청하면 그때만 `reviewer-lite`를 재호출한다. 요청 없이 자동으로 돌지 않는다.

### 3-4. 사이클 상한

기본은 **0사이클**(재검증 없음). 사용자 요청으로 재검증을 돌리는 경우도 **최대 1회** — 그래도 수렴 안 되면 설계 문제로 보고 사용자에게 올린다.

각 묶음이 끝날 때 `journal.md`에 append: 묶음 · 커밋 범위 · 지적 건수(심각도별) · 수정/반박/보류 내역.

---

## Phase 4: compound

모든 묶음이 끝나고 **최종 검증**(계획의 "최종 검증" 절 — 전체 테스트·타입 검사·빌드)이 통과한 뒤에 실행한다.

```
Agent({
  subagent_type: "compounder",
  model: "opus",
  run_in_background: false,
  prompt: `run-id: {run-id}

입력:
- .claude/_workspace/{run-id}/journal.md
- .claude/_workspace/{run-id}/findings-*.md
- .claude/learnings/ 전체
- docs/superpowers/{specs,plans}/{run-id}*.md
- git log {첫 커밋}..HEAD

일반화 가능한 것만 학습으로 남겨라. 없으면 없다고 하라.
같은 성질의 지적이 2회 이상이면 스킬·에이전트 정의를 고치고
CLAUDE.md 변경 이력에 기록하라.
정책·취향에 걸리는 변경은 직접 고치지 말고 제안으로 반환하라.
신규 학습·승급 내역·삭제한 학습·사용자 판단 필요 항목을 반환하라.`
})
```

**게이트 4:** 하네스 파일(`.claude/skills/`, `.claude/agents/`, `CLAUDE.md`)이 수정됐으면 **무엇을 왜 고쳤는지 사용자에게 보고**한다. 하네스가 조용히 바뀌면 다음 실행의 동작을 예측할 수 없다.

### 마지막에 피드백을 청한다

강요하지 않되 반드시 기회를 준다:

> 결과에서 개선할 부분이 있나요? 에이전트 구성이나 단계 순서에 바꾸고 싶은 점이 있나요?

피드백이 오면 성격에 따라 반영한다:

| 피드백 | 대상 |
|---|---|
| 산출물 품질 | 해당 단계의 스킬 |
| 에이전트가 놓친 관점 | 해당 에이전트 정의 |
| 단계 순서·승인 지점 | 이 파일 (`tb-harness`) |
| 트리거가 안 걸림 | 해당 스킬 description |

---

## 데이터 전달

```
.claude/_workspace/{run-id}/
├── journal.md                      # 전 단계 append. Phase 4의 주 입력
├── review-{group}.md                # reviewer-lite 보고서 (3축 전환 시 review-{group}-{axis}.md 3개)
└── findings-{group}.md             # 오케스트레이터가 정리

docs/superpowers/specs/{run-id}-design.md    # 사용자 자산 — 커밋한다
docs/superpowers/plans/{run-id}.md           # 사용자 자산 — 커밋한다
.claude/learnings/*.md                       # 복리 자산 — 커밋한다
```

`_workspace/`는 gitignore 대상이지만 **삭제하지 않는다.** 사후 검증과 다음 compound의 입력이다.

### journal.md 포맷

```markdown
# {run-id}

## Phase 1 — plan
- spec: {경로}
- plan: {경로} (태스크 {n}개, 묶음 {m}개)
- 사용자 결정: {미해결 질문에 답한 내용}

## 묶음 {group} — Task {n}~{m}
- 커밋: {base}..{head} ({k}건)
- 계획 이탈: {내용 또는 없음}
- 리뷰: Critical {a} / Major {b} / Minor {c} / Note {d}
- 처리: 수정 {x} / 반박 {y} / 보류 {z}
- 재검증: {없음(기본) | 1회(사용자 요청)}

## 최종 검증
- {명령} → {결과}
```

---

## 에러 핸들링

| 상황 | 대응 |
|---|---|
| 에이전트가 결과 없이 실패 | **1회 재시도.** 재실패면 그 단계 산출물 없이 진행하고 **저널과 사용자 보고에 누락을 명시**한다 |
| (3축 전환 모드에서) 리뷰어 3인 중 1인 실패 | 나머지 2축으로 진행. 누락된 축을 findings 문서 상단에 명시 |
| 리뷰어 지적이 서로 반대되는 반박 | 삭제 금지. 양쪽 병기 + 출처 표기 후 사용자 판단 |
| 구현자가 3회 시도해도 막힘 | 중단. 지금까지의 커밋과 막힌 지점을 사용자에게 보고 |
| 계획 이탈이 spec 수준 | Phase 1로 되돌린다. 우회 구현을 승인하지 않는다 |
| 사용자 요청으로 재검증했는데도 수렴 안 됨(2회차 진입) | 멈추고 사용자에게 올린다 (설계 문제일 가능성) |
| 최종 검증 실패 | Phase 4로 넘어가지 않는다. 실패를 보고하고 수정 루프로 되돌린다 |
| `_workspace/` 쓰기 실패 | 저널 없이 진행하지 않는다 — Phase 4의 입력이 사라진다. 경로를 확인하고 중단 |

**보고는 정직하게 한다.** 건너뛴 단계, 실패한 검증, 누락된 리뷰 축은 전부 사용자에게 말한다.

## 하지 않는 것

- **오케스트레이터가 직접 구현하지 않는다.** 급해 보여도 `implementer`를 띄운다. 직접 짜면 리뷰 대상이 없어지고 저널이 비어 compound가 굶는다.
- **게이트를 건너뛰지 않는다.** 승인 없이 다음 단계로 가지 않는다.
- **계획 없이 구현하지 않는다.** 한 줄 수정이라도 계획이 있어야 리뷰가 기준을 갖는다. 오타 수정 같은 것은 애초에 이 스킬을 트리거하지 않는다.

## 규모에 맞춘 축약

전부 도는 것이 항상 옳지는 않다. 요청 규모에 맞춰 줄인다.

| 규모 | 축약 |
|---|---|
| 태스크 3개 이하 단일 워크스페이스 | spec 생략 가능(계획에 결정을 인라인). 리뷰 묶음 1개 |
| 버그 수정 1건 | Phase 1을 "재현 테스트 + 수정 태스크" 계획 하나로. 리뷰는 기본(`reviewer-lite`) 유지 |
| 여러 워크스페이스에 걸친 기능 | 전체 수행. `reviewer-lite` 프롬프트에 경계면 교차 비교(체크리스트 2번)를 특히 강조하도록 명시한다 |
| 리팩터링 (동작 무변경) | `reviewer-lite`에게 테스트 품질(회귀 공백) 비중을 높이라고 프롬프트에 명시한다 — 동작 보존의 유일한 증거다 |

**축약해도 review(`reviewer-lite` 최소 1회)와 compound는 유지한다.** 그 둘이 이 하네스의 존재 이유다.

---

## 테스트 시나리오

### 정상 흐름

> "core에 `tb stats` 커맨드를 추가해줘. 스테이지별 진행 상황을 표로 보여주는 거."

1. Phase 0 — `_workspace/`에 해당 run 없음 → 초기 실행. run-id `2026-07-27-tb-stats`
2. Phase 1-1 — `spec-architect`가 `countStageStatus` 재사용을 결정, 출력 포맷을 확정. 미해결 질문 없음 → 게이트 1 통과
3. Phase 1-2 — `plan-writer`가 태스크 3개(포매터 순수 함수 / 커맨드 / index 등록), 묶음 1개 제안 → 게이트 2 통과
4. Phase 2 — `implementer`가 태스크 3개를 TDD로 구현, 커밋 3개
5. Phase 3 — `reviewer-lite` 단일 패스. "빈 결과일 때 출력 테스트 없음"(Major) 1건 → `implementer`가 수정 → **재검증 없이 신뢰**, 다음 단계로
6. 최종 검증: `npm test`, `npm run typecheck`, `npm run build` 통과
7. Phase 4 — `compounder`: 새 학습 없음. 정직하게 "없음" 보고 → 사용자 피드백 청취

### 에러 흐름

> 같은 요청, 그러나 Phase 2에서 `implementer`가 보고: *"계획 Task 2가 `countStageStatus`의 반환에 `nodata` 카운트가 있다고 전제하는데 실제로는 없다."*

1. 오케스트레이터가 멈춘다. 임의 우회를 승인하지 않는다
2. 판정: spec의 전제가 틀렸다 → Phase 1-1로 되돌림
3. `spec-architect` 재호출 — 기존 문서의 **해당 절만** 수정, 변경 근거 병기
4. `plan-writer` 재호출 — 완료된 Task 1(`- [x]`)은 건드리지 않고 Task 2~3만 갱신
5. Phase 2 재개 — 남은 태스크부터
6. Phase 4 — `compounder`가 이 이탈을 학습으로 남긴다: *"spec이 기존 함수의 반환 shape을 전제할 때, 실제 시그니처를 인용하지 않으면 계획 전체가 무너진다"*. 이것이 2회째라면 `tb-spec-writing`의 "현행을 특정하는 법"을 규칙으로 강화하고 CLAUDE.md 이력에 기록
