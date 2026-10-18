import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, tap } from 'rxjs';

import { ADMIN_AUDIT_KEY, type AdminAuditMeta } from './admin-audit.decorator';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { AuthenticatedSuperAdmin } from './current-super-admin.decorator';
import type { Request } from 'express';

/** Escribe la auditoría de los endpoints marcados con `@AdminAudit`. */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: SuperAdminAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AdminAuditMeta | undefined>(ADMIN_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta || context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedSuperAdmin }>();
    return next.handle().pipe(
      tap(() => {
        const params = (req.params ?? {}) as Record<string, string>;
        const body = req.body as Record<string, unknown> | undefined;
        const fields =
          body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
        const isTenantRoute = /\/admin\/tenants\/[^/]+/.test(req.originalUrl ?? '');
        void this.audit.record({
          superAdminId: req.user?.purpose === 'superadmin' ? req.user.sub : null,
          action: meta.action,
          targetType: meta.targetType ?? null,
          targetId: params.id ?? params.slug ?? params.name ?? null,
          targetTenantId: isTenantRoute ? (params.id ?? null) : null,
          changes: fields.length > 0 ? { fields } : null,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
        });
      }),
    );
  }
}
