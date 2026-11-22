import qrcode from './vendor/qrcode.mjs'

const $ = (id) => document.getElementById(id)
const video = $('video')
const file = $('file')
const status = $('status')
let placeLabel = ''
let stampNote = ''
let stream, photoUrl, watchId, fix
let facing = 'user'   // GeoZipTag always opens on the front camera
let cameraRequest = 0
let busy = false
let fromPicker = false
let pickerFix, pendingCapture
let timestampOnly = false
let manualFix, originalUrl, lastPhoto
let cameraHardware, countdownTimer, focusTimer
let gridEnabled = false
let timerSeconds = 0
const preferences = { template: 'satellite', position: 'bottom', keepOriginal: false, preferShare: false }
try {
  const saved = JSON.parse(localStorage.getItem('geostampPreferences') || '{}')
  if (['satellite', 'time', 'qr'].includes(saved.template)) preferences.template = saved.template
  if (saved.position === 'top') preferences.position = 'top'
  preferences.keepOriginal = saved.keepOriginal === true
  preferences.preferShare = saved.preferShare === true
} catch {}

// Dates and times are shown in the time zone of the photo's location (GPS or manual pin),
// looked up offline with tz-lookup; without a location they use the device's zone.
const timeFormats = new Map()
function formatsFor(timeZone) {
  const key = timeZone || ''
  if (!timeFormats.has(key)) {
    const zone = timeZone ? { timeZone } : {}
    timeFormats.set(key, {
      full: new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset', ...zone }),
      date: new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', ...zone }),
      time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'longOffset', ...zone })
    })
  }
  return timeFormats.get(key)
}

function placeTimeZone(snapshot) {
  if (!snapshot || typeof window.tzlookup !== 'function') return undefined
  try {
    const zone = window.tzlookup(snapshot.lat, snapshot.lon)
    new Intl.DateTimeFormat(undefined, { timeZone: zone })   // throws if the browser lacks this zone
    return zone
  } catch {
    return undefined
  }
}

const timeAt = (snapshot) => formatsFor(placeTimeZone(snapshot))

function expireLocationFix() {
  if (manualFix || !fix || currentFix()) return
  fix = undefined
  setLocationStatus('Waiting for a fresh fix…')
}
setInterval(expireLocationFix, 1000)

const hostSaves = typeof android !== 'undefined' && !!android   // the Android app saves every photo itself
let messageTimer
function message(value, hideAfter = 0) {
  clearTimeout(messageTimer)
  status.textContent = value
  status.hidden = !value
  if (value && hideAfter) messageTimer = setTimeout(() => { status.hidden = true }, hideAfter)
}
status.addEventListener('click', () => { clearTimeout(messageTimer); status.hidden = true })

// Address and satellite map are fetched in the background whenever GPS updates, so the
// shutter can stamp instantly. Refetched after moving about 30 m or after 10 minutes.
let placeCache
function prefetchPlace(snapshot) {
  if (!snapshot || preferences.template === 'time') return
  const cached = placeCache
  if (cached && usable(cached, snapshot)) return
  if (cached && !cached.done && metresBetween(snapshot, cached) < 200) return   // one request at a time nearby
  const entry = { lat: snapshot.lat, lon: snapshot.lon, at: Date.now(), done: false, failed: false }
  entry.promise = locate(snapshot).then(result => {
    entry.done = true
    entry.failed = !result.address && !result.map
    entry.partial = !result.complete   // e.g. Nominatim busy: retried shortly instead of kept
    entry.result = result
    setTimeout(renderLiveStamp)
    return result
  }, () => { entry.done = true; entry.failed = true; return {} })
  placeCache = entry
}

// A cached place is reused within 30 m: complete results for 10 minutes, partial ones for 20 s.
function usable(cached, snapshot) {
  const age = Date.now() - cached.at
  return !cached.failed && metresBetween(snapshot, cached) < 30 && age < (cached.partial ? 20000 : 600000)
}

function placeReady(snapshot) {
  const cached = placeCache
  return !!(snapshot && cached && cached.done && usable(cached, snapshot))
}

function placeFor(snapshot) {
  const cached = placeCache
  if (snapshot && cached && usable(cached, snapshot)) return cached.promise
  return locate(snapshot)
}

function stopCamera() {
  cameraRequest++
  stream?.getTracks().forEach((track) => track.stop())
  stream = undefined
  video.srcObject = null
  video.hidden = true
  $('shutter').hidden = true
  $('switchCamera').hidden = true
  resetLiveControls()
}

let switching = false
function freezeFrame() {
  const frame = $('switchFrame')
  if (video.hidden || !video.videoWidth || !video.videoHeight) return false
  frame.width = video.videoWidth
  frame.height = video.videoHeight
  frame.getContext('2d').drawImage(video, 0, 0)
  frame.classList.toggle('mirror', video.classList.contains('mirror'))
  frame.hidden = false
  return true
}
function releaseFrame() { $('switchFrame').hidden = true }
function endSwitch() {
  switching = false
  releaseFrame()
  $('shutter').disabled = busy
  $('switchCamera').disabled = busy
}

// Flipping cameras keeps the screen as it is (last frame, blurred) instead of the start screen.
function softStopCamera() {
  cameraRequest++
  stream?.getTracks().forEach((track) => track.stop())
  stream = undefined
  video.srcObject = null
  video.hidden = true
  cancelCountdown()
  cameraHardware = undefined
  $('zoomControl').hidden = true
  $('torchToggle').hidden = true
  $('focusPoint').hidden = true
  video.classList.remove('can-focus')
}

async function startCamera(nextFacing = facing, { soft = false } = {}) {
  if (soft) {
    softStopCamera()
    switching = true
    $('shutter').disabled = true
    $('switchCamera').disabled = true
  } else stopCamera()
  const request = cameraRequest
  if (!soft) {
    $('start').hidden = false
    $('startCamera').disabled = true
    $('startWithoutLocation').disabled = true
    $('startCamera').textContent = 'Opening camera…'
  }
  message('')
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable')
    const next = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: nextFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    })
    if (cameraRequest !== request) {
      next.getTracks().forEach((track) => track.stop())
      return
    }
    stream = next
    const track = stream.getVideoTracks()[0]
    facing = track.getSettings().facingMode || nextFacing
    video.srcObject = stream
    video.classList.toggle('mirror', facing === 'user')
    await video.play()
    if (cameraRequest !== request) return
    if (!video.videoWidth) throw new Error('No camera frame')
    $('start').hidden = true
    video.hidden = false
    $('shutter').hidden = false
    showLiveControls(track)
    track.addEventListener('ended', () => {
      if (cameraRequest !== request) return
      stopCamera()
      $('start').hidden = false
      message('Camera stopped. Start it again or use your phone camera.')
    })
    const cameras = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    if (cameraRequest === request) {
      $('switchCamera').hidden = cameras.filter((device) => device.kind === 'videoinput').length < 2
    }
  } catch {
    if (cameraRequest !== request) return
    stopCamera()
    endSwitch()
    $('start').hidden = false
    message('Live camera unavailable. Check camera permission or use your phone camera.')
  } finally {
    if (cameraRequest === request) endSwitch()
    if (cameraRequest === request || !stream) resetStart()
  }
}

function resetStart() {
  $('startCamera').disabled = false
  $('startCamera').textContent = preferences.template === 'time' ? 'Start camera' : 'Start camera with location'
  $('startWithoutLocation').disabled = false
}

async function startLiveCamera(requestLocation = false) {
  await startCamera()
  if (!stream || manualFix || preferences.template === 'time' || watchId !== undefined) return
  if (requestLocation) {
    enableLocation()
    return
  }
  if (timestampOnly) return
  const activeStream = stream
  try {
    const permission = await navigator.permissions?.query({ name: 'geolocation' })
    if (permission?.state === 'granted' && stream === activeStream && watchId === undefined &&
        !timestampOnly && !manualFix && preferences.template !== 'time') {
      enableLocation()
    }
  } catch {
    // Browsers that cannot expose the permission state leave location opt-in.
  }
}

$('startCamera').addEventListener('click', () => {
  timestampOnly = false
  startLiveCamera(true)
})
$('startWithoutLocation').addEventListener('click', () => {
  timestampOnly = true
  manualFix = undefined
  stopLocation()
  clearGpsChoice()
  startCamera()
})
$('switchCamera').addEventListener('click', () => {
  if (busy || switching) return
  startCamera(facing === 'environment' ? 'user' : 'environment', { soft: freezeFrame() })
})

function openPicker(snapshot) {
  pickerFix = snapshot
  stopCamera()
  $('start').hidden = false
  resetStart()
  file.click()
}
$('fallback').addEventListener('click', () => requestCapture(openPicker))

function currentFix() {
  return freshFix(fix)
}

function freshFix(snapshot) {
  return snapshot && (snapshot.manual || Date.now() - snapshot.timestamp <= 60000) ? snapshot : undefined
}

function clearGpsChoice() {
  pendingCapture = undefined
  $('gpsChoice').hidden = true
}

function requestCapture(action) {
  const snapshot = preferences.template === 'time' ? undefined : manualFix || currentFix()
  if (snapshot || timestampOnly || preferences.template === 'time') {
    clearGpsChoice()
    action(snapshot)
    return
  }
  pendingCapture = action
  $('gpsHint').textContent = watchId === undefined
    ? 'Enable location for the map, address, and coordinates, or continue with just the time.'
    : 'Wait for GPS to add the map and address, or continue with just the time.'
  $('gpsChoice').hidden = false
  $('captureWithLocation').focus()
}

$('captureWithoutLocation').addEventListener('click', () => {
  const action = pendingCapture
  clearGpsChoice()
  action?.(undefined)
})

function updateLocationMapAction() {
  $('addLocationMap').hidden = preferences.template !== 'time' && !!(manualFix || currentFix())
}

function addLocationMap() {
  if (preferences.template === 'time') {
    preferences.template = 'satellite'
    document.querySelector('input[name="template"][value="satellite"]').checked = true
    savePreferences()
    updateTemplateLabel()
  }
  timestampOnly = false
  if (manualFix) {
    setLocationStatus('Manual location', true)
    return
  }
  enableLocation()
}

$('addLocationMap').addEventListener('click', addLocationMap)
$('captureWithLocation').addEventListener('click', addLocationMap)

function setLocationStatus(message, ready = false) {
  const indicator = $('locationStatus')
  indicator.textContent = message
  indicator.dataset.ready = ready
  $('locationSheetStatus').textContent = message
  $('locationButton').dataset.state = ready ? 'ready'
    : watchId !== undefined || /finding|waiting|approximate/i.test(message) ? 'pending' : 'off'
  $('locationButton').setAttribute('aria-label', `Location: ${message}`)
  updateLocationMapAction()
  if (typeof renderLiveStamp === 'function') setTimeout(renderLiveStamp)
}

function stopLocation(status = 'Timestamp only') {
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId)
  watchId = undefined
  fix = undefined
  $('location').textContent = 'Enable location'
  $('location').setAttribute('aria-pressed', 'false')
  setLocationStatus(status)
}

function enableLocation() {
  if (watchId !== undefined) return
  const location = $('location')
  timestampOnly = false
  if (!navigator.geolocation) {
    setLocationStatus('Location unavailable')
    return
  }
  location.textContent = 'Turn off location'
  location.setAttribute('aria-pressed', 'true')
  setLocationStatus('Finding GPS…')
  const onFix = ({ coords, timestamp }) => {
    if (watchId === undefined) return
    // Keep the more accurate of a quick recent position and a fresh GPS reading.
    if (fix && fix.accuracy < coords.accuracy && timestamp - fix.timestamp < 10000) return
    fix = { lat: coords.latitude, lon: coords.longitude, timestamp, accuracy: coords.accuracy }
    if (coords.accuracy > 100) setLocationStatus('Approximate GPS')
    else setLocationStatus('GPS ready', true)
    prefetchPlace(fix)
    if (pendingCapture) {
      $('gpsHint').textContent = 'Location ready. Tap the shutter or phone camera to include it.'
    }
  }
  // A recent position (up to a minute old) appears straight away; GPS then refines it.
  navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 4000 })
  watchId = navigator.geolocation.watchPosition(onFix, (error) => {
    if (watchId === undefined) return
    if (error.code === 1) {
      stopLocation('Location denied. Allow access in your browser’s site settings, then tap Enable location.')
      if (pendingCapture) $('gpsHint').textContent = 'Location permission is off. You can still take a timestamped photo.'
      return
    }
    if (!currentFix()) setLocationStatus('GPS unavailable. Keep waiting or use timestamp only.')
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 })
}

$('location').addEventListener('click', () => {
  if (manualFix) {
    manualFix = undefined
    enableLocation()
    return
  }
  if (watchId === undefined) enableLocation()
  else {
    timestampOnly = true
    stopLocation()
    clearGpsChoice()
  }
})

const imageryTiles = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/32246'
const imageryTileSize = 256
const mapWindow = 256

async function loadSatelliteMap({ lat, lon }, request, signal, maxZoom = 23, viewSize = mapWindow) {
  if (Math.abs(lat) > 85.051128) return undefined
  const latitude = lat * Math.PI / 180
  const normalizedX = (lon + 180) / 360
  const normalizedY = (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2

  async function getTile(zoom, column, row) {
    const count = 2 ** zoom
    const wrappedColumn = ((column % count) + count) % count
    const response = await request(`${imageryTiles}/${zoom}/${row}/${wrappedColumn}`)
    if (!response.headers.get('Content-Type')?.startsWith('image/')) throw new Error('Imagery unavailable')
    const url = URL.createObjectURL(await response.blob())
    try { return { image: await loadImage(url), column, row } }
    finally { URL.revokeObjectURL(url) }
  }

  // Probe nearby levels together so missing high-resolution tiles cannot consume the whole deadline.
  for (let highest = maxZoom; highest >= 0 && !signal.aborted; highest -= 4) {
    const levels = Array.from({ length: Math.min(4, highest + 1) }, (_, index) => highest - index)
    const centers = await Promise.allSettled(levels.map(zoom => {
      const count = 2 ** zoom
      return getTile(zoom, Math.floor(normalizedX * count), Math.floor(normalizedY * count))
    }))
    for (let index = 0; index < levels.length && !signal.aborted; index++) {
      if (centers[index].status !== 'fulfilled') continue
      const zoom = levels[index]
      const count = 2 ** zoom
      const x = normalizedX * count * imageryTileSize
      const y = normalizedY * count * imageryTileSize
      const left = x - viewSize / 2
      const top = y - viewSize / 2
      const firstColumn = Math.floor(left / imageryTileSize)
      const lastColumn = Math.floor((left + viewSize - 0.001) / imageryTileSize)
      const firstRow = Math.floor(top / imageryTileSize)
      const lastRow = Math.floor((top + viewSize - 0.001) / imageryTileSize)
      if (firstRow < 0 || lastRow >= count) continue
      const center = centers[index].value
      try {
        const neighbors = []
        for (let row = firstRow; row <= lastRow; row++) {
          for (let column = firstColumn; column <= lastColumn; column++) {
            if (column !== center.column || row !== center.row) neighbors.push(getTile(zoom, column, row))
          }
        }
        const tiles = [center, ...await Promise.all(neighbors)]
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = viewSize
        const ctx = canvas.getContext('2d')
        for (const { image, column, row } of tiles) {
          ctx.drawImage(image, column * imageryTileSize - left, row * imageryTileSize - top)
        }
        return { image: canvas, left, top, worldSize: count * imageryTileSize }
      } catch {
        // A complete lower-resolution map is preferable when a neighboring tile is missing.
      }
    }
  }
  return undefined
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Image unavailable'))
    image.src = url
  })
}
async function lookup(url, signal) {
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' })
  if (!response.ok) throw new Error('Location lookup unavailable')
  return response
}

// Nominatim (OpenStreetMap) gives the full Indian hierarchy: village, mandal (county),
// district (state_district) and PIN code. Map it onto the app's address fields.
function nominatimAddress(result) {
  const a = result?.address
  if (!a) return undefined
  const local = a.neighbourhood || a.quarter || (isWard(a.suburb) ? '' : a.suburb)
  const out = {
    street: a.road, housenumber: a.house_number, village: a.village || a.hamlet,
    locality: local, city: a.city || a.town, county: a.county, region: a.state_district,
    state: a.state, postcode: a.postcode, country: a.country, countrycode: a.country_code
  }
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value))
}

// Keep the first source's fields; fill any gaps from the next.
function fillAddress(primary, fallback) {
  if (!primary) return fallback
  if (!fallback) return primary
  return { ...fallback, ...primary }
}

const mandalLabel = (county) => /\bmandal$/i.test(county) ? `${county.replace(/\s*mandal$/i, '')} (M)` : county
const districtLabel = (district) => `${district.replace(/\s*district$/i, '')} (Dist)`

// Address lines for the stamp and reports. In India: street; "Village (V), Mandal (M),
// District (Dist)"; "State – PIN, Country" on its own line so the PIN is never cut off.
function addressLines(address, snapshot) {
  if (!address) return []
  const indian = (address.countrycode || '').toLowerCase() === 'in' && (address.county || address.region)
  if (!indian) {
    const text = fullAddress(address)
    return text ? [[text, 2]] : []
  }
  const street = address.street ? [address.housenumber, address.street.split(',')[0].trim()].filter(Boolean).join(' ') : ''
  const village = unmappedVillageName(snapshot, address) || address.village
  const place = village ? `${village} (V)` : (address.locality || address.city || '')
  const seen = new Set()
  const admin = [place, address.county && mandalLabel(address.county), address.region && districtLabel(address.region)]
    .filter(Boolean).filter(part => {
      const key = nameSkeleton(part.replace(/\s*\((V|M|Dist)\)$/, ''))
      if (seen.has(key)) return false
      seen.add(key); return true
    })
  const tail = [[address.state, address.postcode].filter(Boolean).join(' – '), address.country].filter(Boolean).join(', ')
  return [street && [street, 1], admin.length && [admin.join(', '), 2], tail && [tail, 1]].filter(Boolean)
}

const addressText = (address, snapshot) => addressLines(address, snapshot).map(([text]) => text).join(', ')

async function locate(snapshot) {
  if (!snapshot) return {}
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 15000)
  const reverse = new URL('https://photon.komoot.io/reverse')
  reverse.search = new URLSearchParams({ lat: snapshot.lat, lon: snapshot.lon, limit: 1 })
  const nominatim = new URL('https://nominatim.openstreetmap.org/reverse')
  nominatim.search = new URLSearchParams({ format: 'jsonv2', lat: snapshot.lat, lon: snapshot.lon, zoom: 18, addressdetails: 1, 'accept-language': 'en' })
  const request = (url) => lookup(url, abort.signal)
  try {
    const [address, map, osm] = await Promise.allSettled([
      request(reverse).then((response) => response.json()).then((data) => data.features?.[0]?.properties),
      loadSatelliteMap(snapshot, request, abort.signal),
      request(nominatim).then((response) => response.json()).then(nominatimAddress)
    ])
    return { address: fillAddress(osm.value, address.value), map: map.value?.image, complete: !!(osm.value && map.value) }
  } finally {
    clearTimeout(timer)
  }
}

// Villages that OpenStreetMap does not yet map as places. Near these points the
// geocoder only returns the parent town or mandal, so the stamp names the village
// instead. Once a village is mapped as place=village in OpenStreetMap, its entry
// can be removed. Cheruvugattu is a village in Narketpally mandal, Nalgonda.
const unmappedVillages = [
  {
    name: 'Cheruvugattu',
    parentArea: /^nar(?:kat|ket)pal(?:li|le|ly)(?: mandal)?$|^nalgonda(?: district)?$/i,
    radius: 225,
    points: [
      { lat: 17.1740101, lon: 79.2121757 }, // Cheruvugattu temple (OSM node 10101107918)
      { lat: 17.1743625, lon: 79.2142737 }  // Cheruvugattu-II (OSM node 11984988986)
    ]
  }
]

function metresBetween(a, b) {
  const north = (a.lat - b.lat) * 111195
  const east = (a.lon - b.lon) * 111195 * Math.cos(b.lat * Math.PI / 180)
  return Math.hypot(north, east)
}

// Ward numbers ("Ward 78 Gunfoundry") are administrative codes, not place names people use.
const isWard = (value) => /^ward\b/i.test(value || '')

function rawAreaName(address) {
  return address?.village || address?.locality || (isWard(address?.district) ? '' : address?.district) ||
    (address?.osm_key === 'place' ? address.name : '') || address?.city || address?.county || ''
}

function unmappedVillageName(snapshot, address) {
  if (!snapshot) return ''
  const local = rawAreaName(address)
  const village = unmappedVillages.find(entry => (!local || entry.parentArea.test(local)) &&
    entry.points.some(point => metresBetween(snapshot, point) <= entry.radius))
  return village?.name || ''
}

function localAreaName(snapshot, address) {
  return unmappedVillageName(snapshot, address) || rawAreaName(address)
}

// Heading: the most specific area, then the full state name and country.
function placeHeading(snapshot, address) {
  if (snapshot?.name) return snapshot.name
  const parts = [localAreaName(snapshot, address), address?.state, address?.country].filter(Boolean)
  return [...new Map(parts.map(part => [part.toLowerCase(), part])).values()].join(', ')
}

// Spelling variants of one name ("Chervugattu" / "Cheruvugattu") share their consonants.
const nameSkeleton = (value) => value.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '')
  .replace(/(.)\1+/g, '$1').replace(/(?!^)[aeiouy]/g, '')

// Full postal address: street, area, town, mandal or county, district, "State PIN", country.
function fullAddress(address) {
  if (!address) return ''
  const isStreetResult = address.osm_key === 'highway' || address.osm_key === 'place'
  const street = address.street ? [address.housenumber, address.street].filter(Boolean).join(' ')
    : isStreetResult ? address.name : ''
  const statePin = [address.state, address.postcode].filter(Boolean).join(' ')
  const tail = new Set([address.state, address.postcode, statePin, address.country]
    .filter(Boolean).map(value => value.toLowerCase()))
  const seen = new Set()
  const parts = []
  // Some streets carry their own "Village, State PIN" suffix; split it so nothing repeats.
  for (const value of [street, address.locality, address.district, address.city, address.county, address.region]) {
    for (const piece of (value || '').split(',')) {
      const part = piece.trim()
      const key = part.length > 5 ? nameSkeleton(part) || part.toLowerCase() : part.toLowerCase()
      if (!part || seen.has(key) || tail.has(part.toLowerCase())) continue
      seen.add(key)
      parts.push(part)
    }
  }
  return [...parts, statePin, address.country].filter(Boolean).join(', ')
}

const stampFace = 'Inter, system-ui, sans-serif'
let stampFontsReady = false
// Brand badge artwork (vector wordmark and globe), drawn above the stamp card.
let stampBrand = {}
const stampFonts = Promise.all([
  (document.fonts
    ? Promise.all(['700 18px', '600 12px', '500 13px'].map(spec => document.fonts.load(`${spec} Inter`)))
    : Promise.resolve()).catch(() => {}),
  Promise.all(['assets/geoziptag-wordmark.svg', 'assets/app-icon.png'].map(src => loadImage(src).catch(() => undefined)))
    .then(([wordmark, icon]) => { stampBrand = { wordmark, icon } })
]).then(() => { stampFontsReady = true })

function formatCoordinates({ lat, lon }) {
  const part = (value, positive, negative) => `${Math.abs(value).toFixed(6)}° ${value >= 0 ? positive : negative}`
  return `Lat ${part(lat, 'N', 'S')} · Long ${part(lon, 'E', 'W')}`
}

function drawStamp(canvas, { snapshot, date, picked, address, map, template = preferences.template, position = preferences.position, example = false, note = stampNote }) {
  const ctx = canvas.getContext('2d')
  const unit = Math.min(canvas.width, canvas.height) / 460
  const w = canvas.width / unit, h = canvas.height / unit
  const inset = 10, padding = 10, radius = 12
  const mapSize = map ? 104 : 0
  const codeSize = template === 'qr' && snapshot ? 84 : 0
  const accentBar = map ? 0 : 3
  const width = Math.min(w - 2 * inset, map ? 540 : snapshot ? 450 : 300)
  const textX = inset + padding + (map ? mapSize + padding + 2 : accentBar + padding)
  const textWidth = inset + width - padding - (codeSize ? codeSize + padding : 0) - textX
  const colors = {
    text: '#fbf8f2', muted: '#c9cfd1', coordinate: '#8fdcd8', brand: '#f47a67',
    card: 'rgba(9, 13, 14, 0.88)', accent: '#f2634e'
  }
  const lines = []

  ctx.save()
  ctx.scale(unit, unit)
  ctx.textBaseline = 'top'
  function add(text, size, color, weight = 500, { maxLines = 2, tracking = 0, gapAfter = 0 } = {}) {
    if (!text) return
    const font = `${weight} ${size}px ${stampFace}`
    ctx.font = font
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${tracking}px`
    const wrapped = []
    let line = ''
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (line && ctx.measureText(next).width > textWidth) {
        wrapped.push(line)
        line = word
      } else {
        line = next
      }
    }
    wrapped.push(line)
    if (wrapped.length > maxLines) {
      const chars = Array.from(wrapped[maxLines - 1])
      while (chars.length && ctx.measureText(chars.join('') + '…').width > textWidth) chars.pop()
      wrapped[maxLines - 1] = chars.join('').trimEnd() + '…'
    }
    const shown = wrapped.slice(0, maxLines)
    shown.forEach((text, index) => lines.push({
      text, font, color, tracking, height: Math.round(size * 1.28) + (index === shown.length - 1 ? gapAfter : 0)
    }))
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  }
  function rounded(x, y, width, height, r = radius) {
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, r)
    else ctx.rect(x, y, width, height)
  }
  const addressRows = addressLines(address, snapshot)

  const zoned = timeAt(snapshot)
  const dateLabel = `${picked ? 'Stamped ' : ''}${zoned.date.format(date)}`
  const time = zoned.time.format(date)
  if (snapshot?.manual) add('MANUAL LOCATION', 8.5, colors.brand, 700, { maxLines: 1, tracking: 1.2, gapAfter: 3 })
  if (snapshot) {
    add(placeHeading(snapshot, address) || 'GPS location', 18, colors.text, 700, { gapAfter: 1 })
    addressRows.forEach(([text, maxLines], index) => add(text, 12.5, colors.muted, 500, { maxLines, gapAfter: index === addressRows.length - 1 ? 4 : 0 }))
    add(formatCoordinates(snapshot), 11.5, colors.coordinate, 600, { maxLines: 1 })
    add(`${dateLabel} · ${time}`, 11.5, colors.text, 500, { maxLines: 1 })
  } else {
    add(time, 21, colors.text, 700, { maxLines: 1, gapAfter: 1 })
    add(dateLabel, 13, colors.muted, 500, { maxLines: 1 })
  }
  if (note) add(`Note: ${note}`, 11.5, colors.muted, 500, { maxLines: 2 })
  const textHeight = lines.reduce((sum, item) => sum + item.height, 0) - 2
  const panelHeight = Math.max(mapSize + 2 * padding, codeSize + 2 * padding, textHeight + 2 * padding + 2)
  const top = position === 'top' ? inset : h - inset - panelHeight

  // Card and GeoZipTag tab are one outline, filled once so the translucent
  // background stays even where they join. The tab rises from the card's
  // top-right corner (or hangs from the bottom-right when the stamp is at the top).
  const tabHeight = 28, iconSize = 19, markHeight = 12.5, tabRadius = 9, joinRadius = 5
  const { wordmark, icon } = stampBrand
  const markWidth = wordmark ? markHeight * (wordmark.naturalWidth || 437) / (wordmark.naturalHeight || 102) : 0
  ctx.font = `700 12px ${stampFace}`
  const tabWidth = 7 + iconSize + 7 + (markWidth || ctx.measureText('GeoZipTag').width) + 11
  const x0 = inset, x1 = inset + width, y0 = top, y1 = top + panelHeight, tabX = x1 - tabWidth
  function cardWithTab(grow = 0) {
    const a = x0 + grow, b = x1 - grow, c = y0 + grow, d = y1 - grow, t = y0 - tabHeight + grow, tx = tabX + grow
    ctx.beginPath()
    ctx.moveTo(a + radius, c)
    ctx.lineTo(tx - joinRadius, c)
    ctx.arcTo(tx, c, tx, c - joinRadius, joinRadius)
    ctx.lineTo(tx, t + tabRadius)
    ctx.arcTo(tx, t, tx + tabRadius, t, tabRadius)
    ctx.lineTo(b - tabRadius, t)
    ctx.arcTo(b, t, b, t + tabRadius, tabRadius)
    ctx.lineTo(b, d - radius)
    ctx.arcTo(b, d, b - radius, d, radius)
    ctx.lineTo(a + radius, d)
    ctx.arcTo(a, d, a, d - radius, radius)
    ctx.lineTo(a, c + radius)
    ctx.arcTo(a, c, a + radius, c, radius)
    ctx.closePath()
  }
  ctx.save()
  if (position === 'top') {
    // Mirror the outline about the card's middle so the tab hangs below it.
    ctx.translate(0, y0 + y1)
    ctx.scale(1, -1)
  }
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = position === 'top' ? -2 : 2
  ctx.fillStyle = colors.card
  cardWithTab()
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 0.75
  cardWithTab(0.375)
  ctx.stroke()
  // Faint seam where the tab meets the card, as on printed tab labels.
  ctx.beginPath()
  ctx.moveTo(tabX + 0.75, y0)
  ctx.lineTo(x1 - 0.75, y0)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.stroke()
  ctx.restore()

  if (accentBar) {
    ctx.fillStyle = colors.accent
    rounded(inset + padding, top + padding + 1, accentBar, panelHeight - 2 * padding - 2, 1.5)
    ctx.fill()
  }

  if (map) {
    const mapX = inset + padding
    const mapTop = top + (panelHeight - mapSize) / 2
    ctx.save()
    rounded(mapX, mapTop, mapSize, mapSize, 8)
    ctx.clip()
    ctx.drawImage(map, mapX, mapTop, mapSize, mapSize)
    if (!example) {
      const credit = ['Esri, Vantor', 'Earthstar Geographics', 'GIS User Community']
      const creditTop = mapTop + mapSize - 23
      ctx.font = `500 6.5px ${stampFace}`
      ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
      ctx.fillRect(mapX, creditTop, mapSize, 23)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      credit.forEach((text, index) => ctx.fillText(text, mapX + 4, creditTop + 1.5 + index * 7))
    }
    ctx.restore()

    const x = mapX + mapSize / 2, y = mapTop + mapSize / 2
    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
    ctx.shadowBlur = 4
    ctx.shadowOffsetY = 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.bezierCurveTo(x - 4, y - 6, x - 9, y - 10, x - 9, y - 15)
    ctx.arc(x, y - 15, 9, Math.PI, 0)
    ctx.bezierCurveTo(x + 9, y - 10, x + 4, y - 6, x, y)
    ctx.fillStyle = colors.accent
    ctx.fill()
    ctx.restore()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y - 15, 3, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
  }

  if (codeSize) {
    const qr = qrcode(0, 'M')
    const link = new URL('https://www.google.com/maps/search/')
    link.search = new URLSearchParams({ api: '1', query: `${snapshot.lat.toFixed(6)},${snapshot.lon.toFixed(6)}` })
    qr.addData(link.toString())
    qr.make()
    const modules = qr.getModuleCount()
    const step = codeSize / (modules + 8)
    const x = inset + width - padding - codeSize
    const y = top + (panelHeight - codeSize) / 2
    ctx.fillStyle = '#ffffff'
    rounded(x, y, codeSize, codeSize, 6)
    ctx.fill()
    ctx.fillStyle = '#000000'
    for (let row = 0; row < modules; row++) {
      for (let column = 0; column < modules; column++) {
        if (!qr.isDark(row, column)) continue
        const left = Math.round((column + 4) * step * unit) / unit
        const top = Math.round((row + 4) * step * unit) / unit
        const right = Math.round((column + 5) * step * unit) / unit
        const bottom = Math.round((row + 5) * step * unit) / unit
        ctx.fillRect(x + left, y + top, right - left, bottom - top)
      }
    }
  }

  let y = top + (panelHeight - textHeight) / 2
  for (const item of lines) {
    ctx.font = item.font
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${item.tracking}px`
    ctx.fillStyle = item.color
    ctx.fillText(item.text, textX, y, textWidth)
    y += item.height
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'

  // Tab contents: the app icon and the wordmark.
  const tabTop = position === 'top' ? y1 : y0 - tabHeight
  const iconX = tabX + 7, iconY = tabTop + (tabHeight - iconSize) / 2
  ctx.save()
  rounded(iconX, iconY, iconSize, iconSize, iconSize * 0.23)
  ctx.fillStyle = '#3d97f2'
  ctx.fill()
  if (icon) {
    ctx.clip()
    ctx.drawImage(icon, iconX, iconY, iconSize, iconSize)
  }
  ctx.restore()
  const markX = iconX + iconSize + 7
  if (wordmark) ctx.drawImage(wordmark, markX, tabTop + (tabHeight - markHeight) / 2, markWidth, markHeight)
  else {
    ctx.fillStyle = colors.text
    ctx.textBaseline = 'middle'
    ctx.font = `700 12px ${stampFace}`
    ctx.fillText('GeoZipTag', markX, tabTop + tabHeight / 2)
  }
  ctx.restore()
}

function resetLiveControls() {
  cancelCountdown()
  clearTimeout(focusTimer)
  cameraHardware = undefined
  $('liveCameraTools').hidden = true
  $('cameraGrid').hidden = true
  $('focusPoint').hidden = true
  $('zoomControl').hidden = true
  video.classList.remove('can-focus')
}

function videoFrame() {
  const box = video.getBoundingClientRect()
  if (!video.videoWidth || !video.videoHeight || !box.width || !box.height) return undefined
  // The full-screen phone layout fills the screen (cover) and crops the edges; otherwise it fits (contain).
  const fit = getComputedStyle(video).objectFit === 'cover' ? Math.max : Math.min
  const scale = fit(box.width / video.videoWidth, box.height / video.videoHeight)
  const width = video.videoWidth * scale
  const height = video.videoHeight * scale
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }
}

function updateCameraGrid() {
  const grid = $('cameraGrid')
  if (!gridEnabled || video.hidden) {
    grid.hidden = true
    return
  }
  const frame = videoFrame()
  if (!frame) return
  const bounds = grid.parentElement.getBoundingClientRect()
  // Keep the grid on the visible part of the preview.
  const left = Math.max(frame.left, bounds.left), top = Math.max(frame.top, bounds.top)
  const right = Math.min(frame.left + frame.width, bounds.right), bottom = Math.min(frame.top + frame.height, bounds.bottom)
  grid.style.left = `${left - bounds.left}px`
  grid.style.top = `${top - bounds.top}px`
  grid.style.width = `${right - left}px`
  grid.style.height = `${bottom - top}px`
  grid.hidden = false
}
window.addEventListener('resize', updateCameraGrid)

// The floating bottom bar's height positions the zoom slider, messages and review photo.
function syncBottomBar() {
  const bar = $('review').hidden ? $('controls') : $('review')
  document.documentElement.style.setProperty('--bottom-bar', `${bar.offsetHeight}px`)
}
if ('ResizeObserver' in window) {
  const observer = new ResizeObserver(syncBottomBar)
  observer.observe($('controls'))
  observer.observe($('review'))
}
window.addEventListener('resize', syncBottomBar)
video.addEventListener('resize', updateCameraGrid)
$('gridToggle').addEventListener('click', () => {
  gridEnabled = !gridEnabled
  $('gridToggle').setAttribute('aria-pressed', String(gridEnabled))
  updateCameraGrid()
})

function setZoomLabel(value) {
  $('zoomValue').textContent = `${Number(value.toFixed(2))}×`
}

function showLiveControls(track) {
  const capabilities = track.getCapabilities?.() || {}
  const settings = track.getSettings()
  const focus = capabilities.focusMode?.includes('single-shot') &&
    !!navigator.mediaDevices.getSupportedConstraints?.().pointsOfInterest
  cameraHardware = {
    track, focus, desired: {}, queue: Promise.resolve(), base: track.getConstraints?.() || {}
  }
  $('liveCameraTools').hidden = false
  $('torchToggle').hidden = capabilities.torch !== true
  $('torchToggle').setAttribute('aria-pressed', String(settings.torch === true))
  $('torchToggle').disabled = false
  const zoom = capabilities.zoom
  const hasZoom = Number.isFinite(zoom?.min) && Number.isFinite(zoom?.max) && zoom.max > zoom.min
  $('zoomControl').hidden = !hasZoom
  if (hasZoom) {
    const slider = $('zoomSlider')
    slider.min = zoom.min
    slider.max = zoom.max
    slider.step = zoom.step > 0 ? zoom.step : 'any'
    slider.value = settings.zoom ?? Math.min(zoom.max, Math.max(zoom.min, 1))
    setZoomLabel(slider.valueAsNumber)
  }
  video.classList.toggle('can-focus', !!focus)
  updateCameraGrid()
}

function applyHardwareSetting(camera, change) {
  camera.queue = camera.queue.then(async () => {
    if (cameraHardware !== camera) return false
    const next = { ...camera.desired, ...change }
    await camera.track.applyConstraints({ ...camera.base, advanced: [next] })
    camera.desired = next
    return cameraHardware === camera
  }).catch(() => false)
  return camera.queue
}

$('torchToggle').addEventListener('click', async () => {
  const camera = cameraHardware
  if (!camera) return
  const button = $('torchToggle')
  const enable = button.getAttribute('aria-pressed') !== 'true'
  button.disabled = true
  const applied = await applyHardwareSetting(camera, { torch: enable })
  if (cameraHardware !== camera) return
  button.disabled = false
  if (applied) {
    button.setAttribute('aria-pressed', String(camera.track.getSettings().torch ?? enable))
  } else message('Torch is unavailable on this camera.')
})

$('zoomSlider').addEventListener('input', event => setZoomLabel(event.target.valueAsNumber))
$('zoomSlider').addEventListener('change', async event => {
  const camera = cameraHardware
  if (!camera) return
  const slider = event.currentTarget
  const value = slider.valueAsNumber
  const applied = await applyHardwareSetting(camera, { zoom: value })
  if (cameraHardware !== camera || slider.valueAsNumber !== value) return
  if (applied) {
    slider.value = camera.track.getSettings().zoom ?? value
  } else {
    slider.value = camera.track.getSettings().zoom ?? camera.desired.zoom ?? slider.min
    message('Zoom is unavailable on this camera.')
  }
  setZoomLabel(slider.valueAsNumber)
})

video.addEventListener('click', async event => {
  if (pinch || Date.now() - pinchEndedAt < 400) return
  const camera = cameraHardware
  const frame = videoFrame()
  if (!camera?.focus || !frame) return
  const x = (event.clientX - frame.left) / frame.width
  const y = (event.clientY - frame.top) / frame.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return
  const applied = await applyHardwareSetting(camera, {
    focusMode: 'single-shot', pointsOfInterest: [{ x: facing === 'user' ? 1 - x : x, y }]
  })
  if (!applied) return
  const marker = $('focusPoint')
  const bounds = marker.parentElement.getBoundingClientRect()
  marker.style.left = `${event.clientX - bounds.left}px`
  marker.style.top = `${event.clientY - bounds.top}px`
  marker.hidden = false
  clearTimeout(focusTimer)
  focusTimer = setTimeout(() => { marker.hidden = true }, 950)
})

// Pinch-to-zoom drives the same hardware zoom as the slider.
const touchPoints = new Map()
let pinch, pinchEndedAt = 0, zoomPending, zoomApplying

function pinchDistance() {
  const [a, b] = touchPoints.values()
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function requestZoom(camera, value) {
  zoomPending = { camera, value }
  if (zoomApplying) return
  zoomApplying = true
  ;(async () => {
    while (zoomPending) {
      const next = zoomPending
      zoomPending = undefined
      if (cameraHardware !== next.camera) break
      await applyHardwareSetting(next.camera, { zoom: next.value })
    }
    zoomApplying = false
    const camera = cameraHardware
    if (!pinch && camera) {
      const actual = camera.track.getSettings().zoom
      if (Number.isFinite(actual)) {
        $('zoomSlider').value = actual
        setZoomLabel($('zoomSlider').valueAsNumber)
      }
    }
  })()
}

video.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch') return
  touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (touchPoints.size === 2 && cameraHardware && !$('zoomControl').hidden) {
    pinch = { camera: cameraHardware, distance: pinchDistance(), zoom: $('zoomSlider').valueAsNumber }
  }
})
video.addEventListener('pointermove', event => {
  if (!touchPoints.has(event.pointerId)) return
  touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (!pinch || touchPoints.size < 2 || cameraHardware !== pinch.camera) return
  event.preventDefault()
  const slider = $('zoomSlider')
  const target = pinch.zoom * pinchDistance() / Math.max(pinch.distance, 1)
  const before = slider.valueAsNumber
  slider.value = Math.min(Number(slider.max), Math.max(Number(slider.min), target))
  if (slider.valueAsNumber === before) return
  setZoomLabel(slider.valueAsNumber)
  requestZoom(pinch.camera, slider.valueAsNumber)
})
function endTouch(event) {
  touchPoints.delete(event.pointerId)
  if (pinch && touchPoints.size < 2) {
    pinch = undefined
    pinchEndedAt = Date.now()
    if (!zoomApplying && cameraHardware) requestZoom(cameraHardware, $('zoomSlider').valueAsNumber)
  }
}
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) video.addEventListener(type, endTouch)

// The last photo stays available from a thumbnail beside the shutter.
// The last photos of this session stay available from the thumbnail; deleting one falls back to the previous.
const photoHistory = []
const MAX_PHOTOS = 12

function setCurrentPhoto(entry) {
  lastPhoto = entry
  photoUrl = entry?.url
  originalUrl = entry?.originalUrl
}

function releasePhoto(entry) {
  for (const url of [entry.url, entry.originalUrl, entry.thumb]) if (url) URL.revokeObjectURL(url)
}

function rememberPhoto(entry) {
  photoHistory.push(entry)
  while (photoHistory.length > MAX_PHOTOS) releasePhoto(photoHistory.shift())
  setCurrentPhoto(entry)
}

function removePhoto(entry) {
  const index = photoHistory.indexOf(entry)
  if (index < 0) return
  photoHistory.splice(index, 1)
  releasePhoto(entry)
  if (lastPhoto === entry) {
    const previous = photoHistory[photoHistory.length - 1]
    setCurrentPhoto(previous)
    showThumbnail(previous)
  }
}

function showThumbnail(entry, fresh = false) {
  const button = $('lastPhotoButton'), image = $('lastPhotoImage')
  if (!entry?.thumb) {
    image.hidden = true
    image.removeAttribute('src')
    button.disabled = true
    button.setAttribute('aria-label', 'Last photo. None yet')
    return
  }
  image.src = entry.thumb
  image.hidden = false
  button.disabled = false
  button.setAttribute('aria-label', 'Open last photo')
  if (fresh) {
    button.classList.remove('fresh')
    void button.offsetWidth
    button.classList.add('fresh')
  }
}

function updateThumbnail(canvas, entry) {
  const size = 144
  const thumb = document.createElement('canvas')
  thumb.width = thumb.height = size
  const scale = Math.max(size / canvas.width, size / canvas.height)
  const width = canvas.width * scale, height = canvas.height * scale
  thumb.getContext('2d').drawImage(canvas, (size - width) / 2, (size - height) / 2, width, height)
  thumb.toBlob(blob => {
    if (!blob) return
    if (!photoHistory.includes(entry)) return   // deleted or evicted while the thumbnail was being made
    entry.thumb = URL.createObjectURL(blob)
    if (lastPhoto === entry) showThumbnail(entry, true)
  }, 'image/jpeg', 0.82)
}

$('lastPhotoButton').addEventListener('click', () => {
  if (busy) return
  showReview()
})

// ---- Reviewing the last photo (opened from the thumbnail; the camera keeps running) ----
async function saveAutomatically(name, jpeg, original) {
  try {
    await exportToAndroid('save', name, jpeg)
    if (original) await exportToAndroid('save', name.replace('.jpg', '-original.jpg'), original)
  } catch {
    if (lastPhoto?.name === name) lastPhoto.saved = false
    message('Could not save the photo. Open it from the thumbnail to try again.', 6000)
  }
}

function fireFlash() {
  const flash = $('shutterFlash')
  flash.classList.remove('fire')
  void flash.offsetWidth
  flash.classList.add('fire')
}

function showReview() {
  if (!photoUrl || !lastPhoto) return
  cancelCountdown()
  clearGpsChoice()
  const { name, jpeg, shareFile } = lastPhoto
  $('start').hidden = true
  $('controls').hidden = true
  $('result').src = photoUrl
  $('result').hidden = false
  $('result').parentElement.classList.add('photo-review')
  $('retakeLabel').textContent = 'Camera'
  $('save').href = photoUrl
  $('save').download = name
  $('save').hidden = hostSaves && lastPhoto.saved
  $('saveOriginal').hidden = hostSaves || !originalUrl
  if (originalUrl) {
    $('saveOriginal').href = originalUrl
    $('saveOriginal').download = name.replace('.jpg', '-original.jpg')
  } else $('saveOriginal').removeAttribute('href')
  let canShare = hostSaves
  if (!hostSaves) {
    try { canShare = !!navigator.canShare?.({ files: [shareFile] }) } catch {}
  }
  $('share').hidden = !canShare
  updateSharePreference()
  $('share').onclick = async () => {
    try {
      if (hostSaves) await exportToAndroid('share', name, jpeg)
      else await navigator.share({ files: [shareFile] })
    } catch (error) {
      if (error.name !== 'AbortError') message('Sharing is unavailable. Use Save photo instead.')
    }
  }
  $('review').hidden = false
  $('deletePhoto').hidden = false
  message('')
  ;($('share').classList.contains('share-primary') ? $('share') : $('save')).focus()
  renderLiveStamp()
}

function hideReview() {
  $('result').hidden = true
  $('result').parentElement.classList.remove('photo-review')
  $('result').removeAttribute('src')
  $('review').hidden = true
  $('deletePhoto').hidden = true
  $('result').style.transition = 'none'
  $('result').style.transform = ''
  $('result').style.opacity = ''
  $('controls').hidden = false
  $('start').hidden = !!stream
  message('')
  renderLiveStamp()
}

// Leaving the photo view: back to the live camera.
function closePhotoView() {
  hideReview()
  if (!stream) startLiveCamera()
}

// ---- Delete the photo being viewed ----
$('deletePhoto').addEventListener('click', () => {
  const fromDevice = hostSaves && typeof android.deletePhoto === 'function'
  $('deleteText').textContent = !hostSaves
    ? 'It is only kept in this browser session, so it will be gone for good.'
    : fromDevice ? 'It will also be removed from Pictures/GeoZipTag in your Gallery.'
      : 'It will be removed from the app. This version cannot remove it from your Gallery, so delete it there too.'
  $('deleteConfirm').showModal()
})
$('cancelDelete').addEventListener('click', () => $('deleteConfirm').close())
$('confirmDelete').addEventListener('click', async () => {
  $('deleteConfirm').close()
  const entry = lastPhoto
  if (!entry) return
  const fromDevice = hostSaves && entry.saved && typeof android.deletePhoto === 'function'
  if (fromDevice) {
    try { await entry.saving } catch {}   // let the automatic save finish first, so no file is left behind
    android.deletePhoto(entry.name)
  }
  removePhoto(entry)
  closePhotoView()
  message(hostSaves && entry.saved && !fromDevice ? 'Removed from the app. It is still in your Gallery.' : 'Photo deleted',
    hostSaves && entry.saved && !fromDevice ? 5000 : 2000)
})
// The app reports back when the file could not be removed from the Gallery.
window.onPhotoDeleted = (name, ok) => {
  if (!ok) message('Could not remove the photo from your Gallery. Delete it there.', 6000)
}

// ---- Swipe down on the photo to go back to the camera ----
{
  const area = $('result').parentElement, photo = $('result')
  let drag
  const settle = (animated) => {
    photo.style.transition = animated ? 'transform .2s cubic-bezier(.2,.8,.2,1), opacity .2s' : 'none'
    photo.style.transform = ''
    photo.style.opacity = ''
  }
  area.addEventListener('pointerdown', (event) => {
    if (!area.classList.contains('photo-review') || event.target.closest('button')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), dy: 0, active: false }
    photo.style.transition = 'none'
  })
  area.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (!drag.active) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (dy <= 0 || Math.abs(dx) > dy) { drag = undefined; return }   // up or sideways: not a swipe down
      drag.active = true
      try { area.setPointerCapture(event.pointerId) } catch {}
    }
    drag.dy = dy
    photo.style.transform = `translateY(${dy}px) scale(${Math.max(0.8, 1 - dy / 1600)})`
    photo.style.opacity = String(Math.max(0.25, 1 - dy / 450))
  })
  const release = (event) => {
    if (!drag || drag.id !== event.pointerId) return
    const { dy, time, active } = drag
    drag = undefined
    if (!active) return
    const fast = dy / Math.max(1, performance.now() - time) > 0.6   // pixels per millisecond
    if (event.type !== 'pointercancel' && (dy > 110 || (dy > 40 && fast))) {
      photo.style.transition = 'transform .16s ease-in, opacity .16s'
      photo.style.transform = `translateY(${Math.round(window.innerHeight * 0.4)}px) scale(.8)`
      photo.style.opacity = '0'
      setTimeout(() => { closePhotoView(); settle(false) }, 150)
    } else settle(true)
  }
  photo.addEventListener('dragstart', (event) => event.preventDefault())   // the browser would otherwise start dragging the image
  area.addEventListener('pointerup', release)
  area.addEventListener('pointercancel', release)
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('review').hidden && !document.querySelector('dialog[open]')) closePhotoView()
})

function cancelCountdown() {
  clearInterval(countdownTimer)
  countdownTimer = undefined
  $('cameraCountdown').hidden = true
  $('shutter').setAttribute('aria-label', 'Take photo')
  $('shutter').classList.remove('counting')
}

$('timerToggle').addEventListener('click', () => {
  cancelCountdown()
  timerSeconds = ({ 0: 3, 3: 10, 10: 0 })[timerSeconds]
  const label = timerSeconds ? `Timer ${timerSeconds}s` : 'Timer off'
  $('timerLabel').textContent = timerSeconds ? `${timerSeconds}s` : 'Off'
  $('timerToggle').setAttribute('aria-label', label)
  $('timerToggle').setAttribute('aria-pressed', String(timerSeconds > 0))
})

function takeLivePhoto(snapshot) {
  if (!timerSeconds) {
    capture(video, false, snapshot)
    return
  }
  const deadline = Date.now() + timerSeconds * 1000
  const countdown = $('cameraCountdown')
  countdown.textContent = timerSeconds
  countdown.hidden = false
  $('shutter').setAttribute('aria-label', 'Cancel timer')
  $('shutter').classList.add('counting')
  countdownTimer = setInterval(() => {
    const remaining = Math.ceil((deadline - Date.now()) / 1000)
    if (remaining > 0) {
      if (countdown.textContent !== String(remaining)) countdown.textContent = remaining
      return
    }
    cancelCountdown()
    if (!video.hidden) capture(video, false, snapshot && !snapshot.manual ? currentFix() || freshFix(snapshot) : snapshot)
  }, 100)
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelCountdown()
})

async function capture(source, picked, snapshot) {
  if (busy) return
  busy = true
  const date = new Date()
  if (snapshot && !snapshot.name && placeLabel) snapshot = { ...snapshot, name: placeLabel }
  $('shutter').disabled = true
  $('fallback').disabled = true
  $('startCamera').disabled = true
  $('switchCamera').disabled = true
  if (source === video) fireFlash()
  if (source !== video) message('Stamping photo…')
  else if (snapshot && !placeReady(snapshot)) message('Adding address and satellite map…')
  try {
    const canvas = document.createElement('canvas')
    canvas.width = picked ? source.naturalWidth : source.videoWidth
    canvas.height = picked ? source.naturalHeight : source.videoHeight
    if (!canvas.width || !canvas.height) throw new Error('No image frame')
    canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0)
    const original = preferences.keepOriginal ? await exportJpeg(canvas) : undefined
    const { address, map } = await placeFor(snapshot)
    await stampFonts
    drawStamp(canvas, { snapshot, date, picked, address, map })
    const jpeg = await exportJpeg(canvas)
    if (!jpeg) throw new Error('Export unavailable')
    const name = `GeoZipTag-${date.toISOString().replace(/[:.]/g, '-')}.jpg`
    const shareFile = new File([jpeg], name, { type: 'image/jpeg' })
    fromPicker = picked
    const entry = {
      jpeg, date, snapshot, address, note: stampNote, name, shareFile, saved: false,
      url: URL.createObjectURL(jpeg), originalUrl: original ? URL.createObjectURL(original) : undefined
    }
    rememberPhoto(entry)
    // The photo is ready: the thumbnail updates at once and the viewfinder stays on screen.
    updateThumbnail(canvas, entry)
    if (hostSaves) {
      entry.saved = true
      entry.saving = saveAutomatically(name, jpeg, original)
    }
    if (source !== video && !stream) startLiveCamera()
    const complete = !snapshot || (address && map)
    if (complete) message(hostSaves ? '' : 'Photo ready · tap the thumbnail to save or share', hostSaves ? 0 : 3500)
    else message(map ? 'Satellite map added · address unavailable' : address ? 'Address added · satellite map unavailable' :
      'Timestamp and coordinates added · map and address unavailable', 6000)
  } catch {
    message('Could not create the photo. Take another photo or try the phone camera.')
  } finally {
    busy = false
    $('shutter').disabled = false
    $('fallback').disabled = false
    $('switchCamera').disabled = false
    resetStart()
  }
}

function exportJpeg(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94))
}

$('shutter').addEventListener('click', () => {
  if (countdownTimer !== undefined) cancelCountdown()
  else requestCapture(takeLivePhoto)
})
file.addEventListener('change', async () => {
  const image = file.files?.[0]
  file.value = ''
  const snapshot = freshFix(pickerFix)
  pickerFix = undefined
  if (!image) return
  const url = URL.createObjectURL(image)
  try { await capture(await loadImage(url), true, snapshot) }
  catch { message('This image could not be opened. Try a JPEG or PNG photo.') }
  finally { URL.revokeObjectURL(url) }
})
$('retake').addEventListener('click', closePhotoView)
window.addEventListener('pagehide', () => {
  stopCamera()
  if (!$('controls').hidden) $('start').hidden = false
  resetStart()
  if (watchId !== undefined) stopLocation()
  clearGpsChoice()
})

$('stampNote').addEventListener('input', (event) => {
  stampNote = event.target.value.trim()
})

$('placeLabel').addEventListener('input', (event) => {
  placeLabel = event.target.value.trim()
  $('placeLabelPreview').textContent = placeLabel
  $('placeLabelPreview').hidden = !placeLabel
})

function updateTemplateLabel() {
  setTimeout(renderLiveStamp)
  prefetchPlace(manualFix || currentFix())
  $('chosenTemplate').textContent = { satellite: 'Satellite', time: 'Date & Time', qr: 'QR Location' }[preferences.template]
  for (const tab of document.querySelectorAll('[data-template]')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.template === preferences.template))
  }
  $('startWithoutLocation').hidden = preferences.template === 'time'
  updateLocationMapAction()
  if (!busy) resetStart()
}
updateTemplateLabel()

$('settingsPhoneCamera').addEventListener('click', () => {
  $('settings').close()
  $('fallback').click()
})

function savePreferences() {
  try { localStorage.setItem('geostampPreferences', JSON.stringify(preferences)) } catch {}
}

function updateSharePreference() {
  const highlightShare = (preferences.preferShare || $('save').hidden) && !$('share').hidden
  $('share').classList.toggle('share-primary', highlightShare)
  $('save').classList.toggle('primary', !highlightShare)
  $('save').classList.toggle('secondary', highlightShare)
}

let templateExample

function renderTemplatePreview() {
  const preview = $('templatePreview')
  const canvas = document.createElement('canvas')
  canvas.width = preview.width
  canvas.height = 540
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
  gradient.addColorStop(0, '#424e65')
  gradient.addColorStop(1, '#202937')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (video.videoWidth && stream) {
    const size = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
    const width = video.videoWidth * size
    const height = video.videoHeight * size
    ctx.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
  } else {
    if (!templateExample) {
      templateExample = new Image()
      templateExample.addEventListener('load', () => {
        if ($('templates').open) renderTemplatePreview()
      }, { once: true })
      templateExample.src = 'assets/stamp-example.jpg'
    }
    if (templateExample.naturalWidth) {
      const scale = Math.max(canvas.width / templateExample.naturalWidth, canvas.height / templateExample.naturalHeight)
      const width = templateExample.naturalWidth * scale
      const height = templateExample.naturalHeight * scale
      ctx.drawImage(templateExample, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
    }
  }
  if (!stampFontsReady) stampFonts.then(() => { if ($('templates').open) renderTemplatePreview() })
  const isTime = preferences.template === 'time'
  const map = document.createElement('canvas')
  map.width = map.height = 128
  const grid = map.getContext('2d')
  grid.fillStyle = '#3e4c61'
  grid.fillRect(0, 0, 128, 128)
  grid.strokeStyle = '#a7b3ca'
  grid.lineWidth = 4
  grid.beginPath()
  grid.moveTo(8, 0)
  grid.lineTo(100, 128)
  grid.moveTo(0, 92)
  grid.lineTo(128, 44)
  grid.stroke()
  drawStamp(canvas, {
    snapshot: isTime ? undefined : { lat: 17.2, lon: 79.2 },
    address: isTime ? undefined : { street: 'Site access road', locality: 'Example village', county: 'Example mandal', state: 'Telangana', postcode: '500001', country: 'India' },
    note: stampNote || 'Foundation inspection, Block B',
    map: isTime ? undefined : map, date: new Date(), example: true
  })
  const y = preferences.position === 'top' ? 0 : canvas.height - preview.height
  preview.getContext('2d').drawImage(canvas, 0, y, preview.width, preview.height, 0, 0, preview.width, preview.height)
}

for (const tab of document.querySelectorAll('[data-template]')) {
  tab.addEventListener('click', () => {
    const radio = document.querySelector(`input[name="template"][value="${tab.dataset.template}"]`)
    if (busy || radio.checked) return
    radio.checked = true
    radio.dispatchEvent(new Event('change'))
  })
}

for (const element of document.querySelectorAll('input[name="template"]')) {
  element.checked = element.value === preferences.template
  element.addEventListener('change', () => {
    preferences.template = element.value
    updateTemplateLabel()
    savePreferences()
    clearGpsChoice()
    renderTemplatePreview()
  })
}

$('stampPosition').value = preferences.position
$('keepOriginal').checked = preferences.keepOriginal
$('preferShare').checked = preferences.preferShare

$('settings').addEventListener('change', () => {
  setTimeout(renderLiveStamp)
  preferences.position = $('stampPosition').value
  preferences.keepOriginal = $('keepOriginal').checked
  preferences.preferShare = $('preferShare').checked
  savePreferences()
  updateSharePreference()
})

let pinPreview, pinAbort

function readManualFix() {
  const lat = $('manualLat').valueAsNumber
  const lon = $('manualLon').valueAsNumber
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined
  return { lat, lon, name: $('manualName').value.trim(), manual: true }
}

function setManualFields(snapshot) {
  $('manualLat').value = snapshot ? snapshot.lat.toFixed(6) : ''
  $('manualLon').value = snapshot ? snapshot.lon.toFixed(6) : ''
}

function resetPinPreview() {
  pinAbort?.abort()
  pinAbort = undefined
  pinPreview = undefined
  $('pinView').hidden = true
  $('loadPinMap').disabled = false
}

function paintPin(x, y) {
  const canvas = $('pinMap')
  const ctx = canvas.getContext('2d')
  ctx.drawImage(pinPreview.image, 0, 0, canvas.width, canvas.height)
  ctx.beginPath()
  ctx.arc(x, y, 7, 0, Math.PI * 2)
  ctx.fillStyle = '#db3846'
  ctx.fill()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.stroke()
}

$('loadPinMap').addEventListener('click', async () => {
  const snapshot = readManualFix()
  if (!snapshot) {
    $('pinStatus').textContent = 'Enter valid latitude and longitude first.'
    return
  }
  resetPinPreview()
  const abort = new AbortController()
  pinAbort = abort
  const timer = setTimeout(() => abort.abort(), 5000)
  $('loadPinMap').disabled = true
  $('pinStatus').textContent = 'Loading satellite preview…'
  try {
    const map = await loadSatelliteMap(snapshot, url => lookup(url, abort.signal), abort.signal, 17, 256)
    if (pinAbort !== abort) return
    if (map) {
      pinPreview = map
      paintPin(128, 128)
      $('pinView').hidden = false
      $('pinStatus').textContent = 'Tap the map to move the pin, or edit the coordinates.'
    } else {
      $('pinStatus').textContent = 'Satellite preview unavailable. You can still use the coordinates.'
    }
  } finally {
    clearTimeout(timer)
    if (pinAbort === abort) {
      pinAbort = undefined
      $('loadPinMap').disabled = false
    }
  }
})

$('pinMap').addEventListener('click', (event) => {
  if (!pinPreview) return
  const canvas = $('pinMap')
  const { left, top, width, height } = canvas.getBoundingClientRect()
  const x = Math.max(0, Math.min(255, (event.clientX - left) / width * canvas.width))
  const y = Math.max(0, Math.min(255, (event.clientY - top) / height * canvas.height))
  const normalizedX = ((pinPreview.left + x) / pinPreview.worldSize + 1) % 1
  const normalizedY = (pinPreview.top + y) / pinPreview.worldSize
  setManualFields({
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * normalizedY))) * 180 / Math.PI,
    lon: normalizedX * 360 - 180
  })
  paintPin(x, y)
})

for (const id of ['manualLat', 'manualLon']) {
  $(id).addEventListener('input', () => {
    resetPinPreview()
    $('pinStatus').textContent = 'Preview the pin to check the updated coordinates.'
  })
}

$('copyGps').addEventListener('click', () => {
  const use = (snapshot) => {
    if (!$('manual').open) return
    resetPinPreview()
    setManualFields(snapshot)
    $('pinStatus').textContent = 'Coordinates ready. Preview the pin to confirm or adjust it.'
  }
  const snapshot = currentFix()
  if (snapshot) {
    use(snapshot)
  } else if (navigator.geolocation) {
    $('pinStatus').textContent = 'Requesting device location…'
    navigator.geolocation.getCurrentPosition(({ coords }) => use({ lat: coords.latitude, lon: coords.longitude }), () => {
      if ($('manual').open) $('pinStatus').textContent = 'Device location unavailable. You can enter coordinates manually.'
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 })
  } else {
    $('pinStatus').textContent = 'Device location unavailable. You can enter coordinates manually.'
  }
})

$('manualForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const snapshot = readManualFix()
  if (!snapshot) return
  stopLocation()
  manualFix = snapshot
  prefetchPlace(snapshot)
  timestampOnly = false
  $('location').textContent = 'Use device location'
  setLocationStatus('Manual location ready', true)
  clearGpsChoice()
  $('manual').close()
})

$('clearManual').addEventListener('click', () => {
  manualFix = undefined
  $('manual').close()
  enableLocation()
})
$('manual').addEventListener('close', resetPinPreview)

function locationLabel(photo) {
  const { snapshot, address } = photo || {}
  if (!snapshot) return ''
  const place = placeHeading(snapshot, address)
  const coordinates = `${snapshot.lat.toFixed(6)}, ${snapshot.lon.toFixed(6)}`
  return [place, `${snapshot.manual ? 'Manual location' : 'GPS'} ${coordinates}`].filter(Boolean).join(' · ')
}

function updateReportFields() {
  const comparison = $('reportType').value === 'comparison'
  $('reportCompareFields').hidden = !comparison
  $('reportPhotoFields').hidden = comparison
  $('reportLocation').placeholder = comparison || $('reportPhoto').files[0] ? 'Site or address' : locationLabel(lastPhoto) || 'Site or address'
  $('reportStatus').textContent = ''
}
for (const input of document.querySelectorAll('.file-input')) {
  const drop = document.querySelector(`label.file-drop[for="${input.id}"]`)
  const hint = drop?.querySelector('small')
  const empty = hint?.textContent
  input.addEventListener('change', () => {
    const chosen = input.files?.[0]
    drop?.classList.toggle('has-file', !!chosen)
    if (hint) hint.textContent = chosen ? chosen.name : empty
  })
}
$('reportType').addEventListener('change', updateReportFields)
$('reportPhoto').addEventListener('change', updateReportFields)

// ---------- PDF report ----------
// One layout for the browser print dialog and the Android print service.
const reportHost = typeof android === 'object' && android ? android : undefined
const reportCss = `
@page { size: A4; margin: 14mm 14mm 16mm;
  @bottom-left { content: "GeoZipTag photo report"; font: 500 7.5pt Inter, system-ui, sans-serif; color: #7a8487; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 500 7.5pt Inter, system-ui, sans-serif; color: #7a8487; } }
#reportDocument { display: block; color: #1d2528; font: 9.5pt/1.45 Inter, system-ui, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
#reportDocument * { box-sizing: border-box; }
.gz-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 8mm;
  padding-bottom: 3.5mm; border-bottom: 0.6mm solid #c3422b; }
.gz-logo { display: block; height: 8.5mm; width: auto; }
.gz-company-logo { height: auto; max-height: 15mm; max-width: 62mm; object-fit: contain; }
.gz-head-meta { display: grid; justify-items: end; gap: 0.6mm; color: #5b6669; font-size: 8pt; text-align: right; }
.gz-kicker { color: #123f49; font-size: 7.5pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
.gz-title { margin: 7mm 0 5mm; }
.gz-title h1 { margin: 0; color: #123f49; font-size: 20pt; line-height: 1.15; letter-spacing: -.02em; }
.gz-title p { margin: 1.5mm 0 0; color: #5b6669; font-size: 10.5pt; font-weight: 500; }
.gz-summary { display: flex; gap: 6mm; align-items: flex-start; margin-bottom: 6mm; padding: 4.5mm 5mm;
  border-radius: 2.5mm; background: #f6f1e7; break-inside: avoid; }
.gz-details { flex: 1; display: grid; grid-template-columns: 27mm 1fr; gap: 1.8mm 4mm; margin: 0; }
.gz-details dt { color: #7a8487; font-size: 7.5pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding-top: .4mm; }
.gz-details dd { margin: 0; color: #1d2528; font-weight: 500; }
.gz-details dd.gz-strong { color: #123f49; font-size: 11pt; font-weight: 700; }
.gz-qr { flex: 0 0 auto; display: grid; justify-items: center; gap: 1.5mm; margin: 0; }
.gz-qr img { display: block; width: 24mm; height: 24mm; padding: 1.5mm; border-radius: 1.5mm; background: #fff; image-rendering: pixelated; }
.gz-qr figcaption { color: #5b6669; font-size: 6.5pt; font-weight: 600; letter-spacing: .04em; text-align: center; }
.gz-photos { display: grid; gap: 5mm; }
.gz-photos.gz-pair { grid-template-columns: 1fr 1fr; }
.gz-photo { display: grid; justify-items: center; align-content: start; margin: 0; break-inside: avoid; }
.gz-photo img { display: block; max-width: 100%; max-height: 150mm; width: auto; height: auto; border-radius: 2mm; }
.gz-pair .gz-photo img { max-height: 110mm; }
.gz-photo figcaption { display: flex; align-items: center; gap: 2.5mm; margin-top: 2mm; color: #5b6669; font-size: 8pt; }
.gz-label { padding: .5mm 2.2mm; border-radius: 99mm; background: #123f49; color: #fff; font-size: 7pt; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.gz-pair .gz-photo:last-child .gz-label { background: #c3422b; }
.gz-notes { margin-top: 6mm; padding-top: 4mm; border-top: 0.25mm solid #d9dcdc; break-inside: avoid; }
.gz-notes h2 { margin: 0 0 2mm; color: #123f49; font-size: 8pt; letter-spacing: .14em; text-transform: uppercase; }
.gz-notes p { margin: 0; white-space: pre-wrap; }
`

let reportAssets
async function loadReportAssets() {
  if (reportAssets) return reportAssets
  const text = async (path) => (await fetch(path)).text()
  const dataUrl = async (path) => readPhotoBlob(await (await fetch(path)).blob())
  const [logo, font] = await Promise.all([
    text('assets/geoziptag-wordmark-light.svg').then(svg => `data:image/svg+xml;base64,${btoa(svg)}`).catch(() => ''),
    reportHost ? dataUrl('assets/inter.woff2').catch(() => '') : Promise.resolve('')
  ])
  reportAssets = { logo, font }
  return reportAssets
}

function readPhotoBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function mapsQrDataUrl({ lat, lon }) {
  const qr = qrcode(0, 'M')
  const link = new URL('https://www.google.com/maps/search/')
  link.search = new URLSearchParams({ api: '1', query: `${lat.toFixed(6)},${lon.toFixed(6)}` })
  qr.addData(link.toString())
  qr.make()
  return qr.createDataURL(4, 0)
}

const reportDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

function reportElement(tag, text, parent, className) {
  const element = document.createElement(tag)
  if (text) element.textContent = text
  if (className) element.className = className
  parent.append(element)
  return element
}

// Company logo for reports: chosen once, kept on this device as a clean PNG.
const reportLogoKey = 'geoziptagReportLogo'
let reportLogo = ''
try { reportLogo = localStorage.getItem(reportLogoKey) || '' } catch {}

function showReportLogo() {
  $('reportLogoPreview').src = reportLogo || ''
  $('reportLogoPreview').hidden = !reportLogo
  $('removeReportLogo').hidden = !reportLogo
  $('reportLogoHint').textContent = reportLogo ? 'Shown on every report' : 'Optional · PNG, JPG or SVG'
  document.querySelector('label.logo-drop').classList.toggle('has-file', !!reportLogo)
}
showReportLogo()

$('reportLogo').addEventListener('change', async () => {
  const chosen = $('reportLogo').files?.[0]
  $('reportLogo').value = ''
  if (!chosen) return
  const url = URL.createObjectURL(chosen)
  try {
    const image = await loadImage(url)
    // Redraw into a bounded PNG: strips anything but pixels and keeps transparency.
    const width = image.naturalWidth || 600, height = image.naturalHeight || 200
    const scale = Math.min(1, 1200 / width, 400 / height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    reportLogo = canvas.toDataURL('image/png')
    let kept = true
    try { localStorage.setItem(reportLogoKey, reportLogo) } catch { kept = false }
    showReportLogo()
    $('reportStatus').textContent = kept ? '' : 'Logo added for now, but it could not be saved for next time.'
  } catch {
    $('reportStatus').textContent = 'This logo could not be opened. Try a PNG or JPG image.'
  } finally {
    URL.revokeObjectURL(url)
  }
})

$('removeReportLogo').addEventListener('click', () => {
  reportLogo = ''
  try { localStorage.removeItem(reportLogoKey) } catch {}
  showReportLogo()
})

let reportUrls = []
function clearReportImages() {
  reportUrls.forEach(url => URL.revokeObjectURL(url))
  reportUrls = []
  $('reportDocument').replaceChildren()
}
$('reports').addEventListener('close', clearReportImages)

$('reportForm').addEventListener('submit', async (event) => {
  event.preventDefault()
  const comparison = $('reportType').value === 'comparison'
  const chosenPhoto = $('reportPhoto').files[0]
  const photos = comparison ? [
    { file: $('beforePhoto').files[0], label: 'Before' },
    { file: $('afterPhoto').files[0], label: 'After' }
  ] : [{ file: chosenPhoto || lastPhoto?.jpeg, label: 'Photo' }]
  if (photos.some(photo => !photo.file)) {
    $('reportStatus').textContent = comparison ? 'Choose both a before and an after photo.' : 'Take a photo or choose one for the report.'
    return
  }

  clearReportImages()
  const report = $('reportDocument')
  $('printReport').disabled = true
  $('reportStatus').textContent = 'Preparing report…'
  try {
    const { logo, font } = await loadReportAssets()
    const company = $('reportCompany').value.trim()
    const project = $('reportProject').value.trim()
    const enteredLocation = $('reportLocation').value.trim()
    const notes = $('reportNote').value.trim()
    // Capture details are only known for the latest photo taken in the app.
    const captured = !comparison && !chosenPhoto ? lastPhoto : undefined
    const kind = comparison ? 'Before and after' : 'Photo report'

    const head = reportElement('header', '', report, 'gz-head')
    if (reportLogo || logo) {
      const image = reportElement('img', '', head, reportLogo ? 'gz-logo gz-company-logo' : 'gz-logo')
      image.src = reportLogo || logo
      image.alt = reportLogo ? (company || 'Company logo') : 'GeoZipTag'
    } else reportElement('strong', 'GeoZipTag', head)
    const meta = reportElement('div', '', head, 'gz-head-meta')
    reportElement('span', kind, meta, 'gz-kicker')
    reportElement('span', `Prepared ${reportDay.format(new Date())}`, meta)

    const title = reportElement('section', '', report, 'gz-title')
    reportElement('h1', project || (comparison ? 'Before and after comparison' : 'Site photo report'), title)
    if (company) reportElement('p', company, title)

    const details = []
    const place = enteredLocation || (captured?.snapshot ? placeHeading(captured.snapshot, captured.address) : '')
    if (place) details.push(['Location', place, true])
    if (captured?.address) details.push(['Address', addressText(captured.address, captured.snapshot)])
    if (captured?.snapshot) {
      details.push(['Coordinates', `${formatCoordinates(captured.snapshot)}${captured.snapshot.manual ? ' (manual pin)' : ' (GPS)'}`])
    }
    if (captured) details.push(['Captured', timeAt(captured.snapshot).full.format(captured.date)])
    if (captured?.note) details.push(['Stamp note', captured.note])
    if (details.length) {
      const summary = reportElement('section', '', report, 'gz-summary')
      const list = reportElement('dl', '', summary, 'gz-details')
      for (const [label, value, strong] of details) {
        reportElement('dt', label, list)
        reportElement('dd', value, list, strong ? 'gz-strong' : '')
      }
      if (captured?.snapshot) {
        const code = reportElement('figure', '', summary, 'gz-qr')
        const image = reportElement('img', '', code)
        image.src = mapsQrDataUrl(captured.snapshot)
        image.alt = 'QR code linking to this location on a map'
        reportElement('figcaption', 'Scan to open location', code)
      }
    }

    const images = reportElement('section', '', report, comparison ? 'gz-photos gz-pair' : 'gz-photos')
    await Promise.all(photos.map(async ({ file, label }) => {
      const figure = reportElement('figure', '', images, 'gz-photo')
      const image = reportElement('img', '', figure)
      image.alt = label
      const caption = reportElement('figcaption', '', figure)
      reportElement('span', label, caption, 'gz-label')
      if (captured) reportElement('span', 'Stamped by GeoZipTag at capture', caption)
      else if (file.name) reportElement('span', file.name, caption)
      if (reportHost) image.src = await readPhotoBlob(file)
      else {
        const url = URL.createObjectURL(file)
        reportUrls.push(url)
        image.src = url
      }
      await image.decode()
    }))

    if (notes) {
      const section = reportElement('section', '', report, 'gz-notes')
      reportElement('h2', 'Notes', section)
      reportElement('p', notes, section)
    }

    const fileTitle = ['GeoZipTag', project || kind, new Date().toISOString().slice(0, 10)].join(' - ')
    $('reportStatus').textContent = 'Choose Save as PDF in the print dialog to keep a copy.'
    if (reportHost) {
      const fontFace = font ? `@font-face { font-family: Inter; src: url(${font}) format("woff2"); font-weight: 400 700; }` : ''
      const title = document.createElement('title')
      title.textContent = fileTitle
      reportHost.printReport(`<!doctype html><meta charset="utf-8">${title.outerHTML}<style>${fontFace}${reportCss}</style>${report.outerHTML}`)
    } else {
      let style = $('reportStyle')
      if (!style) {
        style = document.createElement('style')
        style.id = 'reportStyle'
        style.media = 'print'
        style.textContent = reportCss
        document.head.append(style)
      }
      const pageTitle = document.title
      document.title = fileTitle
      window.print()
      document.title = pageTitle
    }
  } catch {
    $('reportStatus').textContent = 'A photo could not be opened. Try a JPEG or PNG image.'
  } finally {
    $('printReport').disabled = false
  }
})

for (const button of document.querySelectorAll('[data-open]')) {
  button.addEventListener('click', () => {
    if (busy) return
    cancelCountdown()
    const panel = button.dataset.open
    if (panel === 'templates') renderTemplatePreview()
    if (panel === 'manual') {
      const snapshot = manualFix || currentFix()
      $('manualName').value = manualFix?.name || ''
      setManualFields(snapshot)
      $('pinStatus').textContent = 'Enter coordinates or use a GPS fix, then preview the pin.'
    }
    if (panel === 'reports') {
      $('reportSource').textContent = lastPhoto ? 'The latest stamped photo is ready to use.' : 'Take a photo first or select one below.'
      updateReportFields()
    }
    document.querySelector('dialog[open]')?.close()
    $(panel).showModal()
  })
}

function openViewfinderOnEntry() {
  if (window.isSecureContext && window.self === window.top && navigator.mediaDevices?.getUserMedia && $('review').hidden) {
    startLiveCamera(!timestampOnly)
  }
}

openViewfinderOnEntry()
window.addEventListener('pageshow', event => {
  if (event.persisted) openViewfinderOnEntry()
})

// Live stamp preview (phones): the stamp as it will appear, drawn over the camera
// preview and under the controls. Refreshed every second and whenever data changes.
const liveStamp = $('liveStamp')
const phoneLayout = window.matchMedia('(max-width: 759px)')
function renderLiveStamp() {
  const show = phoneLayout.matches && (!video.hidden || switching) && $('review').hidden
  liveStamp.hidden = !show
  if (!show) return
  const scale = Math.min(window.devicePixelRatio || 1, 3)
  const width = Math.round(window.innerWidth * scale), height = Math.round(window.innerHeight * scale)
  if (liveStamp.width !== width || liveStamp.height !== height) { liveStamp.width = width; liveStamp.height = height }
  liveStamp.getContext('2d').clearRect(0, 0, width, height)
  let snapshot = preferences.template === 'time' ? undefined : manualFix || currentFix()
  if (snapshot && !snapshot.name && placeLabel) snapshot = { ...snapshot, name: placeLabel }
  const place = snapshot && placeReady(snapshot) ? placeCache.result : undefined
  drawStamp(liveStamp, { snapshot, date: new Date(), picked: false, address: place?.address, map: place?.map })
}
setInterval(renderLiveStamp, 1000)
window.addEventListener('resize', renderLiveStamp)
stampFonts.then(renderLiveStamp)

$('appVersion').textContent = 'GeoZipTag · web version'
