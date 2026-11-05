# JMR — Sistema de Gestão Financeira

Sistema web para gestão de **empréstimos, cobrança e conciliação bancária**, com suporte a **até 3 empresas** no mesmo sistema.

## Funcionalidades

- **Tela de login.** O administrador entra com **e-mail**; os demais usuários entram com o **nome de usuário** criado pelo administrador.
- **Cadastro inicial:** no primeiro acesso, o sistema pede os dados do administrador (e-mail e senha) e da 1ª empresa. Essa tela aparece só uma vez.
- **Até 3 empresas**, cada uma com cor, logotipo e numeração própria de contratos (ex.: `JMR-1001`).
- **Usuários e permissões:**
  | Perfil | O que pode fazer |
  |---|---|
  | **Administrador** | Tudo, em todas as empresas, além de cadastrar empresas e usuários |
  | **Gestor** | Dashboard, contratos, novos empréstimos, baixas, cobrança e conciliação nas empresas liberadas |
  | **Operador** | Lançamento de novos empréstimos, consulta de contratos, painel de cobrança e registro de ocorrências nas empresas liberadas (sem baixas, dashboard ou conciliação) |
- **Contratos:** cadastro do cliente (CPF, WhatsApp, endereço, rede social), valor, taxa de juros, diária de atraso e ciclo (15 ou 30 dias).
- **Baixa manual:** rolagem (paga juros + diárias, vencimento avança 1 ciclo) ou quitação total.
- **Cobrança:** lista de atrasados, texto de cobrança pronto para copiar e atalho para o WhatsApp.
- **Ficha do cliente:** histórico automático (concessão, rolagens, quitação) e ocorrências livres.
- **Conciliação OFX:** importa o extrato do banco, sugere o contrato e a ação de cada Pix/TED e exige validação manual. Reimportar o mesmo extrato não duplica lançamentos.
- **Relatório de inadimplência** pronto para imprimir.

## Regras financeiras

Considere um contrato de **R$ 2.000** a **20%** por ciclo, com diária de **10%**:

| Item | Cálculo | Exemplo |
|---|---|---|
| Juros do ciclo | principal × taxa | R$ 400,00 |
| Diária de atraso | (principal + juros) × taxa da diária, por dia | R$ 240,00 / dia |
| Rolar (4 dias de atraso) | juros + diárias | R$ 400 + R$ 960 = **R$ 1.360,00** |
| Quitar (4 dias de atraso) | principal + juros + diárias | **R$ 3.360,00** |

- Na rolagem, o novo vencimento é **vencimento atual + ciclo**. Se o contrato já estiver vencido, conta-se **hoje + ciclo**.
- No dia do vencimento ainda não há atraso.
- Os valores são calculados no servidor, em centavos, para evitar erros de arredondamento.

## Onde o sistema está publicado

O sistema roda no **Cloudflare Workers**, com o banco de dados **Cloudflare D1** (SQLite gerenciado, com cópias automáticas dos últimos 30 dias).

- Endereço: https://jmr-gestao.jmr-gestao-financeira.workers.dev
- Banco D1: `jmr-db`
- No primeiro acesso, a tela de configuração pede um **código de configuração**. Esse código fica guardado como segredo `SETUP_CODE` no Cloudflare e impede que um estranho que encontre o endereço faça o cadastro inicial.

## Como rodar no computador (para testes)

Pré-requisito: [Node.js](https://nodejs.org) versão 20 ou mais recente.

```bash
npm install
```

```bash
npm run dev
```

Depois abra http://localhost:8787 no navegador. O banco local fica na pasta `.wrangler/` e não mistura com o banco publicado.

Para rodar os testes automáticos (eles usam o simulador local do Cloudflare):

```bash
npm test
```

## Como publicar uma nova versão

É preciso um API Token do Cloudflare com as permissões do modelo **"Edit Cloudflare Workers"** mais **D1 → Edit**.

```bash
CLOUDFLARE_API_TOKEN=seu-token npm run deploy
```

O comando empacota as telas, aplica no banco as mudanças de estrutura que ainda não foram aplicadas (pasta `migrations/`) e publica o Worker.

## Esqueci a senha

- **Usuários:** o administrador define uma nova senha em *Usuários e acessos → Editar*.
- **Administrador:** com o token do Cloudflare configurado, rode:

```bash
CLOUDFLARE_API_TOKEN=seu-token npm run reset-senha-admin -- "nova-senha-aqui"
```

## Estrutura do projeto

```
src/worker.js          Servidor (Cloudflare Worker): rotas da API e permissões
src/finance.js         Regras de cálculo (juros, diárias, rolagem)
src/ofx.js             Leitura do extrato OFX e sugestão de vínculo
src/auth.js            Senhas (PBKDF2), sessões e limite de tentativas de login
migrations/            Estrutura do banco de dados (D1)
public/                Telas do sistema (HTML, JavaScript e CSS)
scripts/               Empacotamento das telas e redefinição de senha do administrador
test/                  Testes automáticos
wrangler.jsonc         Configuração do Cloudflare
```

Se você alterar as classes visuais em `public/index.html` ou `public/app.js`, gere o CSS de novo:

```bash
npm run build:css
```
