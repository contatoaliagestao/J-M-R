// Redefine a senha do administrador no banco do Cloudflare (use se ele esquecer a senha).
// Uso:  npm run reset-senha-admin -- "nova-senha-aqui"
// Para o banco local de testes, acrescente --local:  npm run reset-senha-admin -- "nova-senha" --local

import { execFileSync } from 'node:child_process';
import { hashPassword, validatePasswordStrength } from '../src/auth.js';

const args = process.argv.slice(2);
const local = args.includes('--local');
const newPassword = args.find(a => !a.startsWith('--'));

const err = validatePasswordStrength(newPassword);
if (err) {
  console.error(`Erro: ${err}\nUso: npm run reset-senha-admin -- "nova-senha-aqui"`);
  process.exit(1);
}

const hash = await hashPassword(newPassword);
if (!/^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(hash)) throw new Error('hash inesperado');

const sql = `UPDATE users SET password_hash = '${hash}' WHERE role = 'ADMIN'; ` +
  `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role = 'ADMIN');`;

execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', local ? '--local' : '--remote', '--command', sql], { stdio: 'inherit' });
console.log('\nSenha do administrador redefinida. Use a nova senha para entrar.');
