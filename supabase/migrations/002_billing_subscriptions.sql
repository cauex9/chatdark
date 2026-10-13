-- Registro de cobrancas, nao concede beneficios automaticamente.
create table if not exists public.billing_subscriptions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 plan text not null check (plan in ('pro','business')),
 identifier text not null unique,
 transaction_id text unique,
 subscription_id text unique,
 amount numeric(10,2) not null check (amount > 0),
 status text not null default 'PENDING',
 created_at timestamptz not null default now()
);
alter table public.billing_subscriptions enable row level security;
-- Sem politicas para clientes: acesso somente via backend com service role.
create index if not exists billing_subscriptions_user_id_idx on public.billing_subscriptions(user_id);
