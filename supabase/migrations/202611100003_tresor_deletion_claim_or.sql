BEGIN;

-- The compatibility migration 002 used COALESCE, which can prefer a stale
-- legacy claim over the JSON claims object. Check both representations independently.
DO $preflight$
DECLARE trigger_count integer;
BEGIN
  IF to_regprocedure('tresor_private.guard_tresor_deletion_pending()') IS NULL THEN
    RAISE EXCEPTION 'No existe el guard de eliminación esperado; no se modificó nada.';
  END IF;
  SELECT count(*) INTO trigger_count
  FROM pg_trigger tr
  JOIN pg_class c ON c.oid = tr.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT tr.tgisinternal AND n.nspname = 'public'
    AND tr.tgname IN (
      'tresor_trips_delete_pending_guard', 'tresor_passengers_delete_pending_guard',
      'tresor_trip_passengers_delete_pending_guard', 'tresor_documents_delete_pending_guard',
      'tresor_deliveries_delete_pending_guard', 'tresor_air_reservations_delete_pending_guard',
      'tresor_air_flights_delete_pending_guard', 'tresor_air_reservation_passengers_delete_pending_guard',
      'tresor_followups_delete_pending_guard', 'tresor_notification_attempts_delete_pending_guard'
    );
  IF trigger_count <> 10 THEN
    RAISE EXCEPTION 'Se esperaban los 10 triggers de protección; encontrados: %.', trigger_count;
  END IF;
END;
$preflight$;

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
  -- Either PostgREST claim can independently prove service_role. Do not let a
  -- stale legacy claim mask the role in the JSON claims object.
  IF current_setting('request.jwt.claim.role', true) = 'service_role'
    OR COALESCE(
      (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') = 'service_role',
      false
    ) THEN
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

COMMIT;
