/* Supabase Auth + REST + Storage for the three private Suite applications. */
window.SuiteCloud = (() => {
  'use strict';
  const config = window.SUITE_SUPABASE_CONFIG || {};
  const baseUrl = String(config.url || '').replace(/\/$/, '');
  const apiKey = String(config.publishableKey || '');
  const SESSION_KEY = 'suite-cloud-auth-session-v1';
  const MEDIA_DB = 'suite-flyers-media-v1';
  const MEDIA_STORE = 'blobs';
  const BUCKET = 'suite-flyer-images';
  const MIGRATION_PREFIX = 'suite-cloud-migrated-v1-';
  const LOCAL_KEYS = [
    'suite-flyers-promotions-v1', 'suite-flyers-whatsapp-v1',
    'suite-flyers-settings-v1', 'suite-flyers-library-v1', 'suite-agenda'
  ];
  let session = null;
  let currentUser = null;
  let activeResolve = null;
  let gate = null;
  let gateMessage = null;
  let migrationBackupReady = false;
  const imageCache = new Map();

  class CloudError extends Error {
    constructor(message, status = 0, code = '') { super(message); this.name = 'CloudError'; this.status = status; this.code = code; }
  }

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveSession(value) {
    if(value && !value.expires_at && Number(value.expires_in)) value.expires_at=Math.floor(Date.now()/1000)+Number(value.expires_in);
    session = value;
    try { if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value)); else localStorage.removeItem(SESSION_KEY); }
    catch (_) { throw new CloudError('No se pudo guardar la sesión segura en este navegador.'); }
  }
  function ensureConfig() {
    if (!baseUrl || !apiKey) throw new CloudError('Falta configurar la URL y la clave pública de Supabase.');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(baseUrl)) throw new CloudError('La URL de Supabase no tiene el formato esperado.');
    if (!apiKey.startsWith('sb_publishable_') && !apiKey.startsWith('eyJ')) throw new CloudError('La clave configurada no parece una clave pública anon/publishable.');
  }
  function parseResponse(text) { if (!text) return null; try { return JSON.parse(text); } catch (_) { return text; } }
  function errorFrom(response, body) {
    const message = body?.msg || body?.message || body?.error_description || body?.error || `Supabase respondió HTTP ${response.status}.`;
    return new CloudError(String(message), response.status, body?.code || '');
  }
  async function authRequest(path, body) {
    ensureConfig();
    const response = await fetch(`${baseUrl}/auth/v1/${path}`, {
      method: 'POST', headers: { apikey: apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = parseResponse(await response.text());
    if (!response.ok) throw errorFrom(response, data);
    return data;
  }
  async function refreshSession() {
    if (!session?.refresh_token) throw new CloudError('La sesión venció. Iniciá sesión nuevamente.', 401);
    try {
      const next = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      saveSession(next);
      return next;
    } catch (error) {
      saveSession(null);
      currentUser = null;
      throw new CloudError('La sesión venció. Iniciá sesión nuevamente.', error.status, error.code);
    }
  }
  async function validSession() {
    session ||= readSession();
    if (!session?.access_token) return null;
    if (Number(session.expires_at || 0) <= Math.floor(Date.now() / 1000) + 45) await refreshSession();
    const response = await fetch(`${baseUrl}/auth/v1/user`, { headers: { apikey: apiKey, Authorization: `Bearer ${session.access_token}` } });
    const data = parseResponse(await response.text());
    if (response.status === 401) { await refreshSession(); return validSession(); }
    if (!response.ok) throw errorFrom(response, data);
    currentUser = data;
    return data;
  }
  async function api(path, options = {}, retried = false) {
    ensureConfig();
    session ||= readSession();
    if (!session?.access_token) throw new CloudError('Iniciá sesión para acceder a los datos remotos.', 401);
    if (Number(session.expires_at || 0) <= Math.floor(Date.now() / 1000) + 45) await refreshSession();
    const headers = new Headers(options.headers || {});
    headers.set('apikey', apiKey);
    headers.set('Authorization', `Bearer ${session.access_token}`);
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const body = parseResponse(await response.text());
    if (response.status === 401 && !retried) { await refreshSession(); return api(path, options, true); }
    if (!response.ok) throw errorFrom(response, body);
    return { data: body, response };
  }
  function encodePath(path) { return String(path).split('/').map(encodeURIComponent).join('/'); }
  function queryPath(table, params = {}) {
    const query = new URLSearchParams({ select: '*', ...params });
    return `/rest/v1/${encodeURIComponent(table)}?${query}`;
  }
  async function selectAll(table, params = {}, columns = '*') {
    const rows = [];
    for (let start = 0; ; start += 1000) {
      const query = new URLSearchParams({ select: columns, ...params });
      const { data, response } = await api(`/rest/v1/${encodeURIComponent(table)}?${query}`, { headers: { Range: `${start}-${start + 999}`, Prefer:'count=exact' } });
      if (Array.isArray(data)) rows.push(...data);
      const contentRange = response.headers.get('content-range') || '';
      if (!Array.isArray(data) || data.length < 1000 || contentRange.endsWith('/*')) break;
    }
    return rows;
  }
  async function insertIgnore(table, rows, conflict) {
    if (!rows.length) return;
    const params = new URLSearchParams({ on_conflict: conflict });
    for (let i = 0; i < rows.length; i += 100) {
      await api(`/rest/v1/${encodeURIComponent(table)}?${params}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(rows.slice(i, i + 100))
      });
    }
  }
  async function upsert(table, row, conflict) {
    const params = new URLSearchParams({ on_conflict: conflict });
    const values=Array.isArray(row)?row:[row];
    for(let i=0;i<values.length;i+=100) await api(`/rest/v1/${encodeURIComponent(table)}?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(values.slice(i,i+100))
    });
  }
  async function deleteOwnedMissing(table, keepIds) {
    const keep=new Set(keepIds.map(String)), rows=await selectAll(table,{owner_id:eq(currentUser.id)},'id');
    for(const row of rows) if(!keep.has(String(row.id))) await api(`/rest/v1/${encodeURIComponent(table)}?owner_id=${encodeURIComponent(eq(currentUser.id))}&id=${encodeURIComponent(eq(row.id))}`,{method:'DELETE'});
  }
  function eq(value) { return `eq.${String(value)}`; }
  function stableJson(value) { if(Array.isArray(value)) return value.map(stableJson); if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableJson(value[key])])); return value; }
  function sameJson(left,right) { return JSON.stringify(stableJson(left))===JSON.stringify(stableJson(right)); }
  function cleanFileName(value) { return String(value || 'imagen').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'imagen'; }
  function objectPath(userId, id, name) { return `${userId}/${cleanFileName(id)}/${cleanFileName(name)}`; }
  async function uploadObject(path, blob, upsertExisting = true) {
    const response = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
      method: 'POST', headers: { apikey: apiKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': String(upsertExisting) }, body: blob
    });
    const result = parseResponse(await response.text());
    if (!response.ok) {
      if (!upsertExisting && (response.status === 409 || result?.statusCode === '409')) return false;
      throw errorFrom(response, result);
    }
    return true;
  }
  async function downloadObject(path) {
    const response = await fetch(`${baseUrl}/storage/v1/object/authenticated/${BUCKET}/${encodePath(path)}`, {
      headers: { apikey: apiKey, Authorization: `Bearer ${session.access_token}` }
    });
    if (!response.ok) throw errorFrom(response, parseResponse(await response.text()));
    return response.blob();
  }
  async function deleteObject(path) {
    await api(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [path] }) });
  }
  function showFatal(error) {
    ensureGate();
    gate.innerHTML = `<section class="cloud-card"><div class="cloud-mark">T</div><p class="cloud-eyebrow">Suite del Agente</p><h1>No se pudo conectar</h1><p class="cloud-copy"></p><div class="cloud-actions"><button type="button" class="cloud-button" data-cloud-retry>Reintentar</button><button type="button" class="cloud-button cloud-button--light" data-cloud-logout>Cerrar sesión</button></div></section>`;
    gate.querySelector('.cloud-copy').textContent = friendly(error);
    gate.querySelector('[data-cloud-retry]').onclick = () => location.reload();
    gate.querySelector('[data-cloud-logout]').onclick = () => { saveSession(null); currentUser=null; location.reload(); };
    gate.hidden = false;
  }
  function friendly(error) {
    const message = String(error?.message || error || 'Error de conexión.');
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'No se pudo llegar a Supabase. Revisá internet y la URL configurada. Verificá el estado remoto antes de reintentar.';
    if (/relation .* does not exist|Could not find the table/i.test(message)) return 'Falta aplicar la migración SQL de Suite en Supabase. No se guardaron cambios.';
    return `${message} No se pudo confirmar la operación; verificá el estado remoto antes de reintentar.`;
  }
  function ensureGate() {
    if (gate) return;
    const style = document.createElement('style');
    style.textContent = `
      #suite-cloud-gate[hidden]{display:none}#suite-cloud-gate{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:20px;background:rgba(5,24,44,.66);backdrop-filter:blur(8px);overflow:auto;font-family:Inter,system-ui,-apple-system,sans-serif;color:#15243a}
      .cloud-card{width:min(100%,500px);padding:34px;background:#fff;border:1px solid #dce6ef;border-radius:24px;box-shadow:0 24px 90px #03162955}.cloud-mark{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;background:#0a315e;color:#fff;font-weight:900;font-size:23px}.cloud-eyebrow{margin:20px 0 5px;color:#1763a6;font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.cloud-card h1{margin:0 0 10px;font-size:1.6rem;color:#061b33}.cloud-copy{color:#68778b;line-height:1.55}.cloud-field{display:grid;gap:7px;margin:16px 0}.cloud-field label{font-size:.85rem;font-weight:750}.cloud-field input{width:100%;padding:12px 13px;border:1px solid #cdd9e4;border-radius:10px;font:inherit}.cloud-button{display:inline-flex;justify-content:center;align-items:center;min-height:44px;padding:0 17px;border:0;border-radius:11px;background:#0a315e;color:#fff;font:inherit;font-weight:750;cursor:pointer}.cloud-button:disabled{opacity:.45;cursor:not-allowed}.cloud-button--light{background:#edf5fb;color:#0a315e}.cloud-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.cloud-message{min-height:24px;margin:12px 0 0;color:#a0372b;font-size:.88rem}.cloud-note{padding:12px 14px;background:#f1f7fb;border-radius:11px;color:#52667a;font-size:.87rem;line-height:1.5}.cloud-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:7px max(20px,calc((100vw - 1240px)/2));border-bottom:1px solid #e2eaf1;background:#f8fbfd;font:500 .78rem Inter,system-ui,sans-serif;color:#56677a}.cloud-toolbar-status{margin-right:auto;color:#16704f}.cloud-toolbar button{padding:6px 9px;border:1px solid #d4e0e9;border-radius:8px;background:#fff;color:#0a315e;font:inherit;font-weight:700;cursor:pointer}.cloud-migration-list{margin:10px 0;padding-left:20px;color:#45586d;font-size:.9rem;line-height:1.65}.cloud-check{display:flex;align-items:flex-start;gap:9px;margin-top:15px;font-size:.9rem;line-height:1.5}.cloud-check input{margin-top:4px}.cloud-meter{padding:10px 12px;background:#fff7e8;border:1px solid #f2d49c;border-radius:10px;color:#73521a;font-size:.86rem}
      `;
    document.head.append(style);
    gate = document.createElement('div'); gate.id = 'suite-cloud-gate'; gate.hidden = true; document.body.append(gate);
  }
  function setGateMessage(text, isError = false) { if (!gateMessage) return; gateMessage.textContent = text; gateMessage.style.color = isError ? '#a0372b' : '#16704f'; }
  function renderLogin() {
    ensureGate(); gate.hidden = false;
    gate.innerHTML = `<form class="cloud-card" id="cloud-login"><div class="cloud-mark">T</div><p class="cloud-eyebrow">Suite del Agente</p><h1>Iniciar sesión</h1><p class="cloud-copy">Ingresá con la cuenta administradora habilitada en Supabase. El registro público está desactivado.</p><div class="cloud-field"><label for="cloud-email">Correo</label><input id="cloud-email" name="email" type="email" autocomplete="username" required></div><div class="cloud-field"><label for="cloud-password">Contraseña</label><input id="cloud-password" name="password" type="password" autocomplete="current-password" required></div><button class="cloud-button" type="submit">Ingresar</button><p class="cloud-message" aria-live="polite"></p></form>`;
    const form = gate.querySelector('#cloud-login'); gateMessage = form.querySelector('.cloud-message');
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button[type="submit"]'); button.disabled = true; setGateMessage('Conectando con Supabase…');
      try { const data = await authRequest('token?grant_type=password', { email: form.email.value.trim(), password: form.password.value }); form.password.value=''; saveSession(data); currentUser = data.user; await finishSession(); }
      catch (error) { setGateMessage(friendly(error), true); button.disabled = false; }
    };
  }
  function ensureToolbar() {
    if (document.querySelector('.cloud-toolbar')) return;
    const bar = document.createElement('div'); bar.className = 'cloud-toolbar';
    const header = document.querySelector('.topbar');
    if (header) header.append(bar); else document.body.prepend(bar);
    const who = document.createElement('span'); who.textContent = `Sesión: ${currentUser?.email || 'usuario autenticado'}`; bar.append(who);
    const status=document.createElement('span');status.className='cloud-toolbar-status';status.setAttribute('role','status');bar.append(status);
    const migrate = document.createElement('button'); migrate.type = 'button'; migrate.textContent = 'Respaldo / migración'; migrate.onclick = () => openMigration(true); bar.append(migrate);
    const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = 'Cerrar sesión'; logout.onclick = async () => {
      logout.disabled = true;
      try { await api('/auth/v1/logout', { method: 'POST' }); } catch (_) {}
      saveSession(null); currentUser = null; location.reload();
    }; bar.append(logout);
  }
  async function finishSession() {
    ensureGate();
    if (!currentUser) currentUser = await validSession();
    if (!currentUser) { renderLogin(); return; }
    await migrationDecision(false);
    gate.hidden = true; ensureToolbar();
    if (activeResolve) { const resolve = activeResolve; activeResolve = null; resolve(currentUser); }
  }
  function localCounts(snapshot = localSnapshot()) {
    return { promotions: snapshot.promotions.length, messages: snapshot.messages.length, images: snapshot.images.length+(snapshot.settings?.logoId&&!snapshot.images.some(item=>String(item.id)===String(snapshot.settings.logoId))?1:0), settings:Object.keys(snapshot.settings||{}).length?1:0, profitability: snapshot.profitability.reduce((n, item) => n + item.rows.length, 0), months: snapshot.profitability.length, agenda: snapshot.agenda.length };
  }
  function localSnapshot() {
    const get = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
    const promotions = get('suite-flyers-promotions-v1') || [];
    const messages = get('suite-flyers-whatsapp-v1') || [];
    const settings = get('suite-flyers-settings-v1') || {};
    const images = get('suite-flyers-library-v1') || [];
    const agenda = get('suite-agenda') || [];
    const profitability = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i), match = key?.match(/^suite-profit-(\d{4})-(\d{1,2})$/);
      if (!match) continue;
      try { profitability.push({ year: Number(match[1]), month: Number(match[2]), rows: JSON.parse(localStorage.getItem(key) || '[]') }); } catch (_) {}
    }
    profitability.sort((a,b) => a.year - b.year || a.month - b.month);
    return { promotions: Array.isArray(promotions)?promotions:[], messages:Array.isArray(messages)?messages:[], settings, images:Array.isArray(images)?images:[], agenda:Array.isArray(agenda)?agenda:[], profitability };
  }
  function openMediaDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(MEDIA_DB);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(MEDIA_STORE)) request.result.createObjectStore(MEDIA_STORE); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function allLocalBlobs() {
    const db = await openMediaDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE, 'readonly'), store = tx.objectStore(MEDIA_STORE), keyReq = store.getAllKeys();
      keyReq.onsuccess = async () => { try { const items = await Promise.all(keyReq.result.map(async id => ({ id:String(id), blob:await new Promise((res,rej)=>{const req=store.get(id);req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);}) }))); resolve(items.filter(item=>item.blob instanceof Blob)); } catch (error) { reject(error); } };
      keyReq.onerror = () => reject(keyReq.error);
    }).finally(() => db.close());
  }
  function blobAsDataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }); }
  async function blobSha256(blob) { const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()); return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''); }
  async function exportLocalBackup() {
    const snapshot = localSnapshot(), blobs = await allLocalBlobs();
    const stored = {};
    for (const key of LOCAL_KEYS) { const value = localStorage.getItem(key); if (value !== null) stored[key] = JSON.parse(value); }
    for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (/^suite-profit-\d{4}-\d{1,2}$/.test(key)) stored[key] = JSON.parse(localStorage.getItem(key) || '[]'); }
    const blobFiles = [];
    for (const item of blobs) blobFiles.push({ id:item.id, type:item.blob.type, size:item.blob.size, dataUrl:await blobAsDataUrl(item.blob) });
    const payload = { format:'suite-agent-backup-v1', createdAt:new Date().toISOString(), origin:location.origin, counts:localCounts(snapshot), localStorage:stored, indexedDB:{ database:MEDIA_DB, store:MEDIA_STORE, blobs:blobFiles } };
    let file = new Blob([JSON.stringify(payload)], {type:'application/json'}), name=`respaldo-suite-${new Date().toISOString().slice(0,10)}.json`;
    if ('CompressionStream' in window) { file = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob(); name += '.gz'; }
    const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    migrationBackupReady = true;
    return { name, counts:payload.counts, blobCount:blobFiles.length, bytes:file.size };
  }
  async function localSnapshotWithBlobs() { const data=localSnapshot(), blobs=await allLocalBlobs(); return { ...data, blobs:new Map(blobs.map(item=>[item.id,item.blob])) }; }
  function chooseImageFileName(image, blob) {
    const ext = ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'})[blob?.type || image?.type] || 'bin';
    return `${cleanFileName(image?.name || image?.id || 'imagen')}.${ext}`;
  }
  async function migrateLocalData() {
    if (!currentUser?.id) throw new CloudError('No se encontró la cuenta autenticada.');
    const local = await localSnapshotWithBlobs(), owner_id = currentUser.id;
    const imageRows = [], mediaToUpload = new Map();
    for (const image of local.images) {
      const blob = local.blobs.get(String(image.id)); if (!blob) throw new CloudError(`Falta el archivo local de “${image.name || image.id}”. No se migró el resto. Revisá el origen/navegador de los datos.`);
      const storage_path = objectPath(owner_id, image.id, chooseImageFileName(image, blob));
      mediaToUpload.set(String(image.id), { image, blob, storage_path });
      imageRows.push({ id:String(image.id), owner_id, storage_path, name:String(image.name||image.id), category:String(image.category||'Otros destinos'), destination:String(image.destination||''), content_type:blob.type||image.type||'application/octet-stream', byte_size:blob.size, metadata:image, created_at:image.createdAt||new Date().toISOString(), updated_at:image.updatedAt||null });
    }
    const logoId=local.settings?.logoId, logoBlob=logoId?local.blobs.get(String(logoId)):null;
    if (logoId && logoBlob && !imageRows.some(row=>row.id===String(logoId))) {
      const storage_path=objectPath(owner_id,logoId,chooseImageFileName({id:'logo-comercial',name:'logo-comercial'},logoBlob));
      mediaToUpload.set(String(logoId),{image:{id:logoId,name:'Logo comercial',category:'Identidad',destination:'',type:logoBlob.type,size:logoBlob.size},blob:logoBlob,storage_path});
      imageRows.push({id:String(logoId),owner_id,storage_path,name:'Logo comercial',category:'Identidad',destination:'',content_type:logoBlob.type||'application/octet-stream',byte_size:logoBlob.size,metadata:{kind:'agency-logo'},created_at:new Date().toISOString()});
    } else if (logoId && !logoBlob) throw new CloudError('No se encontró el logo local en IndexedDB. El original no se modificó.');
    for (const {blob,storage_path} of mediaToUpload.values()) {
      await uploadObject(storage_path,blob,false);
      const confirmed=await downloadObject(storage_path);
      if(confirmed.size!==blob.size||confirmed.type!==blob.type||await blobSha256(confirmed)!==await blobSha256(blob)) throw new CloudError('La verificación de una imagen no coincide con el archivo local. Los datos locales siguen intactos.');
    }
    await insertIgnore('suite_flyer_images',imageRows,'owner_id,id');
    await insertIgnore('suite_flyer_promotions',local.promotions.map(item=>({id:String(item.id),owner_id,data:item,created_at:item.createdAt||new Date().toISOString(),updated_at:item.updatedAt||item.createdAt||new Date().toISOString()})),'owner_id,id');
    await insertIgnore('suite_flyer_whatsapp_texts',local.messages.map(item=>({id:String(item.id),owner_id,destination:String(item.destination||''),body:String(item.text||''),created_at:item.createdAt||new Date().toISOString()})),'owner_id,id');
    if (Object.keys(local.settings).length) await insertIgnore('suite_flyer_settings',[{owner_id,data:local.settings,updated_at:new Date().toISOString()}],'owner_id');
    await insertIgnore('suite_profitability_months',local.profitability.map(item=>({owner_id,year:item.year,month:item.month,rows:item.rows,updated_at:new Date().toISOString()})),'owner_id,year,month');
    await insertIgnore('suite_agenda_events',local.agenda.map(item=>({id:String(item.id),owner_id,event_date:item.date,event_type:String(item.type||''),detail:String(item.detail||''),data:item,created_at:new Date().toISOString(),updated_at:new Date().toISOString()})),'owner_id,id');
    const checks = await Promise.all([
      selectAll('suite_flyer_promotions',{owner_id:eq(owner_id)},'id,data'), selectAll('suite_flyer_whatsapp_texts',{owner_id:eq(owner_id)},'id,destination,body'),
      selectAll('suite_flyer_images',{owner_id:eq(owner_id)},'id,metadata,content_type,byte_size'), selectAll('suite_profitability_months',{owner_id:eq(owner_id)},'year,month,rows'),
      selectAll('suite_agenda_events',{owner_id:eq(owner_id)},'id,data'), selectAll('suite_flyer_settings',{owner_id:eq(owner_id)},'data'),
      selectAll('suite_flyer_templates',{},'id,owner_id')
    ]);
    const checkCounts={promotions:checks[0].length,texts:checks[1].length,images:checks[2].length,profitabilityMonths:checks[3].length,agendaEvents:checks[4].length,templates:checks[6].length};
    const wanted={promotions:local.promotions.length,texts:local.messages.length,images:imageRows.length,profitabilityMonths:local.profitability.length,agendaEvents:local.agenda.length};
    const find=(rows,id)=>rows.find(row=>String(row.id)===String(id));
    const verified = local.promotions.every(item=>sameJson(find(checks[0],item.id)?.data,item)) &&
      local.messages.every(item=>{const row=find(checks[1],item.id);return row&&row.destination===String(item.destination||'')&&row.body===String(item.text||'')}) &&
      imageRows.every(item=>{const row=find(checks[2],item.id);return row&&sameJson(row.metadata,item.metadata)&&row.content_type===item.content_type&&Number(row.byte_size)===Number(item.byte_size)}) &&
      local.profitability.every(item=>{const row=checks[3].find(row=>row.year===item.year&&row.month===item.month);return row&&sameJson(row.rows,item.rows)}) &&
      local.agenda.every(item=>sameJson(find(checks[4],item.id)?.data,item)) &&
      (!Object.keys(local.settings).length||checks[5].some(row=>sameJson(row.data,local.settings))) &&
      checks[6].length>=31;
    if(!verified) throw new CloudError('La migración terminó, pero la verificación de registros no coincide. Los datos locales siguen intactos. Podés volver a ejecutar la migración.');
    localStorage.setItem(`${MIGRATION_PREFIX}${owner_id}`,JSON.stringify({at:new Date().toISOString(),counts:wanted}));
    return {counts:wanted,remoteCounts:checkCounts,verified:true};
  }
  function hasLocalData() { const c=localCounts(); return Object.values(c).some(Boolean); }
  function migrationDecision(manual) {
    if (!manual && (!hasLocalData() || localStorage.getItem(`${MIGRATION_PREFIX}${currentUser.id}`))) return Promise.resolve();
    return new Promise(resolve => {
      ensureGate(); gate.hidden=false; migrationBackupReady=false;
      const counts=localCounts();
      gate.innerHTML=`<section class="cloud-card"><div class="cloud-mark">T</div><p class="cloud-eyebrow">Respaldo local</p><h1>Migrar datos a Supabase</h1><p class="cloud-copy">Se encontraron datos del navegador. Se conservarán sin cambios en este dispositivo. Primero descargá una copia; luego podrás enviar una copia a tu cuenta autenticada.</p><ul class="cloud-migration-list"><li>${counts.promotions} promociones · ${counts.messages} textos · ${counts.images} imágenes</li><li>${counts.profitability} reservas en ${counts.months} períodos</li><li>${counts.agenda} recordatorios · ${counts.settings} configuraciones</li></ul><p class="cloud-note">La migración puede repetirse: los registros existentes no se duplican ni se sobrescriben. Para migrar imágenes debe ser el navegador y origen donde se guardaron originalmente.</p><div class="cloud-actions"><button type="button" class="cloud-button cloud-button--light" data-backup>Descargar copia local</button><button type="button" class="cloud-button" data-migrate disabled>Migrar a Supabase</button><button type="button" class="cloud-button cloud-button--light" data-skip>Continuar sin migrar</button></div><label class="cloud-check"><input type="checkbox" data-ack disabled><span>Descargué el respaldo y quiero migrar una copia de estos datos.</span></label><p class="cloud-message" aria-live="polite"></p></section>`;
      gateMessage=gate.querySelector('.cloud-message'); const backup=gate.querySelector('[data-backup]'),ack=gate.querySelector('[data-ack]'),migrate=gate.querySelector('[data-migrate]'),skip=gate.querySelector('[data-skip]');
      backup.onclick=async()=>{backup.disabled=true;try{const out=await exportLocalBackup();setGateMessage(`Respaldo descargado: ${out.name} (${out.blobCount} archivos). Podés continuar.`);ack.disabled=false;ack.checked=false;migrate.disabled=true;}catch(error){setGateMessage(friendly(error),true)}finally{backup.disabled=false}};
      ack.onchange=()=>{migrate.disabled=!ack.checked||!migrationBackupReady};
      skip.onclick=()=>{gate.hidden=true;ensureToolbar();resolve()};
      migrate.onclick=async()=>{migrate.disabled=true;skip.disabled=true;backup.disabled=true;setGateMessage('Subiendo y verificando una copia…');try{const result=await migrateLocalData();localStorage.setItem(`${MIGRATION_PREFIX}${currentUser.id}`,JSON.stringify({at:new Date().toISOString(),counts:result.counts}));setGateMessage(`Migración verificada. ${result.counts.promotions} promociones, ${result.counts.images} imágenes y ${result.counts.agendaEvents} recordatorios, entre los registros comprobados.`);setTimeout(()=>{gate.hidden=true;ensureToolbar();resolve()},900)}catch(error){setGateMessage(friendly(error),true);migrate.disabled=!ack.checked;skip.disabled=false;backup.disabled=false}};
    });
  }
  async function openMigration(manual) {
    if (!currentUser) return;
    if (!hasLocalData()) { const status=document.querySelector('.cloud-toolbar-status');if(status)status.textContent='No hay datos locales para migrar en este navegador y origen.';return; }
    await migrationDecision(true);
  }
  function withSession(boot) {
    ensureGate();
    return new Promise((resolve, reject) => {
      activeResolve = async user => { try { await boot(user); resolve(user); } catch (error) { showFatal(error); reject(error); } };
      (async()=>{
        try {
          ensureConfig(); session=readSession();
          if(session){try{currentUser=await validSession()}catch(_){saveSession(null)}}
          if(currentUser) await finishSession(); else renderLogin();
        } catch(error) { showFatal(error); reject(error); }
      })();
    });
  }
  async function signOut() { try { await api('/auth/v1/logout',{method:'POST'}); } catch (_) {} saveSession(null); currentUser=null; location.reload(); }
  async function loadFlyers() {
    const owner_id=currentUser.id;
    const [promos,texts,images,settings,templates]=await Promise.all([
      selectAll('suite_flyer_promotions',{owner_id:eq(owner_id)}),selectAll('suite_flyer_whatsapp_texts',{owner_id:eq(owner_id)}),
      selectAll('suite_flyer_images',{owner_id:eq(owner_id)}),selectAll('suite_flyer_settings',{owner_id:eq(owner_id)}),
      selectAll('suite_flyer_templates',{},'id,category,destination,style,metadata,owner_id')
    ]);
    return {promotions:promos.map(row=>row.data),texts:texts.map(row=>({id:row.id,destination:row.destination,text:row.body,createdAt:row.created_at})),images:images.map(row=>({...row.metadata,id:row.id,name:row.name,category:row.category,destination:row.destination,type:row.content_type,size:row.byte_size,createdAt:row.created_at,updatedAt:row.updated_at,storagePath:row.storage_path})),settings:settings[0]?.data||{},templates:templates.map(row=>({id:row.id,category:row.category,destination:row.destination,style:row.style,...row.metadata}))};
  }
  async function saveFlyerKey(key,value) {
    const owner_id=currentUser.id;
    if(key==='suite-flyers-settings-v1') return upsert('suite_flyer_settings',{owner_id,data:value,updated_at:new Date().toISOString()},'owner_id');
    if(key==='suite-flyers-library-v1') {
      const rows=value.map(item=>{const storage_path=item.storagePath||objectPath(owner_id,item.id,chooseImageFileName(item,{type:item.type}));return {id:String(item.id),owner_id,storage_path,name:item.name||item.id,category:item.category||'Otros destinos',destination:item.destination||'',content_type:item.type||'application/octet-stream',byte_size:item.size||0,metadata:item,created_at:item.createdAt||new Date().toISOString(),updated_at:item.updatedAt||null}});
      await upsert('suite_flyer_images',rows,'owner_id,id'); return;
    }
    throw new CloudError('Colección de Flyers no reconocida.');
  }
  async function savePromotion(item) { const now=new Date().toISOString(); return upsert('suite_flyer_promotions',{id:String(item.id),owner_id:currentUser.id,data:item,created_at:item.createdAt||now,updated_at:item.updatedAt||now},'owner_id,id'); }
  async function deletePromotion(id) { await api(`/rest/v1/suite_flyer_promotions?owner_id=${encodeURIComponent(eq(currentUser.id))}&id=${encodeURIComponent(eq(id))}`,{method:'DELETE'}); }
  async function saveWhatsappText(item) { return upsert('suite_flyer_whatsapp_texts',{id:String(item.id),owner_id:currentUser.id,destination:String(item.destination||''),body:String(item.text||''),created_at:item.createdAt||new Date().toISOString()},'owner_id,id'); }
  async function deleteWhatsappText(id) { await api(`/rest/v1/suite_flyer_whatsapp_texts?owner_id=${encodeURIComponent(eq(currentUser.id))}&id=${encodeURIComponent(eq(id))}`,{method:'DELETE'}); }
  async function getFlyerImage(id) {
    if(imageCache.has(String(id))) return imageCache.get(String(id));
    const rows=await selectAll('suite_flyer_images',{owner_id:eq(currentUser.id),id:eq(id)},'storage_path');
    if(!rows.length) return null;
    const blob=await downloadObject(rows[0].storage_path);imageCache.set(String(id),blob);return blob;
  }
  async function putFlyerImage(id,blob,metadata={}) {
    const old=(await selectAll('suite_flyer_images',{owner_id:eq(currentUser.id),id:eq(id)},'storage_path'))[0];
    const path=old?.storage_path||objectPath(currentUser.id,id,chooseImageFileName({id,name:metadata.name||id},blob));
    await uploadObject(path,blob,true);
    const row={id:String(id),owner_id:currentUser.id,storage_path:path,name:metadata.name||id,category:metadata.category||'Otros destinos',destination:metadata.destination||'',content_type:blob.type||'application/octet-stream',byte_size:blob.size,metadata,updated_at:new Date().toISOString()};
    await api('/rest/v1/suite_flyer_images?on_conflict=owner_id%2Cid',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(row)});
    imageCache.set(String(id),blob);
  }
  async function removeFlyerImage(id) {
    const row=(await selectAll('suite_flyer_images',{owner_id:eq(currentUser.id),id:eq(id)},'storage_path'))[0];
    if(row) await deleteObject(row.storage_path);
    await api(`/rest/v1/suite_flyer_images?owner_id=${encodeURIComponent(eq(currentUser.id))}&id=${encodeURIComponent(eq(id))}`,{method:'DELETE'});
    imageCache.delete(String(id));
  }
  async function loadProfitability(year,month) {
    const rows=await selectAll('suite_profitability_months',{owner_id:eq(currentUser.id),year:eq(year),month:eq(month)},'rows'); return rows[0]?.rows||[];
  }
  async function saveProfitability(year,month,rows) { return upsert('suite_profitability_months',{owner_id:currentUser.id,year:Number(year),month:Number(month),rows,updated_at:new Date().toISOString()},'owner_id,year,month'); }
  async function loadAgenda() { return (await selectAll('suite_agenda_events',{owner_id:eq(currentUser.id)})).map(row=>row.data||{id:row.id,date:row.event_date,type:row.event_type,detail:row.detail}); }
  async function saveAgendaEvent(item) { return upsert('suite_agenda_events',{id:String(item.id),owner_id:currentUser.id,event_date:item.date,event_type:item.type,detail:item.detail||'',data:item,updated_at:new Date().toISOString()},'owner_id,id'); }
  async function deleteAgendaEvent(id) { await api(`/rest/v1/suite_agenda_events?owner_id=${encodeURIComponent(eq(currentUser.id))}&id=${encodeURIComponent(eq(id))}`,{method:'DELETE'}); }

  return { withSession, api, selectAll, insertIgnore, upsert, currentUser:()=>currentUser, localSnapshot, localCounts, exportLocalBackup, migrateLocalData, loadFlyers, saveFlyerKey, savePromotion, deletePromotion, saveWhatsappText, deleteWhatsappText, getFlyerImage, putFlyerImage, removeFlyerImage, loadProfitability, saveProfitability, loadAgenda, saveAgendaEvent, deleteAgendaEvent, friendly, showFatal, signOut };
})();
