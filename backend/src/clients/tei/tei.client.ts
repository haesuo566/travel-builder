import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { callExternal } from '../call-external';
import { ExternalServiceError } from '../external-service.error';
import { classifyTeiFailure, TeiHttpError } from './tei.errors';

/**
 * 자체 호스팅 서버의 단문 임베딩 한 건이고, TEI는 모델 로딩 중에 5xx를 내므로
 * 5초를 넘길 정상 경로가 없다. env로 열지 않는다.
 */
const TEI_TIMEOUT_MS = 5000;

/** 오류 본문을 로그에 남길 때의 상한. 전문을 남기면 로그가 응답 본문으로 채워진다. */
const BODY_SNIPPET_LIMIT = 200;

/**
 * TEI 질의 임베딩 클라이언트.
 *
 * 색인용 배치 임베딩(embed(texts[]))을 노출하지 않는다 — backend에 배치 호출자가
 * 없고, 노출하면 색인을 backend에서 하려는 유혹이 함께 들어온다.
 * 단건 반환 타입 number[]가 "[0]을 꺼내고 undefined를 체크하는" 실수를
 * 타입에서 없앤다(core가 실제로 그 체크를 반복한다 — enricher.ts:250-255).
 */
@Injectable()
export class TeiClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    // 생성자는 네트워크를 만지지 않는다.
    this.baseUrl = config.getOrThrow<string>('TEI_BASE_URL');
  }

  /**
   * 질의 텍스트 한 건을 임베딩 벡터로 만든다. 색인과 같은 설정으로 고정돼 있다.
   *
   * normalize·truncate·prompt_name을 인자로 받지 않는 이유는, 색인이 만들어진
   * 조건과 다르게 질의할 수 있는 경로를 만들지 않기 위해서다. 요청 바디는
   * core/src/clients/tei.ts:22-31과 같아야 한다 — 갈리면 같은 텍스트가
   * 두 워크스페이스에서 다른 벡터가 된다.
   */
  embedQuery(text: string): Promise<number[]> {
    if (text.trim() === '') {
      // core는 빈 배열을 빈 배열로 돌려주지만 backend의 입력은 질의 한 건이고,
      // 빈 질의로 검색하는 것은 호출자의 버그다.
      // callExternal 밖에서 던진다 — 네트워크를 타지 않으므로 외부 호출 통로에
      // 들어갈 이유가 없다.
      return Promise.reject(
        new ExternalServiceError(
          'tei',
          'invalid-request',
          '빈 질의는 임베딩할 수 없습니다.',
        ),
      );
    }

    return callExternal(
      'tei',
      `embed(text=${text.length}자)`,
      classifyTeiFailure,
      async () => {
        const response = await fetch(`${this.baseUrl}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: [text],
            normalize: true,
            truncate: true,
          }),
          signal: AbortSignal.timeout(TEI_TIMEOUT_MS),
        });

        if (!response.ok) {
          // 상태 확인이 파싱보다 먼저다. 이 분기가 없으면 분류기에 도달할 오류가
          // 아예 만들어지지 않아 실패가 조용히 성공으로 흐른다 — 에러 JSON이
          // number[][]로 파싱에 성공하면 쓰레기 벡터가 Qdrant로 간다.
          // 본문은 로그용으로만 잘라 담고 판정에는 쓰지 않는다.
          const snippet = (await response.text().catch(() => '')).slice(
            0,
            BODY_SNIPPET_LIMIT,
          );
          throw new TeiHttpError(response.status, snippet);
        }

        const body = (await response.json()) as unknown;
        const first = Array.isArray(body) ? (body[0] as unknown) : undefined;
        if (!Array.isArray(first) || first.length === 0) {
          // 이미 kind를 정확히 아는 자리라 분류기를 우회한다.
          // callExternal의 규칙 3(이미 ExternalServiceError면 그대로 재던짐)이
          // 이 우회를 위해 있다.
          throw new ExternalServiceError(
            'tei',
            'empty-response',
            'TEI가 빈 임베딩을 반환했습니다.',
          );
        }

        // 길이를 검사하지 않는다. 검사하려면 기대 차원을 어딘가에 적어야 하고,
        // 그 순간 1024가 backend에 박힌다. 차원 판정은 Qdrant의 일이다.
        return first as number[];
      },
    );
  }
}
