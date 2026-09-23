// =====================================================================
// pedido.js — Menú + validación + cálculo de precios.
// El prompt, la validación y el total salen TODOS de aquí.
// La IA entiende al cliente; este archivo hace las cuentas.
// =====================================================================

const TAMANOS = {
  'Porción': 7000,
  'Personal': 20000,
  'Pequeña': 32000,
  'Familiar': 50000
};

// ⚠️ PON AQUÍ EL PRECIO REAL DE CADA BORDE (0 = no cobra extra).
// Tu prompt anterior no decía cuánto cuestan, así que la IA se lo inventaba.
const ADICIONALES = {
  'Ninguno': 0,
  'Borde de Queso': 0,
  'Borde de Bocadillo': 0
};

const SABORES_ESPECIALES = [
  'Pizza Perro', 'Texana', '4 Carnes', 'Vegetariana', 'Soledaña', 'Caribeña',
  'Caprichosa', 'Pollo Jamón', 'Pollo Champiñón', 'Peperoni Americano',
  'Peperoni Salami', 'Pollo'
];

const SABORES_TRADICIONALES = ['Jamón', 'Bocadillo', 'Tomate', 'Salami', 'Piña', 'Jamón Salami'];

const SABORES = [...SABORES_ESPECIALES, ...SABORES_TRADICIONALES];
const MAX_SABORES = 4;

// ---------- utilidades ----------

// "Jamón" == "jamon" == "JAMÓN ";  "Pizza Perro" == "perro"
const normalizar = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^pizza\s+/, '');

function crearBuscador(lista) {
  const mapa = new Map(lista.map((x) => [normalizar(x), x]));
  return (valor) => mapa.get(normalizar(valor)) || null;
}

// El cliente dice cosas que no están en el menú con ese nombre exacto.
// "hawaiana" -> "Piña" siempre es un solo sabor, así que va directo (sin preguntar).
const ALIAS_SABORES = { hawaiana: 'Piña', hawaiano: 'Piña' };

const _buscarSaborExacto = crearBuscador(SABORES);
const _saboresNorm = SABORES.map((s) => ({ original: s, norm: normalizar(s) }));

// "peperoni" no es un sabor exacto, pero SÍ está contenido en "Peperoni Americano"
// y en "Peperoni Salami". Si solo calza con uno, se usa ese. Si calza con varios,
// se marca como ambiguo para que el bot pregunte cuál, en vez de decir "no existe".
function buscarSaborInfo(valor) {
  const alias = ALIAS_SABORES[normalizar(valor)];
  if (alias) return { exacto: alias };

  const exacto = _buscarSaborExacto(valor);
  if (exacto) return { exacto };

  const n = normalizar(valor);
  if (n.length < 3) return { exacto: null, opciones: [] }; // muy corto para adivinar

  const sinEspacios = (x) => x.replace(/\s+/g, '');
  const opciones = _saboresNorm
    .filter((s) => s.norm.includes(n) || n.includes(s.norm) || sinEspacios(s.norm).includes(sinEspacios(n)))
    .map((s) => s.original);

  if (opciones.length === 1) return { exacto: opciones[0] };
  return { exacto: null, opciones }; // 0 = no existe, 2+ = ambiguo, hay que preguntar
}

const buscarTamano = crearBuscador(Object.keys(TAMANOS));
const buscarAdicional = crearBuscador(Object.keys(ADICIONALES));

// 52000 -> "$52.000" (sin depender del ICU de Node)
const pesos = (n) => '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const pedidoVacio = () => ({ items: [], entrega: '', torre: '', apartamento: '', pago: '' });

// ---------- limpieza del JSON que devuelve la IA ----------
// - Normaliza nombres contra el menú (descarta sabores que no existen)
// - Si la IA deja un campo vacío, conserva lo que ya había (no se "olvida" datos)
function limpiarPedido(raw, previo = pedidoVacio()) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const invalidos = [];
  const ambiguos = []; // [{ texto, opciones }] - existe más de un sabor parecido
  let items = [];

  for (const it of Array.isArray(p.items) ? p.items : []) {
    if (!it || typeof it !== 'object') continue;

    const listaSabores = Array.isArray(it.sabores)
      ? it.sabores
      : typeof it.sabores === 'string' ? [it.sabores] : [];

    const sabores = [];
    for (const s of listaSabores) {
      if (!s || !String(s).trim()) continue;
      const texto = String(s).trim();
      const { exacto, opciones } = buscarSaborInfo(s);
      if (exacto) {
        if (!sabores.includes(exacto)) sabores.push(exacto);
      } else if (opciones && opciones.length > 1) {
        ambiguos.push({ texto, opciones });
      } else {
        invalidos.push(texto);
      }
    }

    const tamano = buscarTamano(it.tamano) || '';
    if (!sabores.length && !tamano) continue;

    items.push({
      sabores: sabores.slice(0, MAX_SABORES),
      tamano,
      adicional: buscarAdicional(it.adicional) || 'Ninguno',
      cantidad: Math.min(Math.max(parseInt(it.cantidad, 10) || 1, 1), 20)
    });
  }
  if (!items.length) items = previo.items;

  const t = (v) => (v == null ? '' : String(v).trim());
  const limpiarUbic = (v) => t(v).replace(/^(torre|apto\.?|apartamento)\s*/i, '');

  const e = t(p.entrega);
  const entrega = /recog|local/i.test(e) ? 'Recoger en el local'
    : /domicil/i.test(e) ? 'Domicilio'
    : previo.entrega;

  const g = t(p.pago);
  const pago = /nequi|transf|bre/i.test(g) ? 'Transferencia'
    : /efectivo/i.test(g) ? 'Efectivo'
    : previo.pago;

  return {
    pedido: {
      items,
      entrega,
      torre: limpiarUbic(p.torre) || previo.torre,
      apartamento: limpiarUbic(p.apartamento) || previo.apartamento,
      pago
    },
    invalidos,
    ambiguos
  };
}

// Qué datos faltan para poder cerrar el pedido (lo decide el código, no la IA)
function faltantes(p) {
  const f = [];
  if (!p.items.length) f.push('pizza (sabor y tamaño)');
  p.items.forEach((it, i) => {
    const n = p.items.length > 1 ? ` de la pizza ${i + 1}` : '';
    if (!it.sabores.length) f.push('sabor' + n);
    if (!it.tamano) f.push('tamaño' + n);
  });
  if (!p.entrega) f.push('si es domicilio o si pasa a recoger');
  else if (p.entrega === 'Domicilio') {
    if (!p.torre) f.push('torre');
    if (!p.apartamento) f.push('apartamento');
  }
  if (!p.pago) f.push('forma de pago (efectivo o transferencia)');
  return f;
}

const precioItem = (it) => ((TAMANOS[it.tamano] || 0) + (ADICIONALES[it.adicional] || 0)) * it.cantidad;
const calcularTotal = (p) => p.items.reduce((acc, it) => acc + precioItem(it), 0);

function lineasItems(p, conPrecio = false) {
  return p.items.map((it) => {
    const n = it.sabores.length;
    const sabores = it.sabores.join(' / ') +
      (n === 2 ? ' (mitad y mitad)' : n > 2 ? ` (${n} sabores)` : '');
    const extra = it.adicional !== 'Ninguno' ? ` + ${it.adicional}` : '';
    const precio = conPrecio ? ` — ${pesos(precioItem(it))}` : '';
    return `${it.cantidad}x ${it.tamano}: ${sabores}${extra}${precio}`;
  });
}

module.exports = {
  TAMANOS, ADICIONALES, SABORES_ESPECIALES, SABORES_TRADICIONALES, MAX_SABORES,
  pedidoVacio, limpiarPedido, faltantes, calcularTotal, lineasItems, pesos
};