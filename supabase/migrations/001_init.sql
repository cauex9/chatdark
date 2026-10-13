-- Execute no SQL Editor do Supabase. Use um projeto novo ou revise antes de aplicar.
create extension if not exists pgcrypto;
create table if not exists public.profiles(id uuid primary key references auth.users(id) on delete cascade,display_name text,avatar_url text,created_at timestamptz default now());
create table if not exists public.projects(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,name text not null,description text default '',status text not null default 'draft',created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table if not exists public.project_files(id uuid primary key default gen_random_uuid(),project_id uuid not null references public.projects(id) on delete cascade,path text not null,content text not null,updated_at timestamptz not null default now(),unique(project_id,path));
create table if not exists public.project_versions(id uuid primary key default gen_random_uuid(),project_id uuid not null references public.projects(id) on delete cascade,version_number int not null,snapshot jsonb not null,created_at timestamptz not null default now(),unique(project_id,version_number));
create table if not exists public.generations(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,project_id uuid references public.projects(id) on delete cascade,status text not null,model text,credits_used int not null default 0,request_id uuid unique,created_at timestamptz not null default now());
create table if not exists public.credit_accounts(user_id uuid primary key references auth.users(id) on delete cascade,balance int not null default 3 check(balance>=0),updated_at timestamptz not null default now());
create table if not exists public.credit_transactions(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,request_id uuid not null,amount int not null,transaction_type text not null,description text,created_at timestamptz not null default now(),unique(request_id,transaction_type));
create index if not exists idx_projects_owner on public.projects(user_id,updated_at desc);
create index if not exists idx_files_project on public.project_files(project_id);
create index if not exists idx_versions_project on public.project_versions(project_id,version_number desc);
create index if not exists idx_generations_user on public.generations(user_id,created_at desc);
create or replace function public.new_user_webforge() returns trigger language plpgsql security definer set search_path=public as $$begin insert into public.profiles(id) values(new.id) on conflict do nothing;insert into public.credit_accounts(user_id) values(new.id) on conflict do nothing;return new;end$$;
drop trigger if exists webforge_auth_user on auth.users;
create trigger webforge_auth_user after insert on auth.users for each row execute function public.new_user_webforge();
insert into public.profiles(id) select id from auth.users on conflict do nothing;
insert into public.credit_accounts(user_id) select id from auth.users on conflict do nothing;
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_files enable row level security;
alter table public.project_versions enable row level security;
alter table public.generations enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_transactions enable row level security;
create policy "own profile read" on public.profiles for select to authenticated using(id=auth.uid());
create policy "own projects read" on public.projects for select to authenticated using(user_id=auth.uid());
create policy "own files read" on public.project_files for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid()));
create policy "own versions read" on public.project_versions for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid()));
create policy "own generations read" on public.generations for select to authenticated using(user_id=auth.uid());
create policy "own credits read" on public.credit_accounts for select to authenticated using(user_id=auth.uid());
create policy "own transactions read" on public.credit_transactions for select to authenticated using(user_id=auth.uid());
-- Only backend secret/service-role can call these credit operations.
create or replace function public.reserve_generation_credit(p_user_id uuid,p_request_id uuid) returns boolean language plpgsql security definer set search_path=public as $$begin
if exists(select 1 from public.credit_transactions where request_id=p_request_id and transaction_type='generation') then return true;end if;
update public.credit_accounts set balance=balance-1,updated_at=now() where user_id=p_user_id and balance>0;
if not found then return false;end if;
insert into public.credit_transactions(user_id,request_id,amount,transaction_type,description) values(p_user_id,p_request_id,-1,'generation','Reserva de geração');return true;end$$;
create or replace function public.refund_generation_credit(p_user_id uuid,p_request_id uuid) returns void language plpgsql security definer set search_path=public as $$begin
if exists(select 1 from public.credit_transactions where request_id=p_request_id and transaction_type='generation') then
insert into public.credit_transactions(user_id,request_id,amount,transaction_type,description) values(p_user_id,p_request_id,1,'refund','Devolução por falha') on conflict do nothing;
if found then update public.credit_accounts set balance=balance+1,updated_at=now() where user_id=p_user_id;end if;
end if;end$$;
revoke all on function public.reserve_generation_credit(uuid,uuid) from public,anon,authenticated;
revoke all on function public.refund_generation_credit(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_generation_credit(uuid,uuid) to service_role;
grant execute on function public.refund_generation_credit(uuid,uuid) to service_role;
