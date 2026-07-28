---
type: process
first_seen: 2026-07-27
occurrences: 2
promoted_to: .claude/skills/tb-harness/SKILL.md (Phase 0 재개 판정 · Phase 3-2 · journal 포맷)
---

# 실행 상태가 저널 문장과 `_workspace/` 파일에 나뉘어 있으면 다음 세션이 잘못된 상태로 수렴한다

**증상**
`journal.md`를 단계가 **끝날 때** 갱신한다. 세션이 중간에 끊기거나 산출물만 만들고 저널을 못 쓰면, 저널과 실제 파일이 갈린다.

**결과**
- `review-CD.md`·`findings-CD.md`가 이미 있는데 저널의 묶음 D 항목은 `리뷰: 아직 안 함`이었다. 재개한 세션이 저널을 믿어 **Minor 3건이 수정 루프를 타지 않고 세션을 넘어갔다.** 사용자가 직접 짚어야 발견됐다.
- 그 앞 세션에서는 `_workspace/`가 통째로 유실됐다(gitignore 대상). `findings-A.md`·`findings-B.md` 원문은 **영구히 없다** — 지적 번호와 해소 커밋만 git log에서 역복원됐고, compound가 A·B의 지적 성질을 판정할 근거를 잃었다.

둘 다 같은 구조다. 상태가 두 곳에 있는데 한 곳만 갱신되면, 다음 읽는 쪽이 낡은 쪽을 유효한 것으로 보고 확정한다(`two-columns-one-state.md`와 같은 병).

**대응**
- **재개할 때 저널만 읽지 않는다.** `ls .claude/_workspace/{run-id}/`를 먼저 보고 저널과 대조한다. `review-*.md`가 있는데 저널에 리뷰 기록이 없으면 **파일이 맞고 저널이 낡은 것이다.**
- **`findings-*.md`를 만들었으면 그 실행 안에서 수정 루프를 닫는다.** 못 닫으면 저널에 `미해결 이월: {n}건 — {파일}의 {지적 제목}`을 남긴다. 산출물만 만들고 저널을 갱신하지 않은 채 다음 묶음으로 넘어가지 않는다.
- 저널은 단계 끝이 아니라 **산출물 파일이 생긴 직후** append한다.

**출처**
`journal.md` 머리말(재구성본 선언) · `journal.md` 묶음 D 항목 · `review-CD.md`의 사후 `[해소 — …]` blockquote 3건
