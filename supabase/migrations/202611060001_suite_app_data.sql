-- Suite del Agente: datos privados para Flyers, Rentabilidad y Agenda.
-- Aplicar una vez al proyecto Supabase destino. El script es repetible y no elimina datos.
-- Se ejecuta en una transacción para evitar dejar un esquema aplicado a medias.

begin;

-- Abort before schema changes if this reserved bucket already exists as public.
do $$
begin
  if exists (select 1 from storage.buckets where id = 'suite-flyer-images' and public) then
    raise exception 'El bucket suite-flyer-images ya existe como público. No se modificó nada; revisá el bucket y las políticas antes de continuar.';
  end if;
end $$;

-- Policies are OR-combined by Postgres. Stop if another policy appeared after
-- preflight, since it could broaden access to these private records or objects.
do $$
declare unexpected_policy text;
begin
  select format('%I.%I: %I', schemaname, tablename, policyname) into unexpected_policy
  from pg_policies
  where (schemaname = 'public' and tablename in (
           'suite_flyer_templates', 'suite_flyer_images', 'suite_flyer_promotions',
           'suite_flyer_whatsapp_texts', 'suite_flyer_settings',
           'suite_profitability_months', 'suite_agenda_events'
         ) and policyname not in (
           'Read shared or own flyer templates', 'Manage own flyer templates',
           'Users manage own flyer images', 'Users manage own flyer promotions',
           'Users manage own flyer texts', 'Users manage own flyer settings',
           'Users manage own profitability', 'Users manage own agenda events'
         ))
     or (schemaname = 'storage' and tablename = 'objects' and policyname not in (
           'Suite Agent - Read own flyer files', 'Suite Agent - Upload own flyer files',
           'Suite Agent - Update own flyer files', 'Suite Agent - Delete own flyer files'
         ))
  limit 1;
  if unexpected_policy is not null then
    raise exception 'Se detectó una política no revisada (%). No se aplicó la migración; revisá las políticas RLS y volvé a ejecutar el preflight.', unexpected_policy;
  end if;
end $$;

create table if not exists public.suite_flyer_templates (
  id text primary key,
  owner_id uuid references auth.users(id),
  category text not null,
  destination text not null,
  style text not null default 'Clásica + Oferta',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.suite_flyer_images (
  id text not null,
  owner_id uuid not null references auth.users(id),
  storage_path text not null,
  name text not null,
  category text not null default 'Otros destinos',
  destination text not null default '',
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (owner_id, id),
  unique (storage_path)
);

create table if not exists public.suite_flyer_promotions (
  id text not null,
  owner_id uuid not null references auth.users(id),
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.suite_flyer_whatsapp_texts (
  id text not null,
  owner_id uuid not null references auth.users(id),
  destination text not null default '',
  body text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create table if not exists public.suite_flyer_settings (
  owner_id uuid primary key references auth.users(id),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Conserva los importes y campos exactamente como los usa la aplicación actual.
create table if not exists public.suite_profitability_months (
  owner_id uuid not null references auth.users(id),
  year integer not null check (year between 2020 and 2100),
  month integer not null check (month between 0 and 11),
  rows jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner_id, year, month)
);

-- Los campos actuales de Agenda son id, date, type y detail; el JSONB preserva
-- cualquier campo adicional que aparezca en datos locales anteriores o futuros.
create table if not exists public.suite_agenda_events (
  id text not null,
  owner_id uuid not null references auth.users(id),
  event_date date not null,
  event_type text not null,
  detail text not null default '',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create index if not exists suite_flyer_images_owner_destination_idx
  on public.suite_flyer_images (owner_id, destination);
create index if not exists suite_flyer_promotions_owner_updated_idx
  on public.suite_flyer_promotions (owner_id, updated_at desc);
create index if not exists suite_flyer_texts_owner_created_idx
  on public.suite_flyer_whatsapp_texts (owner_id, created_at desc);
create index if not exists suite_agenda_events_owner_date_idx
  on public.suite_agenda_events (owner_id, event_date);

alter table public.suite_flyer_templates enable row level security;
alter table public.suite_flyer_images enable row level security;
alter table public.suite_flyer_promotions enable row level security;
alter table public.suite_flyer_whatsapp_texts enable row level security;
alter table public.suite_flyer_settings enable row level security;
alter table public.suite_profitability_months enable row level security;
alter table public.suite_agenda_events enable row level security;

revoke all on public.suite_flyer_templates, public.suite_flyer_images,
  public.suite_flyer_promotions, public.suite_flyer_whatsapp_texts,
  public.suite_flyer_settings, public.suite_profitability_months,
  public.suite_agenda_events from anon, public, authenticated;

drop policy if exists "Read shared or own flyer templates" on public.suite_flyer_templates;
create policy "Read shared or own flyer templates"
  on public.suite_flyer_templates for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));
drop policy if exists "Manage own flyer templates" on public.suite_flyer_templates;
create policy "Manage own flyer templates"
  on public.suite_flyer_templates for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists "Users manage own flyer images" on public.suite_flyer_images;
create policy "Users manage own flyer images"
  on public.suite_flyer_images for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists "Users manage own flyer promotions" on public.suite_flyer_promotions;
create policy "Users manage own flyer promotions"
  on public.suite_flyer_promotions for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists "Users manage own flyer texts" on public.suite_flyer_whatsapp_texts;
create policy "Users manage own flyer texts"
  on public.suite_flyer_whatsapp_texts for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists "Users manage own flyer settings" on public.suite_flyer_settings;
create policy "Users manage own flyer settings"
  on public.suite_flyer_settings for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists "Users manage own profitability" on public.suite_profitability_months;
create policy "Users manage own profitability"
  on public.suite_profitability_months for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
drop policy if exists "Users manage own agenda events" on public.suite_agenda_events;
create policy "Users manage own agenda events"
  on public.suite_agenda_events for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

grant select, insert, update, delete on public.suite_flyer_templates to authenticated;
grant select, insert, update, delete on public.suite_flyer_images to authenticated;
grant select, insert, update, delete on public.suite_flyer_promotions to authenticated;
grant select, insert, update, delete on public.suite_flyer_whatsapp_texts to authenticated;
grant select, insert, update, delete on public.suite_flyer_settings to authenticated;
grant select, insert, update, delete on public.suite_profitability_months to authenticated;
grant select, insert, update, delete on public.suite_agenda_events to authenticated;

-- Las plantillas se comparten como catálogo; las fotografías y los datos de
-- promociones permanecen privados y se guardan en el bucket privado de abajo.
insert into public.suite_flyer_templates (id, owner_id, category, destination, style)
values
  ('Caribe:Punta Cana', null, 'Caribe', 'Punta Cana', 'Clásica + Oferta'),
  ('Caribe:Bayahibe', null, 'Caribe', 'Bayahibe', 'Clásica + Oferta'),
  ('Caribe:Samaná', null, 'Caribe', 'Samaná', 'Clásica + Oferta'),
  ('Caribe:Aruba', null, 'Caribe', 'Aruba', 'Clásica + Oferta'),
  ('Caribe:Curaçao', null, 'Caribe', 'Curaçao', 'Clásica + Oferta'),
  ('Caribe:Riviera Maya', null, 'Caribe', 'Riviera Maya', 'Clásica + Oferta'),
  ('Caribe:Cancún', null, 'Caribe', 'Cancún', 'Clásica + Oferta'),
  ('Caribe:Costa Mujeres', null, 'Caribe', 'Costa Mujeres', 'Clásica + Oferta'),
  ('Caribe:San Andrés', null, 'Caribe', 'San Andrés', 'Clásica + Oferta'),
  ('Estados Unidos:Miami', null, 'Estados Unidos', 'Miami', 'Clásica + Oferta'),
  ('Estados Unidos:Nueva York', null, 'Estados Unidos', 'Nueva York', 'Clásica + Oferta'),
  ('Estados Unidos:Orlando / Disney', null, 'Estados Unidos', 'Orlando / Disney', 'Clásica + Oferta'),
  ('Asia y exóticos:China', null, 'Asia y exóticos', 'China', 'Clásica + Oferta'),
  ('Asia y exóticos:Japón', null, 'Asia y exóticos', 'Japón', 'Clásica + Oferta'),
  ('Asia y exóticos:Sudeste Asiático', null, 'Asia y exóticos', 'Sudeste Asiático', 'Clásica + Oferta'),
  ('Asia y exóticos:Tailandia', null, 'Asia y exóticos', 'Tailandia', 'Clásica + Oferta'),
  ('África:Kenia', null, 'África', 'Kenia', 'Clásica + Oferta'),
  ('África:Sudáfrica', null, 'África', 'Sudáfrica', 'Clásica + Oferta'),
  ('Europa:París', null, 'Europa', 'París', 'Clásica + Oferta'),
  ('Europa:Londres', null, 'Europa', 'Londres', 'Clásica + Oferta'),
  ('Europa:Madrid', null, 'Europa', 'Madrid', 'Clásica + Oferta'),
  ('Europa:Italia', null, 'Europa', 'Italia', 'Clásica + Oferta'),
  ('Europa:Roma', null, 'Europa', 'Roma', 'Clásica + Oferta'),
  ('Europa:Islas Griegas', null, 'Europa', 'Islas Griegas', 'Clásica + Oferta'),
  ('Europa:Europa multidestino', null, 'Europa', 'Europa multidestino', 'Clásica + Oferta'),
  ('Otros destinos:Turquía', null, 'Otros destinos', 'Turquía', 'Clásica + Oferta'),
  ('Otros destinos:Capadocia', null, 'Otros destinos', 'Capadocia', 'Clásica + Oferta'),
  ('Otros destinos:Estambul', null, 'Otros destinos', 'Estambul', 'Clásica + Oferta'),
  ('Otros destinos:Dubái', null, 'Otros destinos', 'Dubái', 'Clásica + Oferta'),
  ('Otros destinos:Marruecos', null, 'Otros destinos', 'Marruecos', 'Clásica + Oferta'),
  ('Otros destinos:Egipto / El Cairo', null, 'Otros destinos', 'Egipto / El Cairo', 'Clásica + Oferta')
on conflict (id) do nothing;

-- Bucket privado: el primer directorio de cada objeto debe ser el UID del usuario.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('suite-flyer-images', 'suite-flyer-images', false, 15728640,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

do $$
declare bucket_is_public boolean;
begin
  select public into bucket_is_public
  from storage.buckets where id = 'suite-flyer-images';
  if bucket_is_public is distinct from false then
    raise exception 'El bucket suite-flyer-images ya existe y debe configurarse como privado antes de continuar.';
  end if;
end $$;

drop policy if exists "Suite Agent - Read own flyer files" on storage.objects;
create policy "Suite Agent - Read own flyer files"
  on storage.objects for select to authenticated
  using (bucket_id = 'suite-flyer-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Suite Agent - Upload own flyer files" on storage.objects;
create policy "Suite Agent - Upload own flyer files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'suite-flyer-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Suite Agent - Update own flyer files" on storage.objects;
create policy "Suite Agent - Update own flyer files"
  on storage.objects for update to authenticated
  using (bucket_id = 'suite-flyer-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'suite-flyer-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Suite Agent - Delete own flyer files" on storage.objects;
create policy "Suite Agent - Delete own flyer files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'suite-flyer-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

commit;
