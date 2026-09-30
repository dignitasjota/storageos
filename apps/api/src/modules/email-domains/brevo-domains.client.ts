import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BREVO_API_BASE } from '../email/providers/brevo.provider';

import type { Env } from '../../config/env.schema';
import type { EmailDnsRecordDto } from '@storageos/shared';

export interface BrevoDomainState {
  authenticated: boolean;
  records: EmailDnsRecordDto[];
}

export class BrevoDomainsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Dominios remitentes en la cuenta Brevo de la PLATAFORMA (API v3
 * `/senders/domains`). Cada tenant con dominio propio de correo lo da de alta
 * aquí; Brevo devuelve los registros DNS (código de verificación, DKIM, DMARC)
 * que el tenant pone en su proveedor, y `authenticate` los comprueba.
 *
 * En `NODE_ENV=test` (o `BREVO_DOMAINS_MODE=stub`) responde de forma
 * determinista sin red: un dominio que empieza por `fail` nunca se autentica.
 */
@Injectable()
export class BrevoDomainsClient {
  private readonly logger = new Logger(BrevoDomainsClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get stub(): boolean {
    return process.env.NODE_ENV === 'test' || process.env.BREVO_DOMAINS_MODE === 'stub';
  }

  /** ¿Se pueden gestionar dominios? (clave de Brevo configurada, o stub). */
  get available(): boolean {
    return this.stub || Boolean(this.config.get('BREVO_API_KEY', { infer: true }));
  }

  async create(domain: string): Promise<BrevoDomainState> {
    if (this.stub) return stubState(domain, false);
    const body = await this.request('POST', '/senders/domains', { name: domain });
    // Algunas respuestas de alta no traen registros: se piden aparte.
    const records = parseDnsRecords((body as { dns_records?: unknown }).dns_records, domain);
    return records.length > 0 ? { authenticated: false, records } : this.get(domain);
  }

  async get(domain: string): Promise<BrevoDomainState> {
    if (this.stub) return stubState(domain, !domain.startsWith('fail'));
    const body = (await this.request('GET', `/senders/domains/${encodeURIComponent(domain)}`)) as {
      authenticated?: boolean;
      dns_records?: unknown;
    };
    return {
      authenticated: body.authenticated === true,
      records: parseDnsRecords(body.dns_records, domain),
    };
  }

  /** Pide a Brevo que compruebe los DNS y devuelve el estado resultante. */
  async authenticate(domain: string): Promise<BrevoDomainState> {
    if (this.stub) return stubState(domain, !domain.startsWith('fail'));
    try {
      await this.request('PUT', `/senders/domains/${encodeURIComponent(domain)}/authenticate`);
    } catch (err) {
      // Brevo responde 400 si los DNS aún no están bien: no es un fallo nuestro.
      if (!(err instanceof BrevoDomainsError) || err.status !== 400) throw err;
    }
    return this.get(domain);
  }

  async remove(domain: string): Promise<void> {
    if (this.stub) return;
    try {
      await this.request('DELETE', `/senders/domains/${encodeURIComponent(domain)}`);
    } catch (err) {
      if (err instanceof BrevoDomainsError && err.status === 404) return;
      throw err;
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const apiKey = this.config.get('BREVO_API_KEY', { infer: true });
    if (!apiKey) throw new BrevoDomainsError('BREVO_API_KEY no configurada', 503);
    const res = await fetch(`${BREVO_API_BASE}${path}`, {
      method,
      headers: {
        'api-key': apiKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { message?: string } | null;
      const msg = err?.message ?? res.statusText;
      this.logger.warn(`Brevo ${method} ${path} → ${res.status}: ${msg}`);
      throw new BrevoDomainsError(msg, res.status);
    }
    if (res.status === 204) return {};
    return res.json().catch(() => ({}));
  }
}

const RECORD_LABELS: [RegExp, string][] = [
  [/brevo_code|code/i, 'Código de verificación de Brevo'],
  [/dkim/i, 'Firma DKIM'],
  [/dmarc/i, 'DMARC'],
  [/spf/i, 'SPF'],
];

/**
 * Normaliza `dns_records` de Brevo (objeto `{ clave: { type, value, host_name,
 * status } }`). Tolerante al formato: ignora entradas sin tipo o valor.
 */
export function parseDnsRecords(raw: unknown, domain: string): EmailDnsRecordDto[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: EmailDnsRecordDto[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const r = value as { type?: unknown; value?: unknown; host_name?: unknown; status?: unknown };
    if (typeof r.type !== 'string' || typeof r.value !== 'string') continue;
    const host = typeof r.host_name === 'string' && r.host_name.trim() ? r.host_name.trim() : '@';
    out.push({
      label: RECORD_LABELS.find(([re]) => re.test(key))?.[1] ?? key,
      type: r.type.toUpperCase(),
      host: host === '@' ? domain : host,
      value: r.value,
      ok: r.status === true,
    });
  }
  return out;
}

function stubState(domain: string, authenticated: boolean): BrevoDomainState {
  return {
    authenticated,
    records: [
      {
        label: 'Código de verificación de Brevo',
        type: 'TXT',
        host: domain,
        value: `brevo-code:stub${domain.length}`,
        ok: authenticated,
      },
      {
        label: 'Firma DKIM',
        type: 'TXT',
        host: 'mail._domainkey',
        value: 'k=rsa;p=STUB',
        ok: authenticated,
      },
      {
        label: 'DMARC',
        type: 'TXT',
        host: '_dmarc',
        value: 'v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com',
        ok: authenticated,
      },
    ],
  };
}
