/**
 * Construye los parámetros posicionales de una plantilla WhatsApp Business a
 * partir del orden de variables configurado en la plantilla y los valores
 * resueltos del envío.
 *
 * Las plantillas WABA usan placeholders posicionales {{1}}, {{2}}… El operador
 * configura en `message_templates.whatsappTemplateVariables` el orden de los
 * nombres de variable; aquí los traducimos a `{ "1": valor, "2": valor }`
 * (claves enteras ascendentes que el provider envía en orden a Meta).
 */
export function buildWhatsappTemplateParams(
  orderedNames: string[],
  variables: Record<string, unknown>,
): Record<string, string> {
  const params: Record<string, string> = {};
  orderedNames.forEach((name, i) => {
    const value = variables[name];
    params[String(i + 1)] = value == null ? '' : String(value);
  });
  return params;
}
