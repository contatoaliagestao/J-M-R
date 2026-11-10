-- "Quebrar juros": amortização (pagamento antecipado de parte do principal).
-- Novo tipo de lançamento AMORTIZACAO no livro financeiro (a tabela é recriada; nenhuma outra aponta para ela).
CREATE TABLE ledger_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id),
  contract_id     INTEGER REFERENCES contracts(id),
  agreement_id    INTEGER REFERENCES agreements(id),
  date            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('CONCESSAO','ROLAGEM','QUITACAO','DESPESA','OUTRA_ENTRADA','PARCELA_ACORDO','AMORTIZACAO')),
  description     TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  principal_cents INTEGER NOT NULL DEFAULT 0,
  revenue_cents   INTEGER NOT NULL DEFAULT 0,
  channel         TEXT NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',
  user_id         INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO ledger_new (id, company_id, contract_id, agreement_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id, created_at)
  SELECT id, company_id, contract_id, agreement_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id, created_at FROM ledger;
DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX idx_ledger_company ON ledger(company_id, type);
CREATE INDEX idx_ledger_agreement ON ledger(agreement_id);
