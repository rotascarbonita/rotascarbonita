# Configurar e publicar

## Supabase

1. Crie o projeto e execute `supabase/INSTALAR.sql` no SQL Editor **uma vez**. Esse arquivo reúne as cinco migrações na ordem correta. Não execute também as migrações individuais no mesmo banco.
2. Em Authentication, desative a criação pública de contas e configure o mínimo de senha em 12 caracteres. Os usuários são criados pela Secretaria.
3. Copie a Project URL e a chave **publishable/anon pública** para o `.env`, nas variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`.
4. Para os scripts administrativos locais, preencha `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. Essa chave privada não pode ter prefixo `VITE_`, ir para o GitHub ou ser usada no navegador.
5. Transfira os dados e provisione os acessos seguindo `MIGRACAO.md`. Se começar com um banco vazio, execute `npm run users:provision -- --bootstrap` para criar o primeiro login `admin`.

Os logins individuais continuam no formato `admin`, `elenice` etc. Internamente, o Auth usa endereços técnicos `login@acesso.rotas.invalid`; não há envio de e-mail para esses endereços. A recuperação de senha é feita pela Secretaria na tela Acessos. A Secretaria recupera o próprio acesso por um administrador do projeto Supabase.

### Publicar a função de gerenciamento de acessos

Na pasta do projeto:

```sh
npx supabase login
npx supabase functions deploy manage-users --project-ref SEU_PROJECT_REF
```

O `project-ref` aparece na configuração do seu projeto Supabase. O arquivo `supabase/config.toml` já configura a função. Ela verifica o token com `auth.getUser` e o perfil no banco antes de usar a chave de serviço. `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são disponibilizadas no ambiente hospedado das Edge Functions pelo Supabase.

Uma redefinição interrompida mantém a conta bloqueada para operações do aplicativo. A Secretaria deve repetir a redefinição e concluí-la. Alterações em Auth e PostgreSQL são serviços distintos; a função evita liberar uma conta com redefinição pendente.

## GitHub

Crie o repositório destinado ao app e envie o conteúdo desta pasta, incluindo `.github/`, `.gitignore` e os arquivos de código. Não envie a pasta `.private/`, o `.env`, a exportação JSON ou os dados SQL gerados.

Se usar Git no computador:

```sh
git init
git add .
git commit -m "Migra Rotas Carbonita para Supabase"
git branch -M main
git remote add origin URL_DO_SEU_REPOSITORIO
git push -u origin main
```

Em **Settings → Secrets and variables → Actions → Variables**, cadastre:

| Nome | Valor |
| --- | --- |
| `VITE_SUPABASE_URL` | Project URL do seu Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Chave publishable/anon pública |
| `VITE_BASE_PATH` | Opcional; por padrão usa `/nome-do-repositorio/` |

Em **Settings → Pages → Build and deployment**, selecione **GitHub Actions**. A disponibilidade de Pages em repositório privado depende do seu plano GitHub. O código não contém os registros da planilha; o app publicado exige autenticação e o banco bloqueia leitura direta dos dados pessoais.

Em **Actions → Publicar app no GitHub Pages → Run workflow**, inicie a publicação. Os testes e o build precisam passar. O workflow exibe a URL final. A publicação é manual; novos commits executam a verificação do app, e uma nova publicação requer executar o workflow novamente.

Para um repositório de site raiz (`usuario.github.io`) ou domínio próprio na raiz, configure `VITE_BASE_PATH` como `/`. Para um repositório comum, mantenha o padrão.

## Conferência no aparelho

Use a URL HTTPS publicada para permitir a câmera. Autorize o acesso à câmera no navegador e teste a lente traseira. O app usa o leitor dentro da própria tela; a aba externa do Apps Script foi removida. A leitura por foto e o código digitado continuam disponíveis como alternativas.

Sem internet, um embarque não deve aparecer como confirmado. Após reconectar, leia o crachá novamente; a restrição única impede um segundo registro no mesmo dia e sentido.

## Evoluir depois da implantação

Depois da instalação inicial, aplique alterações do banco como novas migrações. Não reaplique `INSTALAR.sql` e não substitua o banco com uma exportação antiga. Para novas versões do frontend, envie os commits, confira o workflow Verificar app e execute a publicação manual.
