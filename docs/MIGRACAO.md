# Transferir os dados atuais

O ZIP original contém o código e uma lista de pontos. Ele não inclui as linhas da planilha de produção. O procedimento abaixo transfere os dados sem copiar senhas, sessões ou segredos do Apps Script.

## 1. Exportar a planilha

Faça uma cópia da planilha atual. No projeto Apps Script existente, adicione **um novo arquivo** chamado `ExportarParaSupabase` e cole o conteúdo de `scripts/ExportarParaSupabase.gs`. Execute `exportarParaSupabase` no editor e autorize a exportação quando o próprio Google solicitar.

O log fornece o link de um JSON criado no seu Drive. Baixe esse arquivo. A exportação só lê os dados do sistema; não altera o cadastro e não compartilha o arquivo.

## 2. Preparar e conferir

No computador, dentro da pasta deste projeto:

```sh
npm ci
npm run migrate:prepare -- CAMINHO_DO_ARQUIVO/Rotas_Carbonita_exportacao.json
```

São gerados dois arquivos locais:

| Arquivo | Uso |
| --- | --- |
| `.private/migracao/conferencia.json` | Quantidade de registros por tabela |
| `.private/migracao/dados.sql` | Importação transacional dos dados |

O preparador preserva os IDs, os tokens QR existentes, os códigos impressos e os códigos aposentados. Ele confere referências, logins, crachás e duplicidade de chamadas. Inconsistências interrompem a preparação e precisam ser corrigidas antes de importar. Estudantes sem código impresso recebem um novo código; o QR existente é mantido quando disponível.

Confira as quantidades de estudantes, escolas, rotas, pontos, usuários e chamadas com a planilha. Esses arquivos têm dados pessoais e ficam em uma pasta ignorada pelo Git.

## 3. Importar no Supabase vazio

Execute `supabase/INSTALAR.sql` no SQL Editor de um projeto novo. Depois, execute o conteúdo de `.private/migracao/dados.sql`. O importador interrompe a operação se já houver escolas, estudantes ou usuários no destino. Não use esse arquivo como atualização incremental de um banco em uso.

Todas as linhas são importadas dentro de uma transação. Uma referência inválida ou outro erro cancela a importação inteira. Não apague tabelas para contornar um erro; confira a causa na mensagem do SQL Editor.

## 4. Recriar os acessos

Preencha as variáveis locais do `.env`, incluindo a chave privada do Supabase, e execute:

```sh
npm run users:provision
```

O script provisiona as contas ativas, preserva o ID do perfil e vincula cada uma à sua identidade no Supabase Auth. A senha antiga não é migrável: o sistema anterior usava um hash com segredo próprio. Senhas temporárias aleatórias ficam em `.private/acessos-temporarios.json`, sem aparecer no terminal. Não envie esse arquivo ao GitHub.

Entregue os acessos individualmente pelo seu processo habitual. Cada pessoa troca a senha no primeiro login. A mudança de senha é validada no servidor; remover o aviso da interface não libera o acesso. Contas inativas continuam sem acesso.

O script grava checkpoints antes de criar as identidades. Se for interrompido, pode ser repetido sem redefinir a senha de uma identidade existente que não corresponda ao checkpoint. Um conflito de login no Authentication exige revisão administrativa.

## 5. Conferir antes da troca definitiva

Entre como Secretaria, Escola e Monitor em sessões separadas. Confira um estudante de cada escola e uma rota compartilhada. Teste um crachá já impresso, os dois sentidos, a leitura repetida, a importação XLSX e o fechamento do dia. Duas monitoras devem poder trabalhar ao mesmo tempo na mesma rota.

Os alertas usam **dias de transporte encerrados**, e não dias corridos. Dias com presença ou com chamada ainda aberta interrompem a sequência. O encerramento preserva as escolas atendidas naquela data.

Na mudança definitiva, interrompa os registros no sistema antigo, faça uma exportação final e repita a importação em um destino novo/vazio. Não mantenha os dois aplicativos recebendo chamadas em paralelo: não existe sincronização automática entre a planilha e o Supabase.

Mantenha a planilha original e sua cópia até concluir a conferência. Se voltar ao app antigo depois de registrar novas chamadas no Supabase, será preciso conciliar essas chamadas antes de retomar o uso; não há retorno automático de dados.
