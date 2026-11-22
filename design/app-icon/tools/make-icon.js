// GeoZipTag icon v2, in a bright illustrative 3D language: glowing aqua background,
// a big bevelled globe-lens hero, a 3D coral pin, and a mini stamp card with our tab.
// 108-unit adaptive grid (visible 18..90; mask circle r=36, safe circle r=33).
const fs = require('fs'); const { chromium } = require('playwright');
const [D, OUT] = process.argv.slice(2);
// Vector globe (Natural Earth land + India's official outline), built by globe/build.mjs.
const VG = JSON.parse(fs.readFileSync(`${D}/globe-vector.json`, 'utf8'))
const C = { x: 54, y: 48 }, RING = 19.4, RING_W = 5.8, BEZEL = 1.6, GLASS = RING - RING_W / 2 - BEZEL;
const pinPath = (cx, cy, r, L) => `M${cx} ${cy + L} C${cx - r * .38} ${cy + L - r * 1.15} ${cx - r} ${cy + r * .62} ${cx - r} ${cy} A${r} ${r} 0 1 1 ${cx + r} ${cy} C${cx + r} ${cy + r * .62} ${cx + r * .38} ${cy + L - r * 1.15} ${cx} ${cy + L} Z`;
const PIN = { x: 61.5, y: 32.5, r: 6.6, L: 15 };
const CARD = { x: 35, y: 69.5, w: 38, h: 11, r: 2.4, tabW: 13, tabH: 3.4 };
const cardPath = (g = 0) => { const { x, y, w, h, r, tabW, tabH } = CARD; const a = x + g, b = x + w - g, c = y + g, d = y + h - g, t = y - tabH + g, tx = b - tabW + g * 2, tr = 1.4, j = .9;
  return `M${a + r} ${c} L${tx - j} ${c} Q${tx} ${c} ${tx} ${c - j} L${tx} ${t + tr} Q${tx} ${t} ${tx + tr} ${t} L${b - tr} ${t} Q${b} ${t} ${b} ${t + tr} L${b} ${d - r} Q${b} ${d} ${b - r} ${d} L${a + r} ${d} Q${a} ${d} ${a} ${d - r} L${a} ${c + r} Q${a} ${c} ${a + r} ${c} Z` };
const defs = `<defs>
  <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="18" x2="0" y2="90"><stop offset="0" stop-color="#8FDBFF"/><stop offset=".42" stop-color="#3D97F2"/><stop offset="1" stop-color="#1C3F9E"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".42" r=".5"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".5"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  <linearGradient id="ring" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFBF2"/><stop offset=".5" stop-color="#F7E6C4"/><stop offset="1" stop-color="#D9B98A"/></linearGradient>
  <linearGradient id="ringIn" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FFF8EA"/><stop offset="1" stop-color="#C9A673"/></linearGradient>
  <linearGradient id="pin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF9A7E"/><stop offset=".55" stop-color="#F2634E"/><stop offset="1" stop-color="#C9432F"/></linearGradient>
  <radialGradient id="gloss" cx=".34" cy=".24" r=".48"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".55" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <radialGradient id="shade" cx=".5" cy=".5" r=".5"><stop offset=".72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#001218" stop-opacity=".55"/></radialGradient>
  <linearGradient id="card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16201F"/><stop offset="1" stop-color="#0A0F10"/></linearGradient>
  <linearGradient id="map" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7DB46C"/><stop offset=".55" stop-color="#4E8C67"/><stop offset="1" stop-color="#3B7FA8"/></linearGradient>
  <linearGradient id="cloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".65" stop-color="#F2F9FF"/><stop offset="1" stop-color="#CFE6FF"/></linearGradient>
  <filter id="cloudShadow" x="-30%" y="-40%" width="160%" height="200%"><feDropShadow dx="0" dy=".8" stdDeviation=".9" flood-color="#1C3F9E" flood-opacity=".28"/></filter>
  <radialGradient id="lit" cx=".3" cy=".25" r=".7"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".28"/><stop offset=".6" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  <radialGradient id="limb" cx=".42" cy=".38" r=".62"><stop offset=".62" stop-color="#000814" stop-opacity="0"/><stop offset="1" stop-color="#000814" stop-opacity=".62"/></radialGradient>
  <linearGradient id="window" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".7"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
  <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFF4D6" stop-opacity=".95"/><stop offset=".45" stop-color="#FFF4D6" stop-opacity=".35"/><stop offset="1" stop-color="#FFF4D6" stop-opacity="0"/></radialGradient>
  <linearGradient id="sat" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8DBF6A"/><stop offset=".6" stop-color="#5E9A5A"/><stop offset="1" stop-color="#477E4E"/></linearGradient>
  <radialGradient id="ocean" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#3A8EEB"/><stop offset=".7" stop-color="#1656C2"/><stop offset="1" stop-color="#0C3A94"/></radialGradient>
  <linearGradient id="landFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF4DA"/><stop offset="1" stop-color="#F0DDB3"/></linearGradient>
  <clipPath id="glass"><circle cx="${C.x}" cy="${C.y}" r="${GLASS}"/></clipPath>
  <filter id="drop" x="-40%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="2.2" stdDeviation="2.2" flood-color="#032830" flood-opacity=".5"/></filter>
  <filter id="spark" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation=".6"/></filter>
  <filter id="soft" x="-40%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.2" flood-color="#021A20" flood-opacity=".55"/></filter>
</defs>`;
// A puffy cloud: base width w at (x, y), made of overlapping circles on a rounded base.
const cloud = (x, y, w, o = 1) => { const h = w * .26;
  return `<g filter="url(#cloudShadow)" opacity="${o}"><rect x="${x}" y="${y - h}" width="${w}" height="${h}" rx="${h / 2}" fill="url(#cloud)"/>
    <circle cx="${x + w * .3}" cy="${y - h * .95}" r="${w * .2}" fill="url(#cloud)"/>
    <circle cx="${x + w * .58}" cy="${y - h * 1.25}" r="${w * .26}" fill="url(#cloud)"/>
    <circle cx="${x + w * .8}" cy="${y - h * .8}" r="${w * .15}" fill="url(#cloud)"/></g>` }
// Sky: clouds drifting around and behind the lens, kept to the edges so the hero stays clear.
const sky = `<circle cx="24" cy="22" r="24" fill="url(#sun)"/>${cloud(19, 31, 19, .95)}${cloud(16, 64, 15, .85)}${cloud(74, 26.5, 9, .7)}`
const heroWith = (card) => `
<circle cx="${C.x}" cy="${C.y}" r="30" fill="url(#glow)"/>
<g filter="url(#drop)">
  <circle cx="${C.x}" cy="${C.y}" r="${RING + RING_W / 2}" fill="url(#ring)"/>
  <circle cx="${C.x}" cy="${C.y}" r="${RING + RING_W / 2 - .25}" fill="none" stroke="#1C3F9E" stroke-opacity=".3" stroke-width=".5"/>
  <circle cx="${C.x}" cy="${C.y}" r="${RING + .4}" fill="none" stroke="#B8935E" stroke-opacity=".75" stroke-width=".45"/>
  <circle cx="${C.x}" cy="${C.y}" r="${RING + .9}" fill="none" stroke="#FFFFFF" stroke-opacity=".6" stroke-width=".35"/>
  <circle cx="${C.x}" cy="${C.y}" r="${RING - RING_W / 2 + .2}" fill="url(#ringIn)"/>
  <circle cx="${C.x}" cy="${C.y}" r="${GLASS + BEZEL}" fill="#0A1C3A"/>
</g>
<path d="M${C.x - RING - RING_W / 2 + 1.2} ${C.y - 2} A${RING + RING_W / 2 - 1.2} ${RING + RING_W / 2 - 1.2} 0 0 1 ${C.x + 6} ${C.y - RING - RING_W / 2 + 1.4}" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1" stroke-linecap="round"/>
<g clip-path="url(#glass)">
  <circle cx="${C.x}" cy="${C.y}" r="${GLASS}" fill="url(#ocean)"/>
  <path d="${VG.land}${VG.india}" fill="none" stroke="#8FC7FF" stroke-opacity=".5" stroke-width=".55" stroke-linejoin="round"/>
  <path d="${VG.land}" fill="url(#landFill)"/>
  <path d="${VG.india}" fill="#F2634E" stroke="#FFF4DA" stroke-width=".22" stroke-linejoin="round"/>
  <circle cx="${C.x}" cy="${C.y}" r="${GLASS}" fill="url(#lit)"/>
  <circle cx="${C.x}" cy="${C.y}" r="${GLASS}" fill="url(#limb)"/>
  <circle cx="${C.x}" cy="${C.y}" r="${GLASS}" fill="none" stroke="#000814" stroke-opacity=".35" stroke-width="1.6"/>
  <path d="M${C.x - GLASS * .78} ${C.y - GLASS * .12} A${GLASS * .86} ${GLASS * .86} 0 0 1 ${C.x - GLASS * .05} ${C.y - GLASS * .86} L${C.x - GLASS * .02} ${C.y - GLASS * .62} A${GLASS * .62} ${GLASS * .62} 0 0 0 ${C.x - GLASS * .56} ${C.y - GLASS * .08} Z" fill="url(#window)"/>
  <ellipse cx="${C.x + GLASS * .5}" cy="${C.y + GLASS * .58}" rx="${GLASS * .3}" ry="${GLASS * .1}" transform="rotate(-38 ${C.x + GLASS * .5} ${C.y + GLASS * .58})" fill="#BFE3FF" fill-opacity=".35"/>
</g>
<circle cx="${C.x - GLASS * .5}" cy="${C.y - GLASS * .55}" r="1.4" fill="#fff" filter="url(#spark)"/>
<circle cx="${C.x - GLASS * .5}" cy="${C.y - GLASS * .55}" r=".55" fill="#fff"/>
${cloud(69, 62.5, 15, 1)}
${card ? `<g filter="url(#soft)">
  <path d="${cardPath()}" fill="url(#card)"/>
  <path d="${cardPath(.25)}" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width=".5"/>
  <rect x="${CARD.x + 1.8}" y="${CARD.y + 1.8}" width="8.4" height="7.6" rx="1.3" fill="url(#sat)"/>
  <path d="M${CARD.x + 1.8} ${CARD.y + 7.6} Q${CARD.x + 5} ${CARD.y + 5.2} ${CARD.x + 10.2} ${CARD.y + 6.4}" fill="none" stroke="#F3E3C0" stroke-width=".7"/>
  <path d="M${CARD.x + 6.5} ${CARD.y + 1.8} h3.7 v2.6 q-2 .4 -3.7 -.6 Z" fill="#3D97F2" fill-opacity=".85"/>
  <circle cx="${CARD.x + 5.4}" cy="${CARD.y + 5}" r="1.35" fill="#F2634E" stroke="#fff" stroke-width=".45"/>
  <rect x="${CARD.x + 12}" y="${CARD.y + 2.2}" width="18" height="2.3" rx="1.15" fill="#FFF6E6"/>
  <rect x="${CARD.x + 12}" y="${CARD.y + 5.5}" width="23" height="1.5" rx=".75" fill="#FFF6E6" fill-opacity=".6"/>
  <rect x="${CARD.x + 12}" y="${CARD.y + 8}" width="14" height="1.5" rx=".75" fill="#8FDCD8"/>
  <circle cx="${CARD.x + CARD.w - CARD.tabW + 3}" cy="${CARD.y - CARD.tabH / 2 + .35}" r="1" fill="#3D97F2" stroke="#FFF6E6" stroke-width=".4"/>
  <rect x="${CARD.x + CARD.w - CARD.tabW + 4.8}" y="${CARD.y - CARD.tabH + 1.25}" width="6.2" height="1.3" rx=".65" fill="#F2634E"/>
</g>` : ''}
<g filter="url(#drop)">
  <path d="${pinPath(PIN.x, PIN.y, PIN.r, PIN.L)}" fill="url(#pin)" stroke="#FFFFFF" stroke-opacity=".9" stroke-width=".8"/>
  <circle cx="${PIN.x}" cy="${PIN.y}" r="2.6" fill="#FFF6E6"/>
  <ellipse cx="${PIN.x - 2.8}" cy="${PIN.y - 3.1}" rx="2" ry="1.15" transform="rotate(-35 ${PIN.x - 2.8} ${PIN.y - 3.1})" fill="#fff" fill-opacity=".6"/>
</g>`;
const hero = heroWith(true)
// Small contexts: no card; lens centred and a little larger.
const small = `<g transform="translate(54 54) scale(1.16) translate(-54 -49)">${heroWith(false)}</g>`
const mono = `<circle cx="${C.x}" cy="${C.y}" r="${RING}" fill="none" stroke="#fff" stroke-width="${RING_W}"/>
  <g clip-path="url(#glass)"><path d="${VG.land}${VG.india}" fill="#fff"/></g>
  <path d="${cardPath()}" fill="#fff"/>
  <rect x="${CARD.x + 1.8}" y="${CARD.y + 1.8}" width="8.4" height="8.4" rx="1.3" fill="#000"/>
  <rect x="${CARD.x + 12}" y="${CARD.y + 2.4}" width="19" height="2.1" rx="1.05" fill="#000"/>
  <rect x="${CARD.x + 12}" y="${CARD.y + 5.6}" width="26" height="1.4" rx=".7" fill="#000"/>
  <path d="${pinPath(PIN.x, PIN.y, PIN.r + 1.5, PIN.L + 1.5)}" fill="#000"/>
  <path d="${pinPath(PIN.x, PIN.y, PIN.r, PIN.L)}" fill="#fff"/><circle cx="${PIN.x}" cy="${PIN.y}" r="2.5" fill="#000"/>`;
const svg = (vb, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${defs}${body}</svg>`;
const out = {
  full: svg('18 18 72 72', `<rect x="18" y="18" width="72" height="72" fill="url(#bg)"/>${sky}${hero}`),
  fg: svg('0 0 108 108', hero),
  bg: svg('0 0 108 108', `<rect width="108" height="108" fill="url(#bg)"/>${sky}`),
  small: svg('18 18 72 72', `<rect x="18" y="18" width="72" height="72" fill="url(#bg)"/>${sky}${small}`),
  mono: svg('0 0 108 108', mono)
};
(async () => {
  if (OUT) for (const [k, v] of Object.entries(out)) fs.writeFileSync(`${OUT}/geoziptag-app-icon-${k}.svg`, v);
  const b = await chromium.launch(); const p = await b.newPage();
  for (const [name, size] of [['full', 1024], ['fg', 1080], ['bg', 1080], ['mono', 1080], ['small', 1024]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${out[name]}`);
    await p.waitForTimeout(200); await p.screenshot({ path: `${D}/${name}-${size}.png`, omitBackground: true });
  }
  await b.close();
})();
