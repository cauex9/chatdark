# WebForge AI — MVP inicial

Plataforma SaaS de criação de sites com IA, baseada no prompt fornecido. **Código real, mas ainda não é uma plataforma pronta para produção comercial.**

## Funciona nesta versão

- Landing page responsiva, tema escuro, exemplos de prompt.
- Supabase Auth: cadastro, login, logout e solicitação de recuperação de senha.
- Dashboard com projetos reais do banco, renomear, excluir e acesso ao editor.
- Criação de projeto (limite gratuito de um projeto), persistência no Supabase.
- Backend autenticado que solicita geração de arquivos React/TypeScript via OpenRouter.
- Editor Monaco, salvamento de arquivos, histórico de versões e restauração.
- Preview **estático e restrito**, sem executar JavaScript da IA.
- Exportação ZIP dos arquivos gerados.
- Crédito inicial de 3 gerações, débito atômico e devolução em falhas.

## Instalação local (PowerShell)

1. Em um projeto novo, execute `supabase/migrations/001_init.sql`. Para o banco existente com `public.plans` e `public.subscriptions`, não recrie essas tabelas; revise e aplique `supabase/migrations/003_poseidonpay_billing.sql` antes de habilitar o checkout. A migration antiga `002_billing_subscriptions.sql` não é usada pelo fluxo novo.
2. Copie `client/.env.example` para `client/.env` e `server/.env.example` para `server/.env`.
3. Configure URL e **chave publishable** do Supabase no cliente. Configure URL e **chave secret** somente no servidor. Configure `OPENROUTER_API_KEY` e `OPENROUTER_MODEL` no servidor. Para receber Pix, configure `POSEIDON_PUBLIC_KEY`, `POSEIDON_SECRET_KEY`, `POSEIDON_WEBHOOK_SECRET` e `POSEIDON_WEBHOOK_URL` somente no servidor, conforme [INTEGRACAO_ASSINATURAS.md](./INTEGRACAO_ASSINATURAS.md).
4. Na pasta raiz execute:

```powershell
npm install
npm run install:all
npm run dev
```

5. Abra http://localhost:5173. O backend estará em http://localhost:4000/health.
6. No Supabase Auth, configure Site URL e Redirect URLs do seu frontend. Para recuperação de senha, ainda é necessário implementar a tela de definição de nova senha (ver limitações).

## Deploy

- **Netlify:** conectar repositório; `netlify.toml` usa `client` como base, `npm run build`, publicação `dist`. Configurar `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_API_URL` (URL do Render). Variáveis VITE são públicas; nunca use a chave secreta.
- **Render:** `render.yaml` incluído. Configurar variáveis listadas em `server/.env.example`, `CLIENT_ORIGIN=https://SEU-SITE.netlify.app`. Serviço Node. Planos gratuitos podem mudar e suspender por inatividade.
- **Supabase:** banco/Auth externo com cotas gratuitas sujeitas a mudanças.
- **OpenRouter:** requer conta, chave e modelo válido configurado. Modelos gratuitos podem ter limites e indisponibilidade. O uso pode ter custo.

## Limitações importantes

- Preview estático (`preview.html`) isolado em iframe sandbox sem scripts. **Não executa o app React gerado**. Para preview React real é necessário um serviço de build/sandbox isolado por projeto com recursos e rede restritos; não habilite execução arbitrária no servidor principal.
- Os arquivos React gerados pela IA são validados quanto a nomes/tamanho, mas **não são compilados nem auditados automaticamente**. Confira antes de publicar.
- Pix: o backend usa os registros ativos de `public.plans`, cria assinaturas Pix recorrentes na PoseidonPay, apresenta QR Code/copia-e-cola e processa webhooks somente após reconciliar o pagamento pela API autenticada. Créditos de 30 (Básico) ou 60 (PRO) são concedidos uma vez por transação/ciclo confirmado. A migration ainda precisa ser aplicada e o webhook exercitado no ambiente do provedor; não habilite cobrança de produção antes disso. Veja [INTEGRACAO_ASSINATURAS.md](./INTEGRACAO_ASSINATURAS.md).
- Recuperação de senha envia e-mail pelo Supabase, mas ainda falta página de redefinição no cliente.
- Exportação ZIP inclui arquivos gerados; execute código exportado somente após revisão.
- Geração IA não tem fila durável e não há proteção completa contra falhas parciais de gravação de arquivos.
- Para uso comercial, completar políticas de privacidade/termos, testes, monitoramento, verificação de build e isolamento de projetos.

## Segurança

- Nunca coloque `sb_secret_` nem `OPENROUTER_API_KEY` em `client/.env`, GitHub ou Netlify.
- Se você já divulgou uma chave secreta, **revogue-a no Supabase e gere outra**.
- Backend valida token Supabase; dados privados usam RLS no banco e serviço backend com autorização.
- Não use o projeto como plataforma de execução de código não confiável em produção sem infraestrutura de sandbox.

## Atualização visual e otimização de geração

- Identidade visual grafite/verde-lima com logo fornecida em `client/public/webforge-logo.jpg`.
- Nova página inicial responsiva, ajustes de botões, formulários e cards; editor com indicador de espera.
- O backend aceita `OPENROUTER_TIMEOUT_MS` (padrão 90000 ms) e `OPENROUTER_MAX_TOKENS` (padrão 6500). O contexto de arquivos existentes foi reduzido para diminuir o tamanho da requisição. Se o modelo retornar JSON incompleto, aumente o limite de tokens.
- A velocidade efetiva depende do modelo configurado em `OPENROUTER_MODEL` e do provedor. Não há streaming nesta versão.
- Esta atualização não aplica migrations nem configura credenciais. Teste a integração Pix em ambiente de testes antes de produção.
