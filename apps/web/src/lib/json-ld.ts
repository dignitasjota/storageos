/**
 * Serializa datos estructurados para inyectarlos en un `<script type="application/ld+json">`
 * vía `dangerouslySetInnerHTML`. `JSON.stringify` NO escapa `<`/`>`/`/`, así que un texto libre
 * (nombre del tenant, comentario de una reseña…) que contenga literalmente `</script>` cierra el
 * bloque y permite inyectar HTML/JS ejecutable en la página pública (stored XSS). Escapamos `<`
 * a su secuencia Unicode — sigue siendo JSON válido y el navegador ya no puede cerrar el tag con él.
 */
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
