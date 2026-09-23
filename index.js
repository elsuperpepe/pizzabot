require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const { guardarPedido, buscarPendiente, listarPendientes, marcarPagado } = require('./excel');
const { guardarPedidoSheet } = require('./sheets');
const P = require('./pedido');

if (!process.env.GROQ_API_KEY) {
  console.error('⚠️ GROQ_API_KEY no configurada en el archivo .env');
  process.exit(1);
}

const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, ''); // solo dígitos
const DATA_DIR = process.env.DATA_DIR || __dirname; // en la nube: carpeta del volumen (ej. /data)
const MODELO = process.env.MODELO || 'openai/gpt-oss-20b';
const REASONING = process.env.REASONING || 'low'; // 'low' = la IA piensa menos y responde más rápido
const DEBOUNCE_MS = 1200;                 // junta mensajes seguidos del cliente
const MAX_HISTORIAL = 12;                 // mensajes que ve la IA
const SESION_TTL_MS = 2 * 60 * 60 * 1000; // conversación inactiva 2h -> se reinicia
const PAUSA_HUMANO_MS = 30 * 60 * 1000;   // el bot se calla 30 min cuando piden humano (!reanudar lo despierta)

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
  puppeteer: {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  }
});

if (!fs.existsSync(path.join(__dirname, 'QR.jpeg'))) {
  console.warn('⚠️ No encuentro QR.jpeg en esta carpeta: no se podrá enviar el QR de pago.');
}

// =====================================================================
// PROMPT — la IA SOLO entiende al cliente. Total, resumen y guardado
// los hace el código (más barato, más rápido y sin errores de suma).
// =====================================================================
const PROMPT_BASE = `Eres "PizzaBot", el asistente virtual por WhatsApp de Pizzas El Trébol 🍕. Tu trabajo es tomar pedidos de forma rápida, amable y directa.

## NEGOCIO
- Local: Torre 24 - 104 (NO es la dirección del cliente).
- Horario: 5:00 PM a 12:00 AM.
- Pagos: efectivo o transferencia (Nequi 301 811 2837 / Llave Bre-B). NO se acepta tarjeta.
- Las entregas son en apartamentos.

## MENÚ (el precio depende solo del tamaño, no del sabor)
Tamaños: ${Object.entries(P.TAMANOS).map(([t, v]) => `${t} ${P.pesos(v)}`).join(' | ')}
Sabores especiales: ${P.SABORES_ESPECIALES.join(', ')}
Sabores tradicionales: ${P.SABORES_TRADICIONALES.join(', ')}
Adicionales: ${Object.keys(P.ADICIONALES).filter((a) => a !== 'Ninguno').join(', ')}

## CÓMO INTERPRETAR EL PEDIDO
- Cada pizza es un elemento de "items". Una pizza puede llevar hasta 4 sabores (mitad y mitad, 3 o 4 sabores): todos van en "sabores" y cuentan como UNA sola pizza, con el precio de su tamaño.
  Ej: "una personal mitad perro mitad texana" -> 1 item, sabores ["Pizza Perro","Texana"], tamano "Personal".
- "Porción" es un TAMAÑO válido, nunca un adicional. "una porción de jamón" -> tamano "Porción", sabores ["Jamón"], adicional "Ninguno".
- REGLA IMPORTANTE DE TAMAÑO: si el cliente escribe "pizza [sabor] pequeña" (la palabra pequeña va después del sabor), quiere una PORCIÓN, no el tamaño Pequeña. Guarda tamano "Porción". Ejemplos: "una pizza de piña pequeña" -> Porción de Piña. "dos pizzas de jamón pequeña" -> Porción de Jamón, cantidad 2. Solo es el tamaño Pequeña si dice "una pequeña de piña", "la pequeña" o "tamaño pequeña". Si dudas, pregunta: ¿Te refieres a una porción o a la pizza pequeña?
- "Hawaiana" es lo mismo que el sabor "Piña". Usa siempre "Piña" en sabores.
- Varias unidades iguales ("dos personales de jamón") -> "cantidad": 2. Pizzas distintas -> un item por cada una.
- Si no menciona adicional -> "Ninguno".
- Solo existen los sabores y adicionales del menú. Usa los nombres exactos.

## ENTREGA
- Domicilio: necesitas torre y apartamento (ej. "Torre 24 apartamento 302").
- Recoger: si dice "voy por ella", "paso por ella", "la recojo", "yo paso", "la voy a buscar", "recoger en el local" o similar -> entrega = "Recoger en el local". En ese caso NUNCA preguntes torre ni apartamento.

## PAGO
"Efectivo" o "Transferencia" (Nequi / Bre-B). Si piden tarjeta, explica con amabilidad que no se acepta.

## PERSONALIDAD
Eres un asistente virtual y el cliente lo nota, pero la charla se siente natural: cálida, cercana y casual, como una buena pizzería colombiana.
- Puedes decir "De una", "Perfecto", "Listo", "Claro", "Ya te entendí". Emojis de vez en cuando (🍕😊👍), no en cada mensaje.
- No hables como formulario. No repitas estructura en cada respuesta.
- No repitas lo que el cliente ya dijo. Si ya tienes casi todo, pregunta SOLO por lo que falta, una cosa a la vez.
- Si el cliente es informal, responde informal.
- No inventes precios, sabores ni información que no esté aquí. No repitas que eres una IA.

## PREGUNTAS SOBRE EL MENÚ
Si el cliente pregunta qué sabores hay, pide "la carta", "el menú" o algo similar, respóndele YA la lista completa de sabores (especiales y tradicionales) y los tamaños con precios, tal cual aparecen arriba en MENÚ. No le preguntes antes el tamaño ni ningún otro dato. accion "continuar", pedido sin cambios.

## LO QUE NO HACES
- NO calculas totales ni escribes el resumen del pedido: el sistema lo hace. Si con este mensaje el pedido queda completo, responde algo corto.
- Reclamo, algo fuera del menú o cualquier problema -> accion "humano" y en respuesta: "Te transfiero ahora mismo con un encargado para atenderte directo".

## CONFIRMACIÓN
El sistema te dice en ESTADO si "esperando_confirmacion" es true (ya se mostró el resumen y se preguntó "¿Está todo correcto?").
- Si es true y el cliente responde afirmativamente (sí, correcto, dale, listo, ok, perfecto, de una, confirmo, sisas, sip, claro, ajá, sí señor...) -> accion "confirmar" y devuelve el pedido IDÉNTICO al estado actual.
- Si es true y el cliente cambia algo -> accion "continuar" con el pedido actualizado (solo cambia lo que pidió).
- Si es true y el cliente pregunta otra cosa -> respóndele y recuérdale confirmar. accion "continuar", pedido igual.
- Si es false, NUNCA uses "confirmar" (un "listo" o "perfecto" suelto no es confirmación).
- Si el cliente cancela el pedido -> accion "cancelar".

## FORMATO DE SALIDA
Responde SIEMPRE y SOLO con un JSON válido así:
{
  "respuesta": "mensaje que verá el cliente",
  "accion": "continuar | confirmar | cancelar | humano",
  "pedido": {
    "items": [
      { "sabores": ["Pizza Perro", "Texana"], "tamano": "Personal", "adicional": "Ninguno", "cantidad": 1 }
    ],
    "entrega": "Domicilio | Recoger en el local | (vacío si no se sabe)",
    "torre": "",
    "apartamento": "",
    "pago": "Efectivo | Transferencia | (vacío si no se sabe)"
  }
}
Devuelve SIEMPRE el pedido completo: conserva lo que ya estaba en el ESTADO y aplica los cambios del último mensaje.`;

function textoEstado(s) {
  return `## ESTADO ACTUAL (guardado por el sistema)
${JSON.stringify({
    pedido: s.pedido,
    esperando_confirmacion: s.esperandoConfirmacion,
    faltan: P.faltantes(s.pedido)
  })}
Si "faltan" tiene cosas, pregunta solo por lo primero que falte.`;
}

// =====================================================================
// SESIONES (una por chat)
// =====================================================================
const sesiones = new Map();

const nuevaSesion = () => ({
  historial: [],
  pedido: P.pedidoVacio(),
  esperandoConfirmacion: false,
  pausadoHasta: 0,
  ultima: Date.now()
});

function getSesion(chatId) {
  let s = sesiones.get(chatId);
  const ahora = Date.now();
  if (s && ahora - s.ultima > SESION_TTL_MS && ahora > s.pausadoHasta) s = null;
  if (!s) {
    s = nuevaSesion();
    sesiones.set(chatId, s);
  }
  s.ultima = ahora;
  return s;
}

const estaPausado = (chatId) => (sesiones.get(chatId)?.pausadoHasta || 0) > Date.now();

setInterval(() => {
  const ahora = Date.now();
  for (const [id, s] of sesiones) {
    if (ahora - s.ultima > SESION_TTL_MS && ahora > s.pausadoHasta) sesiones.delete(id);
  }
}, 30 * 60 * 1000).unref();

// =====================================================================
// UTILIDADES DE ENVÍO
// =====================================================================
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviar(chatId, texto) {
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();
  } catch { /* no es crítico */ }
  await esperar(Math.min(300 + texto.length * 3, 1200)); // pausa corta, se siente humano
  await client.sendMessage(chatId, texto);
}

async function responder(chatId, s, texto) {
  s.historial.push({ role: 'assistant', content: texto });
  if (s.historial.length > 30) s.historial.splice(0, s.historial.length - 30);
  await enviar(chatId, texto);
}

// WhatsApp ahora usa IDs internos (LID): hay que resolver el número antes de escribirle.
let adminId = null;
async function resolverAdmin() {
  if (!ADMIN_NUMBER) return null;
  if (adminId) return adminId;
  try {
    const propio = client.info && client.info.wid;
    if (propio && propio.user === ADMIN_NUMBER) {
      adminId = propio._serialized; // el admin es el mismo número del bot ("Mensajes a ti mismo")
    } else {
      const id = await client.getNumberId(ADMIN_NUMBER);
      if (id) adminId = id._serialized;
      else console.error('❌ ADMIN_NUMBER no aparece registrado en WhatsApp. Debe llevar código de país y sin "+".');
    }
  } catch (e) {
    console.error('❌ No pude resolver ADMIN_NUMBER:', e.message);
  }
  return adminId;
}

async function notificarAdmin(texto) {
  const id = await resolverAdmin();
  if (!id) return;
  try {
    await client.sendMessage(id, texto);
    console.log('📨 Aviso enviado al admin');
  } catch (e) {
    console.error('❌ No pude avisar al admin:', e.message);
  }
}

async function enviarQR(chatId) {
  const ruta = path.join(__dirname, 'QR.jpeg');
  try {
    await client.sendMessage(chatId, MessageMedia.fromFilePath(ruta));
    return;
  } catch (e) {
    console.error('❌ Error enviando QR (método 1):', e.message);
  }
  try {
    const base64 = fs.readFileSync(ruta).toString('base64');
    await client.sendMessage(chatId, new MessageMedia('image/jpeg', base64, 'QR.jpeg'));
  } catch (e2) {
    console.error('❌ Error enviando QR (método 2):', e2.message);
  }
}

async function obtenerNumero(msg) {
  const de = msg.from;
  try {
    if (de.endsWith('@lid') && typeof client.getContactLidAndPhone === 'function') {
      const r = await client.getContactLidAndPhone([de]);
      const pn = r && r[0] && r[0].pn;
      if (pn) return String(pn).replace(/@.*/, '');
    }
  } catch { /* seguimos con el método normal */ }
  try {
    const c = await msg.getContact();
    return c.number || de.replace(/@.*/, '');
  } catch {
    return de.replace(/@.*/, '');
  }
}

// =====================================================================
// RESUMEN (lo arma el código: siempre bien formateado y con el total correcto)
// =====================================================================
function resumen(p) {
  const l = ['📦 *Resumen de tu pedido*', ''];
  P.lineasItems(p, true).forEach((x) => l.push('🍕 ' + x));
  l.push('');
  l.push(p.entrega === 'Domicilio'
    ? `🛵 *Entrega:* Domicilio · Torre ${p.torre}, Apto ${p.apartamento}`
    : '🏪 *Entrega:* Recoger en el local (Torre 24 - 104)');
  l.push(`💳 *Pago:* ${p.pago}`);
  l.push(`💰 *Total:* ${P.pesos(P.calcularTotal(p))}`);
  l.push('', '¿Está todo correcto?');
  return l.join('\n');
}

// =====================================================================
// IA
// =====================================================================
async function llamarIA(s) {
  const messages = [
    { role: 'system', content: PROMPT_BASE + '\n\n' + textoEstado(s) },
    ...s.historial.slice(-MAX_HISTORIAL)
  ];
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const r = await openai.chat.completions.create({
        model: MODELO,
        messages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        // Si Groq rechazara este parámetro, el 2º intento va sin él
        ...(intento === 1 && REASONING && /gpt-oss/.test(MODELO) ? { reasoning_effort: REASONING } : {})
      });
      const data = JSON.parse(r.choices[0].message.content);
      if (data && typeof data === 'object') return data;
    } catch (e) {
      console.error(`❌ IA intento ${intento}:`, e.message);
    }
  }
  return null;
}

// =====================================================================
// CONFIRMAR: guarda, avisa, manda QR y REINICIA la sesión
// (antes, si el cliente decía "gracias" después, se guardaba el pedido otra vez)
// =====================================================================
async function confirmarPedido(chatId, s, msg) {
  const p = s.pedido;
  const total = P.calcularTotal(p);
  const numero = await obtenerNumero(msg);
  const domicilio = p.entrega === 'Domicilio';

  // El guardado arranca ya, pero NO hacemos esperar al cliente por el Excel
    const datosPedido = {
    cliente: numero,
    entrega: p.entrega,
    torre: domicilio ? p.torre : '',
    apartamento: domicilio ? p.apartamento : '',
    detalle: P.lineasItems(p).join('\n'),
    pago: p.pago,
    total
  };

  const guardado = guardarPedido(datosPedido);
  guardado.catch(() => {});
  guardarPedidoSheet(datosPedido).catch((e) => console.error('❌ No se pudo guardar en Google Sheets:', e.message)); // evita "unhandledRejection"; el error real se maneja abajo

  sesiones.delete(chatId); // cierra el ciclo: no hay doble guardado

  const l = ['✅ ¡Listo! Tu pedido quedó confirmado 🍕'];
  l.push(domicilio ? `Te lo llevamos a la Torre ${p.torre}, apto ${p.apartamento}.` : 'Te esperamos en el local (Torre 24 - 104).');
  if (p.pago === 'Transferencia') {
    l.push(`Total a transferir: ${P.pesos(total)} (Nequi 301 811 2837).`);
    l.push('Cuando pagues, mándame la foto del comprobante por aquí 📸 Te dejo el QR 👇');
  }
  else l.push(`Total a pagar en efectivo: ${P.pesos(total)}.`);
  await enviar(chatId, l.join('\n'));
  if (p.pago === 'Transferencia') await enviarQR(chatId);

  // Ahora sí esperamos el Excel (el # de pedido solo lo ve el admin)
  let id = null;
  try {
    id = (await guardado).id;
  } catch (e) {
    console.error('❌ No se pudo guardar en Excel (quedó en pedidos_backup.jsonl):', e);
    await notificarAdmin('⚠️ Falló el guardado en Excel. Revisa pedidos_backup.jsonl');
  }

  let aviso = `🆕 *Pedido${id ? ' #' + id : ''}*\n📱 ${numero}\n\n${resumen(p)}`.replace('\n\n¿Está todo correcto?', '');
  if (p.pago === 'Transferencia') {
    aviso += `\n\n⏳ Transferencia PENDIENTE de verificar${id ? `. Cuando la veas en tu Nequi responde: !pagado ${id}` : ''}`;
  }
  await notificarAdmin(aviso);
  console.log(`🍕 Pedido${id ? ' #' + id : ''} de ${numero} — ${P.pesos(total)}`);
}

// =====================================================================
// UN TURNO DE CONVERSACIÓN (el estado lo manda el código, no la IA)
// =====================================================================

// "sí", "dale", "listo"... (solo eso, sin más texto). Justo después del resumen
// confirma al instante, sin esperar a la IA.
const AFIRMATIVO = /^(?:(?:si|sii+|sip|sisas|sisa|dale|listo|ok|okay|okey|confirmo|confirmado|correcto|perfecto|de una|claro|aja|exacto|exactamente|asi es|asi esta bien|asi mismo|esta bien|todo bien|todo correcto|senor)\s*)+$/;
const esAfirmativo = (t) =>
  AFIRMATIVO.test(t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim());

async function procesarTurno(chatId, texto, msg) {
  if (estaPausado(chatId)) return;
  const s = getSesion(chatId);

  if (s.esperandoConfirmacion && esAfirmativo(texto) && P.faltantes(s.pedido).length === 0) {
    return confirmarPedido(chatId, s, msg);
  }
  s.historial.push({ role: 'user', content: texto });

  const ia = await llamarIA(s);
  if (!ia) {
    s.historial.pop();
    return enviar(chatId, 'Disculpa, tuve un problema procesando tu mensaje. ¿Me lo repites? 🙏');
  }

  const respuestaIA = typeof ia.respuesta === 'string' ? ia.respuesta.trim() : '';

  if (ia.accion === 'cancelar') {
    sesiones.delete(chatId);
    return enviar(chatId, respuestaIA || 'Listo, cancelé el pedido. Cuando quieras hacemos otro 🍕');
  }

  if (ia.accion === 'humano') {
    s.pausadoHasta = Date.now() + PAUSA_HUMANO_MS; // el bot se calla para que hable el encargado
    const numero = await obtenerNumero(msg);
    s.numero = numero; // para poder reanudar con !reanudar <número>
    await notificarAdmin(`🙋 Un cliente necesita atención humana\n📱 ${numero}\n💬 "${texto}"`);
    return enviar(chatId, respuestaIA || 'Te transfiero ahora mismo con un encargado para atenderte directo.');
  }

  const { pedido: nuevo, invalidos, ambiguos } = P.limpiarPedido(ia.pedido, s.pedido);
  const cambio = JSON.stringify(nuevo) !== JSON.stringify(s.pedido);
  const faltan = P.faltantes(nuevo);

  // ✅ Confirmación: solo vale si se estaba esperando, NADA cambió y el pedido está completo
  if (ia.accion === 'confirmar' && s.esperandoConfirmacion && !cambio && faltan.length === 0) {
    return confirmarPedido(chatId, s, msg);
  }

  s.pedido = nuevo;

  // Ej: "peperoni" calza con "Peperoni Americano" Y "Peperoni Salami" -> hay que preguntar cuál
  if (ambiguos.length) {
    s.esperandoConfirmacion = false;
    const primero = ambiguos[0];
    return responder(chatId, s,
      `Tenemos ${primero.opciones.join(' y ')} 🍕 ¿Cuál de los dos te gustaría?`);
  }

  // Sabor que no existe en el menú
  if (invalidos.length) {
    s.esperandoConfirmacion = false;
    return responder(chatId, s,
      `Mmm, no tengo "${invalidos.join('", "')}" en el menú 😅\n\nEstos son los sabores:\n` +
      `⭐ ${P.SABORES_ESPECIALES.join(', ')}\n🍕 ${P.SABORES_TRADICIONALES.join(', ')}\n\n¿Cuál te gustaría?`);
  }

  // Pedido incompleto: sigue la conversación
  if (faltan.length) {
    s.esperandoConfirmacion = false;
    return responder(chatId, s, respuestaIA || `Perfecto 👍 Solo me falta: ${faltan[0]}.`);
  }

  // Pedido completo y no cambió mientras esperábamos (ej. el cliente hizo una pregunta)
  if (s.esperandoConfirmacion && !cambio && respuestaIA) {
    return responder(chatId, s, respuestaIA);
  }

  // Pedido completo (o corregido): resumen generado por el código
  s.esperandoConfirmacion = true;
  return responder(chatId, s, resumen(s.pedido));
}

// =====================================================================
// COLA POR CHAT + DEBOUNCE
// - Cola: nunca se procesan 2 mensajes del mismo chat en paralelo
// - Debounce: "una personal" / "de perro" / "torre 5" se leen como UN mensaje
// =====================================================================
const colas = new Map();
function enCola(chatId, fn) {
  const previa = colas.get(chatId) || Promise.resolve();
  const siguiente = previa.then(fn).catch((e) => console.error('❌ Error en turno:', e));
  colas.set(chatId, siguiente);
  siguiente.finally(() => {
    if (colas.get(chatId) === siguiente) colas.delete(chatId);
  });
}

const buffers = new Map();
function encolarTexto(chatId, texto, msg) {
  const b = buffers.get(chatId) || { textos: [] };
  b.textos.push(texto);
  b.msg = msg;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    buffers.delete(chatId);
    enCola(chatId, () => procesarTurno(chatId, b.textos.join('\n'), b.msg));
  }, DEBOUNCE_MS);
  buffers.set(chatId, b);
}

// =====================================================================
// COMPROBANTES DE PAGO
// Una foto NO prueba que pagaron (se falsifican fácil). El bot solo la
// asocia al pedido y se la manda a un humano, que verifica en su Nequi.
// =====================================================================
async function reenviarAdmin(msg) {
  const id = await resolverAdmin();
  if (!id) return;
  try {
    await msg.forward(id);
  } catch (e) {
    console.error('❌ No pude reenviar la imagen al admin:', e.message);
  }
}

async function manejarImagen(chatId, msg) {
  const numero = await obtenerNumero(msg);
  let pendiente = null;
  try {
    pendiente = await buscarPendiente(numero);
  } catch (e) {
    console.error('❌ No pude buscar transferencias pendientes:', e.message);
  }

  if (!pendiente) {
    await enviar(chatId, 'Recibí tu imagen 👍 Se la paso al encargado para que la revise.');
    await notificarAdmin(`🖼️ Imagen de ${numero} (no tiene transferencias pendientes registradas)`);
    return reenviarAdmin(msg);
  }

  await enviar(chatId, `Recibí tu comprobante 👍 En un momento el encargado confirma tu pago de ${P.pesos(pendiente.total)}.`);
  await notificarAdmin(
    `🧾 *Comprobante — Pedido #${pendiente.id}*\n📱 ${numero}\n💰 ${P.pesos(pendiente.total)}\n\n` +
    `Verifícalo en tu Nequi y responde: !pagado ${pendiente.id}`);
  return reenviarAdmin(msg);
}

// =====================================================================
// COMANDOS DEL ADMIN (se escriben por WhatsApp, desde ADMIN_NUMBER)
//   !pagado 12   -> marca el pedido 12 como PAGADO y avisa al cliente
//   !pendientes  -> lista las transferencias por verificar
// =====================================================================
const comandosVistos = new Set(); // evita procesar el mismo mensaje dos veces

async function manejarComandoAdmin(msg) {
  const mid = msg.id && msg.id._serialized;
  if (mid) {
    if (comandosVistos.has(mid)) return;
    comandosVistos.add(mid);
    setTimeout(() => comandosVistos.delete(mid), 60000).unref();
  }

  // Si el admin escribe desde el mismo número del bot, respondemos en "Mensajes a ti mismo"
  const destino = msg.fromMe ? client.info.wid._serialized : msg.from;
  const decir = (t) => client.sendMessage(destino, t);
  const [cmd, arg] = (msg.body || '').trim().split(/\s+/);

  try {
    if (cmd === '!pagado') {
      const id = parseInt(arg, 10);
      if (!id) return await decir('Uso: !pagado 12');
      const r = await marcarPagado(id);
      if (!r) return await decir(`No encontré el pedido #${id}.`);
      if (r.cobroAnterior === 'PAGADO') return await decir(`El pedido #${id} ya estaba marcado como PAGADO.`);
      await decir(`✅ Pedido #${id} marcado como PAGADO (${P.pesos(r.total)}).`);
      try {
        const cliente = await client.getNumberId(r.cliente);
        if (!cliente) throw new Error('número no resuelto');
        await enviar(cliente._serialized, '✅ ¡Recibimos tu pago, gracias! 🍕');
      } catch {
        await decir('(No pude avisarle al cliente por WhatsApp, avísale tú.)');
      }
    } else if (cmd === '!pendientes') {
      const lista = await listarPendientes();
      if (!lista.length) return await decir('No hay transferencias pendientes 🎉');
      await decir('⏳ *Transferencias pendientes*\n' +
        lista.map((x) => `#${x.id} — ${P.pesos(x.total)} — ${x.cliente}`).join('\n'));
    } else if (cmd === '!reanudar') {
      let n = 0;
      for (const ses of sesiones.values()) {
        if (ses.pausadoHasta > Date.now() && (!arg || ses.numero === arg.replace(/\D/g, ''))) {
          ses.pausadoHasta = 0;
          n++;
        }
      }
      await decir(n ? `▶️ Bot reanudado en ${n} chat(s).` : 'No hay chats pausados.');
    } else {
      await decir('Comandos:\n!pagado 12\n!pendientes\n!reanudar [número]');
    }
  } catch (e) {
    console.error('❌ Error en comando de admin:', e.message);
  }
}

// =====================================================================
// EVENTOS
// =====================================================================
client.on('qr', (qr) => {
  console.log('\n================ ESCANEA ESTE CÓDIGO QR ================');
  qrcode.generate(qr, { small: true });
  console.log('=======================================================\n');
});

client.on('ready', () => console.log('✅ ¡Bot de Pizzas El Trébol conectado y activo!'));
client.on('disconnected', (r) => console.log('⚠️ WhatsApp desconectado:', r));

client.on('message', async (msg) => {
  if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast' || msg.isStatus) return;

  // Comandos del admin (!pagado, !pendientes) escritos desde otro teléfono
  if (ADMIN_NUMBER && msg.body && msg.body.startsWith('!') && (await obtenerNumero(msg)) === ADMIN_NUMBER) {
    return manejarComandoAdmin(msg);
  }

  const chatId = msg.from;
  if (estaPausado(chatId)) return;

  // Notas de voz: el bot no las entiende
  if (msg.type === 'ptt' || msg.type === 'audio') {
    return enCola(chatId, () =>
      enviar(chatId, 'Uy, por acá no alcanzo a escuchar audios 😅 ¿Me lo escribes, por favor?'));
  }

  // Imágenes (normalmente comprobantes de pago): se le pasan al encargado
  if (msg.type === 'image') {
    return enCola(chatId, () => manejarImagen(chatId, msg));
  }

  const texto = (msg.body || '').trim();
  if (!texto) return;
  encolarTexto(chatId, texto, msg);
});

// Admin que escribe desde el MISMO número del bot (chat "Mensajes a ti mismo")
client.on('message_create', (msg) => {
  if (!msg.fromMe || !msg.body || !msg.body.startsWith('!')) return;
  if (!client.info || client.info.wid.user !== ADMIN_NUMBER) return;
  manejarComandoAdmin(msg);
});

process.on('unhandledRejection', (e) => console.error('❌ unhandledRejection:', e));

// Tras un reinicio en la nube Chromium puede creer que el perfil sigue "en uso" y no abrir: limpiamos los candados.
function limpiarCandados() {
  const raiz = path.join(DATA_DIR, '.wwebjs_auth');
  try {
    for (const d of fs.readdirSync(raiz)) {
      for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        fs.rmSync(path.join(raiz, d, f), { force: true });
      }
    }
  } catch { /* la carpeta aún no existe (primera vez) */ }
}

// Cierre limpio cuando la plataforma reinicia o redespliega el bot
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await client.destroy(); } catch { /* nada */ }
    process.exit(0);
  });
}

limpiarCandados();
client.initialize();