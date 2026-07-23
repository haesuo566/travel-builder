# core TeiEmbeddingClient 설계 (TEI 임베딩 서버 연동)

- 날짜: 2026-07-23
- 위치: `core/`
- 상태: 승인됨

## 목적

`core`에 Hugging Face TEI(Text Embeddings Inference) 서버 연동 클래스를 만든다. 이 클라이언트가 만든 임베딩 벡터는 `QdrantStore.upsert`/`search`에 그대로 넘겨져 RAG 파이프라인의 벡터 저장/검색에 쓰인다.

## 결정 사항

| 항목 | 선택 |
|------|------|
| 엔드포인트 | 네이티브 `POST /embed` (OpenAI 호환 `/v1/embeddings`는 범위 밖) |
| 인증 | 없음 (자체 호스팅 TEI는 보통 인증 없이 동작) |
| normalize/truncate | `embed()` 호출 시 옵션으로 지정 가능 (기본값은 둘 다 `true`) |
| HTTP 클라이언트 | axios (기존 프로젝트 의존성 재사용, 신규 의존성 없음) |
| 수명주기 | 무상태 (GeminiClient/TourApiClient와 동일 — connect/close 없음) |
| 메서드 형태 | 배치 우선 — `embed(texts: string[])`. 단건은 `embed([text])`로 처리, 별도 `embedOne` 없음 |

## TEI API 실제 스펙 (context7로 확인)

`POST /embed` 요청 바디: `{ inputs: string | string[], normalize?: boolean, truncate?: boolean, prompt_name?: string }`.
응답: `number[][]` — 입력이 단건이어도 배치여도 항상 "임베딩의 배열" 형태(예: 단건 입력 시 `[[0.1, 0.2, ...]]`)로 오며, 입력 순서와 1:1 대응된다. TourAPI와 달리 응답 형태가 단순해 별도 정규화 로직이 필요 없다.

## 파일 구조

```
core/src/clients/tei.ts
core/tests/clients/tei.test.ts
```

기존 `core/src/lib/env.ts`(`requireEnv`)를 재사용한다. 신규 의존성 없음(axios는 TourApiClient 작업에서 이미 추가됨).

## 클래스 인터페이스

**env**: `TEI_BASE_URL`(필수, 예: `http://localhost:8080`)

```ts
interface TeiEmbedOptions {
  normalize?: boolean;   // 기본 true
  truncate?: boolean;    // 기본 true (모델 최대 길이 초과 시 잘라서 에러 방지)
  promptName?: string;   // 선택 — instruction-tuned 모델용, TEI의 prompt_name에 매핑
}

class TeiEmbeddingClient {
  constructor()  // env 로딩만. 네트워크 호출 없음.

  embed(texts: string[], opts?: TeiEmbedOptions): Promise<number[][]>
}
```

- `texts.length === 0`이면 TEI를 호출하지 않고 즉시 빈 배열을 반환한다(불필요한 네트워크 호출 방지).
- 요청 바디는 `{ inputs: texts, normalize: opts.normalize ?? true, truncate: opts.truncate ?? true, prompt_name: opts.promptName }`이며, `prompt_name`이 `undefined`면 요청 바디에서 생략한다.
- 응답 `number[][]`를 그대로 반환한다(입력 순서 = 출력 순서, 별도 매핑 불필요).

## 에러 처리

- `TEI_BASE_URL` 누락 시 생성자에서 명확한 메시지로 throw.
- axios가 던지는 네트워크/HTTP 에러는 최소 래핑으로 그대로 전파한다(기존 클라이언트들과 일관된 최소 에러 처리 원칙).

## 테스트 (단위 · 모킹)

axios를 `vi.mock`으로 모킹한다(실제 네트워크 호출 없음).

- `TEI_BASE_URL` 누락 시 생성자 throw.
- 기본 옵션(`normalize=true, truncate=true`)으로 `POST {TEI_BASE_URL}/embed`에 올바른 바디를 보내는지.
- `opts`로 `normalize`/`truncate`/`promptName`을 덮어쓸 수 있는지, `promptName` 미지정 시 요청 바디에서 생략되는지.
- 응답 `number[][]`를 그대로 반환하는지(단건/배치 모두).
- 빈 배열(`[]`) 입력 시 axios 호출 없이 빈 배열을 즉시 반환하는지.

## 검증 계획

1. `npm run typecheck` (src + tests) 통과.
2. `npm test` — 신규 단위 테스트 전부 통과.
3. `npm run build` 성공.

## 범위 밖 (YAGNI)

- OpenAI 호환 `/v1/embeddings` 엔드포인트.
- 인증(API 키/Bearer 토큰) 지원.
- TEI 기본 배치 상한(32건)을 넘는 입력의 자동 청크 분할.
- 재시도 로직.
- 별도 단건 편의 메서드(`embedOne`).
