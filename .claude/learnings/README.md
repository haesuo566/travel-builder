# learnings — 복리 자산

이 디렉터리는 **관찰 원장(ledger)**이다. 파이프라인이 한 번 돌 때마다 `compounder`가 여기에 기록하고, 같은 관찰이 쌓이면 규칙으로 승급시킨다.

```
관찰 1회  →  .claude/learnings/{slug}.md            (원장에만 기록)
관찰 2회+ →  스킬 본문 / known-pitfalls.md 로 승급  (규칙이 됨)
```

원장 항목은 짧게 유지한다. **상세 점검 절차는 승급된 규칙 쪽에 있다** — 양쪽에 같은 내용을 두 벌 두면 한쪽이 반드시 낡는다.

## 파일 포맷

```markdown
---
type: pitfall | convention | environment | process
first_seen: {YYYY-MM-DD}
occurrences: {n}
promoted_to: {경로 또는 없음}
---

# {한 줄 제목}

**증상** / **결과** / **대응** / **출처**
```

## 누가 읽는가

`spec-architect` · `plan-writer` · `implementer` · 리뷰어 3인 · `compounder` — **파이프라인의 모든 에이전트가 시작 전에 이 디렉터리를 읽는다.** 그래서 정확도가 분량보다 중요하다. 틀린 학습은 없는 학습보다 나쁘다.

## 유지보수

- 참조하는 파일·함수·플래그가 사라졌으면 정정하거나 삭제한다
- 두 학습이 같은 말을 하면 병합하고 `occurrences`를 합산한다
- 이번 실행이 반증한 학습은 지운다

작성·승급 규칙 전문은 `.claude/skills/tb-compound/SKILL.md`에 있다.

## 초기 시드

아래 항목들은 하네스 구축 시점(2026-07-27)에 **git 이력과 기존 설계 문서에서 역으로 추출**한 것이다. `출처`에 커밋 해시가 있다.
