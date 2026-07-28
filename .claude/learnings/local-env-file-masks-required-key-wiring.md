---
type: pitfall
first_seen: 2026-07-28
occurrences: 1
promoted_to: .claude/skills/tb-code-review/references/known-pitfalls.md (F-5)
---

# 로컬 `.env`가 있으면 필수 env 키의 테스트 배선 누락이 초록불로 숨는다

**증상**
필수 환경변수를 추가할 때 `REQUIRED_KEYS`와 `.env.example`은 고치고 `backend/test/setup-env.ts`를 빼먹는다. e2e를 돌려도 통과한다.

**결과**
`ConfigModule`이 로컬 `backend/.env`(gitignore 대상)에서 값을 찾아내므로 **누락이 드러나지 않는다.** `.env`가 없는 환경(CI·새로 클론한 워크스페이스)에서만 부팅 단계에서 죽는다. 이 저장소의 env 배선은 **테스트로 자기 자신을 증명하지 못하는 구간**을 갖고 있다.

**대응**
- 필수 키 추가는 `REQUIRED_KEYS` · `.env.example` · `test/setup-env.ts` · 사용처를 **한 커밋에서** 함께 고친다(`workspaces.md` 경계표 122행).
- 배선을 증명하려면 **`.env`를 임시로 옮겨놓고 e2e를 한 번 돌려** env 부재로 실패하는 것을 눈으로 본 뒤 복구한다. 통과만 확인하는 것으로는 `setup-env.ts` 누락과 정상 배선을 구분할 수 없다.
- **마스킹 여부는 테스트 러너가 env 파일을 읽는지로 갈린다.** backend e2e는 `ConfigModule.forRoot`가 `.env`를 읽어 마스킹되지만, frontend의 vitest는 `.env.local`을 읽지 않아 `vi.stubEnv` 기반 부재 테스트가 로컬 파일과 무관하게 성립한다. 새 워크스페이스에서는 먼저 이것을 확인하고 나서 의심한다.
- 반대로 부재 실패가 확인됐으면 그 결과를 저널 최종 검증에 적는다 — 다음 실행이 같은 의심을 반복하지 않는다.

**출처**
`ccc10bb` 커밋 메시지 · `journal.md` 최종 검증(`.env` 숨기고 e2e 실패 확인)
