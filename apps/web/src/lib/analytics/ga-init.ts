import { SECRET_PATH_SOURCE, SECRET_QUERY_SOURCE } from '@storageos/shared';

/**
 * Arranque de Google Analytics 4 (`gtag`). Si la dirección o la página de la
 * que se viene llevan un enlace secreto (firma del contrato, invitación,
 * cambio de contraseña…), se le manda sin él: quien vea los informes de
 * Analytics podría firmar o entrar en una cuenta con ese enlace.
 */
export function gaInitScript(measurementId: string, extra: Record<string, unknown> = {}): string {
  return `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
(function () {
  var clean = function (u) {
    return String(u || '')
      .replace(new RegExp(${JSON.stringify(SECRET_PATH_SOURCE)}, 'g'), '/$1/enlace')
      .replace(new RegExp(${JSON.stringify(SECRET_QUERY_SOURCE)}, 'gi'), '$1enlace');
  };
  var cfg = ${JSON.stringify(extra)};
  var loc = clean(location.href);
  if (loc !== location.href) cfg.page_location = loc;
  var ref = clean(document.referrer);
  if (ref !== document.referrer) cfg.page_referrer = ref;
  gtag('config', ${JSON.stringify(measurementId)}, cfg);
})();`;
}
