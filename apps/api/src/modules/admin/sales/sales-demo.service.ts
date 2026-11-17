import { randomBytes, randomInt } from 'node:crypto';

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';
import {
  type ImpersonationTokenDto,
  type PlatformSalesSettingsDto,
  type SalesDemoStatusDto,
} from '@storageos/shared';

import { AuthService } from '../../auth/auth.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { AdminTenantResetService } from '../admin-tenant-reset.service';
import { ImpersonationService } from '../impersonation.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAssignmentService } from './sales-assignment.service';
import { DAY } from './sales-common';

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const FIRST_NAMES = [
  'Lucía',
  'Hugo',
  'Martina',
  'Mateo',
  'Sofía',
  'Leo',
  'Julia',
  'Daniel',
  'Paula',
  'Pablo',
  'Valeria',
  'Álvaro',
  'Carmen',
  'Adrián',
  'Elena',
  'Javier',
  'Sara',
  'Diego',
  'Noa',
  'Marcos',
  'Irene',
  'Sergio',
  'Claudia',
  'Raúl',
  'Alba',
  'Iván',
  'Marta',
  'Óscar',
  'Nerea',
  'Rubén',
];
const LAST_NAMES = [
  'García',
  'Martínez',
  'López',
  'Sánchez',
  'Pérez',
  'Gómez',
  'Martín',
  'Jiménez',
  'Ruiz',
  'Hernández',
  'Díaz',
  'Moreno',
  'Muñoz',
  'Álvarez',
  'Romero',
  'Alonso',
  'Gutiérrez',
  'Navarro',
  'Torres',
  'Domínguez',
  'Vázquez',
  'Ramos',
  'Gil',
  'Serrano',
  'Blanco',
  'Molina',
  'Castro',
];
const COMPANIES = [
  'Reformas Levante SL',
  'Mudanzas Rápidas SL',
  'Electro Hogar Valencia',
  'Archivo Legal Abogados',
  'Distribuciones Turia SL',
  'Floristería Las Flores',
];

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

function pick<T>(list: readonly T[]): T {
  return list[randomInt(list.length)]!;
}

function dni(): string {
  const n = randomInt(10_000_000, 99_999_999);
  return `${n}${DNI_LETTERS[n % 23]}`;
}

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
    if (!id) return { available: false, tenantName: null, resetAt: null };
    const [tenant, s] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id }, select: { name: true } }),
      this.assignment.settings(),
    ]);
    return {
      available: true,
      tenantName: tenant?.name ?? null,
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
    await this.reset.reset({
      tenantId: id,
      superAdminId: auditor,
      input: {
        confirmSlug: tenant.slug,
        reason: 'Reinicio de la cuenta de demostración',
        exported: true,
      },
      quiet: true,
    });
    await this.seedOperational(id);
    const s = await this.assignment.settings();
    await this.admin.platformSalesSettings.update({
      where: { id: s.id },
      data: { demoResetAt: new Date() },
    });
    return this.assignment.settingsDto();
  }

  /** Reinicio de cada noche (si la dirección lo tiene activado). */
  async nightlyReset(): Promise<boolean> {
    const s = await this.assignment.settings();
    if (!s.demoResetEnabled || !(await this.demoTenantId())) return false;
    await this.resetNow(null);
    return true;
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

  // ------------------------------------------------------------ datos de ejemplo

  private async seedStructure(tenantId: string): Promise<void> {
    const types = [];
    for (const size of SIZES) {
      types.push(
        await this.admin.unitType.create({
          data: {
            tenantId,
            name: size.name,
            defaultPriceMonthly: size.price,
            defaultDepositAmount: size.deposit,
            color: size.color,
          },
        }),
      );
    }
    for (const f of FACILITIES) {
      const facility = await this.admin.facility.create({
        data: {
          tenantId,
          name: f.name,
          publicSlug: f.name.toLowerCase(),
          address: f.address,
          city: f.city,
          postalCode: f.postalCode,
          contactPhone: '960 000 000',
          openingHours: {
            mon: { open: '07:00', close: '22:00' },
            tue: { open: '07:00', close: '22:00' },
            wed: { open: '07:00', close: '22:00' },
            thu: { open: '07:00', close: '22:00' },
            fri: { open: '07:00', close: '22:00' },
            sat: { open: '09:00', close: '14:00' },
            sun: null,
          },
        },
      });
      const floor = await this.admin.facilityFloor.create({
        data: { facilityId: facility.id, name: 'Planta baja', isDefault: true },
      });
      let n = 1;
      for (const [i, size] of SIZES.entries()) {
        for (let k = 0; k < size.count; k++) {
          await this.admin.unit.create({
            data: {
              tenantId,
              facilityId: facility.id,
              floorId: floor.id,
              unitTypeId: types[i]!.id,
              code: `${f.prefix}-${String(n).padStart(3, '0')}`,
              widthM: size.w,
              depthM: size.d,
              heightM: size.h,
              basePriceMonthly: size.price,
            },
          });
          n += 1;
        }
      }
    }
  }

  /** Inquilinos y contratos (lo que se vacía y se vuelve a crear cada noche). */
  private async seedOperational(tenantId: string): Promise<void> {
    const units = await this.admin.unit.findMany({
      where: { tenantId },
      orderBy: { code: 'asc' },
      select: { id: true, basePriceMonthly: true, unitTypeId: true },
    });
    const types = await this.admin.unitType.findMany({
      where: { tenantId },
      select: { id: true, defaultDepositAmount: true },
    });
    const depositOf = new Map(types.map((t) => [t.id, Number(t.defaultDepositAmount)]));
    const year = new Date().getFullYear();
    let contractNo = 1;
    const now = Date.now();
    for (const unit of units) {
      if (Math.random() > OCCUPANCY) continue;
      const business = Math.random() < 0.15;
      const first = pick(FIRST_NAMES);
      const last = `${pick(LAST_NAMES)} ${pick(LAST_NAMES)}`;
      const customer = await this.admin.customer.create({
        data: {
          tenantId,
          customerType: business ? 'business' : 'individual',
          firstName: business ? null : first,
          lastName: business ? null : last,
          companyName: business ? pick(COMPANIES) : null,
          documentType: business ? 'cif' : 'dni',
          documentNumber: business ? `B${randomInt(10_000_000, 99_999_999)}` : dni(),
          phone: `6${randomInt(10_000_000, 99_999_999)}`,
          city: 'Valencia',
          country: 'ES',
        },
      });
      const start = new Date(now - randomInt(20, 700) * DAY);
      await this.admin.contract.create({
        data: {
          tenantId,
          customerId: customer.id,
          unitId: unit.id,
          contractNumber: `CT-${year}-${String(contractNo).padStart(5, '0')}`,
          status: 'active',
          startDate: new Date(
            Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
          ),
          signedAt: start,
          priceMonthly: unit.basePriceMonthly,
          depositAmount: depositOf.get(unit.unitTypeId) ?? 0,
          depositStatus: (depositOf.get(unit.unitTypeId) ?? 0) > 0 ? 'held' : 'none',
        },
      });
      await this.admin.unit.update({ where: { id: unit.id }, data: { status: 'occupied' } });
      contractNo += 1;
    }
    this.logger.log(`[sales] demo ${tenantId}: ${contractNo - 1} contratos de ejemplo`);
  }
}
