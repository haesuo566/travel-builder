@AGENTS.md

## 하네스: frontend 개발 흐름

**목표:** 개발 작업을 plan → work → review → compound 4단계로 조율해, 계획 없이 구현하거나 검증 없이 커밋하거나 교훈을 잃는 것을 막는다.

**트리거:** frontend의 기능 개발·버그 수정·리팩터링 요청 시 `dev-flow` 스킬을 사용하라. 중단된 작업 재개·단계별 재실행도 같은 스킬이 진입점을 판정한다. 단일 파일의 오타·상수 변경처럼 계획이 필요 없는 변경과 단순 질문은 직접 처리한다.

단계별 단독 호출: `fast-plan`(계획) / `unit-work`(구현) / `lite-review`(리뷰) / `capture-learning`(학습).

**산출물 경로:** 계획 `docs/plans/` · 학습 `docs/solutions/` · 중간 산출물 `.claude/_workspace/`(git 무시)

**변경 이력:**

| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-29 | 초기 구성 — 에이전트 7개, 스킬 5개 | 전체 | - |
| 2026-07-29 | 에이전트 팀 모드 제거, 서브 에이전트 + 리더 경유 통신으로 교체 | unit-work, dev-flow, unit-implementer | 이 환경에 `TeamCreate`가 없어 호출 시점에 실패 (삭제된 `.claude/learnings/no-agent-team-in-this-env.md`) |
| 2026-07-29 | 계획 템플릿에 `## 최종 검증` 절 추가, 리뷰가 이 절을 파싱하도록 연결 | plan-architect, fast-plan, lite-review | 절이 없으면 리뷰가 게이트를 임의 구성해 계획만 아는 실측 항목이 빠짐 |
| 2026-07-29 | 재개 시 미커밋 diff를 hunk 단위로 분류하는 단계 추가 | unit-work Phase 0, dev-flow Phase 0 | 근거 없는 stray 변경이 테스트 초록불 상태로 커밋에 섞인 전례 |
| 2026-07-29 | env 인라인·`.tsx` 미수집 규칙 정밀화 | boundary-checklist, unit-implementer, regression-reviewer | 삭제된 학습 2건 반영 (호출 시점 throw, 테스트 파일명 수집 확인) |
