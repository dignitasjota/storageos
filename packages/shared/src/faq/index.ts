import { z } from 'zod';

/** Una pregunta frecuente del centro de ayuda. */
export interface FaqEntryDto {
  id: string;
  question: string;
  answer: string;
  position: number;
  isPublished: boolean;
  createdAt: string;
}

export const CreateFaqEntrySchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(5000),
  position: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
});
export type CreateFaqEntryInput = z.infer<typeof CreateFaqEntrySchema>;

export const UpdateFaqEntrySchema = CreateFaqEntrySchema.partial();
export type UpdateFaqEntryInput = z.infer<typeof UpdateFaqEntrySchema>;
