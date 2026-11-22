// Vector globe for the GeoZipTag icon: Natural Earth land (1:110m) plus India's
// official outline from Natural Earth's India point-of-view data (1:10m), in an
// orthographic projection rotated so the pin tip lands on New Delhi.
import fs from 'fs'
import { geoOrthographic, geoPath, geoArea } from 'd3-geo'
const [out, cx, cy, R, tipX, tipY, zoom = 1] = process.argv.slice(2).map((v, i) => i ? Number(v) : v)
// One continuous land layer (no country borders); 1:50m so coasts stay crisp when zoomed.
const world = JSON.parse(fs.readFileSync('data/land-50m.geojson'))
const pov = JSON.parse(fs.readFileSync('data/countries-10m-india-pov.geojson'))
const india = pov.features.find(f => f.properties.ADM0_A3 === 'IND')

// Douglas-Peucker on lon/lat rings; drop specks (tiny islands) an icon can't show.
function rdp(points, eps) {
  if (points.length < 3) return points
  let index = 0, max = 0
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len
    if (d > max) { max = d; index = i }
  }
  if (max <= eps) return [points[0], points[points.length - 1]]
  return [...rdp(points.slice(0, index + 1), eps).slice(0, -1), ...rdp(points.slice(index), eps)]
}
const simplifyPolygons = (geometry, eps, minArea) => {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
  // Closed rings: simplify the two halves separately so each has a real baseline.
  const ringSimplify = ring => { const mid = Math.floor(ring.length / 2)
    return [...rdp(ring.slice(0, mid + 1), eps).slice(0, -1), ...rdp(ring.slice(mid), eps)] }
  const kept = polys.map(poly => poly.map(ringSimplify))
    .filter(poly => poly[0].length >= 4 && geoArea({ type: 'Polygon', coordinates: poly }) > minArea)
  return { type: 'MultiPolygon', coordinates: kept }
}
const indiaShape = simplifyPolygons(india.geometry, 0.06, 1e-5)

// Find the rotation that puts New Delhi under the pin tip.
const delhi = [77.21, 28.61]
// zoom > 1 enlarges the sphere behind the glass (the glass clips it), making India bigger.
const proj = geoOrthographic().scale(R * zoom).translate([cx, cy]).clipAngle(90)
let best = { d: Infinity }
for (let lon = 20; lon <= 90; lon += 0.25) for (let lat = -10; lat <= 45; lat += 0.25) {
  const p = proj.rotate([-lon, -lat])(delhi); if (!p) continue
  const d = Math.hypot(p[0] - tipX, p[1] - tipY); if (d < best.d) best = { d, lon, lat }
}
proj.rotate([-best.lon, -best.lat])
const path = geoPath(proj).digits(2)
const land = world.features.map(f => path(simplifyPolygons(f.geometry, 0.04, 2e-6))).filter(Boolean).join('')
const result = { centre: [best.lon, best.lat], tipError: best.d, land, india: path(indiaShape),
  indiaPoints: indiaShape.coordinates.reduce((n, p) => n + p[0].length, 0) }
fs.writeFileSync(out, JSON.stringify(result))
console.log(`globe centred on ${best.lon}E ${best.lat}N; Delhi lands ${best.d.toFixed(2)} units from the pin tip; India outline ${result.indiaPoints} points; land ${Math.round(land.length / 1024)} KB, India ${Math.round(result.india.length / 1024)} KB`)
