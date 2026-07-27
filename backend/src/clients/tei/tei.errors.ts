import { ExternalFailureKind } from '../external-service.error';

/**
 * !response.ok일 때 TeiClient가 던진다. 상태와 본문 일부를 분류기까지
 * 실어 나르는 운반체다.
 *
 * TEI는 SDK가 없어 fetch를 직접 부르고, fetch는 4xx·5xx에 throw하지 않는다.
 * 이 오류를 만들지 않으면 분류기에 도달할 것이 아예 없어 실패가 조용히
 * 성공으로 흐른다 — 에러 JSON이 number[][]로 파싱되면 쓰레기 벡터가 Qdrant로 간다.
 *
 * bodySnippet은 로그용이며 분류에 쓰지 않는다. TEI는 상태 코드만으로
 * 판정이 결정된다 — 본문 문구로 판정하면 TEI 버전이 문구를 바꿀 때 조용히 어긋난다.
 */
export class TeiHttpError extends Error {
  readonly status: number;
  readonly bodySnippet: string;

  constructor(status: number, bodySnippet: string) {
    // 본문을 message에도 넣는 이유: callExternal의 로그는 cause 체인의 message만
    // 읽는다. 필드로만 두면 bodySnippet이 어디에도 출력되지 않아 죽은 값이 된다.
    super(
      bodySnippet === ''
        ? `TEI가 ${status}으로 응답했습니다.`
        : `TEI가 ${status}으로 응답했습니다. ${bodySnippet}`,
    );
    this.name = 'TeiHttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/**
 * 1단계 — 상태 코드 추출. TEI는 우리가 만든 TeiHttpError에만 상태가 있다.
 *
 * instanceof를 여기서는 써도 된다. 묶음 A의 N-1(realm이 갈리면 instanceof가
 * 어긋난다)은 undici가 호스트 realm에서 만드는 fetch 오류에 대한 것이고,
 * TeiHttpError는 같은 realm의 TeiClient가 만든다.
 * 외부에서 온 오류를 instanceof로 판정하지 않는다 — 그건 null로 흘려보내는 쪽이다.
 */
function statusOf(error: unknown): number | null {
  return error instanceof TeiHttpError ? error.status : null;
}

/**
 * 2단계 — 확정된 상태 안에서 세부를 가른다.
 *
 * 본문(bodySnippet)을 보지 않는다. TEI는 상태 코드만으로 판정이 결정되고,
 * 본문 문구로 가르기 시작하면 TEI 버전이 문구를 바꿀 때 조용히 어긋난다.
 */
function classifyByStatus(status: number): ExternalFailureKind {
  // 엔드포인트 경로 오설정(TEI_BASE_URL의 경로 부분이 틀림). 경로
  // `{TEI_BASE_URL}/embed`는 코드가 고정하므로 404는 요청 내용과 무관하게
  // 재현되는 배선 불일치다 — 모델명 오타·컬렉션 이름 오타와 같은 종류의
  // 우리 설정 문제라 not-found(500)로 끊는다. upstream(502)으로 두면
  // TEI는 멀쩡한데 그 응답을 받은 사람이 TEI 장애를 조사하게 된다.
  if (status === 404) {
    return 'not-found';
  }
  // 입력이 모델 제약을 벗어난 경우. truncate: true라 흔치 않다.
  if (status === 400 || status === 413 || status === 422) {
    return 'invalid-request';
  }
  // 5xx(모델 로딩 중·OOM)와 분류되지 않은 비-2xx는 모두 외부 사정으로 본다.
  return 'upstream';
}

/**
 * TEI 실패를 kind로 판정한다. 모르는 오류에는 null을 반환해 공통 판정에 넘긴다.
 *
 * gemini.errors.ts·qdrant.errors.ts와 같은 3단계 골격이되 **3단계가 없다.**
 * 문자열 추정 경로를 두지 않은 것이 이 서비스의 결정이다 — 상태를 못 읽었다는 것은
 * TeiHttpError가 아니라는 뜻이고, 그건 fetch가 던진 것(연결 거부·중단)이라
 * classifyCommonFailure의 몫이다. 여기서 가로채면 같은 실패가 두 곳에서 분류된다.
 *
 * auth·quota는 TEI에 없다 — 자체 호스팅이고 인증이 없다. not-found는 있다 —
 * 엔드포인트 경로(`{TEI_BASE_URL}/embed`)가 코드로 고정돼 있어 404는 TEI
 * 자체가 아니라 우리 `.env`의 경로 오설정을 가리키기 때문이다(review-CD.md
 * Minor 3, spec :628의 "같은 종류 오설정은 같은 kind" 원칙).
 * 서비스마다 쓰는 kind가 다른 것은 결함이 아니라, 이 타입이 서비스별 API가 아니라
 * 책임 귀속의 어휘라는 증거다.
 */
export function classifyTeiFailure(error: unknown): ExternalFailureKind | null {
  const status = statusOf(error);
  return status === null ? null : classifyByStatus(status);
}
