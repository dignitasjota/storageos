/**
 * Helper para consultar Mailpit (servidor SMTP de dev) durante los tests
 * e2e. Mailpit expone una API HTTP en http://127.0.0.1:8026.
 */
const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8026/api/v1';

interface MailpitSummary {
  ID: string;
  To: { Address: string; Name: string }[];
  From: { Address: string; Name: string };
  Subject: string;
  Created: string;
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  HTML: string;
  Text: string;
}

export async function deleteAllMessages(): Promise<void> {
  const res = await fetch(`${MAILPIT_API}/messages`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Mailpit DELETE devolvio ${res.status}`);
  }
}

async function search(toAddress: string): Promise<MailpitSummary[]> {
  const url = `${MAILPIT_API}/search?query=${encodeURIComponent(`to:${toAddress}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mailpit search devolvio ${res.status}`);
  const data = (await res.json()) as { messages: MailpitSummary[] };
  return data.messages ?? [];
}

async function fetchMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${MAILPIT_API}/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit GET /message/${id} devolvio ${res.status}`);
  return (await res.json()) as MailpitMessage;
}

/**
 * Espera (poll cada 100ms, hasta 5s) a que llegue un email al destinatario.
 * Devuelve el mensaje completo con HTML + Text. Lanza si no llega.
 */
export async function waitForEmail(
  toAddress: string,
  options: { subjectIncludes?: string; timeoutMs?: number } = {},
): Promise<MailpitMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    const messages = await search(toAddress);
    const match = options.subjectIncludes
      ? messages.find((m) => m.Subject.includes(options.subjectIncludes!))
      : messages[0];
    if (match) return fetchMessage(match.ID);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No llego email a ${toAddress} en ${options.timeoutMs ?? 5000}ms`);
}

/**
 * Extrae el primer enlace de los emails de verificacion/reset.
 * Los enlaces tienen la forma `WEB_BASE_URL/verify-email/<token>` o
 * `WEB_BASE_URL/reset-password/<token>`.
 */
export function extractToken(text: string, pathPrefix: string): string {
  const regex = new RegExp(`${pathPrefix}/([A-Za-z0-9._-]+)`);
  const match = text.match(regex);
  if (!match || !match[1]) {
    throw new Error(`No se encontro token con prefijo ${pathPrefix} en el email`);
  }
  return match[1];
}
