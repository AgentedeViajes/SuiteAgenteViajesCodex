/* Acceso a los datos de pasajeros y viajes; usa exclusivamente la sesión SuiteCloud. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PassengerAgendaStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var tables = {
    workspaces: 'tresor_workspaces', members: 'tresor_workspace_members',
    passengers: 'tresor_passengers', trips: 'tresor_trips', links: 'tresor_trip_passengers',
    deliveries: 'tresor_deliveries', documents: 'tresor_documents',
    reservations: 'tresor_air_reservations', reservationPassengers: 'tresor_air_reservation_passengers',
    followups: 'tresor_followups'
  };
  function eq(value) { return 'eq.' + String(value); }
  function inList(values) { return 'in.(' + values.map(String).join(',') + ')'; }
  function rows(cloud, table, filters, columns) {
    return cloud.selectAll(table, filters, columns || '*');
  }
  async function optionalRows(cloud, table, filters, columns) {
    try { return await rows(cloud, table, filters, columns); }
    catch (error) {
      if (error && (error.status === 404 || /relation .* does not exist|could not find the table|schema cache/i.test(error.message || ''))) return [];
      throw error;
    }
  }
  function representation(cloud, path, method, body) {
    return cloud.api(path, {
      method: method,
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (result) { return result.data; });
  }
  function filterPath(table, filters) {
    var query = new URLSearchParams(filters);
    return '/rest/v1/' + encodeURIComponent(table) + '?' + query.toString();
  }
  function byWorkspace(workspaceId, filters) {
    var result = Object.assign({ workspace_id: eq(workspaceId) }, filters || {});
    return result;
  }
  function create(cloud, workspaceId) {
    if (!cloud || typeof cloud.api !== 'function' || typeof cloud.selectAll !== 'function') throw new Error('SuiteCloud no está disponible.');
    if (!workspaceId) throw new Error('No hay un espacio de trabajo activo.');

    return {
      workspaceId: workspaceId,
      async load() {
        var filters = byWorkspace(workspaceId);
        var result = await Promise.all([
          rows(cloud, tables.passengers, filters),
          rows(cloud, tables.trips, filters),
          rows(cloud, tables.links, filters)
        ]);
        return { passengers: result[0] || [], trips: result[1] || [], links: result[2] || [] };
      },
      async createPassenger(record) {
        var data = await representation(cloud, '/rest/v1/' + tables.passengers, 'POST', Object.assign({}, record, { workspace_id: workspaceId }));
        return Array.isArray(data) ? data[0] : data;
      },
      async updatePassenger(id, record) {
        var path = filterPath(tables.passengers, byWorkspace(workspaceId, { id: eq(id), select: '*' }));
        var data = await representation(cloud, path, 'PATCH', record);
        return Array.isArray(data) ? data[0] : data;
      },
      async deletePassenger(id) {
        return representation(cloud, '/functions/v1/tresor-delivery-admin', 'POST', {
          action: 'delete-passenger', workspaceId: workspaceId, passengerId: id
        });
      },
      async createTrip(record, passengerIds) {
        if (!passengerIds || !passengerIds.length) throw new Error('Seleccioná al menos un pasajero para el viaje.');
        var data = await representation(cloud, '/rest/v1/' + tables.trips, 'POST', Object.assign({}, record, { workspace_id: workspaceId }));
        var trip = Array.isArray(data) ? data[0] : data;
        if (!trip || !trip.id) throw new Error('Supabase no devolvió el viaje creado.');
        try {
          var linkRows = passengerIds.map(function (passengerId, index) {
            return { workspace_id: workspaceId, trip_id: trip.id, passenger_id: passengerId, relationship: index === 0 ? 'primary' : 'traveler' };
          });
          await representation(cloud, '/rest/v1/' + tables.links, 'POST', linkRows);
        } catch (error) {
          try { await cloud.api(filterPath(tables.trips, byWorkspace(workspaceId, { id: eq(trip.id) })), { method: 'DELETE' }); } catch (_) {}
          throw error;
        }
        return trip;
      },
      async updateTripDetails(id, record) {
        var path = filterPath(tables.trips, byWorkspace(workspaceId, { id: eq(id), select: '*' }));
        var data = await representation(cloud, path, 'PATCH', record);
        return Array.isArray(data) ? data[0] : data;
      },
      async updateTrip(id, record, passengerIds, currentPassengerIds) {
        if (!passengerIds || !passengerIds.length) throw new Error('Un viaje debe conservar al menos un pasajero.');
        var previous = new Set((currentPassengerIds || []).map(String));
        var next = new Set(passengerIds.map(String));
        var additions = Array.from(next).filter(function (value) { return !previous.has(value); });
        var removals = Array.from(previous).filter(function (value) { return !next.has(value); });
        var path = filterPath(tables.trips, byWorkspace(workspaceId, { id: eq(id), select: '*' }));
        var data = await representation(cloud, path, 'PATCH', record);
        var linksPath;
        if (additions.length) {
          var linkRows = additions.map(function (passengerId) {
            return { workspace_id: workspaceId, trip_id: id, passenger_id: passengerId, relationship: 'traveler' };
          });
          await representation(cloud, '/rest/v1/' + tables.links, 'POST', linkRows);
        }
        for (var index = 0; index < removals.length; index += 1) {
          linksPath = filterPath(tables.links, byWorkspace(workspaceId, { trip_id: eq(id), passenger_id: eq(removals[index]) }));
          await cloud.api(linksPath, { method: 'DELETE' });
        }
        return Array.isArray(data) ? data[0] : data;
      },
      async deleteTrip(id) {
        return representation(cloud, '/functions/v1/tresor-delivery-admin', 'POST', {
          action: 'delete-trip', workspaceId: workspaceId, tripId: id
        });
      }
    };
  }

  async function resolveWorkspace(cloud, userId) {
    if (!userId) throw new Error('SuiteCloud no devolvió una sesión administradora.');
    var memberships = await rows(cloud, tables.members, { user_id: eq(userId), is_active: eq(true) }, 'workspace_id,role');
    if (!memberships.length) {
      var absent = new Error('La cuenta inició sesión, pero todavía no tiene un espacio de trabajo habilitado. Se requiere aplicar la configuración SQL autorizada.');
      absent.code = 'WORKSPACE_NOT_PROVISIONED';
      throw absent;
    }
    if (memberships.length > 1) {
      var ambiguous = new Error('La cuenta tiene más de un espacio de trabajo activo. La selección de varios espacios no forma parte de esta etapa.');
      ambiguous.code = 'MULTIPLE_WORKSPACES';
      throw ambiguous;
    }
    var membership = memberships[0];
    var workspaces = await rows(cloud, tables.workspaces, { id: eq(membership.workspace_id) }, 'id,name');
    if (!workspaces.length) throw new Error('No se encontró el espacio de trabajo asociado a la cuenta.');
    return { id: membership.workspace_id, name: workspaces[0].name, role: membership.role };
  }

  function normalizeText(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' '); }
  function normalizeEmail(value) { return normalizeText(value); }
  function normalizePhone(value) { return normalizeText(value); }
  // Los números locales se interpretan como móviles argentinos; los internacionales explícitos se respetan.
  function normalizeWhatsAppNumber(value) {
    var raw = normalizeText(value);
    if (!raw) return '';
    var digits = raw.replace(/\D/g, '');
    if (raw.slice(0, 2) === '00') digits = digits.slice(2);
    else if (raw.charAt(0) !== '+' && digits.indexOf('54') !== 0) {
      digits = digits.replace(/^0+/, '').replace(/^15(?=\d{8,10}$)/, '');
      if (digits.length >= 8 && digits.length <= 10) digits = '549' + digits;
    }
    return digits.length >= 10 && digits.length <= 15 && /^[1-9]\d+$/.test(digits) ? digits : '';
  }
  function whatsappMessage(passenger) {
    var name = normalizeText([passenger && passenger.first_name, passenger && passenger.last_name].filter(Boolean).join(' ')) || 'Hola';
    return '¡Hola, ' + name + '! 😊\n\nQuería ponerme en contacto con vos.\n\nJavier\nTu asesor de viajes en Tresor Travel ✈️';
  }
  function whatsappUrl(number, message) {
    var digits = normalizeWhatsAppNumber(number);
    return digits ? 'https://wa.me/' + digits + '?text=' + encodeURIComponent(String(message || '')) : '';
  }
  function openTripEditor(trips, id, openDialog) {
    var trip = (trips || []).find(function (item) { return String(item.id) === String(id); });
    if (!trip || typeof openDialog !== 'function') return false;
    openDialog('Editar viaje', 'Historial comercial', trip);
    return true;
  }
  function tripEditorPeople(record, passengers, links) {
    var ordered = (passengers || []).slice().sort(function (a, b) {
      return [a.first_name, a.last_name].filter(Boolean).join(' ').localeCompare([b.first_name, b.last_name].filter(Boolean).join(' '), 'es');
    });
    if (!record) return { selectionAllowed: true, passengers: ordered };
    var ids = new Set((links || []).filter(function (link) { return String(link.trip_id) === String(record.id); }).map(function (link) { return String(link.passenger_id); }));
    return { selectionAllowed: false, passengers: ordered.filter(function (person) { return ids.has(String(person.id)); }) };
  }
  function searchKey(value) {
    return normalizeText(value).toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s()+.\-]/g, '');
  }
  function validatePassenger(record) {
    var errors = {};
    if (!normalizeText(record.first_name)) errors.first_name = 'Ingresá el nombre.';
    if (!normalizeText(record.last_name)) errors.last_name = 'Ingresá el apellido.';
    var email = normalizeEmail(record.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Revisá el formato del correo.';
    return errors;
  }
  function validateTrip(record) {
    var errors = {};
    if (!normalizeText(record.destination)) errors.destination = 'Ingresá el destino.';
    if (record.departure_on && record.return_on && record.return_on < record.departure_on) errors.return_on = 'La fecha de regreso no puede ser anterior a la salida.';
    return errors;
  }
  function tripStatus(trip, today) {
    if (trip.status === 'cancelled') return 'cancelled';
    if (trip.status === 'completed' || trip.is_historical) return 'completed';
    var now = today || new Date().toISOString().slice(0, 10);
    if (trip.departure_on && trip.departure_on > now) return 'upcoming';
    if (trip.return_on && trip.return_on < now) return 'completed';
    if (trip.departure_on && trip.departure_on <= now && (!trip.return_on || trip.return_on >= now)) return 'ongoing';
    if (trip.status === 'confirmed') return 'upcoming';
    return 'upcoming';
  }

  return Object.freeze({ create: create, resolveWorkspace: resolveWorkspace, openTripEditor: openTripEditor, tripEditorPeople: tripEditorPeople, normalizeText: normalizeText, normalizeEmail: normalizeEmail, normalizePhone: normalizePhone, normalizeWhatsAppNumber: normalizeWhatsAppNumber, whatsappMessage: whatsappMessage, whatsappUrl: whatsappUrl, searchKey: searchKey, validatePassenger: validatePassenger, validateTrip: validateTrip, tripStatus: tripStatus });
});
