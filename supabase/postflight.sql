-- Solo lectura. Ejecutar después de la migración para confirmar esquema y bucket.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'suite_flyer_templates', 'suite_flyer_images', 'suite_flyer_promotions',
    'suite_flyer_whatsapp_texts', 'suite_flyer_settings',
    'suite_profitability_months', 'suite_agenda_events'
  )
order by c.relname;

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'suite-flyer-images';

select count(*) as shared_destination_templates
from public.suite_flyer_templates where owner_id is null;

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where (schemaname = 'public' and tablename in (
         'suite_flyer_templates', 'suite_flyer_images', 'suite_flyer_promotions',
         'suite_flyer_whatsapp_texts', 'suite_flyer_settings',
         'suite_profitability_months', 'suite_agenda_events'
       ))
   or (schemaname = 'storage' and tablename = 'objects' and policyname like 'Suite Agent - %')
order by schemaname, tablename, policyname;

-- Debe devolver cero filas para anon y PUBLIC: solo authenticated recibe
-- permisos de tabla en las siete tablas privadas de la Suite.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'suite_flyer_templates', 'suite_flyer_images', 'suite_flyer_promotions',
    'suite_flyer_whatsapp_texts', 'suite_flyer_settings',
    'suite_profitability_months', 'suite_agenda_events'
  )
  and grantee in ('anon', 'PUBLIC')
order by table_name, grantee, privilege_type;
