import {
  customDomainAlternate,
  customDomainDnsRecords,
  type CustomDomainDnsRecordDto,
  type CustomDomainTargetDto,
} from '../routing';

/**
 * Dominios propios de los tenants: comprobación completa, guía de activación,
 * limpieza del Proxy Host e historial. Tipos y textos de la página del super admin.
 */

/** Avisos de caducidad del certificado de un dominio (días antes). */
export const DOMAIN_CERT_ALERT_DAYS = [14, 7, 1] as const;

/** Hito de aviso que corresponde a los días que quedan (null = aún no toca). */
export function domainCertMilestone(daysLeft: number): number | null {
  if (daysLeft <= 1) return 1;
  for (const m of [...DOMAIN_CERT_ALERT_DAYS].reverse()) {
    if (daysLeft <= m) return m;
  }
  return null;
}

/** Días mínimos entre dos correos al tenant por el mismo problema de su dominio. */
export const DOMAIN_TENANT_NOTICE_COOLDOWN_DAYS = 3;

export interface DomainHostCheckDto {
  host: string;
  ok: boolean;
  found: string[];
}

/** Resultado de una comprobación completa de un dominio propio. */
export interface DomainFullCheckDto {
  tenantId: string;
  domain: string;
  checkedAt: string;
  trigger: 'manual' | 'cron' | 'activate';
  /** Todo en orden: el DNS apunta, responde por https y el certificado vale. */
  ok: boolean;
  dns: { root: DomainHostCheckDto; www: DomainHostCheckDto | null; expected: string[] };
  https: { ok: boolean; status: number | null; ms: number | null; error: string | null };
  tls: {
    valid: boolean;
    validTo: string | null;
    daysLeft: number | null;
    error: string | null;
  };
}

/** Lo que el panel sabe de un dominio, además de su fila de la lista. */
export interface DomainOpsRowDto {
  tenantId: string;
  lastCheck: DomainFullCheckDto | null;
  /** Pasos de la guía marcados como hechos. */
  checklist: Record<string, boolean>;
  /** Dominio de correo del tenant. */
  emailDomain: { domain: string; status: string; verified: boolean } | null;
  /** Proxy Hosts pendientes de borrar de este tenant. */
  pendingCleanups: number;
  /** Estado del tenant (active, trial, suspended…). */
  tenantStatus: string;
}

export interface DomainOpsOverviewDto {
  rows: DomainOpsRowDto[];
  notifyTenantEnabled: boolean;
}

export interface DomainCleanupDto {
  id: string;
  tenantId: string;
  tenantName: string;
  domain: string;
  reason: 'changed' | 'removed';
  /** Nombre del Proxy Host que hay que borrar en NPM. */
  proxyHost: string;
  createdAt: string;
  doneAt: string | null;
}

export interface DomainHistoryItemDto {
  at: string;
  kind: 'activated' | 'revoked' | 'check' | 'notice' | 'other';
  title: string;
  detail: string | null;
  /** Quién lo hizo (null = automático). */
  by: string | null;
}

// ----------------------------------------------------------------- la guía

export const DOMAIN_CHECKLIST_STEPS = [
  { key: 'dns', label: 'He creado los registros DNS en el proveedor del dominio' },
  { key: 'proxy_host', label: 'He creado el Proxy Host en Nginx Proxy Manager' },
  { key: 'ssl', label: 'He pedido el certificado de Let’s Encrypt' },
  { key: 'force_ssl', label: 'He marcado Force SSL y HTTP/2' },
] as const;

export type DomainChecklistKey = (typeof DOMAIN_CHECKLIST_STEPS)[number]['key'];

export interface DomainGuideDto {
  domain: string;
  /** Nombres que lleva el Proxy Host (el dominio y su forma con o sin `www.`). */
  proxyHostNames: string[];
  records: CustomDomainDnsRecordDto[];
  /** Texto para copiar y mandar a quien gestione el DNS. */
  dnsText: string;
  /** Texto para copiar con los pasos de Nginx Proxy Manager. */
  npmText: string;
  checklist: Record<string, boolean>;
}

/** Nombres que debe llevar el Proxy Host de un dominio. */
export function proxyHostNames(domain: string): string[] {
  const d = domain.trim().toLowerCase();
  const alt = customDomainAlternate(d);
  return alt ? [d, alt] : [d];
}

/** Guía paso a paso de un dominio: DNS exacto y Proxy Host de NPM. */
export function buildDomainGuide(
  domain: string,
  target: CustomDomainTargetDto,
  checklist: Record<string, boolean> = {},
): DomainGuideDto {
  const records = customDomainDnsRecords(domain, target);
  const names = proxyHostNames(domain);
  const dnsText = [
    `Registros DNS para ${domain}:`,
    ...records.map((r) => `- ${r.type}  ${r.name}  →  ${r.value}   (${r.host})`),
  ].join('\n');
  const npmText = [
    `Nginx Proxy Manager → Hosts → Proxy Hosts → Add Proxy Host`,
    `1. Domain Names: ${names.join(', ')}`,
    `2. Scheme: http · Forward Hostname / IP: web · Forward Port: 3000`,
    `3. Marca «Block Common Exploits» y «Websockets Support»`,
    `4. Pestaña SSL: Request a new SSL Certificate (Let’s Encrypt)`,
    `5. Marca Force SSL y HTTP/2 Support, acepta los términos y guarda`,
    `6. Vuelve al panel y pulsa «Comprobar ahora»`,
  ].join('\n');
  return { domain, proxyHostNames: names, records, dnsText, npmText, checklist };
}
