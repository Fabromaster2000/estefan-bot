// ── CORE: SERVICIOS ───────────────────────────────────────────────────────────
// Fuente única de verdad para todos los servicios y precios.
// Modificar acá se refleja en todo el sistema.

const SERVICIOS = [
  { id:1,  nombre:'Corte de pelo',        precio:50000,  seña:false,              categoria:'Cortes' },
  { id:2,  nombre:'Corte + Brushing',     precio:70000,  seña:false,              categoria:'Cortes' },
  { id:3,  nombre:'Brushing / Planchita', precio:20000,  seña:false,              categoria:'Cortes' },
  { id:4,  nombre:'Lavado + Aireado',     precio:15000,  seña:false,              categoria:'Cortes' },
  { id:5,  nombre:'Ozono',                precio:30000,  seña:false,              categoria:'Spa' },
  { id:6,  nombre:'Head Spa completo',    precio:120000, seña:true,  pct:10,      categoria:'Spa' },
  { id:7,  nombre:'Ampolla',              precio:30000,  seña:false,              categoria:'Spa' },
  { id:8,  nombre:'Retoque / Raíz',       precio:60000,  seña:true,  pct:10,      categoria:'Color' },
  { id:9,  nombre:'Color entero',         precio:90000,  seña:true,  pct:10,      categoria:'Color' },
  { id:10, nombre:'Contorno',             precio:80000,  seña:true,  pct:10,      categoria:'Color' },
  { id:11, nombre:'Balayage',             precio:200000, seña:true,  pct:15, consulta:true, categoria:'Color' },
  { id:12, nombre:'Decoloración total',   precio:200000, seña:true,  pct:15, consulta:true, categoria:'Color' },
  { id:13, nombre:'Peinado fiesta / 15',  precio:70000,  seña:true,  pct:10,      categoria:'Peinados' },
  { id:14, nombre:'Peinado novia',        precio:150000, seña:true,  pct:15,      categoria:'Peinados' },
];

function findByName(nombre) {
  if (!nombre) return null;
  return SERVICIOS.find(s => s.nombre === nombre) ||
    SERVICIOS.find(s => s.nombre.toLowerCase().includes(nombre.toLowerCase())) ||
    null;
}

function findById(id) {
  return SERVICIOS.find(s => s.id === id) || null;
}

function getPrice(nombre) {
  const srv = findByName(nombre);
  return srv?.precio || 0;
}

module.exports = SERVICIOS;
module.exports.findByName = findByName;
module.exports.findById   = findById;
module.exports.getPrice   = getPrice;
