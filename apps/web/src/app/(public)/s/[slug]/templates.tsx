import { MapPin, Phone, Mail } from 'lucide-react';
import Link from 'next/link';

import type { PublicLandingDto } from '@storageos/shared';

function formatPrice(n: number): string {
  return n.toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
}

function cities(data: PublicLandingDto): string {
  const set = [...new Set(data.facilities.map((f) => f.city).filter(Boolean))] as string[];
  return set.join(', ');
}

interface TplProps {
  data: PublicLandingDto;
}

/** Selecciona la plantilla de la web pública según `data.webTemplate`. */
export function LandingTemplate({ data }: TplProps) {
  switch (data.webTemplate) {
    case 'modern':
      return <ModernTemplate data={data} />;
    case 'industrial':
      return <IndustrialTemplate data={data} />;
    default:
      return <DefaultTemplate data={data} />;
  }
}

function FacilityMeta({ f }: { f: PublicLandingDto['facilities'][number] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
      {(f.address || f.city) && (
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="h-4 w-4" />
          {[f.address, f.postalCode, f.city].filter(Boolean).join(', ')}
        </span>
      )}
      {f.contactPhone && (
        <a
          href={`tel:${f.contactPhone}`}
          className="inline-flex items-center gap-1.5 hover:text-foreground"
        >
          <Phone className="h-4 w-4" /> {f.contactPhone}
        </a>
      )}
      {f.contactEmail && (
        <a
          href={`mailto:${f.contactEmail}`}
          className="inline-flex items-center gap-1.5 hover:text-foreground"
        >
          <Mail className="h-4 w-4" /> {f.contactEmail}
        </a>
      )}
    </div>
  );
}

function UnitTypeList({ f }: { f: PublicLandingDto['facilities'][number] }) {
  if (f.unitTypes.length === 0) {
    return <p className="mt-4 text-sm text-muted-foreground">Sin disponibilidad ahora mismo.</p>;
  }
  return (
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">
      {f.unitTypes.map((t) => (
        <li
          key={t.id}
          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
        >
          <span>
            <span className="font-medium">{t.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {t.available} disponible{t.available === 1 ? '' : 's'}
            </span>
          </span>
          <span className="font-semibold">
            desde {formatPrice(t.priceMonthly * 1.21)}
            <span className="text-xs font-normal text-muted-foreground">/mes · IVA incl.</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ============================================================================
// Estándar (default) — la plantilla original, centrada y limpia
// ============================================================================

function DefaultTemplate({ data }: TplProps) {
  const where = cities(data);
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <header className="mb-10 text-center">
        {data.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.logoUrl}
            alt={data.tenantName}
            className="mx-auto mb-6 h-14 w-auto object-contain"
          />
        )}
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {data.webHeadline || `Trasteros${where ? ` en ${where}` : ''}`}
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          {data.tenantName} · consulta disponibilidad y reserva online en minutos.
        </p>
        <ReserveButton data={data} />
      </header>

      {data.webAbout && (
        <section className="mb-10 whitespace-pre-line rounded-lg border bg-card p-6 text-center text-sm leading-relaxed text-muted-foreground">
          {data.webAbout}
        </section>
      )}

      <FacilitiesGrid data={data} />
    </div>
  );
}

// ============================================================================
// Moderna — hero a color de marca a pantalla, tarjetas de local
// ============================================================================

function ModernTemplate({ data }: TplProps) {
  const where = cities(data);
  const brand = data.brandColor ?? '#2563EB';
  return (
    <div>
      <header
        className="px-4 py-16 text-center text-white sm:py-24"
        style={{ background: `linear-gradient(135deg, ${brand}, ${brand}cc)` }}
      >
        {data.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.logoUrl}
            alt={data.tenantName}
            className="mx-auto mb-6 h-16 w-auto object-contain drop-shadow"
          />
        )}
        <h1 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
          {data.webHeadline || `Trasteros${where ? ` en ${where}` : ''}`}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg opacity-90">
          {data.tenantName} · reserva tu trastero online en minutos.
        </p>
        <Link
          href={`/book/${data.tenantSlug}`}
          className="mt-8 inline-flex h-12 items-center rounded-full bg-white px-8 text-sm font-semibold shadow-lg transition-transform hover:scale-105"
          style={{ color: brand }}
        >
          Reservar ahora
        </Link>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-12">
        {data.webAbout && (
          <section className="mb-12 whitespace-pre-line text-center text-base leading-relaxed text-muted-foreground">
            {data.webAbout}
          </section>
        )}
        <FacilitiesGrid data={data} cols />
      </div>
    </div>
  );
}

// ============================================================================
// Industrial — tonos oscuros, tipografía marcada
// ============================================================================

function IndustrialTemplate({ data }: TplProps) {
  const where = cities(data);
  const brand = data.brandColor ?? '#f59e0b';
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-4xl">
          {data.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.logoUrl}
              alt={data.tenantName}
              className="mb-6 h-12 w-auto object-contain"
            />
          )}
          <p className="text-sm font-semibold uppercase tracking-widest" style={{ color: brand }}>
            {data.tenantName}
          </p>
          <h1 className="mt-3 text-4xl font-black uppercase tracking-tight sm:text-6xl">
            {data.webHeadline || `Trasteros${where ? ` en ${where}` : ''}`}
          </h1>
          <p className="mt-4 max-w-xl text-lg text-neutral-400">
            Espacio de almacenaje seguro. Reserva online en minutos.
          </p>
          <Link
            href={`/book/${data.tenantSlug}`}
            className="mt-8 inline-flex h-12 items-center px-8 text-sm font-bold uppercase tracking-wider text-neutral-950 transition-opacity hover:opacity-90"
            style={{ backgroundColor: brand }}
          >
            Reservar ahora
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-12">
        {data.webAbout && (
          <section className="mb-12 whitespace-pre-line border-l-2 pl-4 text-base leading-relaxed text-neutral-400"
            style={{ borderColor: brand }}
          >
            {data.webAbout}
          </section>
        )}
        <div className="space-y-6">
          {data.facilities.map((f) => (
            <section key={f.id} className="border border-neutral-800 bg-neutral-900 p-6">
              <h2 className="text-xl font-bold uppercase tracking-wide">{f.name}</h2>
              <FacilityMeta f={f} />
              <UnitTypeList f={f} />
              <Link
                href={f.publicSlug ? `/s/${data.tenantSlug}/${f.publicSlug}` : `/book/${data.tenantSlug}`}
                className="mt-4 inline-flex h-10 items-center border border-neutral-700 px-4 text-sm font-semibold uppercase tracking-wider transition-colors hover:bg-neutral-800"
              >
                {f.publicSlug ? `Ver ${f.name}` : `Reservar en ${f.name}`}
              </Link>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Piezas compartidas
// ============================================================================

function ReserveButton({ data }: TplProps) {
  return (
    <Link
      href={`/book/${data.tenantSlug}`}
      className="mt-6 inline-flex h-11 items-center rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90"
      style={{ backgroundColor: data.brandColor ?? 'hsl(var(--primary))' }}
    >
      Reservar ahora
    </Link>
  );
}

function FacilitiesGrid({ data, cols }: TplProps & { cols?: boolean }) {
  if (data.facilities.length === 0) {
    return (
      <p className="rounded-md border bg-card px-4 py-10 text-center text-muted-foreground">
        Ahora mismo no hay trasteros disponibles. Vuelve pronto o contáctanos.
      </p>
    );
  }
  return (
    <div className={cols ? 'grid gap-6 md:grid-cols-2' : 'space-y-6'}>
      {data.facilities.map((f) => (
        <section key={f.id} className="rounded-lg border bg-card p-6 shadow-sm">
          <h2 className="text-xl font-semibold">{f.name}</h2>
          <FacilityMeta f={f} />
          <UnitTypeList f={f} />
          <Link
            href={f.publicSlug ? `/s/${data.tenantSlug}/${f.publicSlug}` : `/book/${data.tenantSlug}`}
            className="mt-4 inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-accent"
          >
            {f.publicSlug ? `Ver ${f.name}` : `Reservar en ${f.name}`}
          </Link>
        </section>
      ))}
    </div>
  );
}
