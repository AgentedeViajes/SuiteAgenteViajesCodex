const test=require('node:test');
const assert=require('node:assert/strict');

const Stage4A=require('../assets/documentacion-agenda-pasajeros-stage4a.js');
const passenger={id:'p1',first_name:'María José',last_name:'Gómez'};
const trip={id:'t1',destination:'Río de Janeiro & Búzios',departure_on:'2027-03-15',return_on:'2027-03-22'};
test('personaliza las cinco plantillas con pasajero, destino, fechas y firma Tresor Travel',()=>{
 for(const [type] of Stage4A.TYPES){const message=Stage4A.buildMessage(type,{passenger,trip,reservations:[]});assert.match(message,/María José Gómez/);assert.match(message,/Río de Janeiro & Búzios/);assert.match(message,/15 de marzo de 2027/);assert.match(message,/22 de marzo de 2027/);assert.match(message,/Javier\nTu asesor de viajes en Tresor Travel/)}
});
test('la plantilla de check-in solo incorpora reservas asociadas al pasajero y datos confirmados',()=>{
 const reservations=[{id:'r1',airline_name:'Aerolínea A',passengerIds:['p1'],checkin_opens_at:'2027-03-13T10:00:00Z',official_checkin_url:'https://airline.example/checkin',pnr:'PRIVATE-PNR'}, {id:'r2',airline_name:'Aerolínea B',passengerIds:['p2'],checkin_opens_at:'2027-03-13T12:00:00Z',official_checkin_url:'https://other.example/checkin'}];
 const message=Stage4A.buildMessage('before48',{passenger,trip,reservations});assert.match(message,/Aerolínea A/);assert.match(message,/13 de marzo de 2027/);assert.match(message,/https:\/\/airline\.example\/checkin/);assert.doesNotMatch(message,/Aerolínea B|other\.example|PRIVATE-PNR|p2/);
});
test('cuando faltan fechas, check-in o destino, no inventa valores ni expone otras fichas',()=>{
 const message=Stage4A.buildMessage('before48',{passenger,trip:{destination:'Cancún'},reservations:[{passengerIds:['p1'],airline_name:'Aerolínea A',official_checkin_url:'javascript:alert(1)'},{passengerIds:['p2'],airline_name:'Otra aerolínea',official_checkin_url:'https://other.example'}]});
 assert.match(message,/Cancún/);assert.doesNotMatch(message,/Fechas:|javascript:|other\.example|Otra aerolínea/);assert.match(message,/no tiene un horario ni un enlace oficial/);
});
test('teléfono prioriza WhatsApp válido y cae al teléfono principal sin inventar números',()=>{
 const normalize=n=>String(n||'').replace(/\D/g,'');assert.equal(Stage4A.recipientNumber({whatsapp:'invalid',phone:'+54 (11) 5555-1111'},normalize),'541155551111');assert.equal(Stage4A.recipientNumber({whatsapp:'+1 202 555 0101',phone:'555'},normalize),'12025550101');assert.equal(Stage4A.recipientNumber({},normalize),'');
});
test('WhatsApp codifica acentos, emojis, saltos y caracteres especiales, con y sin destinatario',()=>{
 const message='¡Hola, José! 😊\n¿Vamos? & sí';const url=Stage4A.whatsappUrl('5491112345678',message);assert.ok(url.startsWith('https://wa.me/5491112345678?text='));assert.equal(new URL(url).searchParams.get('text'),message);const noNumber=Stage4A.whatsappUrl('',message);assert.ok(noNumber.startsWith('https://wa.me/?text='));assert.equal(new URL(noNumber).searchParams.get('text'),message);assert.doesNotMatch(noNumber,/undefined|null/);
});

test('el recordatorio de check-in solo se habilita si hay una reserva vinculada al pasajero',()=>{const reservations=[{passengerIds:['p1']},{passengerIds:['p2']}];assert.equal(Stage4A.supportsCheckin(reservations,'p1'),true);assert.equal(Stage4A.supportsCheckin(reservations,'p3'),false);assert.equal(Stage4A.supportsCheckin([], 'p1'),false)});

test('el módulo expone el ciclo de vida que integra la navegación principal',()=>{const ui=Stage4A.createUI();assert.equal(typeof ui.init,'function');assert.equal(typeof ui.refresh,'function');assert.equal(typeof ui.onEnter,'function')});

test('no afirma que la salida sea mañana cuando el viaje no tiene fecha',()=>{const message=Stage4A.buildMessage('before1',{passenger,trip:{destination:'Bariloche'}});assert.match(message,/está muy cerca/);assert.doesNotMatch(message,/mañana|Fechas:|Salida:/i)});
test('la carga de navegador expone los controles y no solo las funciones del modelo',()=>{const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require('node:path').join(__dirname,'../assets/documentacion-agenda-pasajeros-stage4a.js'),'utf8'),sandbox={};vm.runInNewContext(source,sandbox);assert.equal(typeof sandbox.PassengerCommsUI.init,'function');assert.equal(typeof sandbox.PassengerCommsUI.refresh,'function');assert.equal(typeof sandbox.PassengerCommsUI.onEnter,'function')});
test('la Suite informa WhatsApp manual y no promete recordatorios por correo',()=>{const fs=require('node:fs'),html=fs.readFileSync(require('node:path').join(__dirname,'../apps/documentacion-agenda-pasajeros.html'),'utf8');assert.match(html,/WhatsApp manual, con revisión previa/);assert.match(html,/no envía mensajes automáticamente/);assert.doesNotMatch(html,/Recordatorios por correo|Se prepararán en la Etapa 4|Disponible en Etapa 4/)})
