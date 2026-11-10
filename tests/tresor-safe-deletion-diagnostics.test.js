'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('la corrección aditiva reconoce service_role en claims legacy y JSON, sin cambiar permisos', () => {
  const migration = read('supabase/migrations/202611100002_tresor_deletion_claim_compat.sql');
  assert.match(migration, /request\.jwt\.claim\.role/);
  assert.match(migration, /request\.jwt\.claims/);
  assert.match(migration, /->> 'role'\s*\) = 'service_role'/);
  assert.match(migration, /trigger_count <> 10/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION tresor_private\.guard_tresor_deletion_pending/);
  assert.doesNotMatch(migration, /GRANT EXECUTE|CREATE POLICY|DROP POLICY|ALTER TABLE/);
});

test('la Edge Function distingue autorización, rechazo SQL y fallos de base sin exponer cuerpo remoto', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  assert.match(edge, /class RestError/);
  assert.match(edge, /error\.code === '42501'/);
  assert.match(edge, /error\.code === '55000'/);
  assert.match(edge, /error\.stage\.startsWith\('storage'/);
  assert.match(edge, /status: error\.status, code:/);
  assert.doesNotMatch(edge, /console\.(?:log|warn|error)\([^\n]*(?:token|storage_path|body)/i);
  assert.match(edge, /No se pudo autorizar|workspace-authorization/);
});

test('la interfaz informa progreso y no anuncia éxito si el registro sigue presente', () => {
  const ui = read('assets/documentacion-agenda-pasajeros.js');
  assert.match(ui, /deletePassenger\(id, actionButton\)/);
  assert.match(ui, /actionButton\.textContent = 'Eliminando…'/);
  assert.match(ui, /No se completó la eliminación del pasajero/);
  assert.match(ui, /byId\(state\.passengers, id\)/);
  assert.match(ui, /deleteTrip\(id, button\)/);
  const trip = ui.slice(ui.indexOf('async function deleteTrip('), ui.indexOf('function handleAction('));
  assert.ok(trip.indexOf('result.deleted !== true') < trip.indexOf('await reloadData()'));
  assert.ok(trip.indexOf('byId(state.trips, id)') < trip.indexOf("setStatus('Viaje y sus PDF eliminados."));
});

test('la Edge Function no trata false del RPC como éxito si el registro aún existe', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const trip = edge.slice(edge.indexOf('async function deleteTrip('), edge.indexOf('async function deletePassenger('));
  const passenger = edge.slice(edge.indexOf('async function deletePassenger('), edge.indexOf('Deno.serve('));
  assert.match(trip, /if \(began === false\)[\s\S]*tripStillExists[\s\S]*throw new HttpError/);
  assert.match(trip, /if \(completed === false\)[\s\S]*tripStillExists[\s\S]*throw new HttpError/);
  assert.match(trip, /completed !== true/);
  assert.match(trip, /verify-trip-delete/);
  assert.match(passenger, /if \(began === false\)[\s\S]*passengerStillExists[\s\S]*throw new HttpError/);
  assert.match(passenger, /if \(completed === false\)[\s\S]*passengerStillExists[\s\S]*throw new HttpError/);
  assert.match(passenger, /completed !== true/);
});

test('la compatibilidad JWT revisa ambas fuentes de claims de forma independiente', () => {
  const migration = read('supabase/migrations/202611100003_tresor_deletion_claim_or.sql');
  const guard = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION tresor_private.guard_tresor_deletion_pending'));
  assert.match(guard, /current_setting\('request\.jwt\.claim\.role', true\) = 'service_role'\s+OR\s+COALESCE\(/);
  assert.match(guard, /NULLIF\(current_setting\('request\.jwt\.claims', true\), ''\)::jsonb ->> 'role'/);
  assert.doesNotMatch(guard, /IF COALESCE\([\s\S]*?request\.jwt\.claim\.role/);
  assert.match(migration, /trigger_count <> 10/);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
});

test('pasajeros vinculados a un viaje pendiente reciben un conflicto seguro antes del RPC', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const passenger = edge.slice(edge.indexOf('async function deletePassenger('), edge.indexOf('Deno.serve('));
  assert.match(passenger, /related-trip-check/);
  assert.match(passenger, /trip\.deletion_pending/);
  assert.match(passenger, /related-trip-pending/);
  assert.ok(passenger.indexOf('related-trip-pending') < passenger.indexOf('rpc/tresor_begin_passenger_deletion'));
});

test('el RPC de inicio rechaza expresamente pasajeros de viajes pendientes antes de cambiar datos', () => {
  const migration = read('supabase/migrations/202611100001_tresor_safe_deletions.sql');
  const begin = migration.slice(migration.indexOf('FUNCTION public.tresor_begin_passenger_deletion'), migration.indexOf('FUNCTION public.tresor_finish_trip_deletion'));
  const pendingCheck = begin.indexOf("t.deletion_pending");
  const raise = begin.indexOf("USING ERRCODE = '55000'", pendingCheck);
  const mutation = begin.indexOf('UPDATE public.tresor_passengers SET deletion_pending = true');
  assert.ok(pendingCheck >= 0 && raise > pendingCheck && mutation > raise);
  assert.match(begin, /Uno de los viajes tiene una eliminación pendiente/);
});

test('fallos de Storage registran estados HTTP y códigos acotados sin rutas ni cuerpos', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const deletion = edge.slice(edge.indexOf('async function removeObject('), edge.indexOf('async function removeDocuments('));
  assert.match(deletion, /deleteStatus/);
  assert.match(deletion, /infoStatus/);
  assert.match(deletion, /safeStorageErrorCode/);
  assert.match(deletion, /Storage deletion not confirmed/);
  assert.match(deletion, /deleteConfirmedAbsentOrRemoved && await confirmsMissingStorageObjectResponse\(info\)\) return/);
  assert.doesNotMatch(deletion, /console\.warn\([^;]*(?:storagePath|storage_path|token)/i);
});

test('solo confirma como idempotente la ausencia explícita del objeto, nunca errores de permiso o servicio', () => {
  const edge = read('supabase/functions/tresor-delivery-admin/index.ts');
  const start = edge.indexOf('function confirmsMissingStorageObject(');
  const end = edge.indexOf('\nasync function confirmsMissingStorageObjectResponse', start);
  assert.ok(start >= 0 && end > start, 'helper de clasificación de objeto ausente presente');
  const helperSource = edge.slice(start, end);
  const confirmsMissing = new Function(`${helperSource}; return confirmsMissingStorageObject;`)();
  const absent = { statusCode: '404', error: 'not_found', message: 'Object not found' };
  assert.equal(confirmsMissing(400, absent), true, 'acepta el formato de error de Storage para objeto ausente');
  assert.equal(confirmsMissing(404, absent), true, 'acepta HTTP 404 con cuerpo explícito de objeto ausente');
  assert.equal(confirmsMissing(404, { code: 'NoSuchKey', message: 'Object not found' }), true, 'acepta el formato actual de Storage');
  assert.equal(confirmsMissing(404, { statusCode: '404', error: 'NoSuchKey' }), true, 'acepta clave inexistente identificada por código');
  assert.equal(confirmsMissing(404, { statusCode: '404', error: 'BucketNotFound' }), false, 'no confunde bucket ausente con objeto ausente');
  assert.equal(confirmsMissing(404, { statusCode: '404', error: 'not_found', message: 'Bucket not found' }), false);
  assert.equal(confirmsMissing(404, { statusCode: '404', error: 'not_found' }), false, 'not_found genérico no es suficiente');
  assert.equal(confirmsMissing(403, absent), false, 'no ignora permisos');
  assert.equal(confirmsMissing(503, absent), false, 'no ignora errores del servicio');
  assert.equal(confirmsMissing(200, absent), false, 'no clasifica una respuesta exitosa como ausencia');
  const deletion = edge.slice(edge.indexOf('async function removeObject('), edge.indexOf('async function removeDocuments('));
  assert.match(deletion, /if \(removed\.ok\) deleteConfirmedAbsentOrRemoved = true/);
  assert.match(deletion, /deleteConfirmedAbsentOrRemoved = await confirmsMissingStorageObjectResponse\(removed\)/);
  assert.match(deletion, /deleteConfirmedAbsentOrRemoved && await confirmsMissingStorageObjectResponse\(info\)/);
  assert.match(deletion, /Sin respuesta del borrado no se asume/);
});

test('la interfaz exige confirmación explícita del servidor y fuerza nueva versión del script', () => {
  const ui = read('assets/documentacion-agenda-pasajeros.js');
  for (const html of ['apps/documentacion-agenda-pasajeros.html', 'dist/apps/documentacion-agenda-pasajeros.html']) {
    const contents = read(html);
    assert.match(contents, /documentacion-agenda-pasajeros\.js\?v=20261110-safe-delete2/);
    assert.doesNotMatch(contents, /documentacion-agenda-pasajeros\.js\?v=20261110-safe-delete1/);
  }
  assert.match(ui, /result\.deleted !== true/);
  assert.equal(read('assets/documentacion-agenda-pasajeros.js'), read('dist/assets/documentacion-agenda-pasajeros.js'));
});

test('la interfaz está sincronizada y la migración previa permanece sin cambios locales', () => {
  assert.equal(read('assets/documentacion-agenda-pasajeros.js'), read('dist/assets/documentacion-agenda-pasajeros.js'));
  const migration = read('supabase/migrations/202611100002_tresor_deletion_claim_compat.sql');
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(migration, /request\.jwt\.claims/);
});
