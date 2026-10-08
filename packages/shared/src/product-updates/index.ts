import { z } from 'zod';

import { TenantFeatures, type TenantFeature } from '../features';

/** «Novedades» de la plataforma que se publican en el panel de los tenants. */
export const ProductUpdateCategoryEnum = z.enum(['new', 'improvement', 'fix']);
export type ProductUpdateCategory = z.infer<typeof ProductUpdateCategoryEnum>;

export const PRODUCT_UPDATE_CATEGORY_LABELS: Record<ProductUpdateCategory, string> = {
  new: 'Nuevo',
  improvement: 'Mejora',
  fix: 'Corrección',
};

export const UpsertProductUpdateSchema = z.object({
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().min(3).max(10_000),
  category: ProductUpdateCategoryEnum.default('new'),
  feature: z.enum(TenantFeatures).nullable().optional(),
  /** Ruta del panel del tenant (empieza por «/»). */
  link: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/, 'Debe ser una ruta del panel, p. ej. /settings/web')
    .nullable()
    .optional(),
  /** true = publicar ahora; false = dejar en borrador. */
  published: z.boolean().default(false),
});
export type UpsertProductUpdateInput = z.infer<typeof UpsertProductUpdateSchema>;

/** Vista del super admin. */
export interface AdminProductUpdateDto {
  id: string;
  title: string;
  body: string;
  category: ProductUpdateCategory;
  feature: TenantFeature | null;
  link: string | null;
  publishedAt: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Vista del tenant. */
export interface ProductUpdateDto {
  id: string;
  title: string;
  body: string;
  category: ProductUpdateCategory;
  feature: TenantFeature | null;
  /** El tenant tiene la funcionalidad relacionada (plan o extra). null si no hay. */
  featureIncluded: boolean | null;
  link: string | null;
  publishedAt: string;
  /** Publicada después de la última vez que el usuario abrió «Novedades». */
  unread: boolean;
}
