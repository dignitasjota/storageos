import { normalizeTaxId } from '@storageos/shared';

/**
 * Envío a Veri*Factu con el certificado de otra persona o entidad (un
 * administrador de fincas, una gestoría o un asesor apoderado). La AEAT lo
 * admite si el titular del certificado está apoderado por el obligado
 * tributario; el registro debe llevar entonces `<Representante>` en la
 * cabecera (CabeceraType de SuministroInformacion.xsd).
 */
export interface AeatRepresentative {
  name: string;
  taxId: string;
}

export interface CredentialIdentity {
  certNif: string;
  certOrganizationNif: string | null;
  certCommonName: string;
  representativeName: string | null;
}

/** NIF/CIF dentro de un texto (DNI, NIE o CIF). */
const NIF_RE = /([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[A-Z]\d{8})/i;

/** Extrae un NIF de un valor de certificado (`IDCES-…`, `VATES-…`, etc.). */
export function nifFromCertValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(NIF_RE);
  return match?.[1] ? match[1].toUpperCase() : null;
}

/**
 * Nombre legible del titular a partir del CN de un certificado. Los de la FNMT
 * llevan el NIF y otras marcas («12345678Z JUAN PÉREZ (R: B12345678)»,
 * «PÉREZ GÓMEZ JUAN - NIF 12345678Z»): se quitan y queda el nombre.
 */
export function nameFromCommonName(commonName: string): string {
  const cleaned = commonName
    .replace(/\(R:[^)]*\)/gi, ' ')
    .replace(/\b(?:NIF|DNI|NIE|CIF)\b\s*:?/gi, ' ')
    .replace(new RegExp(NIF_RE.source, 'gi'), ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-,\s]+|[-,\s]+$/g, '');
  return cleaned || commonName.trim();
}

/**
 * Decide si un envío va como representante. No lo es si el certificado es del
 * propio tenant: su NIF, o un certificado de representante de su propia empresa
 * (la entidad del certificado es el tenant). En otro caso el representante es
 * la entidad del certificado (la gestoría) o, si no trae entidad, su titular.
 */
export function resolveRepresentative(
  tenantTaxId: string | null | undefined,
  cred: CredentialIdentity,
): AeatRepresentative | null {
  if (!tenantTaxId) return null;
  const tenant = normalizeTaxId(tenantTaxId);
  const holder = normalizeTaxId(cred.certNif);
  const org = cred.certOrganizationNif ? normalizeTaxId(cred.certOrganizationNif) : null;
  if (holder === tenant || org === tenant) return null;
  return {
    taxId: org ?? holder,
    name: (cred.representativeName?.trim() || nameFromCommonName(cred.certCommonName)).slice(
      0,
      120,
    ),
  };
}
