import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminTenantConfigDto,
  AdminTenantConfigItemDto,
  AdminTenantConfigSectionDto,
} from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

const on = (label: string, value = 'Activado'): AdminTenantConfigItemDto => ({
  label,
  value,
  tone: 'ok',
});
const off = (label: string, value = 'Desactivado'): AdminTenantConfigItemDto => ({
  label,
  value,
  tone: 'off',
});
const warn = (label: string, value: string): AdminTenantConfigItemDto => ({
  label,
  value,
  tone: 'warn',
});
const flag = (label: string, enabled: boolean, detail?: string): AdminTenantConfigItemDto =>
  enabled ? on(label, detail ?? 'Activado') : off(label);
const eur = (n: unknown) =>
  `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const date = (d: Date) => d.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });

/**
 * Configuración de un tenant vista por el super admin (solo lectura): lo que
 * soporte necesita para entender cómo trabaja un cliente sin entrar en su panel.
 * Nunca devuelve secretos (claves, IBAN completos, tokens).
 */
@Injectable()
export class AdminTenantConfigService {
  constructor(private readonly admin: PrismaAdminService) {}

  async getConfig(tenantId: string, now = new Date()): Promise<AdminTenantConfigDto> {
    const tenant = await this.admin.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
    if (!tenant) throw new NotFoundException({ code: 'tenant_not_found' });

    const [
      series,
      cert,
      holded,
      redsys,
      gocardless,
      sepa,
      emailDomain,
      blogPosts,
      devices,
      curfewFacilities,
      apiKeys,
      webhooks,
      users2fa,
      managers,
    ] = await Promise.all([
      this.admin.invoiceSeries.count({ where: { tenantId, isActive: true } }),
      this.admin.tenantAeatCredential.findFirst({
        where: { tenantId, ownerId: null, revokedAt: null },
        orderBy: { certValidTo: 'desc' },
        select: { certValidTo: true, environment: true },
      }),
      this.admin.holdedSettings.findUnique({
        where: { tenantId },
        select: { enabled: true, invoiceSeriesId: true, lastError: true },
      }),
      this.admin.redsysSettings.findUnique({
        where: { tenantId },
        select: { enabled: true, bizumEnabled: true, environment: true },
      }),
      this.admin.goCardlessSettings.findUnique({
        where: { tenantId },
        select: { enabled: true, environment: true },
      }),
      this.admin.sepaSettings.findUnique({
        where: { tenantId },
        select: { enabled: true, prenoticeDays: true },
      }),
      this.admin.tenantEmailDomain.findFirst({
        where: { tenantId },
        select: { domain: true, status: true, verifiedAt: true },
      }),
      this.admin.blogPost.count({ where: { tenantId, isPublished: true } }),
      this.admin.accessDevice.findMany({
        where: { tenantId, isActive: true },
        select: { lastSeenAt: true },
      }),
      this.admin.facility.count({
        where: { tenantId, deletedAt: null, accessCurfewEnabled: true },
      }),
      this.admin.apiKey.count({ where: { tenantId, revokedAt: null } }),
      this.admin.webhook.count({ where: { tenantId, isActive: true, revokedAt: null } }),
      this.admin.user.count({ where: { tenantId, isActive: true, twoFactorEnabled: true } }),
      this.admin.user.count({
        where: { tenantId, isActive: true, role: { in: ['owner', 'manager'] } },
      }),
    ]);

    const sections: AdminTenantConfigSectionDto[] = [];

    // --- Facturación ---
    const billing: AdminTenantConfigItemDto[] = [];
    billing.push(
      on(
        'Dónde se emiten las facturas',
        tenant.invoicingMode === 'holded' ? 'En Holded' : 'En la app (Veri*Factu)',
      ),
    );
    if (tenant.invoicingModePending) {
      billing.push(
        warn(
          'Cambio programado',
          `A ${tenant.invoicingModePending === 'holded' ? 'Holded' : 'la app'}${
            tenant.invoicingModePendingFrom ? ` el ${date(tenant.invoicingModePendingFrom)}` : ''
          }`,
        ),
      );
    }
    billing.push(
      series > 0
        ? on('Series de facturación', `${series} activa(s)`)
        : warn('Series de facturación', 'Ninguna'),
    );
    if (tenant.invoicingMode === 'app') {
      if (!cert) {
        billing.push(warn('Certificado de la AEAT', 'Sin subir'));
      } else {
        const days = Math.ceil((cert.certValidTo.getTime() - now.getTime()) / DAY_MS);
        const text = `Hasta el ${date(cert.certValidTo)} (${cert.environment === 'production' ? 'producción' : 'pruebas'})`;
        billing.push(
          days <= 30 ? warn('Certificado de la AEAT', text) : on('Certificado de la AEAT', text),
        );
      }
    }
    billing.push(flag('Emisión automática de las mensuales', tenant.autoIssueRecurring));
    billing.push(
      flag(
        'Recargo por mora',
        tenant.lateFeeEnabled,
        `${tenant.lateFeeType === 'percentage' ? `${Number(tenant.lateFeeValue)} %` : eur(tenant.lateFeeValue)} a los ${tenant.lateFeeGraceDays} días`,
      ),
    );
    if (!holded) billing.push(off('Holded', 'Sin conectar'));
    else if (!holded.enabled) billing.push(off('Holded', 'Conectado pero desactivado'));
    else if (holded.lastError)
      billing.push(warn('Holded', `Último error: ${holded.lastError.slice(0, 120)}`));
    else if (tenant.invoicingMode === 'app' && !holded.invoiceSeriesId)
      billing.push(warn('Holded', 'Activo sin serie elegida (no se envía nada)'));
    else billing.push(on('Holded', 'Activo'));
    sections.push({ key: 'billing', title: 'Facturación', items: billing });

    // --- Cobros ---
    const payments: AdminTenantConfigItemDto[] = [];
    payments.push(flag('Cobro automático al emitir', tenant.autoChargeOnIssue));
    payments.push(
      flag(
        'Reintentos de cobro',
        tenant.autoChargeRetryEnabled,
        `${tenant.autoChargeRetryMax} intentos cada ${tenant.autoChargeRetryIntervalDays} días`,
      ),
    );
    payments.push(
      redsys?.enabled
        ? on(
            'Redsys (tarjeta)',
            `${redsys.environment === 'live' ? 'Real' : 'Pruebas'}${redsys.bizumEnabled ? ' · con Bizum' : ''}`,
          )
        : off('Redsys (tarjeta)'),
    );
    payments.push(
      gocardless?.enabled
        ? on('GoCardless (domiciliación)', gocardless.environment === 'live' ? 'Real' : 'Pruebas')
        : off('GoCardless (domiciliación)'),
    );
    payments.push(
      sepa?.enabled
        ? on('Remesas SEPA', `Preaviso de ${sepa.prenoticeDays} días`)
        : off('Remesas SEPA'),
    );
    payments.push(
      tenant.transferIban
        ? on('IBAN para transferencias', `…${tenant.transferIban.slice(-4)}`)
        : off('IBAN para transferencias', 'Sin indicar'),
    );
    if (!redsys?.enabled && !gocardless?.enabled && !sepa?.enabled && !tenant.transferIban) {
      payments.push(warn('Forma de cobro', 'No tiene ninguna configurada'));
    }
    sections.push({ key: 'payments', title: 'Cobros', items: payments });

    // --- Web y correo ---
    const web: AdminTenantConfigItemDto[] = [];
    web.push(on('Plantilla de la web', tenant.webTemplate));
    if (tenant.customDomain) {
      web.push(
        tenant.customDomainVerifiedAt
          ? on('Dominio propio', tenant.customDomain)
          : warn('Dominio propio', `${tenant.customDomain} (pendiente de activar)`),
      );
    } else {
      web.push(off('Dominio propio', 'No'));
    }
    if (tenant.externalSiteUrl) web.push(on('Web externa', tenant.externalSiteUrl));
    web.push(
      blogPosts > 0
        ? on('Blog', `${blogPosts} entrada(s) publicadas`)
        : off('Blog', 'Sin entradas'),
    );
    web.push(
      tenant.portalLogoUrl || tenant.portalBrandColor
        ? on('Marca del portal', tenant.portalBrandColor ?? 'Logo')
        : off('Marca del portal', 'Por defecto'),
    );
    web.push(
      flag('Google Analytics', Boolean(tenant.googleAnalyticsId), tenant.googleAnalyticsId ?? ''),
    );
    if (!emailDomain) web.push(off('Dominio de correo propio', 'No'));
    else if (emailDomain.status === 'verified')
      web.push(on('Dominio de correo propio', emailDomain.domain));
    else
      web.push(warn('Dominio de correo propio', `${emailDomain.domain} (${emailDomain.status})`));
    web.push(flag('Informe mensual por correo', tenant.monthlyDigestEnabled));
    sections.push({ key: 'web', title: 'Web y correo', items: web });

    // --- Accesos ---
    const offline = devices.filter(
      (d) => d.lastSeenAt && d.lastSeenAt.getTime() < now.getTime() - 60 * 60 * 1000,
    ).length;
    const access: AdminTenantConfigItemDto[] = [];
    access.push(
      devices.length === 0
        ? off('Dispositivos de acceso', 'Ninguno')
        : offline > 0
          ? warn('Dispositivos de acceso', `${devices.length} (${offline} sin conexión)`)
          : on('Dispositivos de acceso', `${devices.length}`),
    );
    access.push(
      curfewFacilities > 0
        ? on('Toque de queda', `${curfewFacilities} local(es)`)
        : off('Toque de queda', 'Ninguno'),
    );
    access.push(flag('Pase nocturno', tenant.nightPassEnabled, eur(tenant.nightPassPrice)));
    access.push(on('Accesos adicionales por inquilino', `${tenant.extraAccessLimit}`));
    sections.push({ key: 'access', title: 'Accesos', items: access });

    // --- Clientes y crecimiento ---
    const growth: AdminTenantConfigItemDto[] = [];
    growth.push(flag('Expedientes de impago', tenant.collectionsEnabled));
    growth.push(
      flag('Win-back de bajas', tenant.winbackEnabled, `A los ${tenant.winbackDelayDays} días`),
    );
    growth.push(
      flag(
        'Petición de valoraciones',
        tenant.reviewsAutoRequest,
        `A los ${tenant.reviewRequestDelayDays} días`,
      ),
    );
    growth.push(flag('Programa de referidos', tenant.referralEnabled));
    growth.push(
      flag(
        'Tope de subidas de precio',
        Number(tenant.rentIncreaseMaxAnnualPct) > 0,
        `${Number(tenant.rentIncreaseMaxAnnualPct)} % al año`,
      ),
    );
    growth.push(on('Ocupación objetivo (precios)', `${tenant.pricingTargetOccupancy} %`));
    sections.push({ key: 'growth', title: 'Clientes y crecimiento', items: growth });

    // --- Seguridad e integraciones ---
    const security: AdminTenantConfigItemDto[] = [];
    security.push(
      tenant.requireTwoFactorForManagers
        ? on('2FA obligatorio para propietarios y gestores')
        : managers > 0 && users2fa === 0
          ? warn('2FA obligatorio para propietarios y gestores', 'No (nadie lo usa)')
          : off('2FA obligatorio para propietarios y gestores', 'No'),
    );
    security.push(on('Usuarios con 2FA', `${users2fa}`));
    security.push(
      apiKeys > 0 ? on('Claves de API', `${apiKeys}`) : off('Claves de API', 'Ninguna'),
    );
    security.push(webhooks > 0 ? on('Webhooks', `${webhooks}`) : off('Webhooks', 'Ninguno'));
    sections.push({ key: 'security', title: 'Seguridad e integraciones', items: security });

    return { sections };
  }
}
