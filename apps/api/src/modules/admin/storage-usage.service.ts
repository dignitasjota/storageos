import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

/**
 * Mide el espacio que ocupa cada tenant en MinIO y lo guarda en
 * `tenant_storage_usage` (una fila por tenant). Lo dispara un cron diario y el
 * botón «Medir ahora» del panel.
 */
@Injectable()
export class StorageUsageService {
  private readonly logger = new Logger(StorageUsageService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
  ) {}

  async measure(): Promise<{ tenants: number; bytes: number }> {
    const usage = await this.files.usageByTenant();
    const tenants = await this.admin.tenant.findMany({ select: { id: true } });
    const known = new Set(tenants.map((t) => t.id));
    const measuredAt = new Date();
    let total = 0;
    for (const t of tenants) {
      const u = usage.get(t.id) ?? { bytes: 0, objects: 0, byBucket: {} };
      total += u.bytes;
      await this.admin.tenantStorageUsage.upsert({
        where: { tenantId: t.id },
        create: {
          tenantId: t.id,
          bytes: BigInt(u.bytes),
          objects: u.objects,
          byBucket: u.byBucket,
          measuredAt,
        },
        update: { bytes: BigInt(u.bytes), objects: u.objects, byBucket: u.byBucket, measuredAt },
      });
    }
    const orphan = [...usage.keys()].filter((id) => !known.has(id)).length;
    if (orphan > 0) {
      this.logger.warn(`[storage] ${orphan} prefijo(s) de tenants que ya no existen`);
    }
    return { tenants: tenants.length, bytes: total };
  }
}
