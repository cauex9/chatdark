# Integração MandAPI (teste local)

O projeto usa agora POST https://api.mandapi.com/v1/chat/completions no backend.

1. Copie suas configurações privadas de `server/.env` da instalação anterior, sem compartilhar esse arquivo.
2. Remova OPENROUTER_API_KEY e OPENROUTER_MODEL, e adicione:

```env
MANDAPI_API_KEY=SUA_CHAVE_PRIVADA
MANDAPI_MODEL=claude-sonnet-4-6
MANDAPI_TIMEOUT_MS=180000
MANDAPI_MAX_TOKENS=8500
```

3. No PowerShell, na pasta do projeto, rode `npm install`, `npm install --prefix client`, `npm install --prefix server`, `npm run build` e `npm run dev`.
4. Faça primeiro um teste pequeno com um usuário que tenha créditos de geração no Supabase.

IMPORTANTE: o saldo da MandAPI é separado dos créditos internos do WebForge AI. A aplicação ainda exige o RPC reserve_generation_credit. Não há garantia de JSON válido em toda chamada; se falhar, o crédito interno deve ser estornado. Se a devolução falhar, o backend agora informa um requestId para auditoria.

Não foram incluídos .env nem node_modules no ZIP. O frontend e o fluxo de pagamentos não foram alterados. Antes de produção, testar autenticação, geração, estorno e atomicidade do salvamento de arquivos.
