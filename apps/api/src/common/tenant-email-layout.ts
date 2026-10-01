/**
 * Carcasa de los correos que un tenant envía a sus inquilinos y contactos:
 * cabecera con su logo (o su nombre) y su color de marca, y pie con su nombre.
 * La usan los correos por defecto al inquilino y todo lo que sale por el
 * outbox de Comunicaciones (recordatorios, automatizaciones, campañas…).
 */

export interface TenantEmailBrand {
  name: string;
  /** URL pública del logo (Ajustes → Marca del portal). */
  logoUrl: string | null;
  /** Color de marca en hex (#rrggbb). */
  brandColor: string | null;
}

export const DEFAULT_BRAND_COLOR = '#2563eb';

/** Marca de un HTML que ya lleva la carcasa (el envío no lo vuelve a envolver). */
export const TENANT_SHELL_MARK = '<!--tenant-shell-->';

export function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Color seguro para incrustar en estilos (solo #rrggbb). */
export function safeBrandColor(color: string | null | undefined): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_BRAND_COLOR;
}

/** Logo seguro para incrustar (solo https/http). */
function safeLogo(url: string | null | undefined): string | null {
  return url && /^https?:\/\/[^\s"<>]+$/i.test(url) ? url : null;
}

/** Envuelve el contenido (HTML ya escapado) en la carcasa del tenant. */
export function tenantEmailShell(brand: TenantEmailBrand, innerHtml: string): string {
  const color = safeBrandColor(brand.brandColor);
  const logo = safeLogo(brand.logoUrl);
  const name = escapeHtml(brand.name);
  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${name}" style="max-height:48px;max-width:200px;display:block">`
    : `<p style="margin:0;font-size:16px;font-weight:700;color:${color}">${name}</p>`;
  return `<!DOCTYPE html>${TENANT_SHELL_MARK}<html lang="es"><body style="margin:0;padding:24px 0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-top:4px solid ${color};border-radius:8px;padding:32px">
<div style="margin:0 0 20px">${header}</div>
${innerHtml}
</div>
<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#94a3b8;text-align:center">${name}</p>
</body></html>`;
}

/** Botón con el color de marca. */
export function brandButton(brand: TenantEmailBrand, href: string, label: string): string {
  return `<p style="margin:24px 0;text-align:center"><a href="${escapeHtml(href)}" style="display:inline-block;background:${safeBrandColor(brand.brandColor)};color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

/** Texto plano → párrafos HTML (escapados) con los enlaces clicables. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const linked = escapeHtml(block).replace(
        /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
        (u) => `<a href="${u}" style="color:#2563eb">${u}</a>`,
      );
      return `<p style="font-size:15px;line-height:24px;margin:0 0 14px">${linked.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

/**
 * Contenido de un HTML de plantilla (lo que hay dentro de `<body>`), sin el
 * pie genérico que llevaban las plantillas por defecto («Enviado por …»): lo
 * pone ya la carcasa.
 */
export function extractBody(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const inner = m ? m[1]! : html;
  return inner.replace(/<hr[^>]*\/?>\s*<p[^>]*>\s*Enviado por [\s\S]*?<\/p>/i, '').trim();
}
