-- Un CSV de la banca sin columna de saldo: los saldos del extracto no se
-- conocen (no es que el fichero no cuadre). true = los trae el fichero.
ALTER TABLE bank_statements ADD COLUMN balances_known BOOLEAN NOT NULL DEFAULT true;
