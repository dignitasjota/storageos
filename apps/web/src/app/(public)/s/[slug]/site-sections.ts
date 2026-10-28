/**
 * Navegación de la cabecera y el pie de las plantillas. En la portada, los
 * enlaces de sección hacen scroll; en otra página que reutiliza la misma
 * cabecera (la reserva), llevan a esa sección de la portada.
 */
export function goToSection(id: string, homeHref?: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (homeHref) window.location.assign(`${homeHref}#${id}`);
}

/** El logo: arriba del todo en la portada, a la portada desde otra página. */
export function goToTop(homeHref?: string): void {
  if (homeHref) window.location.assign(homeHref);
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}
