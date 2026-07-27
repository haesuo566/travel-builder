---
type: pitfall
first_seen: 2026-07-26
occurrences: 1
promoted_to: .claude/skills/tb-code-review/references/known-pitfalls.md (B-1)
---

# 하나의 상태를 두 컬럼이 나눠 가지면 되돌리기가 반쪽이 된다

**증상**
내용 컬럼(`structured_text`)과 상태 컬럼(`structure_status`)이 같은 사실을 나타낸다. 재처리를 위해 상태 컬럼만 `pending`으로 되돌린다.

**결과**
재사용 분기가 남아 있는 **옛 내용을 유효한 것으로 보고 다시 `done`으로 수렴**시킨다. 재생성이 영원히 일어나지 않고, 아무도 눈치채지 못한다.

**대응**
재사용·캐시 분기는 **단일 진실 원천 하나만** 본다. 두 컬럼 구조가 불가피하면 되돌리는 SQL이 두 컬럼을 함께 되돌리도록 설계 문서에 명세하고, 그 SQL을 문서에 그대로 적어둔다.

**출처**
`5aa5cfe` (재사용 분기가 structure_status를 단일 진실로 삼게 한다) · `4b5101a` (재구조화 SQL 명세)
