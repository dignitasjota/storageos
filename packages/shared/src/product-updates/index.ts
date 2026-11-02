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
    .regex(/^\/(?!\/)[A-Za-z0-9/_?=&.#-]*$/, 'Debe ser una ruta del panel, p. ej. /settings/web')
    .nullable()
    .optional(),
  /** true = publicar (ahora o en `publishAt`); false = dejar en borrador. */
  published: z.boolean().default(false),
  /** Publicar más adelante (ISO). Sin ella, ahora. */
  publishAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** Se enseña en un aviso al entrar al panel. */
  highlighted: z.boolean().default(false),
  /** Captura ya subida (`POST /admin/product-updates/image-upload-url`); null la quita. */
  imageKey: z.string().max(500).nullable().optional(),
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
  /** Publicada con fecha futura: aún no la ve nadie. */
  scheduled: boolean;
  highlighted: boolean;
  imageUrl: string | null;
  /** Usuarios de los tenants que han abierto «Novedades» desde que se publicó. */
  seenBy: number;
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
  highlighted: boolean;
  imageUrl: string | null;
  /** Publicada después de la última vez que el usuario abrió «Novedades». */
  unread: boolean;
}
