-- Facturas sin contrato de los negocios con un solo local: a ese local, para
-- que salgan al filtrar por local y cuenten en su caja (2026-11-12). Desde
-- ahora la factura toma el local al crearse. No se tocan las ventas (llevan el
-- local de la venta) ni las facturas de suscripción del negocio propio.
UPDATE invoices i
SET facility_id = f.id
FROM (
  SELECT tenant_id, (array_agg(id))[1] AS id
  FROM facilities
  WHERE deleted_at IS NULL
  GROUP BY tenant_id
  HAVING count(*) = 1
) f
WHERE i.tenant_id = f.tenant_id
  AND i.contract_id IS NULL
  AND i.facility_id IS NULL
  AND i.platform_payment_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM product_sales ps WHERE ps.invoice_id = i.id)
  AND NOT EXISTS (
    SELECT 1 FROM customers c WHERE c.id = i.customer_id AND c.platform_tenant_id IS NOT NULL
  );
