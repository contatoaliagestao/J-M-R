-- Acordos de pagamento (renegociação de dívidas em atraso)

-- Marca se o contrato está em acordo (o status continua ATIVO até o acordo ser concluído)
ALTER TABLE contracts ADD COLUMN in_agreement INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agreements (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id                   INTEGER NOT NULL REFERENCES companies(id),
  contract_id                  INTEGER NOT NULL REFERENCES contracts(id),
  status                       TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','CONCLUIDO','CANCELADO')),
  total_cents                  INTEGER NOT NULL CHECK (total_cents > 0),  -- valor total acordado
  debt_at_agreement_cents      INTEGER NOT NULL,                          -- dívida na data do acordo (referência)
  principal_at_agreement_cents INTEGER NOT NULL,                          -- principal ainda não recuperado
  notes                        TEXT NOT NULL DEFAULT '',
  replaces_id                  INTEGER REFERENCES agreements(id),         -- acordo anterior (renegociação)
  created_by                   INTEGER REFERENCES users(id),
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at                    TEXT
);
-- Apenas um acordo ativo por contrato
CREATE UNIQUE INDEX idx_agreements_active ON agreements(contract_id) WHERE status = 'ATIVO';
CREATE INDEX idx_agreements_company ON agreements(company_id, status);

CREATE TABLE agreement_installments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id  INTEGER NOT NULL REFERENCES agreements(id),
  number        INTEGER NOT NULL,
  due_date      TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  status        TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','PAGO')),
  paid_cents    INTEGER,
  paid_at       TEXT,
  channel       TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  received_by   INTEGER REFERENCES users(id),
  UNIQUE (agreement_id, number)
);

-- Livro financeiro: novo tipo de lançamento PARCELA_ACORDO e vínculo com o acordo.
-- (o SQLite não altera CHECK, então a tabela é recriada; nenhuma outra tabela aponta para ela)
CREATE TABLE ledger_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id),
  contract_id     INTEGER REFERENCES contracts(id),
  agreement_id    INTEGER REFERENCES agreements(id),
  date            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('CONCESSAO','ROLAGEM','QUITACAO','DESPESA','OUTRA_ENTRADA','PARCELA_ACORDO')),
  description     TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  principal_cents INTEGER NOT NULL DEFAULT 0,
  revenue_cents   INTEGER NOT NULL DEFAULT 0,
  channel         TEXT NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',
  user_id         INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO ledger_new (id, company_id, contract_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id, created_at)
  SELECT id, company_id, contract_id, date, type, description, amount_cents, principal_cents, revenue_cents, channel, notes, user_id, created_at FROM ledger;
DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX idx_ledger_company ON ledger(company_id, type);
CREATE INDEX idx_ledger_agreement ON ledger(agreement_id);
