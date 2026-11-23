import qrcode from './vendor/qrcode.mjs'

const $ = (id) => document.getElementById(id)
const video = $('video')
const file = $('file')
const status = $('status')
const android = window.AndroidHost
const hasPhoneCamera = typeof android?.preparePhoneCamera === 'function'
let phoneRequest, phoneMetadata, lastPhoneMode
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
const preferences = { template: 'satellite', position: 'bottom', keepOriginal: false, preferShare: false, aspect: '16:9',
  quality: 'high', tapAction: 'focus', volumeShutter: true, shareAfter: false,
  mirrorFront: false, showLevel: false }
try {
  const saved = JSON.parse(localStorage.getItem('geostampPreferences') || '{}')
  if (['satellite', 'time', 'qr'].includes(saved.template)) preferences.template = saved.template
  if (saved.position === 'top') preferences.position = 'top'
  preferences.keepOriginal = saved.keepOriginal === true
  preferences.preferShare = saved.preferShare === true
  if (['16:9', '4:3', '1:1'].includes(saved.aspect)) preferences.aspect = saved.aspect
  if (saved.quality === 'standard') preferences.quality = 'standard'
  if (saved.tapAction === 'capture') preferences.tapAction = 'capture'
  preferences.volumeShutter = saved.volumeShutter !== false
  preferences.shareAfter = saved.shareAfter === true
  preferences.mirrorFront = saved.mirrorFront === true
  preferences.showLevel = saved.showLevel === true
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
      // Stamps always read "Monday, 23/11/2026 · 2:33 AM GMT+05:30" (day/month/year), whatever the phone's language.
      date: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', ...zone }),
      time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'longOffset', ...zone }),
      clock: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', ...zone }),
      longDate: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', ...zone }),
      zoneName: new Intl.DateTimeFormat(undefined, { timeZoneName: 'long', ...zone }),
      offset: new Intl.DateTimeFormat(undefined, { timeZoneName: 'longOffset', ...zone }),
      calendar: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', weekday: 'long', ...zone })
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

// "India Standard Time · GMT+05:30"
function zoneLabel(formats, date) {
  const part = (format) => format.formatToParts(date).find(item => item.type === 'timeZoneName')?.value || ''
  const name = part(formats.zoneName), offset = part(formats.offset)
  return [...new Set([name, offset].filter(Boolean))].join(' · ')
}

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

// ---- Native camera (iPhone app): the phone's own photo camera, with its preview drawn by the app behind
// the page. It is driven through stand-ins for a camera stream and track, so the rest of the page
// (zoom buttons, torch, focus, pinch, flip) works the same as with the browser camera. ----
const nativeHost = typeof android?.cameraStart === 'function' ? android : undefined
let nativeOpen, nativeStopTimer, nativeEnded, nativePhotoCount = 0
const nativePhotos = new Map()
window.onNativeCamera = (state) => {
  if (state?.ended) { nativeEnded?.(); return }
  const done = nativeOpen
  nativeOpen = undefined
  done?.(state)
}
window.onNativePhoto = (id, ok) => nativePhotos.get(id)?.(ok)

function openNativeCamera(nextFacing) {
  return new Promise((resolve, reject) => {
    clearTimeout(nativeStopTimer)   // flipping: stop and start become one switch
    nativeOpen?.(undefined)
    const timer = setTimeout(() => { nativeOpen = undefined; reject(new Error('timeout')) }, 60000)
    nativeOpen = (state) => {
      clearTimeout(timer)
      if (state?.ok) resolve(nativeStream(state))
      else reject(new Error(state?.error || 'unavailable'))
    }
    nativeHost.cameraStart(nextFacing)
  })
}

function nativeStream(state) {
  const settings = { facingMode: state.facing, zoom: state.zoom ?? 1, torch: false, flash: 'off', exposure: 0 }
  const track = {
    native: true,
    width: state.width,
    height: state.height,
    lenses: Array.isArray(state.lenses) ? state.lenses : undefined,
    getCapabilities: () => ({
      zoom: state.zoomMax > state.zoomMin ? { min: state.zoomMin, max: state.zoomMax, step: 0.01 } : undefined,
      torch: !!state.hasTorch,
      flash: Array.isArray(state.flashModes) && state.flashModes.length > 1 ? state.flashModes : undefined,
      exposure: state.exposureMax > state.exposureMin ? { min: state.exposureMin, max: state.exposureMax } : undefined,
      focusMode: state.canFocus ? ['single-shot'] : []
    }),
    getSettings: () => ({ ...settings }),
    getConstraints: () => ({}),
    async applyConstraints(constraints) {
      const change = constraints?.advanced?.[0] || {}
      if (Number.isFinite(change.zoom)) settings.zoom = change.zoom
      if (typeof change.torch === 'boolean') settings.torch = change.torch
      if (typeof change.flash === 'string') settings.flash = change.flash
      if (Number.isFinite(change.exposure)) settings.exposure = change.exposure
      nativeHost.cameraSet(JSON.stringify({ zoom: settings.zoom, torch: settings.torch, flash: settings.flash, exposure: settings.exposure }))
    },
    focusAt: (x, y) => nativeHost.cameraFocus(x, y),
    addEventListener: (type, listener) => { if (type === 'ended') nativeEnded = listener },
    stop: () => {
      clearTimeout(nativeStopTimer)
      nativeStopTimer = setTimeout(() => nativeHost.cameraStop(), 0)
    }
  }
  return { native: true, cameras: state.cameras || 1, getTracks: () => [track], getVideoTracks: () => [track] }
}

function takeNativePhoto() {
  return new Promise((resolve, reject) => {
    const id = `photo${Date.now()}x${++nativePhotoCount}`
    const timer = setTimeout(() => { nativePhotos.delete(id); reject(new Error('timeout')) }, 20000)
    nativePhotos.set(id, (ok) => {
      clearTimeout(timer)
      nativePhotos.delete(id)
      if (!ok) { reject(new Error('capture failed')); return }
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('photo unavailable'))
      image.src = `native-photo/${id}.jpg`
    })
    nativeHost.cameraCapture(id)
  })
}

// Size of the live picture, from the browser camera or the native one.
const liveWidth = () => stream?.native ? stream.getVideoTracks()[0].width : video.videoWidth
const liveHeight = () => stream?.native ? stream.getVideoTracks()[0].height : video.videoHeight

function stopCamera() {
  cameraRequest++
  stream?.getTracks().forEach((track) => track.stop())
  stream = undefined
  video.srcObject = null
  video.hidden = true
  document.documentElement.classList.remove('native-camera')
  $('shutter').hidden = true
  $('switchCamera').hidden = true
  resetLiveControls()
}

let switching = false
function freezeFrame() {
  const frame = $('switchFrame')
  if (stream?.native || video.hidden || !video.videoWidth || !video.videoHeight) return false
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
    let next
    if (nativeHost) {
      // The phone's own camera; the browser camera is only a fallback (never after a refused permission).
      next = await openNativeCamera(nextFacing).catch(error => {
        if (error.message === 'denied' || !navigator.mediaDevices?.getUserMedia) throw error
      })
    }
    if (!next) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable')
      next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      })
    }
    if (cameraRequest !== request) {
      next.getTracks().forEach((track) => track.stop())
      return
    }
    stream = next
    const track = stream.getVideoTracks()[0]
    facing = track.getSettings().facingMode || nextFacing
    document.documentElement.classList.toggle('native-camera', !!next.native)
    video.classList.toggle('mirror', facing === 'user')
    if (!next.native) {
      video.srcObject = stream
      await video.play()
      if (cameraRequest !== request) return
      if (!video.videoWidth) throw new Error('No camera frame')
    }
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
    const cameras = next.native ? Array.from({ length: next.cameras }, () => ({ kind: 'videoinput' }))
      : await navigator.mediaDevices.enumerateDevices().catch(() => [])
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
  if (requestLocation || (!timestampOnly && android?.hasLocationAccess?.())) {
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
  startCamera(facing === 'environment' ? 'user' : 'environment', { soft: !!stream?.native || freezeFrame() })
})

function openPicker(snapshot) {
  pickerFix = snapshot
  stopCamera()
  $('start').hidden = false
  resetStart()
  file.click()
}
if (hasPhoneCamera) {
  window.setPhoneCameraMetadata = (metadata) => {
    phoneMetadata = metadata
    if (!metadata) {
      const resume = phoneRequest?.resume
      phoneRequest = undefined
      message('')
      if (resume) startLiveCamera()
    }
  }
}

function openPhoneCamera(withLocation) {
  if (busy || phoneRequest) return
  const snapshot = withLocation ? manualFix || currentFix() : undefined
  phoneRequest = { withLocation, snapshot, resume: !video.hidden }
  phoneMetadata = undefined
  stopCamera()
  $('start').hidden = false
  resetStart()
  message('Opening phone camera…')
  android.preparePhoneCamera(withLocation && !snapshot?.manual)
  file.click()
}

$('fallback').addEventListener('click', () => {
  if (hasPhoneCamera) openPhoneCamera(preferences.template !== 'time' && !timestampOnly)
  else requestCapture(openPicker)
})

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
  $('addLocationMap').hidden = preferences.template === 'time' || !!(manualFix || currentFix())
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
// Photon answers with the nearest named thing. When that is a building or shop, its street is the one on
// its own address, which can be a different road if the building is not right here; that street is dropped.
function photonAddress(feature, snapshot) {
  const properties = feature?.properties
  if (!properties) return undefined
  const [lon, lat] = feature.geometry?.coordinates || []
  if (properties.street && properties.osm_key !== 'highway' && Number.isFinite(lat) && Number.isFinite(lon) &&
      metresBetween(snapshot, { lat, lon }) > 60) {
    const { street, housenumber, ...rest } = properties
    return rest
  }
  return properties
}

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

// The phone's built-in geocoder (Android only, free, no key). Answers arrive through
// window.onPhoneAddress; a slow or missing answer never holds up the stamp.
const pendingPhoneAddresses = new Map()
let phoneAddressRequest = 0
window.onPhoneAddress = (id, value) => {
  const done = pendingPhoneAddresses.get(id)
  if (done) done(value && typeof value === 'object' ? value : undefined)
}

function phoneAddress(snapshot) {
  if (typeof android?.reverseGeocode !== 'function') return Promise.resolve(undefined)
  return new Promise(resolve => {
    const id = `address${++phoneAddressRequest}`
    const finish = (value) => {
      clearTimeout(timer)
      pendingPhoneAddresses.delete(id)
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), 5000)
    pendingPhoneAddresses.set(id, finish)
    try { android.reverseGeocode(id, snapshot.lat, snapshot.lon) } catch { finish(undefined) }
  })
}

// Photon stays the base; the phone fills what Photon is missing, including the district.
function mergeAddresses(photon, phone) {
  const named = (value) => typeof value === 'string' && value.trim() && !/^unnamed\b/i.test(value) ? value.trim() : undefined
  const fromPhone = phone && {
    street: named(phone.thoroughfare), housenumber: named(phone.subThoroughfare),
    locality: named(phone.subLocality), city: named(phone.locality), region: named(phone.subAdminArea),
    state: named(phone.adminArea), postcode: named(phone.postalCode),
    country: named(phone.countryName), countrycode: named(phone.countryCode)
  }
  if (!fromPhone) return photon
  if (!photon) return Object.fromEntries(Object.entries(fromPhone).filter(([, value]) => value))
  const merged = { ...photon }
  if (!merged.street && !merged.name && fromPhone.street) {
    merged.street = fromPhone.street
    merged.housenumber = fromPhone.housenumber
  }
  for (const key of ['locality', 'city', 'state', 'postcode', 'country', 'countrycode']) {
    if (!merged[key] && fromPhone[key]) merged[key] = fromPhone[key]
  }
  const known = [merged.locality, merged.district, merged.city, merged.county].filter(Boolean).map(value => value.toLowerCase())
  if (fromPhone.region && !known.includes(fromPhone.region.toLowerCase())) merged.region = fromPhone.region
  return merged
}

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
    const [address, map, phone, osm] = await Promise.allSettled([
      request(reverse).then((response) => response.json()).then((data) => photonAddress(data.features?.[0], snapshot)),
      loadSatelliteMap(snapshot, request, abort.signal),
      phoneAddress(snapshot),
      request(nominatim).then((response) => response.json()).then(nominatimAddress)
    ])
    return { address: mergeAddresses(fillAddress(osm.value, address.value), phone.value), map: map.value?.image, complete: !!(osm.value && map.value) }
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

// `base` is the size the stamp scales with (normally the photo's short side). Returns the stamp's top and
// bottom edges, tab included, in canvas pixels.
function drawStamp(canvas, { snapshot, date, picked, address, map, template = preferences.template, position = preferences.position, example = false, note = stampNote, base }) {
  const ctx = canvas.getContext('2d')
  const unit = (base || Math.min(canvas.width, canvas.height)) / 460
  const w = canvas.width / unit, h = canvas.height / unit
  const inset = 10, padding = 8, radius = 11
  // Date & time stamps get a calendar tile where the satellite stamp has its map, so all cards match.
  const calendar = !snapshot
  const mapSize = map || calendar ? 92 : 0
  const codeSize = template === 'qr' && snapshot ? 84 : 0
  const accentBar = mapSize ? 0 : 3
  const width = Math.min(w - 2 * inset, mapSize ? 540 : 450)
  const textX = inset + padding + (mapSize ? mapSize + padding + 2 : accentBar + padding)
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
      text, font, color, tracking, height: Math.round(size * 1.2) + (index === shown.length - 1 ? gapAfter : 0)
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
    add(picked ? 'STAMPED' : 'TIMESTAMP', 8.5, colors.brand, 700, { maxLines: 1, tracking: 1.4, gapAfter: 4 })
    add(zoned.clock.format(date), 25, colors.text, 700, { maxLines: 1, gapAfter: 3 })
    add(zoned.longDate.format(date), 13.5, colors.text, 500, { maxLines: 1, gapAfter: 2 })
    add(zoneLabel(zoned, date), 11.5, colors.coordinate, 600, { maxLines: 1 })
  }
  if (note) add(`Note: ${note}`, 11.5, colors.muted, 500, { maxLines: 2 })
  const textHeight = lines.reduce((sum, item) => sum + item.height, 0) - 2
  const panelHeight = Math.max(mapSize + 2 * padding, codeSize + 2 * padding, textHeight + 2 * padding + 2)
  const top = position === 'top' ? inset : h - inset - panelHeight

  // Card and GeoZipTag tab are one outline, filled once so the translucent
  // background stays even where they join. The tab rises from the card's
  // top-right corner (or hangs from the bottom-right when the stamp is at the top).
  const tabHeight = 24, iconSize = 16, markHeight = 11, tabRadius = 8, joinRadius = 5
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

  if (calendar) {
    const x = inset + padding, y = top + (panelHeight - mapSize) / 2, size = mapSize, band = 24
    const parts = Object.fromEntries(zoned.calendar.formatToParts(date).map(part => [part.type, part.value]))
    ctx.save()
    rounded(x, y, size, size, 8)
    ctx.clip()
    ctx.fillStyle = '#fbf8f2'
    ctx.fillRect(x, y, size, size)
    ctx.fillStyle = colors.accent
    ctx.fillRect(x, y, size, band)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 12px ${stampFace}`
    ctx.fillText((parts.month || '').toUpperCase(), x + size / 2, y + band / 2 + 0.5)
    ctx.fillStyle = '#16191a'
    ctx.font = `700 38px ${stampFace}`
    ctx.fillText(parts.day || '', x + size / 2, y + band + (size - band) / 2 - 6)
    ctx.fillStyle = '#5f676a'
    ctx.font = `600 9.5px ${stampFace}`
    ctx.fillText((parts.weekday || '').toUpperCase(), x + size / 2, y + size - 11)
    ctx.restore()
  }

  if (map) {
    const mapX = inset + padding
    const mapTop = top + (panelHeight - mapSize) / 2
    ctx.save()
    rounded(mapX, mapTop, mapSize, mapSize, 8)
    ctx.clip()
    ctx.drawImage(map, mapX, mapTop, mapSize, mapSize)
    if (!example) {
      // Imagery credit (required by Esri): one small line on a faint strip, so the map stays visible.
      const credit = '© Esri, Vantor, Earthstar Geographics'
      let size = 5.6
      ctx.font = `500 ${size}px ${stampFace}`
      const room = mapSize - 6
      if (ctx.measureText(credit).width > room) {
        size *= room / ctx.measureText(credit).width
        ctx.font = `500 ${size}px ${stampFace}`
      }
      const stripHeight = size + 4
      const strip = ctx.createLinearGradient(0, mapTop + mapSize - stripHeight - 3, 0, mapTop + mapSize)
      strip.addColorStop(0, 'rgba(0, 0, 0, 0)')
      strip.addColorStop(1, 'rgba(0, 0, 0, 0.55)')
      ctx.fillStyle = strip
      ctx.fillRect(mapX, mapTop + mapSize - stripHeight - 3, mapSize, stripHeight + 3)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.fillText(credit, mapX + 3, mapTop + mapSize - size - 2)
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
  return position === 'top'
    ? { top: top * unit, bottom: (top + panelHeight + tabHeight) * unit }
    : { top: (top - tabHeight) * unit, bottom: (top + panelHeight) * unit }
}

function resetLiveControls() {
  cancelCountdown()
  clearTimeout(focusTimer)
  cameraHardware = undefined
  $('cameraGrid').hidden = true
  $('focusPoint').hidden = true
  $('zoomControl').hidden = true
  $('exposureControl').hidden = true
  exposureValue = 0
  video.classList.remove('can-focus')
}

// Phones fill the screen with the camera (cropping the edges). The iOS web view can ignore object-fit on a
// live camera, so the video element itself is sized to cover the preview area instead of relying on CSS.
function coverVideo() {
  const area = video.parentElement.getBoundingClientRect()
  const cover = getComputedStyle(video).objectFit === 'cover'
  if (!cover || stream?.native || video.hidden || !video.videoWidth || !video.videoHeight || !area.width || !area.height) {
    for (const property of ['width', 'height', 'left', 'top', 'right', 'bottom']) video.style.removeProperty(property)
    return
  }
  const scale = Math.max(area.width / video.videoWidth, area.height / video.videoHeight)
  const width = Math.ceil(video.videoWidth * scale), height = Math.ceil(video.videoHeight * scale)
  Object.assign(video.style, {
    width: `${width}px`, height: `${height}px`, right: 'auto', bottom: 'auto',
    left: `${Math.round((area.width - width) / 2)}px`, top: `${Math.round((area.height - height) / 2)}px`,
  })
}
for (const type of ['loadedmetadata', 'resize', 'playing']) video.addEventListener(type, coverVideo)
window.addEventListener('resize', coverVideo)
if ('ResizeObserver' in window) new ResizeObserver(coverVideo).observe(video.parentElement)

function videoFrame() {
  const box = video.getBoundingClientRect()
  const liveW = liveWidth(), liveH = liveHeight()
  if (!liveW || !liveH || !box.width || !box.height) return undefined
  // The full-screen phone layout fills the screen (cover) and crops the edges; otherwise it fits (contain).
  const fit = stream?.native || getComputedStyle(video).objectFit === 'cover' ? Math.max : Math.min
  const scale = fit(box.width / liveW, box.height / liveH)
  const width = liveW * scale
  const height = liveH * scale
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
  if (typeof layoutFrame === 'function' && $('review').hidden) setTimeout(layoutFrame)
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

// Zoom like the iPhone camera. Back camera: lens numbers (.5, 1×, 2, 3…), the active one yellow and centred,
// showing the exact zoom while pinching. Front camera: one button between the normal and the wider view.
const zoomText = (value) => `${Number(value.toFixed(1))}`.replace(/^0\./, '.')
let zoomSteps = [], frontZoom
function setZoomLabel(value) {
  if (frontZoom) {
    const wide = value <= frontZoom.wide + 0.01
    $('zoomToggle').setAttribute('aria-label', wide ? 'Narrower' : 'Wider')
    $('zoomToggle').querySelector('use').setAttribute('href', wide ? '#i-zoom-out' : '#i-zoom-in')
    return
  }
  const buttons = [...$('zoomLenses').querySelectorAll('button')]
  const active = buttons.filter(button => Number(button.dataset.zoom) <= value + 0.05).pop() || buttons[0]
  for (const button of buttons) {
    const selected = button === active
    button.setAttribute('aria-pressed', String(selected))
    button.textContent = selected ? `${zoomText(value)}×` : zoomText(Number(button.dataset.zoom))
  }
  // Keep the active lens in the middle, as the Camera app does.
  const row = $('zoomLenses')
  if (active) row.style.transform = `translateX(${row.offsetWidth / 2 - (active.offsetLeft + active.offsetWidth / 2)}px)`
}
function buildZoomButtons(min, max, track) {
  const row = $('zoomLenses')
  row.replaceChildren()
  frontZoom = undefined
  if (track?.getSettings?.().facingMode === 'user') {
    // Front camera: the full sensor (wider) or Apple's usual selfie crop (about 1.3×).
    if (max < 1.25) { $('zoomToggle').hidden = true; return 0 }
    frontZoom = { wide: Math.max(min, 1), narrow: Math.min(max, 1.3) }
    $('zoomToggle').hidden = false
    row.hidden = true
    return 1
  }
  $('zoomToggle').hidden = true
  row.hidden = false
  // Lenses: the camera's own list when it gives one (iPhone: .5, 1, 2, 3…), otherwise ultra-wide, 1× and 2×.
  const widest = min < 0.95 ? Math.max(0.5, Math.round(min * 10) / 10) : undefined
  const lenses = track?.lenses || [widest, 1, 2]
  zoomSteps = [...new Set(lenses.filter(Boolean).map(stop => Math.round(stop * 10) / 10))]
    .filter(stop => stop >= min - 0.01 && stop <= max + 0.01).sort((a, b) => a - b)
  for (const stop of zoomSteps) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.zoom = stop
    button.setAttribute('aria-label', `Zoom ${stop}×`)
    button.addEventListener('click', () => setZoom(stop))
    row.append(button)
  }
  return zoomSteps.length > 1 ? zoomSteps.length : 0
}
function setZoom(value) {
  const camera = cameraHardware
  if (!camera) return
  $('zoomSlider').value = value
  setZoomLabel(value)
  requestZoom(camera, value)
}
$('zoomToggle').addEventListener('click', () => {
  if (!frontZoom) return
  const current = $('zoomSlider').valueAsNumber
  setZoom(current <= frontZoom.wide + 0.01 ? frontZoom.narrow : frontZoom.wide)
})

function showLiveControls(track) {
  const capabilities = track.getCapabilities?.() || {}
  const settings = track.getSettings()
  const focus = capabilities.focusMode?.includes('single-shot') &&
    (!!track.native || !!navigator.mediaDevices.getSupportedConstraints?.().pointsOfInterest)
  // Brightness: the native camera's exposure bias (EV), or the browser's exposure compensation.
  const exposure = capabilities.exposure || (capabilities.exposureCompensation?.max > capabilities.exposureCompensation?.min
    ? { ...capabilities.exposureCompensation, key: 'exposureCompensation' } : undefined)
  cameraHardware = {
    track, focus, exposure, desired: {}, queue: Promise.resolve(), base: track.getConstraints?.() || {},
    flashModes: capabilities.flash, torch: capabilities.torch === true
  }
  showFlash(cameraHardware, settings)
  const zoom = capabilities.zoom
  const hasZoom = Number.isFinite(zoom?.min) && Number.isFinite(zoom?.max) && zoom.max > zoom.min
  const slider = $('zoomSlider')   // hidden; holds the zoom range and value for the buttons and pinch
  slider.disabled = !hasZoom
  $('zoomControl').hidden = !hasZoom || buildZoomButtons(zoom.min, zoom.max, track) < 1
  if (hasZoom) {
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

// Flash: Off → Auto → On with the phone's own camera (it fires when the photo is taken); in a browser the
// button is a torch (Off/On).
function showFlash(camera, settings) {
  const button = $('torchToggle')
  const usable = !!camera.flashModes || camera.torch
  button.hidden = !usable
  button.disabled = false
  setFlashButton(camera.flashModes ? settings.flash || 'off' : settings.torch ? 'on' : 'off')
}
function setFlashButton(mode) {
  const button = $('torchToggle')
  button.dataset.flash = mode
  button.setAttribute('aria-label', `Flash ${mode}`)
  button.querySelector('use').setAttribute('href', mode === 'off' ? '#i-flash-off' : '#i-flash')
}
$('torchToggle').addEventListener('click', async () => {
  const camera = cameraHardware
  if (!camera) return
  const button = $('torchToggle')
  const modes = camera.flashModes
  const current = button.dataset.flash || 'off'
  const next = modes ? modes[(modes.indexOf(current) + 1) % modes.length] : current === 'on' ? 'off' : 'on'
  setFlashButton(next)
  button.disabled = true
  const applied = await applyHardwareSetting(camera, modes ? { flash: next } : { torch: next === 'on' })
  if (cameraHardware !== camera) return
  button.disabled = false
  if (!applied) {
    setFlashButton(current)
    message('Flash is unavailable on this camera.')
  } else message(`Flash ${next === 'auto' ? 'auto' : next}`, 1200)
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
  if (preferences.tapAction === 'capture') {
    if (!busy && countdownTimer === undefined) $('shutter').click()
    return
  }
  const camera = cameraHardware
  const frame = videoFrame()
  if (!(camera?.focus || camera?.exposure) || !frame) return
  const x = (event.clientX - frame.left) / frame.width
  const y = (event.clientY - frame.top) / frame.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return
  const applied = camera.track.native ? (camera.track.focusAt(event.clientX, event.clientY), true)
    : camera.focus ? await applyHardwareSetting(camera, { focusMode: 'single-shot', pointsOfInterest: [{ x: facing === 'user' ? 1 - x : x, y }] })
      : true
  if (!applied) return
  showExposureControl(camera, event.clientX, event.clientY)
  const marker = $('focusPoint')
  const bounds = marker.parentElement.getBoundingClientRect()
  marker.style.left = `${event.clientX - bounds.left}px`
  marker.style.top = `${event.clientY - bounds.top}px`
  marker.hidden = false
  clearTimeout(focusTimer)
  focusTimer = setTimeout(() => { if ($('exposureControl').hidden) marker.hidden = true }, 950)
})

// Brightness: after a tap, a sun beside the focus square; drag it up to brighten, down to darken (±2 stops).
let exposureTimer, exposureValue = 0
function exposureRange(camera) {
  const range = camera?.exposure
  return range ? { min: Math.max(-2, range.min), max: Math.min(2, range.max), key: range.key || 'exposure' } : undefined
}
function placeExposureKnob() {
  $('exposureKnob').style.top = `${(1 - (exposureValue + 2) / 4) * 122}px`
}
function hideExposureLater() {
  clearTimeout(exposureTimer)
  exposureTimer = setTimeout(() => { $('exposureControl').hidden = true; $('focusPoint').hidden = true }, 2500)
}
function showExposureControl(camera, clientX, clientY) {
  const range = exposureRange(camera)
  const control = $('exposureControl')
  if (!range) { control.hidden = true; return }
  if (exposureValue !== 0) applyHardwareSetting(camera, { [range.key]: 0 })   // a new tap starts from normal
  exposureValue = 0
  const bounds = control.parentElement.getBoundingClientRect()
  const right = clientX - bounds.left + 46 + 36 < bounds.width
  control.style.left = `${clientX - bounds.left + (right ? 46 : -82)}px`
  control.style.top = `${Math.min(Math.max(clientY - bounds.top - 75, 8), bounds.height - 158)}px`
  placeExposureKnob()
  control.hidden = false
  hideExposureLater()
}
{
  const control = $('exposureControl')
  let drag
  control.addEventListener('pointerdown', event => {
    drag = { id: event.pointerId, y: event.clientY, value: exposureValue }
    control.setPointerCapture(event.pointerId)
    clearTimeout(exposureTimer)
    event.preventDefault()
  })
  control.addEventListener('pointermove', event => {
    const camera = cameraHardware, range = exposureRange(camera)
    if (!drag || drag.id !== event.pointerId || !range) return
    const next = Math.min(range.max, Math.max(range.min, drag.value - (event.clientY - drag.y) / 122 * 4))
    if (Math.abs(next - exposureValue) < 0.05) return
    exposureValue = Math.round(next * 10) / 10
    placeExposureKnob()
    applyHardwareSetting(camera, { [range.key]: exposureValue })
  })
  const end = () => { drag = undefined; hideExposureLater() }
  control.addEventListener('pointerup', end)
  control.addEventListener('pointercancel', end)
}

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
  if (touchPoints.size === 2 && cameraHardware && !$('zoomSlider').disabled) {
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
  while (photoHistory.length > MAX_PHOTOS) {
    const old = photoHistory.shift()
    photoStore.remove(old.name)
    releasePhoto(old)
  }
  setCurrentPhoto(entry)
  photoStore.put(entry)
}

// The last photos are kept on the phone (IndexedDB), so the thumbnail shows the last photo taken with the app
// even after it was closed, and older photos open, share and delete as before.
const photoStore = (() => {
  let database
  const open = () => database ||= new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('no storage')); return }
    const request = indexedDB.open('geoziptag', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'name' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const run = async (mode, work) => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('photos', mode)
      const request = work(transaction.objectStore('photos'))
      transaction.oncomplete = () => resolve(request?.result)
      transaction.onerror = () => reject(transaction.error)
    })
  }
  return {
    put: (entry) => run('readwrite', store => store.put({
      name: entry.name, date: entry.date.getTime(), jpeg: entry.jpeg, kind: entry.kind || 'photo',
      snapshot: entry.snapshot ? { ...entry.snapshot } : undefined, address: entry.address, note: entry.note, saved: entry.saved
    })).catch(() => {}),
    remove: (name) => run('readwrite', store => store.delete(name)).catch(() => {}),
    all: () => run('readonly', store => store.getAll()).catch(() => [])
  }
})()

async function thumbnailFor(blob) {
  const bitmap = await createImageBitmap(blob)
  const size = 144, canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const scale = Math.max(size / bitmap.width, size / bitmap.height)
  canvas.getContext('2d').drawImage(bitmap, (size - bitmap.width * scale) / 2, (size - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale)
  bitmap.close?.()
  const thumb = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82))
  return thumb ? URL.createObjectURL(thumb) : undefined
}

async function restorePhotos() {
  const records = (await photoStore.all()).filter(record => record?.jpeg instanceof Blob).sort((a, b) => a.date - b.date)
  const known = new Set(photoHistory.map(entry => entry.name))
  const restored = []
  for (const record of records.slice(-MAX_PHOTOS)) {
    if (known.has(record.name)) continue
    const entry = {
      jpeg: record.jpeg, date: new Date(record.date), snapshot: record.snapshot, address: record.address, note: record.note,
      name: record.name, kind: record.kind, saved: !!record.saved, url: URL.createObjectURL(record.jpeg),
      shareFile: new File([record.jpeg], record.name, { type: record.jpeg.type || 'image/jpeg' })
    }
    try { entry.thumb = await thumbnailFor(record.jpeg) } catch {}
    restored.push(entry)
  }
  if (!restored.length) return
  photoHistory.unshift(...restored)   // older than anything taken since the app opened
  while (photoHistory.length > MAX_PHOTOS) releasePhoto(photoHistory.shift())
  if (!lastPhoto) {
    setCurrentPhoto(photoHistory[photoHistory.length - 1])
    showThumbnail(lastPhoto)
  }
}
restorePhotos()

function removePhoto(entry) {
  const index = photoHistory.indexOf(entry)
  if (index < 0) return
  photoHistory.splice(index, 1)
  photoStore.remove(entry.name)
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
  $('share').onclick = () => sharePhoto(lastPhoto)
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

async function capture(source, picked, snapshot, { date = new Date(), imageFile = picked, phoneMode } = {}) {
  if (busy) return
  busy = true
  if (snapshot && !snapshot.name && placeLabel) snapshot = { ...snapshot, name: placeLabel }
  $('shutter').disabled = true
  $('fallback').disabled = true
  $('startCamera').disabled = true
  $('switchCamera').disabled = true
  const live = source === video
  if (live) fireFlash()
  if (!live) message('Stamping photo…')
  else if (snapshot && !placeReady(snapshot)) message('Adding address and satellite map…')
  let canvas
  try {
    if (live && stream?.native) {
      source = await takeNativePhoto()   // full-quality photo from the phone's camera
      imageFile = true
    }
    const sourceWidth = imageFile ? source.naturalWidth : source.videoWidth
    const sourceHeight = imageFile ? source.naturalHeight : source.videoHeight
    if (!sourceWidth || !sourceHeight) throw new Error('No image frame')
    // Camera photos are cut to the chosen photo shape (the centre, as the live view shows it).
    const crop = live ? cropToShape(sourceWidth, sourceHeight) : { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
    // Standard quality: at most 2560 pixels on the long side (about 1 MB), for quick sharing.
    const fit = preferences.quality === 'standard' ? Math.min(1, 2560 / Math.max(crop.width, crop.height)) : 1
    canvas = document.createElement('canvas')
    canvas.width = Math.round(crop.width * fit)
    canvas.height = Math.round(crop.height * fit)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('out of memory')
    // Mirror (Camera settings): front-camera photos saved as seen in the preview.
    const mirrored = live && facing === 'user' && preferences.mirrorFront
    if (mirrored) context.setTransform(-1, 0, 0, 1, canvas.width, 0)
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
    if (mirrored) context.setTransform(1, 0, 0, 1, 0, 0)
    const original = preferences.keepOriginal ? await exportJpeg(canvas) : undefined
    const { address, map } = await placeFor(snapshot)
    await stampFonts
    drawStamp(canvas, { snapshot, date, picked, address, map })
    const jpeg = await exportJpeg(canvas)
    if (!jpeg) throw new Error('Export unavailable')
    const name = `GeoZipTag-${date.toISOString().replace(/[:.]/g, '-')}.jpg`
    const shareFile = new File([jpeg], name, { type: 'image/jpeg' })
    fromPicker = picked
    lastPhoneMode = phoneMode
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
      photoStore.put(entry)   // remembers that the app saved it (Delete then removes it from the gallery too)
    }
    if (live && preferences.shareAfter) sharePhoto(entry, true)
    if (!live && !stream) startLiveCamera()
    const complete = !snapshot || (address && map)
    if (complete) message(hostSaves ? '' : 'Photo ready · tap the thumbnail to save or share', hostSaves ? 0 : 3500)
    else message(map ? 'Satellite map added · address unavailable' : address ? 'Address added · satellite map unavailable' :
      'Timestamp and coordinates added · map and address unavailable', 6000)
  } catch (error) {
    message(`Could not create the photo (${error?.message || 'unknown error'}). Take another photo or try the phone camera.`)
  } finally {
    // Full-resolution canvases hold about 50 MB each; free this one now (the browser caps the total).
    if (canvas) canvas.width = canvas.height = 0
    busy = false
    $('shutter').disabled = false
    $('fallback').disabled = false
    $('switchCamera').disabled = false
    resetStart()
  }
}

function readPhotoData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function exportToAndroid(action, filename, jpeg) {
  const data = await readPhotoData(jpeg)
  android.exportPhoto(action, filename, data.slice(data.indexOf(',') + 1))
}

if (android) {
  for (const id of ['save', 'saveOriginal']) {
    $(id).addEventListener('click', async (event) => {
      event.preventDefault()
      const { href, download } = event.currentTarget
      try {
        const response = await fetch(href)
        await exportToAndroid('save', download, await response.blob())
      } catch {
        message('Could not prepare the photo for saving.')
      }
    })
  }
  // Called by the native back handler: close a sheet, or leave the photo view; false means "ask to exit".
  window.closeGeoStampDialog = () => {
    const dialog = document.querySelector('dialog[open]')
    if (dialog) {
      if (dialog.close) dialog.close()
      else dialog.removeAttribute('open')
      return true
    }
    if (!$('review').hidden) {
      closePhotoView()
      return true
    }
    return false
  }
}

// ---- Camera settings tray: Ratio, Grid, Timer, Focus, Mirror, Level, Add text ----
function setCameraPanel(open) {
  $('cameraPanel').hidden = !open
  $('cameraPanelButton').setAttribute('aria-expanded', String(open))
  if (open) refreshCameraPanel()
}
function refreshCameraPanel() {
  $('ratioValue').textContent = preferences.aspect
  $('tapValue').textContent = preferences.tapAction === 'capture' ? 'Tap to shoot' : 'Tap to focus'
  $('tapTile').classList.toggle('on', preferences.tapAction === 'capture')
  $('mirrorTile').setAttribute('aria-pressed', String(preferences.mirrorFront))
  $('levelTile').setAttribute('aria-pressed', String(preferences.showLevel))
  $('noteValue').textContent = stampNote ? 'Added' : 'On the stamp'
  $('noteTile').classList.toggle('on', !!stampNote)
}
$('cameraPanelButton').addEventListener('click', () => setCameraPanel($('cameraPanel').hidden))
document.addEventListener('pointerdown', event => {
  if (!$('cameraPanel').hidden && !event.target.closest('#cameraPanel, #cameraPanelButton')) setCameraPanel(false)
})
$('ratioTile').addEventListener('click', () => {
  preferences.aspect = { '16:9': '4:3', '4:3': '1:1', '1:1': '16:9' }[preferences.aspect] || '16:9'
  $('photoShape').value = preferences.aspect
  savePreferences()
  layoutFrame()
  refreshCameraPanel()
})
$('tapTile').addEventListener('click', () => {
  preferences.tapAction = preferences.tapAction === 'capture' ? 'focus' : 'capture'
  $('tapAction').value = preferences.tapAction
  savePreferences()
  refreshCameraPanel()
})
$('mirrorTile').addEventListener('click', () => {
  preferences.mirrorFront = !preferences.mirrorFront
  savePreferences()
  refreshCameraPanel()
})
$('noteTile').addEventListener('click', () => {
  setCameraPanel(false)
  $('locationTools').showModal()
  setTimeout(() => $('stampNote').focus(), 50)
})

// Level: a line that stays level with the horizon (from the motion sensor) and turns yellow when straight.
function onMotion(event) {
  const g = event.accelerationIncludingGravity
  if (!g || g.x == null || g.y == null) return
  let angle = Math.atan2(g.x, g.y) * 180 / Math.PI
  if (angle > 90) angle -= 180   // iOS reports the opposite sign
  else if (angle < -90) angle += 180
  const line = $('levelLine')
  line.style.transform = `rotate(${angle.toFixed(1)}deg)`
  line.classList.toggle('straight', Math.abs(angle) < 1.5)
}
async function applyLevel() {
  const on = preferences.showLevel
  $('levelLine').hidden = !on
  window.removeEventListener('devicemotion', onMotion)
  if (on) window.addEventListener('devicemotion', onMotion)
}
$('levelTile').addEventListener('click', async () => {
  preferences.showLevel = !preferences.showLevel
  // iPhones ask once for motion access; this tap is the permission gesture.
  if (preferences.showLevel && /iPhone|iPad|iPod/.test(navigator.userAgent) && typeof DeviceMotionEvent?.requestPermission === 'function') {
    try { if (await DeviceMotionEvent.requestPermission() !== 'granted') preferences.showLevel = false } catch { preferences.showLevel = false }
  }
  savePreferences()
  applyLevel()
  refreshCameraPanel()
})
applyLevel()

// Volume buttons as a shutter (apps only): the app passes presses on while this is on.
function applyVolumeShutter() {
  try { android?.setVolumeShutter?.(preferences.volumeShutter) } catch {}
}
$('volumeShutterRow').hidden = typeof android?.setVolumeShutter !== 'function'
window.onHardwareShutter = () => {
  if (!video.hidden && $('review').hidden && !document.querySelector('dialog[open]') && !busy) $('shutter').click()
}
applyVolumeShutter()

// Photo shape: the long side over the short side; the photo keeps the camera's orientation.
const shapeRatios = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1 }
const shapeRatio = () => shapeRatios[preferences.aspect] || 16 / 9
function cropToShape(width, height) {
  const ratio = shapeRatio()
  const target = height >= width ? 1 / ratio : ratio   // width / height
  let cropWidth = width, cropHeight = height
  if (width / height > target) cropWidth = Math.round(height * target)
  else cropHeight = Math.round(width / target)
  return { x: Math.round((width - cropWidth) / 2), y: Math.round((height - cropHeight) / 2), width: cropWidth, height: cropHeight }
}

async function sharePhoto(entry, automatic = false) {
  if (!entry) return
  try {
    if (hostSaves) await exportToAndroid('share', entry.name, entry.jpeg)
    else await navigator.share({ files: [entry.shareFile] })
  } catch (error) {
    // Right after the shutter a browser may refuse to open sharing; the photo view's Share still works.
    if (automatic) message('Photo saved. Open it from the thumbnail to share.', 3500)
    else if (error.name !== 'AbortError') message('Sharing is unavailable. Use Save photo instead.')
  }
}

function exportJpeg(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', preferences.quality === 'standard' ? 0.85 : 0.94))
}

$('shutter').addEventListener('click', () => {
  if (countdownTimer !== undefined) cancelCountdown()
  else requestCapture(takeLivePhoto)
})
file.addEventListener('change', async () => {
  const image = file.files?.[0]
  file.value = ''
  const request = phoneRequest
  const metadata = phoneMetadata
  const savedPickerFix = pickerFix
  phoneRequest = phoneMetadata = pickerFix = undefined
  if (!image) return

  const cameraPhoto = metadata?.camera && Number.isFinite(metadata.takenAt)
  const date = cameraPhoto ? new Date(metadata.takenAt) : new Date()
  let snapshot = request ? undefined : freshFix(savedPickerFix)
  if (request?.withLocation) {
    if (request.snapshot?.manual) snapshot = request.snapshot
    else if (cameraPhoto) {
      if (Number.isFinite(metadata.lat) && Number.isFinite(metadata.lon)) {
        snapshot = { lat: metadata.lat, lon: metadata.lon }
      } else if (request.snapshot && Math.abs(date.getTime() - request.snapshot.timestamp) <= 60000) {
        snapshot = request.snapshot
      }
    }
  }
  const url = URL.createObjectURL(image)
  try {
    await capture(await loadImage(url), !cameraPhoto, snapshot, {
      date, imageFile: true, phoneMode: request?.withLocation
    })
  } catch { message('This image could not be opened. Try a JPEG or PNG photo.') }
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
  setTimeout(refreshCameraPanel)
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
  if (hasPhoneCamera) openPhoneCamera(preferences.template !== 'time' && !timestampOnly)
  else $('fallback').click()
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
$('photoShape').value = preferences.aspect
$('photoQuality').value = preferences.quality
$('tapAction').value = preferences.tapAction
$('volumeShutter').checked = preferences.volumeShutter
$('shareAfter').checked = preferences.shareAfter

$('settings').addEventListener('change', () => {
  setTimeout(renderLiveStamp)
  preferences.position = $('stampPosition').value
  preferences.keepOriginal = $('keepOriginal').checked
  preferences.preferShare = $('preferShare').checked
  preferences.aspect = $('photoShape').value
  preferences.quality = $('photoQuality').value
  preferences.tapAction = $('tapAction').value
  preferences.volumeShutter = $('volumeShutter').checked
  preferences.shareAfter = $('shareAfter').checked
  applyVolumeShutter()
  savePreferences()
  layoutFrame()
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
    requestAnimationFrame(() => { $(panel).scrollTop = 0 })   // focusing the first control can scroll it
  })
}

// Sheets close by pulling them down (from the top of their content), like system sheets.
for (const sheet of document.querySelectorAll('dialog')) {
  let startY, startTime, drag = 0, dragging = false
  const reset = () => { sheet.style.transition = ''; sheet.style.transform = ''; sheet.style.opacity = ''; sheet.scrollTop = 0 }
  sheet.addEventListener('close', reset)
  sheet.addEventListener('touchstart', event => {
    startY = undefined
    if (event.touches.length !== 1 || event.target.closest('select, textarea, input[type=range]')) return
    if (sheet.scrollTop > 0 && !event.target.closest('.sheet-head')) return
    startY = event.touches[0].clientY
    startTime = performance.now()
    drag = 0
    dragging = false
  }, { passive: true })
  sheet.addEventListener('touchmove', event => {
    if (startY === undefined) return
    const distance = event.touches[0].clientY - startY
    if (!dragging) {
      if (distance < -6) { startY = undefined; return }   // scrolling up: leave it to the sheet
      if (distance < 8) return
      dragging = true
      sheet.style.transition = 'none'
    }
    drag = Math.max(0, distance - 8)
    sheet.style.transform = `translateY(${drag}px)`
    event.preventDefault()
  }, { passive: false })
  sheet.addEventListener('touchend', () => {
    if (!dragging) { startY = undefined; return }
    const fast = drag / Math.max(1, performance.now() - startTime) > 0.5
    startY = undefined
    dragging = false
    if (drag > 110 || (drag > 40 && fast)) {
      sheet.style.transition = 'transform .18s ease-in, opacity .18s'
      sheet.style.transform = `translateY(${Math.max(drag, sheet.offsetHeight)}px)`
      sheet.style.opacity = '0'
      setTimeout(() => { sheet.close(); reset() }, 170)
    } else {
      sheet.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)'
      sheet.style.transform = ''
    }
  })
}

function openViewfinderOnEntry() {
  if (window.isSecureContext && window.self === window.top && (nativeHost || navigator.mediaDevices?.getUserMedia) && $('review').hidden) {
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
  // The stamp preview sits exactly where it lands on the photo, behind the see-through controls.
  const frame = video.parentElement.getBoundingClientRect()
  liveStamp.style.top = `${frame.top}px`
  liveStamp.style.height = `${frame.height}px`
  const width = Math.round(frame.width * scale), height = Math.round(frame.height * scale)
  if (liveStamp.width !== width || liveStamp.height !== height) { liveStamp.width = width; liveStamp.height = height }
  liveStamp.getContext('2d').clearRect(0, 0, width, height)
  let snapshot = preferences.template === 'time' ? undefined : manualFix || currentFix()
  if (snapshot && !snapshot.name && placeLabel) snapshot = { ...snapshot, name: placeLabel }
  const place = snapshot && placeReady(snapshot) ? placeCache.result : undefined
  const edges = drawStamp(liveStamp, { snapshot, date: new Date(), picked: false, address: place?.address, map: place?.map, base: width })
  // Keeps the zoom buttons clear of the stamp preview when the stamp is at the bottom.
  const stampTop = frame.top + edges.top / scale
  document.documentElement.style.setProperty('--stamp-clearance',
    preferences.position === 'top' ? '0px' : `${Math.max(0, frame.bottom - stampTop)}px`)
}
setInterval(renderLiveStamp, 1000)
window.addEventListener('resize', renderLiveStamp)

// Phones: the camera area takes the photo's shape, full width and centred, so the live view shows exactly
// what the photo will contain (the camera image fills it, cropped at the centre like the photo).
function layoutFrame() {
  const root = document.documentElement.style
  if (!phoneLayout.matches) {
    for (const name of ['--frame-top', '--frame-height', '--frame-gap']) root.removeProperty(name)
    return
  }
  const screenWidth = window.innerWidth, screenHeight = window.innerHeight
  const height = Math.min(screenHeight, Math.round(screenWidth * shapeRatio()))
  // The frame rests on the shutter tray (its bottom edge is where the stamp sits).
  const trayTop = screenHeight - ($('controls').offsetHeight || 0)
  const top = Math.max(0, Math.round(Math.min(trayTop, screenHeight) - height))
  root.setProperty('--frame-top', `${top}px`)
  root.setProperty('--frame-height', `${height}px`)
  root.setProperty('--frame-gap', `${screenHeight - top - height}px`)
  try { nativeHost?.cameraLayout?.(0, top, screenWidth, height) } catch {}
  coverVideo()
  updateCameraGrid()
  renderLiveStamp()
}
window.addEventListener('resize', layoutFrame)
phoneLayout.addEventListener?.('change', layoutFrame)
layoutFrame()
stampFonts.then(renderLiveStamp)

// ---- App updates (Android and iOS apps): the app downloads signed web updates in the background ----
if (typeof android !== 'undefined' && android && typeof android.updateInfo === 'function') {
  let info = {}
  try { info = JSON.parse(android.updateInfo()) } catch {}
  $('appVersion').textContent = `GeoZipTag · v${info.app || '?'} · web ${info.web || ''}`.trim()
  if (info.updates) {
    $('updatesGroup').hidden = false
    const messages = {
      checking: () => 'Checking…',
      current: () => 'You have the latest version.',
      ready: (label) => `Update ${label} is ready. Restart to apply it.`,
      'needs-apk': () => 'This update needs a newer app version. Install the latest APK.',
      'needs-app': () => 'This update needs a newer version of the app. Install the latest build.',
      error: (text) => text || 'Could not check for updates. Try again later.'
    }
    window.onOtaStatus = (state, detail) => {
      $('updateStatus').textContent = (messages[state] || (() => ''))(detail)
      $('checkUpdates').disabled = state === 'checking'
      $('updateReady').hidden = state !== 'ready'
    }
    if (info.pending) window.onOtaStatus('ready', info.pendingLabel)
    $('checkUpdates').addEventListener('click', () => android.checkForUpdates())
    $('updateReady').addEventListener('click', () => android.applyUpdate())
  }
} else {
  $('appVersion').textContent = 'GeoZipTag · web version'
}
// The page started properly: an update being served is good (otherwise it is rolled back).
try { android?.otaConfirm?.() } catch {}
