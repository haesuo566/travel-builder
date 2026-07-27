import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import {
  ExternalFailureKind,
  ExternalServiceError,
} from './external-service.error';

/**
 * kind → HTTP 상태. 어떤 kind도 4xx가 되지 않는다.
 * 우리 설정·코드의 문제는 500, 외부 서비스 사정은 502/503/504다.
 */
const STATUS_BY_KIND: Record<ExternalFailureKind, number> = {
  auth: 500,
  'not-found': 500,
  'dimension-mismatch': 500,
  quota: 503,
  unavailable: 503,
  timeout: 504,
  upstream: 502,
  'invalid-request': 502,
  'empty-response': 502,
};

/**
 * 응답 본문 문구. 예외 인스턴스의 message를 쓰지 않는 이유는
 * 업스트림 원문과 자격증명이 그 안에 있을 수 있기 때문이다.
 * 상세는 서버 로그에만 남는다.
 */
const MESSAGE_BY_KIND: Record<ExternalFailureKind, string> = {
  auth: '외부 서비스 인증에 실패했습니다.',
  'not-found': '외부 서비스에서 대상을 찾을 수 없습니다.',
  'dimension-mismatch': '질의 벡터 차원이 컬렉션과 일치하지 않습니다.',
  quota: '외부 서비스 사용량이 초과되었습니다. 잠시 후 다시 시도하세요.',
  unavailable: '외부 서비스에 연결할 수 없습니다.',
  timeout: '외부 서비스가 시간 안에 응답하지 않았습니다.',
  upstream: '외부 서비스에서 오류가 발생했습니다.',
  'invalid-request': '외부 서비스가 요청을 거절했습니다.',
  'empty-response': '외부 서비스가 빈 응답을 반환했습니다.',
};

/** 고정값이다. Gemini 오류 상세의 retryDelay를 읽어 반영하는 것은 범위 밖이다. */
const RETRY_AFTER_SECONDS = 60;

@Catch(ExternalServiceError)
export class ExternalServiceFilter implements ExceptionFilter {
  catch(exception: ExternalServiceError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const statusCode = STATUS_BY_KIND[exception.kind];

    if (exception.kind === 'quota') {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }

    response.status(statusCode).json({
      statusCode,
      error: exception.kind,
      message: MESSAGE_BY_KIND[exception.kind],
    });
  }
}
