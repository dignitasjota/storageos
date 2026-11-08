/**
 * Número de instalación del sistema en los registros de Veri*Factu. En un
 * programa en la nube cada facturación (el negocio y cada uno de sus
 * propietarios) es un sistema distinto, y su número no se repite nunca, ni al
 * volver a activarlo (preguntas frecuentes de la AEAT a desarrolladores, n.º 4).
 */

/**
 * El de un negocio: la fecha y hora (UTC) en que activó Veri*Factu y el
 * principio de su id, como recomienda la AEAT (otra activación, otro número).
 */
export function verifactuInstallationNumber(enabledAt: Date, tenantId: string): string {
  const stamp = enabledAt.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${tenantId.slice(0, 8)}`;
}

/** El de cada propietario (otra facturación, otro sistema) cuelga del del negocio. */
export function ownerInstallationNumber(tenantInstallation: string, ownerId: string): string {
  return `${tenantInstallation}-${ownerId.slice(0, 8)}`;
}
