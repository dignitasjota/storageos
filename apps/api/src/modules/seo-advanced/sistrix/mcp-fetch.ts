/**
 * Envoltorio de `fetch` para el canje del código de autorización con SISTRIX.
 *
 * Peculiaridad comprobada en la prueba de concepto: el servidor de SISTRIX
 * rechaza el canje (`grant_type=authorization_code`) si la petición lleva
 * `redirect_uri` («did not match») y lo acepta sin él. El SDK lo manda
 * siempre, así que se quita SOLO de esa petición; la renovación, el registro y
 * el resto de llamadas pasan tal cual.
 */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

function formBody(body: RequestInit['body']): URLSearchParams | null {
  if (body instanceof URLSearchParams) return new URLSearchParams(body);
  if (typeof body === 'string') {
    try {
      return new URLSearchParams(body);
    } catch {
      return null;
    }
  }
  return null;
}

export function stripRedirectUriOnCodeExchange(inner: FetchLike): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const form = method === 'POST' ? formBody(init?.body) : null;
    if (form && form.get('grant_type') === 'authorization_code' && form.has('redirect_uri')) {
      form.delete('redirect_uri');
      return inner(url, { ...init, body: form });
    }
    return inner(url, init);
  };
}
