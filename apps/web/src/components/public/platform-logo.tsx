import { DEFAULT_PLATFORM_ICON } from '@/lib/platform-website';

/**
 * Logo de la web de TrasterOS sobre fondo oscuro o de color: el subido desde el
 * panel admin o, si no hay, el isotipo blanco con el nombre.
 */
export function PlatformLogo({
  logoUrl,
  name = 'TrasterOS',
  className = 'h-8',
}: {
  logoUrl: string | null;
  name?: string;
  className?: string;
}) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={name}
        className={`${className} w-auto max-w-[200px] object-contain`}
      />
    );
  }
  return (
    <span className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={DEFAULT_PLATFORM_ICON} alt="" aria-hidden className={`${className} w-auto`} />
      <span className="text-lg font-semibold tracking-tight text-white">{name}</span>
    </span>
  );
}
