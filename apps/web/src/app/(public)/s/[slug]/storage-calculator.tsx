'use client';

import {
  STORAGE_ITEMS,
  STORAGE_PRESETS,
  computeStorageM2,
  recommendStorageUnit,
  type PublicLandingDto,
  type StorageItemCategory,
} from '@storageos/shared';
import {
  Archive,
  Armchair,
  Bed,
  BedDouble,
  BedSingle,
  Bike,
  Box,
  Boxes,
  Calculator,
  Container,
  DoorClosed,
  Frame,
  LampDesk,
  Library,
  Luggage,
  Microwave,
  Minus,
  Package,
  Plus,
  Refrigerator,
  RotateCcw,
  Sofa,
  Tv,
  UtensilsCrossed,
  WashingMachine,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import { trackEvent } from './google-analytics';
import { bookHrefFor, intlLocaleFor, type PublicWebLocale } from './i18n/messages';
import { grossPrice } from './price-format';
import { themeFor } from './promo/promo-theme';

const CATEGORY_ORDER: StorageItemCategory[] = ['muebles', 'electrodomesticos', 'cajas', 'otros'];

const ITEM_ICONS: Record<string, LucideIcon> = {
  sofa_2: Sofa,
  sofa_3: Sofa,
  cama_ind: BedSingle,
  cama_doble: BedDouble,
  colchon: Bed,
  armario: DoorClosed,
  comoda: Archive,
  mesa: UtensilsCrossed,
  silla: Armchair,
  estanteria: Library,
  escritorio: LampDesk,
  nevera: Refrigerator,
  lavadora: WashingMachine,
  tv: Tv,
  microondas: Microwave,
  caja_p: Package,
  caja_m: Box,
  caja_g: Boxes,
  maleta: Luggage,
  bici: Bike,
  moto: Bike,
  electrodomestico_grande: Container,
  cuadro: Frame,
  herramientas: Wrench,
};

function formatPrice(n: number, locale: PublicWebLocale): string {
  return n.toLocaleString(intlLocaleFor(locale), {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
}

/**
 * Calculadora de espacio (gratis en toda web `/s/[slug]`): atajos para
 * empezar, objetos por pestañas con icono, m² en vivo con los tamaños del
 * local en una barra y el trastero recomendado con su precio. Toma los rasgos
 * de la plantilla (color, esquinas, mayúsculas, fondo oscuro).
 */
export function StorageCalculator({
  data,
  brand,
  locale,
}: {
  data: PublicLandingDto;
  brand: string;
  locale: PublicWebLocale;
}) {
  const t = useTranslations('publicWeb.calculator');
  const tCommon = useTranslations('publicWeb.common');
  const theme = themeFor(data.webTemplate, brand);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<StorageItemCategory>('muebles');
  const [preset, setPreset] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Móvil: el resumen flotante solo mientras se ven los objetos y no el resultado.
  const [gridInView, setGridInView] = useState(false);
  const [resultInView, setResultInView] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === gridRef.current) setGridInView(e.isIntersecting);
        if (e.target === resultRef.current) setResultInView(e.isIntersecting);
      }
    });
    if (gridRef.current) obs.observe(gridRef.current);
    if (resultRef.current) obs.observe(resultRef.current);
    return () => obs.disconnect();
  }, []);

  const m2 = useMemo(() => computeStorageM2(qty), [qty]);
  const nf = (n: number) =>
    n.toLocaleString(intlLocaleFor(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  // Tipos disponibles con área, deduplicados por nombre (el menor precio/área).
  // `unitTypeId`/`facilityId` viajan con la recomendación para preseleccionar
  // la elección en el formulario de reserva (evita que el visitante la repita).
  const unitTypes = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        areaM2: number | null;
        priceMonthly: number;
        available: number;
        unitTypeId: string;
        facilityId: string;
      }
    >();
    for (const f of data.facilities) {
      for (const ut of f.unitTypes) {
        const prev = map.get(ut.name);
        if (!prev || (ut.areaM2 ?? Infinity) < (prev.areaM2 ?? Infinity)) {
          map.set(ut.name, {
            name: ut.name,
            areaM2: ut.areaM2,
            priceMonthly: ut.priceMonthly,
            available: (prev?.available ?? 0) + ut.available,
            unitTypeId: ut.id,
            facilityId: f.id,
          });
        } else {
          prev.available += ut.available;
        }
      }
    }
    return [...map.values()];
  }, [data.facilities]);

  // Tamaños del local para la barra (m² distintos, de menor a mayor).
  const sizes = useMemo(
    () =>
      [...new Set(unitTypes.map((u) => u.areaM2).filter((a): a is number => !!a && a > 0))].sort(
        (a, b) => a - b,
      ),
    [unitTypes],
  );

  const recommendation = useMemo(
    () => (m2 > 0 ? recommendStorageUnit(m2, unitTypes) : null),
    [m2, unitTypes],
  );

  // Evento de conversión: cuando aparece una recomendación nueva (no en cada
  // render mientras se sigue ajustando el mismo tamaño).
  const lastTracked = useRef<string | null>(null);
  useEffect(() => {
    const name = recommendation?.name ?? null;
    if (name && name !== lastTracked.current) {
      lastTracked.current = name;
      trackEvent('calculator_recommendation_shown', { unitType: name });
    }
  }, [recommendation]);

  function change(key: string, delta: number) {
    setPreset(null);
    setQty((q) => {
      const next = Math.max(0, (q[key] ?? 0) + delta);
      const copy = { ...q };
      if (next === 0) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }

  function applyPreset(key: string) {
    const p = STORAGE_PRESETS.find((x) => x.key === key);
    if (!p) return;
    setQty({ ...p.items });
    setPreset(key);
    trackEvent('calculator_preset', { preset: key });
  }

  const label = (key: string) => t(`items.${key}`);
  const countIn = (cat: StorageItemCategory) =>
    STORAGE_ITEMS.filter((i) => i.category === cat).reduce((n, i) => n + (qty[i.key] ?? 0), 0);
  const chosen = STORAGE_ITEMS.filter((i) => (qty[i.key] ?? 0) > 0);
  const hasItems = m2 > 0;

  // Estilos según la plantilla.
  const dark = theme.dark;
  const card = dark ? 'border-neutral-800 bg-neutral-900' : 'bg-card';
  const muted = dark ? 'text-neutral-400' : 'text-muted-foreground';
  const upper = theme.upper ? 'uppercase tracking-wide' : '';

  // Barra de tamaños: escala hasta el mayor tamaño o lo que lleva (con margen).
  const scaleMax = Math.max(sizes[sizes.length - 1] ?? 0, m2) * 1.1 || 1;
  const pct = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`;

  const result = (
    <div className={`border p-6 shadow-sm ${theme.radius} ${card}`}>
      <p className={`text-sm ${muted}`}>{t('spaceNeeded')}</p>
      <p className="mt-1 text-4xl font-bold tabular-nums" style={{ color: brand }}>
        {nf(m2)}
        <span className={`ml-1 text-lg font-normal ${muted}`}>m²</span>
      </p>

      {sizes.length > 0 && (
        <div className="mt-4" aria-hidden="true">
          <div className={`relative h-2 rounded-full ${dark ? 'bg-neutral-800' : 'bg-muted'}`}>
            {hasItems && (
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all"
                style={{ width: pct(m2), backgroundColor: brand }}
              />
            )}
            {sizes.map((s) => (
              <span
                key={s}
                className={`absolute top-1/2 h-3 w-0.5 -translate-y-1/2 ${
                  dark ? 'bg-neutral-500' : 'bg-foreground/40'
                }`}
                style={{ left: pct(s) }}
              />
            ))}
          </div>
          <div className={`relative mt-1 h-4 text-[10px] tabular-nums ${muted}`}>
            {sizes.map((s) => (
              <span key={s} className="absolute -translate-x-1/2" style={{ left: pct(s) }}>
                {s.toLocaleString(intlLocaleFor(locale))}
              </span>
            ))}
          </div>
          <p className={`mt-1 text-[11px] ${muted}`}>{t('sizesHint')}</p>
        </div>
      )}

      {!hasItems ? (
        <p className={`mt-4 text-sm ${muted}`}>{t('emptyState')}</p>
      ) : recommendation ? (
        <div
          className={`mt-4 border p-4 ${theme.radius} ${dark ? 'border-neutral-700' : 'bg-background'}`}
        >
          <p className={`text-xs ${muted} uppercase tracking-wide`}>{t('recommended')}</p>
          <p className="mt-1 text-lg font-semibold">{recommendation.name}</p>
          <p className={`text-sm ${muted}`}>
            {recommendation.areaM2 != null ? `${recommendation.areaM2} m² · ` : ''}
            {tCommon('from')} {formatPrice(grossPrice(recommendation), locale)}
            {t('perMonth')}
          </p>
          {recommendation.areaM2 != null && (
            <p className={`mt-1 text-xs ${muted}`}>
              {recommendation.areaM2 >= m2
                ? recommendation.areaM2 - m2 < 1
                  ? t('fitTight')
                  : t('fitRoom')
                : t('fitShort')}
            </p>
          )}
          <Link
            href={bookHrefFor(data, locale, {
              facilityId: recommendation.facilityId,
              unitTypeId: recommendation.unitTypeId,
            })}
            onClick={() => trackEvent('cta_reservar_click', { location: 'calculator' })}
            className={`mt-3 inline-flex h-10 w-full items-center justify-center px-4 text-sm font-semibold text-white shadow transition-opacity hover:opacity-90 ${theme.button} ${upper}`}
            style={{ backgroundColor: brand }}
          >
            {t('reserveThis')}
          </Link>
        </div>
      ) : (
        <p className={`mt-4 text-sm ${muted}`}>{t('noMatch')}</p>
      )}

      {chosen.length > 0 && (
        <div className="mt-5">
          <p className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>
            {t('yourItems')}
          </p>
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1 text-sm">
            {chosen.map((i) => (
              <li key={i.key} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {label(i.key)} <span className={muted}>× {qty[i.key]}</span>
                </span>
                <button
                  type="button"
                  aria-label={t('removeItem', { label: label(i.key) })}
                  onClick={() => change(i.key, -1)}
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                    dark ? 'border-neutral-700' : ''
                  }`}
                >
                  <Minus className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasItems && (
        <button
          type="button"
          onClick={() => {
            setQty({});
            setPreset(null);
          }}
          className={`mt-4 inline-flex items-center gap-1 text-xs ${muted} hover:opacity-80`}
        >
          <RotateCcw className="h-3 w-3" /> {t('reset')}
        </button>
      )}
      <p className={`mt-4 text-[11px] leading-tight ${muted}`}>{t('disclaimer')}</p>
    </div>
  );

  return (
    <section id="calculadora" className="mt-14 scroll-mt-20">
      <div className="mb-6 text-center">
        <h2
          className={`flex items-center justify-center gap-2 text-2xl font-bold tracking-tight ${
            theme.upper ? 'uppercase' : ''
          }`}
        >
          <Calculator className="h-6 w-6" style={{ color: brand }} />
          {t('title')}
        </h2>
        <p className={`mt-2 text-sm ${muted}`}>{t('subtitle')}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div ref={gridRef} className="min-w-0 lg:col-span-2">
          {/* Atajos */}
          <p className={`mb-2 text-xs font-semibold uppercase tracking-wide ${muted}`}>
            {t('presetsTitle')}
          </p>
          <div className="mb-5 flex flex-wrap gap-2">
            {STORAGE_PRESETS.map((p) => {
              const active = preset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => applyPreset(p.key)}
                  aria-pressed={active}
                  className={`border px-4 py-2 text-sm font-medium transition-colors ${theme.button} ${
                    active
                      ? 'text-white'
                      : dark
                        ? 'border-neutral-700 hover:bg-neutral-800'
                        : 'hover:bg-accent'
                  }`}
                  style={active ? { backgroundColor: brand, borderColor: brand } : undefined}
                >
                  {t(`presets.${p.key}`)}
                </button>
              );
            })}
          </div>

          {/* Pestañas */}
          <div
            role="tablist"
            className={`mb-4 flex gap-1 overflow-x-auto border-b ${dark ? 'border-neutral-800' : ''}`}
          >
            {CATEGORY_ORDER.map((cat) => {
              const active = tab === cat;
              const n = countIn(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(cat)}
                  className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
                    active ? '' : `border-transparent ${muted} hover:opacity-80`
                  }`}
                  style={active ? { borderColor: brand, color: brand } : undefined}
                >
                  {t(`categories.${cat}`)}
                  {n > 0 && (
                    <span
                      className="rounded-full px-1.5 text-[11px] font-bold tabular-nums text-white"
                      style={{ backgroundColor: brand }}
                    >
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Objetos de la pestaña */}
          <div role="tabpanel" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {STORAGE_ITEMS.filter((i) => i.category === tab).map((item) => {
              const count = qty[item.key] ?? 0;
              const Icon = ITEM_ICONS[item.key] ?? Package;
              return (
                <div
                  key={item.key}
                  className={`relative flex flex-col items-center border p-3 text-center transition-colors ${theme.radius} ${
                    dark ? 'border-neutral-800 bg-neutral-900' : 'bg-card'
                  }`}
                  style={count > 0 ? { borderColor: brand } : undefined}
                >
                  <button
                    type="button"
                    onClick={() => change(item.key, 1)}
                    aria-label={t('addItem', { label: label(item.key) })}
                    className="flex w-full flex-col items-center gap-2 pb-1"
                  >
                    <span
                      className="flex h-12 w-12 items-center justify-center rounded-full"
                      style={{
                        backgroundColor: count > 0 ? brand : `${brand}1a`,
                        color: count > 0 ? '#fff' : brand,
                      }}
                    >
                      <Icon className="h-6 w-6" />
                    </span>
                    <span className="text-sm font-medium leading-tight">{label(item.key)}</span>
                  </button>
                  {/* Siempre ocupa su sitio: todas las tarjetas miden igual. */}
                  {
                    <div
                      className={`mt-2 flex items-center gap-2 ${count > 0 ? '' : 'invisible'}`}
                      inert={count === 0}
                    >
                      <button
                        type="button"
                        aria-label={t('removeItem', { label: label(item.key) })}
                        onClick={() => change(item.key, -1)}
                        className={`flex h-7 w-7 items-center justify-center rounded-full border ${
                          dark ? 'border-neutral-700' : ''
                        }`}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-5 text-center font-semibold tabular-nums">{count}</span>
                      <button
                        type="button"
                        aria-label={t('addItem', { label: label(item.key) })}
                        onClick={() => change(item.key, 1)}
                        className={`flex h-7 w-7 items-center justify-center rounded-full border ${
                          dark ? 'border-neutral-700' : ''
                        }`}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  }
                </div>
              );
            })}
          </div>
        </div>

        {/* Resultado (fijo en escritorio) */}
        <div ref={resultRef} className="scroll-mt-24 lg:sticky lg:top-24 lg:self-start">
          {result}
        </div>
      </div>

      {/* Móvil: resumen flotante mientras se eligen objetos */}
      {hasItems && gridInView && !resultInView && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center px-4 lg:hidden">
          <button
            type="button"
            onClick={() =>
              resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className={`pointer-events-auto flex items-center gap-3 px-5 py-3 text-sm font-semibold text-white shadow-lg ${theme.button}`}
            style={{ backgroundColor: brand }}
          >
            <span className="tabular-nums">{nf(m2)} m²</span>
            {recommendation && <span className="opacity-90">· {recommendation.name}</span>}
            <span className="underline underline-offset-2">{t('seeResult')}</span>
          </button>
        </div>
      )}
    </section>
  );
}
