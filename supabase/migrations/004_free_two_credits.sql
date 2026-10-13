-- Execute uma única vez no SQL Editor do Supabase.
-- Apenas novos cadastros recebem 2 créditos; não modifica o saldo dos clientes atuais.
alter table public.credit_accounts alter column balance set default 2;
