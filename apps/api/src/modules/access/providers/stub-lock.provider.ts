import { Injectable, Logger } from '@nestjs/common';

import { LockProvider, type OpenLockArgs, type OpenLockResult } from './lock-provider';

/**
 * Stub que solo loggea. Util en dev/test donde no hay hardware. La
 * persistencia del intento sigue siendo responsabilidad del verify service.
 */
@Injectable()
export class StubLockProvider extends LockProvider {
  private readonly logger = new Logger(StubLockProvider.name);

  get name(): string {
    return 'stub';
  }

  async open(args: OpenLockArgs): Promise<OpenLockResult> {
    this.logger.warn(`[lock_stub] tenant=${args.tenantId} device=${args.deviceId} open dispatched`);
    return { dispatched: true, message: 'stub' };
  }

  async start(): Promise<void> {
    // sin estado
  }

  async stop(): Promise<void> {
    // sin estado
  }
}
