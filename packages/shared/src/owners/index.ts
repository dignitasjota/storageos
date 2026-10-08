import { z } from 'zod';

import { isValidSpanishTaxId, normalizeTaxId } from '../accounting/billing-details';
import { isValidIban, normalizeIban } from '../sepa';

/** Honorarios del administrador: % de lo cobrado o cuota fija mensual. */
export const OwnerFeeTypeEnum = z.enum(['percentage', 'fixed']);

export const CreateOwnerSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  taxId: z
    .string()
    .trim()
    .transform(normalizeTaxId)
    .refine(isValidSpanishTaxId, { message: 'NIF/CIF no válido' }),
  address: z.string().trim().max(300).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  postalCode: z.string().trim().max(10).optional().or(z.literal('')),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  /** Cuenta donde se le transfiere la liquidación. '' = quitarla. */
  iban: z
    .string()
    .trim()
    .transform(normalizeIban)
    .refine((v) => v === '' || isValidIban(v), { message: 'IBAN no válido' })
    .optional(),
  feeType: OwnerFeeTypeEnum.default('percentage'),
  feeValue: z.number().min(0).max(100000).default(0),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type CreateOwnerInput = z.infer<typeof CreateOwnerSchema>;

export const UpdateOwnerSchema = CreateOwnerSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateOwnerInput = z.infer<typeof UpdateOwnerSchema>;

export interface OwnerDto {
  id: string;
  legalName: string;
  taxId: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  email: string | null;
  phone: string | null;
  ibanLast4: string | null;
  feeType: 'percentage' | 'fixed';
  feeValue: number;
  notes: string | null;
  isActive: boolean;
  facilitiesCount: number;
  createdAt: string;
}
