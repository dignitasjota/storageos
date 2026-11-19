/**
 * Dominios reservados para ejemplos y pruebas (RFC 2606 y RFC 6761): nunca
 * tienen buzón. Los usan los inquilinos de la cuenta de demostración.
 */
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];
const RESERVED_TLDS = ['.example', '.invalid', '.test', '.localhost'];

export function isReservedExampleAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@').pop() ?? '';
  if (!domain) return false;
  return (
    RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)) ||
    RESERVED_TLDS.some((tld) => domain.endsWith(tld))
  );
}
