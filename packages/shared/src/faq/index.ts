import { z } from 'zod';

/** Una pregunta frecuente del centro de ayuda. */
export interface FaqEntryDto {
  id: string;
  question: string;
  answer: string;
  /** Versión en inglés (opcional): la usa la web pública en inglés y el área de clientes en inglés. */
  questionEn: string | null;
  answerEn: string | null;
  position: number;
  isPublished: boolean;
  createdAt: string;
}

/** Texto en inglés: '' o null = sin traducción. */
const englishText = (max: number) => z.string().trim().max(max).nullable().optional();

export const CreateFaqEntrySchema = z
  .object({
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().min(1).max(5000),
    questionEn: englishText(300),
    answerEn: englishText(5000),
    position: z.number().int().min(0).optional(),
    isPublished: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!faqTranslationComplete(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [v.questionEn ? 'answerEn' : 'questionEn'],
        message: 'Para la versión en inglés escribe la pregunta y la respuesta',
      });
    }
  });
export type CreateFaqEntryInput = z.infer<typeof CreateFaqEntrySchema>;

export const UpdateFaqEntrySchema = z.object({
  question: z.string().trim().min(1).max(300).optional(),
  answer: z.string().trim().min(1).max(5000).optional(),
  questionEn: englishText(300),
  answerEn: englishText(5000),
  position: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
});
export type UpdateFaqEntryInput = z.infer<typeof UpdateFaqEntrySchema>;

/** La traducción va completa (pregunta y respuesta) o no va. */
export function faqTranslationComplete(v: {
  questionEn?: string | null | undefined;
  answerEn?: string | null | undefined;
}): boolean {
  return !!v.questionEn?.trim() === !!v.answerEn?.trim();
}

/**
 * La pregunta en el idioma de quien la lee: en inglés, la versión inglesa si
 * la tiene completa; si no, la española.
 */
export function faqInLanguage<
  T extends {
    question: string;
    answer: string;
    questionEn?: string | null | undefined;
    answerEn?: string | null | undefined;
  },
>(entry: T, locale: string): { question: string; answer: string } {
  const en = locale.toLowerCase().startsWith('en');
  if (en && entry.questionEn?.trim() && entry.answerEn?.trim()) {
    return { question: entry.questionEn, answer: entry.answerEn };
  }
  return { question: entry.question, answer: entry.answer };
}
