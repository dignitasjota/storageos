import { z } from 'zod';

export const UpdateHoldedSettingsSchema = z.object({
  /** API key de Holded. Si se omite, no se cambia (se conserva la existente). */
  apiKey: z.string().trim().min(10).max(200).optional(),
  enabled: z.boolean(),
});
export type UpdateHoldedSettingsInput = z.infer<typeof UpdateHoldedSettingsSchema>;

export interface HoldedSettingsDto {
  enabled: boolean;
  /** true si hay una API key guardada (nunca se devuelve la key). */
  hasApiKey: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface HoldedTestResultDto {
  ok: boolean;
  message: string;
}
