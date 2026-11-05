'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function openDatabase(file = process.env.DB_FILE || path.join(DATA_DIR, 'jmr.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE COLLATE NOCASE,      -- apenas o administrador entra por e-mail
      username      TEXT UNIQUE COLLATE NOCASE,      -- usuários criados pelo administrador
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('ADMIN','GESTOR','OPERADOR')),
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (email IS NOT NULL OR username IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companies (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      official_name TEXT NOT NULL,
      short_name    TEXT NOT NULL,
      tagline       TEXT NOT NULL DEFAULT '',
      cnpj          TEXT NOT NULL DEFAULT '',
      color_theme   TEXT NOT NULL DEFAULT 'amber',
      logo_url      TEXT NOT NULL DEFAULT '',
      code_prefix   TEXT NOT NULL,
      next_number   INTEGER NOT NULL DEFAULT 1001,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_companies (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, company_id)
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id      INTEGER NOT NULL REFERENCES companies(id),
      code            TEXT NOT NULL,
      client_name     TEXT NOT NULL,
      cpf             TEXT NOT NULL,
      phone           TEXT NOT NULL,
      address         TEXT NOT NULL DEFAULT '',
      social_media    TEXT NOT NULL DEFAULT '',
      principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
      rate            REAL NOT NULL CHECK (rate >= 0),
      late_fee_rate   REAL NOT NULL DEFAULT 10 CHECK (late_fee_rate >= 0),
      cycle_days      INTEGER NOT NULL CHECK (cycle_days > 0),
      start_date      TEXT NOT NULL,
      due_date        TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO','QUITADO')),
      rollover_count  INTEGER NOT NULL DEFAULT 0,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at      TEXT,
      UNIQUE (company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_contracts_company ON contracts(company_id, status);

    CREATE TABLE IF NOT EXISTS occurrences (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id  INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      user_id      INTEGER REFERENCES users(id),
      author_name  TEXT NOT NULL,
      author_role  TEXT NOT NULL,      -- ADMIN / GESTOR / OPERADOR / SISTEMA
      text         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_occurrences_contract ON occurrences(contract_id);

    -- Livro financeiro: toda entrada/saída que afeta resultado
    CREATE TABLE IF NOT EXISTS ledger (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id      INTEGER NOT NULL REFERENCES companies(id),
      contract_id     INTEGER REFERENCES contracts(id),
      date            TEXT NOT NULL,
      type            TEXT NOT NULL CHECK (type IN ('CONCESSAO','ROLAGEM','QUITACAO','DESPESA','OUTRA_ENTRADA')),
      description     TEXT NOT NULL,
      amount_cents    INTEGER NOT NULL,        -- positivo = entrada, negativo = saída
      principal_cents INTEGER NOT NULL DEFAULT 0, -- parte do valor que é devolução/saída de principal
      revenue_cents   INTEGER NOT NULL DEFAULT 0, -- parte do valor que é receita (juros + diárias)
      channel         TEXT NOT NULL,           -- DINHEIRO / PIX_MANUAL / OFX / SISTEMA
      notes           TEXT NOT NULL DEFAULT '',
      user_id         INTEGER REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_company ON ledger(company_id, type);

    -- Extrato bancário importado (OFX)
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id     INTEGER NOT NULL REFERENCES companies(id),
      fitid          TEXT NOT NULL,
      date           TEXT NOT NULL,
      description    TEXT NOT NULL,
      amount_cents   INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','CONCILIADO')),
      contract_id    INTEGER REFERENCES contracts(id),
      action         TEXT,                    -- ação confirmada na validação
      validated_by   INTEGER REFERENCES users(id),
      validated_at   TEXT,
      imported_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (company_id, fitid)
    );
  `);
}

module.exports = { openDatabase };
