# Revisão e limites dos testes

- Backend MandAPI integrado a partir do pacote MandAPI anterior. Não contém segredos.
- Cliente: configuração inválida do Supabase não derruba mais o carregamento do React; exibe erro de configuração visível.
- Cliente: erros ao recuperar sessão tratados e fallback para falhas de renderização.
- Botões de login/cadastro possuem handlers e formulário com onSubmit no código.
- É necessário manter as configurações originais em client/.env.local e server/.env no computador. Reiniciar npm run dev após editar.
- Testes reais de cadastro, login, banco, geração MandAPI e pagamento requerem credenciais e serviços externos; não foram executados.
- Pendências: auditar 11 alertas npm audit do cliente, testar Supabase Auth e migrações, crédito/estorno, cobranças e preview.

## Testes executados nesta revisão
- TypeScript do cliente: PASSOU (`tsc --noEmit -p client/tsconfig.json`).
- TypeScript do servidor: PASSOU (`tsc -p server/tsconfig.json`).
- Vite build: NÃO EXECUTÁVEL neste ambiente, devido a módulo nativo Rollup ausente no node_modules vindo do Windows.
- Testes automatizados do backend: NÃO CONCLUÍDOS neste ambiente, devido a dependências de execução não disponíveis.
- Navegador e serviços externos: NÃO TESTADOS; é indispensável verificar cadastro, login e geração localmente.
