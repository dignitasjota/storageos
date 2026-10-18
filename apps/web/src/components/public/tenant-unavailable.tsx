import type { PublicTenantBrandDto } from '@storageos/shared';

/**
 * Web o reserva de un negocio con la cuenta suspendida. No se dice el motivo
 * (es asunto entre el negocio y TrasterOS); solo cómo contactar con él.
 */
export function TenantUnavailable({
  brand,
  kind,
}: {
  brand: PublicTenantBrandDto;
  kind: 'web' | 'booking';
}) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md space-y-4 text-center">
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brand.logoUrl}
            alt={brand.tenantName}
            className="mx-auto h-12 w-auto object-contain"
          />
        ) : (
          <p className="text-xl font-semibold">{brand.tenantName}</p>
        )}
        <h1 className="text-2xl font-semibold">
          {kind === 'web' ? 'Web temporalmente no disponible' : 'Reserva online no disponible'}
        </h1>
        <p className="text-muted-foreground">
          {kind === 'web'
            ? `La web de ${brand.tenantName} no está disponible en este momento.`
            : `Ahora mismo no se puede reservar online en ${brand.tenantName}.`}{' '}
          Si ya eres cliente, tu acceso a los trasteros sigue funcionando con normalidad.
        </p>
        {(brand.contactPhone || brand.contactEmail) && (
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">Contacta directamente con el negocio:</p>
            {brand.contactPhone && (
              <p>
                <a className="font-medium underline" href={`tel:${brand.contactPhone}`}>
                  {brand.contactPhone}
                </a>
              </p>
            )}
            {brand.contactEmail && (
              <p>
                <a className="font-medium underline" href={`mailto:${brand.contactEmail}`}>
                  {brand.contactEmail}
                </a>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
