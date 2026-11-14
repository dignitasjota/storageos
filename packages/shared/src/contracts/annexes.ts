import { z } from 'zod';

/**
 * Anexos a un contrato firmado: lo firmado no se cambia; lo que se acuerde
 * después va en un anexo que el inquilino firma aparte (desde el correo o su
 * área de clientes).
 */
export const ContractAnnexStatusEnum = z.enum(['pending', 'signed', 'cancelled']);
export type ContractAnnexStatus = z.infer<typeof ContractAnnexStatusEnum>;

export const CreateContractAnnexSchema = z.object({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(10).max(10_000),
});
export type CreateContractAnnexInput = z.infer<typeof CreateContractAnnexSchema>;

/** Firma del anexo con el enlace (igual que la del contrato). */
export const SignContractAnnexSchema = z
  .object({
    signerName: z.string().trim().min(2).max(160),
    method: z.enum(['drawn', 'typed']),
    signatureImage: z.string().max(2_000_000).optional(),
    typedSignature: z.string().trim().max(160).optional(),
    accept: z.literal(true),
    /** Huella del texto que ha leído: si no coincide, no se firma. */
    documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .refine((v) => (v.method === 'drawn' ? !!v.signatureImage : !!v.typedSignature?.trim()), {
    message: 'Falta la firma',
  });
export type SignContractAnnexInput = z.infer<typeof SignContractAnnexSchema>;

/** Anexo tal como lo ve el equipo en la ficha del contrato. */
export interface ContractAnnexDto {
  id: string;
  contractId: string;
  number: number;
  title: string;
  body: string;
  status: ContractAnnexStatus;
  /** Texto completo que se firma (o se firmó). */
  termsText: string;
  documentHash: string;
  createdAt: string;
  /** Email al que se envió el último enlace. */
  sentTo: string | null;
  /** Hasta cuándo vale el enlace (solo pendientes). */
  linkExpiresAt: string | null;
  signedAt: string | null;
  signerName: string | null;
  signatureMethod: 'drawn' | 'typed' | null;
  signatureImage: string | null;
  typedSignature: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  cancelledAt: string | null;
  /** Renovación que se aplica al firmarlo (null = anexo de texto). */
  renewal: { months: number; newPrice: number | null } | null;
  /** Cuándo se aplicó lo que hacía al firmarse, o por qué no. */
  actionAppliedAt: string | null;
  actionError: string | null;
}

/** Al crear o reenviar: el enlace (para copiarlo) y si salió el correo. */
export interface ContractAnnexSentDto {
  annex: ContractAnnexDto;
  signingUrl: string;
  emailed: boolean;
}

/** Página pública de firma del anexo. */
export interface AnnexSignViewDto {
  number: number;
  title: string;
  termsText: string;
  documentHash: string;
  contractNumber: string;
  customerName: string;
  tenantName: string;
  tenantSlug: string;
  brandColor: string | null;
  logoUrl: string | null;
  /** Idioma del inquilino para los textos de la página. */
  locale: 'es' | 'en';
  status: 'pending' | 'signed';
  signedAt: string | null;
}

/** Anexo en el área de clientes. */
export interface PortalAnnexDto {
  id: string;
  contractId: string;
  contractNumber: string;
  unitCode: string;
  facilityName: string;
  number: number;
  title: string;
  status: 'pending' | 'signed';
  createdAt: string;
  signedAt: string | null;
  /** Oferta de renovación: al firmarla se renueva el contrato. */
  renewal: { months: number; newPrice: number | null } | null;
}
