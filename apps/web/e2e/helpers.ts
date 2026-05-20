/**
 * Helpers comunes para los smoke tests E2E.
 *
 * Mantenemos los tests autocontenidos (sin Page Object Model) pero
 * compartimos utilidades de bajo nivel: lectura de emails desde Mailpit,
 * generación de códigos TOTP y creación rápida de tenants vía API.
 *
 * Las URLs por defecto coinciden con el `docker-compose.yml` del repo:
 *   - API:      http://localhost:3001
 *   - Web:      http://localhost:3000
 *   - Mailpit:  http://localhost:8026
 */
import { Secret, TOTP } from 'otpauth';

export const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:3001';
export const WEB_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
export const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8026/api/v1';

interface MailpitSummary {
  ID: string;
  To: { Address: string; Name: string }[];
  Subject: string;
  Created: string;
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  HTML: string;
  Text: string;
}

/**
 * Devuelve un identificador único por test (slug y email) para evitar
 * colisiones entre ejecuciones consecutivas que comparten BD.
 */
export function uniqueIds(prefix: string): { slug: string; email: string } {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return {
    slug: `${prefix}-${ts}-${rand}`,
    email: `${prefix}-${ts}-${rand}@e2e.local`,
  };
}

/** Borra todos los mensajes de Mailpit (útil al inicio de un test). */
export async function clearMailpit(): Promise<void> {
  const res = await fetch(`${MAILPIT_API}/messages`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Mailpit DELETE devolvió ${res.status}`);
  }
}

async function searchMailpit(toAddress: string): Promise<MailpitSummary[]> {
  const url = `${MAILPIT_API}/search?query=${encodeURIComponent(`to:${toAddress}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mailpit search devolvió ${res.status}`);
  const data = (await res.json()) as { messages?: MailpitSummary[] };
  return data.messages ?? [];
}

async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${MAILPIT_API}/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit GET /message/${id} devolvió ${res.status}`);
  return (await res.json()) as MailpitMessage;
}

/**
 * Espera (poll cada 200 ms, hasta `timeoutMs`) a que llegue un email al
 * destinatario indicado. Devuelve el mensaje con HTML + Text para que el
 * test extraiga lo que necesite.
 */
export async function waitForEmail(
  toAddress: string,
  options: { subjectIncludes?: string; timeoutMs?: number } = {},
): Promise<MailpitMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const messages = await searchMailpit(toAddress);
    const match = options.subjectIncludes
      ? messages.find((m) => m.Subject.includes(options.subjectIncludes!))
      : messages[0];
    if (match) return getMailpitMessage(match.ID);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No llegó email a ${toAddress} en ${options.timeoutMs ?? 10_000}ms`);
}

/**
 * Extrae el token de los enlaces del email. Los enlaces tienen la forma
 * `<WEB_URL>/<pathPrefix>/<token>`.
 */
export function extractMailpitToken(messageText: string, pathPrefix: string): string {
  // Aceptamos cualquier carácter "seguro" en el token (los nuestros son
  // base64url con `.` y `_`).
  const regex = new RegExp(`${pathPrefix}/([A-Za-z0-9._-]+)`);
  const match = messageText.match(regex);
  if (!match || !match[1]) {
    throw new Error(`No se encontró token con prefijo ${pathPrefix} en el email`);
  }
  return match[1];
}

/**
 * Genera el código TOTP actual para un secret base32 (mismo algoritmo
 * que el backend: SHA1, 6 dígitos, periodo 30s).
 */
export function generateTotpCode(secretBase32: string): string {
  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.generate();
}

/** Resultado de `seedTestTenant`: lo mínimo para login posterior. */
export interface SeededTenant {
  slug: string;
  email: string;
  password: string;
  tenantId: string;
  userId: string;
}

/**
 * Crea un tenant verificado vía API directa (sin UI) para que los tests
 * 02-04 puedan saltarse el flujo de registro. Sigue:
 *   1. POST /auth/register
 *   2. Lee email de verificación de Mailpit
 *   3. POST /auth/verify-email
 */
export async function seedTestTenant(prefix = 'e2e'): Promise<SeededTenant> {
  const { slug, email } = uniqueIds(prefix);
  const password = 'Secret123';

  const reg = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantName: `E2E ${prefix}`,
      tenantSlug: slug,
      fullName: 'E2E Tester',
      email,
      password,
      acceptTerms: true,
    }),
  });
  if (!reg.ok) {
    throw new Error(`/auth/register devolvió ${reg.status}: ${await reg.text()}`);
  }

  const mail = await waitForEmail(email, { subjectIncludes: 'Verifica' });
  const token = extractMailpitToken(mail.Text || mail.HTML, '/verify-email');

  const verify = await fetch(`${API_URL}/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!verify.ok) {
    throw new Error(`/auth/verify-email devolvió ${verify.status}: ${await verify.text()}`);
  }
  const body = (await verify.json()) as {
    user: { id: string };
    tenant: { id: string };
  };
  return {
    slug,
    email,
    password,
    tenantId: body.tenant.id,
    userId: body.user.id,
  };
}

/**
 * Login vía API directa. Devuelve `accessToken` para llamar a endpoints
 * autenticados desde los helpers de fixtures. NO maneja 2FA: usar solo
 * con usuarios sin 2FA activo.
 */
export async function apiLogin(
  slug: string,
  email: string,
  password: string,
): Promise<{ accessToken: string }> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug: slug, email, password }),
  });
  if (!res.ok) throw new Error(`/auth/login devolvió ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { accessToken?: string; requires2fa?: boolean };
  if (body.requires2fa || !body.accessToken) {
    throw new Error('apiLogin no soporta usuarios con 2FA activo');
  }
  return { accessToken: body.accessToken };
}

/** Crea un customer individual vía API. */
export async function apiCreateCustomer(
  accessToken: string,
  overrides: Partial<{ firstName: string; lastName: string; email: string }> = {},
): Promise<{ id: string }> {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const res = await fetch(`${API_URL}/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      customerType: 'individual',
      firstName: overrides.firstName ?? `E2E ${stamp}`,
      lastName: overrides.lastName ?? 'Tester',
      email: overrides.email ?? `cust-${stamp}@e2e.local`,
      documentNumber: `${stamp}-X`,
      country: 'ES',
    }),
  });
  if (!res.ok) {
    throw new Error(`/customers create devolvió ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

/**
 * Garantiza una serie de facturación por defecto en el tenant. Devuelve su
 * ID. Idempotente: si ya existe una serie default, la reutiliza.
 */
export async function apiEnsureDefaultInvoiceSeries(accessToken: string): Promise<string> {
  const listRes = await fetch(`${API_URL}/invoice-series`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    throw new Error(`/invoice-series GET devolvió ${listRes.status}`);
  }
  const series = (await listRes.json()) as Array<{ id: string; isDefault: boolean }>;
  const existing = series.find((s) => s.isDefault);
  if (existing) return existing.id;
  const create = await fetch(`${API_URL}/invoice-series`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      code: 'A',
      name: 'Serie principal',
      prefix: 'FA',
      yearScope: true,
      isDefault: true,
    }),
  });
  if (!create.ok) {
    throw new Error(`/invoice-series POST devolvió ${create.status}: ${await create.text()}`);
  }
  const created = (await create.json()) as { id: string };
  return created.id;
}

/** Crea una factura draft + (opcional) la emite. Devuelve la factura final. */
export async function apiCreateDraftInvoice(
  accessToken: string,
  customerId: string,
  opts: Partial<{ unitPrice: number; description: string; issue: boolean }> = {},
): Promise<{ id: string; status: string; invoiceNumber: string | null }> {
  await apiEnsureDefaultInvoiceSeries(accessToken);
  const draftRes = await fetch(`${API_URL}/invoices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      customerId,
      items: [
        {
          description: opts.description ?? 'Cuota mensual',
          quantity: 1,
          unitPrice: opts.unitPrice ?? 100,
          taxRate: 21,
        },
      ],
    }),
  });
  if (!draftRes.ok) {
    throw new Error(`/invoices POST devolvió ${draftRes.status}: ${await draftRes.text()}`);
  }
  const draft = (await draftRes.json()) as {
    id: string;
    status: string;
    invoiceNumber: string | null;
  };
  if (!opts.issue) return draft;

  const issueRes = await fetch(`${API_URL}/invoices/${draft.id}/issue`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!issueRes.ok) {
    throw new Error(`/invoices/:id/issue devolvió ${issueRes.status}: ${await issueRes.text()}`);
  }
  return (await issueRes.json()) as { id: string; status: string; invoiceNumber: string | null };
}
