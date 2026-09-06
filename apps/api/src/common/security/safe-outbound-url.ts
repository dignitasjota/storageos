import { promises as dns } from 'node:dns';

import { isDisallowedIp, isIpLiteralHostname } from '@storageos/shared';

export interface UnsafeUrlCheck {
  safe: boolean;
  reason?: string;
}

/**
 * Comprueba si una URL que el backend va a usar para un fetch SALIENTE
 * (nunca la visita un navegador) es segura de disparar: solo bloquea IPs
 * privadas/loopback/link-local/reservadas (v4+v6) tras resolver el
 * hostname por DNS. Nunca lanza — pensado para los providers que ya
 * declaran "nunca lanzo, devuelvo `dispatched:false`"
 * (`LockProvider`/`CameraControlProvider`): quien haga el fetch de verdad
 * debe volver a llamar esto justo antes de cada request (defensa contra DNS
 * rebinding: el hostname pudo resolver a una IP pública en el pasado y a
 * una privada ahora), no basta con validar una vez al guardar la URL.
 *
 * A propósito NO exige `https` ni bloquea por dominio de plataforma (a
 * diferencia de `parseExternalSiteUrl`, usado para `externalSiteUrl`/
 * `portalLogoUrl`): el `controlUrl` de un dispositivo de acceso/cámara es
 * la URL de un controlador físico en la red del propio tenant (a menudo
 * `http://`, sin TLS) — bloquear `http` o IPs privadas por defecto
 * rompería el caso de uso real (y el de los tests/dev, que simulan un
 * terminal con un literal `127.0.0.1`). El riesgo que sí hay que cerrar es
 * que el servidor CLOUD (sin acceso a la LAN del cliente) reciba una
 * respuesta real de una IP privada — eso solo puede ser infraestructura de
 * la propia plataforma (red interna de Docker, metadata cloud), nunca el
 * hardware legítimo del cliente.
 */
export async function isSafeOutboundUrl(url: string): Promise<UnsafeUrlCheck> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { safe: false, reason: 'invalid_url' };
  }
  if (isIpLiteralHostname(hostname)) {
    return isDisallowedIp(hostname) ? { safe: false, reason: 'private_ip' } : { safe: true };
  }
  // Hostname de dominio (frecuente para exponer un controlador tras el
  // router del cliente vía DDNS) — se resuelve y se re-chequea la IP real.
  try {
    const { address } = await dns.lookup(hostname);
    if (isDisallowedIp(address)) return { safe: false, reason: 'private_ip' };
    return { safe: true };
  } catch {
    return { safe: false, reason: 'dns_error' };
  }
}
