const byteLimit = 2 * 1024 * 1024;
const vertexLimit = 12000;
const segmentLimit = 128;
const earthRadius = 6371008.8;
const radians = degrees => degrees * Math.PI / 180;

function point(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    throw Error('O arquivo contém coordenadas inválidas.');
  }
  return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
}

function decimal(text) {
  const token = String(text ?? '').trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) ? Number(token) : NaN;
}

export function distanceBetween([lng1, lat1], [lng2, lat2]) {
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lng2 - lng1) / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function lengthOf(line) {
  return line.slice(1).reduce((sum, vertex, index) => sum + distanceBetween(line[index], vertex), 0);
}

function joinSegments(segments) {
  if (segments.length > segmentLimit) throw Error('O arquivo contém mais de 128 trechos.');
  const line = [];
  let count = 0;
  for (const segment of segments) {
    count += segment.length;
    if (count > vertexLimit || segment.length < 2) throw Error('O arquivo excede 12 mil vértices ou contém um trecho incompleto.');
    for (const [index, vertex] of segment.entries()) {
      if (!Array.isArray(vertex) || vertex.length < 2 || vertex.length > 3) throw Error('Coordenada sem longitude e latitude válidas.');
      const xy = point(vertex[0], vertex[1]);
      const previous = line.at(-1);
      if (previous && previous[0] === xy[0] && previous[1] === xy[1]) continue;
      if (previous && index === 0) throw Error('Há trechos desconectados. Separe o arquivo por percurso antes de importar.');
      line.push(xy);
    }
  }
  if (line.length < 2) throw Error('O arquivo precisa conter um trajeto contínuo com pelo menos dois vértices distintos.');
  return line;
}

function collectGeoJson(text) {
  let root;
  try { root = JSON.parse(text); } catch { throw Error('O GeoJSON não pôde ser lido.'); }
  if (!root || Object.hasOwn(root, 'crs')) throw Error('Use GeoJSON em WGS84, com longitude antes da latitude.');
  const objects = root.type === 'FeatureCollection' ? root.features : [root];
  if (!Array.isArray(objects) || objects.length > segmentLimit) throw Error('O GeoJSON contém feições demais.');
  const segments = [];
  for (const item of objects) {
    const shape = item?.type === 'Feature' ? item.geometry : item;
    if (shape?.type === 'Point' || shape?.type === 'MultiPoint') continue;
    if (!shape || Object.hasOwn(shape, 'crs') || !Array.isArray(shape.coordinates)) throw Error('Geometria GeoJSON inválida.');
    if (shape.type === 'LineString') segments.push(shape.coordinates);
    else if (shape.type === 'MultiLineString') {
      for (const line of shape.coordinates) {
        if (segments.length >= segmentLimit || !Array.isArray(line)) throw Error('O GeoJSON contém trechos demais ou estrutura inválida.');
        segments.push(line);
      }
    } else throw Error('Use LineString ou MultiLineString para o trajeto.');
  }
  return segments;
}

function collectXml(text, format) {
  if (/<!\s*(?:doctype|entity)\b/i.test(text)) throw Error('O arquivo XML contém declarações proibidas.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (root.localName !== format || doc.querySelector('parsererror')) throw Error('O arquivo ' + format.toUpperCase() + ' não pôde ser lido.');
  const ns = root.namespaceURI;
  if (format === 'gpx' && ns && !/^http:\/\/www\.topografix\.com\/GPX\/1\/[01]$/.test(ns) ||
      format === 'kml' && ns && ns !== 'http://www.opengis.net/kml/2.2') throw Error('O arquivo usa um formato XML incompatível.');
  const children = (element, name) => [...element.children].filter(child => child.localName === name && child.namespaceURI === ns);
  if (format === 'gpx') {
    const tracks = children(root, 'trk').flatMap(track => children(track, 'trkseg'));
    const routes = children(root, 'rte');
    if (tracks.length + routes.length > segmentLimit) throw Error('O GPX contém trechos demais.');
    return [...tracks.map(segment => children(segment, 'trkpt')), ...routes.map(route => children(route, 'rtept'))]
      .map(segment => segment.map(node => [decimal(node.getAttribute('lon')), decimal(node.getAttribute('lat'))]));
  }
  const lines = [...root.getElementsByTagNameNS(ns, 'LineString')];
  if (lines.length > segmentLimit) throw Error('O KML contém trechos demais.');
  return lines.map(line => {
    const value = children(line, 'coordinates')[0]?.textContent.trim() || '';
    return value ? value.split(/\s+/u).map(tuple => tuple.split(',').map(decimal)) : [];
  });
}

export async function readTrack(file) {
  if (!file?.size || file.size > byteLimit) throw Error('Escolha um arquivo de até 2 MiB.');
  const extension = file.name.split('.').at(-1).toLowerCase();
  if (!['gpx', 'kml', 'geojson', 'json'].includes(extension)) throw Error('Use um arquivo GPX, KML ou GeoJSON.');
  const bytes = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Error('Exporte o arquivo novamente em UTF-8.'); }
  const line = joinSegments(extension === 'gpx' || extension === 'kml' ? collectXml(text, extension) : collectGeoJson(text));
  return { line, distance: lengthOf(line), format: extension === 'json' ? 'geojson' : extension };
}

export function nearestVertex(line, [lat, lng]) {
  let index = -1, gap = Infinity;
  for (const [i, coordinate] of line.entries()) {
    const distance = distanceBetween(coordinate, [lng, lat]);
    if (distance < gap) { index = i; gap = distance; }
  }
  return { index, gap };
}

export function measureImported(track, indexes) {
  if (indexes.length < 2 || indexes.some((index, i) =>
    !Number.isInteger(index) || index < 0 || index >= track.line.length || (i > 0 && index <= indexes[i - 1]))) {
    throw Error('Associe todos os itens a vértices distintos, na ordem do percurso.');
  }
  const first = indexes[0];
  const coordinates = track.line.slice(first, indexes.at(-1) + 1);
  const legs = indexes.slice(1).map((end, i) => ({
    endIndex: end - first, distance: lengthOf(track.line.slice(indexes[i], end + 1)), duration: null,
  }));
  return { geometry: { type: 'LineString', coordinates }, legs, distance: lengthOf(coordinates),
    duration: null, provider: 'arquivo-' + track.format };
}
