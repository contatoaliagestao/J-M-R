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
  | **Operador** | Consulta de contratos, painel de cobrança e registro de ocorrências nas empresas liberadas |
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

## Como rodar no computador

Pré-requisito: [Node.js](https://nodejs.org) versão 22.9 ou mais recente.

```bash
npm install
```

```bash
npm start
```

Depois abra http://localhost:3000 no navegador e faça o cadastro inicial.

Para rodar os testes automáticos:

```bash
npm test
```

## Como colocar no ar (hospedagem)

O sistema é um único servidor Node.js e guarda os dados em um arquivo SQLite (`data/jmr.db`). Ele funciona em qualquer serviço que rode Node.js **com disco persistente**, por exemplo Render (com *Persistent Disk*), Railway (com *Volume*) ou uma VPS.

1. Comando de instalação: `npm install`. Comando de início: `npm start`.
2. Configure as variáveis de ambiente (veja `.env.example`). As principais são:
   - `DATA_DIR`: pasta do disco persistente (ex.: `/var/data`)
   - `NODE_ENV=production` e `TRUST_PROXY=true`
3. Use **HTTPS**, que esses serviços já oferecem.
4. **Faça backup** do arquivo `jmr.db` regularmente.

## Esqueci a senha

- **Usuários:** o administrador define uma nova senha em *Usuários e acessos → Editar*.
- **Administrador:** no servidor, rode:

```bash
npm run reset-senha-admin -- "nova-senha-aqui"
```

## Estrutura do projeto

```
src/server.js     Servidor e rotas da API (com as permissões)
src/finance.js    Regras de cálculo (juros, diárias, rolagem)
src/ofx.js        Leitura do extrato OFX e sugestão de vínculo
src/auth.js       Senhas (scrypt), sessões e limite de tentativas de login
src/db.js         Estrutura do banco de dados
public/           Telas do sistema (HTML, JavaScript e CSS)
test/             Testes automáticos
```

Se você alterar as classes visuais em `public/index.html` ou `public/app.js`, gere o CSS de novo:

```bash
npm run build:css
```
