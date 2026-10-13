# Assinaturas Pix PoseidonPay

## Fonte oficial dos planos

O backend consulta `public.plans` a cada leitura/criação e só oferece planos ativos com os nomes Básico e PRO. Preço, duração e créditos não são recebidos do frontend:

| Plano | Preço por ciclo | Duração | Créditos por ciclo |
|---|---:|---:|---:|
| Básico | R$ 10,99 | 30 dias | 30 |
| PRO | R$ 15,99 | 30 dias | 60 |

O `plan_id` UUID encontrado no Supabase é gravado em `public.subscriptions`. As chaves `basic` e `pro` são identificadores de rota, não IDs de banco.

## Migration

Revise `supabase/migrations/003_poseidonpay_billing.sql` antes de aplicar no projeto Supabase. Ela não recria nem atualiza `plans` ou a estrutura existente de `subscriptions`. Acrescenta tabelas de tentativas/ciclos, habilita RLS sem permissões de escrita aos clientes e disponibiliza a RPC de crédito somente a `service_role`.

A migration foi aprovada para inclusão no repositório, mas não foi executada no Supabase. A política existente `Admins can create subscriptions` foi mantida conforme solicitado. A integração de aplicação usa a chave `service_role`; a política existente não concede acesso à RPC de crédito.

Documentação oficial consultada:

- [Criar assinatura Pix](https://app.poseidonpay.site/docs/v1/endpoint/pix/subscription)
- [Webhook de pagamento](https://app.poseidonpay.site/docs/v1/webhooks/payment)
- [Webhook de assinatura](https://app.poseidonpay.site/docs/v1/webhooks/subscription)
- [Consultar transação](https://app.poseidonpay.site/docs/v1/endpoint/transactions)
- [Consultar assinatura](https://app.poseidonpay.site/docs/v1/endpoint/subscriptions)

## Variáveis de ambiente

Configure apenas no serviço backend:

- `POSEIDON_PUBLIC_KEY`: chave pública PoseidonPay.
- `POSEIDON_SECRET_KEY`: chave secreta PoseidonPay.
- `POSEIDON_WEBHOOK_SECRET`: segredo aleatório longo gerado para proteger o caminho público do webhook.
- `POSEIDON_WEBHOOK_URL`: URL HTTPS completa `https://<api>/api/webhooks/poseidon/<POSEIDON_WEBHOOK_SECRET>`.

As chaves PoseidonPay e o segredo do webhook não podem usar prefixo `VITE_` nem ser configurados no Netlify/frontend. `POSEIDON_WEBHOOK_URL` deve apontar para o backend publicamente acessível e terminar exatamente com o segredo configurado. Use um segredo URL-safe.

No Render, adicione as quatro variáveis secretas/privadas listadas em `render.yaml`. O cliente continua usando somente `VITE_API_URL` e as variáveis públicas do Supabase.

## Fluxo

1. O frontend carrega `GET /api/plans`; o servidor lê preço, duração e créditos diretamente de `public.plans`.
2. O cliente autenticado inicia `POST /api/plans/{basic|pro}/subscription/pix` com `Idempotency-Key` e somente os dados do cliente. O servidor grava a tentativa pendente e uma linha `pending` em `subscriptions` antes de solicitar a cobrança.
3. O backend envia `POST https://app.poseidonpay.site/api/v1/gateway/pix/subscription` com `x-public-key` e `x-secret-key`. A cobrança tem um identificador UUID diferente e persistido antes da chamada. Repetir a mesma chave de idempotência reutiliza a tentativa e não cria outra cobrança.
4. A resposta e a consulta de status no frontend nunca ativam a assinatura. O QR Pix, código copia e cola, preço, plano e status são apresentados a partir da tentativa persistida.
5. O webhook precisa ter segredo correto no caminho e conter o campo documentado `token`. Quando o ID corresponde à transação inicial, o backend compara o token do evento com o hash SHA-256 do `webhookToken` retornado pela criação. Para renovações, cancelamento e expiração, não presume que esse token inicial continua válido: valida o segredo independente no caminho e consulta o estado remoto pela API autenticada com as chaves do servidor. Só concede créditos quando a PoseidonPay confirma `COMPLETED`, `RECURRING`, `PIX`, valor e IDs correspondentes.
6. Cancelamento e expiração só alteram o estado local após consulta autenticada confirmar o estado remoto correspondente.
7. A RPC registra cada `gateway_transaction_id` e ciclo uma única vez, soma `plans.monthly_credits`, atualiza a assinatura e registra a transação de crédito na mesma transação SQL. Eventos duplicados não geram novos créditos.

O webhook processa `TRANSACTION_PAID`, `SUBSCRIPTION_STARTED`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_RENEWAL_PENDING`, `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_EXPIRED` e `TRANSACTION_CANCELED`. Um início em período de teste ou pagamento pendente não concede créditos.

## Configurar webhook na PoseidonPay

1. Faça deploy do backend em uma URL HTTPS estável.
2. Gere um segredo criptograficamente aleatório URL-safe com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, configure `POSEIDON_WEBHOOK_SECRET` e configure `POSEIDON_WEBHOOK_URL` com esse mesmo valor no caminho.
3. A aplicação envia essa URL como `callbackUrl` ao criar cada assinatura Pix. Não coloque `webhookToken` ou chaves no navegador.
4. No painel da PoseidonPay, habilite/configure notificações de pagamento e de assinatura para a mesma URL quando essa opção estiver disponível para sua conta. Eventos necessários: pagamento pago/cancelado e assinatura iniciada/renovada/renovação pendente/cancelada/expirada. Início de período de teste não concede créditos.
5. Confirme no painel que a URL está aceita pela validação anti-SSRF da PoseidonPay e teste com eventos de sandbox, se disponíveis. O backend responde `503` quando a consulta autenticada falha; confirme a política de retentativa de webhook da sua conta.
6. Valide ponta a ponta primeiro em ambiente de teste. Não use a criação de cobrança em testes automatizados.

## Endpoints

- `GET /api/plans`: catálogo ativo, sem exigir login.
- `POST /api/plans/:plan/subscription/pix`: criação autenticada; exige `Idempotency-Key` e body `{ "client": { "name": "...", "email": "...", "phone": "..." } }`.
- `GET /api/billing/payment-attempts/:id`: status e dados Pix da tentativa do usuário autenticado.
- `GET /api/billing/subscriptions`: assinaturas do usuário autenticado.
- `POST /api/webhooks/poseidon/:secret`: callback público com validação do segredo no caminho e reconciliação autenticada com a PoseidonPay.

## Testes e limitações de validação

Execute `npm --prefix server test` e `npm run build` na raiz. Os testes usam stubs e não fazem chamadas ou cobranças reais.

O workspace não contém credenciais Supabase/PoseidonPay nem acesso à instância Supabase. Portanto a migration não foi executada remotamente, e o webhook real/sandbox e a assinatura efetiva não foram verificados neste ambiente. A política `Admins can create subscriptions` existente foi mantida por decisão do proprietário; a condição `WITH CHECK` não foi confirmada. Por isso, não é possível certificar aqui que criação direta de linhas esteja restrita a administradores. A concessão de créditos, porém, só é executável via `service_role`. A integração não deve ser considerada validada em produção até a migration final ser revisada/aplicada, a política existente ser auditada e o fluxo completo ser testado com as credenciais e eventos de teste do provedor.
