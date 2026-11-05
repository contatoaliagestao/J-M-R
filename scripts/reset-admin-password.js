'use strict';

// Redefine a senha do administrador (use se ele esquecer a senha).
// Uso: npm run reset-senha-admin -- "nova-senha-aqui"

const { openDatabase } = require('../src/db');
const { hashPassword, validatePasswordStrength } = require('../src/auth');

const newPassword = process.argv[2];
const err = validatePasswordStrength(newPassword);
if (err) {
  console.error(`Erro: ${err}\nUso: npm run reset-senha-admin -- "nova-senha-aqui"`);
  process.exit(1);
}

const db = openDatabase();
const admin = db.prepare("SELECT id, email FROM users WHERE role = 'ADMIN'").get();
if (!admin) {
  console.error('Nenhum administrador cadastrado ainda. Abra o sistema no navegador para fazer o cadastro inicial.');
  process.exit(1);
}
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), admin.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
console.log(`Senha do administrador (${admin.email}) redefinida com sucesso.`);
