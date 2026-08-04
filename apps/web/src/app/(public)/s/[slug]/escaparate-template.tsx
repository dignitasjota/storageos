import {
  Archive,
  Building2,
  Clock,
  CreditCard,
  Headset,
  Home,
  KeyRound,
  Package,
  Ruler,
  ShieldCheck,
  Star,
} from 'lucide-react';
import Link from 'next/link';

import { ContactForm } from './contact-form';
import { OnePageNav, type OnePageNavItem } from './onepage-nav';

import type { PublicLandingDto } from '@storageos/shared';
import type { LucideIcon } from 'lucide-react';

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

type ServiceItem = { icon: LucideIcon; title: string; text: string };
type AdvantageItem = { icon: LucideIcon; label: string };
type StepItem = { n: number; title: string; text: string };

/** Iconos fijos por posición (el tenant edita el texto, no el icono). */
const SERVICE_ICONS: LucideIcon[] = [Home, Building2, Archive, Package];
const ADVANTAGE_ICONS: LucideIcon[] = [Ruler, Clock, ShieldCheck, KeyRound, CreditCard, Headset];

/** Servicios / usos (contenido genérico; el tenant lo afina con su copy). */
const SERVICES: ServiceItem[] = [
  { icon: Home, title: 'Particulares', text: 'Mudanzas, reformas, cosas de temporada o simplemente hacer sitio en casa.' },
  { icon: Building2, title: 'Empresas', text: 'Stock, mobiliario o material de trabajo con acceso cómodo.' },
  { icon: Archive, title: 'Documentación', text: 'Guarda tu archivo de forma ordenada y segura.' },
  { icon: Package, title: 'Guardamuebles', text: 'Espacio para tus muebles el tiempo que necesites.' },
];

/** Ventajas (iconos). Genéricas; el tenant las edita en Ajustes → Web. */
const ADVANTAGES: AdvantageItem[] = [
  { icon: Ruler, label: 'Tamaños a medida' },
  { icon: Clock, label: 'Acceso amplio' },
  { icon: ShieldCheck, label: 'Instalaciones seguras' },
  { icon: KeyRound, label: 'Acceso desde el móvil' },
  { icon: CreditCard, label: 'Sin permanencia' },
  { icon: Headset, label: 'Atención cercana' },
];

const STEPS: StepItem[] = [
  { n: 1, title: 'Elige tu trastero', text: 'Mira los tamaños y precios y quédate con el que encaje.' },
  { n: 2, title: 'Reserva online', text: 'Contrata en minutos desde la web, sin papeleo.' },
  { n: 3, title: 'Accede cuando quieras', text: 'Recibe tu acceso y empieza a usar tu trastero.' },
];

/**
 * Plantilla premium «Escaparate»: web multisección (hero + servicios + centros +
 * ventajas + opiniones + pasos + contacto), con la MISMA estructura/estilo de una
 * web corporativa de self-storage pero con el CONTENIDO del tenant (su color de
 * marca, las imágenes de sus locales y sus textos). Autocontenida (menú + pie
 * propios); la página no la envuelve en `TenantWebChrome`.
 */
export function EscaparateTemplate({ data }: { data: PublicLandingDto }) {
  const brand = data.brandColor ?? '#2BA84A';
  const where = citiesOf(data);
  const trasterosLabel = `Trasteros${where ? ` en ${where}` : ''}`;
  const portalHref = `/portal/login?slug=${encodeURIComponent(data.tenantSlug)}`;
  const bookHref = `/book/${data.tenantSlug}`;
  const heroImage = data.facilities.flatMap((f) => f.imageUrls)[0] ?? null;
  const hasReviews = data.testimonials.length > 0;

  // Copy editable por el tenant (Ajustes → Web). Vacío → textos por defecto.
  const content = data.webContent;
  const heroSubtitle =
    content?.heroSubtitle?.trim() ||
    `${data.tenantName} · tu espacio extra, fácil y sin complicaciones.`;
  const svcCustom = (content?.services ?? [])
    .filter((s) => s.title.trim())
    .map((s, i) => ({
      icon: SERVICE_ICONS[i % SERVICE_ICONS.length]!,
      title: s.title,
      text: s.text ?? '',
    }));
  const services: ServiceItem[] = svcCustom.length > 0 ? svcCustom : SERVICES;
  const advCustom = (content?.advantages ?? [])
    .filter((a) => a.trim())
    .map((label, i) => ({ icon: ADVANTAGE_ICONS[i % ADVANTAGE_ICONS.length]!, label }));
  const advantages: AdvantageItem[] = advCustom.length > 0 ? advCustom : ADVANTAGES;
  const stepCustom = (content?.steps ?? [])
    .filter((s) => s.title.trim())
    .map((s, i) => ({ n: i + 1, title: s.title, text: s.text ?? '' }));
  const steps: StepItem[] = stepCustom.length > 0 ? stepCustom : STEPS;

  const navItems: OnePageNavItem[] = [
    { id: 'servicios', label: 'Servicios' },
    { id: 'centros', label: 'Centros' },
    { id: 'ventajas', label: 'Ventajas' },
    ...(hasReviews ? [{ id: 'opiniones', label: 'Opiniones' }] : []),
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

      {/* Hero moderado con imagen de fondo (o gradiente de marca si no hay) */}
      <section className="relative isolate overflow-hidden px-4 py-24 text-center text-white sm:py-28">
        {heroImage ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroImage}
              alt=""
              aria-hidden
              className="absolute inset-0 -z-10 h-full w-full object-cover"
            />
            <div className="absolute inset-0 -z-10 bg-black/55" />
          </>
        ) : (
          <div
            className="absolute inset-0 -z-10"
            style={{ background: `linear-gradient(135deg, ${brand}, ${brand}cc)` }}
          />
        )}
        <h1 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
          {data.webHeadline || trasterosLabel}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg opacity-95">{heroSubtitle}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href={bookHref}
            className="inline-flex h-12 items-center rounded-md px-8 text-sm font-semibold text-white shadow-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: brand }}
          >
            Reservar ahora
          </Link>
          <Link
            href={portalHref}
            className="inline-flex h-12 items-center rounded-md bg-white px-8 text-sm font-semibold text-neutral-900 shadow-lg transition-transform hover:scale-105"
          >
            Área cliente
          </Link>
        </div>
      </section>

      <div className="flex-1">
        {/* Servicios */}
        <section id="servicios" className="scroll-mt-20 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">Nuestros servicios</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {services.map((s) => (
                <div key={s.title} className="rounded-lg border bg-card p-6 text-center shadow-sm">
                  <div
                    className="mx-auto flex h-12 w-12 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${brand}1a`, color: brand }}
                  >
                    <s.icon className="h-6 w-6" />
                  </div>
                  <h3 className="mt-3 font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Centros / localizaciones */}
        <section id="centros" className="scroll-mt-20 bg-muted/40 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">
              {where ? `Centros en ${where}` : 'Nuestros centros'}
            </h2>
            {data.facilities.length > 0 ? (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {data.facilities.map((f) => {
                  const img = f.imageUrls[0] ?? null;
                  const cheapest = f.unitTypes.reduce<number | null>(
                    (min, t) => (min === null ? t.priceMonthly : Math.min(min, t.priceMonthly)),
                    null,
                  );
                  const href = f.publicSlug ? `/s/${data.tenantSlug}/${f.publicSlug}` : bookHref;
                  return (
                    <Link
                      key={f.id}
                      href={href}
                      className="group overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md"
                    >
                      <div className="aspect-[16/10] w-full overflow-hidden bg-muted">
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={img}
                            alt={f.name}
                            className="h-full w-full object-cover transition-transform group-hover:scale-105"
                          />
                        ) : (
                          <div
                            className="h-full w-full"
                            style={{ background: `linear-gradient(135deg, ${brand}22, ${brand}66)` }}
                          />
                        )}
                      </div>
                      <div className="p-4">
                        <h3 className="font-semibold">{f.name}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {[f.address, f.city].filter(Boolean).join(', ') || '—'}
                        </p>
                        {cheapest !== null && (
                          <p className="mt-2 text-sm font-semibold" style={{ color: brand }}>
                            desde {priceWithVat(cheapest)}/mes
                          </p>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-md border bg-card px-4 py-10 text-center text-muted-foreground">
                Ahora mismo no hay disponibilidad. Contáctanos y te avisamos.
              </p>
            )}
          </div>
        </section>

        {/* Ventajas */}
        <section id="ventajas" className="scroll-mt-20 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">Por qué elegirnos</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              {advantages.map((a) => (
                <div key={a.label} className="flex flex-col items-center gap-2 text-center">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${brand}1a`, color: brand }}
                  >
                    <a.icon className="h-6 w-6" />
                  </div>
                  <span className="text-sm font-medium">{a.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Opiniones (si hay reseñas) */}
        {hasReviews && (
          <section id="opiniones" className="scroll-mt-20 bg-muted/40 py-16">
            <div className="mx-auto max-w-6xl px-4">
              <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">
                Lo que dicen nuestros clientes
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.testimonials.map((t, i) => (
                  <figure key={i} className="rounded-lg border bg-card p-5 shadow-sm">
                    <div className="flex items-center gap-0.5">
                      {Array.from({ length: t.rating ?? 5 }).map((_, s) => (
                        <Star
                          key={s}
                          className="h-4 w-4 fill-current"
                          style={{ color: '#f59e0b' }}
                        />
                      ))}
                    </div>
                    <blockquote className="mt-2 text-sm leading-relaxed">{t.comment}</blockquote>
                    <figcaption className="mt-3 text-xs font-medium text-muted-foreground">
                      {t.author}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Banda CTA */}
        <section className="px-4 py-14 text-center text-white" style={{ backgroundColor: brand }}>
          <h2 className="text-2xl font-bold tracking-tight">¿Listo para tu trastero?</h2>
          <p className="mx-auto mt-2 max-w-xl opacity-95">
            Reserva online en minutos y accede a tu espacio cuando lo necesites.
          </p>
          <Link
            href={bookHref}
            className="mt-6 inline-flex h-12 items-center rounded-md bg-white px-8 text-sm font-semibold text-neutral-900 shadow-lg transition-transform hover:scale-105"
          >
            Reservar ahora
          </Link>
        </section>

        {/* Pasos para contratar */}
        <section id="contratar" className="scroll-mt-20 py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mb-10 text-center text-2xl font-bold tracking-tight">
              Contratar es muy fácil
            </h2>
            <div className="grid gap-6 sm:grid-cols-3">
              {steps.map((s) => (
                <div key={s.n} className="text-center">
                  <div
                    className="mx-auto flex h-12 w-12 items-center justify-center rounded-full text-lg font-bold text-white"
                    style={{ backgroundColor: brand }}
                  >
                    {s.n}
                  </div>
                  <h3 className="mt-3 font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Contacto */}
        <section id="contacto" className="scroll-mt-20 bg-muted/40 py-16">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="mb-2 text-center text-2xl font-bold tracking-tight">Contacto</h2>
            <p className="mb-8 text-center text-sm text-muted-foreground">
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
                      <a
                        href={`tel:${f.contactPhone}`}
                        className="text-muted-foreground hover:text-foreground"
                      >
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
