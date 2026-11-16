import { Controller, Get } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { TenantSalesRepDto } from '@storageos/shared';

/** «Tu comercial» en el panel del cliente (cualquier usuario del negocio). */
@Controller('settings/sales-rep')
export class TenantSalesRepController {
  constructor(private readonly admin: PrismaAdminService) {}

  @Get()
  async get(@CurrentUser() user: AuthenticatedUser): Promise<{ rep: TenantSalesRepDto | null }> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
        salesRep: {
          select: {
            fullName: true,
            email: true,
            phone: true,
            whatsapp: true,
            bookingUrl: true,
            isActive: true,
            role: true,
          },
        },
      },
    });
    const rep = tenant?.salesRep;
    if (!rep?.isActive || rep.role !== 'sales') return { rep: null };
    return {
      rep: {
        fullName: rep.fullName,
        email: rep.email,
        phone: rep.phone,
        whatsapp: rep.whatsapp,
        bookingUrl: rep.bookingUrl,
      },
    };
  }
}
