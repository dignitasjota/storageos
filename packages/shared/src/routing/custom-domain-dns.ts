/**
 * Dominio propio del tenant: el registro DNS que hay que crear y la variante
 * con y sin `www.`.
 *
 * El dominio guardado es el principal; su variante (`www.` delante, o sin él
 * si el guardado ya lo lleva) también sirve la web y redirige al principal.
 * Solo hay variante cuando el dominio sin `www.` es la raíz del dominio
 * (`garcia.com`, `garcia.com.es`): un subdominio como `trasteros.garcia.com`
 * no tiene `www`.
 */

/** Sufijos de dos niveles habituales (el dominio se compra «debajo» de ellos). */
const TWO_LEVEL_SUFFIXES = new Set([
  'com.es',
  'org.es',
  'nom.es',
  'gob.es',
  'edu.es',
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'com.pt',
  'com.ar',
  'com.mx',
  'com.br',
  'com.co',
  'com.pe',
  'com.uy',
  'com.ve',
  'com.ec',
  'com.do',
  'com.gt',
  'com.py',
  'com.bo',
]);

function normalize(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** El dominio que se compra (`garcia.com` de `trasteros.garcia.com`). */
export function registrableDomain(domain: string): string {
  const labels = normalize(domain).split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** ¿Es la raíz del dominio (sin subdominio)? */
export function isApexDomain(domain: string): boolean {
  const d = normalize(domain);
  return d === registrableDomain(d);
}

/**
 * La otra forma del dominio: `www.garcia.com` para `garcia.com` y al revés.
 * null si el dominio es un subdominio (no tiene `www`).
 */
export function customDomainAlternate(domain: string): string | null {
  const d = normalize(domain);
  if (d.startsWith('www.')) {
    const bare = d.slice(4);
    return bare.includes('.') && isApexDomain(bare) ? bare : null;
  }
  return isApexDomain(d) ? `www.${d}` : null;
}

/** El dominio guardado y su variante con o sin `www.`, en ese orden. */
export function customDomainHosts(domain: string): string[] {
  const alt = customDomainAlternate(domain);
  return alt ? [normalize(domain), alt] : [normalize(domain)];
}

/** ¿Este host es el dominio guardado o su variante con o sin `www.`? */
export function matchesCustomDomain(host: string, domain: string): boolean {
  return customDomainHosts(domain).includes(normalize(host).split(':')[0] ?? '');
}

/** Nombre del registro tal como se escribe en el proveedor (`@`, `www`, `tienda`). */
export function relativeRecordName(host: string, zone: string): string {
  const h = normalize(host);
  const z = normalize(zone);
  if (h === z) return '@';
  return h.endsWith(`.${z}`) ? h.slice(0, -(z.length + 1)) : h;
}

/** A dónde tiene que apuntar un dominio propio (sale de la configuración del API). */
export interface CustomDomainTargetDto {
  /** Dominio de la plataforma (destino de los CNAME). */
  host: string;
  /** IPv4 de la plataforma (destino de los registros A). Vacío si no se conocen. */
  addresses: string[];
}

export interface CustomDomainDnsRecordDto {
  /** `ALIAS`: CNAME en la raíz, solo si el proveedor lo permite (sin IP conocida). */
  type: 'A' | 'CNAME' | 'ALIAS';
  /** Nombre a escribir en el proveedor (`@` = el dominio sin nada delante). */
  name: string;
  /** Nombre completo al que se refiere el registro. */
  host: string;
  /** A qué apunta. */
  value: string;
  /** `primary`: el dominio guardado; `alternate`: su forma con o sin `www.`. */
  purpose: 'primary' | 'alternate';
}

function recordsFor(
  host: string,
  zone: string,
  target: CustomDomainTargetDto,
  purpose: 'primary' | 'alternate',
  cnameTo: string,
): CustomDomainDnsRecordDto[] {
  const name = relativeRecordName(host, zone);
  if (name !== '@') return [{ type: 'CNAME', name, host, value: cnameTo, purpose }];
  // En la raíz no se puede poner CNAME: registros A con la IP de la plataforma.
  if (target.addresses.length === 0) {
    return [{ type: 'ALIAS', name, host, value: target.host, purpose }];
  }
  return target.addresses.map((value) => ({ type: 'A' as const, name, host, value, purpose }));
}

/**
 * Los registros DNS que hay que crear para el dominio propio: el del dominio
 * guardado y el de su variante con o sin `www.` (un CNAME al principal o, si
 * el principal lleva `www.`, el registro A de la raíz).
 */
export function customDomainDnsRecords(
  domain: string,
  target: CustomDomainTargetDto,
): CustomDomainDnsRecordDto[] {
  const primary = normalize(domain);
  const zone = registrableDomain(primary);
  const records = recordsFor(primary, zone, target, 'primary', target.host);
  const alt = customDomainAlternate(primary);
  if (alt) {
    // `www` es un CNAME al principal; si el principal es el que lleva `www.`,
    // la raíz lleva sus registros A.
    records.push(...recordsFor(alt, zone, target, 'alternate', primary));
  }
  return records;
}
