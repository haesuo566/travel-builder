---
type: environment
first_seen: 2026-07-27
occurrences: 1
promoted_to: .claude/skills/tb-harness/SKILL.md ("실행 모드" 절)
---

# 이 환경에는 `TeamCreate`가 없다 — 에이전트 팀 모드를 쓸 수 없다

**증상**
멀티 에이전트 조율을 설계할 때 `TeamCreate` / `TeamDelete`를 전제한다.

**결과**
도구가 존재하지 않아 호출이 실패한다. 팀원 간 자체 조율(`SendMessage` 기반 상호 토론)에 의존하는 설계는 이 저장소에서 성립하지 않는다.

**대응**
`Agent` 도구 기반 **서브 에이전트 모드**로 설계한다. 사용 가능한 조율 수단은 `Agent`(호출) · 반환값(결과 수집) · 파일(`_workspace/`, 대용량 산출물) · `TaskCreate`/`TaskUpdate`(진행 노출) · `SendMessage`(이미 띄운 명명 에이전트 재호출)다. 병렬 실행은 **한 메시지에 여러 `Agent` 호출**을 담아 얻는다.

이 사실이 바뀌면(도구가 추가되면) 이 학습을 삭제하고 `tb-harness`의 실행 모드 절을 다시 판단한다.

**출처**
2026-07-27 하네스 구축 시 도구 목록 확인
