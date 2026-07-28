---
type: process
first_seen: 2026-07-28
occurrences: 1
promoted_to: .claude/skills/tb-plan-writing/SKILL.md (검증 배정 절)
---

# 계획 끝의 "최종 검증" 절은 장식이 아니라 오케스트레이터의 입력이다

**증상**
spec을 생략한 축약 실행에서 계획이 `리뷰 묶음`까지만 쓰고 끝났다. 템플릿(`references/plan-template.md:97`)에는 `## 최종 검증`이 있지만 `tb-plan-writing/SKILL.md` 본문은 `리뷰 묶음`만 필수 절로 설명한다 — plan-writer가 본문만 보고 쓰면 빠진다.

**결과**
`tb-harness/SKILL.md:322,401`은 "**계획의 '최종 검증' 절**"을 읽어 마지막 묶음 뒤에 돌린다. 절이 없으니 오케스트레이터가 전체 게이트(`npm test`·`tsc`·`lint`·`build`)를 임의로 구성해 대체했다. 이번에는 결과가 같았지만, 계획만 아는 항목(env 없이 빌드 통과 확인, 뮤테이션 결과, 사용자 확인 필요 항목)은 임의 구성으로는 복원되지 않는다 — 계획이 "실측해야 한다"고 판단한 것이 조용히 검증에서 빠진다.

**대응**
계획의 꼬리 두 절(`리뷰 묶음`, `최종 검증`)은 **다른 에이전트가 파싱하는 인터페이스**로 취급한다. 규모를 축약해도(spec 생략, 태스크 4개) 빼지 않는다. 최종 검증에는 게이트 명령뿐 아니라 **그 계획에서만 아는 실측 항목**을 함께 적는다.

**출처**
`2026-07-28-frontend-chat-api/journal.md` 최종 검증 비고 · `docs/superpowers/plans/2026-07-28-frontend-chat-api.md`(절 부재) ↔ backend-clients·backend-cors·chat-intent-classification 계획(절 존재)
