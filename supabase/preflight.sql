-- Solo lectura. Ejecutar antes de la migración para inspeccionar el bucket
-- reservado y detectar políticas preexistentes que puedan ampliar el acceso.

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'suite-flyer-images';

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'suite_flyer_templates', 'suite_flyer_images', 'suite_flyer_promotions',
    'suite_flyer_whatsapp_texts', 'suite_flyer_settings',
    'suite_profitability_months', 'suite_agenda_events'
  )
order by table_name, grantee, privilege_type;
