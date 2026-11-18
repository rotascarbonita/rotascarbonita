# Rotas Carbonita · GitHub + Supabase

Versão web independente do Google Apps Script. O frontend usa JavaScript + Vite, o banco usa PostgreSQL no Supabase e os acessos usam Supabase Auth. O GitHub guarda o código e pode hospedar o frontend pelo Pages.

Foram preservados os perfis Secretaria, Escola e Monitor; rotas compartilhadas; cadastro de escolas, turmas, pontos e estudantes; importação XLSX; crachás e substituição; chamada manual e QR; ida/volta; encerramento de dia; motivos após três dias de ausência; relatórios e CSV.

O pacote contém o código migrado e os testes. **Não contém a planilha de produção e ainda não está publicado nem conectado a uma conta Supabase.**

## Começar

1. No Supabase, crie um projeto vazio e execute **`supabase/INSTALAR.sql`** no SQL Editor.
2. Copie `.env.example` para `.env` e preencha os valores da sua conta. Para transferir os cadastros atuais, siga [a migração dos dados](docs/MIGRACAO.md) antes de criar novos cadastros no destino.
3. Instale as dependências com `npm ci`. Recrie os acessos importados com `npm run users:provision`. Se começar sem dados antigos, use `npm run users:provision -- --bootstrap`.
4. Publique a Edge Function e o frontend seguindo [a configuração e publicação](docs/PUBLICACAO.md).

As senhas temporárias ficam **apenas no seu computador**, em `.private/acessos-temporarios.json`. A troca é obrigatória no primeiro login.

## Desenvolver

Requer Node.js 22.12 ou superior.

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
```

A aplicação pede configuração quando as duas variáveis públicas do Supabase não estão preenchidas. Ela não usa dados fictícios em substituição ao banco.

## Organização

| Caminho | Conteúdo |
| --- | --- |
| `src/client.js` | Interface adaptada do app original |
| `src/backend.js` | Autenticação, RPC e atualização em tempo real |
| `public/vendor/` | Leitura QR, geração de crachás e importação XLSX sob demanda |
| `supabase/migrations/` | Esquema, permissões e regras de negócio |
| `supabase/functions/manage-users/` | Criação e redefinição de acessos no servidor |
| `scripts/` | Exportação, preparação dos dados e recriação de acessos |
| `.github/workflows/` | Testes automáticos e publicação manual no Pages |

## O que melhora na arquitetura

O navegador carrega arquivos estáticos, sem depender do HTMLService. Cada consulta do painel é uma RPC ao PostgreSQL. Os embarques têm índices e restrição única por estudante/data/sentido; duas monitoras podem usar o app simultaneamente. Apenas alterações de catálogo compartilham lock; os embarques usam um lock específico por aluno/data/sentido.

Atualizações do banco podem avisar as telas por Supabase Realtime. Uma consulta leve a cada 60 segundos, enquanto o app está aberto, cobre perda de conexão com esse canal. Dados pessoais não são enviados pelo canal, que publica apenas uma revisão numérica.

Não foi medido tempo de resposta no ambiente real. Região do projeto, volume de dados e conexão das monitoras influenciam a velocidade. A aplicação requer internet e **não confirma embarques offline**.

## Validação

Os testes executam as migrações e as regras em PostgreSQL incorporado (PGlite). Cobrem isolamento de perfis, RLS, troca de senha obrigatória, crachás aposentados, repetição de embarque, importação com prévia e confirmação, ausências e unificação de rotas. A comunicação com Supabase Auth, a Edge Function, o Realtime, o Pages e a câmera devem ser validados na conta e nos aparelhos reais antes da mudança definitiva.

Documentação oficial: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Auth Admin](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [Edge Functions](https://supabase.com/docs/guides/functions/auth), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
