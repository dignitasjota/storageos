import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

import type {
  RedsysPayMethod,
  RedsysRedirectDto,
  RedsysSettingsDto,
  UpdateRedsysSettingsInput,
} from '@storageos/shared';

const redsysKey = ['redsys-settings'] as const;

export function useRedsysSettings() {
  return useQuery({
    queryKey: redsysKey,
    queryFn: () => apiFetch<RedsysSettingsDto>('/settings/redsys'),
  });
}

export function useUpdateRedsysSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateRedsysSettingsInput) =>
      apiFetch<RedsysSettingsDto>('/settings/redsys', { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: redsysKey }),
  });
}

/** Redirige el navegador a la pasarela Redsys auto-enviando el formulario firmado. */
export function submitRedsysForm(redirect: RedsysRedirectDto): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = redirect.url;
  const fields: Record<string, string> = {
    Ds_SignatureVersion: redirect.signatureVersion,
    Ds_MerchantParameters: redirect.merchantParameters,
    Ds_Signature: redirect.signature,
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/** Staff: obtiene el formulario de pago Redsys para una factura (tarjeta o Bizum). */
export async function fetchRedsysRedirect(
  invoiceId: string,
  payMethod?: RedsysPayMethod,
): Promise<RedsysRedirectDto> {
  return apiFetch<RedsysRedirectDto>(`/settings/redsys/invoices/${invoiceId}/redirect`, {
    method: 'POST',
    json: payMethod ? { payMethod } : {},
  });
}

/** Portal (inquilino): formulario de pago Redsys usando el token de portal. */
export async function fetchPortalRedsysRedirect(
  portalToken: string,
  invoiceId: string,
  payMethod?: RedsysPayMethod,
): Promise<RedsysRedirectDto> {
  return apiFetch<RedsysRedirectDto>(`/portal/me/invoices/${invoiceId}/redsys-redirect`, {
    method: 'POST',
    requiresAuth: false,
    headers: { Authorization: `Bearer ${portalToken}` },
    json: payMethod ? { payMethod } : {},
  });
}
