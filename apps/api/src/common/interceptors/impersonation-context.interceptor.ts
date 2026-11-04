import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';

import { impersonationContext } from '../async-context/impersonation-context';

import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';

/** Deja la sesión de impersonación en el contexto de la request. */
@Injectable()
export class ImpersonationContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const impersonationId = req.user?.impersonation?.id;
    if (!impersonationId) return next.handle();
    return new Observable((subscriber) =>
      impersonationContext.run({ impersonationId }, () => next.handle().subscribe(subscriber)),
    );
  }
}
