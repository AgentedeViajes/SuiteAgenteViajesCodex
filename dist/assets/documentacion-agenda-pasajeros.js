(function () {
  'use strict';

  var model = window.PassengerAgendaStore;
  var cloud = window.SuiteCloud;
  var state = { user: null, workspace: null, store: null, passengers: [], trips: [], links: [], selectedPassengerId: null, loading: false };
  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };
  var dialog = $('#record-dialog');
  var whatsappDialog = $('#whatsapp-dialog');
  var whatsappPassengerId = null;
  var form = $('#record-form');
  var fields = $('#dialog-fields');
  var errorBox = $('#dialog-error');
  var submitButton = $('#dialog-submit');
  var pending = $('#app-alert');
  if (!pending) {
    pending = document.createElement('p');
    pending.id = 'app-alert';
    pending.className = 'app-alert';
    pending.setAttribute('role', 'status');
    pending.setAttribute('aria-live', 'polite');
    pending.hidden = true;
    var sessionBar = $('.session-bar');
    if (sessionBar) sessionBar.insertAdjacentElement('afterend', pending);
  }
  var activeDialog = null;
  var formDirty = false;
  var today = function () {
    var date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  };

  function setStatus(message, kind) {
    pending.textContent = message || '';
    pending.className = 'app-alert' + (kind ? ' app-alert--' + kind : '');
    pending.hidden = !message;
  }
  function show(name) {
    $$('[data-panel-content]').forEach(function (panel) { panel.hidden = panel.getAttribute('data-panel-content') !== name; });
    $$('[data-panel]').forEach(function (item) {
      var active = item.getAttribute('data-panel') === name;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    var titles = { dashboard: 'Documentacion y Agenda de Pasajeros', passengers: 'Pasajeros', trips: 'Viajes', deliveries: 'Entregas', communications: 'Comunicaciones', completed: 'Viajes finalizados', settings: 'Configuración' };
    document.title = titles[name] + ' | Documentacion y Agenda de Pasajeros';
  }
  function byId(array, id) { return array.find(function (item) { return String(item.id) === String(id); }); }
  function passengerTrips(passengerId) {
    var tripIds = new Set(state.links.filter(function (link) { return String(link.passenger_id) === String(passengerId); }).map(function (link) { return String(link.trip_id); }));
    return state.trips.filter(function (trip) { return tripIds.has(String(trip.id)); });
  }
  function tripPassengers(tripId) {
    var passengerIds = new Set(state.links.filter(function (link) { return String(link.trip_id) === String(tripId); }).map(function (link) { return String(link.passenger_id); }));
    return state.passengers.filter(function (passenger) { return passengerIds.has(String(passenger.id)); });
  }
  function passengerName(passenger) { return [passenger.first_name, passenger.last_name].filter(Boolean).join(' '); }
  function dateLabel(date) {
    if (!date) return '';
    var parts = String(date).slice(0, 10).split('-');
    if (parts.length !== 3) return String(date);
    var value = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return isNaN(value.getTime()) ? String(date) : new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }).format(value);
  }
  function dateRange(trip) {
    if (trip.departure_on && trip.return_on) return dateLabel(trip.departure_on) + ' — ' + dateLabel(trip.return_on);
    if (trip.departure_on) return 'Salida: ' + dateLabel(trip.departure_on);
    if (trip.return_on) return 'Regreso: ' + dateLabel(trip.return_on);
    return 'Fechas no registradas';
  }
  function statusLabel(trip) {
    var key = model.tripStatus(trip, today());
    return { upcoming: 'Próximo', ongoing: 'En curso', completed: trip.is_historical && !trip.departure_on && !trip.return_on ? 'Histórico' : 'Finalizado', cancelled: 'Cancelado' }[key];
  }
  function statusClass(trip) { return 'status-chip status-chip--' + model.tripStatus(trip, today()); }
  function noWorkspaceMessage(error) {
    if (error && error.code === 'WORKSPACE_NOT_PROVISIONED') return error.message;
    if (error && error.code === 'MULTIPLE_WORKSPACES') return error.message;
    if (error && (error.status === 404 || /does not exist|schema cache|not found/i.test(error.message || ''))) return 'La estructura de agenda todavía no está aplicada en Supabase. No se modificó ningún dato. La migración queda pendiente de tu autorización.';
    if (cloud && typeof cloud.friendly === 'function') return cloud.friendly(error);
    return 'No pudimos cargar la agenda. Revisá tu conexión e intentá nuevamente.';
  }
  function reportSafeError(error, operation) {
    // Diagnóstico limitado a metadatos; nunca registra tokens, correo, formularios ni datos del pasajero.
    console.warn('[Documentacion y Agenda] ' + operation + ' falló', { name: error && error.name || 'Error', status: error && error.status || 0, code: error && error.code || 'UNKNOWN' });
  }
  function observeSuiteCloudLoginGate() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    var observer = new MutationObserver(function () {
      var gate = $('#suite-cloud-gate');
      if (gate && !gate.hidden && $('#cloud-login', gate)) {
        console.info('[Documentacion y Agenda] SuiteCloud mostró el formulario de acceso. No se registraron credenciales, tokens ni datos de pasajeros; el motivo de la validación no está disponible para esta subaplicación.');
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    window.setTimeout(function () { observer.disconnect(); }, 15000);
  }
  async function reloadData() {
    var result = await state.store.load();
    state.passengers = result.passengers;
    state.trips = result.trips;
    state.links = result.links;
    if (state.selectedPassengerId && !byId(state.passengers, state.selectedPassengerId)) state.selectedPassengerId = null;
    renderAll();
    if (window.PassengerDocsUI && typeof window.PassengerDocsUI.refresh === 'function') window.PassengerDocsUI.refresh({ passengers: state.passengers, trips: state.trips, links: state.links });
    if (window.PassengerCommsUI && typeof window.PassengerCommsUI.refresh === 'function') window.PassengerCommsUI.refresh({ passengers: state.passengers, trips: state.trips, links: state.links });
  }
  function renderDashboard() {
    $('#metric-passengers').textContent = String(state.passengers.length);
    $('#metric-trips').textContent = String(state.trips.length);
    var container = $('#dashboard-trips');
    container.replaceChildren();
    var upcoming = state.trips.filter(function (trip) { var s = model.tripStatus(trip, today()); return s === 'upcoming' || s === 'ongoing'; })
      .sort(function (a, b) { return String(a.departure_on || '9999').localeCompare(String(b.departure_on || '9999')); }).slice(0, 4);
    if (!upcoming.length) {
      var empty = document.createElement('div'); empty.className = 'empty';
      empty.append(makeText('span', '✈'), makeText('h3', state.trips.length ? 'No hay viajes próximos' : 'Tu agenda de viajes aparecerá acá'), makeText('p', state.trips.length ? 'Podés consultar viajes anteriores desde la sección Viajes.' : 'Agregá pasajeros y registrá sus viajes, incluso si ya ocurrieron.'));
      container.append(empty); return;
    }
    upcoming.forEach(function (trip) { container.append(tripSummary(trip)); });
  }
  function makeText(tag, value, className) {
    var element = document.createElement(tag); element.textContent = value;
    if (className) element.className = className;
    return element;
  }
  function makeButton(text, className, action, data) {
    var button = document.createElement('button'); button.type = 'button'; button.className = className || 'btn btn--secondary'; button.textContent = text;
    if (action) button.dataset.action = action;
    if (data) Object.keys(data).forEach(function (key) { button.dataset[key] = data[key]; });
    return button;
  }
  function tripSummary(trip) {
    var article = document.createElement('article'); article.className = 'trip-summary';
    var body = document.createElement('div');
    body.append(makeText('b', trip.trip_name || trip.destination), makeText('span', trip.destination + ' · ' + dateRange(trip)));
    article.append(body, makeText('span', statusLabel(trip), statusClass(trip)));
    return article;
  }
  function sortedPassengers() {
    var query = model.searchKey($('#passenger-search').value);
    var sort = $('#passenger-sort').value;
    var results = state.passengers.filter(function (person) {
      var values = [person.first_name, person.last_name, passengerName(person), person.email, person.phone, person.whatsapp];
      return !query || values.some(function (value) { return model.searchKey(value).includes(query); });
    });
    return results.sort(function (a, b) {
      if (sort === 'created') return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      if (sort === 'trips') return passengerTrips(b.id).length - passengerTrips(a.id).length || passengerName(a).localeCompare(passengerName(b), 'es');
      return String(a.last_name || '').localeCompare(String(b.last_name || ''), 'es', { sensitivity: 'base' }) || String(a.first_name || '').localeCompare(String(b.first_name || ''), 'es', { sensitivity: 'base' });
    });
  }
  function renderPassengerList() {
    var list = $('#passenger-list'); list.replaceChildren();
    var people = sortedPassengers();
    if (!people.length) {
      var empty = document.createElement('article'); empty.className = 'surface list-empty';
      empty.append(makeText('span', '♙'), makeText('h2', state.passengers.length ? 'No encontramos coincidencias' : 'La agenda todavía está vacía'), makeText('p', state.passengers.length ? 'Probá buscar por otro nombre, correo o teléfono.' : 'Podés registrar pasajeros históricos aunque no tengan documentación digital.'));
      list.append(empty); return;
    }
    people.forEach(function (person) {
      var card = document.createElement('article'); card.className = 'passenger-row' + (String(person.id) === String(state.selectedPassengerId) ? ' is-selected' : '');
      var open = makeButton('', 'passenger-open', 'open-passenger', { id: person.id });
      open.append(makeText('b', passengerName(person)), makeText('span', person.email || person.phone || person.whatsapp || 'Sin datos de contacto'), makeText('small', passengerTrips(person.id).length + (passengerTrips(person.id).length === 1 ? ' viaje' : ' viajes')));
      card.append(open, makeButton('›', 'row-arrow', 'open-passenger', { id: person.id }));
      list.append(card);
    });
  }
  function renderPassengerDetail() {
    var detail = $('#passenger-detail'); detail.replaceChildren();
    var person = byId(state.passengers, state.selectedPassengerId);
    if (!person) {
      var empty = document.createElement('div'); empty.className = 'empty';
      empty.append(makeText('span', '♙'), makeText('h3', 'Elegí un pasajero'), makeText('p', 'Su información y sus viajes aparecerán acá.'));
      detail.append(empty); return;
    }
    var head = document.createElement('div'); head.className = 'detail-head';
    var title = document.createElement('div'); title.append(makeText('p', 'FICHA DEL PASAJERO', 'eyebrow'), makeText('h2', passengerName(person)), makeText('span', passengerTrips(person.id).length + (passengerTrips(person.id).length === 1 ? ' viaje registrado' : ' viajes registrados'), 'detail-count'));
    var actions = document.createElement('div'); actions.className = 'action-wrap';
    actions.append(makeButton('Abrir WhatsApp', 'btn btn--whatsapp btn--small', 'open-whatsapp', { id: person.id }), makeButton('Editar datos', 'btn btn--secondary btn--small', 'edit-passenger', { id: person.id }), makeButton('Eliminar', 'btn btn--danger btn--small', 'delete-passenger', { id: person.id }));
    head.append(title, actions); detail.append(head);
    var contacts = document.createElement('dl'); contacts.className = 'contact-grid';
    [['Correo', person.email || 'No registrado'], ['Teléfono', person.phone || 'No registrado'], ['WhatsApp', person.whatsapp || person.phone || 'No registrado'], ['Creado', dateLabel((person.created_at || '').slice(0, 10)) || 'Fecha no disponible']].forEach(function (item) {
      var box = document.createElement('div'); box.append(makeText('dt', item[0]), makeText('dd', item[1])); contacts.append(box);
    });
    detail.append(contacts);
    var notes = document.createElement('div'); notes.className = 'notes-block'; notes.append(makeText('b', 'Observaciones'), makeText('p', person.personal_notes || 'Sin observaciones.'));
    detail.append(notes);
    var tripHead = document.createElement('div'); tripHead.className = 'surface-head detail-trips-head'; tripHead.append(makeText('h3', 'Historial de viajes'), makeButton('＋ Agregar viaje', 'text-button', 'add-trip-for-passenger', { id: person.id }));
    detail.append(tripHead);
    var trips = passengerTrips(person.id).sort(function (a, b) { return String(b.departure_on || b.created_at || '').localeCompare(String(a.departure_on || a.created_at || '')); });
    if (!trips.length) detail.append(makeText('p', 'Este pasajero todavía no tiene viajes registrados.', 'muted-note'));
    trips.forEach(function (trip) { detail.append(tripCard(trip, false)); });
    detail.append(makeText('p', 'Las entregas de documentación vinculadas estarán disponibles en una etapa posterior.', 'future-note'));
  }
  function openWhatsAppDialog(id) {
    var person = byId(state.passengers, id); if (!person) return;
    whatsappPassengerId = id;
    var number = person.whatsapp || person.phone || '';
    var digits = model.normalizeWhatsAppNumber(number);
    $('#whatsapp-number-label').textContent = digits ? 'Se usará el número internacional +' + digits + (person.whatsapp ? ' (WhatsApp)' : ' (teléfono principal)') : 'No hay un número válido registrado para abrir WhatsApp.';
    $('#whatsapp-warning').textContent = digits ? '' : 'Agregá un número con código de país en los datos del pasajero. Para números locales, se interpretan como móviles de Argentina (+54 9).';
    $('#whatsapp-warning').hidden = !!digits;
    $('#whatsapp-message').value = model.whatsappMessage(person);
    $('#whatsapp-preview').textContent = $('#whatsapp-message').value;
    updateWhatsAppLink();
    $('#whatsapp-correct').hidden = !!digits;
    whatsappDialog.showModal();
  }
  function updateWhatsAppLink() {
    var person = byId(state.passengers, whatsappPassengerId); if (!person) return;
    var url = model.whatsappUrl(person.whatsapp || person.phone, $('#whatsapp-message').value);
    var link = $('#whatsapp-open');
    if (!url) {
      link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); link.tabIndex = -1;
      $('#whatsapp-warning').textContent = 'El número ya no parece válido. Corregilo en los datos del pasajero.'; $('#whatsapp-warning').hidden = false; $('#whatsapp-correct').hidden = false;
      return;
    }
    link.href = url; link.setAttribute('aria-disabled', 'false'); link.tabIndex = 0;
  }
  function blockInvalidWhatsApp(event) {
    if (this.getAttribute('aria-disabled') === 'true') event.preventDefault();
  }
  function renderTrips() {
    var list = $('#trip-list'); list.replaceChildren();
    var query = model.searchKey($('#trip-search').value);
    var sort = $('#trip-sort').value;
    var trips = state.trips.filter(function (trip) {
      var people = tripPassengers(trip.id).map(passengerName);
      return !query || [trip.destination, trip.trip_name].concat(people).some(function (value) { return model.searchKey(value).includes(query); });
    });
    trips.sort(function (a, b) {
      var aDate = a.departure_on || a.created_at || '';
      var bDate = b.departure_on || b.created_at || '';
      return sort === 'recent' ? bDate.localeCompare(aDate) : aDate.localeCompare(bDate);
    });
    if (!trips.length) {
      var empty = document.createElement('article'); empty.className = 'surface list-empty';
      empty.append(makeText('span', '✈'), makeText('h2', state.trips.length ? 'No encontramos viajes' : 'Todavía no hay viajes'), makeText('p', state.trips.length ? 'Probá buscar por otro destino, título o pasajero.' : 'Registrá viajes anteriores o próximos y asociá a todos sus integrantes.'));
      list.append(empty); return;
    }
    trips.forEach(function (trip) { list.append(tripCard(trip, true)); });
  }
  function tripCard(trip, roomy) {
    var card = document.createElement('article'); card.className = 'trip-card' + (roomy ? ' trip-card--roomy' : '');
    var top = document.createElement('div'); top.className = 'trip-card-top';
    var info = document.createElement('div'); info.append(makeText('h3', trip.trip_name || trip.destination), makeText('p', trip.destination + ' · ' + dateRange(trip)));
    top.append(info, makeText('span', statusLabel(trip), statusClass(trip))); card.append(top);
    var people = tripPassengers(trip.id);
    var names = makeText('p', people.length ? 'Pasajeros: ' + people.map(passengerName).join(', ') : 'Sin pasajeros asociados', 'trip-people');
    card.append(names);
    if (trip.notes) card.append(makeText('p', trip.notes, 'trip-notes'));
    var actions = document.createElement('div'); actions.className = 'action-wrap';
    actions.append(makeButton('Editar viaje', 'btn btn--secondary btn--small', 'edit-trip', { id: trip.id }), makeButton('Eliminar', 'btn btn--danger btn--small', 'delete-trip', { id: trip.id }), makeButton('Documentación', 'btn btn--primary btn--small', 'manage-docs', { tripId: trip.id }), makeButton('Reservas aéreas', 'btn btn--secondary btn--small', 'manage-air', { tripId: trip.id }));
    card.append(actions); return card;
  }
  function renderAll() {
    renderDashboard(); renderPassengerList(); renderPassengerDetail(); renderTrips();
  }
  function field(label, name, type, hint) {
    var wrap = document.createElement('label'); wrap.className = 'form-field';
    wrap.append(makeText('span', label));
    var control = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    control.name = name;
    if (type !== 'textarea') control.type = type || 'text';
    if (name === 'first_name' || name === 'last_name' || name === 'destination') control.required = true;
    wrap.append(control);
    if (hint) wrap.append(makeText('small', hint));
    return wrap;
  }
  function selectField(label, name, options) {
    var wrap = document.createElement('label'); wrap.className = 'form-field'; wrap.append(makeText('span', label));
    var select = document.createElement('select'); select.name = name;
    options.forEach(function (option) { var item = document.createElement('option'); item.value = option[0]; item.textContent = option[1]; select.append(item); });
    wrap.append(select); return wrap;
  }
  function inputValue(name, value) { var control = $('[name="' + name + '"]', form); if (control) control.value = value == null ? '' : value; }
  function openDialog(title, eyebrow, mode, record) {
    activeDialog = { type: mode, id: record && record.id || null, record: record || null };
    $('#dialog-title').textContent = title;
    $('#dialog-eyebrow').textContent = eyebrow;
    fields.replaceChildren(); errorBox.hidden = true; errorBox.textContent = '';
    submitButton.disabled = false; submitButton.textContent = record ? 'Guardar cambios' : 'Guardar';
    formDirty = false; form.dataset.dirty = 'false';
    if (mode === 'passenger') {
      fields.className = 'dialog-fields dialog-fields--two';
      fields.append(field('Nombre *', 'first_name', 'text'), field('Apellido *', 'last_name', 'text'), field('Correo electrónico', 'email', 'email'), field('Teléfono', 'phone', 'tel'), field('WhatsApp (si es distinto)', 'whatsapp', 'tel'), field('Observaciones personales', 'personal_notes', 'textarea', 'Evitá incluir información sensible que no sea necesaria.'));
      if (record) ['first_name','last_name','email','phone','whatsapp','personal_notes'].forEach(function (key) { inputValue(key, record[key]); });
    } else {
      fields.className = 'dialog-fields dialog-fields--two';
      fields.append(field('Nombre del viaje (opcional)', 'trip_name', 'text'), field('Destino *', 'destination', 'text'), field('Fecha de salida', 'departure_on', 'date'), field('Fecha de regreso', 'return_on', 'date'), selectField('Estado', 'status', [['planning','Según fechas'],['completed','Finalizado / histórico'],['cancelled','Cancelado']]), field('Observaciones', 'notes', 'textarea'));
      var memberModel = typeof model.tripEditorPeople === 'function' ? model.tripEditorPeople(record, state.passengers, state.links) : { passengers: record ? tripPassengers(record.id) : state.passengers.slice().sort(function (a, b) { return passengerName(a).localeCompare(passengerName(b), 'es'); }) };
      if (record) {
        var memberTitle = makeText('span', 'Pasajeros asociados'); memberTitle.className = 'field-title'; fields.append(memberTitle);
        var readonlyMembers = document.createElement('div'); readonlyMembers.id = 'trip-passenger-readonly'; readonlyMembers.className = 'trip-members-readonly'; readonlyMembers.setAttribute('aria-readonly', 'true');
        if (!memberModel.passengers.length) readonlyMembers.append(makeText('p', 'Este viaje no tiene pasajeros asociados.', 'muted-note'));
        memberModel.passengers.forEach(function (person) { readonlyMembers.append(makeText('span', passengerName(person), 'trip-member-readonly')); });
        fields.append(readonlyMembers);
      } else {
        var memberLabel = makeText('span', 'Pasajeros asociados *'); memberLabel.className = 'field-title'; fields.append(memberLabel);
        var group = document.createElement('div'); group.id = 'trip-passenger-choices'; group.className = 'choice-list';
        if (!memberModel.passengers.length) group.append(makeText('p', 'Primero agregá al menos un pasajero a la agenda.', 'muted-note'));
        memberModel.passengers.forEach(function (person) {
          var label = document.createElement('label'); label.className = 'choice-item';
          var checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'passenger_ids'; checkbox.value = person.id;
          if (activeDialog.preselectedPassengerId && String(activeDialog.preselectedPassengerId) === String(person.id)) checkbox.checked = true;
          label.append(checkbox, makeText('span', passengerName(person))); group.append(label);
        });
        fields.append(group);
      }
      if (record) {
        inputValue('trip_name', record.trip_name); inputValue('destination', record.destination); inputValue('departure_on', record.departure_on); inputValue('return_on', record.return_on); inputValue('notes', record.notes);
        inputValue('status', record.status === 'cancelled' ? 'cancelled' : (record.status === 'completed' || record.is_historical ? 'completed' : 'planning'));
      }
    }
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    var first = $('input:not([type=checkbox]),textarea,select', form); if (first) first.focus();
  }
  function closeDialog(force) {
    if (!force && formDirty && !window.confirm('Hay cambios sin guardar. ¿Querés descartarlos?')) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close(); else dialog.removeAttribute('open');
    activeDialog = null; formDirty = false;
  }
  function saveRecord(event) {
    event.preventDefault(); if (!activeDialog || state.loading) return;
    var type = activeDialog.type; var record = activeDialog.record;
    var payload;
    if (type === 'passenger') {
      payload = {
        first_name: model.normalizeText(form.elements.first_name.value),
        last_name: model.normalizeText(form.elements.last_name.value),
        email: model.normalizeEmail(form.elements.email.value) || null,
        phone: model.normalizePhone(form.elements.phone.value) || null,
        whatsapp: model.normalizePhone(form.elements.whatsapp.value) || null,
        personal_notes: model.normalizeText(form.elements.personal_notes.value)
      };
      var errors = model.validatePassenger(payload);
      if (Object.keys(errors).length) { showFormError(Object.values(errors).join(' ')); return; }
    } else {
      payload = {
        trip_name: model.normalizeText(form.elements.trip_name.value),
        destination: model.normalizeText(form.elements.destination.value),
        departure_on: form.elements.departure_on.value || null,
        return_on: form.elements.return_on.value || null,
        status: form.elements.status.value,
        is_historical: form.elements.status.value === 'completed',
        notes: model.normalizeText(form.elements.notes.value)
      };
      var tripErrors = model.validateTrip(payload);
      if (Object.keys(tripErrors).length) { showFormError(Object.values(tripErrors).join(' ')); return; }
      if (!record) {
        var passengerIds = $$('input[name="passenger_ids"]:checked', form).map(function (control) { return control.value; });
        if (!passengerIds.length) { showFormError('Seleccioná al menos un pasajero para asociar el viaje.'); return; }
        return saveTrip(payload, passengerIds, null);
      }
      return saveTrip(payload, [], record);
    }
    savePassenger(payload, record);
  }
  function showFormError(message) { errorBox.textContent = message; errorBox.hidden = false; }
  async function savePassenger(payload, record) {
    submitButton.disabled = true; submitButton.textContent = 'Guardando…';
    try {
      if (record) await state.store.updatePassenger(record.id, Object.assign({}, payload, { updated_at: new Date().toISOString() })); else {
        var created = await state.store.createPassenger(payload);
        state.selectedPassengerId = created && created.id || null;
      }
      closeDialog(true); await reloadData(); setStatus('Pasajero guardado en Supabase.', 'success');
    } catch (error) { reportSafeError(error, 'guardar pasajero'); showFormError(noWorkspaceMessage(error)); }
    finally { submitButton.disabled = false; submitButton.textContent = record ? 'Guardar cambios' : 'Guardar'; }
  }
  async function saveTrip(payload, passengerIds, record) {
    submitButton.disabled = true; submitButton.textContent = 'Guardando…';
    try {
      if (record) { var details = Object.assign({}, payload, { updated_at: new Date().toISOString() }); if (typeof state.store.updateTripDetails === 'function') await state.store.updateTripDetails(record.id, details); else { var unchangedIds = state.links.filter(function (link) { return String(link.trip_id) === String(record.id); }).map(function (link) { return link.passenger_id; }); await state.store.updateTrip(record.id, details, unchangedIds, unchangedIds); } }
      else await state.store.createTrip(payload, passengerIds);
      closeDialog(true); await reloadData(); setStatus(record ? 'Viaje actualizado. Las asociaciones de pasajeros se conservaron.' : 'Viaje y pasajeros asociados guardados en Supabase.', 'success');
    } catch (error) { reportSafeError(error, 'guardar viaje'); showFormError(noWorkspaceMessage(error)); }
    finally { submitButton.disabled = false; submitButton.textContent = record ? 'Guardar cambios' : 'Guardar'; }
  }
  async function deletePassenger(id) {
    var person = byId(state.passengers, id); if (!person) return;
    var trips = passengerTrips(id);
    if (trips.length) {
      window.alert(passengerName(person) + ' está vinculado a ' + trips.length + (trips.length === 1 ? ' viaje.' : ' viajes.') + ' Para conservar el historial, quitá primero a esta persona de esos viajes desde la edición del viaje. Los viajes compartidos y sus demás integrantes se conservarán.');
      return;
    }
    if (!window.confirm('¿Eliminar a ' + passengerName(person) + ' de la agenda? Esta acción no se puede deshacer.')) return;
    try { await state.store.deletePassenger(id); if (String(state.selectedPassengerId) === String(id)) state.selectedPassengerId = null; await reloadData(); setStatus('Pasajero eliminado.', 'success'); }
    catch (error) { reportSafeError(error, 'eliminar pasajero'); setStatus(noWorkspaceMessage(error), 'error'); }
  }
  async function deleteTrip(id) {
    var trip = byId(state.trips, id); if (!trip) return;
    var name = trip.trip_name || trip.destination;
    if (!window.confirm('¿Eliminar el viaje «' + name + '» y quitar sus asociaciones? Los pasajeros permanecerán en la agenda.')) return;
    try { await state.store.deleteTrip(id); await reloadData(); setStatus('Viaje eliminado. Los pasajeros siguen en la agenda.', 'success'); }
    catch (error) { reportSafeError(error, 'eliminar viaje'); setStatus(noWorkspaceMessage(error), 'error'); }
  }
  function handleAction(event) {
    var button = event.target.closest('[data-action]'); if (!button) return;
    var id = button.dataset.id;
    if (button.dataset.action === 'open-passenger') { state.selectedPassengerId = id; renderPassengerList(); renderPassengerDetail(); }
    else if (button.dataset.action === 'open-whatsapp') openWhatsAppDialog(id);
    else if (button.dataset.action === 'edit-passenger') openDialog('Editar pasajero', 'Agenda de clientes', 'passenger', byId(state.passengers, id));
    else if (button.dataset.action === 'delete-passenger') deletePassenger(id);
    else if (button.dataset.action === 'edit-trip') { try { if (!model.openTripEditor(state.trips, id, function (title, eyebrow, trip) { openDialog(title, eyebrow, 'trip', trip); })) setStatus('No se encontró el viaje seleccionado. Actualizá la lista e intentá nuevamente.', 'error'); } catch (error) { reportSafeError(error, 'abrir formulario de viaje'); setStatus('No se pudo abrir el formulario del viaje. Actualizá la aplicación e intentá nuevamente.', 'error'); } }
    else if (button.dataset.action === 'delete-trip') deleteTrip(id);
    else if (button.dataset.action === 'add-trip-for-passenger') { openDialog('Registrar viaje', 'Historial comercial', 'trip', null); activeDialog.preselectedPassengerId = id; var checkbox = $$('input[name="passenger_ids"]', form).find(function (item) { return String(item.value) === String(id); }); if (checkbox) checkbox.checked = true; }
  }
  function attachEvents() {
    $$('[data-panel]').forEach(function (item) { item.addEventListener('click', function () { show(item.dataset.panel); if (item.dataset.panel === 'communications' && window.PassengerCommsUI) window.PassengerCommsUI.onEnter(); }); });
    $$('[data-go]').forEach(function (item) { item.addEventListener('click', function () { show(item.dataset.go); }); });
    $('#add-passenger').addEventListener('click', function () { openDialog('Agregar pasajero', 'Agenda de clientes', 'passenger', null); });
    $('#add-trip').addEventListener('click', function () { openDialog('Registrar viaje', 'Historial comercial', 'trip', null); });
    $('#passenger-search').addEventListener('input', renderPassengerList);
    $('#passenger-sort').addEventListener('change', renderPassengerList);
    $('#trip-search').addEventListener('input', renderTrips);
    $('#trip-sort').addEventListener('change', renderTrips);
    $('#passenger-list').addEventListener('click', handleAction);
    $('#passenger-detail').addEventListener('click', handleAction);
    $('#whatsapp-message').addEventListener('input', function () { $('#whatsapp-preview').textContent = this.value; updateWhatsAppLink(); });
    $('#whatsapp-open').addEventListener('click', blockInvalidWhatsApp);
    $('#whatsapp-correct').addEventListener('click', function () { var id = whatsappPassengerId; whatsappDialog.close(); openDialog('Editar pasajero', 'Agenda de clientes', 'passenger', byId(state.passengers, id)); });
    $$('[data-whatsapp-close]').forEach(function (button) { button.addEventListener('click', function () { whatsappDialog.close(); }); });
    whatsappDialog.addEventListener('cancel', function () { whatsappPassengerId = null; });
    whatsappDialog.addEventListener('close', function () { whatsappPassengerId = null; });
    $('#trip-list').addEventListener('click', handleAction);
    form.addEventListener('input', function () { formDirty = true; form.dataset.dirty = 'true'; });
    form.addEventListener('change', function () { formDirty = true; form.dataset.dirty = 'true'; });
    form.addEventListener('submit', saveRecord);
    $$('[data-dialog-close]').forEach(function (button) { button.addEventListener('click', function () { closeDialog(false); }); });
    dialog.addEventListener('cancel', function (event) { if (formDirty && !window.confirm('Hay cambios sin guardar. ¿Querés descartarlos?')) event.preventDefault(); else { activeDialog = null; formDirty = false; } });
  }
  async function boot(user) {
    state.user = user;
    $('#session-label').textContent = user && user.email ? user.email : 'Administrador autenticado';
    state.loading = true;
    try {
      state.workspace = await model.resolveWorkspace(cloud, user && user.id);
      state.store = model.create(cloud, state.workspace.id);
      await reloadData();
      if (window.PassengerDocsUI && typeof window.PassengerDocsUI.init === 'function') await window.PassengerDocsUI.init({ cloud: cloud, workspace: state.workspace, passengers: state.passengers, trips: state.trips, links: state.links, setStatus: setStatus });
      if (window.PassengerCommsUI && typeof window.PassengerCommsUI.init === 'function') window.PassengerCommsUI.init({ cloud: cloud, workspace: state.workspace, passengers: state.passengers, trips: state.trips, links: state.links });
      setStatus('Conectado al espacio de trabajo ' + state.workspace.name + '.', 'success');
    } catch (error) {
      reportSafeError(error, 'inicializar agenda');
      setStatus(noWorkspaceMessage(error), 'error');
      $$('.nav-item').forEach(function (item) { item.disabled = true; });
      $('#add-passenger').disabled = true;
      $('#add-trip').disabled = true;
      $('#session-label').textContent = 'Cuenta autenticada · agenda pendiente de activación';
    } finally { state.loading = false; }
  }

  attachEvents();
  if (window.PassengerAgendaStore && cloud && typeof cloud.withSession === 'function') {
    observeSuiteCloudLoginGate();
    cloud.withSession(boot).catch(function (error) { reportSafeError(error, 'sesión SuiteCloud'); });
  }
})();
