'use client';

import {
  CUSTOMER_EMAIL_LABELS,
  CUSTOMER_EMAIL_TESTS_PER_HOUR,
  type CustomerEmailKind,
  type CustomerEmailPreviewLocale,
} from '@storageos/shared';
import { Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCustomerEmailPreview, useSendCustomerEmailTest } from '@/lib/email-domain/hooks';

const LOCALES: { value: CustomerEmailPreviewLocale; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'Inglés' },
];

/**
 * Un correo automático tal como lo recibe el inquilino (con tu marca y datos de
 * ejemplo), en español o en inglés, y «Enviarme uno de prueba».
 */
export function CustomerEmailPreviewDialog({
  kind,
  onClose,
}: {
  kind: CustomerEmailKind | null;
  onClose: () => void;
}) {
  const [locale, setLocale] = useState<CustomerEmailPreviewLocale>('es');
  const preview = useCustomerEmailPreview(kind, locale);
  const sendTest = useSendCustomerEmailTest();
  const canManage = useHasPermission('settings:manage');

  async function onSendTest() {
    if (!kind) return;
    try {
      const res = await sendTest.mutateAsync({ kind, locale });
      toast.success(`Te lo hemos enviado a ${res.sentTo}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido enviar la prueba.');
    }
  }

  return (
    <Dialog open={!!kind} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{kind ? CUSTOMER_EMAIL_LABELS[kind].label : ''}</DialogTitle>
          <DialogDescription>
            Así lo recibe tu inquilino, con tu logo y tu color. Los datos son de ejemplo: un
            inquilino ficticio y la cuota de uno de tus trasteros.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Idioma" className="inline-flex rounded-md border p-0.5">
            {LOCALES.map((l) => (
              <Button
                key={l.value}
                type="button"
                size="sm"
                variant={locale === l.value ? 'secondary' : 'ghost'}
                aria-pressed={locale === l.value}
                onClick={() => setLocale(l.value)}
              >
                {l.label}
              </Button>
            ))}
          </div>
          {canManage && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onSendTest()}
              disabled={sendTest.isPending || !preview.data}
            >
              {sendTest.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Enviarme uno de prueba
            </Button>
          )}
        </div>

        {preview.isError ? (
          <SectionError onRetry={() => void preview.refetch()} />
        ) : (
          <div className="overflow-hidden rounded-md border">
            <div className="border-b bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Asunto: </span>
              {preview.data?.subject ?? 'Cargando…'}
            </div>
            {preview.data ? (
              <iframe
                title="Vista previa del correo"
                sandbox=""
                srcDoc={preview.data.html}
                className="h-[60vh] max-h-[520px] min-h-[320px] w-full bg-white"
              />
            ) : (
              <div className="flex h-40 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        )}
        {canManage && (
          <p className="text-xs text-muted-foreground">
            La prueba llega a tu email con «[Prueba]» en el asunto y no se guarda en las
            comunicaciones de ningún inquilino. Como mucho {CUSTOMER_EMAIL_TESTS_PER_HOUR} pruebas
            por hora.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
