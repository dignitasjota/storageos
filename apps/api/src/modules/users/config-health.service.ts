import { Injectable } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { ConfigHealthItemDto } from '@storageos/shared';

const DAY = 86_400_000;

/**
 * Lo que conviene revisar de la configuración: el certificado de la AEAT que
 * caduca, el dominio o el correo sin verificar, la serie por defecto, los
 * datos fiscales y cómo te pagan.
 */
@Injectable()
export class ConfigHealthService {
  constructor(private readonly prisma: PrismaService) {}

  async check(tenantId: string): Promise<ConfigHealthItemDto[]> {
    const d = await this.prisma.withTenant(async (tx) => {
      const [tenant, cert, emailDomain, defaultSeries, gateways] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: {
            taxId: true,
            billingLegalName: true,
            billingAddress: true,
            transferIban: true,
            invoicingMode: true,
            customDomain: true,
            customDomainVerifiedAt: true,
            customDomainReadyAt: true,
          },
        }),
        tx.tenantAeatCredential.findFirst({
          where: { ownerId: null, revokedAt: null },
          orderBy: { uploadedAt: 'desc' },
          select: { certValidTo: true },
        }),
        tx.tenantEmailDomain.findFirst({ select: { domain: true, status: true } }),
        tx.invoiceSeries.count({ where: { isDefault: true, isActive: true } }),
        Promise.all([
          tx.redsysSettings.count({ where: { enabled: true } }),
          tx.goCardlessSettings.count({ where: { enabled: true } }),
          tx.sepaSettings.count({ where: { enabled: true } }),
          tx.tenantStripeAccount.count({ where: { chargesEnabled: true } }),
        ]),
      ]);
      return { tenant, cert, emailDomain, defaultSeries, gateways };
    }, tenantId);

    const out: ConfigHealthItemDto[] = [];
    const t = d.tenant;

    if (d.defaultSeries === 0) {
      out.push({
        key: 'no_default_series',
        level: 'error',
        title: 'No hay serie de facturación por defecto',
        detail: 'Sin ella no se emiten las facturas de las reservas ni las mensuales.',
        href: '/settings/billing',
      });
    }
    if (!t.taxId || !t.billingLegalName || !t.billingAddress) {
      out.push({
        key: 'company_data',
        level: 'error',
        title: 'Faltan los datos fiscales de tu empresa',
        detail: 'Razón social, NIF y domicilio salen en cada factura que emites.',
        href: '/settings/company',
      });
    }
    if (t.invoicingMode === 'app') {
      if (!d.cert) {
        out.push({
          key: 'aeat_missing',
          level: 'warning',
          title: 'No has subido el certificado de la AEAT',
          detail: 'Lo necesitas para enviar tus facturas a Veri*Factu.',
          href: '/settings/billing/verifactu',
        });
      } else {
        const days = Math.ceil((d.cert.certValidTo.getTime() - Date.now()) / DAY);
        if (days <= 30) {
          out.push({
            key: 'aeat_expiring',
            level: days <= 0 ? 'error' : 'warning',
            title:
              days <= 0
                ? 'El certificado de la AEAT ha caducado'
                : `El certificado de la AEAT caduca en ${days} ${days === 1 ? 'día' : 'días'}`,
            detail: 'Renuévalo con la FNMT y súbelo de nuevo para seguir enviando facturas.',
            href: '/settings/billing/verifactu',
          });
        }
      }
    }
    const gateways = d.gateways.reduce((a, b) => a + b, 0);
    if (gateways === 0 && !t.transferIban) {
      out.push({
        key: 'no_payment_method',
        level: 'warning',
        title: 'No has indicado cómo te pagan',
        detail: 'Activa la tarjeta, la domiciliación o pon tu IBAN para transferencias.',
        href: '/settings/payments',
      });
    }
    if (t.customDomain && !t.customDomainVerifiedAt) {
      out.push({
        key: 'domain_pending',
        level: 'warning',
        title: `Tu dominio ${t.customDomain} aún no está activo`,
        detail: t.customDomainReadyAt
          ? 'Ya nos avisaste: lo estamos comprobando.'
          : 'Configura el DNS y avísanos desde «Dominio propio».',
        href: '/settings/domain',
      });
    }
    if (d.emailDomain && d.emailDomain.status !== 'verified') {
      out.push({
        key: 'email_domain_pending',
        level: 'warning',
        title: `Los registros DNS de ${d.emailDomain.domain} no están verificados`,
        detail: 'Hasta entonces, tus correos salen con el remitente de TrasterOS.',
        href: '/settings/email',
      });
    }
    return out;
  }
}
