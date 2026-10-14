'use client';

import { WHATSAPP_AI_PROVIDERS, type WhatsappAiProvider } from '@storageos/shared';
import { Bot, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useTestWhatsappAssistant,
  useUpdateWhatsappAssistant,
  useWhatsappAssistant,
  useWhatsappTemplates,
} from '@/lib/whatsapp/hooks';

/**
 * Asistente automático de WhatsApp: responde con los datos de tu web (locales,
 * horarios, tamaños, precios, disponibilidad, promoción y preguntas frecuentes)
 * y pasa la conversación al equipo cuando hace falta.
 */
export function AssistantCard() {
  const assistant = useWhatsappAssistant();
  const templates = useWhatsappTemplates(true);
  const update = useUpdateWhatsappAssistant();
  const test = useTestWhatsappAssistant();

  const [enabled, setEnabled] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState<WhatsappAiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [bookings, setBookings] = useState(true);
  const [templateName, setTemplateName] = useState('');
  const [templateLanguage, setTemplateLanguage] = useState('es');
  const [privacyUrl, setPrivacyUrl] = useState('');

  const loaded = useRef(false);
  useEffect(() => {
    if (!assistant.data || loaded.current) return;
    loaded.current = true;
    setEnabled(assistant.data.assistantEnabled);
    setInstructions(assistant.data.assistantInstructions ?? '');
    setBookings(assistant.data.assistantBookingsEnabled);
    setTemplateName(assistant.data.reminderTemplateName ?? '');
    setTemplateLanguage(assistant.data.reminderTemplateLanguage);
    setPrivacyUrl(assistant.data.privacyUrl ?? '');
    if (assistant.data.ownAi) {
      setProvider(assistant.data.ownAi.provider);
      setModel(assistant.data.ownAi.model);
      setBaseUrl(assistant.data.ownAi.baseUrl ?? '');
    }
  }, [assistant.data]);

  if (!assistant.data) return null;
  const d = assistant.data;
  const ownMode = d.aiMode === 'own';
  const preset = WHATSAPP_AI_PROVIDERS.find((p) => p.value === provider);

  async function saveAssistant() {
    try {
      await update.mutateAsync({
        assistantEnabled: enabled,
        assistantInstructions: instructions,
        assistantBookingsEnabled: bookings,
        reminderTemplateName: templateName.trim(),
        reminderTemplateLanguage: templateLanguage.trim() || 'es',
        privacyUrl: privacyUrl.trim(),
      });
      toast.success('Asistente guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function saveKey() {
    try {
      await update.mutateAsync({
        ownProvider: provider,
        ownModel: model.trim(),
        ownBaseUrl: provider === 'openai_compatible' ? baseUrl.trim() : '',
        ...(apiKey.trim() ? { ownApiKey: apiKey.trim() } : {}),
      });
      setApiKey('');
      toast.success('Clave de IA guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function removeKey() {
    if (!window.confirm('¿Quitar tu clave de IA?')) return;
    try {
      await update.mutateAsync({ removeOwnKey: true });
      setModel('');
      setBaseUrl('');
      toast.success('Clave quitada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  async function runTest() {
    try {
      const r = await test.mutateAsync();
      if (r.ok) toast.success(`Tu clave funciona. Respuesta: «${r.sample ?? ''}»`);
      else toast.error(r.error ?? 'No funciona.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar.');
    }
  }

  const noAi = ownMode ? !d.ownAi?.keyLast4 : !d.platformAiAvailable && !d.ownAi?.keyLast4;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4" />
          Asistente automático
        </CardTitle>
        <CardDescription>
          Responde a quien te escribe con la información de tu web: locales, horarios, tamaños,
          precios con IVA, disponibilidad, promoción y preguntas frecuentes. Para reservar envía el
          enlace de tu web. Si no sabe responder o el cliente pide una persona, deja de contestar en
          esa conversación y te avisa. Cuando respondes tú, también se calla en esa conversación.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            <span>Activar el asistente</span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="wa-instructions">Información extra para el asistente (opcional)</Label>
            <Textarea
              id="wa-instructions"
              rows={4}
              maxLength={2000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Ej.: Hay carros y montacargas. La fianza es de un mes. Aceptamos pago con Bizum."
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-privacy-url">Tu política de privacidad (opcional)</Label>
            <Input
              id="wa-privacy-url"
              value={privacyUrl}
              onChange={(e) => setPrivacyUrl(e.target.value)}
              placeholder="https://tuweb.es/privacidad"
              className="text-base sm:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              En su primera respuesta, el asistente avisa de que es automático y de que se puede
              pedir una persona. Si pones aquí la página de privacidad de tu web, la enlaza.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={bookings} onCheckedChange={(v) => setBookings(v === true)} />
            <span>
              Permitir que prepare reservas
              <span className="block text-xs text-muted-foreground">
                Pide los datos, los confirma con el cliente y le envía el enlace para firmar y pagar
                (el trastero queda reservado 72 horas, como en la reserva online).
              </span>
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <div className="space-y-1.5">
              <Label htmlFor="wa-reminder-tpl">Plantilla para recordar reservas (opcional)</Label>
              <Input
                id="wa-reminder-tpl"
                list="wa-approved-templates"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="recordatorio_reserva"
                className="text-base sm:text-sm"
              />
              <datalist id="wa-approved-templates">
                {(templates.data?.templates ?? []).map((t) => (
                  <option key={`${t.name}|${t.language}`} value={t.name}>
                    {t.body}
                  </option>
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wa-reminder-lang">Idioma</Label>
              <Input
                id="wa-reminder-lang"
                value={templateLanguage}
                onChange={(e) => setTemplateLanguage(e.target.value)}
                placeholder="es"
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Si una reserva hecha por WhatsApp sigue sin firmar o sin pagar a las 12 horas, se le
            recuerda por WhatsApp. Pasadas 24 horas desde su último mensaje, WhatsApp solo deja
            escribir con una plantilla aprobada en Meta: su texto debe llevar {'{{1}}'} (nombre) y{' '}
            {'{{2}}'} (enlace). Sin plantilla, el recordatorio sale por correo.
          </p>
          {noAi && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {ownMode
                ? 'Tu cuenta usa tu propia IA: pon tu clave abajo para que el asistente responda.'
                : 'Ahora mismo no hay IA disponible para el asistente. Pon tu propia clave abajo o contacta con soporte.'}
            </p>
          )}
          <Button onClick={saveAssistant} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Guardar asistente
          </Button>
        </div>

        <div className="space-y-4 border-t pt-6">
          <div>
            <p className="text-sm font-medium">IA que usa el asistente</p>
            <p className="text-xs text-muted-foreground">
              {ownMode
                ? `Usa siempre tu propia clave. Este mes: ${d.usage.ownRepliesThisMonth} respuestas.`
                : `Usa la IA de TrasterOS: ${d.usage.platformRepliesThisMonth} de ${d.usage.limit} respuestas este mes. Si llegas al límite y tienes tu propia clave, seguirá respondiendo con la tuya hasta el mes que viene.`}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Tu proveedor de IA {ownMode ? '' : '(opcional)'}</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v as WhatsappAiProvider);
                  const p = WHATSAPP_AI_PROVIDERS.find((x) => x.value === v);
                  if (p?.defaultModel) setModel(p.defaultModel);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHATSAPP_AI_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wa-own-model">Modelo</Label>
              <Input
                id="wa-own-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={preset?.defaultModel || 'Nombre del modelo'}
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          {provider === 'openai_compatible' && (
            <div className="space-y-1.5">
              <Label htmlFor="wa-own-url">URL de la API</Label>
              <Input
                id="wa-own-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.proveedor.com/v1"
                className="text-base sm:text-sm"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="wa-own-key">Tu clave de API</Label>
            <Input
              id="wa-own-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                d.ownAi?.keyLast4
                  ? `Guardada (termina en ${d.ownAi.keyLast4}). Escribe otra para cambiarla.`
                  : 'Pega aquí tu clave'
              }
              className="text-base sm:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Los mensajes de tus clientes se envían a este proveedor: el consumo te lo cobra él.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={saveKey}
              disabled={update.isPending || !model.trim()}
            >
              Guardar clave
            </Button>
            {d.ownAi?.keyLast4 && (
              <>
                <Button variant="outline" onClick={runTest} disabled={test.isPending}>
                  {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Probar mi clave
                </Button>
                <Button variant="ghost" onClick={removeKey} disabled={update.isPending}>
                  Quitar clave
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
