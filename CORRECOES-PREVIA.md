# Correção da prévia interativa

A prévia agora permite JavaScript inline **somente dentro de um iframe com origem isolada**. A política CSP bloqueia chamadas de rede por script, formulários e frames internos. Imagens HTTPS podem ser carregadas; links externos abrem nova aba, sujeitos às restrições do navegador.

A IA recebe instruções para gerar `preview.html` interativo, com carrinho e botões funcionais. Sites antigos não são alterados automaticamente: gere nova versão ou peça para recriar a prévia.

**Limites:** não há garantia de disponibilidade de imagens externas; a IA não possui biblioteca de imagens licenciadas. A prévia é HTML/JS e não compila automaticamente `src/App.tsx`. A exportação ZIP contém o projeto React, não `preview.html`; teste o projeto exportado separadamente. Não use URLs de chat como checkout; forneça o link de pagamento correto.

## Instalação (PowerShell)

Entre na pasta que contém `package.json` após extrair o ZIP. Copie `server/.env` e `client/.env.local` da instalação anterior, sem divulgar chaves. Rode `npm install`, `npm run install:all`, `npm run build` e `npm run dev`.
