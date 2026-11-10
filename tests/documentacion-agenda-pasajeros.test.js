const test = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../assets/documentacion-agenda-pasajeros-store.js');

function fakeCloud({ rows = {}, createResponse = [], failDelete = false } = {}) {
  const calls = [];
  return {
    calls,
    async selectAll(table, filters, columns) {
      calls.push({ type: 'select', table, filters, columns });
      return typeof rows[table] === 'function' ? rows[table](filters) : (rows[table] || []);
    },
    async api(path, options = {}) {
      calls.push({ type: options.method || 'GET', path, options });
      if (options.method === 'DELETE' && failDelete) throw Object.assign(new Error('blocked'), { status: 409 });
      if (options.method === 'POST') return { data: createResponse.length ? createResponse : [{ id: 'new-id' }] };
      if (options.method === 'PATCH') return { data: [{ id: 'existing-id' }] };
      return { data: [] };
    }
  };
}

test('normaliza espacios sin alterar valores válidos de contacto', () => {
  assert.equal(Store.normalizeText('  María   González '), 'María González');
  assert.equal(Store.normalizeEmail('  Maria.G@example.com  '), 'Maria.G@example.com');
  assert.equal(Store.normalizePhone(' +54 11 5555-2222 '), '+54 11 5555-2222');
});

test('valida pasajero con datos de contacto opcionales y rechaza correo inválido', () => {
  assert.deepEqual(Store.validatePassenger({ first_name: 'María', last_name: 'González', email: '', phone: '' }), {});
  assert.equal(Store.validatePassenger({ first_name: 'María', last_name: '', email: 'no-es-correo' }).last_name, 'Ingresá el apellido.');
  assert.equal(Store.validatePassenger({ first_name: 'María', last_name: 'González', email: 'no-es-correo' }).email, 'Revisá el formato del correo.');
});

test('valida destinos y orden cronológico de las fechas', () => {
  assert.equal(Store.validateTrip({ destination: '', departure_on: '', return_on: '' }).destination, 'Ingresá el destino.');
  assert.equal(Store.validateTrip({ destination: 'Europa', departure_on: '2026-11-10', return_on: '2026-11-09' }).return_on, 'La fecha de regreso no puede ser anterior a la salida.');
  assert.deepEqual(Store.validateTrip({ destination: 'Europa', departure_on: null, return_on: null }), {});
});

test('deriva estados de viaje sin inventar fechas y respeta cancelaciones', () => {
  assert.equal(Store.tripStatus({ status: 'planning', departure_on: '2027-01-10', return_on: '2027-01-15' }, '2026-11-09'), 'upcoming');
  assert.equal(Store.tripStatus({ status: 'confirmed', departure_on: '2026-11-08', return_on: '2026-11-12' }, '2026-11-09'), 'ongoing');
  assert.equal(Store.tripStatus({ status: 'planning', departure_on: '2026-10-01', return_on: '2026-10-08' }, '2026-11-09'), 'completed');
  assert.equal(Store.tripStatus({ status: 'cancelled', departure_on: '2027-01-10' }, '2026-11-09'), 'cancelled');
  assert.equal(Store.tripStatus({ status: 'completed', is_historical: true }, '2026-11-09'), 'completed');
});

test('busca ignorando mayúsculas, tildes y formato telefónico', () => {
  assert.equal(Store.searchKey('  GONZÁLEZ '), 'gonzalez');
  assert.equal(Store.searchKey('+54 (11) 5555-2222'), '541155552222');
});

test('prepara WhatsApp con número internacional y admite formatos locales argentinos', () => {
  assert.equal(Store.normalizeWhatsAppNumber('+54 9 11 5555-2222'), '5491155552222');
  assert.equal(Store.normalizeWhatsAppNumber('011 5555-2222'), '5491155552222');
  assert.equal(Store.normalizeWhatsAppNumber('5491155552222'), '5491155552222');
  assert.equal(Store.normalizeWhatsAppNumber('123'), '');
  const message = Store.whatsappMessage({ first_name: 'María', last_name: 'González' });
  assert.match(message, /¡Hola, María González!/);
  const url = Store.whatsappUrl('+54 9 11 5555-2222', message);
  assert.match(url, /^https:\/\/wa\.me\/5491155552222\?text=/);
  assert.equal(decodeURIComponent(url.split('?text=')[1]), message);
  assert.equal(Store.whatsappUrl('123', message), '');
});

test('resuelve únicamente la membresía autenticada y limita la búsqueda al workspace', async () => {
  const cloud = fakeCloud({ rows: {
    tresor_workspace_members: [{ workspace_id: 'workspace-1', role: 'admin' }],
    tresor_workspaces: [{ id: 'workspace-1', name: 'Tresor Travel' }]
  } });
  const workspace = await Store.resolveWorkspace(cloud, 'user-1');
  assert.deepEqual(workspace, { id: 'workspace-1', name: 'Tresor Travel', role: 'admin' });
  const store = Store.create(cloud, workspace.id);
  await store.load();
  const dataQueries = cloud.calls.filter(call => call.type === 'select' && ['tresor_passengers','tresor_trips','tresor_trip_passengers'].includes(call.table));
  assert.equal(dataQueries.length, 3);
  assert.ok(dataQueries.every(call => call.filters.workspace_id === 'eq.workspace-1'));
});

test('informa si no hay membresía o si hay más de un workspace', async () => {
  await assert.rejects(Store.resolveWorkspace(fakeCloud(), 'user-1'), error => error.code === 'WORKSPACE_NOT_PROVISIONED');
  const cloud = fakeCloud({ rows: { tresor_workspace_members: [{ workspace_id: 'one' }, { workspace_id: 'two' }] } });
  await assert.rejects(Store.resolveWorkspace(cloud, 'user-1'), error => error.code === 'MULTIPLE_WORKSPACES');
});

test('alta y edición se escriben mediante SuiteCloud en las tablas remotas', async () => {
  const cloud = fakeCloud({ createResponse: [{ id: 'p-1', first_name: 'María', workspace_id: 'workspace-1' }] });
  const store = Store.create(cloud, 'workspace-1');
  const created = await store.createPassenger({ first_name: 'María', last_name: 'González' });
  assert.equal(created.id, 'p-1');
  assert.ok(cloud.calls.some(call => call.type === 'POST' && call.path === '/rest/v1/tresor_passengers'));
  await store.updatePassenger('p-1', { first_name: 'María Elena' });
  assert.ok(cloud.calls.some(call => call.type === 'PATCH' && call.path.includes('/tresor_passengers?')));
});

test('un viaje compartido crea una fila única y asociaciones para todos los pasajeros', async () => {
  const cloud = fakeCloud({ createResponse: [{ id: 'trip-1' }] });
  const store = Store.create(cloud, 'workspace-1');
  const trip = await store.createTrip({ destination: 'Europa', trip_name: 'Circuito' }, ['p-1', 'p-2']);
  assert.equal(trip.id, 'trip-1');
  const linkWrite = cloud.calls.find(call => call.type === 'POST' && call.path === '/rest/v1/tresor_trip_passengers');
  const payload = JSON.parse(linkWrite.options.body);
  assert.equal(payload.length, 2);
  assert.equal(payload[0].relationship, 'primary');
  assert.equal(payload[1].relationship, 'traveler');
  assert.ok(payload.every(row => row.workspace_id === 'workspace-1' && row.trip_id === 'trip-1'));
});

test('actualizar integrantes modifica solo las asociaciones del viaje seleccionado', async () => {
  const cloud = fakeCloud();
  const store = Store.create(cloud, 'workspace-1');
  await store.updateTrip('trip-1', { destination: 'Europa' }, ['p-2', 'p-3'], ['p-1', 'p-2']);
  const writes = cloud.calls.filter(call => call.type === 'POST' || call.type === 'DELETE');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].type, 'POST');
  assert.equal(writes[0].path, '/rest/v1/tresor_trip_passengers');
  assert.equal(JSON.parse(writes[0].options.body)[0].passenger_id, 'p-3');
  assert.ok(writes[1].path.includes('passenger_id=eq.p-1'));
  assert.equal(JSON.parse(writes[0].options.body)[0].workspace_id, 'workspace-1');
  assert.ok(writes[1].path.includes('workspace_id=eq.workspace-1'));
});

test('el borrado de pasajero asociado se deriva al endpoint administrativo sin escrituras directas', async () => {
  const cloud = fakeCloud({ rows: { tresor_trip_passengers: [{ trip_id: 't-1' }] } });
  const store = Store.create(cloud, 'workspace-1');
  await store.deletePassenger('p-1');
  const call = cloud.calls.find(item => item.path.includes('/functions/v1/tresor-delivery-admin'));
  assert.ok(call);
  assert.equal(JSON.parse(call.options.body).action, 'delete-passenger');
  assert.equal(JSON.parse(call.options.body).workspaceId, 'workspace-1');
  assert.equal(JSON.parse(call.options.body).passengerId, 'p-1');
  assert.equal(cloud.calls.some(item => item.type === 'DELETE' && /tresor_passengers|tresor_trip_passengers/.test(item.path)), false);
});

test('el borrado de viaje con dependencias se deriva al endpoint administrativo del workspace', async () => {
  const cloud = fakeCloud({ rows: { tresor_deliveries: [{ id: 'delivery-1' }] } });
  const store = Store.create(cloud, 'workspace-1');
  await store.deleteTrip('trip-1');
  const call = cloud.calls.find(item => item.path.includes('/functions/v1/tresor-delivery-admin'));
  assert.ok(call);
  assert.equal(JSON.parse(call.options.body).action, 'delete-trip');
  assert.equal(JSON.parse(call.options.body).workspaceId, 'workspace-1');
  assert.equal(JSON.parse(call.options.body).tripId, 'trip-1');
  assert.equal(cloud.calls.some(item => item.type === 'DELETE'), false);
});


test('registrar viaje ofrece todos los pasajeros para seleccion y editar solo devuelve los ya asociados', () => {
  const passengers=[{id:'p-1',first_name:'Ana',last_name:'Zeta'},{id:'p-2',first_name:'Luis',last_name:'Alfa'},{id:'p-3',first_name:'Eva',last_name:'Beta'}];
  const links=[{trip_id:'trip-1',passenger_id:'p-1'},{trip_id:'trip-1',passenger_id:'p-3'},{trip_id:'trip-other',passenger_id:'p-2'}];
  const createView=Store.tripEditorPeople(null,passengers,links);assert.equal(createView.selectionAllowed,true);assert.deepEqual(createView.passengers.map(p=>p.id),['p-1','p-3','p-2']);
  const editView=Store.tripEditorPeople({id:'trip-1'},passengers,links);assert.equal(editView.selectionAllowed,false);assert.deepEqual(editView.passengers.map(p=>p.id),['p-1','p-3']);
});

test('editar los campos de un viaje ejecuta solo PATCH al viaje y no toca asociaciones', async () => {
  const cloud=fakeCloud();const store=Store.create(cloud,'workspace-1');
  await store.updateTripDetails('trip-1',{destination:'Brasil',notes:'Actualizado'});
  const writes=cloud.calls.filter(call=>['POST','PATCH','DELETE'].includes(call.type));
  assert.equal(writes.length,1);assert.equal(writes[0].type,'PATCH');assert.ok(writes[0].path.includes('/tresor_trips?'));assert.deepEqual(JSON.parse(writes[0].options.body),{destination:'Brasil',notes:'Actualizado'});
  assert.equal(cloud.calls.some(call=>call.path&&call.path.includes('/tresor_trip_passengers')),false);
});

test('la interfaz solo crea casillas al registrar y guarda ediciones con la operacion sin asociaciones',()=>{
  const fs=require('node:fs'),source=fs.readFileSync(require('node:path').join(__dirname,'../assets/documentacion-agenda-pasajeros.js'),'utf8');
  assert.match(source,/if \(record\) \{\s*var memberTitle[\s\S]*?trip-passenger-readonly[\s\S]*?\} else \{[\s\S]*?checkbox\.name = 'passenger_ids'/);
  assert.match(source,/state\.store\.updateTripDetails\(record\.id/);
});


test('el botón Editar viaje resuelve el viaje y abre el formulario de edición', () => {
  const trip={id:'trip-1',destination:'Brasil'},dialog={open:false,showModal(){this.open=true;}};
  const opened=Store.openTripEditor([trip], 'trip-1', (title, eyebrow, selected) => { assert.equal(title,'Editar viaje');assert.equal(eyebrow,'Historial comercial');assert.equal(selected,trip);dialog.showModal(); });
  assert.equal(opened,true);assert.equal(dialog.open,true);
  assert.equal(Store.openTripEditor([trip], 'missing', () => dialog.showModal()),false);
});

test('editar viaje conserva compatibilidad con Store anterior y muestra solo asociados',()=>{
  const fs=require('node:fs'),source=fs.readFileSync(require('node:path').join(__dirname,'../assets/documentacion-agenda-pasajeros.js'),'utf8');
  assert.match(source,/typeof model\.tripEditorPeople === 'function' \? model\.tripEditorPeople[\s\S]*tripPassengers\(record\.id\)/);
  assert.match(source,/model\.openTripEditor\(state\.trips, id/);
  assert.match(source,/typeof state\.store\.updateTripDetails === 'function'[\s\S]*unchangedIds, unchangedIds/);
});

test('HTML de la aplicación invalida caché de los scripts del formulario',()=>{
  const fs=require('node:fs'),html=fs.readFileSync(require('node:path').join(__dirname,'../apps/documentacion-agenda-pasajeros.html'),'utf8');
  assert.match(html,/documentacion-agenda-pasajeros-store\.js\?v=20261110-safe-delete1/);
  assert.match(html,/documentacion-agenda-pasajeros\.js\?v=20261110-safe-delete2/);
});
