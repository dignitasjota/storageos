'use client';

import { Download, ExternalLink, Loader2, MonitorPlay } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  CopyButton,
  errorText,
  Field,
  PageHeader,
  QueryState,
  SalesPage,
} from '@/components/admin/sales/common';
import { DemoExtraLinks } from '@/components/admin/sales/demo-links';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useOpenSalesDemo,
  useOpenSalesDemoPortal,
  useSalesDemo,
  useSalesMe,
  useUpdateSalesMe,
} from '@/lib/admin/sales-hooks';
import { openImpersonationTab } from '@/lib/auth/impersonation';
import { formatDateTime } from '@/lib/format';

function QrBlock({ url, code }: { url: string; code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  function download() {
    const canvas = ref.current?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `trasteros-${code.toLowerCase()}.png`;
    a.click();
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <div ref={ref} className="rounded-md border bg-white p-3">
        <QRCodeCanvas value={url} size={180} marginSize={1} />
      </div>
      <Button size="sm" variant="outline" onClick={download}>
        <Download className="mr-1.5 size-4" />
        Descargar QR
      </Button>
    </div>
  );
}

export default function SalesProfilePage() {
  const me = useSalesMe();
  const save = useUpdateSalesMe();
  const demo = useSalesDemo();
  const openDemo = useOpenSalesDemo();
  const openPortal = useOpenSalesDemoPortal();
  const [form, setForm] = useState({ phone: '', whatsapp: '', bookingUrl: '' });

  // Se rellena una vez: volver a la pestaña no borra lo que se está escribiendo.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (!me.data || filled) return;
    setFilled(true);
    setForm({
      phone: me.data.phone ?? '',
      whatsapp: me.data.whatsapp ?? '',
      bookingUrl: me.data.bookingUrl ?? '',
    });
  }, [me.data, filled]);

  if (!me.data) {
    return (
      <SalesPage>
        <QueryState query={me} />
      </SalesPage>
    );
  }
  const m = me.data;

  async function submit() {
    try {
      await save.mutateAsync({
        phone: form.phone.trim() || null,
        whatsapp: form.whatsapp.trim() || null,
        bookingUrl: form.bookingUrl.trim() || null,
      });
      toast.success('Guardado.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function startDemo() {
    try {
      const session = await openDemo.mutateAsync();
      openImpersonationTab(session);
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido abrir la demo.'));
    }
  }

  return (
    <SalesPage>
      <PageHeader
        title="Mi enlace y QR"
        description="Todo lo que se registre con tu enlace, tu QR o tu código es tuyo. Desde la web sin tu código, no."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tu código: {m.salesCode}</CardTitle>
            <CardDescription>
              {m.extraTrialDays > 0
                ? `Quien se registra con tu código tiene ${m.extraTrialDays} días más de prueba.`
                : 'Pásalo a tus clientes; si lo escriben al registrarse, la cuenta es tuya.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Enlace de registro">
              <div className="flex gap-2">
                <Input readOnly value={m.signupUrl} className="text-xs" />
                <CopyButton text={m.signupUrl} />
              </div>
            </Field>
            <Field label="Enlace a la web (el registro lo lleva puesto)">
              <div className="flex gap-2">
                <Input readOnly value={m.landingUrl} className="text-xs" />
                <CopyButton text={m.landingUrl} />
              </div>
            </Field>
            <QrBlock url={m.signupUrl} code={m.salesCode} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tus datos de contacto</CardTitle>
              <CardDescription>
                Salen en tus correos y en el panel de tus clientes («Tu comercial»).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field id="me-phone" label="Teléfono">
                <Input
                  id="me-phone"
                  type="tel"
                  value={form.phone}
                  maxLength={30}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                />
              </Field>
              <Field id="me-wa" label="WhatsApp">
                <Input
                  id="me-wa"
                  type="tel"
                  value={form.whatsapp}
                  maxLength={30}
                  onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))}
                />
              </Field>
              <Field
                id="me-booking"
                label="Enlace para reservar una demo contigo"
                hint="Calendly, Google Calendar…"
              >
                <Input
                  id="me-booking"
                  type="url"
                  value={form.bookingUrl}
                  maxLength={500}
                  onChange={(e) => setForm((f) => ({ ...f, bookingUrl: e.target.value }))}
                />
              </Field>
              <div className="flex justify-end">
                <Button size="sm" disabled={save.isPending} onClick={() => void submit()}>
                  {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                  Guardar
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cuenta de demostración</CardTitle>
              <CardDescription>
                Un negocio de ejemplo con locales, trasteros, inquilinos y facturas para enseñarlo
                en una demo. Lo que cambies se deshace solo cada noche.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {demo.data?.available ? (
                <div className="space-y-2">
                  <Button onClick={() => void startDemo()} disabled={openDemo.isPending}>
                    <MonitorPlay className="mr-1.5 size-4" />
                    Abrir la demo
                    <ExternalLink className="ml-1.5 size-3.5" />
                  </Button>
                  <DemoExtraLinks
                    tenantSlug={demo.data.tenantSlug}
                    openPortal={() => openPortal.mutateAsync()}
                    portalPending={openPortal.isPending}
                  />
                  {demo.data.resetAt && (
                    <p className="text-xs text-muted-foreground">
                      Última puesta a cero: {formatDateTime(demo.data.resetAt)}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  La dirección aún no la ha preparado.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Lo que puedes hacer tú</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-muted-foreground">
              <p>
                Ampliar la prueba de un cliente hasta {m.limits.trialExtensionDays} días en total.
              </p>
              {m.limits.addonTrialDays > 0 && (
                <p>Dejar probar un extra {m.limits.addonTrialDays} días (uno por cliente).</p>
              )}
              <p>
                Para lo demás (otro plan, precios especiales, más días), pídeselo a la dirección
                desde la ficha.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </SalesPage>
  );
}
