'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('la Edge Function administra ambos borrados con workspace y sesión verificados', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const store = read('assets/documentacion-agenda-pasajeros-store.js');
  assert.match(edge, /auth\/v1\/user/);
  assert.match(edge, /role: 'eq\.admin'/);
  assert.match(edge, /action === 'delete-trip'/);
  assert.match(edge, /action === 'delete-passenger'/);
  assert.match(store, /action: 'delete-trip', workspaceId: workspaceId, tripId: id/);
  assert.match(store, /action: 'delete-passenger', workspaceId: workspaceId, passengerId: id/);
  assert.doesNotMatch(store, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
});

test('el viaje se revoca, valida rutas registradas, borra Storage y luego finaliza SQL', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const start = edge.indexOf('async function deleteTrip(');
  const end = edge.indexOf('async function deletePassenger(', start);
  const body = edge.slice(start, end);
  assert.ok(body.indexOf('rpc/tresor_begin_trip_deletion') < body.indexOf('removeDocuments'));
  assert.ok(body.indexOf('removeDocuments') < body.indexOf('rpc/tresor_finish_trip_deletion'));
  assert.match(body, /tresor_documents\?/);
  assert.match(edge, /validDocumentPath\(row\.storage_path, workspaceId, row\.trip_id, row\.delivery_id\)/);
  assert.match(edge, /storage\/v1\/object\/\$\{bucket\}/);
  assert.match(edge, /object\/info\/\$\{bucket\}/);
  assert.match(edge, /endpoint de información confirma que Storage ya no reporta la ruta/);
  assert.match(edge, /deleteConfirmedAbsentOrRemoved && await confirmsMissingStorageObjectResponse\(info\)\) return/);
});

test('borrar pasajero elimina solo sus PDF privados y rota/revoca enlaces del grupo', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const migration = read('supabase/migrations/202611100001_tresor_safe_deletions.sql');
  assert.match(edge, /passenger_id: `eq\.\$\{passengerId\}`/);
  assert.match(edge, /deriveToken\(secret\(currentVersion\), currentVersion, delivery\.id, nonce\)/);
  assert.match(migration, /DELETE FROM public\.tresor_documents\s+WHERE workspace_id = p_workspace_id AND passenger_id = p_passenger_id/);
  assert.match(migration, /primary_passenger_id = next_passenger/);
  assert.match(migration, /ALTER COLUMN primary_passenger_id DROP NOT NULL/);
  assert.match(migration, /status = 'revoked'/);
});

test('migración finaliza relaciones respetando las 17 FKs RESTRICT sin cascadas generales', () => {
  const migration = read('supabase/migrations/202611100001_tresor_safe_deletions.sql');
  const trip = migration.slice(migration.indexOf('FUNCTION public.tresor_finish_trip_deletion'), migration.indexOf('FUNCTION public.tresor_finish_passenger_deletion'));
  const order = ['tresor_notification_attempts', 'tresor_followups', 'tresor_air_flights', 'tresor_air_reservation_passengers', 'tresor_air_reservations', 'tresor_documents', 'tresor_deliveries', 'tresor_trip_passengers', 'tresor_trips'];
  let prior = -1;
  for (const table of order) { const at = trip.indexOf(`DELETE FROM public.${table}`); assert.ok(at > prior, `${table} debe respetar el orden FK`); prior = at; }
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
  assert.match(migration, /SET search_path TO ''/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.tresor_finish_trip_deletion[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.tresor_finish_trip_deletion[\s\S]*TO service_role/);
});

test('un fallo parcial conserva datos con flag pendiente y la interfaz ofrece reintentar', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const ui = read('assets/documentacion-agenda-pasajeros.js');
  const migration = read('supabase/migrations/202611100001_tresor_safe_deletions.sql');
  assert.match(migration, /deletion_pending boolean NOT NULL DEFAULT false/);
  assert.match(edge, /No se pudieron retirar todos los PDF de Storage/);
  assert.match(edge, /El registro quedó pendiente/);
  assert.match(ui, /Reintentar eliminación/);
  assert.match(ui, /await reloadData\(\)\.catch/);
});

test('políticas RESTRICTIVE y triggers bloquean nuevas escrituras durante el borrado', () => {
  const migration = read('supabase/migrations/202611100001_tresor_safe_deletions.sql');
  assert.equal((migration.match(/AS RESTRICTIVE/g) || []).length, 3);
  assert.equal((migration.match(/CREATE TRIGGER tresor_/g) || []).length, 10);
  assert.match(migration, /CREATE OR REPLACE FUNCTION tresor_private\.is_document_deletion_pending/);
  assert.match(migration, /current_setting\('request\.jwt\.claim\.role', true\) = 'service_role'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION tresor_private\.is_document_deletion_pending\(text\) FROM PUBLIC, anon/);
  assert.match(migration, /REVOKE ALL ON FUNCTION tresor_private\.guard_tresor_deletion_pending\(\) FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /IF TG_TABLE_NAME = 'tresor_deliveries' THEN\s+passenger_uuid := NULLIF\(row_data->>'primary_passenger_id'/);
});

test('preflight lista índices únicos parciales y postflight valida ejecución solo del servidor', () => {
  const preflight = read('supabase/preflight_tresor_safe_deletions.sql');
  const postflight = read('supabase/postflight_tresor_safe_deletions.sql');
  assert.match(preflight, /FROM pg_indexes[\s\S]*indexdef ILIKE '%UNIQUE%'/);
  assert.match(postflight, /has_function_privilege\('public', p\.oid, 'EXECUTE'\)/);
  assert.match(postflight, /guard_tresor_deletion_pending/);
});

test('preflight y postflight de la migración contienen solo consultas de lectura', () => {
  for (const file of ['supabase/preflight_tresor_safe_deletions.sql', 'supabase/postflight_tresor_safe_deletions.sql']) {
    const sql = read(file).replace(/--[^\n]*/g, '');
    const statements = sql.split(';').map((x) => x.trim()).filter(Boolean);
    assert.ok(statements.length >= 3);
    assert.ok(statements.every((x) => /^SELECT\b/i.test(x)), `${file} debe ser solo lectura`);
  }
});

test('copias de distribución quedan sincronizadas con los archivos de la aplicación', () => {
  for (const [source, dist] of [
    ['apps/documentacion-agenda-pasajeros.html', 'dist/apps/documentacion-agenda-pasajeros.html'],
    ['assets/documentacion-agenda-pasajeros-store.js', 'dist/assets/documentacion-agenda-pasajeros-store.js'],
    ['assets/documentacion-agenda-pasajeros.js', 'dist/assets/documentacion-agenda-pasajeros.js']
  ]) assert.equal(read(source), read(dist), `${dist} debe coincidir con ${source}`);
});
