-- Preflight de solo lectura para planificar eliminaciones de pasajeros y viajes.
-- No devuelve filas de negocio ni modifica el esquema o los datos.

-- 1. Claves foráneas que tocan tablas Tresor: columnas, destino y acciones referenciales.
SELECT
  src_ns.nspname AS source_schema,
  src.relname AS source_table,
  con.conname AS constraint_name,
  ARRAY(
    SELECT src_att.attname
    FROM unnest(con.conkey) WITH ORDINALITY AS key_col(attnum, ord)
    JOIN pg_attribute AS src_att ON src_att.attrelid = con.conrelid AND src_att.attnum = key_col.attnum
    ORDER BY key_col.ord
  ) AS source_columns,
  dst_ns.nspname AS referenced_schema,
  dst.relname AS referenced_table,
  ARRAY(
    SELECT dst_att.attname
    FROM unnest(con.confkey) WITH ORDINALITY AS key_col(attnum, ord)
    JOIN pg_attribute AS dst_att ON dst_att.attrelid = con.confrelid AND dst_att.attnum = key_col.attnum
    ORDER BY key_col.ord
  ) AS referenced_columns,
  con.confdeltype AS delete_action_code,
  con.confupdtype AS update_action_code,
  con.convalidated AS is_validated,
  con.condeferrable AS is_deferrable,
  con.condeferred AS initially_deferred,
  pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint AS con
JOIN pg_class AS src ON src.oid = con.conrelid
JOIN pg_namespace AS src_ns ON src_ns.oid = src.relnamespace
JOIN pg_class AS dst ON dst.oid = con.confrelid
JOIN pg_namespace AS dst_ns ON dst_ns.oid = dst.relnamespace
WHERE con.contype = 'f'
  AND ((src_ns.nspname = 'public' AND left(src.relname, 7) = 'tresor_')
    OR (dst_ns.nspname = 'public' AND left(dst.relname, 7) = 'tresor_'))
ORDER BY source_schema, source_table, constraint_name;

-- 2. Claves y restricciones CHECK de las tablas Tresor para conocer invariantes de borrado.
SELECT
  ns.nspname AS table_schema,
  cls.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  con.convalidated AS is_validated,
  pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint AS con
JOIN pg_class AS cls ON cls.oid = con.conrelid
JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
WHERE ns.nspname = 'public'
  AND left(cls.relname, 7) = 'tresor_'
  AND con.contype IN ('p', 'u', 'c', 'x')
ORDER BY cls.relname, con.contype, con.conname;

-- 3. Estado RLS de todas las tablas Tresor.
SELECT
  ns.nspname AS table_schema,
  cls.relname AS table_name,
  cls.relrowsecurity AS row_security_enabled,
  cls.relforcerowsecurity AS row_security_forced
FROM pg_class AS cls
JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
WHERE ns.nspname = 'public'
  AND cls.relkind IN ('r', 'p')
  AND left(cls.relname, 7) = 'tresor_'
ORDER BY cls.relname;

-- 4. Políticas RLS de las tablas Tresor, con expresiones y roles efectivos.
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual AS using_expression,
  with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND left(tablename, 7) = 'tresor_'
ORDER BY tablename, policyname;

-- 5. Todas las políticas de storage.objects, incluidas las ajenas al bucket Tresor.
-- Se incluyen todas porque una política permisiva amplia también puede conceder acceso.
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual AS using_expression,
  with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
ORDER BY policyname;

-- 6. Configuración del bucket privado de documentos de pasajeros.
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'tresor-passenger-documents';

-- 7. Definiciones actuales de las funciones usadas para autorizar acceso a documentos.
SELECT
  ns.nspname AS function_schema,
  proc.proname AS function_name,
  pg_get_function_identity_arguments(proc.oid) AS arguments,
  proc.prosecdef AS security_definer,
  proc.provolatile AS volatility,
  pg_get_userbyid(proc.proowner) AS owner_name,
  proc.proconfig AS function_settings,
  pg_get_functiondef(proc.oid) AS definition
FROM pg_proc AS proc
JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
WHERE ns.nspname = 'tresor_private'
  AND proc.proname IN ('can_manage_document_object', 'is_workspace_admin')
ORDER BY proc.proname, arguments;

-- 8. Triggers no internos de tablas Tresor que podrían ejecutar efectos adicionales al borrar.
SELECT
  ns.nspname AS table_schema,
  cls.relname AS table_name,
  trg.tgname AS trigger_name,
  trg.tgenabled AS enabled_state,
  pg_get_triggerdef(trg.oid, true) AS definition
FROM pg_trigger AS trg
JOIN pg_class AS cls ON cls.oid = trg.tgrelid
JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace
WHERE NOT trg.tgisinternal
  AND ns.nspname = 'public'
  AND left(cls.relname, 7) = 'tresor_'
ORDER BY cls.relname, trg.tgname;
