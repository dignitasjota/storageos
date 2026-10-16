/**
 * Rasgos de cada plantilla que la landing de promoción hereda: color por
 * defecto, esquinas, mayúsculas y fondo oscuro. Así una sola landing se ve como
 * el resto de la web. Puro (lo usan la página en el servidor y el cuerpo).
 */
export interface PromoTheme {
  accent: string;
  radius: string;
  button: string;
  upper: boolean;
  dark: boolean;
}

export function themeFor(template: string, brandColor: string | null): PromoTheme {
  const base: PromoTheme = {
    accent: brandColor ?? '#2563EB',
    radius: 'rounded-xl',
    button: 'rounded-lg',
    upper: false,
    dark: false,
  };
  switch (template) {
    case 'industrial':
      return {
        ...base,
        accent: brandColor ?? '#f59e0b',
        radius: 'rounded-none',
        button: 'rounded-none',
        upper: true,
        dark: true,
      };
    case 'cabe':
      return {
        ...base,
        accent: brandColor ?? '#1E3A8A',
        radius: 'rounded-2xl',
        button: 'rounded-full',
        upper: true,
      };
    case 'trstrom':
    case 'modern':
    case 'onepagemovil':
      return { ...base, radius: 'rounded-2xl', button: 'rounded-full' };
    default:
      return base;
  }
}
