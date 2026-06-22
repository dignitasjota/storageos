import { z } from 'zod';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');

/** Firma pública (remota o self-service) enviada por el inquilino. */
export const PublicSignSubmitSchema = z
  .object({
    signerName: z.string().trim().min(2, 'Nombre requerido').max(160),
    method: z.enum(['drawn', 'typed']),
    /** Data URL PNG de la firma dibujada (si method=drawn). Máx ~2 MB. */
    signatureImage: z.string().max(2_000_000).optional(),
    typedSignature: z.string().trim().max(160).optional(),
    accept: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar para firmar' }) }),
  })
  .refine((v) => (v.method === 'drawn' ? !!v.signatureImage : !!v.typedSignature?.trim()), {
    message: 'Falta la firma',
    path: ['method'],
  });
export type PublicSignSubmitInput = z.infer<typeof PublicSignSubmitSchema>;

/** Alta self-service desde la web pública (move-in). */
export const PublicBookingSchema = z.object({
  facilityId: z.string().uuid(),
  unitTypeId: z.string().uuid(),
  startDate: dateOnly,
  customer: z.object({
    firstName: z.string().trim().min(1, 'Obligatorio').max(100),
    lastName: z.string().trim().min(1, 'Obligatorio').max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().max(40).optional().or(z.literal('')),
    documentNumber: z.string().trim().max(40).optional().or(z.literal('')),
  }),
  /** Código de referido opcional (best-effort). */
  referralCode: z.string().trim().toUpperCase().max(32).optional().or(z.literal('')),
  /** Honeypot anti-bot: debe venir vacío. */
  website: z.string().optional(),
});
export type PublicBookingInput = z.infer<typeof PublicBookingSchema>;
