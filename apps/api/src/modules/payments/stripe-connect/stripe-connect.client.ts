import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import StripeSDK from 'stripe';

import type { Env } from '../../../config/env.schema';

type Stripe = InstanceType<typeof StripeSDK>;

export interface ConnectAccountState {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
}

/**
 * Cliente de Stripe Connect con la clave de la plataforma (cuentas Express).
 * En test (o con `STRIPE_CONNECT_MODE=stub`) simula Stripe: las cuentas
 * `acct_stub_…` quedan activas al consultarlas, salvo las que empiezan por
 * `acct_stub_pending` (siguen pidiendo datos).
 */
@Injectable()
export class StripeConnectClient {
  private readonly stripe: Stripe;
  private readonly configured: boolean;
  readonly stub: boolean;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('STRIPE_SECRET_KEY', { infer: true });
    this.configured = Boolean(apiKey) && apiKey !== 'sk_test_dummy';
    this.stub = process.env.NODE_ENV === 'test' || process.env.STRIPE_CONNECT_MODE === 'stub';
    this.stripe = new StripeSDK(apiKey, { typescript: true, telemetry: false });
  }

  /** Se puede conectar una cuenta (hay clave real de Stripe o modo simulado). */
  isAvailable(): boolean {
    return this.stub || this.configured;
  }

  /** SDK de Stripe para operar contra la cuenta conectada (`stripeAccount`). */
  get sdk(): Stripe {
    return this.stripe;
  }

  async createAccount(args: {
    tenantId: string;
    email: string | null;
    businessName: string;
  }): Promise<string> {
    if (this.stub) return `acct_stub_${randomBytes(6).toString('hex')}`;
    const account = await this.stripe.accounts.create({
      type: 'express',
      country: 'ES',
      ...(args.email ? { email: args.email } : {}),
      business_profile: { name: args.businessName },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { tenantId: args.tenantId },
    });
    return account.id;
  }

  async createOnboardingLink(args: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<string> {
    if (this.stub) return `${args.returnUrl}${args.returnUrl.includes('?') ? '&' : '?'}stub=1`;
    const link = await this.stripe.accountLinks.create({
      account: args.accountId,
      refresh_url: args.refreshUrl,
      return_url: args.returnUrl,
      type: 'account_onboarding',
    });
    return link.url;
  }

  async retrieveAccount(accountId: string): Promise<ConnectAccountState> {
    if (this.stub) {
      const pending = accountId.startsWith('acct_stub_pending');
      return {
        chargesEnabled: !pending,
        payoutsEnabled: !pending,
        detailsSubmitted: !pending,
        requirementsDue: pending ? ['external_account'] : [],
        disabledReason: pending ? 'requirements.past_due' : null,
      };
    }
    const account = await this.stripe.accounts.retrieve(accountId);
    return accountState(account);
  }

  /** Enlace de un solo uso al panel Express de Stripe del tenant. */
  async createDashboardLink(accountId: string): Promise<string> {
    if (this.stub) return 'https://connect.stripe.com/express/stub';
    const link = await this.stripe.accounts.createLoginLink(accountId);
    return link.url;
  }
}

/** Estado de una cuenta de Stripe (también lo usa el webhook `account.updated`). */
export function accountState(account: {
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  requirements?: {
    currently_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
}): ConnectAccountState {
  return {
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    requirementsDue: account.requirements?.currently_due ?? [],
    disabledReason: account.requirements?.disabled_reason ?? null,
  };
}
