import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

/**
 * Datos asociados a una request a traves de AsyncLocalStorage. El middleware
 * de autenticacion los rellena al inicio de la request (Fase 1B.8). Antes
 * de eso, services como AuthService pueden establecer el contexto manualmente
 * dentro de un `run(...)`.
 */
export interface RequestContext {
  tenantId?: string | undefined;
  userId?: string | undefined;
  sessionId?: string | undefined;
  requestId?: string | undefined;
}

/**
 * Wrapper sobre `AsyncLocalStorage` para tener un unico inyectable que
 * cualquier modulo pueda usar para leer/escribir el contexto de la request.
 */
@Injectable()
export class AsyncContextService {
  private readonly als = new AsyncLocalStorage<RequestContext>();

  /** Ejecuta `fn` dentro de un nuevo contexto. */
  run<T>(ctx: RequestContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  /** Devuelve el store actual o `undefined` si estamos fuera de una request. */
  getStore(): RequestContext | undefined {
    return this.als.getStore();
  }

  getTenantId(): string | undefined {
    return this.als.getStore()?.tenantId;
  }

  getUserId(): string | undefined {
    return this.als.getStore()?.userId;
  }

  getSessionId(): string | undefined {
    return this.als.getStore()?.sessionId;
  }

  /**
   * Modifica el store actual fusionando los campos pasados. Solo valido
   * dentro de un `run(...)`; fuera, es no-op.
   */
  patch(partial: Partial<RequestContext>): void {
    const store = this.als.getStore();
    if (!store) return;
    Object.assign(store, partial);
  }
}
