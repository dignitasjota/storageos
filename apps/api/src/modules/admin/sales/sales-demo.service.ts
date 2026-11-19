import { randomBytes } from 'node:crypto';

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';
import {
  type ImpersonationTokenDto,
  type PlatformSalesSettingsDto,
  DEMO_PORTAL_CUSTOMER_TAG,
  type SalesDemoPortalLinkDto,
  type SalesDemoStatusDto,
} from '@storageos/shared';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { AuthService } from '../../auth/auth.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PortalService } from '../../portal/portal.service';
import { AdminTenantResetService } from '../admin-tenant-reset.service';
import { ImpersonationService } from '../impersonation.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAssignmentService } from './sales-assignment.service';
import { seedDemoData } from './sales-demo-data';
import { SalesNotifyService } from './sales-notify.service';

/** Tamaños de la demo: nombre, medidas, precio y color. */
const SIZES = [
  { name: 'Taquilla', w: 1, d: 1, h: 2, price: 29, deposit: 30, color: '#60A5FA', count: 10 },
  {
    name: 'Pequeño (3 m²)',
    w: 1.5,
    d: 2,
    h: 2.5,
    price: 49,
    deposit: 50,
    color: '#34D399',
    count: 14,
  },
  {
    name: 'Mediano (6 m²)',
    w: 2,
    d: 3,
    h: 2.5,
    price: 85,
    deposit: 85,
    color: '#FBBF24',
    count: 12,
  },
  {
    name: 'Grande (10 m²)',
    w: 2.5,
    d: 4,
    h: 2.5,
    price: 135,
    deposit: 135,
    color: '#F87171',
    count: 8,
  },
];

const FACILITIES = [
  {
    name: 'Centro',
    address: 'Calle de Colón, 12',
    city: 'Valencia',
    postalCode: '46004',
    prefix: 'C',
  },
  {
    name: 'Norte',
    address: 'Avenida de Burjassot, 88',
    city: 'Valencia',
    postalCode: '46025',
    prefix: 'N',
  },
];

/** Proporción de trasteros alquilados en la demo. */
const OCCUPANCY = 0.72;

/**
 * Cuenta de demostración para los comerciales: un negocio de trasteros con
 * locales, tamaños, inquilinos y contratos de ejemplo. Cada noche se vacían los
 * datos de prueba y se vuelven a crear, así siempre está igual de completa
 * aunque se toque durante una demo. No cuenta en las cifras (cuenta exenta).
 */
@Injectable()
export class SalesDemoService {
  private readonly logger = new Logger(SalesDemoService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly auth: AuthService,
    private readonly reset: AdminTenantResetService,
    private readonly impersonation: ImpersonationService,
    private readonly assignment: SalesAssignmentService,
    private readonly audit: SuperAdminAuditService,
    private readonly notify: SalesNotifyService,
    private readonly portal: PortalService,
    private readonly crypto: CryptoService,
  ) {}

  private async demoTenantId(): Promise<string | null> {
    const s = await this.assignment.settings();
    if (!s.demoTenantId) return null;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: s.demoTenantId },
      select: { deletedAt: true, status: true },
    });
    return tenant && !tenant.deletedAt && tenant.status !== 'cancelled' ? s.demoTenantId : null;
  }

  async status(): Promise<SalesDemoStatusDto> {
    const id = await this.demoTenantId();
    if (!id) return { available: false, tenantName: null, tenantSlug: null, resetAt: null };
    const [tenant, s] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id }, select: { name: true, slug: true } }),
      this.assignment.settings(),
    ]);
    return {
      available: true,
      tenantName: tenant?.name ?? null,
      tenantSlug: tenant?.slug ?? null,
      resetAt: s.demoResetAt?.toISOString() ?? null,
    };
  }

  /** Crea la cuenta de demostración (una sola) con sus datos de ejemplo. */
  async create(byId: string): Promise<PlatformSalesSettingsDto> {
    if (await this.demoTenantId()) {
      throw new ConflictException({
        code: 'demo_exists',
        message: 'Ya hay una cuenta de demostración',
      });
    }
    const me = await this.admin.superAdmin.findUnique({
      where: { id: byId },
      select: { email: true, fullName: true },
    });
    if (!me)
      throw new NotFoundException({
        code: 'super_admin_not_found',
        message: 'Administrador no encontrado',
      });
    const { tenant } = await this.auth.createTenantAccount({
      tenantName: 'Trasteros Demo',
      email: me.email,
      fullName: me.fullName,
      passwordHash: await argonHash(randomBytes(32).toString('hex')),
      planSlug: 'pro',
      trialDays: 0,
      emailVerified: true,
    });
    await this.admin.tenant.update({
      where: { id: tenant.id },
      data: {
        billingExempt: true,
        tags: ['demo'],
        billingLegalName: 'Trasteros Demo SL',
        taxId: 'B00000000',
        billingAddress: 'Calle de Colón, 12',
        billingCity: 'Valencia',
        billingPostalCode: '46004',
      },
    });
    const s = await this.assignment.settings();
    await this.admin.platformSalesSettings.update({
      where: { id: s.id },
      data: { demoTenantId: tenant.id, updatedById: byId },
    });
    await this.seedStructure(tenant.id);
    await this.seedOperational(tenant.id);
    await this.admin.platformSalesSettings.update({
      where: { id: s.id },
      data: { demoResetAt: new Date() },
    });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.demo_created',
      targetType: 'tenant',
      targetId: tenant.id,
      targetTenantId: tenant.id,
    });
    return this.assignment.settingsDto();
  }

  /** Vacía los datos de prueba de la demo y los vuelve a crear. */
  async resetNow(byId: string | null): Promise<PlatformSalesSettingsDto> {
    const id = await this.demoTenantId();
    if (!id)
      throw new NotFoundException({
        code: 'demo_not_found',
        message: 'No hay cuenta de demostración',
      });
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id },
      select: { slug: true },
    });
    const auditor =
      byId ??
      (
        await this.admin.superAdmin.findFirst({
          where: { role: 'superadmin', isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id;
    if (!auditor) return this.assignment.settingsDto();
    // Un reinicio a la vez (el de la noche y uno a mano, o un doble clic).
    const claimed = await this.claimReset();
    if (!claimed) {
      throw new ConflictException({
        code: 'demo_resetting',
        message: 'La demostración se está poniendo a cero: espera un momento',
      });
    }
    try {
      await this.runReset(id, tenant.slug, auditor);
    } finally {
      await this.releaseReset();
    }
    return this.assignment.settingsDto();
  }

  private async runReset(id: string, slug: string, auditor: string): Promise<void> {
    await this.reset.reset({
      tenantId: id,
      superAdminId: auditor,
      input: {
        confirmSlug: slug,
        reason: 'Reinicio de la cuenta de demostración',
        exported: true,
      },
      quiet: true,
    });
    await this.seedStructure(id);
    await this.seedOperational(id);
    const s = await this.assignment.settings();
    await this.admin.platformSalesSettings.update({
      where: { id: s.id },
      data: { demoResetAt: new Date() },
    });
  }

  /** Reserva el reinicio (caduca a los 15 minutos por si un proceso se cae). */
  private async claimReset(): Promise<boolean> {
    const s = await this.assignment.settings();
    const { count } = await this.admin.platformSalesSettings.updateMany({
      where: {
        id: s.id,
        OR: [
          { demoResettingAt: null },
          { demoResettingAt: { lt: new Date(Date.now() - 15 * 60_000) } },
        ],
      },
      data: { demoResettingAt: new Date() },
    });
    return count > 0;
  }

  private async releaseReset(): Promise<void> {
    await this.admin.platformSalesSettings.updateMany({ data: { demoResettingAt: null } });
  }

  /** Reinicio de cada noche (si la dirección lo tiene activado). */
  async nightlyReset(): Promise<boolean> {
    const s = await this.assignment.settings();
    if (!s.demoResetEnabled || !(await this.demoTenantId())) return false;
    try {
      await this.resetNow(null);
      return true;
    } catch (err) {
      this.logger.error(`[sales] reinicio de la demo: ${String(err)}`);
      // Que la dirección se entere (una vez al día) en vez de solo en el log.
      await this.notify.team({
        type: 'sales.demo_reset_failed',
        title: 'La cuenta de demostración no se ha podido poner a cero',
        body: err instanceof Error ? err.message.slice(0, 300) : null,
        link: '/admin/sales-team',
      });
      return false;
    }
  }

  /** Abre la demo para enseñarla (con cambios: se reinicia cada noche). */
  async open(
    superAdminId: string,
    meta: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<ImpersonationTokenDto> {
    const id = await this.demoTenantId();
    if (!id)
      throw new NotFoundException({
        code: 'demo_not_found',
        message: 'Aún no hay cuenta de demostración',
      });
    return this.impersonation.impersonate({
      superAdminId,
      tenantId: id,
      reason: 'Demostración comercial',
      readOnly: false,
      skipOwnerNotice: true,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  /**
   * Enlace de un solo uso al área de clientes de la inquilina de la demo: el
   * comercial enseña lo que ven los inquilinos y lo que hacen ahí (un mensaje,
   * pedir otro trastero…) le llega al negocio de la demo.
   */
  async openPortal(superAdminId: string): Promise<SalesDemoPortalLinkDto> {
    const id = await this.demoTenantId();
    if (!id)
      throw new NotFoundException({
        code: 'demo_not_found',
        message: 'Aún no hay cuenta de demostración',
      });
    const customer = await this.admin.customer.findFirst({
      where: { tenantId: id, deletedAt: null, tags: { has: DEMO_PORTAL_CUSTOMER_TAG } },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!customer)
      throw new ConflictException({
        code: 'demo_portal_missing',
        message: 'La demo aún no tiene inquilino de ejemplo: ponla a cero y vuelve a probar',
      });
    const { url } = await this.portal.issueStaffMagicLink(id, customer.id);
    await this.audit.record({
      superAdminId,
      action: 'admin.sales.demo_portal_opened',
      targetType: 'tenant',
      targetId: id,
      targetTenantId: id,
    });
    return {
      url,
      customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
    };
  }

  // ------------------------------------------------------------ datos de ejemplo

  /**
   * Tipos, locales, plantas y trasteros de ejemplo. Se puede repetir: deja todo
   * como al crearla (lo que el comercial haya borrado o cambiado vuelve).
   */
  private async seedStructure(tenantId: string): Promise<void> {
    const types = [];
    for (const size of SIZES) {
      const data = {
        defaultPriceMonthly: size.price,
        defaultDepositAmount: size.deposit,
        color: size.color,
        isActive: true,
      };
      types.push(
        await this.admin.unitType.upsert({
          where: { tenantId_name: { tenantId, name: size.name } },
          create: { tenantId, name: size.name, ...data },
          update: data,
        }),
      );
    }
    for (const f of FACILITIES) {
      const data = {
        name: f.name,
        address: f.address,
        city: f.city,
        postalCode: f.postalCode,
        contactPhone: '960 000 000',
        isActive: true,
        deletedAt: null,
        openingHours: {
          mon: { open: '07:00', close: '22:00' },
          tue: { open: '07:00', close: '22:00' },
          wed: { open: '07:00', close: '22:00' },
          thu: { open: '07:00', close: '22:00' },
          fri: { open: '07:00', close: '22:00' },
          sat: { open: '09:00', close: '14:00' },
          sun: null,
        },
      };
      const facility = await this.admin.facility.upsert({
        where: { tenantId_publicSlug: { tenantId, publicSlug: f.name.toLowerCase() } },
        create: { tenantId, publicSlug: f.name.toLowerCase(), ...data },
        update: data,
      });
      const floor =
        (await this.admin.facilityFloor.findFirst({
          where: { facilityId: facility.id },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        })) ??
        (await this.admin.facilityFloor.create({
          data: { facilityId: facility.id, name: 'Planta baja', isDefault: true },
        }));
      let n = 1;
      for (const [i, size] of SIZES.entries()) {
        for (let k = 0; k < size.count; k++) {
          const code = `${f.prefix}-${String(n).padStart(3, '0')}`;
          const data = {
            floorId: floor.id,
            unitTypeId: types[i]!.id,
            widthM: size.w,
            depthM: size.d,
            heightM: size.h,
            basePriceMonthly: size.price,
            status: 'available' as const,
          };
          await this.admin.unit.upsert({
            where: { facilityId_code: { facilityId: facility.id, code } },
            create: { tenantId, facilityId: facility.id, code, ...data },
            update: data,
          });
          n += 1;
        }
      }
    }
  }

  /**
   * Todo lo que se vacía y se vuelve a crear cada noche: inquilinos, contratos,
   * facturas y cobros, contactos, tareas, accesos… (`sales-demo-data.ts`).
   */
  private async seedOperational(tenantId: string): Promise<void> {
    await seedDemoData({
      db: this.admin,
      tenantId,
      logger: this.logger,
      occupancy: OCCUPANCY,
      encryptSecret: (plain) => this.crypto.encryptString(plain, tenantId),
    });
    this.logger.log(`[sales] demo ${tenantId}: datos de ejemplo creados`);
  }
}
