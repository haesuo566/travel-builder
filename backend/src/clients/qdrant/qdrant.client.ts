import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';

import { callExternal } from '../call-external';
import { ExternalServiceError } from '../external-service.error';
import { classifyQdrantFailure } from './qdrant.errors';
import {
  buildQdrantFilter,
  parseTourContentPayload,
} from './tour-content-payload';
import type {
  TourContentPayload,
  TourSearchFilter,
} from './tour-content-payload';

export interface QdrantSearchOptions {
  limit?: number;
  filter?: TourSearchFilter;
}

export interface TourSearchHit {
  id: string | number;
  score: number;
  payload: TourContentPayload;
}

export interface QdrantCollectionInfo {
  vectorSize: number;
  distance: string;
}

/** SDK 기본값은 300000ms(5분)다. 사람이 기다리는 요청에 그대로 두지 않는다. */
const QDRANT_TIMEOUT_MS = 5000;

/** core/.env.example과 같은 기본값을 유지한다. */
const DEFAULT_COLLECTION = 'tour_contents';

/** core의 QdrantStore.search와 같은 기본값(core/src/clients/qdrant.ts:123). */
const DEFAULT_LIMIT = 10;

/**
 * 읽기 전용 Qdrant 클라이언트.
 * 이름에 Search가 들어간 것은 의도다 — 쓰기 메서드가 없다는 사실이 타입에 드러난다.
 * SDK의 QdrantClient와 이름이 겹치지 않게 하는 목적도 겸한다.
 */
@Injectable()
export class QdrantSearchClient {
  private readonly logger = new Logger(QdrantSearchClient.name);
  private readonly client: QdrantClient;
  private readonly collection: string;

  constructor(config: ConfigService) {
    // ConfigService.get의 두 번째 인자(기본값)를 쓰지 않는다. 그 인자는 값이
    // undefined일 때만 폴백해서 .env의 "QDRANT_COLLECTION="(값만 빈 줄)을
    // 유효한 값으로 받는다. core의 optionalEnv는 ''도 폴백하므로 같은 .env로
    // core는 돌고 backend만 죽는다. trim까지 하는 이유는 ||가 공백 문자열을
    // truthy로 보기 때문이다 — 이름이 ''이거나 '  '인 컬렉션은 존재하지 않는다.
    const apiKey = config.get<string>('QDRANT_API_KEY')?.trim();
    // 생성자는 네트워크를 만지지 않는다. core의 connect()가 하는 getCollections
    // 확인을 가져오지 않는 이유는 Qdrant가 사내망에 있어 외부망에서 부팅이
    // 매달리기 때문이다(chat.module.ts:7-9와 같은 판단).
    this.client = new QdrantClient({
      url: config.getOrThrow<string>('QDRANT_URL'),
      // 키가 없으면 apiKey 자체를 넘기지 않는다. undefined를 넘기면 SDK가
      // 빈 인증 헤더를 붙일 수 있어 "인증을 끈 것도 켠 것도 아닌" 상태가 된다.
      ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
      timeout: QDRANT_TIMEOUT_MS,
    });
    this.collection =
      config.get<string>('QDRANT_COLLECTION')?.trim() || DEFAULT_COLLECTION;
  }

  /**
   * 질의 벡터로 검색한다. 컬렉션 인자를 두지 않는 이유는, 인자로 열면 호출자가
   * 이름을 문자열로 짐작하게 되고 오타 판정이 호출부마다 달라지기 때문이다.
   */
  search(
    vector: number[],
    opts: QdrantSearchOptions = {},
  ): Promise<TourSearchHit[]> {
    const filter = buildQdrantFilter(opts.filter);

    // operation에 질의 벡터를 넣지 않는다 — 사용자 입력에서 온 값이다.
    return callExternal(
      'qdrant',
      `query(${this.collection})`,
      classifyQdrantFailure,
      async () => {
        const response = await this.client.query(this.collection, {
          query: vector,
          // ||가 아니라 ??다. 숫자 선택 값은 0이 유효하므로 ||로 다루면
          // "아무것도 가져오지 말라"는 요청이 조용히 10건이 된다.
          limit: opts.limit ?? DEFAULT_LIMIT,
          // payload가 결과의 본체다. 보내지 않으면 payload가 null로 오고
          // 아래 파서가 전 건을 버려 "정상 200 + 빈 배열"이 된다.
          with_payload: true,
          // with_vector는 요청하지 않는다 — hit당 float 수백~수천 개를 되받을 이유가 없다.
          ...(filter === undefined ? {} : { filter }),
        });

        const points = response.points;
        const hits: TourSearchHit[] = [];
        for (const point of points) {
          const payload = parseTourContentPayload(point.payload);
          if (payload === null) continue;
          hits.push({ id: point.id, score: point.score, payload });
        }

        if (points.length > 0 && hits.length === 0) {
          // hit 0건과 화면에서 구분되지 않는다. 여기서 끊지 않으면 with_payload
          // 누락이나 core의 payload 키 변경이 "검색 결과 없음"으로 위장한다.
          // 이 오류의 유일한 독자는 로그라서 판단 재료를 함께 싣는다 —
          // 키 목록이 있으면 with_payload 누락인지 키 변경인지 바로 갈린다.
          const firstKeys = Object.keys(points[0].payload ?? {});
          throw new ExternalServiceError(
            'qdrant',
            'upstream',
            `payload를 읽을 수 있는 hit이 없습니다. 버린 건수 ${points.length}, ` +
              `첫 hit의 키: ${firstKeys.length === 0 ? '없음' : firstKeys.join(', ')}`,
          );
        }

        if (hits.length < points.length) {
          this.logger.warn(
            `payload 파싱에 실패한 hit ${points.length - hits.length}건을 버렸습니다.`,
          );
        }
        return hits;
      },
    );
  }

  /** 진단용. 컬렉션 차원·distance가 core가 만든 것과 맞는지 확인한다. */
  getCollectionInfo(): Promise<QdrantCollectionInfo> {
    return callExternal(
      'qdrant',
      `getCollection(${this.collection})`,
      classifyQdrantFailure,
      async () => {
        const info = await this.client.getCollection(this.collection);
        const vectors = info.config?.params?.vectors;
        const isRecord = typeof vectors === 'object' && vectors !== null;
        const size = isRecord
          ? Number((vectors as { size?: unknown }).size)
          : Number.NaN;
        const distance = isRecord
          ? (vectors as { distance?: unknown }).distance
          : undefined;

        if (
          !Number.isFinite(size) ||
          size <= 0 ||
          typeof distance !== 'string'
        ) {
          // 차원과 distance를 버리고 넘어가면 잘못된 컬렉션 위에서 검색이 조용히 돈다.
          throw new ExternalServiceError(
            'qdrant',
            'upstream',
            `컬렉션 ${this.collection}의 벡터 설정을 읽을 수 없습니다.`,
          );
        }
        return { vectorSize: size, distance };
      },
    );
  }
}
