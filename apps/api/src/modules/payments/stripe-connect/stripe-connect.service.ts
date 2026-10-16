import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../auth/audit.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { PlatformPaymentSettingsService } from './platform-payment-settings.service';
import { type ConnectAccountState, StripeConnectClient } from './stripe-connect.client';

import type { Env } from '../../../config/env.schema';
import type { CardProvider, StripeConnectLinkDto, StripeConnectStatusDto } from '@storageos/shared';

export type StripeCardContext =
  | { mode: 'connect'; accountId: string; applicationFeePct: number }
  | { mode: 'platform' };

/** Comisión de la plataforma en céntimos (redondeo al céntimo). */
export function applicationFeeCents(amountCents: number, pct: number): number {
  if (pct <= 0) return 0;
  return Math.round((amountCents * pct) / 100);
}

/** Pantalla del panel a la que vuelve el tenant desde el registro de Stripe. */
const SETTINGS_PATH = '/settings/payments';

/**
 * Cuenta de Stripe (Connect Express) del tenant para cobrar con tarjeta a sus
 * inquilinos, y elección del proveedor de tarjeta (Redsys o Stripe).
 */
@Injectable()
export class StripeConnectService {
  private readonly logger = new Logger(StripeConnectService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly client: StripeConnectClient,
    private readonly platformSettings: PlatformPaymentSettingsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getStatus(tenantId: string): Promise<StripeConnectStatusDto> {
    const [tenant, account, feePct, redsysEnabled] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { cardProvider: true } }),
      this.admin.tenantStripeAccount.findUnique({ where: { tenantId } }),
      this.platformSettings.applicationFeePct(),
      this.redsysEnabled(tenantId),
    ]);
    const cardProvider = parseProvider(tenant?.cardProvider ?? null);
    return {
      platformAvailable: this.client.isAvailable(),
      connected: Boolean(account),
      accountId: account?.stripeAccountId ?? null,
      chargesEnabled: account?.chargesEnabled ?? false,
      payoutsEnabled: account?.payoutsEnabled ?? false,
      detailsSubmitted: account?.detailsSubmitted ?? false,
      requirementsDue: account?.requirementsDue ?? [],
      disabledReason: account?.disabledReason ?? null,
      applicationFeePct: feePct,
      cardProvider,
      effectiveCardProvider: effectiveProvider(
        cardProvider,
        account?.chargesEnabled ?? false,
        redsysEnabled,
      ),
      redsysEnabled,
    };
  }

  /**
   * Proveedor con el que se cobra la tarjeta ahora mismo: el elegido si está
   * operativo; si no se eligió, Redsys si está activo.
   */
  async effectiveCardProvider(tenantId: string): Promise<CardProvider | null> {
    const s = await this.getStatus(tenantId);
    return s.effectiveCardProvider;
  }

  /**
   * Con qué cuenta de Stripe se cobra la tarjeta de los inquilinos de este
   * tenant: la suya (Connect) si la eligió y puede cobrar; la de la plataforma
   * solo con `TENANT_CARD_PAYMENTS_ENABLED` (instalaciones antiguas); si no, no
   * se cobra con Stripe.
   */
  async cardContext(tenantId: string): Promise<StripeCardContext | null> {
    const [tenant, account] = await Promise.all([
      this.admin.tenant.findUnique({ where: { id: tenantId }, select: { cardProvider: true } }),
      this.admin.tenantStripeAccount.findUnique({ where: { tenantId } }),
    ]);
    if (tenant?.cardProvider === 'stripe' && account?.chargesEnabled && this.client.isAvailable()) {
      return {
        mode: 'connect',
        accountId: account.stripeAccountId,
        applicationFeePct: await this.platformSettings.applicationFeePct(),
      };
    }
    if (this.config.get('TENANT_CARD_PAYMENTS_ENABLED', { infer: true }) === true) {
      return { mode: 'platform' };
    }
    return null;
  }

  /** Cuenta conectada lista para cobrar (o null). */
  async chargeableAccount(tenantId: string): Promise<string | null> {
    const account = await this.admin.tenantStripeAccount.findUnique({ where: { tenantId } });
    return account?.chargesEnabled ? account.stripeAccountId : null;
  }

  /** Crea la cuenta (si no existe) y devuelve el enlace al registro de Stripe. */
  async startOnboarding(tenantId: string, userId: string): Promise<StripeConnectLinkDto> {
    this.assertAvailable();
    let account = await this.admin.tenantStripeAccount.findUnique({ where: { tenantId } });
    if (!account) {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, billingEmail: true, billingLegalName: true },
      });
      if (!tenant) throw new NotFoundException({ code: 'tenant_not_found', message: 'No existe' });
      const accountId = await this.call(() =>
        this.client.createAccount({
          tenantId,
          email: tenant.billingEmail,
          businessName: tenant.billingLegalName || tenant.name,
        }),
      );
      try {
        account = await this.admin.tenantStripeAccount.create({
          data: { tenantId, stripeAccountId: accountId },
        });
      } catch (err) {
        // Doble clic: otra petición ya guardó la cuenta; se usa esa.
        const existing = await this.admin.tenantStripeAccount.findUnique({ where: { tenantId } });
        if (!existing) throw err;
        this.logger.warn(`Stripe Connect: cuenta ${accountId} creada de más para ${tenantId}`);
        account = existing;
      }
      await this.audit.write({
        tenantId,
        userId,
        action: 'stripe_connect.account_created',
        entityType: 'TenantStripeAccount',
        entityId: account.id,
        changes: { stripeAccountId: accountId },
        ipAddress: null,
        userAgent: null,
      });
    }
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const url = await this.call(() =>
      this.client.createOnboardingLink({
        accountId: account.stripeAccountId,
        refreshUrl: `${base}${SETTINGS_PATH}?stripe=refresh`,
        returnUrl: `${base}${SETTINGS_PATH}?stripe=return`,
      }),
    );
    return { url };
  }

  /** Vuelve a leer el estado de la cuenta en Stripe. */
  async refresh(tenantId: string): Promise<StripeConnectStatusDto> {
    const account = await this.admin.tenantStripeAccount.findUnique({ where: { tenantId } });
    if (!account) {
      throw new NotFoundException({
        code: 'stripe_not_connected',
        message: 'No hay ninguna cuenta de Stripe conectada',
      });
    }
    this.assertAvailable();
    const state = await this.call(() => this.client.retrieveAccount(account.stripeAccountId));
    await this.saveState(account.stripeAccountId, state);
    return this.getStatus(tenantId);
  }

  /** Guarda el estado de una cuenta (refresco manual o webhook `account.updated`). */
  async saveState(stripeAccountId: string, state: ConnectAccountState): Promise<void> {
    await this.admin.tenantStripeAccount.updateMany({
      where: { stripeAccountId },
      data: { ...state, lastSyncedAt: new Date() },
    });
  }

  /**
   * El tenant quitó el acceso de la plataforma a su cuenta desde Stripe: se
   * olvida la cuenta y, si la tarjeta iba por Stripe, vuelve a Redsys o a nada.
   */
  async forgetAccount(stripeAccountId: string): Promise<void> {
    const account = await this.admin.tenantStripeAccount.findUnique({
      where: { stripeAccountId },
    });
    if (!account) return;
    await this.admin.$transaction([
      this.admin.tenantStripeAccount.delete({ where: { id: account.id } }),
      this.admin.tenant.updateMany({
        where: { id: account.tenantId, cardProvider: 'stripe' },
        data: { cardProvider: null },
      }),
      this.retireCards(account.tenantId, stripeAccountId),
    ]);
    await this.audit.write({
      tenantId: account.tenantId,
      userId: null,
      action: 'stripe_connect.account_deauthorized',
      entityType: 'TenantStripeAccount',
      entityId: account.id,
      changes: { stripeAccountId },
      ipAddress: null,
      userAgent: null,
    });
  }

  async dashboardLink(tenantId: string): Promise<StripeConnectLinkDto> {
    const account = await this.admin.tenantStripeAccount.findUnique({ where: { tenantId } });
    if (!account?.detailsSubmitted) {
      throw new BadRequestException({
        code: 'stripe_onboarding_incomplete',
        message: 'Termina primero el registro en Stripe',
      });
    }
    this.assertAvailable();
    const url = await this.call(() => this.client.createDashboardLink(account.stripeAccountId));
    return { url };
  }

  /**
   * Desconecta la cuenta de la app (la cuenta sigue existiendo en Stripe). Si
   * la tarjeta se cobraba con Stripe, vuelve a Redsys (o a nada).
   */
  async disconnect(tenantId: string, userId: string): Promise<StripeConnectStatusDto> {
    const account = await this.admin.tenantStripeAccount.findUnique({ where: { tenantId } });
    if (account) {
      await this.admin.$transaction([
        this.admin.tenantStripeAccount.delete({ where: { id: account.id } }),
        this.admin.tenant.updateMany({
          where: { id: tenantId, cardProvider: 'stripe' },
          data: { cardProvider: null },
        }),
        // Las tarjetas guardadas en esa cuenta ya no se pueden cobrar.
        this.retireCards(tenantId, account.stripeAccountId),
      ]);
      await this.audit.write({
        tenantId,
        userId,
        action: 'stripe_connect.account_disconnected',
        entityType: 'TenantStripeAccount',
        entityId: account.id,
        changes: { stripeAccountId: account.stripeAccountId },
        ipAddress: null,
        userAgent: null,
      });
    }
    return this.getStatus(tenantId);
  }

  /** Elige con qué se cobra la tarjeta a los inquilinos. */
  async setCardProvider(
    tenantId: string,
    userId: string,
    provider: CardProvider | null,
  ): Promise<StripeConnectStatusDto> {
    if (provider === 'stripe') {
      const account = await this.admin.tenantStripeAccount.findUnique({ where: { tenantId } });
      if (!account?.chargesEnabled) {
        throw new BadRequestException({
          code: 'stripe_not_ready',
          message: 'Conecta tu cuenta de Stripe y termina el registro antes de elegirla',
        });
      }
    }
    if (provider === 'redsys' && !(await this.redsysEnabled(tenantId))) {
      throw new BadRequestException({
        code: 'redsys_not_enabled',
        message: 'Activa Redsys antes de elegirlo',
      });
    }
    await this.admin.tenant.update({ where: { id: tenantId }, data: { cardProvider: provider } });
    await this.audit.write({
      tenantId,
      userId,
      action: 'tenant.card_provider_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { cardProvider: provider },
      ipAddress: null,
      userAgent: null,
    });
    return this.getStatus(tenantId);
  }

  /** Da de baja las tarjetas de los inquilinos guardadas en una cuenta de Stripe. */
  private retireCards(tenantId: string, stripeAccountId: string) {
    return this.admin.paymentMethod.updateMany({
      where: { tenantId, gateway: 'stripe', stripeAccountId, deletedAt: null },
      data: { deletedAt: new Date(), isDefault: false },
    });
  }

  /**
   * Redsys activo (se lee la tabla directamente: el módulo de Redsys depende
   * de facturación, que a su vez usa este servicio para cobrar).
   */
  private async redsysEnabled(tenantId: string): Promise<boolean> {
    const row = await this.admin.redsysSettings.findUnique({
      where: { tenantId },
      select: { enabled: true },
    });
    return Boolean(row?.enabled);
  }

  private assertAvailable(): void {
    if (!this.client.isAvailable()) {
      throw new ServiceUnavailableException({
        code: 'stripe_not_configured',
        message: 'Los cobros con Stripe aún no están disponibles en la plataforma',
      });
    }
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`Stripe Connect: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException({
        code: 'stripe_connect_error',
        message: 'Stripe no ha podido completar la operación. Inténtalo de nuevo.',
      });
    }
  }
}

function parseProvider(v: string | null): CardProvider | null {
  return v === 'redsys' || v === 'stripe' ? v : null;
}

export function effectiveProvider(
  chosen: CardProvider | null,
  stripeReady: boolean,
  redsysEnabled: boolean,
): CardProvider | null {
  if (chosen === 'stripe') return stripeReady ? 'stripe' : redsysEnabled ? 'redsys' : null;
  if (chosen === 'redsys') return redsysEnabled ? 'redsys' : null;
  return redsysEnabled ? 'redsys' : null;
}
