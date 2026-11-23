# Rotas Carbonita · Tela da monitora e cadastro de estudantes

Em Estudantes, o campo Turno permite marcar Manhã, Tarde ou os dois. A ficha de edição carrega os turnos já salvos.

No celular, o perfil de monitora abre em Chamada. A barra inferior em React tem Visão geral, Estudantes, Relatórios e Perfil. Se o JavaScript da barra falhar no carregamento, a navegação original continua disponível. Para retornar à chamada de hoje, toque em Chamada no topo. Alterar senha e Sair ficam em Perfil.

## Publicação

1. Preserve em script.js a URL e a chave pública do Supabase usadas pela versão publicada, caso sua configuração local seja diferente da que acompanha o pacote.
2. Publique `index.html`, `script.js`, `styles.css`, `favicon.svg` e a pasta `assets/` no mesmo diretório do GitHub Pages. O ZIP já contém os arquivos compilados da barra.

## Banco sem suporte a turnos

Se o formulário informar que o banco precisa da atualização de turnos, use o SQL Editor do Supabase existente. Aplique os scripts da pasta supabase nesta ordem:

1. ATUALIZAR_TURNOS_E_ADVERTENCIAS.sql
2. ATUALIZAR_CRACHAS_E_MONITORAS.sql
3. LIBERAR_CADASTRO_E_CRACHAS_MONITORAS.sql

Os dois últimos reaplicam os ajustes de crachás e acesso das monitoras sobre as funções da atualização de turnos. Se a primeira migração já estiver ativa no banco atual, basta publicar os arquivos do site.

## Editar a barra

| Arquivo | Função |
| --- | --- |
| `components/ui/bottom-nav-bar.tsx` | Componente de navegação reutilizável |
| `components/ui/demo.tsx` | Exemplo isolado com seleção local |
| `components/monitor-dock.tsx` | Conecta a barra ao estado e às telas do portal |
| `navbar.css` | Entrada do Tailwind CSS e estilos da barra |
| `styles.css` | Estilos gerais do portal |
| `assets/monitor-dock.js` e `assets/monitor-dock.css` | Arquivos compilados usados por `index.html` |

Na raiz do pacote, execute `npm ci` e `npm run build`. A compilação valida o TypeScript e regenera os dois arquivos em `assets/`. React, Lucide, Framer Motion e Tailwind estão no `package.json`. O Tailwind carrega as utilidades da barra sem aplicar um reset global ao portal.

O portal original não tinha pastas de componentes. O alias `@/components/ui` agora aponta para `components/ui/`, onde ficam os componentes reutilizáveis e onde a estrutura shadcn pode localizar os componentes de interface. O `components.json` registra esse alias e aponta para `navbar.css`.

### Se for levar o componente a outro projeto

Num projeto React + TypeScript existente com Tailwind v4, configure o alias `@/*` para o diretório de código e execute `npx shadcn@latest init` se o projeto ainda não tiver shadcn. Use o alias `@/components/ui` para os componentes de interface e indique seu CSS global em `tailwind.css` dentro de `components.json`. Instale `lucide-react` e `framer-motion` com `npm install lucide-react framer-motion`. Copie o componente e os estilos `.rotas-bottom-nav`, incluindo a regra móvel para `.rotas-bottom-nav--fixed` se usar a versão fixa. Passe `activeTab` e `onNavigate` para ligar a barra à navegação real.

Se começar do zero, o template React + TypeScript do Vite fornece TypeScript. Para configurar também Tailwind e shadcn, siga o [guia do shadcn para Vite](https://ui.shadcn.com/docs/installation/vite).
