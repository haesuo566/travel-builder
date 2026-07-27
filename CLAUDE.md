# travel-builder

## 하네스: 개발 파이프라인

**목표:** 모든 코드 변경이 `plan → work → compound`(review는 명시적 요청 시에만 추가)를 통과하게 하고, 리뷰에서 잡힌 것이 다음 실행의 규칙으로 남게 한다.

**트리거:** `core` / `backend` / `frontend`의 기능 추가·변경·리팩터링·버그 수정 요청이 오면 `tb-harness` 스킬을 사용하라. 후속 요청("다시 실행", "이어서", "리뷰해줘", "리뷰만 다시", "계획만 수정")도 같은 스킬로 처리한다. 단순 질문·조회·설명은 직접 응답해도 된다.

**변경 이력:**

| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-27 | 초기 구성 (에이전트 7 · 스킬 6 · 학습 시드 7) | 전체 | - |
| 2026-07-27 | review 기본 모드를 3축 병렬(correctness/contract/test)에서 `reviewer-lite` 단일 패스로 교체. 실행 기반 증명(임시 테스트·뮤테이션)과 재검증 사이클 생략, 고위험/명시 요청 시에만 3축 병렬로 복귀 | tb-harness, tb-code-review, agents/reviewer-lite.md(신규) | review 단계가 시간·토큰을 가장 많이 쓴다는 사용자 피드백. 버그 리스크 증가를 사용자가 명시적으로 승인(약 80%+ 절감 목표) |
| 2026-07-27 | 게이트 2(plan 승인)를 **모델 전환 지점**으로 강화. Phase 1 완료 시 설계·계획 요약과 함께 `/model sonnet` 전환을 요청하고 사용자 응답까지 하드 정지한다. 단계별 모델 정책 표 신설(spec·plan·review·compound=opus, implementer=sonnet) | tb-harness, agents/implementer.md | `~/CLAUDE.md`의 "설계=Opus, 구현=Sonnet" 규칙을 파이프라인에 실제로 적용. 세션 모델은 오케스트레이터가 바꿀 수 없어 정지점이 없으면 전환 기회 자체가 사라짐. harness 메타 스킬의 "전원 opus" 규칙에서 의도적으로 이탈 |
| 2026-07-27 | 3축 리뷰어 정의를 현행과 동기화. 세 파일이 여전히 자신을 기본 경로("3축 중 하나, 병렬로 실행")로 설명하던 것을 "전환 시에만 호출되는 모드"로 고치고, 각 축이 `reviewer-lite` 대비 추가로 제공하는 것(뮤테이션 증명·대조 깊이·독립 교차검증)을 명시 | agents/reviewer-correctness.md, agents/reviewer-contract.md, agents/reviewer-test.md | 앞 항목의 기본 모드 교체가 세 에이전트 정의에 반영되지 않아 drift 발생. 오케스트레이터가 어느 쪽이 기본인지 오판할 여지를 제거 |
| 2026-07-28 | review 단계를 **기본 생략**으로 전환. 트리거만 있는 요청은 plan → work → compound로 끝나고, 사용자가 "리뷰해줘"/"review 포함해서 작업해줘"처럼 명시적으로 요청할 때만 Phase 3(`reviewer-lite` 기본, 강도 지정 시 3축)을 끼워 넣는다. 고위험 변경은 자동으로 켜지 않되 게이트 2에서 포함 여부를 먼저 물어본다 | tb-harness | `reviewer-lite`로도 review 단계가 여전히 오래 걸린다는 사용자 피드백. review 비용 자체를 없애기보다 "필요할 때만 켠다"로 전환 |
