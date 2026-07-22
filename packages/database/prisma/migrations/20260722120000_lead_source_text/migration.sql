-- El origen del lead pasa de enum (`lead_source`) a texto libre para permitir
-- orígenes personalizados por tenant (Idealista, Fotocasa, campañas propias…),
-- creables al vuelo desde el alta manual del lead. Los valores existentes se
-- conservan tal cual (el enum se serializa a su etiqueta de texto).
ALTER TABLE "leads" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "leads" ALTER COLUMN "source" TYPE TEXT USING "source"::text;
ALTER TABLE "leads" ALTER COLUMN "source" SET DEFAULT 'manual';

-- El tipo enum ya no se usa (solo lo referenciaba `leads.source`).
DROP TYPE "lead_source";
