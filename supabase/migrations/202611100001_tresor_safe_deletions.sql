BEGIN;

-- Aborta si el estado no coincide con el esquema inspeccionado.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('tresor_trips','tresor_passengers') AND column_name = 'deletion_pending'
  ) THEN RAISE EXCEPTION 'Columna deletion_pending ya existe; detener y revisar el esquema.'; END IF;
  IF to_regprocedure('tresor_private.is_document_deletion_pending(text)') IS NOT NULL
    OR to_regprocedure('tresor_private.guard_tresor_deletion_pending()') IS NOT NULL
    OR to_regprocedure('public.tresor_begin_trip_deletion(uuid,uuid,uuid)') IS NOT NULL
    OR to_regprocedure('public.tresor_begin_passenger_deletion(uuid,uuid,uuid,jsonb)') IS NOT NULL
    OR to_regprocedure('public.tresor_finish_trip_deletion(uuid,uuid,uuid)') IS NOT NULL
    OR to_regprocedure('public.tresor_finish_passenger_deletion(uuid,uuid,uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'Una función de eliminación Tresor ya existe; detener y revisar.'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN ('tresor_docs_pending_insert_guard','tresor_docs_pending_update_guard','tresor_docs_pending_delete_guard')
  ) THEN RAISE EXCEPTION 'Una política de protección de borrado Tresor ya existe; detener y revisar.'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN ('tresor_trips_delete_pending_guard','tresor_passengers_delete_pending_guard','tresor_trip_passengers_delete_pending_guard',
        'tresor_documents_delete_pending_guard','tresor_deliveries_delete_pending_guard','tresor_air_reservations_delete_pending_guard',
        'tresor_air_flights_delete_pending_guard','tresor_air_reservation_passengers_delete_pending_guard',
        'tresor_followups_delete_pending_guard','tresor_notification_attempts_delete_pending_guard')
  ) THEN RAISE EXCEPTION 'Un trigger de protección Tresor ya existe; detener y revisar.'; END IF;
END;
$preflight$;

ALTER TABLE public.tresor_trips
  ADD COLUMN deletion_pending boolean NOT NULL DEFAULT false;
ALTER TABLE public.tresor_passengers
  ADD COLUMN deletion_pending boolean NOT NULL DEFAULT false;

-- Un viaje puede conservar su documentación compartida aunque se borre su último pasajero.
ALTER TABLE public.tresor_deliveries
  ALTER COLUMN primary_passenger_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION tresor_private.is_document_deletion_pending(object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  workspace_uuid uuid;
  trip_uuid uuid;
BEGIN
  IF object_name IS NULL OR object_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$' THEN
    RETURN false;
  END IF;
  workspace_uuid := split_part(object_name, '/', 1)::uuid;
  trip_uuid := split_part(object_name, '/', 2)::uuid;
  RETURN EXISTS (
    SELECT 1 FROM public.tresor_trips t
    WHERE t.workspace_id = workspace_uuid AND t.id = trip_uuid AND t.deletion_pending
  ) OR EXISTS (
    SELECT 1
    FROM public.tresor_trip_passengers tp
    JOIN public.tresor_passengers p ON p.workspace_id = tp.workspace_id AND p.id = tp.passenger_id
    WHERE tp.workspace_id = workspace_uuid AND tp.trip_id = trip_uuid AND p.deletion_pending
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION tresor_private.is_document_deletion_pending(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION tresor_private.is_document_deletion_pending(text) FROM PUBLIC, anon;

-- Políticas RESTRICTIVE adicionales: no alteran las políticas existentes y bloquean escrituras
-- sobre los objetos del bucket durante una eliminación pendiente.
CREATE POLICY tresor_docs_pending_insert_guard
  ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (bucket_id <> 'tresor-passenger-documents' OR NOT tresor_private.is_document_deletion_pending(name));
CREATE POLICY tresor_docs_pending_update_guard
  ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (bucket_id <> 'tresor-passenger-documents' OR NOT tresor_private.is_document_deletion_pending(name))
  WITH CHECK (bucket_id <> 'tresor-passenger-documents' OR NOT tresor_private.is_document_deletion_pending(name));
CREATE POLICY tresor_docs_pending_delete_guard
  ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (bucket_id <> 'tresor-passenger-documents' OR NOT tresor_private.is_document_deletion_pending(name));

CREATE OR REPLACE FUNCTION tresor_private.guard_tresor_deletion_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  row_data jsonb;
  workspace_uuid uuid;
  trip_uuid uuid;
  passenger_uuid uuid;
  followup_uuid uuid;
BEGIN
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  workspace_uuid := NULLIF(row_data->>'workspace_id', '')::uuid;
  trip_uuid := NULLIF(row_data->>'trip_id', '')::uuid;
  passenger_uuid := NULLIF(row_data->>'passenger_id', '')::uuid;
  IF TG_TABLE_NAME = 'tresor_deliveries' THEN
    passenger_uuid := NULLIF(row_data->>'primary_passenger_id', '')::uuid;
  END IF;

  IF TG_TABLE_NAME = 'tresor_trips' THEN
    trip_uuid := NULLIF(row_data->>'id', '')::uuid;
    IF COALESCE((row_data->>'deletion_pending')::boolean, false) THEN
      RAISE EXCEPTION 'Use el flujo administrativo de eliminación.' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'tresor_passengers' THEN
    passenger_uuid := NULLIF(row_data->>'id', '')::uuid;
    IF COALESCE((row_data->>'deletion_pending')::boolean, false) THEN
      RAISE EXCEPTION 'Use el flujo administrativo de eliminación.' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'tresor_notification_attempts' THEN
    followup_uuid := NULLIF(row_data->>'followup_id', '')::uuid;
    SELECT f.trip_id INTO trip_uuid
    FROM public.tresor_followups f
    WHERE f.workspace_id = workspace_uuid AND f.id = followup_uuid;
  END IF;

  IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('tresor_trips','tresor_passengers') THEN
    RAISE EXCEPTION 'Use el flujo administrativo de eliminación.' USING ERRCODE = '55000';
  END IF;
  IF trip_uuid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tresor_trips t
    WHERE t.workspace_id = workspace_uuid AND t.id = trip_uuid AND t.deletion_pending
  ) THEN
    RAISE EXCEPTION 'El viaje tiene una eliminación pendiente; reintentá esa operación.' USING ERRCODE = '55000';
  END IF;
  IF passenger_uuid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tresor_passengers p
    WHERE p.workspace_id = workspace_uuid AND p.id = passenger_uuid AND p.deletion_pending
  ) THEN
    RAISE EXCEPTION 'El pasajero tiene una eliminación pendiente; reintentá esa operación.' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

CREATE TRIGGER tresor_trips_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_trips FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_passengers_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_passengers FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_trip_passengers_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_trip_passengers FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_documents_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_documents FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_deliveries_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_deliveries FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_air_reservations_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_air_reservations FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_air_flights_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_air_flights FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_air_reservation_passengers_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_air_reservation_passengers FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_followups_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_followups FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();
CREATE TRIGGER tresor_notification_attempts_delete_pending_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tresor_notification_attempts FOR EACH ROW EXECUTE FUNCTION tresor_private.guard_tresor_deletion_pending();

-- A trigger invokes its function without requiring callers to have EXECUTE.
-- Remove the default PUBLIC grant so it cannot be called as a public RPC.
REVOKE ALL ON FUNCTION tresor_private.guard_tresor_deletion_pending() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tresor_begin_trip_deletion(p_workspace_id uuid, p_trip_id uuid, p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  changed integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tresor_workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.is_active AND m.role = 'admin'
  ) THEN RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':trip:' || p_trip_id::text, 0));
  UPDATE public.tresor_trips SET deletion_pending = true, updated_at = now()
  WHERE workspace_id = p_workspace_id AND id = p_trip_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 0 THEN RETURN false; END IF;
  UPDATE public.tresor_deliveries
  SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
  WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tresor_begin_passenger_deletion(
  p_workspace_id uuid, p_passenger_id uuid, p_actor_id uuid, p_rotations jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  trip_row record;
  trip_ids uuid[];
  expected_deliveries integer;
  rotation_count integer;
  distinct_rotations integer;
  changed integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tresor_workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.is_active AND m.role = 'admin'
  ) THEN RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':passenger:' || p_passenger_id::text, 0));
  PERFORM 1 FROM public.tresor_passengers p WHERE p.workspace_id = p_workspace_id AND p.id = p_passenger_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT COALESCE(array_agg(DISTINCT tp.trip_id ORDER BY tp.trip_id), ARRAY[]::uuid[])
  INTO trip_ids
  FROM public.tresor_trip_passengers tp
  WHERE tp.workspace_id = p_workspace_id AND tp.passenger_id = p_passenger_id;
  FOR trip_row IN SELECT unnest(trip_ids) AS trip_id ORDER BY trip_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':trip:' || trip_row.trip_id::text, 0));
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.tresor_trips t WHERE t.workspace_id = p_workspace_id AND t.id = ANY(trip_ids) AND t.deletion_pending
  ) THEN RAISE EXCEPTION 'Uno de los viajes tiene una eliminación pendiente.' USING ERRCODE = '55000'; END IF;

  IF p_rotations IS NULL OR jsonb_typeof(p_rotations) <> 'array' THEN
    RAISE EXCEPTION 'Rotación de enlaces inválida.' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO expected_deliveries
  FROM public.tresor_deliveries d
  WHERE d.workspace_id = p_workspace_id AND d.trip_id = ANY(trip_ids);
  SELECT count(*), count(DISTINCT item->>'delivery_id')
  INTO rotation_count, distinct_rotations
  FROM jsonb_array_elements(p_rotations) AS rotation_items(item);
  IF rotation_count <> expected_deliveries OR distinct_rotations <> rotation_count THEN
    RAISE EXCEPTION 'La lista de enlaces no coincide con las entregas del workspace.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_rotations) AS r(delivery_id uuid, token_hash text, token_nonce text, token_key_version integer)
    LEFT JOIN public.tresor_deliveries d ON d.workspace_id = p_workspace_id AND d.id = r.delivery_id
    WHERE d.id IS NULL OR NOT (d.trip_id = ANY(trip_ids))
      OR r.token_hash IS NULL OR r.token_nonce IS NULL OR r.token_key_version < 1
  ) THEN RAISE EXCEPTION 'La rotación contiene una entrega fuera del alcance.' USING ERRCODE = '22023'; END IF;

  UPDATE public.tresor_passengers SET deletion_pending = true, updated_at = now()
  WHERE workspace_id = p_workspace_id AND id = p_passenger_id;
  UPDATE public.tresor_deliveries d
  SET token_hash = r.token_hash::bytea,
      token_nonce = r.token_nonce::bytea,
      token_key_version = r.token_key_version,
      status = 'revoked', revoked_at = now(), updated_at = now()
  FROM jsonb_to_recordset(p_rotations) AS r(delivery_id uuid, token_hash text, token_nonce text, token_key_version integer)
  WHERE d.workspace_id = p_workspace_id AND d.id = r.delivery_id AND d.trip_id = ANY(trip_ids);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tresor_finish_trip_deletion(p_workspace_id uuid, p_trip_id uuid, p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  changed integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tresor_workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.is_active AND m.role = 'admin'
  ) THEN RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':trip:' || p_trip_id::text, 0));
  PERFORM 1 FROM public.tresor_trips t
  WHERE t.workspace_id = p_workspace_id AND t.id = p_trip_id AND t.deletion_pending FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.tresor_trips t WHERE t.workspace_id = p_workspace_id AND t.id = p_trip_id) THEN RETURN false; END IF;
    RAISE EXCEPTION 'El viaje no está marcado para eliminación.' USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.tresor_notification_attempts na
  USING public.tresor_followups f
  WHERE na.workspace_id = p_workspace_id AND na.followup_id = f.id
    AND f.workspace_id = p_workspace_id AND f.trip_id = p_trip_id;
  DELETE FROM public.tresor_followups WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  DELETE FROM public.tresor_air_flights WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  DELETE FROM public.tresor_air_reservation_passengers WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  DELETE FROM public.tresor_air_reservations WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  DELETE FROM public.tresor_documents WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  DELETE FROM public.tresor_deliveries WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  DELETE FROM public.tresor_trip_passengers WHERE workspace_id = p_workspace_id AND trip_id = p_trip_id;
  DELETE FROM public.tresor_trips WHERE workspace_id = p_workspace_id AND id = p_trip_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tresor_finish_passenger_deletion(p_workspace_id uuid, p_passenger_id uuid, p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  trip_row record;
  next_passenger uuid;
  reservation_ids uuid[];
  changed integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tresor_workspace_members m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.is_active AND m.role = 'admin'
  ) THEN RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':passenger:' || p_passenger_id::text, 0));
  PERFORM 1 FROM public.tresor_passengers p
  WHERE p.workspace_id = p_workspace_id AND p.id = p_passenger_id AND p.deletion_pending FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.tresor_passengers p WHERE p.workspace_id = p_workspace_id AND p.id = p_passenger_id) THEN RETURN false; END IF;
    RAISE EXCEPTION 'El pasajero no está marcado para eliminación.' USING ERRCODE = '55000';
  END IF;
  FOR trip_row IN
    SELECT DISTINCT tp.trip_id FROM public.tresor_trip_passengers tp
    WHERE tp.workspace_id = p_workspace_id AND tp.passenger_id = p_passenger_id ORDER BY tp.trip_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':trip:' || trip_row.trip_id::text, 0));
    SELECT tp.passenger_id INTO next_passenger
    FROM public.tresor_trip_passengers tp
    WHERE tp.workspace_id = p_workspace_id AND tp.trip_id = trip_row.trip_id AND tp.passenger_id <> p_passenger_id
    ORDER BY (tp.relationship = 'primary') DESC, tp.passenger_id
    LIMIT 1;
    UPDATE public.tresor_trip_passengers tp
    SET relationship = CASE WHEN tp.passenger_id = next_passenger THEN 'primary' ELSE 'traveler' END
    WHERE tp.workspace_id = p_workspace_id AND tp.trip_id = trip_row.trip_id AND tp.passenger_id <> p_passenger_id;
    UPDATE public.tresor_deliveries d
    SET primary_passenger_id = next_passenger, status = 'revoked', revoked_at = COALESCE(d.revoked_at, now()), updated_at = now()
    WHERE d.workspace_id = p_workspace_id AND d.trip_id = trip_row.trip_id;
  END LOOP;
  SELECT COALESCE(array_agg(DISTINCT arp.reservation_id), ARRAY[]::uuid[])
  INTO reservation_ids
  FROM public.tresor_air_reservation_passengers arp
  WHERE arp.workspace_id = p_workspace_id AND arp.passenger_id = p_passenger_id;
  DELETE FROM public.tresor_air_reservation_passengers
  WHERE workspace_id = p_workspace_id AND passenger_id = p_passenger_id;
  DELETE FROM public.tresor_air_flights f
  WHERE f.workspace_id = p_workspace_id AND f.reservation_id = ANY(reservation_ids)
    AND NOT EXISTS (
      SELECT 1 FROM public.tresor_air_reservation_passengers remaining
      WHERE remaining.workspace_id = p_workspace_id AND remaining.reservation_id = f.reservation_id
    );
  DELETE FROM public.tresor_air_reservations r
  WHERE r.workspace_id = p_workspace_id AND r.id = ANY(reservation_ids)
    AND NOT EXISTS (
      SELECT 1 FROM public.tresor_air_reservation_passengers remaining
      WHERE remaining.workspace_id = p_workspace_id AND remaining.reservation_id = r.id
    );
  DELETE FROM public.tresor_documents
  WHERE workspace_id = p_workspace_id AND passenger_id = p_passenger_id;
  DELETE FROM public.tresor_trip_passengers
  WHERE workspace_id = p_workspace_id AND passenger_id = p_passenger_id;
  DELETE FROM public.tresor_passengers
  WHERE workspace_id = p_workspace_id AND id = p_passenger_id AND deletion_pending;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.tresor_begin_trip_deletion(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tresor_begin_passenger_deletion(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tresor_finish_trip_deletion(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tresor_finish_passenger_deletion(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tresor_begin_trip_deletion(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tresor_begin_passenger_deletion(uuid,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.tresor_finish_trip_deletion(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tresor_finish_passenger_deletion(uuid,uuid,uuid) TO service_role;

COMMIT;
