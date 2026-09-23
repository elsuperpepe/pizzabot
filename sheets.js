const fs = require('fs');
const path = require('path');

// Google Sheets es opcional: si no hay credentials.json o GOOGLE_SHEET_ID,
// esta parte simplemente no hace nada (el bot sigue guardando en Excel normal).
const CREDENCIALES = path.join(__dirname, 'credentials.json');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const NOMBRE_HOJA = 'Pedidos';
const ENCABEZADO = ['#', 'Fecha', 'Cliente', 'Entrega', 'Torre', 'Apartamento', 'Pedido', 'Pago', 'Total', 'Estado', 'Cobro'];

function habilitado() {
  return Boolean(SHEET_ID) && fs.existsSync(CREDENCIALES);
}

let _sheets = null;
async function obtenerSheets() {
  if (_sheets) return _sheets;
  const { google } = require('googleapis'); // se carga solo si de verdad se va a usar
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENCIALES,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  _sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _sheets;
}

let encabezadoListo = false;
async function asegurarEncabezado(sheets) {
  if (encabezadoListo) return;
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${NOMBRE_HOJA}!A1:A1` });
  if (!r.data.values || !r.data.values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${NOMBRE_HOJA}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [ENCABEZADO] }
    });
  }
  encabezadoListo = true;
}

// Cola simple: si dos pedidos llegan casi juntos, se guardan uno detrás del otro
let cola = Promise.resolve();
function guardarPedidoSheet(pedido) {
  const tarea = cola.then(() => _guardar(pedido));
  cola = tarea.catch(() => {});
  return tarea;
}

async function _guardar(pedido) {
  if (!habilitado()) return null; // no configurado todavía: se omite en silencio

  const sheets = await obtenerSheets();
  await asegurarEncabezado(sheets);

  // El "id" es simplemente cuántas filas ya hay (fila 1 = encabezado)
  const actuales = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${NOMBRE_HOJA}!A:A` });
  const id = actuales.data.values ? actuales.data.values.length : 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${NOMBRE_HOJA}!A:K`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        id,
        new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
        pedido.cliente,
        pedido.entrega,
        pedido.torre || '',
        pedido.apartamento || '',
        pedido.detalle,
        pedido.pago,
        pedido.total,
        'NUEVO',
        pedido.pago === 'Transferencia' ? 'PENDIENTE' : 'EFECTIVO'
      ]]
    }
  });

  console.log(`✅ Pedido #${id} guardado en Google Sheets`);
  return { id };
}

module.exports = { guardarPedidoSheet, habilitado };
