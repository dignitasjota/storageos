import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';

import { Public } from '../../common/decorators/public.decorator';

/**
 * Endpoint de health. Se monta como `VERSION_NEUTRAL` para que tanto
 * `/health` como `/v1/health` respondan sin redirect. La infraestructura
 * (Nginx Proxy Manager, Uptime Kuma) apunta a `/health` y no queremos
 * que un redirect 308 se le indigeste a un health checker simple.
 */
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
