# Revisão de avisos e planos

- Corrigida a apresentação de sessão inválida e mensagens de erro comuns.
- Avisos visuais de sucesso, atenção e informação em português, com fechamento e duração de 9 segundos.
- Cadastro informa os 2 créditos gratuitos. Execute a migração `004_free_two_credits.sql` no Supabase.
- **Importante:** preços de Starter R$ 7,90/10, Pro R$ 14,90/25 e Premium R$ 24,90/50 **ainda precisam de integração completa** ao checkout, catálogo do banco e webhook. A versão existente só suporta `basic` e `pro`. Não altere valores só no frontend.
- Não publique sem testar sessão expirada, cadastro, webhook e renovação.
