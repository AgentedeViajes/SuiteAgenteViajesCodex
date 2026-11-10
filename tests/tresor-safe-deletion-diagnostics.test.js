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
