---
type: pitfall
first_seen: 2026-07-26
occurrences: 3
promoted_to: .claude/skills/tb-code-review/references/known-pitfalls.md (A절)
---

# 실패의 책임을 잘못된 대상에게 청구한다

**증상**
실패를 한 덩어리로 처리한다. 쿼터 소진·인증 만료·네트워크 단절·DB 쓰기 실패가 전부 "기타 오류" 분기로 들어간다.

**결과**
- 쿼터 소진에 항목의 `attempt_count`를 올리면 → 멀쩡한 데이터가 며칠 만에 `failed`로 영구 제외
- 시스템 장애를 항목 오류로 기록하면 → claim한 전량에 실패가 박힘
- DB 쓰기 실패를 외부 호출 실패로 분류하면 → 이미 태운 쿼터를 버리면서 남의 attempt를 올림

**대응**
분기 전에 묻는다: **이 실패의 책임이 데이터에 있는가, 호출자 사정에 있는가, 우리 저장소에 있는가.** 셋의 처리가 다르다. spec의 에러 처리 표에 세 종류가 모두 나타나지 않으면 아직 분류하지 않은 것이다.

**출처**
`b9b0936` (enricher 리뷰 지적 4건 — 쿼터 오분류·소진 미대응) · `2026-07-26-collect-detail-inline-embedding-design.md` 함정 1/4/5
