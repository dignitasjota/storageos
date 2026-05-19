import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ZodError } from 'zod';

import type { Request, Response } from 'express';

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function statusText(status: number): string {
  return STATUS_TEXT[status] ?? HttpStatus[status] ?? 'Error';
}

interface NormalizedError {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
  /** Codigo semantico opcional (p.ej. `email_not_verified`, `account_disabled`). */
  code?: string;
}

/**
 * Filtro global: convierte cualquier excepcion en una respuesta JSON con la
 * envoltura definida en docs/API.md.
 *
 *   {
 *     "statusCode": 400,
 *     "error": "Bad Request",
 *     "message": "Validation failed",
 *     "details": [...],
 *     "code": "email_not_verified"   // opcional
 *   }
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const normalized = this.normalize(exception);

    if (normalized.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${normalized.statusCode}: ${normalized.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(normalized.statusCode).json({
      statusCode: normalized.statusCode,
      error: normalized.error,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
      ...(normalized.code ? { code: normalized.code } : {}),
    });
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof ZodError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: 'Validacion fallida',
        details: exception.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return {
          statusCode: status,
          error: statusText(status),
          message: body,
        };
      }
      const obj = body as {
        message?: string | string[];
        error?: string;
        details?: unknown;
        errors?: unknown;
        code?: string;
      };
      // nestjs-zod expone los issues en `errors`; los normalizamos a `details`.
      const details = obj.details ?? obj.errors;
      return {
        statusCode: status,
        error: obj.error ?? statusText(status),
        message: Array.isArray(obj.message) ? obj.message.join('; ') : (obj.message ?? 'Error'),
        ...(details ? { details } : {}),
        ...(obj.code ? { code: obj.code } : {}),
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: statusText(HttpStatus.INTERNAL_SERVER_ERROR),
      message: 'Error interno del servidor',
    };
  }
}
