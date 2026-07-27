---
type: pitfall
first_seen: 2026-07-26
occurrences: 1
promoted_to: .claude/skills/tb-code-review/references/known-pitfalls.md (D-1)
---

# `CREATE TABLE IF NOT EXISTS`에 컬럼을 추가해도 기존 테이블에는 생기지 않는다

**증상**
테이블 생성 함수의 `CREATE TABLE IF NOT EXISTS`에 컬럼을 추가한다.

**결과**
테이블이 이미 존재하면 **구문 전체가 no-op**이라 신규 컬럼이 절대 생기지 않는다. 로컬 신규 DB에서는 통과하고 운영에서만 깨진다.

**대응**
`CREATE TABLE` 뒤에 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`를 붙여 신규 생성과 기존 갱신을 **한 함수에서** 처리한다. 이 저장소는 마이그레이션 프레임워크를 쓰지 않으므로 이 패턴이 유일한 스키마 진화 수단이다. 테스트는 발행 SQL에 `ALTER TABLE`이 포함되는지 확인한다.

**출처**
`20a3cd2` · `ae31b35`
