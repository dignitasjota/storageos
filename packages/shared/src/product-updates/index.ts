import { z } from 'zod';

import { UserRoles, type UserRole } from '../auth/enums';
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
  /** Solo para estos planes (slugs); vacío = todos. */
  targetPlans: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(60)
        .regex(/^[a-z0-9-]+$/),
    )
    .max(20)
    .default([]),
  /** Solo para estos roles; vacío = todos. */
  targetRoles: z.array(z.enum(UserRoles)).max(UserRoles.length).default([]),
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
  /** «¿Te ha sido útil?»: cuántos 👍 y 👎. */
  helpfulUp: number;
  helpfulDown: number;
  /** Planes (slugs) y roles a los que va dirigida; vacíos = a todos. */
  targetPlans: string[];
  targetRoles: UserRole[];
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
  /** «¿Te ha sido útil?» del usuario (null = sin responder). */
  myReaction: ProductUpdateReaction | null;
  /**
   * Prueba gratis que el negocio puede activar desde la novedad: hay un extra
   * activo que da la función, no la tiene y nunca lo ha probado. Solo la puede
   * activar quien gestiona la suscripción (`billing:configure`).
   */
  trialOffer: ProductUpdateTrialOfferDto | null;
}

export interface ProductUpdateTrialOfferDto {
  addonId: string;
  addonName: string;
  days: number;
}

/** Días de la prueba gratis de un extra activada desde una novedad. */
export const SELF_ADDON_TRIAL_DAYS = 14;

/** Resultado de activar la prueba gratis de un extra. */
export interface SelfAddonTrialResultDto {
  feature: TenantFeature;
  expiresAt: string;
}

// --- «¿Te ha sido útil?» ---

export const ProductUpdateReactionEnum = z.enum(['up', 'down']);
export type ProductUpdateReaction = z.infer<typeof ProductUpdateReactionEnum>;

/** null quita la reacción. */
export const SetProductUpdateReactionSchema = z.object({
  value: ProductUpdateReactionEnum.nullable(),
});
export type SetProductUpdateReactionInput = z.infer<typeof SetProductUpdateReactionSchema>;

// --- Novedades dirigidas ---

export const PRODUCT_UPDATE_ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Propietario',
  manager: 'Gestor',
  staff: 'Personal',
  readonly: 'Solo lectura',
};

/** ¿Le toca a un usuario con este plan y este rol? (vacío = a todos). */
export function productUpdateTargets(
  update: { targetPlans: readonly string[]; targetRoles: readonly string[] },
  planSlug: string | null,
  role: string,
): boolean {
  const planOk =
    update.targetPlans.length === 0 || (planSlug != null && update.targetPlans.includes(planSlug));
  const roleOk = update.targetRoles.length === 0 || update.targetRoles.includes(role);
  return planOk && roleOk;
}

// --- Filtros de la página de Novedades ---

/** Valor del tipo en la dirección (`?tipo=`), en español. */
export const PRODUCT_UPDATE_CATEGORY_SLUGS: Record<ProductUpdateCategory, string> = {
  new: 'novedad',
  improvement: 'mejora',
  fix: 'correccion',
};

export function productUpdateCategoryFromSlug(
  slug: string | null | undefined,
): ProductUpdateCategory | null {
  if (!slug) return null;
  const entry = (
    Object.entries(PRODUCT_UPDATE_CATEGORY_SLUGS) as Array<[ProductUpdateCategory, string]>
  ).find(([, v]) => v === slug);
  return entry ? entry[0] : null;
}

// --- Resumen mensual por correo ---

/** Resultado de enviar el resumen mensual de novedades. */
export interface ProductUpdatesDigestResultDto {
  /** Mes resumido (AAAA-MM). */
  month: string;
  /** Novedades publicadas ese mes. */
  updates: number;
  /** Correos encolados. */
  sent: number;
}

/** Enlace de baja del resumen (página pública). */
export interface ProductUpdatesDigestUnsubscribeDto {
  /** Email enmascarado. */
  email: string;
  unsubscribed: boolean;
}
