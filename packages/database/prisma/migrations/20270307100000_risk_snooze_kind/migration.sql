-- En riesgo: «Ignorar» oculta solo el motivo por el que se ignoró (prueba que
-- termina, impago, inactivo, salud baja o prueba caducada sin pagar). Los que
-- ya estaban ignorados (sin motivo guardado) siguen ocultos en todas las
-- secciones hasta que venzan.

ALTER TABLE tenants
  ADD COLUMN risk_snoozed_kind TEXT;
