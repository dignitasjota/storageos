'use client';

import {
  PROMO_CTA_ACTIONS,
  PROMO_CTA_ACTION_LABELS,
  PROMO_SECTION_LABELS,
  promoSectionOrder,
  type PromoCtaAction,
  type PromoLandingContent,
  type PromoSectionKey,
} from '@storageos/shared';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm';

type Setter = (fn: (c: PromoLandingContent) => PromoLandingContent) => void;

/** Campo de texto con contador opcional. */
export function Field({
  id,
  label,
  value,
  onChange,
  max,
  multiline,
  rows = 3,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea
          id={id}
          rows={rows}
          maxLength={max}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          id={id}
          maxLength={max}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Lista de textos cortos, una por línea (las vacías se ignoran al guardar). */
function LinesField({
  id,
  label,
  value,
  onChange,
  max,
  hint,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  max: number;
  hint?: string;
}) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={Math.min(Math.max(value.length + 1, 3), 8)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, max),
          );
        }}
      />
      <p className="mt-1 text-xs text-muted-foreground">{hint ?? `Una por línea, hasta ${max}.`}</p>
    </div>
  );
}

/** Botón: texto y qué hace (nunca una dirección libre). */
function CtaField({
  id,
  label,
  value,
  onChange,
  optional,
  whatsappAvailable,
}: {
  id: string;
  label: string;
  value: { label: string; action: PromoCtaAction } | null;
  onChange: (v: { label: string; action: PromoCtaAction } | null) => void;
  optional?: boolean;
  whatsappAvailable: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
      <div>
        <Label htmlFor={`${id}-label`}>{label}</Label>
        <Input
          id={`${id}-label`}
          maxLength={40}
          value={value?.label ?? ''}
          placeholder={optional ? 'Sin botón' : ''}
          onChange={(e) =>
            onChange(
              e.target.value
                ? { label: e.target.value, action: value?.action ?? 'book' }
                : optional
                  ? null
                  : { label: '', action: value?.action ?? 'book' },
            )
          }
        />
      </div>
      <div>
        <Label htmlFor={`${id}-action`}>Al pulsarlo</Label>
        <select
          id={`${id}-action`}
          className={selectClass}
          value={value?.action ?? 'book'}
          disabled={!value}
          onChange={(e) =>
            value && onChange({ ...value, action: e.target.value as PromoCtaAction })
          }
        >
          {PROMO_CTA_ACTIONS.map((a) => (
            <option key={a} value={a} disabled={a === 'whatsapp' && !whatsappAvailable}>
              {PROMO_CTA_ACTION_LABELS[a]}
              {a === 'whatsapp' && !whatsappAvailable ? ' (sin WhatsApp activo)' : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Filas repetibles (ventajas, pasos, preguntas). */
function Rows<T extends Record<string, string>>({
  items,
  onChange,
  max,
  empty,
  fields,
  addLabel,
}: {
  items: T[];
  onChange: (v: T[]) => void;
  max: number;
  empty: T;
  fields: {
    key: keyof T & string;
    label: string;
    max: number;
    multiline?: boolean;
    width?: string;
  }[];
  addLabel: string;
}) {
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 rounded-md border p-3">
          <div className="grid flex-1 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
            {fields.map((f) => (
              <div key={f.key} className={f.width}>
                <Label className="text-xs">{f.label}</Label>
                {f.multiline ? (
                  <Textarea
                    rows={2}
                    maxLength={f.max}
                    value={item[f.key]}
                    onChange={(e) =>
                      onChange(
                        items.map((x, j) => (j === i ? { ...x, [f.key]: e.target.value } : x)),
                      )
                    }
                  />
                ) : (
                  <Input
                    maxLength={f.max}
                    value={item[f.key]}
                    onChange={(e) =>
                      onChange(
                        items.map((x, j) => (j === i ? { ...x, [f.key]: e.target.value } : x)),
                      )
                    }
                  />
                )}
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Quitar"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {items.length < max && (
        <Button variant="outline" size="sm" onClick={() => onChange([...items, { ...empty }])}>
          <Plus className="mr-1 h-4 w-4" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}

/** Antetítulo, título y texto de un bloque. */
function HeadFields({
  prefix,
  value,
  onChange,
  description = true,
}: {
  prefix: string;
  value: { eyebrow: string; title: string; description?: string };
  onChange: (v: { eyebrow?: string; title?: string; description?: string }) => void;
  description?: boolean;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id={`${prefix}-eyebrow`}
          label="Antetítulo"
          max={60}
          value={value.eyebrow}
          onChange={(eyebrow) => onChange({ eyebrow })}
        />
        <Field
          id={`${prefix}-title`}
          label="Título"
          max={120}
          value={value.title}
          onChange={(title) => onChange({ title })}
        />
      </div>
      {description && (
        <Field
          id={`${prefix}-desc`}
          label="Texto"
          max={400}
          multiline
          rows={2}
          value={value.description ?? ''}
          onChange={(d) => onChange({ description: d })}
        />
      )}
    </>
  );
}

/** Tarjeta de un bloque: interruptor, subir/bajar y sus campos (plegables). */
function BlockCard({
  title,
  enabled,
  onToggle,
  onUp,
  onDown,
  note,
  children,
}: {
  title: string;
  enabled: boolean;
  onToggle?: (v: boolean) => void;
  onUp?: () => void;
  onDown?: () => void;
  note?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-lg border ${enabled ? '' : 'bg-muted/40'}`}>
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 text-left text-sm font-semibold"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title}
          {!enabled && <span className="text-xs font-normal text-muted-foreground">(oculto)</span>}
        </button>
        {onToggle && (
          <label className="flex items-center gap-1.5 text-xs">
            <Checkbox checked={enabled} onCheckedChange={(v) => onToggle(v === true)} />
            Mostrar
          </label>
        )}
        {onUp && (
          <Button variant="ghost" size="icon" aria-label="Subir" onClick={onUp}>
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
        {onDown && (
          <Button variant="ghost" size="icon" aria-label="Bajar" onClick={onDown}>
            <ArrowDown className="h-4 w-4" />
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t p-3">
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Editor del contenido de la landing: barra, portada, oferta y los bloques
 * reordenables. Solo textos: los colores y la forma salen de la plantilla.
 */
export function PromoContentEditor({
  content,
  setContent,
  sizes,
  whatsappAvailable,
  hasCoupon,
}: {
  content: PromoLandingContent;
  setContent: Setter;
  /** Tamaños de la landing (para su texto propio). */
  sizes: { id: string; name: string }[];
  whatsappAvailable: boolean;
  hasCoupon: boolean;
}) {
  const c = content;
  const patch = <K extends keyof PromoLandingContent>(k: K, v: Partial<PromoLandingContent[K]>) =>
    setContent((cur) => ({ ...cur, [k]: { ...(cur[k] as object), ...v } }));
  const order = promoSectionOrder(c.order);
  const move = (k: PromoSectionKey, dir: -1 | 1) =>
    setContent((cur) => {
      const o = promoSectionOrder(cur.order);
      const i = o.indexOf(k);
      const j = i + dir;
      if (j < 0 || j >= o.length) return cur;
      [o[i], o[j]] = [o[j]!, o[i]!];
      return { ...cur, order: o };
    });

  const blockBody: Record<PromoSectionKey, React.ReactNode> = {
    benefits: (
      <>
        <HeadFields prefix="pb" value={c.benefits} onChange={(v) => patch('benefits', v)} />
        <Rows
          items={c.benefits.items}
          onChange={(items) => patch('benefits', { items })}
          max={6}
          empty={{ icon: '', title: '', description: '' }}
          addLabel="Añadir ventaja"
          fields={[
            { key: 'icon', label: 'Icono (emoji)', max: 8, width: 'sm:max-w-[110px]' },
            { key: 'title', label: 'Título', max: 60 },
            { key: 'description', label: 'Texto', max: 240, multiline: true },
          ]}
        />
      </>
    ),
    sizes: (
      <>
        <HeadFields prefix="ps" value={c.sizes} onChange={(v) => patch('sizes', v)} />
        <p className="text-xs text-muted-foreground">
          El precio y la disponibilidad son los reales de cada tamaño. Puedes añadir un texto a cada
          uno («Ideal para los muebles de un estudio»…).
        </p>
        {sizes.map((s) => (
          <Field
            key={s.id}
            id={`ps-${s.id}`}
            label={s.name}
            max={160}
            value={c.sizes.descriptions[s.id] ?? ''}
            onChange={(v) =>
              patch('sizes', {
                descriptions: Object.fromEntries(
                  Object.entries({ ...c.sizes.descriptions, [s.id]: v }).filter(([, t]) => t),
                ),
              })
            }
          />
        ))}
      </>
    ),
    steps: (
      <>
        <HeadFields
          prefix="pst"
          value={c.steps}
          onChange={(v) => patch('steps', v)}
          description={false}
        />
        <Rows
          items={c.steps.items}
          onChange={(items) => patch('steps', { items })}
          max={6}
          empty={{ title: '', description: '' }}
          addLabel="Añadir paso"
          fields={[
            { key: 'title', label: 'Paso', max: 80 },
            { key: 'description', label: 'Texto', max: 240, multiline: true },
          ]}
        />
      </>
    ),
    promotion: (
      <>
        <HeadFields prefix="pp" value={c.promotion} onChange={(v) => patch('promotion', v)} />
        <Field
          id="pp-panel-title"
          label="Título del recuadro"
          max={120}
          value={c.promotion.panelTitle}
          onChange={(panelTitle) => patch('promotion', { panelTitle })}
        />
        <Field
          id="pp-panel-text"
          label="Texto del recuadro"
          max={1000}
          multiline
          rows={3}
          value={c.promotion.panelText}
          onChange={(panelText) => patch('promotion', { panelText })}
        />
        <Field
          id="pp-terms"
          label="Letra pequeña"
          max={400}
          multiline
          rows={2}
          value={c.promotion.terms}
          onChange={(terms) => patch('promotion', { terms })}
        />
        <Field
          id="pp-cond-link"
          label="Enlace a las condiciones"
          max={60}
          value={c.promotion.conditionsLink}
          onChange={(conditionsLink) => patch('promotion', { conditionsLink })}
          hint="Solo se ve si el bloque de condiciones está visible."
        />
        <CtaField
          id="pp-cta"
          label="Botón"
          value={c.promotion.cta}
          onChange={(cta) => cta && patch('promotion', { cta })}
          whatsappAvailable={whatsappAvailable}
        />
      </>
    ),
    conditions: (
      <>
        <HeadFields prefix="pc" value={c.conditions} onChange={(v) => patch('conditions', v)} />
        <LinesField
          id="pc-items"
          label="Condiciones"
          max={12}
          value={c.conditions.items}
          onChange={(items) => patch('conditions', { items })}
          hint="Una por línea, hasta 12. Pon lo que diga tu cupón: el descuento se comprueba al reservar."
        />
        <Field
          id="pc-closing"
          label="Texto final"
          max={600}
          multiline
          rows={2}
          value={c.conditions.closing}
          onChange={(closing) => patch('conditions', { closing })}
        />
        <CtaField
          id="pc-cta"
          label="Botón (opcional)"
          optional
          value={c.conditions.cta}
          onChange={(cta) => patch('conditions', { cta })}
          whatsappAvailable={whatsappAvailable}
        />
      </>
    ),
    testimonials: (
      <Field
        id="pt-title"
        label="Título"
        max={120}
        value={c.testimonials.title}
        onChange={(title) => patch('testimonials', { title })}
        hint="Se muestran las opiniones publicadas en tu web (si las hay)."
      />
    ),
    faq: (
      <>
        <HeadFields
          prefix="pf"
          value={c.faq}
          onChange={(v) => patch('faq', v)}
          description={false}
        />
        <Rows
          items={c.faq.items}
          onChange={(items) => patch('faq', { items })}
          max={12}
          empty={{ question: '', answer: '' }}
          addLabel="Añadir pregunta"
          fields={[
            { key: 'question', label: 'Pregunta', max: 200 },
            { key: 'answer', label: 'Respuesta', max: 1500, multiline: true },
          ]}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={c.faq.useBusinessFaq}
            onCheckedChange={(v) => patch('faq', { useBusinessFaq: v === true })}
          />
          Sin preguntas propias, usar las de tu centro de ayuda
        </label>
      </>
    ),
    contact: (
      <>
        <HeadFields prefix="pk" value={c.contact} onChange={(v) => patch('contact', v)} />
        <LinesField
          id="pk-trust"
          label="Puntos a la izquierda del formulario"
          max={4}
          value={c.contact.trust}
          onChange={(trust) => patch('contact', { trust })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="pk-button"
            label="Texto del botón"
            max={40}
            value={c.contact.buttonLabel}
            onChange={(buttonLabel) => patch('contact', { buttonLabel })}
          />
          <Field
            id="pk-success"
            label="Mensaje al enviar"
            max={200}
            value={c.contact.successMessage}
            onChange={(successMessage) => patch('contact', { successMessage })}
          />
        </div>
        <Field
          id="pk-legal"
          label="Texto legal bajo el botón (opcional)"
          max={400}
          multiline
          rows={2}
          value={c.contact.legal}
          onChange={(legal) => patch('contact', { legal })}
        />
        <p className="text-xs text-muted-foreground">
          Pide nombre y teléfono (el email es opcional) y el tamaño que busca. Cada solicitud entra
          en Contactos con el origen «Landing de promoción».
        </p>
      </>
    ),
  };

  return (
    <div className="space-y-3">
      <BlockCard
        title="Barra superior"
        enabled={c.topbar.enabled}
        onToggle={(enabled) => patch('topbar', { enabled })}
      >
        <Field
          id="ptb"
          label="Texto"
          max={160}
          value={c.topbar.text}
          onChange={(text) => patch('topbar', { text })}
          placeholder="Promoción de apertura · plazas limitadas"
        />
      </BlockCard>

      <BlockCard title="Portada: botones y datos" enabled>
        <Field
          id="ph-eyebrow"
          label="Antetítulo"
          max={80}
          value={c.hero.eyebrow}
          onChange={(eyebrow) => patch('hero', { eyebrow })}
          placeholder="Nuevo centro en Mislata"
        />
        <CtaField
          id="ph-cta1"
          label="Botón principal"
          value={c.hero.primaryCta}
          onChange={(primaryCta) => primaryCta && patch('hero', { primaryCta })}
          whatsappAvailable={whatsappAvailable}
        />
        <CtaField
          id="ph-cta2"
          label="Botón secundario (opcional)"
          optional
          value={c.hero.secondaryCta}
          onChange={(secondaryCta) => patch('hero', { secondaryCta })}
          whatsappAvailable={whatsappAvailable}
        />
        <LinesField
          id="ph-trust"
          label="Puntos de confianza"
          max={4}
          value={c.hero.trustItems}
          onChange={(trustItems) => patch('hero', { trustItems })}
        />
        <Field
          id="ph-alt"
          label="Descripción de la foto (para quien no la ve)"
          max={120}
          value={c.hero.imageAlt}
          onChange={(imageAlt) => patch('hero', { imageAlt })}
        />
      </BlockCard>

      <BlockCard
        title="Oferta destacada"
        enabled={c.offer.enabled}
        onToggle={(enabled) => patch('offer', { enabled })}
        note={
          hasCoupon
            ? 'Si el cupón caduca, se agota o se apaga, la oferta se oculta sola.'
            : 'Sin cupón la oferta es solo un texto: el descuento lo pone el cliente con su código al reservar.'
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="po-eyebrow"
            label="Antetítulo"
            max={40}
            value={c.offer.eyebrow}
            onChange={(eyebrow) => patch('offer', { eyebrow })}
            placeholder="Apertura"
          />
          <Field
            id="po-title"
            label="Oferta (sobre la foto)"
            max={40}
            value={c.offer.title}
            onChange={(title) => patch('offer', { title })}
            placeholder="1 mes gratis"
          />
        </div>
        <Field
          id="po-subtitle"
          label="Subtítulo"
          max={120}
          value={c.offer.subtitle}
          onChange={(subtitle) => patch('offer', { subtitle })}
        />
        <Field
          id="po-highlight"
          label="Frase destacada bajo los botones"
          max={120}
          value={c.offer.highlight}
          onChange={(highlight) => patch('offer', { highlight })}
        />
        <Field
          id="po-cond"
          label="Enlace a las condiciones"
          max={60}
          value={c.offer.conditionsLink}
          onChange={(conditionsLink) => patch('offer', { conditionsLink })}
        />
      </BlockCard>

      <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Bloques (en este orden)
      </p>
      {order.map((k, i) => (
        <BlockCard
          key={k}
          title={PROMO_SECTION_LABELS[k]}
          enabled={c[k].enabled}
          onToggle={(enabled) => patch(k, { enabled } as Partial<PromoLandingContent[typeof k]>)}
          {...(i > 0 ? { onUp: () => move(k, -1) } : {})}
          {...(i < order.length - 1 ? { onDown: () => move(k, 1) } : {})}
        >
          {blockBody[k]}
        </BlockCard>
      ))}
    </div>
  );
}

/** Quita filas vacías antes de guardar (el servidor exige título o pregunta). */
export function cleanPromoContent(c: PromoLandingContent): PromoLandingContent {
  return {
    ...c,
    benefits: { ...c.benefits, items: c.benefits.items.filter((b) => b.title.trim()) },
    steps: { ...c.steps, items: c.steps.items.filter((s) => s.title.trim()) },
    faq: {
      ...c.faq,
      items: c.faq.items.filter((f) => f.question.trim() && f.answer.trim()),
    },
    hero: {
      ...c.hero,
      primaryCta: c.hero.primaryCta.label.trim()
        ? c.hero.primaryCta
        : { ...c.hero.primaryCta, label: 'Reservar ahora' },
    },
    promotion: {
      ...c.promotion,
      cta: c.promotion.cta.label.trim()
        ? c.promotion.cta
        : { ...c.promotion.cta, label: 'Lo quiero' },
    },
  };
}
