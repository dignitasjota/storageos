import { lookup } from 'node:dns/promises';
import https from 'node:https';

import { isDisallowedIp, isIpLiteralHostname, isValidCustomDomain } from '@storageos/shared';

/** Respuesta https y certificado de un dominio. */
export interface DomainProbeResult {
  https: { ok: boolean; status: number | null; ms: number | null; error: string | null };
  tls: { valid: boolean; validTo: Date | null; error: string | null };
}

const TIMEOUT_MS = 6_000;

const failed = (error: string): DomainProbeResult => ({
  https: { ok: false, status: null, ms: null, error },
  tls: { valid: false, validTo: null, error },
});

/** Simulación en `NODE_ENV=test`: `ready…` responde; `soon`, `expired` y `badcert` cambian el certificado. */
function simulate(host: string): DomainProbeResult {
  const name = host.replace(/^www\./, '');
  if (!name.startsWith('ready')) return failed('No responde (simulado)');
  const day = 86_400_000;
  const validTo = (days: number) => new Date(Date.now() + days * day);
  if (name.includes('badcert')) {
    return {
      https: { ok: true, status: 200, ms: 120, error: null },
      tls: { valid: false, validTo: validTo(60), error: 'Certificado no válido para este dominio' },
    };
  }
  const days = name.includes('expired') ? -3 : name.includes('soon') ? 5 : 90;
  return {
    https: { ok: true, status: 200, ms: 120, error: null },
    tls: {
      valid: days > 0,
      validTo: validTo(days),
      error: days > 0 ? null : 'El certificado ha caducado',
    },
  };
}

/**
 * Comprueba que `https://<host>` responde y que su certificado vale. Protegido
 * contra SSRF: solo dominios con formato válido (nunca una IP) y se conecta a la
 * dirección ya resuelta tras comprobar que no es privada ni interna.
 */
export async function probeDomain(host: string): Promise<DomainProbeResult> {
  if (process.env.NODE_ENV === 'test') return simulate(host);
  if (!isValidCustomDomain(host) || isIpLiteralHostname(host)) return failed('Dominio no válido');
  let ip: string;
  try {
    const addresses = await lookup(host, { all: true, family: 4 });
    if (addresses.length === 0) return failed('El dominio no resuelve a ninguna dirección');
    if (addresses.some((a) => isDisallowedIp(a.address))) {
      return failed('El dominio resuelve a una dirección interna: no se comprueba');
    }
    ip = addresses[0]!.address;
  } catch {
    return failed('El dominio no resuelve a ninguna dirección');
  }
  const started = Date.now();
  return new Promise<DomainProbeResult>((resolve) => {
    const req = https.request(
      {
        host: ip,
        servername: host,
        port: 443,
        method: 'HEAD',
        path: '/',
        headers: { Host: host, 'User-Agent': 'TrasterOS-domain-check' },
        timeout: TIMEOUT_MS,
        // Se mira el resultado de la validación para informar, no se corta la conexión.
        rejectUnauthorized: false,
      },
      (res) => {
        const ms = Date.now() - started;
        const socket = res.socket as import('node:tls').TLSSocket;
        const cert = socket.getPeerCertificate?.();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        const expired = validTo !== null && validTo.getTime() < Date.now();
        const authError = socket.authorized
          ? null
          : String(socket.authorizationError ?? 'Certificado no válido');
        res.resume();
        resolve({
          https: { ok: true, status: res.statusCode ?? null, ms, error: null },
          tls: {
            valid: socket.authorized === true && !expired,
            validTo,
            error: expired ? 'El certificado ha caducado' : authError,
          },
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(failed('No responde (tiempo agotado)'));
    });
    req.on('error', (err) => resolve(failed(`No se puede conectar: ${err.message}`.slice(0, 200))));
    req.end();
  });
}
