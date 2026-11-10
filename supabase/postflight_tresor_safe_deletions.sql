-- Solo lectura: verificar la migración 202611100001.
SELECT table_name, column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND ((table_name = 'tresor_trips' AND column_name = 'deletion_pending') OR (table_name = 'tresor_passengers' AND column_name = 'deletion_pending') OR (table_name = 'tresor_deliveries' AND column_name = 'primary_passenger_id'))
ORDER BY table_name, column_name;

SELECT n.nspname AS function_schema, p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS arguments, p.prosecdef AS security_definer, p.proconfig AS function_settings, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'public' AND p.proname IN ('tresor_begin_trip_deletion','tresor_begin_passenger_deletion','tresor_finish_trip_deletion','tresor_finish_passenger_deletion'))
   OR (n.nspname = 'tresor_private' AND p.proname IN ('is_document_deletion_pending','guard_tresor_deletion_pending'))
ORDER BY n.nspname, p.proname, arguments;

SELECT n.nspname AS function_schema, p.proname AS function_name,
  has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'tresor_private' AND p.proname IN ('is_document_deletion_pending','guard_tresor_deletion_pending'))
   OR (n.nspname = 'public' AND p.proname IN ('tresor_begin_trip_deletion','tresor_begin_passenger_deletion','tresor_finish_trip_deletion','tresor_finish_passenger_deletion'))
ORDER BY n.nspname, p.proname;

SELECT policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname IN ('tresor_docs_pending_insert_guard','tresor_docs_pending_update_guard','tresor_docs_pending_delete_guard')
ORDER BY policyname;

SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND t.tgname IN ('tresor_trips_delete_pending_guard','tresor_passengers_delete_pending_guard','tresor_trip_passengers_delete_pending_guard','tresor_documents_delete_pending_guard','tresor_deliveries_delete_pending_guard','tresor_air_reservations_delete_pending_guard','tresor_air_flights_delete_pending_guard','tresor_air_reservation_passengers_delete_pending_guard','tresor_followups_delete_pending_guard','tresor_notification_attempts_delete_pending_guard')
ORDER BY c.relname, t.tgname;

SELECT relname AS table_name, relrowsecurity AS row_security_enabled
FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('tresor_trips','tresor_passengers','tresor_deliveries','tresor_documents','tresor_trip_passengers','tresor_air_reservations','tresor_air_flights','tresor_air_reservation_passengers','tresor_followups','tresor_notification_attempts')
ORDER BY relname;
