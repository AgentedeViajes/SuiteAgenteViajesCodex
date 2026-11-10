-- Solo lectura: comprobar colisiones antes de aplicar la migración 202611100001.
SELECT table_schema, table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND ((table_name = 'tresor_trips' AND column_name = 'deletion_pending') OR (table_name = 'tresor_passengers' AND column_name = 'deletion_pending') OR (table_name = 'tresor_deliveries' AND column_name = 'primary_passenger_id'))
ORDER BY table_name, column_name;

SELECT n.nspname AS function_schema, p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'public' AND p.proname IN ('tresor_begin_trip_deletion','tresor_begin_passenger_deletion','tresor_finish_trip_deletion','tresor_finish_passenger_deletion'))
   OR (n.nspname = 'tresor_private' AND p.proname IN ('is_document_deletion_pending','guard_tresor_deletion_pending'))
ORDER BY n.nspname, p.proname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname IN ('tresor_docs_pending_insert_guard','tresor_docs_pending_update_guard','tresor_docs_pending_delete_guard')
ORDER BY policyname;

-- Solo lectura: revisar índices únicos sobre relaciones de pasajeros, incluidos los parciales.
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('tresor_trip_passengers','tresor_deliveries')
  AND indexdef ILIKE '%UNIQUE%'
ORDER BY tablename, indexname;

SELECT c.relname AS table_name, t.tgname AS trigger_name
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND t.tgname IN ('tresor_trips_delete_pending_guard','tresor_passengers_delete_pending_guard','tresor_trip_passengers_delete_pending_guard','tresor_documents_delete_pending_guard','tresor_deliveries_delete_pending_guard','tresor_air_reservations_delete_pending_guard','tresor_air_flights_delete_pending_guard','tresor_air_reservation_passengers_delete_pending_guard','tresor_followups_delete_pending_guard','tresor_notification_attempts_delete_pending_guard')
ORDER BY c.relname, t.tgname;
