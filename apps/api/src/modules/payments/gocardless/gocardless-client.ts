import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

export type GoCardlessEnvironment = 'sandbox' | 'live';

/** Versión de la API de GoCardless con la que hablamos (header obligatorio). */
const GOCARDLESS_API_VERSION = '2015-07-06';

function baseUrl(environment: GoCardlessEnvironment): string {
  return environment === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';
}

/**
 * Verifica la firma de un webhook de GoCardless: HMAC-SHA256 (hex) del cuerpo
 * crudo con el secret del endpoint, comparado en tiempo constante con el header
 * `Webhook-Signature`. Función pura (sin estado), reutilizable y testeable.
 */
export function verifyGoCardlessSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Billing request resuelto (lo mínimo que usamos del payload). */
export interface GoCardlessBillingRequest {
  id: string;
  status: string;
  mandateId: string | null;
  customerId: string | null;
  bankAccountId: string | null;
}

/** Mandato SEPA resuelto. */
export interface GoCardlessMandate {
  id: string;
  reference: string | null;
  status: string;
  bankAccountId: string | null;
}

/** Cuenta bancaria del cliente (para mostrar los últimos 4 del IBAN). */
export interface GoCardlessBankAccount {
  id: string;
  accountNumberEnding: string | null;
  bankName: string | null;
}

/**
 * Cliente HTTP fino para la API de GoCardless (sin SDK; `fetch`, como Redsys /
 * Holded / Anthropic). Incluye el flujo de mandato (Billing Request) para la
 * Fase 2. En `NODE_ENV=test` o con `GOCARDLESS_MODE=stub` opera en modo
 * **stub** determinista (sin red ni credenciales reales), como `AeatClient` /
 * `AiProvider`.
 */
@Injectable()
export class GoCardlessClient {
  private readonly logger = new Logger(GoCardlessClient.name);

  /** Modo stub: e2e/CI sin tocar la API real ni necesitar credenciales. */
  private get stub(): boolean {
    return process.env.GOCARDLESS_MODE === 'stub' || process.env.NODE_ENV === 'test';
  }

  /** Llamada genérica autenticada a la API de GoCardless. */
  async request<T = unknown>(args: {
    accessToken: string;
    environment: GoCardlessEnvironment;
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    idempotencyKey?: string;
  }): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${args.accessToken}`,
      'GoCardless-Version': GOCARDLESS_API_VERSION,
      Accept: 'application/json',
    };
    if (args.body !== undefined) headers['Content-Type'] = 'application/json';
    if (args.idempotencyKey) headers['Idempotency-Key'] = args.idempotencyKey;

    const res = await fetch(`${baseUrl(args.environment)}${args.path}`, {
      method: args.method,
      headers,
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    return { status: res.status, data };
  }

  /**
   * Prueba la conexión: lista los `creditors` de la cuenta. Si el token es
   * válido devuelve el nombre del primer acreedor; si no, el motivo.
   */
  async testConnection(
    accessToken: string,
    environment: GoCardlessEnvironment,
  ): Promise<{ ok: boolean; creditorName: string | null; error: string | null }> {
    try {
      const { status, data } = await this.request<{
        creditors?: { name: string }[];
        error?: { message?: string };
      }>({ accessToken, environment, method: 'GET', path: '/creditors?limit=1' });
      if (status === 200) {
        return { ok: true, creditorName: data.creditors?.[0]?.name ?? null, error: null };
      }
      return { ok: false, creditorName: null, error: data.error?.message ?? `HTTP ${status}` };
    } catch (err) {
      this.logger.warn(`GoCardless testConnection falló: ${(err as Error).message}`);
      return { ok: false, creditorName: null, error: (err as Error).message };
    }
  }

  // --- Billing Request Flow (mandato SEPA) --------------------------------

  /** Crea un billing request para un mandato SEPA CORE. Devuelve su id. */
  async createBillingRequest(
    accessToken: string,
    environment: GoCardlessEnvironment,
  ): Promise<{ id: string }> {
    if (this.stub) {
      return { id: `BR-stub-${stubSuffix()}` };
    }
    const { status, data } = await this.request<{
      billing_requests?: { id: string };
      error?: { message?: string };
    }>({
      accessToken,
      environment,
      method: 'POST',
      path: '/billing_requests',
      body: { billing_requests: { mandate_request: { scheme: 'sepa_core' } } },
      idempotencyKey: `br-${stubSuffix()}`,
    });
    const id = data.billing_requests?.id;
    if (status >= 300 || !id) {
      throw new Error(`createBillingRequest: ${data.error?.message ?? `HTTP ${status}`}`);
    }
    return { id };
  }

  /**
   * Crea el flow de autorización del billing request y devuelve la URL a la que
   * mandar al cliente para que autorice la domiciliación.
   */
  async createBillingRequestFlow(
    accessToken: string,
    environment: GoCardlessEnvironment,
    args: { billingRequestId: string; redirectUri: string; exitUri: string },
  ): Promise<{ authorisationUrl: string }> {
    if (this.stub) {
      return {
        authorisationUrl: `https://pay-sandbox.gocardless.com/flow/stub/${args.billingRequestId}`,
      };
    }
    const { status, data } = await this.request<{
      billing_request_flows?: { authorisation_url: string };
      error?: { message?: string };
    }>({
      accessToken,
      environment,
      method: 'POST',
      path: '/billing_request_flows',
      body: {
        billing_request_flows: {
          redirect_uri: args.redirectUri,
          exit_uri: args.exitUri,
          links: { billing_request: args.billingRequestId },
        },
      },
    });
    const url = data.billing_request_flows?.authorisation_url;
    if (status >= 300 || !url) {
      throw new Error(`createBillingRequestFlow: ${data.error?.message ?? `HTTP ${status}`}`);
    }
    return { authorisationUrl: url };
  }

  /** Lee el estado de un billing request (status + mandate/customer enlazados). */
  async getBillingRequest(
    accessToken: string,
    environment: GoCardlessEnvironment,
    billingRequestId: string,
  ): Promise<GoCardlessBillingRequest> {
    if (this.stub) {
      return {
        id: billingRequestId,
        status: 'fulfilled',
        mandateId: `MD-${billingRequestId}`,
        customerId: `CU-${billingRequestId}`,
        bankAccountId: `BA-${billingRequestId}`,
      };
    }
    const { status, data } = await this.request<{
      billing_requests?: {
        id: string;
        status: string;
        links?: {
          mandate_request_mandate?: string;
          customer?: string;
          customer_bank_account?: string;
        };
      };
      error?: { message?: string };
    }>({
      accessToken,
      environment,
      method: 'GET',
      path: `/billing_requests/${billingRequestId}`,
    });
    const br = data.billing_requests;
    if (status >= 300 || !br) {
      throw new Error(`getBillingRequest: ${data.error?.message ?? `HTTP ${status}`}`);
    }
    return {
      id: br.id,
      status: br.status,
      mandateId: br.links?.mandate_request_mandate ?? null,
      customerId: br.links?.customer ?? null,
      bankAccountId: br.links?.customer_bank_account ?? null,
    };
  }

  /** Lee un mandato (referencia + cuenta bancaria enlazada). */
  async getMandate(
    accessToken: string,
    environment: GoCardlessEnvironment,
    mandateId: string,
  ): Promise<GoCardlessMandate> {
    if (this.stub) {
      return {
        id: mandateId,
        reference: `STUB-${mandateId.slice(0, 16)}`,
        status: 'active',
        bankAccountId: `BA-${mandateId}`,
      };
    }
    const { status, data } = await this.request<{
      mandates?: {
        id: string;
        reference: string | null;
        status: string;
        links?: { customer_bank_account?: string };
      };
      error?: { message?: string };
    }>({ accessToken, environment, method: 'GET', path: `/mandates/${mandateId}` });
    const m = data.mandates;
    if (status >= 300 || !m) {
      throw new Error(`getMandate: ${data.error?.message ?? `HTTP ${status}`}`);
    }
    return {
      id: m.id,
      reference: m.reference,
      status: m.status,
      bankAccountId: m.links?.customer_bank_account ?? null,
    };
  }

  /** Lee la cuenta bancaria del cliente (para los últimos 4 del IBAN). */
  async getCustomerBankAccount(
    accessToken: string,
    environment: GoCardlessEnvironment,
    bankAccountId: string,
  ): Promise<GoCardlessBankAccount> {
    if (this.stub) {
      return { id: bankAccountId, accountNumberEnding: '0001', bankName: 'Stub Bank' };
    }
    const { status, data } = await this.request<{
      customer_bank_accounts?: { id: string; account_number_ending: string; bank_name: string };
      error?: { message?: string };
    }>({
      accessToken,
      environment,
      method: 'GET',
      path: `/customer_bank_accounts/${bankAccountId}`,
    });
    const ba = data.customer_bank_accounts;
    if (status >= 300 || !ba) {
      throw new Error(`getCustomerBankAccount: ${data.error?.message ?? `HTTP ${status}`}`);
    }
    return {
      id: ba.id,
      accountNumberEnding: ba.account_number_ending ?? null,
      bankName: ba.bank_name ?? null,
    };
  }
}

/** Sufijo pseudoaleatorio para ids/idempotency keys (no usado en prod-crypto). */
function stubSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
