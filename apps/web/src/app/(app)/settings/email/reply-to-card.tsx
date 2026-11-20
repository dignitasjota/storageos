'use client';

import { UpdateEmailReplyToSchema, type EmailReplyToDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useEmailReplyTo, useUpdateEmailReplyTo } from '@/lib/email-domain/hooks';

/** A qué dirección llegan las respuestas de tus inquilinos (tengas o no dominio propio). */
export function ReplyToCard() {
  const replyTo = useEmailReplyTo();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Las respuestas de tus inquilinos llegan a</CardTitle>
        <CardDescription>
          Cuando un inquilino responde a una factura, un recordatorio o cualquier correo de tu
          negocio, la respuesta llega a esta dirección.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {replyTo.isError ? (
          <SectionError onRetry={() => void replyTo.refetch()} />
        ) : !replyTo.data ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          // La clave cambia al guardar: el campo vuelve a lo guardado.
          <ReplyToForm key={replyTo.data.emailReplyTo ?? ''} data={replyTo.data} />
        )}
      </CardContent>
    </Card>
  );
}

function ReplyToForm({ data }: { data: EmailReplyToDto }) {
  const update = useUpdateEmailReplyTo();
  const canManage = useHasPermission('settings:manage');
  const [value, setValue] = useState(data.emailReplyTo ?? '');
  const trimmed = value.trim();
  const dirty = trimmed.toLowerCase() !== (data.emailReplyTo ?? '');
  const invalid =
    trimmed !== '' && !UpdateEmailReplyToSchema.safeParse({ emailReplyTo: trimmed }).success;

  async function onSave() {
    try {
      await update.mutateAsync({ emailReplyTo: trimmed });
      toast.success(
        trimmed ? 'Dirección de respuesta guardada.' : 'Se usará la dirección por defecto.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido guardar.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="reply-to">Dirección</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="reply-to"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={data.fallback ?? 'atencion@tu-negocio.com'}
            value={value}
            disabled={!canManage}
            aria-invalid={invalid}
            onChange={(e) => setValue(e.target.value)}
            className="sm:max-w-sm"
          />
          {canManage && (
            <Button onClick={() => void onSave()} disabled={update.isPending || !dirty || invalid}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          )}
        </div>
        {invalid && <p className="text-sm text-destructive">Escribe un email válido.</p>}
        <p className="text-sm text-muted-foreground">
          {data.fallback
            ? `Si lo dejas vacío, llegan a ${data.fallback} (tu email de facturación).`
            : 'Si lo dejas vacío, llegan a tu email de facturación.'}
        </p>
      </div>
      {data.customDomainReplyTo && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Ahora mismo llegan a {data.customDomainReplyTo}: es la dirección de respuesta de tu
          dominio de correo, y manda sobre esta mientras la tengas puesta.
        </p>
      )}
    </div>
  );
}
