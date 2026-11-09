(function () {
  'use strict';
  var database = {
    tresor_workspace_members: [{ workspace_id: 'mock-workspace', user_id: 'mock-user', role: 'admin', is_active: true }],
    tresor_workspaces: [{ id: 'mock-workspace', name: 'Tresor Travel' }],
    tresor_passengers: [], tresor_trips: [], tresor_trip_passengers: [],
    tresor_deliveries: [], tresor_documents: [], tresor_air_reservations: [],
    tresor_air_reservation_passengers: [], tresor_followups: []
  };
  var nextId = 0;
  function parseEq(value) { return value && value.indexOf('eq.') === 0 ? value.slice(3) : null; }
  function matches(row, filters) {
    return Object.keys(filters || {}).every(function (key) {
      if (key === 'select' || key === 'order') return true;
      var expected = parseEq(filters[key]);
      return expected === null || String(row[key]) === expected;
    });
  }
  window.__passengerMockDb = database;
  window.SuiteCloud = {
    currentUser: function () { return { id: 'mock-user', email: 'javier@example.invalid' }; },
    friendly: function () { return 'Error simulado del servicio local.'; },
    async withSession(boot) { return boot({ id: 'mock-user', email: 'javier@example.invalid' }); },
    async selectAll(table, filters) { return (database[table] || []).filter(function (row) { return matches(row, filters); }).map(function (row) { return Object.assign({}, row); }); },
    async api(path, options) {
      options = options || {};
      var url = new URL(path, location.origin);
      var table = url.pathname.split('/').pop();
      var filters = Object.fromEntries(url.searchParams.entries());
      var method = options.method || 'GET';
      var body = options.body ? JSON.parse(options.body) : null;
      var list = database[table] || (database[table] = []);
      if (method === 'POST') {
        var incoming = Array.isArray(body) ? body : [body];
        var created = incoming.map(function (item) {
          var row = Object.assign({ id: 'mock-' + (++nextId), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, item);
          list.push(row); return Object.assign({}, row);
        });
        return { data: created, response: { headers: { get: function () { return null; } } } };
      }
      if (method === 'PATCH') {
        var changed = list.filter(function (row) { return matches(row, filters); }).map(function (row) { Object.assign(row, body); return Object.assign({}, row); });
        return { data: changed, response: { headers: { get: function () { return null; } } } };
      }
      if (method === 'DELETE') {
        database[table] = list.filter(function (row) { return !matches(row, filters); });
        return { data: null, response: { headers: { get: function () { return null; } } } };
      }
      return { data: list.filter(function (row) { return matches(row, filters); }), response: { headers: { get: function () { return null; } } } };
    }
  };
})();
