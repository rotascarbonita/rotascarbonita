import { center, coordinates, legDistances, osmTiles, roadProvider } from './route-map-routing.mjs?v=2';

const colors = ['#1351b4', '#8c3d0b', '#006b60', '#773c93', '#ad154c', '#355617'];
const distance = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const updateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
const km = meters => distance.format(meters / 1000) + ' km';
function duration(seconds) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = total % 60;
  return [hours && hours + ' h', minutes && minutes + ' min', (remainder || !total) && remainder + ' s']
    .filter(Boolean).join(' ');
}
const urbanZoom = 15;
const mapIcons = {
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  exit: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  location: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a7.5 7.5 0 0 1 12-3l3 3M4 15l3 3a7.5 7.5 0 0 0 12-3"/>',
  school: '<path d="m3 10 9-6 9 6v10H3z"/><path d="M10 20v-6h4v6M7 12h1m8 0h1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
const mapIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${mapIcons[name]}</svg>`;
const pointKinds = { stop: 'Embarque', school: 'Escola', via: 'Passagem' };

function pointNumbers(list) {
  let number = 0;
  return list.map(point => point.kind === 'stop' ? ++number : '');
}

function pin(point, number) {
  return `<span class="rm-pin rm-pin-${point.kind}" aria-hidden="true">${point.kind === 'stop'
    ? `<svg viewBox="0 0 32 42" aria-hidden="true" focusable="false"><path d="M16 40C12 34 2 25 2 16a14 14 0 0 1 28 0c0 9-10 18-14 24Z" fill="currentColor" stroke="white" stroke-width="2"/><text x="16" y="20" text-anchor="middle" fill="white">${number}</text></svg>`
    : point.kind === 'school' ? mapIcon('school') : ''}</span>`;
}
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const waypointKey = ({ kind, id }) => JSON.stringify([kind, id]);
const stateLabels = { draft: 'Rascunho', calculated: 'Calculado', validated: 'Validado' };
let library;
const assets = new Map();

function asset(path, type) {
  if (assets.has(path)) return assets.get(path);
  const loading = new Promise((resolve, reject) => {
    const element = document.createElement(type);
    const url = new URL(path, import.meta.url).href;
    element.onload = resolve;
    element.onerror = () => { element.remove(); reject(Error('Não foi possível carregar o mapa.')); };
    if (type === 'link') {
      element.rel = 'stylesheet';
      element.href = url;
    } else {
      element.src = url;
    }
    document.head.append(element);
  });
  assets.set(path, loading);
  loading.catch(() => assets.delete(path));
  return loading;
}

async function leaflet() {
  library ??= Promise.allSettled([
    asset('./leaflet/leaflet.css', 'link'),
    asset('./route-map.css?v=9', 'link'),
    asset('./leaflet/leaflet.js', 'script'),
  ]).then(results => {
    if (results.some(item => item.status === 'rejected') || !window.L) {
      library = undefined;
      throw Error('Não foi possível carregar o mapa. Tente novamente.');
    }
    return window.L;
  });
  return library;
}

export function createWorkspace() {
  return { plans: new Map(), pending: new Map(), cache: new Map(), nextPassage: 1 };
}

function institutionalRouter(endpoint) {
  if (!endpoint || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return null;
  try {
    const url = new URL(endpoint);
    if (url.origin !== location.origin || url.pathname !== '/osrm/' ||
        url.username || url.password || url.search || url.hash) return null;
    return roadProvider(url, 'OSRM local');
  } catch { return null; }
}

export function mountRouteMap(root, initialData, workspace, {
  tiles = osmTiles, gateway, institutionalEndpoint,
  provider = institutionalRouter(institutionalEndpoint),
} = {}) {
  const events = new AbortController();
  const markers = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = matchMedia('(max-width: 870px)');
  const sheetStates = ['collapsed', 'middle', 'expanded'];
  let sheetIndex = 1, desktopOpen = true, sheetDrag, suppressSheetClick = false;
  let lastRoad, pinEntrance;
  let locationDot;
  let data = initialData, map, layers, resize, request, disposed = false;
  let routeId = '', schoolId = '', direction = 'out', selected = 0, placing = false;
  let persistenceRequest, drag, readFailed = false, expandedMap = false;
  let imported, importing, linkingTrack = false;
  const saved = new Map();
  const undo = new Map();
  const canEdit = () => data.role === 'secretaria';
  const monitor = data.role === 'monitor';
  const displayDistance = meters => monitor && meters < 1000 ? distance.format(Math.round(meters)) + ' m' : km(meters);
  const displayDuration = seconds => monitor
    ? '≈ ' + (seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0) + ' min'
    : duration(seconds);
  const directions = monitor ? { out: 'Para Escola', back: 'Para Casa' } : { out: 'Ida', back: 'Volta' };
  const unconfigured = 'A rota ainda está sendo configurada pela Secretaria.';
  const isEditable = () => canEdit() && (!gateway || (Boolean(entry()) && !persistenceRequest));
  const routes = () => data.routes.filter(route => !schoolId || route.schoolIds.includes(schoolId));
  const route = () => routes().find(item => item.id === routeId);
  const key = (id = routeId, way = direction) => JSON.stringify([id, way, scope()]);
  const scope = () => canEdit() && route()?.schoolIds.length > 1 ? schoolId : '';
  const entry = () => saved.get(key());
  const selection = () => ({ routeId, direction, schoolScope: scope() });
  const get = selector => root.querySelector(selector);
  const tell = message => { get('.rm-status').textContent = message; };
  const closePersistence = () => { persistenceRequest?.abort(); persistenceRequest = undefined; };
  const draft = ({ points, road, status, journeys, observedSeconds, corrections }) =>
    ({ points, road, status, journeys, observedSeconds, corrections });

  function remember() {
    const history = undo.get(key()) || [];
    undo.set(key(), [...history.slice(-19), draft(entry())]);
    workspace.pending.set(key(), entry());
  }

  async function readPlan(refresh = false) {
    closePersistence();
    readFailed = false;
    if (!gateway || !route()) {
      render();
      fit();
      if (!route()) tell(canEdit() ? 'Nenhuma rota ativa disponível para este perfil e ano letivo.' : unconfigured);
      return;
    }
    const id = key();
    const pending = !refresh && canEdit() ? workspace.pending.get(id) : null;
    saved.delete(id);
    const controller = new AbortController();
    persistenceRequest = controller;
    render();
    tell(canEdit() ? 'Carregando percurso salvo…' : 'Carregando rota…');
    try {
      const result = await gateway('read', selection(), controller.signal);
      if (persistenceRequest !== controller || disposed) return;
      const stored = canEdit() || result.plan?.status === 'validated' ? result.plan : null;
      const state = {
        plan: stored, revision: stored?.revision || 0, status: stored?.status || 'draft',
        road: stored?.road || null, journeys: stored?.journeys ?? 1,
        observedSeconds: stored?.observedSeconds ?? null, coordinates: result.coordinates,
        metrics: result.metrics || {}, corrections: [],
      };
      if (refresh) { workspace.pending.delete(id); undo.delete(id); }
      if (pending?.revision === state.revision) {
        Object.assign(state, draft(pending));
        workspace.pending.set(id, state);
      }
      saved.set(id, state);
      tell(pending && pending.revision !== state.revision
        ? 'Outra sessão salvou uma revisão enquanto este rascunho estava aberto. Foi carregada a versão do servidor.'
        : stored ? '' : canEdit() ? 'Ainda não há percurso salvo. Selecione um ponto ou escola existente para informar a localização.' : unconfigured);
    } catch (error) {
      if (!disposed && persistenceRequest === controller) {
        readFailed = true;
        tell(canEdit() ? error.message || 'Percurso indisponível.' : 'Não foi possível carregar a rota.');
      }
    } finally {
      if (!disposed && persistenceRequest === controller) {
        persistenceRequest = undefined;
        render();
        fit();
      }
    }
  }

  async function persist(validate = false) {
    if (!gateway || !isEditable() || !route()) return;
    const state = entry();
    const list = plan();
    const status = validate ? 'validated' : state.status;
    if (validate && (!state.road || !get('[name="verified"]').checked)) return;
    const controller = new AbortController();
    persistenceRequest = controller;
    render();
    tell('Salvando percurso…');
    try {
      const response = await gateway('save', {
        ...selection(), revision: state.revision, status, journeys: state.journeys,
        observedSeconds: state.observedSeconds,
        waypoints: list.map(({ kind, id, position }) => ({ kind, id, position })),
        road: state.road ? {
          geometry: state.road.geometry, legs: state.road.legs.map(({ distance, duration, endIndex }) => ({ distance, duration, endIndex })),
          provider: state.road.provider || 'osrm-institucional',
        } : null,
        coordinateUpdates: state.corrections.map(id => JSON.parse(id)),
      }, controller.signal);
      if (disposed || persistenceRequest !== controller) return;
      state.revision = response.revision;
      state.status = response.status;
      state.plan = { revision: response.revision, waypoints: list, updatedAt: response.updatedAt };
      state.points = list;
      state.corrections = [];
      workspace.pending.delete(key());
      undo.delete(key());
      tell(response.status === 'validated' ? 'Percurso validado e salvo.' : 'Percurso salvo.');
    } catch (error) {
      if (!disposed && persistenceRequest === controller) tell(error.message || 'Não foi possível salvar o percurso.');
    } finally {
      if (!disposed && persistenceRequest === controller) { persistenceRequest = undefined; render(); }
    }
  }

  function plan(id = routeId, way = direction) {
    const currentRoute = data.routes.find(item => item.id === id);
    if (!currentRoute) return [];
    const kinds = [
      ...data.stops.filter(stop => stop.routeId === id).map(stop => ({ ...stop, kind: 'stop' })),
      ...data.schools.filter(school => currentRoute.schoolIds.includes(school.id) &&
        (!scope() || school.id === scope())).map(school => ({ ...school, kind: 'school' })),
    ];
    const state = saved.get(key(id, way));
    if (gateway && (!state || (!canEdit() && !state.plan))) return [];
    const previous = gateway ? state.points ?? state.plan?.waypoints : workspace.plans.get(key(id, way));
    const byId = new Map(kinds.map(point => [waypointKey(point), point]));
    // Retain only drafts whose referenced records remain authorized in this snapshot.
    const list = (previous || []).flatMap(point => {
      if (point.kind === 'via') return [{ ...point, name: point.name || 'Passagem' }];
      const idKey = waypointKey(point);
      const fresh = byId.get(idKey);
      byId.delete(idKey);
      return fresh ? [{ ...fresh, position: point.position }] : [];
    });
    if (gateway && previous) return list;
    const additions = [...byId.values()].map(point => ({
      ...point, position: state?.coordinates?.[point.kind]?.[point.id] || null,
    }));
    if (!previous && way === 'back') additions.reverse();
    return [...list, ...additions];
  }

  function stopRequest() {
    request?.abort();
    request = undefined;
  }

  function save(list) {
    if (!isEditable() || !route()) return;
    stopRequest();
    if (gateway) {
      remember();
      Object.assign(entry(), { points: list, status: 'draft', road: null,
        corrections: (entry().corrections || []).filter(id => list.some(point => waypointKey(point) === id && point.position)) });
    } else {
      const previous = undo.get(key()) || [];
      undo.set(key(), [...previous.slice(-19), plan()]);
      workspace.plans.set(key(), list);
    }
    placing = false;
    get('[name="verified"]').checked = false;
    render();
  }

  function setPosition(position, index = selected) {
    const list = plan();
    if (!isEditable() || !list[index] || !position) return;
    list[index] = { ...list[index], position };
    pinEntrance = waypointKey(list[index]);
    const updateCatalogue = gateway && list[index].kind !== 'via' && get('[name="setReference"]').checked;
    save(list);
    if (updateCatalogue) entry().corrections = [...new Set([...(entry().corrections || []), waypointKey(list[index])])];
    tell('Localização atualizada no rascunho deste sentido.');
  }

  const cacheKey = list => JSON.stringify(list.map(point => point.position?.map(value => value.toFixed(6))));
  function computed(list) {
    if (gateway) return entry()?.road ?? null;
    return list.length > 1 && list.every(point => point.position) ? workspace.cache.get(cacheKey(list)) : null;
  }

  function fit() {
    if (!map) return;
    const list = plan().filter(point => point.position);
    if (!list.length && !imported) map.setView(center, urbanZoom, { animate: false });
    else {
      const road = computed(plan());
      const bounds = window.L.latLngBounds(list.map(point => point.position));
      road?.geometry.coordinates.forEach(([lng, lat]) => bounds.extend([lat, lng]));
      imported?.track.line.forEach(([lng, lat]) => bounds.extend([lat, lng]));
      const [topLeft, bottomRight] = mapPadding();
      map.fitBounds(bounds, { paddingTopLeft: topLeft, paddingBottomRight: bottomRight, maxZoom: 16, animate: false });
    }
  }

  function focusMarker(index) {
    const point = plan()[index];
    if (point?.position && map) {
      keepMarkerVisible(point.position);
      markers.get(index)?.openPopup();
    }
  }

  function keepMarkerVisible(position) {
    const [paddingTopLeft, paddingBottomRight] = mapPadding();
    map.panInside(position, { paddingTopLeft, paddingBottomRight, animate: false });
  }

  function mapPadding() {
    const canvas = get('.rm-canvas');
    const side = get('.rm-side');
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (expandedMap) return [[24, 64], [24, 24]];
    if (narrow.matches) {
      const occupied = canvas.getBoundingClientRect().bottom - side.getBoundingClientRect().top;
      return [[24, 60], [24, Math.max(24, Math.min(height - 76, occupied + 24))]];
    }
    return [[Math.min(width - 52, side.offsetWidth + 38), 66], [24, 28]];
  }

  function showLocation() {
    const button = get('[data-rm="my-position"]');
    const status = get('.rm-map-feedback');
    if (!map || !navigator.geolocation) {
      status.textContent = 'Localização atual indisponível.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Buscando localização…';
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (disposed) return;
      const position = coordinates(coords.latitude, coords.longitude);
      button.disabled = false;
      if (!position) { status.textContent = 'Localização atual indisponível.'; return; }
      locationDot?.remove();
      locationDot = window.L.circleMarker(position, { radius: 8, color: '#fff', weight: 3,
        fillColor: '#1351b4', fillOpacity: 1, interactive: false }).addTo(map);
      map.setView(position, Math.max(map.getZoom(), urbanZoom), { animate: false });
      status.textContent = 'Localização atual exibida no mapa.';
    }, () => {
      if (disposed) return;
      button.disabled = false;
      status.textContent = 'Permita a localização no navegador ou navegue pelo mapa.';
    }, { timeout: 10000 });
  }

  function draw(list = plan(), result = computed(list), numbers = pointNumbers(list),
    distances = result ? legDistances(result.legs, list) : []) {
    if (!map) return;
    const L = window.L;
    const animateRoad = result && result.geometry !== lastRoad && !result.provider?.startsWith('arquivo-');
    lastRoad = result?.geometry;
    layers.clearLayers();
    markers.clear();
    const color = colors[data.routes.findIndex(item => item.id === routeId) % colors.length] || colors[0];
    if (imported?.reference && result?.provider?.startsWith('arquivo-')) {
      L.geoJSON(imported.reference.geometry, { style: { color, weight: 5, opacity: .72 }, interactive: false }).addTo(layers);
    }
    if (result) {
      const file = result.provider?.startsWith('arquivo-');
      const road = L.geoJSON(result.geometry, { style: { color: file ? '#7d286f' : color, weight: 5,
        className: 'rm-road-line', opacity: 0.9, dashArray: file ? '8 6' : null }, interactive: false }).addTo(layers);
      if (animateRoad && !reducedMotion.matches) {
        requestAnimationFrame(() => road.eachLayer(line => {
          const path = line.getElement();
          if (!path?.isConnected || reducedMotion.matches) return;
          const length = path.getTotalLength();
          if (!length) return;
          path.style.setProperty('--rm-path-length', String(length));
          path.classList.add('rm-road-enter');
          path.addEventListener('animationend', () => path.classList.remove('rm-road-enter'), { once: true });
        }));
      }
    }
    if (imported) L.geoJSON({ type: 'LineString', coordinates: imported.track.line },
      { style: { color: '#7d286f', weight: 4, dashArray: '8 6' }, smoothFactor: 1.5, interactive: false }).addTo(layers);
    for (const [index, point] of list.entries()) {
      if (!point.position || (!canEdit() && point.kind === 'via')) continue;
      const popup = document.createElement('div');
      popup.className = 'rm-popup';
      const roadLeg = result?.legs[index];
      const rows = distances[index]?.remaining.slice(point.kind === 'school' ? 1 : 0) || [];
      popup.innerHTML = `<small>${pointKinds[point.kind]}${numbers[index] ? ' ' + numbers[index] : ''}</small>
        <strong>${h(point.name)}</strong>
        ${rows.map(school => `<div>Até ${h(school.name)} <b>${displayDistance(school.distance)}</b></div>`).join('')}
        ${canEdit() && roadLeg ? `<div>Até o próximo ponto <b>${km(roadLeg.distance)}</b></div>
          ${Number.isFinite(roadLeg.duration) ? `<div>Tempo estimado do trecho <b>${duration(roadLeg.duration)}</b></div>` : ''}`
          : !result ? '<div>Distâncias e tempo ainda indisponíveis.</div>' : ''}`;
      const marker = L.marker(point.position, {
        icon: L.divIcon({ html: pin(point, numbers[index]), className: 'rm-marker', iconSize: [44, 44],
          iconAnchor: point.kind === 'stop' ? [22, 42] : [22, 22], popupAnchor: point.kind === 'stop' ? [0, -39] : [0, -13] }),
        title: point.name, alt: point.name, draggable: isEditable(),
      }).addTo(layers).bindPopup(popup, { maxWidth: 254, keepInView: false });
      marker.on('popupopen', ({ popup: panel }) => {
        const [topLeft, bottomRight] = mapPadding();
        panel.options.autoPanPaddingTopLeft = topLeft;
        panel.options.autoPanPaddingBottomRight = bottomRight;
        panel.update();
      });
      markers.set(index, marker);
      const markerElement = marker.getElement();
      markerElement?.setAttribute('aria-label', point.name);
      markerElement?.addEventListener('focus', () => keepMarkerVisible(marker.getLatLng()));
      if (pinEntrance === waypointKey(point)) markerElement?.classList.add('rm-pin-enter');
      marker.on('click', () => { selected = index; render(false); });
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        selected = index;
        setPosition(coordinates(lat, lng), index);
      });
    }
    pinEntrance = undefined;
  }

  function render(redraw = true) {
    const available = routes();
    if (!available.some(item => item.id === routeId)) routeId = available[0]?.id || '';
    get('[data-rm-school]').innerHTML = '<option value="">Todas as escolas</option>' +
      data.schools.map(school => `<option value="${h(school.id)}">${h(school.name)}</option>`).join('');
    get('[data-rm-school]').value = schoolId;
    get('[data-rm-school]').parentElement.hidden = !canEdit();
    get('[data-rm-route]').innerHTML = available.length
      ? available.map(item => `<option value="${h(item.id)}">${h(item.name)}</option>`).join('')
      : '<option value="">Nenhuma rota disponível</option>';
    get('[data-rm-route]').value = routeId;
    get('[data-rm-route]').disabled = !available.length;
    get('[data-rm-route]').parentElement.hidden = !canEdit() && available.length <= 1;
    const currentRoute = get('.rm-current-route');
    currentRoute.hidden = canEdit() || available.length !== 1;
    currentRoute.textContent = route()?.name || '';
    get('.rm-selection').hidden = !canEdit() && !available.length;
    for (const button of root.querySelectorAll('[data-rm-direction]')) {
      button.setAttribute('aria-pressed', String(button.dataset.rmDirection === direction));
    }
    const list = plan();
    selected = Math.min(selected, Math.max(0, list.length - 1));
    const point = list[selected];
    const result = computed(list);
    const numbers = pointNumbers(list);
    const distances = result ? legDistances(result.legs, list) : [];
    const state = entry();
    const other = gateway ? null : computed(plan(routeId, direction === 'out' ? 'back' : 'out'));
    const visibleKinds = new Set(list.filter(item => item.position).map(item => item.kind));
    const routeColor = colors[data.routes.indexOf(route()) % colors.length];
    const fileLine = result?.provider?.startsWith('arquivo-');
    const legend = get('.rm-legend');
    legend.innerHTML =
      (route() && (visibleKinds.size || result || imported) ? `<strong>${h(route().name)}</strong>` : '') +
      Object.entries(pointKinds).filter(([kind]) => visibleKinds.has(kind))
        .map(([kind, name]) => `<span>${pin({ kind }, '')}${name}</span>`).join('') +
      (result && !fileLine || fileLine && imported?.reference
        ? `<span><i style="--pin-color:${routeColor}"></i>Percurso calculado</span>` : '') +
      (imported || fileLine ? '<span><i class="rm-file-swatch"></i> Traçado do arquivo</span>' : '');
    legend.hidden = !canEdit() || !legend.firstChild;
    const importedItem = point && imported?.matches.get(waypointKey(point));
    get('.rm-import').hidden = !isEditable() || !route();
    get('.rm-track-actions').hidden = !imported;
    get('[data-rm="import-link"]').disabled = !point;
    get('[data-rm="import-link"]').setAttribute('aria-pressed', String(linkingTrack));
    get('[data-rm="import-nearest"]').disabled = !point?.position;
    get('[data-rm="import-index"]').disabled = !point;
    get('[name="trackVertex"]').max = imported?.track.line.length || 1;
    get('[name="trackVertex"]').value = importedItem ? importedItem.index + 1 : '';
    get('[data-rm="import-use"]').disabled = list.length < 2;
    get('.rm-track-summary').textContent = imported
      ? km(imported.track.distance) + ' medidos ao longo do arquivo · ' +
        list.filter(item => imported.matches.has(waypointKey(item))).length + '/' + list.length + ' itens associados' +
        (importedItem ? ' · Selecionado no vértice ' + (importedItem.index + 1) : '') +
        (imported.reference ? ' · OSRM ' + km(imported.reference.distance) : '')
      : '';
    const editor = get('.rm-editor');
    editor.hidden = !canEdit() || !route();
    get('[data-rm="pick"]').hidden = editor.hidden;
    const showConsultation = canEdit() || Boolean(state?.plan);
    get('.rm-consultation-summary').hidden = canEdit() || !state?.plan;
    get('.rm-point-list').hidden = !showConsultation;
    get('.rm-point-rows').innerHTML = list.map((item,i) =>
      !canEdit() && item.kind !== 'stop' && !(monitor && item.kind === 'school') ? '' :
      `<li data-rm-row="${i}"><button type="button" data-rm-index="${i}" aria-pressed="${i === selected}">${pin(item, numbers[i])}
      <span><strong>${h(item.name)}</strong><small>${monitor && item.kind === 'school' ? 'Escola atendida' : pointKinds[item.kind]}${numbers[i] ? ' ' + numbers[i] : ''}
      ${item.position ? '' : ' · <b class="rm-missing">Sem localização</b>'}</small>
      ${canEdit() ? '' : (distances[i]?.remaining.slice(item.kind === 'school' ? 1 : 0) || []).map(school =>
        `<small>Até ${h(school.name)} · ${displayDistance(school.distance)}</small>`).join('')}</span></button>
      ${isEditable() ? '<span class="rm-handle" data-rm-handle aria-hidden="true" title="Arraste para reordenar">⠿</span>' : ''}</li>`).join('');
    filterPoints();
    if (canEdit()) {
      editor.querySelector('fieldset').disabled = !point || !isEditable();
      editor.querySelector('[name="lat"]').value = point?.position?.[0]?.toFixed(6) ?? '';
      editor.querySelector('[name="lng"]').value = point?.position?.[1]?.toFixed(6) ?? '';
      get('[data-rm="up"]').disabled = selected === 0;
      get('[data-rm="down"]').disabled = selected >= list.length - 1;
      get('[data-rm="add"]').disabled = !isEditable() || list.length >= 40;
      get('[data-rm="remove"]').hidden = !point || (!gateway && point.kind !== 'via');
      const addSchool = get('[name="addSchool"]');
      addSchool.innerHTML = '<option value="">Adicionar escola vinculada</option>' + data.schools
        .filter(school => route()?.schoolIds.includes(school.id) && (!scope() || school.id === scope()) &&
          !list.some(item => item.kind === 'school' && item.id === school.id))
        .map(school => `<option value="${h(school.id)}">${h(school.name)}</option>`).join('');
      addSchool.disabled = !isEditable() || list.length >= 40 || addSchool.options.length < 2;
      const addStop = get('[name="addStop"]');
      addStop.innerHTML = '<option value="">Adicionar ponto da rota</option>' + data.stops
        .filter(stop => stop.routeId === routeId && !list.some(item => item.kind === 'stop' && item.id === stop.id))
        .map(stop => `<option value="${h(stop.id)}">${h(stop.name)}</option>`).join('');
      addStop.disabled = !isEditable() || list.length >= 40 || addStop.options.length < 2;
      get('[data-rm="pick"]').setAttribute('aria-pressed', String(placing));
      get('[data-rm="pick"]').disabled = !point || !isEditable();
      get('.rm-canvas').classList.toggle('rm-picking', placing || linkingTrack);
    }
    const calculateButton = get('[data-rm="calculate"]');
    calculateButton.hidden = !canEdit();
    calculateButton.disabled = !provider || !route() || Boolean(request) || !isEditable();
    get('.rm-provider').textContent = provider?.label || '';
    get('.rm-provider').hidden = !provider;
    get('.rm-routing-help').hidden = !canEdit();
    const refresh = get('[data-rm="load"]');
    refresh.disabled = Boolean(persistenceRequest) || !route();
    refresh.hidden = !gateway || (!canEdit() && !route());
    if (!canEdit()) {
      const label = readFailed ? 'Tentar novamente' : monitor ? 'Atualizar mapa' : 'Atualizar rota';
      refresh.querySelector('span').textContent = label;
      refresh.setAttribute('aria-label', label);
      refresh.title = label;
      refresh.querySelector('span').hidden = !monitor && !readFailed;
    }
    get('.rm-persistence').hidden = !gateway || !canEdit();
    get('.rm-advanced').hidden = !canEdit();
    get('.rm-technical').hidden = !canEdit();
    get('.rm-preview').hidden = !canEdit();
    get('.rm-revision').hidden = !canEdit();
    get('[data-rm="undo"]').disabled = !isEditable() || !undo.get(key())?.length;
    get('.rm-schedule fieldset').disabled = !isEditable();
    get('[data-rm="persist"]').disabled = !isEditable();
    get('[name="journeys"]').value = state?.journeys ?? 1;
    get('[name="observed"]').value = state?.observedSeconds ?? '';
    get('[data-rm="validate"]').disabled = !isEditable() || !state?.road || !get('[name="verified"]').checked;
    const badge = get('.rm-state');
    const status = state?.status || (result ? 'calculated' : 'draft');
    if (badge.dataset.state !== status) {
      badge.dataset.state = status;
      badge.textContent = stateLabels[status];
    }
    get('.rm-scope').textContent = state
      ? [canEdit() ? (scope() ? 'Versão da escola selecionada' : 'Versão geral') : '',
        workspace.pending.has(key()) ? 'Alterações locais' : ''].filter(Boolean).join(' · ') : '';
    const timestamp = new Date(state?.plan?.updatedAt);
    get('.rm-revision').textContent = state?.revision && Number.isFinite(+timestamp)
      ? 'Revisão ' + state.revision + ' · ' + updateTime.format(timestamp) : '';
    const stops = numbers.filter(Boolean).length;
    const schools = list.filter(item => item.kind === 'school');
    get('.rm-preview-count').textContent = `${stops} ${stops === 1 ? 'embarque' : 'embarques'} · ${schools.length} ${schools.length === 1 ? 'escola' : 'escolas'}`;
    const routeName = route()?.name;
    get('.rm-sheet-route').textContent = routeName ? routeName + ' · ' + directions[direction] : 'Nenhuma rota disponível';
    const sheetCounts = get('.rm-sheet-counts');
    sheetCounts.textContent = canEdit() && routeName ? get('.rm-preview-count').textContent : '';
    const sheetSchools = get('.rm-sheet-schools');
    sheetSchools.textContent = schools.map(item => item.name).join(' · ');
    sheetSchools.title = sheetSchools.textContent;
    get('.rm-sheet-metrics').textContent = result ? [
      Number.isFinite(result.distance) && displayDistance(result.distance),
      Number.isFinite(result.duration) && displayDuration(result.duration),
    ].filter(Boolean).join(' · ') : '';
    get('.rm-consultation-summary').innerHTML = result ? `<dl>
      <div><dt>Distância total</dt><dd>${displayDistance(result.distance)}</dd></div>
      ${Number.isFinite(result.duration) ? `<div><dt>Tempo estimado</dt><dd>${displayDuration(result.duration)}</dd></div>` : ''}</dl>` : '';
    get('.rm-preview-total').textContent = result ? km(result.distance) : '—';
    const destinations = get('.rm-preview-schools');
    destinations.hidden = !schools.length;
    destinations.textContent = schools.map(item => item.name).join(' · ');
    get('.rm-summary').innerHTML = result
      ? `<strong>${km(result.distance)}</strong> · ${Number.isFinite(result.duration) ? duration(result.duration) + ' estimados' : 'Tempo indisponível'}<br>
        ${other ? `Ida e volta <strong>${km(result.distance + other.distance)}</strong>` : 'Calcule o outro sentido para ver a quilometragem total.'}`
      : 'Sem trajeto calculado para este sentido.';
    if (gateway) {
      const metrics = { ...state?.metrics, [direction]: { distance: result?.distance, journeys: state?.journeys } };
      const out = metrics.out, back = metrics.back;
      const item = value => Number.isFinite(value?.distance)
        ? km(value.distance) + (value.provider?.startsWith('arquivo-') ? ' medidos' : ' estimados') + ' × ' + value.journeys : '—';
      metrics[direction].provider = result?.provider;
      const known = [out, back].every(value => value && (value.journeys === 0 || Number.isFinite(value.distance)));
      const daily = known ? km([out, back].reduce((sum, value) => sum + (value.distance || 0) * value.journeys, 0)) : '—';
      get('.rm-summary').innerHTML = `<dl><div><dt>Ida</dt><dd>${item(out)}</dd></div>
        <div><dt>Volta</dt><dd>${item(back)}</dd></div>
        <div><dt>Total diário</dt><dd>${daily}</dd></div>
        <div><dt>Tempo estimado</dt><dd>${Number.isFinite(result?.duration) ? duration(result.duration) : '—'}</dd></div>
        <div><dt>Tempo registrado</dt><dd>${Number.isFinite(state?.observedSeconds) ? duration(state.observedSeconds) : '—'}</dd></div></dl>`;
    }
    get('.rm-breakdown').hidden = !canEdit() || !result;
    get('.rm-results').innerHTML = result ? distances.map(row =>
      `<li><strong>${h(row.point.name)}</strong><span>Trecho ${km(row.leg)} · Acumulado ${km(row.accumulated)}</span>
        ${row.remaining.map(school => `<span>Até ${h(school.name)} · ${km(school.distance)}</span>`).join('')}</li>`).join('') : '';
    if (redraw) draw(list, result, numbers, distances);
    for (const [index, marker] of markers) marker.getElement()?.classList.toggle('rm-marker-selected', index === selected);
    syncDisclosure();
  }

  async function calculate() {
    const list = plan();
    if (!provider || !route() || request || !isEditable()) return;
    if (list.length < 2 || list.some(point => !point.position) || !list.some(point => point.kind === 'school')) {
      tell('Localize todos os pontos do percurso, incluindo pelo menos uma escola.');
      return;
    }
    if (list.length > 40) { tell('A homologação aceita até 40 paradas e passagens por percurso.'); return; }
    const id = cacheKey(list);
    if (workspace.cache.has(id)) {
      storeRoad(workspace.cache.get(id)); render(); tell('Trajeto recuperado desta sessão.'); fit(); return;
    }
    const controller = new AbortController();
    request = controller;
    const timer = setTimeout(() => controller.abort('timeout'), 12000);
    get('[data-rm="calculate"]').disabled = true;
    tell('Calculando pela malha viária…');
    try {
      const result = await provider.calculate(list.map(point => point.position), controller.signal);
      if (request !== controller || disposed || controller.signal.aborted) return;
      if (workspace.cache.size >= 32) workspace.cache.delete(workspace.cache.keys().next().value);
      workspace.cache.set(id, result);
      storeRoad(result);
      tell('Trajeto calculado. Valide as ruas e a adequação para o ônibus escolar.');
      fit();
    } catch (error) {
      if (request !== controller || disposed) return;
      tell(controller.signal.reason === 'timeout' || error instanceof TypeError
        ? 'Sem resposta do roteador. Verifique a conexão ou tente novamente.' : error.message);
    } finally {
      clearTimeout(timer);
      if (request === controller && !disposed) { request = undefined; render(); }
    }
  }

  function associate(position) {
    const point = plan()[selected];
    if (!isEditable() || !imported || !point || !position) return;
    const match = imported.reader.nearestVertex(imported.track.line, position);
    if (match.gap > 150) { tell('Escolha uma posição a até 150 m de um vértice do arquivo.'); return; }
    associateVertex(match.index);
  }

  function associateVertex(index) {
    const point = plan()[selected];
    if (!isEditable() || !point || !imported?.track.line[index]) return;
    imported.matches.set(waypointKey(point), { index });
    linkingTrack = false;
    render(false);
    tell(point.name + ' associado ao vértice ' + (index + 1) + '.');
  }

  async function importFile(file) {
    if (!isEditable() || !route() || !file) return;
    const token = {};
    importing = token;
    tell('Lendo arquivo de trajeto…');
    try {
      const reader = await import('./route-map-import.mjs?v=1');
      const track = await reader.readTrack(file);
      if (disposed || importing !== token) return;
      const road = computed(plan());
      imported = { track, reader, matches: new Map(), reference: road?.provider?.startsWith('arquivo-') ? null : road };
      linkingTrack = false;
      render();
      fit();
      tell('Prévia pronta. Associe os itens na ordem do trajeto antes de usar a medição.');
    } catch (error) {
      if (!disposed && importing === token) tell(error.message || 'Não foi possível ler o arquivo.');
    }
  }

  function storeRoad(road) {
    if (!gateway) return;
    if (imported && !road.provider?.startsWith('arquivo-')) imported.reference = road;
    remember();
    Object.assign(entry(), { road, status: 'calculated' });
    get('[name="verified"]').checked = false;
  }

  const actions = {
    fit,
    calculate,
    pick() {
      linkingTrack = false;
      placing = !placing;
      render(false);
      if (placing && narrow.matches) {
        setPanel(0);
        get('.rm-canvas').focus({ preventScroll: true });
      }
      get('.rm-map-feedback').textContent = placing ? 'Toque no mapa para marcar a localização.' : '';
      tell(placing ? 'Clique no mapa para posicionar o item selecionado.' : 'Posicionamento cancelado.');
    },
    locate() {
      if (!navigator.geolocation) { tell('Localização indisponível neste navegador.'); return; }
      const original = [key(), plan()[selected]?.id, selected];
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          if (!disposed && key() === original[0] && plan()[original[2]]?.id === original[1]) {
            setPosition(coordinates(coords.latitude, coords.longitude), original[2]);
          }
        },
        () => { if (!disposed) tell('Localização não concedida ou indisponível. Use o mapa ou digite as coordenadas.'); },
        { maximumAge: 0, timeout: 12000 },
      );
    },
    add() {
      const next = plan();
      const id = gateway ? crypto.randomUUID() : String(workspace.nextPassage++);
      next.splice(selected + 1, 0, { id, name: 'Passagem', kind: 'via', position: null });
      selected = Math.min(selected + 1, next.length - 1);
      save(next);
      get('[data-rm-index="' + selected + '"]')?.focus();
    },
    remove() {
      const next = plan();
      if (!next[selected] || (!gateway && next[selected].kind !== 'via')) return;
      next.splice(selected, 1);
      save(next);
      get('[data-rm="add"]').focus();
    },
    up() { move(-1); },
    down() { move(1); },
    undo() {
      const previous = undo.get(key())?.pop();
      if (!previous) return;
      stopRequest();
      if (gateway) Object.assign(entry(), previous);
      else workspace.plans.set(key(), previous);
      get('[name="verified"]').checked = false;
      render();
      tell('Última alteração desfeita.');
    },
    persist() { void persist(); },
    validate() { void persist(true); },
    load() {
      if (!workspace.pending.has(key()) || confirm('Descartar alterações locais e ler a versão salva?')) void readPlan(true);
    },
    fullscreen: toggleFullscreen,
    'my-position': showLocation,
    'import-link'() {
      if (!imported) return;
      linkingTrack = !linkingTrack;
      placing = false;
      render(false);
      tell(linkingTrack ? 'Clique próximo ao vértice do trajeto importado.' : 'Associação cancelada.');
    },
    'import-nearest'() { associate(plan()[selected]?.position); },
    'import-index'() {
      const field = get('[name="trackVertex"]');
      if (!field.value || !field.validity.valid) { tell('Informe um vértice válido para o item selecionado.'); return; }
      associateVertex(Number(field.value) - 1);
    },
    'import-use'() {
      if (!imported || !gateway) return;
      try {
        const list = plan();
        if (!list.some(point => point.kind === 'school')) throw Error('Inclua ao menos uma escola no percurso.');
        const road = imported.reader.measureImported(imported.track,
          list.map(point => imported.matches.get(waypointKey(point))?.index));
        const items = list.map(point => {
          const [lng, lat] = imported.track.line[imported.matches.get(waypointKey(point)).index];
          return { ...point, position: [lat, lng] };
        });
        stopRequest();
        remember();
        Object.assign(entry(), { points: items, road, status: 'calculated', corrections: [] });
        get('[name="verified"]').checked = false;
        render();
        fit();
        tell('Medição aplicada à edição local entre o primeiro e o último item. Salve a revisão quando estiver pronta.');
      } catch (error) { tell(error.message); }
    },
    'import-clear'() {
      imported = importing = undefined;
      linkingTrack = false;
      render();
      tell('Prévia removida.');
    },
  };

  function move(by) {
    reorder(selected, selected + by);
  }

  function reorder(from, target) {
    if (!isEditable()) return;
    const next = plan();
    if (!next[target]) return;
    const [point] = next.splice(from, 1);
    if (!point) return;
    next.splice(target, 0, point);
    selected = target;
    save(next);
    if (document.activeElement === document.body) get('[data-rm-index="' + selected + '"]')?.focus();
    tell(next[selected].name + ' na posição ' + (selected + 1) + '.');
  }

  function setExpanded(expanded) {
    expandedMap = expanded;
    const area = get('.rm-map-area');
    area.classList.toggle('rm-expanded', expanded);
    if (!reducedMotion.matches) {
      area.getAnimations().filter(animation => animation.id === 'rm-fullscreen').forEach(animation => animation.cancel());
      const transition = area.animate({ opacity: [expanded ? .8 : .9, 1] }, {
        duration: expanded ? 250 : 150, easing: 'cubic-bezier(.22, 1, .36, 1)',
      });
      transition.id = 'rm-fullscreen';
    }
    const button = get('[data-rm="fullscreen"]');
    button.setAttribute('aria-pressed', String(expanded));
    const label = expanded ? 'Sair da tela cheia' : 'Tela cheia';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = mapIcon(expanded ? 'exit' : 'fullscreen');
    get('.rm-side').inert = expanded;
    map?.invalidateSize({ pan: false });
  }

  async function toggleFullscreen() {
    const area = get('.rm-map-area');
    if (document.fullscreenElement === area) { await document.exitFullscreen(); return; }
    if (expandedMap) { setExpanded(false); return; }
    if (area.requestFullscreen) {
      try { await area.requestFullscreen(); return; } catch { if (disposed) return; }
    }
    setExpanded(true);
  }

  function reloadSelection() {
    stopRequest();
    selected = 0;
    placing = false;
    imported = importing = undefined;
    linkingTrack = false;
    lastRoad = undefined;
    get('[name="verified"]').checked = false;
    tell('');
    render();
    void readPlan();
  }

  async function openMap() {
    const retry = get('[data-rm="retry"]');
    retry.hidden = true;
    try {
      const L = await leaflet();
      if (disposed || !root.isConnected) return;
      map = L.map(get('.rm-canvas'), {
        scrollWheelZoom: true, zoomControl: false, zoomAnimation: false,
        fadeAnimation: false, markerZoomAnimation: false, attributionControl: false,
      }).setView(center, urbanZoom);
      L.control.zoom({ position: 'topright', zoomInTitle: 'Aproximar', zoomOutTitle: 'Afastar' }).addTo(map);
      const attribution = L.control.attribution({ prefix: false }).addTo(map);
      const scale = L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      get('.rm-credits').append(scale.getContainer(), attribution.getContainer());
      const tileLayer = L.tileLayer(tiles.url, { attribution: tiles.attribution, maxZoom: 19, minZoom: 3,
        referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
      tileLayer.on('tileerror', () => {
        get('.rm-tile-status').textContent = 'Parte do mapa-base está indisponível. Confira a conexão.';
      });
      tileLayer.on('loading', () => { get('.rm-tile-status').textContent = ''; });
      layers = L.layerGroup().addTo(map);
      map.on('click', ({ latlng }) => {
        const position = coordinates(latlng.lat, latlng.lng);
        if (linkingTrack) associate(position);
        else if (placing) {
          setPosition(position);
          get('.rm-map-feedback').textContent = 'Localização atualizada no rascunho.';
        }
      });
      resize = new ResizeObserver(() => map?.invalidateSize({ debounceMoveend: true }));
      resize.observe(get('.rm-canvas'));
      draw();
      fit();
    } catch (error) {
      if (!disposed) { tell(error.message); retry.hidden = false; }
    }
  }

  root.innerHTML = `
    <div class="rm-layout${canEdit() ? '' : ' rm-consultation'}${monitor ? ' rm-operational' : ''}">
      <section class="rm-map-area" aria-label="Mapa de Carbonita">
        <div class="rm-canvas" tabindex="0" role="region" aria-label="Mapa interativo. Use as setas para mover e mais ou menos para ajustar o zoom."></div>
        <div class="rm-map-buttons">
          <button type="button" data-rm="fit" aria-label="Enquadrar percurso" title="Enquadrar percurso">${mapIcon('fit')}</button>
          <button type="button" data-rm="fullscreen" aria-pressed="false" aria-label="Tela cheia" title="Tela cheia" ${monitor ? 'hidden' : ''}>${mapIcon('fullscreen')}</button>
          <button type="button" data-rm="my-position" aria-label="Minha localização no mapa" title="Minha localização no mapa">${mapIcon('location')}</button>
        </div>
        <p class="rm-tile-status" role="status"></p>
        <p class="rm-map-feedback" role="status"></p>
        <div class="rm-credits" aria-label="Escala e atribuição cartográfica"></div>
      </section>
      <aside class="rm-side" aria-label="Rotas e pontos">
        <button type="button" class="rm-disclosure" aria-expanded="true" aria-controls="rm-controls">
          <span class="rm-panel-title">Rotas e pontos</span>
          <span class="rm-sheet-summary"><strong class="rm-sheet-route"></strong><small class="rm-sheet-counts"></small><small class="rm-sheet-schools"></small><small class="rm-sheet-metrics"></small></span>
          ${mapIcon('chevron')}
        </button>
        <div id="rm-controls" class="rm-fold"><div class="rm-inner"><div class="rm-controls">
          <div class="rm-selection"><strong class="rm-current-route" hidden></strong><div class="rm-filters">
            <label>Escola<select data-rm-school></select></label>
            <label>Rota<select data-rm-route></select></label>
          </div>
          <div class="rm-directions" role="group" aria-label="Sentido">
            <button type="button" class="btn" data-rm-direction="out">${directions.out}</button>
            <button type="button" class="btn" data-rm-direction="back">${directions.back}</button>
          </div></div>
          <div class="rm-legend" aria-label="Legenda"></div>
          <div class="rm-technical"><div class="rm-state-row"><span class="rm-state" role="status"></span><small class="rm-scope"></small></div>
          <small class="rm-revision"></small></div>
          <p class="rm-status" role="status"></p>
          <div class="rm-consultation-summary" aria-label="Resumo da rota"></div>
          <div class="rm-actions rm-primary-actions">
          <button type="button" class="btn" data-rm="pick" hidden>Marcar no mapa</button>
          <button type="button" class="btn primary" data-rm="calculate">Calcular trajeto</button>
          <button type="button" class="btn" data-rm="retry" hidden>Tentar carregar mapa</button>
          </div>
          <div class="rm-persistence">
            <button type="button" class="btn" data-rm="persist">Salvar revisão</button>
            <label><input type="checkbox" name="verified"> Conferi a sequência e as vias com a equipe</label>
            <button type="button" class="btn primary" data-rm="validate">Validar e salvar</button>
          </div>
          <details class="rm-preview" open>
            <summary><span><strong>Resumo do percurso</strong><small class="rm-preview-count"></small></span><span><b class="rm-preview-total"></b>${mapIcon('chevron')}</span></summary>
            <div class="rm-summary" aria-label="Métricas do percurso"></div>
            <p class="rm-preview-schools" aria-label="Escolas atendidas" hidden></p>
          </details>
          <details class="rm-breakdown" hidden><summary>Distâncias por trecho</summary>
            <ol class="rm-results" aria-label="Distâncias do percurso"></ol>
          </details>
          <section class="rm-point-list">
          <div class="rm-list-heading"><h2>${canEdit() || monitor ? 'Pontos do percurso' : 'Pontos de embarque'}</h2></div>
          <label class="rm-search">${canEdit() ? 'Buscar neste percurso' : 'Buscar pontos'}<input type="search" data-rm-search placeholder="${canEdit() ? 'Ponto ou escola' : 'Nome do ponto'}" autocomplete="off"></label>
          <p class="rm-search-count" role="status" hidden></p>
          <ol class="rm-point-rows" aria-label="Sequência do percurso"></ol>
          </section>
          <button type="button" class="btn small rm-refresh" data-rm="load" ${gateway ? '' : 'hidden'}>${mapIcon('refresh')}<span>Atualizar percurso</span></button>
          <details class="rm-advanced"><summary>Configurações avançadas</summary>
          <div class="rm-advanced-body">
          <small class="rm-provider"></small>
          <details class="rm-routing-help">
            <summary>Cálculo no editor administrativo local</summary>
            <ol><li>Inicie o OSRM institucional e abra o editor administrativo local.</li>
              <li>Selecione a mesma rota, escola e sentido.</li>
              <li>Calcule, confira as ruas e salve o percurso no editor.</li></ol>
            <p>O cálculo exige o editor local. Use Atualizar percurso para consultar aqui a versão salva.</p>
          </details>
          <form class="rm-editor">
            <fieldset><legend>Editar item selecionado</legend>
              <div class="rm-actions">
                <button type="button" class="btn small" data-rm="up">Subir</button>
                <button type="button" class="btn small" data-rm="down">Descer</button>
                <button type="button" class="btn small" data-rm="remove" hidden>Retirar da sequência</button>
              </div>
              <div class="rm-filters">
                <label>Latitude<input name="lat" inputmode="decimal" required></label>
                <label>Longitude<input name="lng" inputmode="decimal" required></label>
              </div>
              <label ${gateway ? '' : 'hidden'}><input type="checkbox" name="setReference"> Atualizar também a coordenada de referência do cadastro</label>
              <div class="rm-actions">
                <button type="submit" class="btn small">Aplicar coordenadas</button>
                <button type="button" class="btn small" data-rm="locate">Usar minha localização</button>
              </div>
            </fieldset>
            <div class="rm-filters rm-route-filters" ${gateway ? '' : 'hidden'}>
              <label>Ponto existente<select name="addStop"></select></label>
              <label>Escola de destino<select name="addSchool"></select></label>
            </div>
            <div class="rm-actions">
              <button type="button" class="btn small" data-rm="add">Adicionar passagem</button>
              <button type="button" class="btn small" data-rm="undo">Desfazer</button>
            </div>
          </form>
          <section class="rm-import" aria-label="Importar trajeto">
            <label>Importar GPX, KML ou GeoJSON <input type="file" name="trackFile" accept=".gpx,.kml,.geojson,.json"></label>
            <div class="rm-track-actions" hidden>
              <p class="rm-track-summary" role="status"></p>
              <div class="rm-actions">
                <button type="button" class="btn small" data-rm="import-link" aria-pressed="false">Associar no mapa</button>
                <button type="button" class="btn small" data-rm="import-nearest">Associar pela posição atual</button>
                <button type="button" class="btn small" data-rm="import-use" ${gateway ? '' : 'hidden'}>Usar medição no rascunho</button>
                <button type="button" class="btn small" data-rm="import-clear">Remover prévia</button>
              </div>
              <div class="rm-filters">
                <label>Vértice do item<input type="number" name="trackVertex" min="1" step="1"></label>
                <button type="button" class="btn small" data-rm="import-index">Associar vértice</button>
              </div>
            </div>
          </section>
          <div class="rm-schedule" ${gateway ? '' : 'hidden'}>
            <fieldset><legend>Programação do percurso</legend>
              <div class="rm-filters">
                <label>Viagens por dia neste sentido<input type="number" name="journeys" min="0" max="40" step="1"></label>
                <label>Tempo registrado (s)<input type="number" name="observed" min="1" max="86400" step="1"></label>
              </div>
            </fieldset>
          </div>
          </div></details>
        </div></div></div>
      </aside>
    </div>`;

  const register = (type, listener) => root.addEventListener(type, listener, { signal: events.signal });
  document.addEventListener('fullscreenchange', () => {
    if (!disposed) setExpanded(document.fullscreenElement === get('.rm-map-area'));
  }, { signal: events.signal });
  document.addEventListener('keydown', event => {
    if (!expandedMap) return;
    if (event.key === 'Escape' && !document.fullscreenElement) {
      setExpanded(false);
      get('[data-rm="fullscreen"]').focus();
    }
    if (event.key !== 'Tab') return;
    const targets = [...get('.rm-map-area').querySelectorAll('button, a[href], [tabindex="0"]')]
      .filter(element => element.getClientRects().length && !element.disabled);
    const first = targets[0], last = targets.at(-1);
    if (!first) return;
    const active = document.activeElement;
    if (!targets.includes(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }, { signal: events.signal });
  function filterPoints() {
    const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
    const query = normalize(get('[data-rm-search]').value.trim());
    let visible = 0;
    for (const row of get('.rm-point-rows').children) {
      row.hidden = !normalize(row.querySelector('strong').textContent).includes(query);
      if (!row.hidden) visible++;
    }
    const feedback = get('.rm-search-count');
    feedback.hidden = !query;
    feedback.textContent = visible ? `${visible} ${visible === 1 ? 'resultado' : 'resultados'}` : 'Nenhum ponto ou escola encontrado neste percurso.';
  }

  function setPanel(index) {
    if (narrow.matches) sheetIndex = Math.max(0, Math.min(2, index));
    else desktopOpen = Boolean(index);
    syncDisclosure();
  }

  function syncDisclosure() {
    const button = get('.rm-disclosure'), panel = get('.rm-inner');
    const index = narrow.matches ? sheetIndex : desktopOpen ? 2 : 0;
    const collapsed = index === 0;
    get('.rm-side').dataset.panel = sheetStates[index];
    const label = collapsed ? 'Abrir painel de rotas e pontos' : index === 1
      ? 'Expandir painel de rotas e pontos' : 'Recolher painel de rotas e pontos';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed && narrow.matches
      ? [label, ...Array.from(button.querySelector('.rm-sheet-summary').children, item => item.textContent)].filter(Boolean).join('. ')
      : label);
    button.title = label;
    if (collapsed && panel.contains(document.activeElement)) button.focus({ preventScroll: true });
    panel.inert = collapsed;
  }
  narrow.addEventListener('change', syncDisclosure, { signal: events.signal });
  register('input', event => { if (event.target.matches('[data-rm-search]')) filterPoints(); });
  register('keydown', event => {
    if (!narrow.matches || !event.target.matches('.rm-disclosure')) return;
    const index = { ArrowUp: sheetIndex + 1, ArrowDown: sheetIndex - 1, Home: 0, End: 2 }[event.key];
    if (index === undefined) return;
    event.preventDefault();
    setPanel(index);
  });
  register('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.matches('.rm-disclosure')) {
      if (suppressSheetClick && event.detail) return;
      setPanel(narrow.matches ? (sheetIndex + 1) % sheetStates.length : Number(!desktopOpen));
    } else if (button.dataset.rmDirection && direction !== button.dataset.rmDirection) {
      direction = button.dataset.rmDirection;
      reloadSelection();
    } else if (button.dataset.rmIndex !== undefined) {
      selected = Number(button.dataset.rmIndex); placing = false;
      if (narrow.matches && sheetIndex === 2 && plan()[selected]?.position) setPanel(1);
      render(false);
      get('[data-rm-index="' + selected + '"]')?.focus();
      focusMarker(selected);
    } else if (button.dataset.rm === 'retry') {
      openMap();
    } else if (isEditable() || ['fit', 'fullscreen', 'load', 'my-position'].includes(button.dataset.rm)) {
      actions[button.dataset.rm]?.();
    }
  });
  register('transitionend', event => {
    if (!event.target.matches('.rm-side') || event.propertyName !== 'height') return;
    const marker = markers.get(selected);
    const popup = marker?.getPopup();
    if (!popup?.isOpen()) return;
    keepMarkerVisible(marker.getLatLng());
    const [topLeft, bottomRight] = mapPadding();
    popup.options.autoPanPaddingTopLeft = topLeft;
    popup.options.autoPanPaddingBottomRight = bottomRight;
    popup.update();
  });
  register('change', event => {
    const field = event.target;
    if (field.name === 'trackFile') {
      const file = field.files?.[0];
      field.value = '';
      void importFile(file);
      return;
    }
    if (field.matches('[data-rm-school]')) schoolId = field.value;
    else if (field.matches('[data-rm-route]')) routeId = field.value;
    else if (isEditable() && ['verified', 'journeys', 'observed', 'addSchool', 'addStop'].includes(field.name)) {
      if (field.name === 'verified') {
        get('[data-rm="validate"]').disabled = !entry()?.road || !field.checked;
      } else if (field.name === 'journeys' || field.name === 'observed') {
        if (!field.validity.valid || (field.name === 'journeys' && field.value === '')) {
          tell('Informe um número inteiro dentro do intervalo mostrado no campo.');
          field.value = field.name === 'journeys' ? entry().journeys : entry().observedSeconds ?? '';
          return;
        }
        remember();
        if (field.name === 'journeys') entry().journeys = Number(field.value);
        else entry().observedSeconds = field.value === '' ? null : Number(field.value);
        if (entry().status === 'validated') entry().status = 'calculated';
        get('[name="verified"]').checked = false;
        render(false);
      } else if (field.value) {
        const kind = field.name === 'addSchool' ? 'school' : 'stop';
        const item = (kind === 'school' ? data.schools : data.stops).find(point => point.id === field.value);
        if (item) {
          const next = plan();
          if (next.length >= 40) return;
          next.push({ ...item, kind, position: entry().coordinates?.[kind]?.[item.id] || null });
          selected = next.length - 1;
          save(next);
          get('[data-rm-index="' + selected + '"]')?.focus();
        }
      }
      return;
    } else return;
    reloadSelection();
  });
  register('pointerdown', event => {
    const disclosure = event.target.closest('.rm-disclosure');
    if (narrow.matches && disclosure && event.isPrimary && event.button === 0) {
      suppressSheetClick = false;
      const side = get('.rm-side');
      sheetDrag = { id: event.pointerId, start: event.clientY, height: side.offsetHeight };
      disclosure.setPointerCapture(event.pointerId);
      return;
    }
    const handle = event.target.closest('[data-rm-handle]');
    if (!handle || drag || !isEditable() || event.button !== 0) return;
    const row = handle.closest('[data-rm-row]');
    drag = { id: event.pointerId, handle, row, from: Number(row.dataset.rmRow), target: row };
    handle.setPointerCapture(event.pointerId);
    row.classList.add('rm-dragging');
    event.preventDefault();
  });
  register('pointermove', event => {
    if (sheetDrag?.id === event.pointerId) {
      const delta = sheetDrag.start - event.clientY;
      if (Math.abs(delta) < 8 && !suppressSheetClick) return;
      suppressSheetClick = true;
      get('.rm-side').style.setProperty('--rm-drag-height', `${sheetDrag.height + delta}px`);
      return;
    }
    if (drag?.id !== event.pointerId) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-rm-row]');
    if (!row || !root.contains(row) || row === drag.target) return;
    drag.target.classList.remove('rm-drop-target');
    drag.target = row;
    row.classList.add('rm-drop-target');
  });
  function endDrag(event) {
    if (sheetDrag?.id === event.pointerId) {
      const delta = sheetDrag.start - event.clientY;
      sheetDrag = undefined;
      get('.rm-side').style.removeProperty('--rm-drag-height');
      if (event.type === 'pointerup' && Math.abs(delta) >= 32) {
        setPanel(sheetIndex + Math.sign(delta));
      }
      return;
    }
    if (drag?.id !== event.pointerId) return;
    const { row, target, from } = drag;
    const to = Number(target.dataset.rmRow);
    row.classList.remove('rm-dragging');
    target.classList.remove('rm-drop-target');
    drag = undefined;
    if (event.type === 'pointerup' && from !== to) {
      reorder(from, to);
      get('[data-rm-index="' + selected + '"]')?.focus();
    }
  }
  register('pointerup', endDrag);
  register('pointercancel', endDrag);
  register('lostpointercapture', endDrag);
  register('submit', event => {
    if (!event.target.matches('.rm-editor')) return;
    event.preventDefault();
    if (!isEditable()) return;
    const form = new FormData(event.target);
    const position = coordinates(form.get('lat'), form.get('lng'));
    if (position) setPosition(position);
    else tell('Digite latitude de −90 a 90 e longitude de −180 a 180.');
  });
  render();
  syncDisclosure();
  openMap();
  void readPlan();
  return {
    update(next) {
      if (JSON.stringify(next) === JSON.stringify(data)) return;
      stopRequest();
      closePersistence();
      data = next;
      if (!data.schools.some(school => school.id === schoolId)) schoolId = '';
      for (const [id] of workspace.pending) {
        const [savedRoute] = JSON.parse(id);
        if (!data.routes.some(item => item.id === savedRoute)) workspace.pending.delete(id);
      }
      reloadSelection();
    },
    destroy() {
      disposed = true; stopRequest(); closePersistence(); events.abort(); resize?.disconnect(); map?.remove();
      if (document.fullscreenElement === get('.rm-map-area')) void document.exitFullscreen().catch(() => {});
    },
  };
}
