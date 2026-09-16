import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, type ErrorResponseBody } from '../errors/app-error';
import { REQUEST_ID_HEADER } from '../http/request-id';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const isProduction = process.env.NODE_ENV === 'production';
    const requestIdHeader = request.headers[REQUEST_ID_HEADER];
    const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;

    const { status, body } = this.normalize(exception, isProduction);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({
        requestId,
        method: request.method,
        path: request.originalUrl ?? request.url,
        statusCode: status,
        errName: exception instanceof Error ? exception.name : 'UnknownError',
        errMessage: exception instanceof Error && !isProduction ? exception.message : undefined,
        stack: exception instanceof Error && !isProduction ? exception.stack : undefined,
      });
    }

    response.status(status).json(body);
  }

  private normalize(
    exception: unknown,
    isProduction: boolean,
  ): { status: number; body: ErrorResponseBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        body: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const details = this.httpExceptionDetails(payload);
      const message =
        typeof payload === 'string' ? payload : (this.readMessage(payload) ?? exception.message);

      return {
        status,
        body: {
          code: this.codeFromStatus(status),
          message,
          details,
        },
      };
    }

    const prismaMapped = this.mapPrismaError(exception);
    if (prismaMapped) {
      return prismaMapped;
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'INTERNAL_ERROR',
        message: isProduction ? 'Internal server error' : this.unknownMessage(exception),
        details: {},
      },
    };
  }

  private mapPrismaError(exception: unknown): { status: number; body: ErrorResponseBody } | null {
    if (typeof exception !== 'object' || exception === null || !('code' in exception)) {
      return null;
    }

    const code = (exception as { code?: string }).code;
    if (code === 'P2002') {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          code: 'CONFLICT',
          message: 'Конфликт уникального значения',
          details: {},
        },
      };
    }

    if (code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        body: {
          code: 'NOT_FOUND',
          message: 'Запись не найдена',
          details: {},
        },
      };
    }

    return null;
  }

  private httpExceptionDetails(payload: string | object): Record<string, unknown> {
    if (typeof payload !== 'object' || payload === null) {
      return {};
    }

    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.message)) {
      return { issues: record.message };
    }

    return {};
  }

  private readMessage(payload: object): string | undefined {
    if ('message' in payload && typeof payload.message === 'string') {
      return payload.message;
    }

    return undefined;
  }

  private unknownMessage(exception: unknown): string {
    return exception instanceof Error ? exception.message : 'Internal server error';
  }

  private codeFromStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'VALIDATION_ERROR';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
    }
  }
}
