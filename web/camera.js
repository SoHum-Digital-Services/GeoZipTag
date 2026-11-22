import qrcode from './vendor/qrcode.mjs'

const $ = (id) => document.getElementById(id)
const video = $('video')
const file = $('file')
const status = $('status')
let placeLabel = ''
let stream, photoUrl, watchId, fix
let facing = 'environment'
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

const localDate = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric',
  minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset'
})
const stampDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
})
const stampTime = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit', timeZoneName: 'longOffset'
})
function expireLocationFix() {
  if (manualFix || !fix || currentFix()) return
  fix = undefined
  setLocationStatus('Waiting for a fresh fix…')
}
setInterval(expireLocationFix, 1000)

function message(value) {
  status.textContent = value
  status.hidden = !value
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

async function startCamera(nextFacing = facing) {
  stopCamera()
  const request = cameraRequest
  $('start').hidden = false
  $('startCamera').disabled = true
  $('startWithoutLocation').disabled = true
  $('startCamera').textContent = 'Opening camera…'
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
    message('Live camera unavailable. Check camera permission or use your phone camera.')
  } finally {
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
$('switchCamera').addEventListener('click', () => startCamera(facing === 'environment' ? 'user' : 'environment'))

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
  updateLocationMapAction()
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
  watchId = navigator.geolocation.watchPosition(({ coords, timestamp }) => {
    if (watchId === undefined) return
    fix = { lat: coords.latitude, lon: coords.longitude, timestamp }
    if (coords.accuracy > 100) setLocationStatus('Approximate GPS')
    else setLocationStatus('GPS ready', true)
    if (pendingCapture) {
      $('gpsHint').textContent = 'Location ready. Tap the shutter or phone camera to include it.'
    }
  }, (error) => {
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

async function locate(snapshot) {
  if (!snapshot) return {}
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 15000)
  const reverse = new URL('https://photon.komoot.io/reverse')
  reverse.search = new URLSearchParams({ lat: snapshot.lat, lon: snapshot.lon, limit: 1 })
  const request = (url) => lookup(url, abort.signal)
  try {
    const [address, map] = await Promise.allSettled([
      request(reverse).then((response) => response.json()).then((data) => data.features?.[0]?.properties),
      loadSatelliteMap(snapshot, request, abort.signal)
    ])
    return { address: address.value, map: map.value?.image }
  } finally {
    clearTimeout(timer)
  }
}

// Nalgonda district records identify Cheruvugattu as a village within Narketpally mandal.
const cheruvugattuLandmarks = [
  { lat: 17.1740101, lon: 79.2121757 }, // Cheruvugattu temple (OSM node 10101107918)
  { lat: 17.1743625, lon: 79.2142737 }  // Cheruvugattu-II (OSM node 11984988986)
]

function placeHeading(snapshot, address) {
  if (snapshot?.name) return snapshot.name
  const localName = address?.locality || address?.district ||
    (address?.osm_key === 'place' ? address.name : '') || address?.city || address?.county
  // Prefer the village near its mapped landmarks when the geocoder only supplies the parent area.
  const parentArea = !localName || /^(?:narkatpalli|narketpalli|narketpally)(?: mandal)?$|^nalgonda(?: district)?$/i.test(localName)
  if (snapshot && parentArea && cheruvugattuLandmarks.some(({ lat, lon }) => {
    const north = (snapshot.lat - lat) * 111195
    const east = (snapshot.lon - lon) * 111195 * Math.cos(lat * Math.PI / 180)
    return Math.hypot(north, east) <= 225
  })) return 'Cheruvugattu, TG, India'

  const region = address?.state === 'Telangana' ? 'TG' : address?.state
  return [...new Set([localName, region, address?.country].filter(Boolean))].join(', ')
}

function drawStamp(canvas, { snapshot, date, picked, address, map, template = preferences.template, position = preferences.position, example = false }) {
  const ctx = canvas.getContext('2d')
  const unit = Math.min(canvas.width, canvas.height) / 460
  const w = canvas.width / unit, h = canvas.height / unit
  const inset = 8, padding = 8, gap = map ? 6 : 0
  const mapSize = map ? 100 : 0
  const codeSize = template === 'qr' && snapshot ? 82 : 0
  const width = Math.min(w - 2 * inset, map ? 540 : snapshot ? 440 : 285)
  const panelX = inset + mapSize + gap
  const panelWidth = width - (mapSize + gap)
  const textWidth = panelWidth - 2 * padding - (codeSize ? codeSize + padding : 0)
  const white = '#f6f8fc', muted = '#e1e6ef'
  const background = '#11151dec'
  const lines = []

  ctx.save()
  ctx.scale(unit, unit)
  ctx.textBaseline = 'top'
  function add(text, size, color, weight = 500, maxLines = 2) {
    if (!text) return
    const font = `${weight} ${size}px system-ui, sans-serif`
    ctx.font = font
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
    for (const text of wrapped.slice(0, maxLines)) lines.push({ text, font, color, height: size + 2 })
  }
  function rounded(x, y, width, height) {
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, 5)
    else ctx.rect(x, y, width, height)
  }
  const street = address && [
    address.street ? [address.housenumber, address.street].filter(Boolean).join(' ') : address.name,
    address.postcode
  ].filter(Boolean).join(', ')

  if (snapshot) {
    add(placeHeading(snapshot, address) || 'GPS location', 18, white, 700)
    add(street, 13, muted)
    add(`Lat ${snapshot.lat.toFixed(6)}° · Long ${snapshot.lon.toFixed(6)}°`, 12, '#d2dfff', 650)
    if (snapshot.manual) add('Manual location', 11, muted, 650)
  }
  const dateLabel = `${picked ? 'Stamped at ' : ''}${stampDate.format(date)}`
  const time = stampTime.format(date)
  if (snapshot) {
    add(`${dateLabel} · ${time}`, 12, white, 600)
  } else {
    add(dateLabel, 17, white, 700)
    add(time, 14, muted)
  }
  const panelHeight = Math.max(mapSize, codeSize + 2 * padding, lines.reduce((sum, item) => sum + item.height, 2 * padding))
  const top = position === 'top' ? inset : h - inset - panelHeight
  const bottom = top + panelHeight

  ctx.fillStyle = background
  rounded(panelX, top, panelWidth, panelHeight)
  ctx.fill()
  if (map) {
    const mapTop = position === 'top' ? top : bottom - mapSize
    ctx.save()
    rounded(inset, mapTop, mapSize, mapSize)
    ctx.clip()
    ctx.drawImage(map, inset, mapTop, mapSize, mapSize)
    if (!example) {
      const credit = ['Esri, Vantor', 'Earthstar Geographics', 'GIS User Community']
      const creditTop = mapTop + mapSize - 24
      ctx.font = '550 7px system-ui, sans-serif'
      const creditWidth = Math.max(...credit.map(text => ctx.measureText(text).width)) + 6
      ctx.fillStyle = '#101817df'
      ctx.fillRect(inset, creditTop, creditWidth, 24)
      ctx.fillStyle = white
      credit.forEach((text, index) => ctx.fillText(text, inset + 3, creditTop + 1 + index * 7.5))
    }
    ctx.restore()

    const x = inset + mapSize / 2, y = mapTop + mapSize / 2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.bezierCurveTo(x - 4, y - 6, x - 9, y - 10, x - 9, y - 15)
    ctx.arc(x, y - 15, 9, Math.PI, 0)
    ctx.bezierCurveTo(x + 9, y - 10, x + 4, y - 6, x, y)
    ctx.fillStyle = '#d43743'
    ctx.fill()
    ctx.lineWidth = 1.25
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y - 15, 2.5, 0, Math.PI * 2)
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
    const x = panelX + panelWidth - padding - codeSize
    const y = top + padding
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x, y, codeSize, codeSize)
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

  let y = top + padding
  for (const item of lines) {
    ctx.font = item.font
    ctx.fillStyle = item.color
    ctx.fillText(item.text, panelX + padding, y, textWidth)
    y += item.height
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
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight)
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
  grid.style.left = `${frame.left - bounds.left}px`
  grid.style.top = `${frame.top - bounds.top}px`
  grid.style.width = `${frame.width}px`
  grid.style.height = `${frame.height}px`
  grid.hidden = false
}
window.addEventListener('resize', updateCameraGrid)
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
  $('timerLabel').textContent = label
  $('timerToggle').setAttribute('aria-label', label)
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
  message(snapshot ? 'Adding address and satellite map…' : 'Stamping photo…')
  try {
    const canvas = document.createElement('canvas')
    canvas.width = picked ? source.naturalWidth : source.videoWidth
    canvas.height = picked ? source.naturalHeight : source.videoHeight
    if (!canvas.width || !canvas.height) throw new Error('No image frame')
    canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0)
    const original = preferences.keepOriginal ? await exportJpeg(canvas) : undefined
    const { address, map } = await locate(snapshot)
    drawStamp(canvas, { snapshot, date, picked, address, map })
    const jpeg = await exportJpeg(canvas)
    if (!jpeg) throw new Error('Export unavailable')
    const name = `GeoZipTag-${date.toISOString().replace(/[:.]/g, '-')}.jpg`
    const shareFile = new File([jpeg], name, { type: 'image/jpeg' })
    if (photoUrl) URL.revokeObjectURL(photoUrl)
    photoUrl = URL.createObjectURL(jpeg)
    fromPicker = picked
    lastPhoto = { jpeg, date, snapshot, address }
    if (originalUrl) URL.revokeObjectURL(originalUrl)
    originalUrl = original ? URL.createObjectURL(original) : undefined
    $('saveOriginal').hidden = !originalUrl
    if (originalUrl) {
      $('saveOriginal').href = originalUrl
      $('saveOriginal').download = name.replace('.jpg', '-original.jpg')
    } else $('saveOriginal').removeAttribute('href')
    stopCamera()
    $('start').hidden = true
    $('controls').hidden = true
    $('result').src = photoUrl
    $('result').hidden = false
    $('result').parentElement.classList.add('photo-review')
    $('save').href = photoUrl
    $('save').download = name
    $('review').hidden = false
    let canShare = false
    try { canShare = !!navigator.canShare?.({ files: [shareFile] }) } catch {}
    $('share').hidden = !canShare
    updateSharePreference()
    $('share').onclick = async () => {
      try { await navigator.share({ files: [shareFile] }) }
      catch (error) {
        if (error.name !== 'AbortError') message('Sharing is unavailable. Use Save photo instead.')
      }
    }
    message(!snapshot ? (preferences.template === 'time' ? 'Date and time added' : 'Timestamp added · no GPS location') : address && map ? 'Timestamp, address, and satellite map added' :
      map ? 'Satellite map added · address unavailable' : address ? 'Address added · satellite map unavailable' :
        'Timestamp and coordinates added · map and address unavailable')
    const primaryAction = canShare && preferences.preferShare ? $('share') : $('save')
    primaryAction.focus()
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
$('retake').addEventListener('click', () => {
  $('result').hidden = true
  $('result').parentElement.classList.remove('photo-review')
  $('result').removeAttribute('src')
  $('save').removeAttribute('href')
  $('share').onclick = null
  URL.revokeObjectURL(photoUrl)
  photoUrl = undefined
  if (originalUrl) URL.revokeObjectURL(originalUrl)
  originalUrl = undefined
  $('saveOriginal').removeAttribute('href')
  $('review').hidden = true
  $('controls').hidden = false
  $('start').hidden = false
  message('')
  if (fromPicker) requestCapture(openPicker)
  else startLiveCamera()
})
window.addEventListener('pagehide', () => {
  stopCamera()
  if (!$('controls').hidden) $('start').hidden = false
  resetStart()
  if (watchId !== undefined) stopLocation()
  clearGpsChoice()
})

$('placeLabel').addEventListener('input', (event) => {
  placeLabel = event.target.value.trim()
  $('placeLabelPreview').textContent = placeLabel
  $('placeLabelPreview').hidden = !placeLabel
})

function updateTemplateLabel() {
  $('chosenTemplate').textContent = { satellite: 'Satellite', time: 'Date & Time', qr: 'QR Location' }[preferences.template]
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
  const highlightShare = preferences.preferShare && !$('share').hidden
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
    address: isTime ? undefined : { city: 'Example site', state: 'Telangana', street: 'Site access road' },
    map: isTime ? undefined : map, date: new Date(), example: true
  })
  const y = preferences.position === 'top' ? 0 : canvas.height - preview.height
  preview.getContext('2d').drawImage(canvas, 0, y, preview.width, preview.height, 0, 0, preview.width, preview.height)
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
$('reportType').addEventListener('change', updateReportFields)
$('reportPhoto').addEventListener('change', updateReportFields)

function reportElement(tag, text, parent) {
  const element = document.createElement(tag)
  element.textContent = text
  parent.append(element)
  return element
}

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
    reportElement('h1', comparison ? 'Before and after' : 'Photo report', report)
    const reportLocation = $('reportLocation').value.trim() || (!comparison && !chosenPhoto ? locationLabel(lastPhoto) : '')
    for (const value of [$('reportCompany').value, $('reportProject').value, reportLocation]) {
      if (value.trim()) reportElement('p', value.trim(), report)
    }
    if (!comparison && !chosenPhoto && lastPhoto) reportElement('p', localDate.format(lastPhoto.date), report)
    const images = reportElement('div', '', report)
    images.className = comparison ? 'report-images comparison' : 'report-images'
    await Promise.all(photos.map(async ({ file, label }) => {
      const figure = reportElement('figure', '', images)
      reportElement('figcaption', label, figure)
      const image = reportElement('img', '', figure)
      image.alt = label
      const url = URL.createObjectURL(file)
      reportUrls.push(url)
      image.src = url
      await image.decode()
    }))
    if ($('reportNote').value.trim()) {
      reportElement('p', $('reportNote').value.trim(), report).className = 'report-notes'
    }
    $('reportStatus').textContent = 'Choose Save as PDF in the print dialog to keep a copy.'
    window.print()
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
