const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// En tu PC todo se guarda junto al código. En la nube, DATA_DIR apunta al volumen persistente (ej. /data).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CARPETA = path.join(DATA_DIR, 'pedidos');
const BACKUP = path.join(DATA_DIR, 'pedidos_backup.jsonl');
fs.mkdirSync(CARPETA, { recursive: true });

// Un Excel por día: pedidos/pedidos_2026-09-21.xlsx  ->  el # de pedido reinicia solo cada día.
// "Día del negocio": el local cierra a las 12 AM, así que hasta las 5 AM todavía cuenta como el día anterior.
const HORA_CORTE = 5;
function archivoDelDia(ahora = Date.now()) {
  const dia = new Date(ahora - HORA_CORTE * 3600 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // YYYY-MM-DD
  return path.join(CARPETA, `pedidos_${dia}.xlsx`);
}
let ARCHIVO = archivoDelDia(); // se actualiza en cada operación (ver enCola)
const ESTADOS = '"NUEVO,PREPARANDO,EN CAMINO,ENTREGADO,CANCELADO"';
const COBROS = '"PENDIENTE,PAGADO,EFECTIVO"';

const COLUMNAS = [
  { header: '#', key: 'id', width: 6 },
  { header: 'Fecha', key: 'fecha', width: 20 },
  { header: 'Cliente', key: 'cliente', width: 16 },
  { header: 'Entrega', key: 'entrega', width: 20 },
  { header: 'Torre', key: 'torre', width: 8 },
  { header: 'Apartamento', key: 'apartamento', width: 13 },
  { header: 'Pedido', key: 'detalle', width: 60 },
  { header: 'Pago', key: 'pago', width: 15 },
  { header: 'Total', key: 'total', width: 12 },
  { header: 'Estado', key: 'estado', width: 14 },
  { header: 'Cobro', key: 'cobro', width: 14 } // PENDIENTE / PAGADO / EFECTIVO
];
const COLUMNAS_BASE = 10; // columnas de la versión anterior (sin "Cobro")
const COL_CLIENTE = 3;
const COL_TOTAL = 9;
const COL_COBRO = 11;

function crearHoja(workbook) {
  const hoja = workbook.addWorksheet('Pedidos', { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = COLUMNAS;
  hoja.getRow(1).font = { bold: true };
  hoja.autoFilter = 'A1:K1';
  return hoja;
}

async function abrirLibro() {
  const workbook = new ExcelJS.Workbook();

  if (!fs.existsSync(ARCHIVO)) {
    crearHoja(workbook);
    return workbook;
  }

  // Si el archivo está corrupto esto lanza error y NO lo sobrescribimos
  await workbook.xlsx.readFile(ARCHIVO);
  const hoja = workbook.getWorksheet('Pedidos');
  const formatoOk = hoja && COLUMNAS.slice(0, COLUMNAS_BASE)
    .every((c, i) => hoja.getRow(1).getCell(i + 1).value === c.header);

  if (formatoOk) {
    // Excel de la versión anterior: le agregamos al final las columnas nuevas ("Cobro")
    COLUMNAS.slice(COLUMNAS_BASE).forEach((c, k) => {
      const n = COLUMNAS_BASE + 1 + k;
      const celda = hoja.getRow(1).getCell(n);
      if (!celda.value) {
        celda.value = c.header;
        celda.font = { bold: true };
        hoja.getColumn(n).width = c.width;
      }
    });
    hoja.autoFilter = 'A1:K1';
    return workbook;
  }

  // Formato desconocido: lo apartamos y empezamos uno nuevo
  const viejo = ARCHIVO.replace('.xlsx', `_viejo_${Date.now()}.xlsx`);
  fs.renameSync(ARCHIVO, viejo);
  console.log(`📁 Formato anterior detectado. Copia guardada en ${path.basename(viejo)}`);
  const nuevo = new ExcelJS.Workbook();
  crearHoja(nuevo);
  return nuevo;
}

// Escritura atómica: escribe a un temporal y renombra
async function escribir(workbook) {
  const tmp = ARCHIVO + '.tmp';
  await workbook.xlsx.writeFile(tmp);
  fs.renameSync(tmp, ARCHIVO);
}

async function _guardar(pedido) {
  // 1) Backup en texto plano PRIMERO: si algo falla con el Excel, el pedido no se pierde
  fs.appendFileSync(BACKUP, JSON.stringify({ fecha: new Date().toISOString(), ...pedido }) + '\n');

  // 2) Excel
  const workbook = await abrirLibro();
  const hoja = workbook.getWorksheet('Pedidos');
  const id = hoja.lastRow.number; // fila 1 = encabezado -> el primer pedido es el #1

  const fila = hoja.addRow([
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
  ]);
  fila.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  fila.getCell(COL_TOTAL).numFmt = '"$"#,##0';
  fila.getCell(10).dataValidation = { type: 'list', allowBlank: false, formulae: [ESTADOS] };
  fila.getCell(COL_COBRO).dataValidation = { type: 'list', allowBlank: false, formulae: [COBROS] };

  await escribir(workbook);
  console.log(`✅ Pedido #${id} guardado en Excel`);
  return { id };
}

// Cola: todo lo que toca el Excel (guardar, leer, marcar pagado) va uno detrás del otro
let cola = Promise.resolve();
function enCola(fn) {
  const tarea = cola.then(() => {
    ARCHIVO = archivoDelDia(); // cada operación usa el Excel del día actual
    return fn();
  });
  cola = tarea.catch(() => {});
  return tarea;
}

const guardarPedido = (pedido) => enCola(() => _guardar(pedido));

async function leerHoja() {
  if (!fs.existsSync(ARCHIVO)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ARCHIVO);
  return wb.getWorksheet('Pedidos') || null;
}

// Último pedido de este cliente con transferencia PENDIENTE (a él se asocia el comprobante)
const buscarPendiente = (cliente) => enCola(async () => {
  const hoja = await leerHoja();
  if (!hoja) return null;
  for (let n = hoja.rowCount; n >= 2; n--) {
    const f = hoja.getRow(n);
    if (String(f.getCell(COL_CLIENTE).value) === String(cliente) && f.getCell(COL_COBRO).value === 'PENDIENTE') {
      return { id: Number(f.getCell(1).value), total: Number(f.getCell(COL_TOTAL).value) };
    }
  }
  return null;
});

const listarPendientes = () => enCola(async () => {
  const hoja = await leerHoja();
  const lista = [];
  if (!hoja) return lista;
  hoja.eachRow((f, n) => {
    if (n === 1 || f.getCell(COL_COBRO).value !== 'PENDIENTE') return;
    lista.push({
      id: Number(f.getCell(1).value),
      cliente: String(f.getCell(COL_CLIENTE).value || ''),
      total: Number(f.getCell(COL_TOTAL).value)
    });
  });
  return lista;
});

// Marca el pedido como PAGADO. Devuelve null si no existe.
const marcarPagado = (id) => enCola(async () => {
  if (!fs.existsSync(ARCHIVO)) return null;
  const workbook = await abrirLibro();
  const hoja = workbook.getWorksheet('Pedidos');
  let res = null;
  hoja.eachRow((f, n) => {
    if (n === 1 || res || Number(f.getCell(1).value) !== Number(id)) return;
    res = {
      cliente: String(f.getCell(COL_CLIENTE).value || ''),
      total: Number(f.getCell(COL_TOTAL).value),
      cobroAnterior: f.getCell(COL_COBRO).value
    };
    f.getCell(COL_COBRO).value = 'PAGADO';
  });
  if (res) await escribir(workbook);
  return res;
});

module.exports = { guardarPedido, buscarPendiente, listarPendientes, marcarPagado, archivoDelDia };
