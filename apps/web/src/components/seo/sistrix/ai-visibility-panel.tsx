'use client';

import { seoAiModelLabel, type SeoAiVisibilityReportDto } from '@storageos/shared';
import { Eye, Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { SeoOrigin } from './seo-origin';

import { SectionError } from '@/components/dashboard/section-state';
import { PrepareContentButton } from '@/components/seo/assistant/prepare-content-button';
import { seoErrorMessage } from '@/components/seo/seo-errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCount, formatDate, formatShortDay } from '@/lib/format';
import {
  type Ga4AiScope,
  useSeoAiVisibility,
  useSetSeoAiTrackedPrompts,
} from '@/lib/seo-advanced/ga4-ai-hooks';

/** La pareja de colores validada del SEO (`globals.css`): tú y la competencia. */
const YOU = 'var(--seo-current)';
const THEM = 'var(--seo-previous)';

/**
 * Texto de una IA o de SISTRIX: siempre como texto (React lo escapa), sin
 * enlaces activos ni HTML, respetando los saltos de línea.
 */
function ExternalText({ text, className }: { text: string; className?: string }) {
  return <p className={`whitespace-pre-wrap break-words text-sm ${className ?? ''}`}>{text}</p>;
}

/**
 * Visibilidad en buscadores de IA (PR 12): en cuántos prompts de ChatGPT, AI
 * Overviews y AI Mode de Google sales tú (tu dominio y tu marca) frente a tus
 * competidores, los prompts en los que sale la competencia y tú no (para
 * preparar contenido), las fuentes que citan las IA y las respuestas de los
 * prompts que sigues. Estimación de SISTRIX, en España.
 */
export function SeoAiVisibilityPanel({ scope, canEdit }: { scope: Ga4AiScope; canEdit: boolean }) {
  const q = useSeoAiVisibility(scope);
  if (q.isError) return <SectionError onRetry={() => void q.refetch()} />;
  if (!q.data) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const d = q.data;
  const hasData = d.subjects.some((s) => s.promptCount !== null) || d.ownPrompts.length > 0;
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Estimación de SISTRIX en España: prompts (preguntas) a ChatGPT y a las respuestas con IA de
        Google en los que sale cada dominio o marca. Se consulta una vez al mes («Visibilidad en IA»
        en las descargas de SISTRIX).
        {d.latestDate ? ` Última consulta: ${formatDate(d.latestDate)}.` : ''}
      </p>
      {!hasData ? (
        <p className="text-sm text-muted-foreground">
          Aún no hay datos. Sincroniza «Visibilidad en IA».
        </p>
      ) : (
        <>
          <Evolution d={d} />
          <Subjects d={d} />
          <Gaps d={d} scope={scope} canEdit={canEdit} />
          <OwnPrompts d={d} />
          <Sources d={d} />
        </>
      )}
      <Tracked d={d} scope={scope} canEdit={canEdit} />
    </div>
  );
}

/** Tus prompts frente a la media de tus competidores, consulta a consulta (un solo eje). */
function Evolution({ d }: { d: SeoAiVisibilityReportDto }) {
  const own =
    d.subjects.find((s) => s.own && s.subjectType === 'domain') ?? d.subjects.find((s) => s.own);
  const comps = d.subjects.filter((s) => !s.own);
  const dates = [...new Set(d.subjects.flatMap((s) => s.series.map((p) => p.date)))].sort();
  if (!own || dates.length === 0) return null;
  const data = dates.map((date) => {
    const mine = own.series.find((p) => p.date === date)?.promptCount ?? null;
    const values = comps
      .map((c) => c.series.find((p) => p.date === date)?.promptCount)
      .filter((v): v is number => v !== undefined);
    return {
      date,
      you: mine,
      them: values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null,
    };
  });
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">
        Prompts en los que sales, consulta a consulta
      </figcaption>
      <div className="h-48" role="img" aria-label="Prompts tuyos y de la competencia por consulta">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 320, height: 192 }}
        >
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.4} />
            <XAxis
              dataKey="date"
              tickFormatter={(v: string) => formatShortDay(v)}
              tick={{ fontSize: 11 }}
            />
            <YAxis tick={{ fontSize: 11 }} width={44} allowDecimals={false} domain={[0, 'auto']} />
            <Tooltip
              labelFormatter={(l) => formatShortDay(String(l))}
              formatter={(value, name) => [
                value == null ? '—' : formatCount(Number(value)),
                name === 'you' ? 'Tú' : 'Media de tus competidores',
              ]}
            />
            <Legend
              verticalAlign="top"
              height={24}
              iconType="plainline"
              formatter={(v) => (v === 'you' ? 'Tú' : 'Media de tus competidores')}
            />
            <Line
              dataKey="you"
              name="you"
              stroke={YOU}
              strokeWidth={2}
              dot
              isAnimationActive={false}
            />
            {comps.length > 0 && (
              <Line
                dataKey="them"
                name="them"
                stroke={THEM}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function Subjects({ d }: { d: SeoAiVisibilityReportDto }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Tú y tus competidores</h3>
      <ul className="divide-y rounded-md border">
        {d.subjects.map((s) => (
          <li key={`${s.subjectType}|${s.subject}`} className="space-y-1 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-medium">{s.subject}</span>
              {s.own && <Badge variant="secondary">Tú</Badge>}
              <Badge variant="outline">{s.subjectType === 'brand' ? 'Marca' : 'Dominio'}</Badge>
              <span className="text-sm tabular-nums">
                {s.promptCount === null ? 'Sin dato' : `${formatCount(s.promptCount)} prompts`}
              </span>
              {s.previousCount !== null && s.promptCount !== null && (
                <span className="text-xs text-muted-foreground">
                  (antes {formatCount(s.previousCount)})
                </span>
              )}
            </div>
            {s.models.length > 0 && (
              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                {s.models.map((m) => (
                  <span key={m.model}>
                    {seoAiModelLabel(m.model)}: {formatCount(m.promptCount)}
                  </span>
                ))}
                {s.origin && <SeoOrigin origin={s.origin} />}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gaps({
  d,
  scope,
  canEdit,
}: {
  d: SeoAiVisibilityReportDto;
  scope: Ga4AiScope;
  canEdit: boolean;
}) {
  const setTracked = useSetSeoAiTrackedPrompts(scope);
  const track = async (prompt: string) => {
    try {
      await setTracked.mutateAsync([...d.settings.trackedPrompts, prompt]);
      toast.success('Lo sigues: sus respuestas llegan en la próxima consulta');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const tracked = new Set(d.tracked.map((t) => t.promptKey));
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Sale la competencia y tú no</h3>
      <p className="text-xs text-muted-foreground">
        Prompts de las IA en los que sale algún competidor y ni tu web ni tu marca: ideas de
        contenido que responda esa pregunta.
      </p>
      {d.gaps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ninguno en la última consulta.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {d.gaps.map((g) => (
            <li
              key={g.promptKey}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <ExternalText text={g.prompt} className="font-medium" />
                <p className="break-words text-xs text-muted-foreground">
                  {g.competitors.join(', ')}
                  {g.models.length ? ` · ${g.models.map(seoAiModelLabel).join(', ')}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <PrepareContentButton
                  source={{ source: 'prompt', prompt: g.prompt.slice(0, 300) }}
                />
                {canEdit && !tracked.has(g.promptKey) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={setTracked.isPending || d.settings.trackedPrompts.length >= 20}
                    onClick={() => void track(g.prompt.slice(0, 300))}
                  >
                    <Eye className="mr-1 size-4" aria-hidden /> Seguir
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OwnPrompts({ d }: { d: SeoAiVisibilityReportDto }) {
  if (d.ownPrompts.length === 0) return null;
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Prompts en los que sales ({formatCount(d.ownPrompts.length)})
      </summary>
      <ul className="mt-2 space-y-3">
        {d.ownPrompts.map((p) => (
          <li key={`${p.promptKey}|${p.model}`} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ExternalText text={p.prompt} className="font-medium" />
              {p.model && <Badge variant="outline">{seoAiModelLabel(p.model)}</Badge>}
            </div>
            {p.answer && (
              <ExternalText
                text={p.answer}
                className="border-l-2 pl-2 text-xs text-muted-foreground"
              />
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Las respuestas son texto de las IA, tal cual: no son de TrasterOS.
      </p>
    </details>
  );
}

function Sources({ d }: { d: SeoAiVisibilityReportDto }) {
  if (d.sources.length === 0 && d.competitorBrands.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Fuentes que citan las IA</h3>
        {d.citedPages.length > 0 ? (
          <p className="text-xs text-green-700 dark:text-green-400">
            Citan {formatCount(d.citedPages.length)} página(s) de tu web.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No citan ninguna página de tu web.</p>
        )}
        <ul className="divide-y rounded-md border text-sm">
          {d.sources.slice(0, 15).map((s) => (
            <li
              key={`${s.sourceType}|${s.source}`}
              className="flex items-center justify-between gap-2 p-2"
            >
              <span className="min-w-0 break-all">{s.source}</span>
              <span className="flex shrink-0 items-center gap-2">
                {s.own && <Badge variant="secondary">Tu web</Badge>}
                <span className="tabular-nums text-muted-foreground">{formatCount(s.count)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {d.competitorBrands.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Marcas que compiten en las IA</h3>
          <ul className="divide-y rounded-md border text-sm">
            {d.competitorBrands.map((s) => (
              <li key={s.source} className="flex items-center justify-between gap-2 p-2">
                <span className="min-w-0 break-words">{s.source}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatCount(s.count)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Prompts que sigues: sus respuestas en cada modelo (con `ai_prompt_answers`). */
function Tracked({
  d,
  scope,
  canEdit,
}: {
  d: SeoAiVisibilityReportDto;
  scope: Ga4AiScope;
  canEdit: boolean;
}) {
  const setTracked = useSetSeoAiTrackedPrompts(scope);
  const [value, setValue] = useState('');
  const save = async (prompts: string[], ok: string) => {
    try {
      await setTracked.mutateAsync(prompts);
      toast.success(ok);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const list = d.settings.trackedPrompts;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Prompts que sigues ({list.length}/20)</h3>
      <p className="text-xs text-muted-foreground">
        De cada uno se descargan, en la próxima consulta, las respuestas de cada IA y se ve si te
        nombran.
      </p>
      {canEdit && (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            const p = value.trim();
            if (p.length < 3) return;
            void save([...list, p], 'Prompt añadido').then(() => setValue(''));
          }}
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={300}
            placeholder="p. ej. ¿dónde alquilar un trastero barato en Valencia?"
            aria-label="Prompt que seguir"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={setTracked.isPending || value.trim().length < 3 || list.length >= 20}
          >
            <Plus className="mr-1 size-4" aria-hidden /> Seguir
          </Button>
        </form>
      )}
      {d.tracked.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sigues ningún prompt.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {d.tracked.map((t) => (
            <li key={t.promptKey} className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <ExternalText text={t.prompt} className="font-medium" />
                  {t.answers.length > 0 && (
                    <Badge variant={t.mentionsYou ? 'secondary' : 'outline'}>
                      {t.mentionsYou ? 'Te nombran' : 'No te nombran'}
                    </Badge>
                  )}
                </div>
                {canEdit && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 shrink-0"
                    aria-label="Dejar de seguir"
                    disabled={setTracked.isPending}
                    onClick={() =>
                      void save(
                        list.filter((p) => p !== t.prompt),
                        'Ya no lo sigues',
                      )
                    }
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                )}
              </div>
              {t.answers.length === 0 ? (
                <p className="text-xs text-muted-foreground">Sin respuestas todavía.</p>
              ) : (
                t.answers.map((a) => (
                  <div key={a.model} className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {seoAiModelLabel(a.model)} · {formatDate(a.date)}
                    </p>
                    {a.answer && (
                      <ExternalText text={a.answer} className="border-l-2 pl-2 text-xs" />
                    )}
                  </div>
                ))
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
