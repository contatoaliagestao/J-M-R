-- Registro de contratos excluídos (auditoria: quem excluiu, quando, por quê e o que era)
CREATE TABLE deleted_contracts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id),
  contract_code    TEXT NOT NULL,
  client_name      TEXT NOT NULL,
  cpf              TEXT NOT NULL,
  principal_cents  INTEGER NOT NULL,
  data_json        TEXT NOT NULL,          -- cópia completa do contrato no momento da exclusão
  reason           TEXT NOT NULL DEFAULT '',
  deleted_by       INTEGER REFERENCES users(id),
  deleted_by_name  TEXT NOT NULL,
  deleted_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deleted_contracts_company ON deleted_contracts(company_id);
