'use client';

import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { FacilityDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth/hooks';
import { useFacility, useFacilityOverview } from '@/lib/facilities/hooks';

function Poster({
  facility,
  url,
  tenantName,
  color,
  className,
}: {
  facility: FacilityDto;
  url: string;
  tenantName: string;
  color: string;
  className: string;
}) {
  const place = [facility.address, facility.postalCode, facility.city].filter(Boolean).join(', ');
  return (
    <div className={`${className} flex flex-col items-center gap-6 bg-white p-10 text-black`}>
      <p className="text-xl font-medium">{tenantName}</p>
      <h2 className="text-center text-5xl font-bold" style={{ color }}>
        Reserva tu trastero
      </h2>
      <p className="text-center text-2xl">{facility.name}</p>
      <QRCodeSVG value={url} size={320} marginSize={2} />
      <p className="text-center text-lg">Escanea el código para ver tamaños y precios</p>
      <p className="break-all text-center text-sm">{url.replace(/^https?:\/\//, '')}</p>
      {(place || facility.contactPhone) && (
        <div className="text-center text-lg">
          {place && <p>{place}</p>}
          {facility.contactPhone && <p className="font-semibold">{facility.contactPhone}</p>}
        </div>
      )}
    </div>
  );
}

/** Cartel para la puerta del local: el QR lleva a su página en la web. */
export default function FacilityPosterPage() {
  const id = useParams<{ id: string }>()?.id ?? '';
  const facility = useFacility(id);
  const overview = useFacilityOverview(id);
  const me = useMe();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const url = overview.data?.publicUrl ?? null;
  const tenant = me.data?.tenant;
  const ready = !!facility.data && !!url;
  const poster = (className: string) =>
    ready ? (
      <Poster
        facility={facility.data}
        url={url}
        tenantName={tenant?.name ?? ''}
        color={tenant?.brandColor ?? '#2563EB'}
        className={className}
      />
    ) : null;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      {/* Se imprime una copia colgada de <body>: dentro del panel heredaría su
          posición y se estiraría a toda la hoja. */}
      <style>{`
        .facility-poster-print { display: none; }
        @media print {
          @page { size: A4; margin: 15mm; }
          body > *:not(.facility-poster-print) { display: none !important; }
          .facility-poster-print { display: block; }
        }
      `}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href={`/facilities/${id}`}>
              <ArrowLeft className="mr-1 h-4 w-4" /> {facility.data?.name ?? 'Local'}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Cartel con QR</h1>
          <p className="text-sm text-muted-foreground">
            El QR lleva a la página de este local en tu web.
          </p>
        </div>
        <Button onClick={() => window.print()} disabled={!ready}>
          <Printer className="mr-1 h-4 w-4" /> Imprimir
        </Button>
      </div>
      {overview.data && !url && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Este local no tiene página en tu web: actívalo y ponle una dirección en Ajustes.
        </p>
      )}
      <div className="mx-auto max-w-xl rounded-lg border">{poster('')}</div>
      {mounted &&
        createPortal(<div className="facility-poster-print">{poster('')}</div>, document.body)}
    </div>
  );
}
