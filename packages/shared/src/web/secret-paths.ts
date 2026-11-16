/**
 * Páginas con un enlace secreto en la dirección: firma del contrato, mandato
 * SEPA, invitación, cambio de contraseña… Con ese enlace se puede firmar o
 * entrar en una cuenta, así que la dirección no debe llegar a Google Analytics
 * ni a los informes. Se cambia el enlace por `enlace`.
 */
export const SECRET_PATH_SOURCE =
  '/(sign/annex|sign|sepa-mandate|review|waitlist-confirm|unsubscribe|nps|invite|reset-password|verify-email/change|verify-email|security/enrolment|admin/reset-password)/[^/?#]+';

/** Parámetros de la dirección que llevan un secreto (`?token=` del área de clientes). */
export const SECRET_QUERY_SOURCE = '([?&](?:token|code)=)[^&#]*';

/** La dirección sin los enlaces secretos. */
export function redactSecretPaths(url: string): string {
  return url
    .replace(new RegExp(SECRET_PATH_SOURCE, 'g'), '/$1/enlace')
    .replace(new RegExp(SECRET_QUERY_SOURCE, 'gi'), '$1enlace');
}
