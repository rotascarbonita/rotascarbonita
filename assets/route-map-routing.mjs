export const center = [-17.527, -43.016];
export const osmTiles = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
};

export function coordinates(latitude, longitude) {
  const values = [latitude, longitude].map(value => {
    if (typeof value === 'number') return value;
    const decimal = String(value ?? '').trim().replace(',', '.');
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal) ? Number(decimal) : NaN;
  });
  return values.every(Number.isFinite) && Math.abs(values[0]) <= 90 && Math.abs(values[1]) <= 180
    ? values : null;
}

export function roadProvider(endpoint, label, profile = 'driving') {
  return {
    label,
    async calculate(points, signal) {
      const path = points.map(([lat, lng]) => lng.toFixed(6) + ',' + lat.toFixed(6)).join(';');
      const url = new URL('route/v1/' + encodeURIComponent(profile) + '/' + path, endpoint);
      url.search = new URLSearchParams({
        overview: 'full', geometries: 'geojson', steps: 'false', generate_hints: 'false',
        radiuses: Array(points.length).fill('100').join(';'),
      });
      const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' });
      const data = await response.json().catch(() => null);
      if (['NoRoute', 'NoSegment'].includes(data?.code)) {
        throw Error('Não foi encontrado um trajeto viário. Ajuste os pontos ou adicione uma passagem.');
      }
      const route = data?.routes?.[0];
      const nonnegative = value => Number.isFinite(value) && value >= 0;
      if (!response.ok || data?.code !== 'Ok' || route?.geometry?.type !== 'LineString' ||
          !Array.isArray(route.geometry.coordinates) || route.geometry.coordinates.length < 2 ||
          !route.geometry.coordinates.every(pair => Array.isArray(pair) && coordinates(pair[1], pair[0])) ||
          !nonnegative(route.distance) || !nonnegative(route.duration) ||
          !Array.isArray(route.legs) || route.legs.length !== points.length - 1 ||
          !route.legs.every(leg => nonnegative(leg.distance) && nonnegative(leg.duration))) {
        throw Error('O roteador está indisponível ou retornou um trajeto incompleto. Tente novamente.');
      }
      return route;
    },
  };
}

export function legDistances(legs, waypoints) {
  let accumulated = 0;
  const cumulative = waypoints.map((_, i) => {
    accumulated += i ? legs[i - 1].distance : 0;
    return accumulated;
  });
  const schools = waypoints.flatMap((point, index) => point.kind === 'school' ? [{ point, index }] : []);
  return waypoints.map((point, i) => ({
    point,
    leg: i ? legs[i - 1].distance : 0,
    accumulated: cumulative[i],
    remaining: schools.filter(school => school.index >= i).map(({ point: school, index }) =>
      ({ name: school.name, distance: cumulative[index] - cumulative[i] })),
  }));
}
