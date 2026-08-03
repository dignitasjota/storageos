import { Clock, CreditCard, Headset, KeyRound, Ruler, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import { ContactForm } from './contact-form';
import { OnePageNav, type OnePageNavItem } from './onepage-nav';
import { StorageCalculator } from './storage-calculator';

import type { PublicLandingDto, PublicLandingFacilityDto } from '@storageos/shared';

const SAAS_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro';

function priceWithVat(n: number): string {
  return (n * 1.21).toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
}

function citiesOf(data: PublicLandingDto): string {
  const set = [...new Set(data.facilities.map((f) => f.city).filter(Boolean))] as string[];
  return set.join(', ');
}

/** Tipos de trastero distintos (por nombre) con su área y precio de referencia. */
function distinctUnitTypes(data: PublicLandingDto) {
  const map = new Map<
    string,
    { name: string; areaM2: number | null; priceMonthly: number; available: number }
  >();
  for (const f of data.facilities) {
    for (const t of f.unitTypes) {
      const prev = map.get(t.name);
      if (!prev) {
        map.set(t.name, {
          name: t.name,
          areaM2: t.areaM2,
          priceMonthly: t.priceMonthly,
          available: t.available,
        });
      } else {
        prev.available += t.available;
        if ((t.areaM2 ?? Infinity) < (prev.areaM2 ?? Infinity)) prev.areaM2 = t.areaM2;
        if (t.priceMonthly < prev.priceMonthly) prev.priceMonthly = t.priceMonthly;
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.areaM2 ?? 0) - (b.areaM2 ?? 0));
}

const SERVICES = [
  { icon: Clock, title: 'Acceso amplio', text: 'Entra a tu trastero en un horario cómodo, tú decides cuándo.' },
  { icon: ShieldCheck, title: 'Seguridad', text: 'Instalaciones protegidas para que tus cosas estén a salvo.' },
  { icon: KeyRound, title: 'Tu acceso, fácil', text: 'Gestiona tu acceso desde el móvil, sin llaves que perder.' },
  { icon: Ruler, title: 'Tamaños a medida', text: 'Desde un armario hasta una mudanza completa: paga solo lo que usas.' },
  { icon: CreditCard, title: 'Sin permanencia', text: 'Contrata por los meses que necesites, sin ataduras.' },
  { icon: Headset, title: 'Atención cercana', text: 'Te ayudamos a elegir el trastero ideal y con lo que necesites.' },
] as const;

const DEFAULT_FAQS = [
  {
    question: '¿Cuánto cuesta alquilar un trastero?',
    answer:
      'Depende del tamaño que necesites. Puedes ver los precios por tamaño más abajo y usar la calculadora para saber qué trastero te encaja.',
  },
  {
    question: '¿Hay permanencia mínima?',
    answer: 'No. Alquilas por los meses que necesites y avisas cuando quieras darte de baja.',
  },
  {
    question: '¿Cuándo puedo acceder a mis cosas?',
    answer: 'Puedes acceder a tu trastero en el horario del local; contáctanos y te contamos los detalles.',
  },
  {
    question: '¿Cómo reservo?',
    answer: 'Puedes reservar online en minutos desde el botón «Reservar» o escribirnos y te ayudamos.',
  },
] as const;

function FacilityBlock({ f }: { f: PublicLandingFacilityDto }) {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <h3 className="text-lg font-semibold">{f.name}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {[f.address, f.postalCode, f.city].filter(Boolean).join(', ') || '—'}
      </p>
      {(f.contactPhone || f.contactEmail) && (
        <p className="mt-1 text-sm text-muted-foreground">
          {[f.contactPhone, f.contactEmail].filter(Boolean).join(' · ')}
        </p>
      )}
      {f.unitTypes.length > 0 && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {f.unitTypes.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span className="font-medium">{t.name}</span>
              <span className="font-semibold">
                desde {priceWithVat(t.priceMonthly)}
                <span className="text-xs font-normal text-muted-foreground">/mes</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Plantilla «una página»: menú superior fijo cuyos botones se deslizan a cada
 * sección (Trasteros, Espacios, Servicios, FAQ, Contacto) y «Área cliente» que
 * lleva al portal del inquilino. Es AUTOCONTENIDA (trae su propia cabecera y
 * pie); la página no la envuelve en `TenantWebChrome`.
 */
export function OnePageTemplate({ data }: { data: PublicLandingDto }) {
  const brand = data.brandColor ?? '#2563EB';
  const where = citiesOf(data);
  const trasterosLabel = `Trasteros${where ? ` en ${where}` : ''}`;
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const bookHref = `/book/${data.tenantSlug}`;
  const types = distinctUnitTypes(data);
  const faqs = data.faqs.length > 0 ? data.faqs : DEFAULT_FAQS;

  const navItems: OnePageNavItem[] = [
    { id: 'trasteros', label: trasterosLabel },
    { id: 'espacios', label: 'Espacios' },
    { id: 'servicios', label: 'Servicios' },
    { id: 'faq', label: 'FAQ' },
    { id: 'contacto', label: 'Contacto' },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <OnePageNav
        items={navItems}
        brand={brand}
        tenantName={data.tenantName}
        logoUrl={data.logoUrl}
        portalHref={portalHref}
      />

      {/* Hero */}
      <section
        className="px-4 py-20 text-center text-white sm:py-28"
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
          {data.webHeadline || trasterosLabel}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg opacity-90">
          {data.tenantName} · reserva tu trastero online en minutos.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={bookHref}
            className="inline-flex h-12 items-center rounded-full bg-white px-8 text-sm font-semibold shadow-lg transition-transform hover:scale-105"
            style={{ color: brand }}
          >
            Reservar ahora
          </Link>
          <Link
            href={portalHref}
            className="inline-flex h-12 items-center rounded-full border border-white/70 px-8 text-sm font-semibold text-white transition-colors hover:bg-white/10"
          >
            Área cliente
          </Link>
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4">
        {/* Trasteros en <ciudad> */}
        <section id="trasteros" className="scroll-mt-20 py-14">
          <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">{trasterosLabel}</h2>
          {data.webAbout && (
            <p className="mx-auto mb-8 max-w-2xl whitespace-pre-line text-center text-sm leading-relaxed text-muted-foreground">
              {data.webAbout}
            </p>
          )}
          {data.facilities.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {data.facilities.map((f) => (
                <FacilityBlock key={f.id} f={f} />
              ))}
            </div>
          ) : (
            <p className="rounded-md border bg-card px-4 py-10 text-center text-muted-foreground">
              Ahora mismo no hay disponibilidad. Vuelve pronto o contáctanos.
            </p>
          )}
        </section>

        {/* Espacios (tamaños) + calculadora */}
        <section id="espacios" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">Espacios</h2>
          <p className="mb-6 text-center text-sm text-muted-foreground">
            Elige el tamaño que necesitas. Precios con IVA incluido.
          </p>
          {types.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {types.map((t) => (
                <div key={t.name} className="rounded-lg border bg-card p-5 text-center shadow-sm">
                  <p className="text-lg font-semibold">{t.name}</p>
                  {t.areaM2 != null && (
                    <p className="text-sm text-muted-foreground">{t.areaM2} m²</p>
                  )}
                  <p className="mt-2 text-2xl font-bold" style={{ color: brand }}>
                    {priceWithVat(t.priceMonthly)}
                    <span className="text-sm font-normal text-muted-foreground">/mes</span>
                  </p>
                  <Link
                    href={bookHref}
                    className="mt-3 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-white"
                    style={{ backgroundColor: brand }}
                  >
                    Reservar
                  </Link>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4">
            <StorageCalculator data={data} brand={brand} />
          </div>
        </section>

        {/* Servicios */}
        <section id="servicios" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">Servicios</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SERVICES.map((s) => (
              <div key={s.title} className="rounded-lg border bg-card p-5 shadow-sm">
                <s.icon className="h-6 w-6" style={{ color: brand }} />
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">Preguntas frecuentes</h2>
          <div className="mx-auto max-w-2xl divide-y rounded-lg border bg-card">
            {faqs.map((f, i) => (
              <details key={i} className="group px-5 py-4">
                <summary className="cursor-pointer list-none font-medium marker:content-none">
                  {f.question}
                </summary>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {f.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* Contacto */}
        <section id="contacto" className="scroll-mt-20 border-t py-14">
          <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">Contacto</h2>
          <p className="mb-6 text-center text-sm text-muted-foreground">
            ¿Dudas? Escríbenos o pásate por el local.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              {data.facilities.map((f) => (
                <div key={f.id} className="rounded-lg border bg-card p-4 text-sm">
                  <p className="font-medium">{f.name}</p>
                  <p className="text-muted-foreground">
                    {[f.address, f.postalCode, f.city].filter(Boolean).join(', ') || '—'}
                  </p>
                  {f.contactPhone && (
                    <a href={`tel:${f.contactPhone}`} className="text-muted-foreground hover:text-foreground">
                      {f.contactPhone}
                    </a>
                  )}
                  {f.contactEmail && (
                    <a
                      href={`mailto:${f.contactEmail}`}
                      className="block text-muted-foreground hover:text-foreground"
                    >
                      {f.contactEmail}
                    </a>
                  )}
                </div>
              ))}
            </div>
            {data.contactEnabled && (
              <div>
                <ContactForm slug={data.tenantSlug} brand={brand} />
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Pie */}
      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getUTCFullYear()} {data.tenantName}
          </p>
          <div className="flex items-center gap-4">
            <Link href={portalHref} className="transition hover:text-foreground">
              Área cliente
            </Link>
            <a
              href={SAAS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition hover:text-foreground"
            >
              Creado con TrasterOS
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
