begin;

create table if not exists public.webforge_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  idempotency_key text not null,
  gateway_identifier text not null unique,
  gateway_transaction_id text unique,
  gateway_subscription_id text,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'creating'
    check (status in ('creating','pending','paid','failed','expired','canceled')),
  pix_code text,
  pix_image text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

alter table public.webforge_payment_attempts
  add column if not exists webhook_token_hash text;

create index if not exists webforge_payment_attempts_user_created_idx
  on public.webforge_payment_attempts (user_id, created_at desc);

create table if not exists public.webforge_payment_cycles (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  gateway_transaction_id text not null unique,
  cycle_number integer check (cycle_number is null or cycle_number > 0),
  amount numeric(12,2) not null check (amount > 0),
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists webforge_payment_cycles_subscription_cycle_idx
  on public.webforge_payment_cycles (subscription_id, cycle_number)
  where cycle_number is not null;

alter table public.webforge_payment_attempts enable row level security;
alter table public.webforge_payment_cycles enable row level security;

create or replace function public.apply_webforge_subscription_payment(
  p_subscription_id uuid,
  p_gateway_transaction_id text,
  p_cycle_number integer,
  p_amount numeric,
  p_confirmed_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_status text;
  v_price numeric;
  v_credits integer;
  v_duration_days integer;
  v_cycle_number integer;
  v_cycle_id uuid;
  v_was_canceled boolean;
  v_new_expires_at timestamptz;
begin
  if p_gateway_transaction_id is null or btrim(p_gateway_transaction_id) = ''
     or p_amount is null or p_amount <= 0
     or (p_cycle_number is not null and p_cycle_number <= 0) then
    raise exception 'Invalid confirmed payment data';
  end if;

  select s.user_id, s.status, p.price, p.monthly_credits, p.duration_days
    into v_user_id, v_status, v_price, v_credits, v_duration_days
  from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.id = p_subscription_id
  for update of s;

  if not found then raise exception 'Subscription or plan not found'; end if;
  if round(p_amount, 2) <> round(v_price, 2) then raise exception 'Payment amount does not match plan'; end if;
  if v_credits is null or v_credits <= 0 or v_duration_days is null or v_duration_days <= 0 then
    raise exception 'Invalid plan credit or duration configuration';
  end if;

  v_cycle_number := coalesce(p_cycle_number, (
    select coalesce(max(c.cycle_number), 0) + 1
    from public.webforge_payment_cycles c
    where c.subscription_id = p_subscription_id
  ));

  insert into public.webforge_payment_cycles
    (subscription_id, gateway_transaction_id, cycle_number, amount, confirmed_at)
  values
    (p_subscription_id, p_gateway_transaction_id, v_cycle_number, p_amount,
     coalesce(p_confirmed_at, now()))
  on conflict do nothing
  returning id into v_cycle_id;

  if v_cycle_id is null then return false; end if;

  update public.credit_accounts
    set balance = balance + v_credits, updated_at = now()
    where user_id = v_user_id;
  if not found then raise exception 'Credit account not found'; end if;

  insert into public.credit_transactions
    (user_id, request_id, amount, transaction_type, description)
  values
    (v_user_id, v_cycle_id, v_credits, 'subscription',
     'Créditos de assinatura - transação ' || p_gateway_transaction_id);

  v_was_canceled := lower(v_status) in ('canceled', 'cancelled');
  v_new_expires_at := greatest(coalesce(expires_at, coalesce(p_confirmed_at, now())),
                               coalesce(p_confirmed_at, now()))
                      + make_interval(days => v_duration_days);
  update public.subscriptions
    set status = case when v_was_canceled then v_status else 'active' end,
        starts_at = case when lower(v_status) = 'pending'
                         then coalesce(p_confirmed_at, now()) else starts_at end,
        expires_at = v_new_expires_at,
        last_payment_at = coalesce(p_confirmed_at, now()),
        next_charge_at = case when v_was_canceled then null
                              else v_new_expires_at end,
        updated_at = now()
    where id = p_subscription_id;

  return true;
end;
$$;

revoke all on function public.apply_webforge_subscription_payment(uuid, text, integer, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_webforge_subscription_payment(uuid, text, integer, numeric, timestamptz)
  to service_role;

commit;
