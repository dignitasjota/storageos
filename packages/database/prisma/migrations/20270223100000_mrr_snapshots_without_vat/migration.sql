-- El MRR de las métricas pasa a contarse SIN IVA (antes era el precio de lista,
-- que con «precios con IVA incluido» llevaba el IVA). Se pasan a sin IVA los
-- snapshots ya guardados para que el primer mes con la cuenta nueva no salga
-- como una contracción de todos los tenants. Solo si los precios incluían el IVA
-- (sin ajustes guardados, el valor por defecto: IVA incluido al 21 %).
UPDATE mrr_snapshots
SET mrr = ROUND(
  mrr / (1 + COALESCE((SELECT tax_rate FROM platform_billing_settings LIMIT 1), 21) / 100.0),
  2
)
WHERE COALESCE((SELECT prices_include_vat FROM platform_billing_settings LIMIT 1), true);
