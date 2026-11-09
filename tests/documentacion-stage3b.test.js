const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const corePath=pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/portal-core.mjs')).href;
const Store=require('../assets/documentacion-agenda-pasajeros-stage3b-store.js');

test('token de portal se deriva estable con HMAC y se almacena solo su hash',async()=>{
 const core=await import(corePath);const nonce=new Uint8Array(32).fill(7);const key='fictitious-test-secret-key-with-at-least-32-bytes';
 const first=await core.deriveToken(key,1,'11111111-1111-4111-8111-111111111111',nonce);
 const second=await core.deriveToken(key,1,'11111111-1111-4111-8111-111111111111',nonce);
 assert.equal(first.token,second.token);assert.equal(first.tokenHash,second.tokenHash);assert.notEqual(first.token,core.toBase64Url(new Uint8Array(32).fill(8)));
 assert.equal(await core.tokenHash(first.token),first.tokenHash);assert.match(first.tokenHash,/^\\x[0-9a-f]{64}$/i);
 assert.throws(()=>core.fromBytea('invalid'));assert.throws(()=>core.fromBase64Url('bad'));
});
test('el portal no incluye documentos asociados a una persona ni rutas de Storage',async()=>{
 const core=await import(corePath);const result=core.publicPortalData({
  trip:{destination:'Destino ficticio',trip_name:'Viaje QA',departure_on:'2027-01-01',return_on:'2027-01-08',notes:'secreto'},
  passengers:[{id:'p1',first_name:'Ana',last_name:'Prueba',email:'private@example.test',phone:'123'}],
  documents:[{id:'d1',passenger_id:null,file_name:'viaje.pdf',description:'Voucher general',category:'lodging',size_bytes:10,storage_path:'private/path'},
   {id:'d2',passenger_id:'p1',file_name:'individual.pdf',description:'Documento individual',storage_path:'individual/path'}],
  reservations:[{id:'r1',airline_name:'Aerolínea QA',pnr:'PNR-QA',official_checkin_url:'javascript:alert(1)'}],
  flights:[{reservation_id:'r1',origin:'AAA',destination:'BBB',departure_at:'2027-01-01T10:00:00Z',arrival_at:'2027-01-01T12:00:00Z',internal:'omit'}],
  reservationPassengers:[{reservation_id:'r1',passenger_id:'p1'}]
 });
 assert.equal(result.documents.length,1);assert.equal(result.documents[0].id,'d1');assert.equal('storage_path' in result.documents[0],false);
 assert.equal(result.passengers[0].name,'Ana Prueba');assert.equal('email' in result.passengers[0],false);
 assert.equal(result.reservations[0].official_checkin_url,null);assert.equal(result.reservations[0].pnr,'PNR-QA');assert.equal('notes' in result.trip,false);
});
test('rutas de PDF exigen workspace, viaje, entrega y nombre UUID.pdf',async()=>{
 const core=await import(corePath);const w='11111111-1111-4111-8111-111111111111',t='22222222-2222-4222-8222-222222222222',d='33333333-3333-4333-8333-333333333333',f='44444444-4444-4444-8444-444444444444.pdf';
 assert.equal(core.validDocumentPath(`${w}/${t}/${d}/${f}`,w,t,d),true);
 assert.equal(core.validDocumentPath(`${w}/${t}/other/${f}`,w,t,d),false);
 assert.equal(core.validDocumentPath(`${w}/${t}/${d}/file.txt`,w,t,d),false);
});
test('subida ficticia valida firma PDF y registra metadatos sin eliminar original',async()=>{
 const calls=[];const cloud={api:async(url,options)=>{calls.push({url,options});if(url.startsWith('/storage/'))return{data:{}};return{data:[{id:'doc-fake',...JSON.parse(options.body)}]};},selectAll:async()=>[]};
 const workspace='11111111-1111-4111-8111-111111111111',trip='22222222-2222-4222-8222-222222222222',deliveryId='33333333-3333-4333-8333-333333333333';const store=Store.create(cloud,workspace);const blob=new Blob([new TextEncoder().encode('%PDF-fake-payload')],{type:'application/pdf'});Object.defineProperty(blob,'name',{value:'voucher-demo.pdf'});
 const result=await store.addDocument({id:deliveryId,trip_id:trip},blob,{description:'Voucher ficticio',category:'lodging',passenger_id:null});
 assert.equal(result.id,'doc-fake');assert.equal(calls.length,2);assert.match(calls[0].url,new RegExp(workspace+'/'+trip+'/'+deliveryId+'/[0-9a-f-]+\\.pdf$'));assert.equal(calls[0].options.headers['Content-Type'],'application/pdf');assert.equal(result.size_bytes,blob.size);assert.equal(result.description,'Voucher ficticio');
});
test('subida rechaza contenido no PDF o mayor a 50 MiB antes de llamar Storage',async()=>{
 let count=0;const store=Store.create({api:async()=>{count++;return{data:[]}},selectAll:async()=>[]},'workspace-fake');
 const bad=new Blob(['plain text']);Object.defineProperty(bad,'name',{value:'fake.pdf'});await assert.rejects(store.addDocument({id:'d',trip_id:'t'},bad,{description:'x',category:'other'}),/PDF válido/);assert.equal(count,0);
});
test('portal usa fragmento para el token y endpoints POST con respuestas sin caché',()=>{
 const fs=require('node:fs');const portal=fs.readFileSync(path.join(__dirname,'../assets/documentacion-pasajero.js'),'utf8');
 assert.match(portal,/location\.hash\.slice\(1\)/);assert.match(portal,/history\.replaceState\(null,'',location\.pathname\)/);
 assert.match(portal,/functions\/v1\/tresor-portal/);assert.match(portal,/referrerPolicy:'no-referrer'/);
 assert.doesNotMatch(portal,/console\.(log|info|warn|error).*token/i);
});
test('config de Edge Functions requiere validación manual del admin y permite portal público controlado',()=>{
 const fs=require('node:fs');const config=fs.readFileSync(path.join(__dirname,'../supabase/config.toml'),'utf8');
 const admin=fs.readFileSync(path.join(__dirname,'../supabase/functions/tresor-delivery-admin/index.ts'),'utf8');
 const pub=fs.readFileSync(path.join(__dirname,'../supabase/functions/tresor-portal/index.ts'),'utf8');
 assert.match(config,/\[functions\.tresor-delivery-admin\][\s\S]*?verify_jwt = false/);assert.match(admin,/auth\/v1\/user/);assert.match(admin,/role:'eq\.admin'/);
 assert.match(pub,/status:'eq\.active'/);assert.match(pub,/passenger_id:'is\.null'/);assert.match(pub,/expiresIn:120/);
 assert.doesNotMatch(admin+pub,/console\.(log|info|warn|error)/);
});


test('el mensaje con enlace portador no se persiste en texto plano', () => {
 const fs=require('node:fs');const ui=fs.readFileSync(path.join(__dirname,'../assets/documentacion-agenda-pasajeros-stage3b.js'),'utf8');
 const store=fs.readFileSync(path.join(__dirname,'../assets/documentacion-agenda-pasajeros-stage3b-store.js'),'utf8');
 assert.doesNotMatch(ui,/saveDeliveryMessage/);assert.doesNotMatch(store,/saveDeliveryMessage/);
 assert.match(ui,/message\.value=delivery\.whatsapp_message\|\|shareMessage\(\)/);
});


test('CORS permite Prefer en el preflight del endpoint administrativo', () => {
 const fs=require('node:fs');
 const cors=fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/cors.ts'),'utf8');
 const store=fs.readFileSync(path.join(__dirname,'../assets/documentacion-agenda-pasajeros-stage3b-store.js'),'utf8');
 const match=cors.match(/'Access-Control-Allow-Headers'\s*:\s*'([^']+)'/);
 assert.ok(match,'debe declarar Access-Control-Allow-Headers');
 const allowed=match[1].toLowerCase().split(/\s*,\s*/);
 for(const header of ['authorization','apikey','content-type','prefer']) assert.ok(allowed.includes(header),`falta permitir ${header}`);
 assert.match(store,/Prefer:'return=representation'/);
});


test('la entrega devuelta por la Edge Function incluye trip_id para Storage', () => {
 const fs=require('node:fs');
 const admin=fs.readFileSync(path.join(__dirname,'../supabase/functions/tresor-delivery-admin/index.ts'),'utf8');
 assert.match(admin,/return \{delivery:\{id:delivery\.id,trip_id:delivery\.trip_id,status:delivery\.status/);
});

test('la carga se detiene antes de Storage si la ruta carece de UUIDs', async () => {
 let calls=0;const store=Store.create({api:async()=>{calls++;return{data:[]}},selectAll:async()=>[]},'workspace-fake');
 const blob=new Blob([new TextEncoder().encode('%PDF-fake-payload')],{type:'application/pdf'});Object.defineProperty(blob,'name',{value:'voucher-demo.pdf'});
 await assert.rejects(store.addDocument({id:'delivery-fake'},blob,{description:'Ficticio',category:'other'}),/No se pudo validar la ruta/);
 assert.equal(calls,0);
});

test('los errores de carga se muestran dentro del diálogo de documentación', () => {
 const fs=require('node:fs');const ui=fs.readFileSync(path.join(__dirname,'../assets/documentacion-agenda-pasajeros-stage3b.js'),'utf8');
 assert.match(ui,/function reportDialogError\(error\)/);assert.match(ui,/note\.setAttribute\('role','alert'\)/);
 assert.match(ui,/catch\(error\)\{reportDialogError\(error\)\}/);
});


test('la descarga administrativa convierte la ruta relativa de Storage a URL completa canónica', async () => {
 global.window={SUITE_SUPABASE_CONFIG:{url:'https://project.supabase.co'}};
 const calls=[];const cloud={api:async(url,options)=>{calls.push({url,options});return{data:{signedURL:'/object/sign/tresor-passenger-documents/w/t/d/file.pdf?token=fake-token'}}},selectAll:async()=>[]};
 const store=Store.create(cloud,'11111111-1111-4111-8111-111111111111');
 const url=await store.downloadDocument({storage_path:'11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444.pdf'});
 const parsed=new URL(url);assert.equal(parsed.pathname,'/storage/v1/object/sign/tresor-passenger-documents/w/t/d/file.pdf');assert.equal(parsed.searchParams.get('token'),'fake-token');
 assert.match(calls[0].url,/^\/storage\/v1\/object\/sign\//);assert.equal(JSON.parse(calls[0].options.body).expiresIn,120);
 delete global.window;
});

test('el normalizador del portal agrega el prefijo Storage una sola vez y rechaza otros orígenes', async () => {
 const core=await import(corePath),base='https://project.supabase.co';
 assert.equal(core.normalizeSignedStorageUrl(base,'/object/sign/private-bucket/folder/file.pdf?token=fake-token'),base+'/storage/v1/object/sign/private-bucket/folder/file.pdf?token=fake-token');
 assert.equal(core.normalizeSignedStorageUrl(base,'/storage/v1/object/sign/private-bucket/folder/file.pdf?token=fake-token'),base+'/storage/v1/object/sign/private-bucket/folder/file.pdf?token=fake-token');
 assert.throws(()=>core.normalizeSignedStorageUrl(base,'https://evil.example/storage/v1/object/sign/bucket/file.pdf?token=fake-token'),/invalid signed storage url/);
});

test('la Edge Function pública devuelve URL canónica y conserva vigencia de 120 segundos', () => {
 const fs=require('node:fs');const edge=fs.readFileSync(path.join(__dirname,'../supabase/functions/tresor-portal/index.ts'),'utf8');
 const ui=fs.readFileSync(path.join(__dirname,'../assets/documentacion-pasajero.js'),'utf8');
 assert.match(edge,/normalizeSignedStorageUrl\(url,result\.signedURL\|\|result\.signedUrl\)/);assert.match(edge,/expiresIn:120/);
 assert.match(ui,/safeSignedUrl\(out\.signedUrl\)/);assert.match(ui,/\/storage\/v1\/object\/sign\//);
});
