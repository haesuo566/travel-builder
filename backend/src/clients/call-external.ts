import { Logger } from '@nestjs/common';

import {
  ExternalFailureKind,
  ExternalService,
  ExternalServiceError,
} from './external-service.error';

/** 서비스별 판정. 자기가 모르는 오류에는 null을 반환해 공통 판정에 넘긴다. */
export type FailureClassifier = (error: unknown) => ExternalFailureKind | null;

const logger = new Logger('ExternalService');

/** cause 체인 탐색 깊이. 순환 참조에 갇히지 않도록 상한을 둔다. */
const MAX_CAUSE_DEPTH = 5;

/**
 * cause 체인을 펼친다.
 * Node의 fetch는 ECONNREFUSED를 "TypeError: fetch failed"의 cause에 숨기므로
 * 최상위 오류만 보면 네트워크 단절을 upstream으로 오분류한다.
 */
function unwrapCauses(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** 중단·네트워크 단절처럼 모든 SDK가 같은 모양으로 내는 실패만 판정한다. */
export function classifyCommonFailure(
  error: unknown,
): ExternalFailureKind | null {
  for (const item of unwrapCauses(error)) {
    const record = item as { name?: unknown; code?: unknown };
    if (record.name === 'AbortError' || record.name === 'TimeoutError') {
      return 'timeout';
    }
    if (record.code === 'ECONNREFUSED' || record.code === 'ENOTFOUND') {
      return 'unavailable';
    }
  }
  return null;
}

/**
 * 로그에 남기기 전에 자격증명처럼 보이는 문자열을 가린다.
 * 원인 메시지를 통째로 버리면 무엇이 실패했는지가 사라지고,
 * 그대로 남기면 URL 쿼리에 실린 API 키가 로그에 박힌다.
 */
function maskSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{35}/g, 'AIza***')
    .replace(/([?&](?:key|api[_-]?key|access_token)=)[^&\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1***');
}

/** 원인 메시지. API 키와 프롬프트 전문은 여기에 담기지 않는다. */
function causeMessage(error: unknown): string {
  if (error instanceof Error) return maskSecrets(error.message);
  return maskSecrets(typeof error === 'string' ? error : String(error));
}

/**
 * 외부 SDK·fetch 호출의 유일한 통로.
 * 클라이언트 메서드가 SDK를 직접 호출하는 것을 금지한다 —
 * 진입 경로가 둘이 되면 분류도 로그도 한쪽에서만 동작한다.
 *
 * operation에는 프롬프트·질의 전문 대신 길이만 넣는다.
 */
export async function callExternal<T>(
  service: ExternalService,
  operation: string,
  classify: FailureClassifier,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // 안쪽에서 이미 정확히 분류한 kind를 바깥에서 upstream으로 덮지 않는다.
    const failure =
      error instanceof ExternalServiceError
        ? error
        : new ExternalServiceError(
            service,
            classify(error) ?? classifyCommonFailure(error) ?? 'upstream',
            `${service} ${operation} 실패`,
            { cause: error },
          );

    const detail = `${failure.service} ${operation} 실패 (${failure.kind}): ${causeMessage(
      failure.cause ?? failure,
    )}`;
    if (failure.kind === 'quota') {
      logger.warn(detail);
    } else {
      logger.error(detail);
    }
    throw failure;
  }
}
