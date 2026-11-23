/* 착한한끼 · GitHub Pages 정적 웹앱 (Google Sheets 실시간 DB + Supabase 회원/찜/제보 DB) */

const CFG = window.CHAKHAN_CONFIG || {};
const SHEET_ID = CFG.GOOGLE_SHEET_ID || '1sMiFRC4RwI4xRnZ-RG2zInph6QAV6ywWpS4POHZDoZw';
const SHEET_GID = CFG.GOOGLE_SHEET_GID || '553501454';
const ALLOWED_CATEGORIES = new Set(['한식', '중식', '일식', '양식', '베이커리']);

const SEOUL_CAMPUS_HUBS = [
  { id: 'sinchon', name: '신촌역 (연대·서강·이대)', gu: '서대문구', lat: 37.5551, lng: 126.9368 },
  { id: 'hongdae', name: '홍대입구역 (홍익대)', gu: '마포구', lat: 37.5572, lng: 126.9245 },
  { id: 'hyehwa', name: '혜화역 (성균관대)', gu: '종로구', lat: 37.5821, lng: 127.0019 },
  { id: 'anam', name: '안암역 (고려대)', gu: '성북구', lat: 37.5863, lng: 127.0291 },
  { id: 'hoegi', name: '회기역 (경희·외대·시립대)', gu: '동대문구', lat: 37.5897, lng: 127.0579 },
  { id: 'kondae', name: '건대입구역 (건국·세종대)', gu: '광진구', lat: 37.5404, lng: 127.0692 },
  { id: 'hanyang', name: '한양대·왕십리역', gu: '성동구', lat: 37.5612, lng: 127.0378 },
  { id: 'snu', name: '서울대입구역 (서울대)', gu: '관악구', lat: 37.4812, lng: 126.9527 },
  { id: 'cau', name: '흑석역 (중앙대)', gu: '동작구', lat: 37.5088, lng: 126.9637 },
  { id: 'soongsil', name: '숭실대입구역 (숭실대)', gu: '동작구', lat: 37.4963, lng: 126.9537 },
  { id: 'sookmyung', name: '숙대입구역 (숙명여대)', gu: '용산구', lat: 37.5446, lng: 126.9722 },
  { id: 'noryangjin', name: '노량진역', gu: '동작구', lat: 37.5134, lng: 126.9424 },
  { id: 'gangnam', name: '강남·서초권 (교대)', gu: '서초구', lat: 37.50564, lng: 127.01483 },
  { id: 'seoul_all', name: '서울 중심 (시청·종로)', gu: '중구', lat: 37.5665, lng: 126.9780 },
];

const state = {
  allRestaurants: [],
  filtered: [],
  geoCache: {},
  geoLookup: { gus: {}, places: {} },
  dataSourceLabel: '연동 대기',
  lastSyncAt: '',

  sb: null,
  sbConfigured: false,
  user: null,
  profile: null,
  favKeys: new Set(),
  pendingFavoriteKey: null,

  selectedId: null,
  selectedRestaurant: null,

  refLat: 37.5551,
  refLng: 126.9368,
  refLabel: '신촌역 (연대·서강·이대)',
  activeHubId: 'sinchon',
  isGpsActive: false,

  gu: '전체',
  category: '전체',
  maxPrice: '',
  radiusM: 2000,
  query: '',
  sort: 'distance',
  favoritesOnly: false,
};

let map = null;
let clusterGroup = null;
let radiusCircle = null;
let refMarker = null;
let searchDebounce = null;

// --- Utility Helpers ---
function fmtPrice(num) {
  return Number(num || 0).toLocaleString('ko-KR') + '원';
}

function fmtShortPrice(num) {
  const n = Number(num || 0);
  if (n >= 10000 && n % 1000 === 0) return n / 10000 + '만';
  return n.toLocaleString('ko-KR') + '원';
}

function fmtDistance(m) {
  if (m === null || m === undefined) return '';
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function extractDong(address) {
  const m = /\(([^,)]+)/.exec(address || '');
  if (!m) return '';
  const part = m[1].trim().split(/\s+/)[0];
  return /[동가로]$/.test(part) ? part : '';
}

function deterministicOffset(key, radiusDeg = 0.0022) {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  h = Math.abs(h);
  const angle = ((h % 360) * Math.PI) / 180;
  const dist = ((Math.floor(h / 360) % 100) / 100) * radiusDeg;
  return [Math.sin(angle) * dist, Math.cos(angle) * dist];
}

function resolveCoords(gu, name, address, dong) {
  const key = `${gu}|${name}|${address}`;
  const cached = state.geoCache[key];
  if (cached && cached.lat && cached.lng) {
    return { lat: cached.lat, lng: cached.lng, precision: cached.precision || 'cached' };
  }
  const place = dong && state.geoLookup.places ? state.geoLookup.places[dong] : null;
  if (place && place.length === 2) {
    const [dlat, dlng] = deterministicOffset(key, 0.0018);
    return { lat: +(place[0] + dlat).toFixed(6), lng: +(place[1] + dlng).toFixed(6), precision: 'osm_dong' };
  }
  const guCenter = (state.geoLookup.gus && state.geoLookup.gus[gu]) || [37.5665, 126.978];
  const [dlat, dlng] = deterministicOffset(key, 0.004);
  return { lat: +(guCenter[0] + dlat).toFixed(6), lng: +(guCenter[1] + dlng).toFixed(6), precision: 'gu_fallback' };
}

// --- Google Spreadsheet Reader (No Apps Script Needed) ---
function normalizeSheetRecords(rawObjects) {
  const items = [];
  let seq = 1;

  for (const r of rawObjects) {
    const sido = (r['시도'] || '').trim();
    const gu = (r['시군'] || '').trim();
    const category = (r['업종'] || '').trim();
    const name = (r['업소명'] || '').trim();
    const address = (r['주소'] || '').trim();

    if (sido !== '서울특별시' || !ALLOWED_CATEGORIES.has(category) || !name || !address) {
      continue;
    }

    const menus = [];
    for (let i = 1; i <= 4; i++) {
      const mName = String(r[`메뉴${i}`] ?? '').trim();
      const pRaw = String(r[`가격${i}`] ?? '').replace(/,/g, '').trim();
      const pNum = Number(pRaw);
      if (mName && pRaw !== '' && Number.isFinite(pNum) && pNum > 0) {
        menus.push({ name: mName, price: Math.round(pNum) });
      }
    }
    if (!menus.length) continue;

    const minPrice = Math.min(...menus.map((m) => m.price));
    const dong = extractDong(address);
    const { lat, lng, precision } = resolveCoords(gu, name, address, dong);
    const externalKey = `${gu}|${name}|${address}`;

    items.push({
      id: seq++,
      external_key: externalKey,
      gu,
      dong,
      category,
      name,
      address,
      menus,
      min_price: minPrice,
      main_menu: menus[0].name,
      main_price: menus[0].price,
      lat,
      lng,
      geo_precision: precision,
    });
  }

  return items;
}

async function fetchGoogleSheetLive() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${SHEET_GID}&_=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Sheet HTTP ${res.status}`);
  const text = await res.text();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Invalid gviz payload');
  const json = JSON.parse(text.slice(start, end + 1));
  const cols = (json.table?.cols || []).map((c) => (c.label || c.id || '').trim());
  const rows = json.table?.rows || [];

  const objects = rows.map((row) => {
    const obj = {};
    cols.forEach((colName, idx) => {
      const cell = row.c?.[idx];
      obj[colName] = cell && cell.v !== null && cell.v !== undefined ? String(cell.v) : '';
    });
    return obj;
  });

  return normalizeSheetRecords(objects);
}

function parseCsvText(csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };

  const headers = parseLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = vals[i] || '';
    });
    return obj;
  });
}

async function loadRestaurantsFromSheet(showNotice = false) {
  let items = [];
  try {
    items = await fetchGoogleSheetLive();
    state.dataSourceLabel = '구글 시트 실시간 연동';
  } catch (err) {
    console.warn('Google Sheet live fetch failed, using fallback CSV:', err);
    const res = await fetch('./data/fallback_restaurants.csv');
    const csvText = await res.text();
    items = normalizeSheetRecords(parseCsvText(csvText));
    state.dataSourceLabel = '로컬 스냅샷 (오프라인 대체)';
  }

  state.allRestaurants = items;
  state.lastSyncAt = new Date().toLocaleString('ko-KR');
  document.getElementById('syncStatusText').textContent = `구글시트 · ${items.length.toLocaleString()}개소`;

  // Populate 25 Seoul Gus dropdown
  const guCounts = new Map();
  items.forEach((r) => guCounts.set(r.gu, (guCounts.get(r.gu) || 0) + 1));
  const guSelect = document.getElementById('guSelect');
  const prevGu = guSelect.value;
  guSelect.innerHTML = '<option value="전체">서울 전체 (25개 구)</option>';
  [...guCounts.keys()].sort().forEach((gu) => {
    const opt = document.createElement('option');
    opt.value = gu;
    opt.textContent = `${gu} (${guCounts.get(gu)})`;
    guSelect.appendChild(opt);
  });
  if ([...guCounts.keys()].includes(prevGu)) guSelect.value = prevGu;

  if (showNotice) {
    showToast(`구글 스프레드시트 동기화 완료 (${items.length.toLocaleString()}개소)`);
  }
  applyFilters(true);
}

// --- Supabase Auth, Favorites, Reports, Analytics ---
function initSupabaseClient() {
  const url = (CFG.SUPABASE_URL || '').trim();
  const key = (CFG.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key || !window.supabase) {
    state.sbConfigured = false;
    document.getElementById('supabaseMissingNotice').classList.remove('hidden');
    loadLocalFavoritesFallback();
    return;
  }

  state.sb = window.supabase.createClient(url, key);
  state.sbConfigured = true;
  document.getElementById('supabaseMissingNotice').classList.add('hidden');

  state.sb.auth.onAuthStateChange((_event, session) => {
    handleSessionUpdate(session);
  });
}

async function handleSessionUpdate(session) {
  state.user = session?.user || null;
  if (state.user) {
    await ensureProfile();
    await loadUserFavorites();
  } else {
    state.profile = null;
    state.favKeys = new Set();
  }
  updateAuthUI();
  updateFavBadge();
  applyFilters(false);
}

async function ensureProfile() {
  if (!state.sb || !state.user) return;
  const { data: existing } = await state.sb
    .from('profiles')
    .select('id, nickname, university')
    .eq('id', state.user.id)
    .maybeSingle();

  if (existing) {
    state.profile = existing;
    return;
  }

  const meta = state.user.user_metadata || {};
  const fallbackNick = meta.nickname || (state.user.email ? state.user.email.split('@')[0] : '대학생');
  const fallbackUniv = meta.university || '';
  const { data: inserted } = await state.sb
    .from('profiles')
    .upsert({
      id: state.user.id,
      nickname: fallbackNick,
      university: fallbackUniv,
      agreed_terms: true,
    })
    .select('id, nickname, university')
    .maybeSingle();
  state.profile = inserted || { nickname: fallbackNick, university: fallbackUniv };
}

async function loadUserFavorites() {
  if (!state.sb || !state.user) return;
  const { data, error } = await state.sb
    .from('favorites')
    .select('restaurant_key')
    .eq('user_id', state.user.id);
  if (!error && data) {
    state.favKeys = new Set(data.map((row) => row.restaurant_key));
  }
}

function loadLocalFavoritesFallback() {
  try {
    const raw = JSON.parse(localStorage.getItem('chakhan_local_favs') || '[]');
    state.favKeys = new Set(raw);
  } catch {
    state.favKeys = new Set();
  }
  updateFavBadge();
}

function saveLocalFavoritesFallback() {
  localStorage.setItem('chakhan_local_favs', JSON.stringify([...state.favKeys]));
}

function updateFavBadge() {
  document.getElementById('favCountBadge').textContent = state.favKeys.size;
}

async function toggleFavorite(restaurantKey, restaurantName = '') {
  if (!state.sbConfigured) {
    if (state.favKeys.has(restaurantKey)) {
      state.favKeys.delete(restaurantKey);
      showToast('브라우저 임시 즐겨찾기에서 해제했어요');
    } else {
      state.favKeys.add(restaurantKey);
      showToast('브라우저 임시 즐겨찾기에 저장했어요 ♥ (Supabase 연결 시 클라우드 저장)');
    }
    saveLocalFavoritesFallback();
    updateFavBadge();
    refreshCurrentViewAfterFav(restaurantKey);
    return;
  }

  if (!state.user) {
    state.pendingFavoriteKey = { key: restaurantKey, name: restaurantName };
    openModal('authModal');
    showToast('찜하기를 클라우드에 저장하려면 먼저 로그인해 주세요!');
    return;
  }

  if (state.favKeys.has(restaurantKey)) {
    const { error } = await state.sb
      .from('favorites')
      .delete()
      .eq('user_id', state.user.id)
      .eq('restaurant_key', restaurantKey);
    if (error) return showToast('찜 해제 실패: ' + error.message);
    state.favKeys.delete(restaurantKey);
    showToast('즐겨찾기에서 해제했어요');
  } else {
    const { error } = await state.sb.from('favorites').insert({
      user_id: state.user.id,
      restaurant_key: restaurantKey,
      restaurant_name: restaurantName,
    });
    if (error) return showToast('찜 저장 실패: ' + error.message);
    state.favKeys.add(restaurantKey);
    showToast('내 Supabase 계정에 찜 완료 ♥');
  }

  updateFavBadge();
  refreshCurrentViewAfterFav(restaurantKey);
}

function refreshCurrentViewAfterFav(restaurantKey) {
  if (state.selectedRestaurant && state.selectedRestaurant.external_key === restaurantKey) {
    updateDetailFavButton(state.favKeys.has(restaurantKey));
  }
  applyFilters(false);
}

function logEvent(eventType, payload = {}) {
  if (!state.sbConfigured || !state.sb) return;
  state.sb.from('analytics_events').insert({ event_type: eventType, payload }).then(() => {});
}

// --- Map & Filtering ---
function initMap() {
  map = L.map('map', {
    center: [state.refLat, state.refLng],
    zoom: 14,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 48,
    spiderfyOnMaxZoom: true,
  });
  map.addLayer(clusterGroup);
}

function updateReferenceOverlay(fitRadius = false) {
  if (refMarker) {
    map.removeLayer(refMarker);
    refMarker = null;
  }
  if (radiusCircle) {
    map.removeLayer(radiusCircle);
    radiusCircle = null;
  }

  if (state.refLat != null && state.refLng != null) {
    const icon = L.divIcon({
      className: 'hub-marker-wrap',
      html: '<div class="hub-marker-dot"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    refMarker = L.marker([state.refLat, state.refLng], { icon, interactive: true })
      .bindTooltip(state.isGpsActive ? '📍 내 현재 위치' : `🎓 기준: ${state.refLabel}`, { direction: 'top' })
      .addTo(map);

    if (state.radiusM > 0 && state.gu === '전체' && !state.favoritesOnly) {
      radiusCircle = L.circle([state.refLat, state.refLng], {
        radius: state.radiusM,
        color: '#0f766e',
        weight: 1.5,
        fillColor: '#14b8a6',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);

      if (fitRadius) {
        map.fitBounds(radiusCircle.getBounds(), { padding: [36, 36], maxZoom: 15 });
      }
    } else if (fitRadius) {
      map.setView([state.refLat, state.refLng], state.gu !== '전체' ? 13 : 12);
    }
  }
}

function applyFilters(fitMap = false) {
  const maxPriceNum = state.maxPrice ? Number(state.maxPrice) : null;
  const q = state.query.toLowerCase();
  const useRadius = state.radiusM > 0 && state.gu === '전체' && !state.favoritesOnly && !q;

  const list = [];
  for (const r of state.allRestaurants) {
    const isFav = state.favKeys.has(r.external_key);
    if (state.favoritesOnly && !isFav) continue;
    if (state.category !== '전체' && r.category !== state.category) continue;
    if (state.gu !== '전체' && r.gu !== state.gu) continue;
    if (maxPriceNum && r.min_price > maxPriceNum) continue;

    if (q) {
      const hay = `${r.name} ${r.gu} ${r.dong} ${r.address} ${r.category} ${r.menus.map((m) => m.name).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    const distM = haversineMeters(state.refLat, state.refLng, r.lat, r.lng);
    if (useRadius && distM > state.radiusM) continue;

    list.push({ ...r, distance_m: distM, is_favorite: isFav });
  }

  if (state.sort === 'price_asc') {
    list.sort((a, b) => a.min_price - b.min_price || a.distance_m - b.distance_m);
  } else {
    list.sort((a, b) => a.distance_m - b.distance_m || a.min_price - b.min_price);
  }

  state.filtered = list;
  updateReferenceOverlay(fitMap);
  renderMapPins();
  renderList();
}

function renderMapPins() {
  clusterGroup.clearLayers();
  const markers = state.filtered.map((r) => {
    const isSelected = state.selectedId === r.id;
    const html = `<div class="price-pin cat-${r.category} ${isSelected ? 'active' : ''} ${r.is_favorite ? 'liked' : ''}">
      ${r.is_favorite ? '♥ ' : ''}${fmtShortPrice(r.min_price)}
    </div>`;

    const icon = L.divIcon({ className: 'price-pin-wrap', html, iconSize: [0, 0] });
    const marker = L.marker([r.lat, r.lng], { icon });
    marker.bindTooltip(
      `<strong>${escapeHtml(r.name)}</strong><br>${r.category} · ${escapeHtml(r.main_menu)} ${fmtPrice(r.main_price)}`,
      { direction: 'top', offset: [0, -10] }
    );
    marker.on('click', () => openDetail(r.id, false));
    return marker;
  });

  clusterGroup.addLayers(markers);

  if (state.favoritesOnly && state.filtered.length > 0) {
    const bounds = L.latLngBounds(state.filtered.map((r) => [r.lat, r.lng]));
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  }
}

function renderList() {
  const listEl = document.getElementById('restaurantList');
  const countEl = document.getElementById('resultCount');
  const refEl = document.getElementById('activeRefLabel');

  countEl.textContent = state.filtered.length.toLocaleString('ko-KR');
  if (state.favoritesOnly) {
    refEl.textContent = '· 내 즐겨찾기 모아보기';
  } else if (state.gu !== '전체') {
    refEl.textContent = `· ${state.gu}`;
  } else if (state.radiusM > 0 && !state.query) {
    refEl.textContent = `· ${state.refLabel} 반경 ${fmtDistance(state.radiusM)}`;
  } else {
    refEl.textContent = '· 서울특별시 전체';
  }

  if (!state.filtered.length) {
    listEl.innerHTML = `
      <div class="empty-state">
        조건에 맞는 착한가격업소가 없어요.<br/>
        <strong>검색 반경을 넓히거나</strong> 가격·업종 필터를 조정해 보세요!
      </div>
    `;
    return;
  }

  const visible = state.filtered.slice(0, 250);
  const frag = document.createDocumentFragment();

  visible.forEach((r) => {
    const card = document.createElement('div');
    card.className = `r-card ${state.selectedId === r.id ? 'selected' : ''}`;
    card.innerHTML = `
      <div class="r-card-top">
        <div class="r-title-row">
          <span class="cat-badge cat-${r.category}">${r.category}</span>
          <span class="r-name">${escapeHtml(r.name)}</span>
        </div>
        <button type="button" class="heart-mini ${r.is_favorite ? 'liked' : ''}" title="즐겨찾기">
          ${r.is_favorite ? '♥' : '♡'}
        </button>
      </div>
      <div class="r-menu-row">
        <span class="r-menu-name">${escapeHtml(r.main_menu)} ${r.menus.length > 1 ? `외 ${r.menus.length - 1}개` : ''}</span>
        <span class="r-price">최저 ${fmtPrice(r.min_price)}</span>
      </div>
      <div class="r-foot">
        <span>${escapeHtml(r.gu)} ${escapeHtml(r.dong)}</span>
        <span class="r-dist">${fmtDistance(r.distance_m)}</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.heart-mini')) {
        e.stopPropagation();
        toggleFavorite(r.external_key, r.name);
        return;
      }
      openDetail(r.id, true);
    });

    frag.appendChild(card);
  });

  listEl.innerHTML = '';
  listEl.appendChild(frag);
}

// --- Detail Drawer & Reports ---
async function openDetail(id, panMap = false) {
  const r = state.filtered.find((x) => x.id === id) || state.allRestaurants.find((x) => x.id === id);
  if (!r) return;

  state.selectedId = id;
  state.selectedRestaurant = r;
  renderList();

  if (panMap && map) {
    map.setView([r.lat, r.lng], Math.max(map.getZoom(), 16), { animate: true });
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('mobileListToggle').textContent = '📋 목록 보기';
  }

  const drawer = document.getElementById('detailDrawer');
  drawer.classList.remove('hidden');

  document.getElementById('detailBadges').innerHTML = `
    <span class="cat-badge cat-${r.category}">${r.category}</span>
    <span class="cert-badge">✔ 행정안전부 착한가격업소</span>
  `;
  document.getElementById('detailName').textContent = r.name;
  document.getElementById('detailAddress').textContent = r.address;
  const distM = haversineMeters(state.refLat, state.refLng, r.lat, r.lng);
  document.getElementById('detailDistance').textContent = `${state.refLabel} 기준 ${fmtDistance(distM)}`;

  updateDetailFavButton(state.favKeys.has(r.external_key));

  document.getElementById('detailMenuList').innerHTML = r.menus
    .map(
      (m) => `
      <li class="menu-item">
        <span>${escapeHtml(m.name)}</span>
        <strong>${fmtPrice(m.price)}</strong>
      </li>
    `
    )
    .join('');

  const encodedQuery = encodeURIComponent(`${r.name} ${r.gu}`);
  document.getElementById('naverMapLink').href = `https://map.naver.com/p/search/${encodedQuery}`;
  document.getElementById('kakaoMapLink').href = `https://map.kakao.com/link/to/${encodeURIComponent(r.name)},${r.lat},${r.lng}`;
  document.getElementById('osmMapLink').href = `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=17/${r.lat}/${r.lng}`;

  renderMapPins();
  await loadReportsForRestaurant(r.external_key);
  logEvent('view_restaurant', { gu: r.gu, category: r.category });
}

function updateDetailFavButton(isFav) {
  const btn = document.getElementById('detailFavBtn');
  btn.classList.toggle('liked', isFav);
  btn.textContent = isFav ? '♥ 찜 완료' : '♡ 찜하기';
}

async function loadReportsForRestaurant(restaurantKey) {
  const ul = document.getElementById('reportHistory');
  ul.innerHTML = '';
  if (!state.sbConfigured || !state.sb) return;

  const { data } = await state.sb
    .from('reports')
    .select('id, report_type, reported_price, detail, status, created_at')
    .eq('restaurant_key', restaurantKey)
    .order('id', { ascending: false })
    .limit(10);

  if (!data || !data.length) return;
  const typeLabel = {
    price_change: '가격 변동',
    menu_error: '메뉴 오류',
    closed: '폐업/휴업',
    location_error: '위치 오차',
  };
  ul.innerHTML = data
    .map((rep) => {
      const priceStr = rep.reported_price ? ` (${fmtPrice(rep.reported_price)})` : '';
      return `<li><strong>[${typeLabel[rep.report_type] || rep.report_type}${priceStr}]</strong> ${escapeHtml(rep.detail)} · <em>${escapeHtml(rep.status)}</em></li>`;
    })
    .join('');
}

// --- Auth UI ---
function updateAuthUI() {
  const authBtn = document.getElementById('authBtn');
  const loggedOut = document.getElementById('loggedOutView');
  const loggedIn = document.getElementById('loggedInView');

  if (state.user) {
    const nick = state.profile?.nickname || state.user.user_metadata?.nickname || state.user.email.split('@')[0];
    const univ = state.profile?.university || state.user.user_metadata?.university || '서울 대학생';
    authBtn.textContent = `👤 ${nick}`;
    authBtn.classList.remove('btn-primary');
    authBtn.classList.add('btn-outline');
    loggedOut.classList.add('hidden');
    loggedIn.classList.remove('hidden');
    document.getElementById('authModalTitle').textContent = '👤 내 계정 관리';
    document.getElementById('profileNickname').textContent = nick;
    document.getElementById('profileEmail').textContent = state.user.email;
    document.getElementById('profileUniv').textContent = univ;
  } else {
    authBtn.textContent = '로그인 / 가입';
    authBtn.classList.add('btn-primary');
    authBtn.classList.remove('btn-outline');
    loggedOut.classList.remove('hidden');
    loggedIn.classList.add('hidden');
    document.getElementById('authModalTitle').textContent = '🎓 착한한끼 로그인';
  }
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function syncFilterChipStates() {
  document.querySelectorAll('#categoryChips .chip').forEach((el) => {
    el.classList.toggle('active', el.dataset.cat === state.category);
  });
  document.querySelectorAll('#priceChips .chip').forEach((el) => {
    el.classList.toggle('active', el.dataset.price === String(state.maxPrice));
  });
  document.querySelectorAll('#radiusChips .chip').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.radius) === state.radiusM);
  });
}

// --- Bootstrap ---
async function initApp() {
  initMap();

  const hubContainer = document.getElementById('hubChips');
  hubContainer.innerHTML = SEOUL_CAMPUS_HUBS.map(
    (h) => `
    <button type="button" class="hub-chip ${h.id === state.activeHubId ? 'active' : ''}" data-hub="${h.id}">
      ${escapeHtml(h.name)}
    </button>
  `
  ).join('');

  initSupabaseClient();
  if (state.sb) {
    const { data } = await state.sb.auth.getSession();
    await handleSessionUpdate(data.session);
  }

  try {
    const [cacheRes, lookupRes] = await Promise.all([
      fetch('./data/geocode_cache.json'),
      fetch('./data/seoul_geo_lookup.json'),
    ]);
    state.geoCache = await cacheRes.json();
    state.geoLookup = await lookupRes.json();
  } catch (err) {
    console.warn('Geocode cache preload warning:', err);
  }

  await loadRestaurantsFromSheet(false);
  bindEvents();
}

function bindEvents() {
  document.getElementById('brandHomeBtn').addEventListener('click', () => {
    state.favoritesOnly = false;
    state.gu = '전체';
    state.category = '전체';
    state.maxPrice = '';
    state.query = '';
    state.radiusM = 2000;
    document.getElementById('searchInput').value = '';
    document.getElementById('clearSearchBtn').classList.add('hidden');
    document.getElementById('guSelect').value = '전체';
    document.getElementById('favOnlyCheck').checked = false;
    document.getElementById('favModeBtn').classList.remove('active');
    syncFilterChipStates();
    applyFilters(true);
  });

  document.getElementById('closeIntroBtn').addEventListener('click', () => {
    document.getElementById('introBanner').classList.add('hidden');
  });

  document.getElementById('hubChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.hub-chip');
    if (!btn) return;
    const hub = SEOUL_CAMPUS_HUBS.find((h) => h.id === btn.dataset.hub);
    if (!hub) return;

    state.activeHubId = hub.id;
    state.isGpsActive = false;
    state.refLat = hub.lat;
    state.refLng = hub.lng;
    state.refLabel = hub.name;
    state.gu = '전체';
    state.favoritesOnly = false;
    if (hub.id === 'seoul_all') state.radiusM = 0;
    else if (state.radiusM === 0) state.radiusM = 2000;

    document.getElementById('guSelect').value = '전체';
    document.getElementById('favOnlyCheck').checked = false;
    document.getElementById('favModeBtn').classList.remove('active');
    document.getElementById('gpsBtn').classList.remove('active');
    document.querySelectorAll('.hub-chip').forEach((el) => el.classList.toggle('active', el === btn));
    syncFilterChipStates();
    logEvent('select_hub', { hub: hub.id });
    applyFilters(true);
  });

  document.getElementById('guSelect').addEventListener('change', (e) => {
    state.gu = e.target.value;
    state.favoritesOnly = false;
    document.getElementById('favOnlyCheck').checked = false;
    document.getElementById('favModeBtn').classList.remove('active');
    if (state.gu !== '전체' && state.geoLookup.gus?.[state.gu]) {
      const [lat, lng] = state.geoLookup.gus[state.gu];
      state.refLat = lat;
      state.refLng = lng;
      state.refLabel = state.gu;
    }
    logEvent('select_gu', { gu: state.gu });
    applyFilters(true);
  });

  document.getElementById('gpsBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return showToast('브라우저가 위치 정보를 지원하지 않습니다.');
    showToast('현재 위치를 확인하고 있어요...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.refLat = pos.coords.latitude;
        state.refLng = pos.coords.longitude;
        state.refLabel = '내 현재 위치';
        state.isGpsActive = true;
        state.activeHubId = '';
        state.gu = '전체';
        if (state.radiusM === 0) state.radiusM = 1000;
        document.getElementById('gpsBtn').classList.add('active');
        document.getElementById('guSelect').value = '전체';
        document.querySelectorAll('.hub-chip').forEach((el) => el.classList.remove('active'));
        syncFilterChipStates();
        logEvent('use_gps');
        applyFilters(true);
        showToast('현재 위치 주변 가성비 식당을 찾았어요!');
      },
      () => showToast('위치 권한이 거부되었거나 확인할 수 없습니다.'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  document.getElementById('categoryChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.category = btn.dataset.cat;
    syncFilterChipStates();
    logEvent('filter_category', { category: state.category });
    applyFilters(false);
  });

  document.getElementById('priceChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.maxPrice = btn.dataset.price;
    syncFilterChipStates();
    logEvent('filter_price', { max_price: state.maxPrice || 'all' });
    applyFilters(false);
  });

  document.getElementById('radiusChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.radiusM = Number(btn.dataset.radius);
    if (state.radiusM > 0) {
      state.gu = '전체';
      document.getElementById('guSelect').value = '전체';
    }
    syncFilterChipStates();
    applyFilters(true);
  });

  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim();
    clearSearchBtn.classList.toggle('hidden', !state.query);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => applyFilters(false), 200);
  });
  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    clearSearchBtn.classList.add('hidden');
    applyFilters(false);
  });

  document.getElementById('sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyFilters(false);
  });

  const toggleFavOnly = (forceVal = null) => {
    if (state.sbConfigured && !state.user) {
      openModal('authModal');
      showToast('내 즐겨찾기 모아보기는 로그인 후 이용할 수 있어요!');
      document.getElementById('favOnlyCheck').checked = false;
      return;
    }
    state.favoritesOnly = forceVal !== null ? forceVal : !state.favoritesOnly;
    document.getElementById('favOnlyCheck').checked = state.favoritesOnly;
    document.getElementById('favModeBtn').classList.toggle('active', state.favoritesOnly);
    applyFilters(true);
  };
  document.getElementById('favOnlyCheck').addEventListener('change', (e) => toggleFavOnly(e.target.checked));
  document.getElementById('favModeBtn').addEventListener('click', () => toggleFavOnly());

  document.getElementById('closeDetailBtn').addEventListener('click', () => {
    document.getElementById('detailDrawer').classList.add('hidden');
    state.selectedId = null;
    renderList();
    renderMapPins();
  });

  document.getElementById('detailFavBtn').addEventListener('click', () => {
    if (state.selectedRestaurant) {
      toggleFavorite(state.selectedRestaurant.external_key, state.selectedRestaurant.name);
    }
  });

  document.getElementById('copyAddrBtn').addEventListener('click', () => {
    if (!state.selectedRestaurant) return;
    navigator.clipboard?.writeText(state.selectedRestaurant.address);
    showToast('도로명 주소를 복사했어요!');
  });

  document.getElementById('detailShareBtn').addEventListener('click', () => {
    if (!state.selectedRestaurant) return;
    const r = state.selectedRestaurant;
    navigator.clipboard?.writeText(`[착한한끼] ${r.name} (${r.category}) - ${r.main_menu} ${fmtPrice(r.main_price)} | ${r.address}`);
    showToast('식당 정보를 클립보드에 복사했어요!');
  });

  document.getElementById('reportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedRestaurant) return;
    if (!state.sbConfigured || !state.sb) {
      return showToast('Supabase 연결 설정 후 제보를 저장할 수 있어요.');
    }

    const report_type = document.getElementById('reportType').value;
    const priceRaw = document.getElementById('reportPrice').value.trim();
    const reported_price = priceRaw ? Number(priceRaw) : null;
    const detail = document.getElementById('reportDetail').value.trim();

    const { error } = await state.sb.from('reports').insert({
      restaurant_key: state.selectedRestaurant.external_key,
      restaurant_name: state.selectedRestaurant.name,
      user_id: state.user?.id || null,
      report_type,
      reported_price,
      detail,
    });

    if (error) return showToast('제보 등록 실패: ' + error.message);
    document.getElementById('reportPrice').value = '';
    document.getElementById('reportDetail').value = '';
    showToast('Supabase DB에 제보가 등록되었어요! 감사합니다.');
    await loadReportsForRestaurant(state.selectedRestaurant.external_key);
  });

  document.getElementById('syncNowBtn').addEventListener('click', () => loadRestaurantsFromSheet(true));
  document.getElementById('authBtn').addEventListener('click', () => openModal('authModal'));
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });

  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.authTab;
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.getElementById('loginForm').classList.toggle('hidden', mode !== 'login');
      document.getElementById('registerForm').classList.toggle('hidden', mode !== 'register');
    });
  });

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.sb) return showToast('먼저 docs/config.js에 Supabase 키를 설정해 주세요.');
    const { data, error } = await state.sb.auth.signInWithPassword({
      email: document.getElementById('loginEmail').value.trim(),
      password: document.getElementById('loginPassword').value,
    });
    if (error) return showToast('로그인 실패: ' + error.message);
    closeModal('authModal');
    showToast('로그인되었습니다!');
    await handleSessionUpdate(data.session);
    if (state.pendingFavoriteKey) {
      const p = state.pendingFavoriteKey;
      state.pendingFavoriteKey = null;
      await toggleFavorite(p.key, p.name);
    }
  });

  document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.sb) return showToast('먼저 docs/config.js에 Supabase 키를 설정해 주세요.');
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    const nickname = document.getElementById('regNickname').value.trim();
    const university = document.getElementById('regUniv').value.trim();

    const { data, error } = await state.sb.auth.signUp({
      email,
      password,
      options: { data: { nickname, university } },
    });
    if (error) return showToast('회원가입 실패: ' + error.message);

    if (data.session) {
      closeModal('authModal');
      showToast(`환영합니다, ${nickname}님!`);
      await handleSessionUpdate(data.session);
      if (state.pendingFavoriteKey) {
        const p = state.pendingFavoriteKey;
        state.pendingFavoriteKey = null;
        await toggleFavorite(p.key, p.name);
      }
    } else {
      showToast('가입 확인 이메일을 보냈습니다! 이메일 인증 후 로그인해 주세요.');
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (state.sb) await state.sb.auth.signOut();
    state.favoritesOnly = false;
    document.getElementById('favOnlyCheck').checked = false;
    document.getElementById('favModeBtn').classList.remove('active');
    closeModal('authModal');
    showToast('로그아웃되었습니다.');
  });

  document.getElementById('viewMyFavMapBtn').addEventListener('click', () => {
    closeModal('authModal');
    toggleFavOnly(true);
  });

  document.getElementById('metricsBtn').addEventListener('click', async () => {
    openModal('metricsModal');
    const el = document.getElementById('metricsContent');
    el.innerHTML = '<p class="metric-full">데이터 확인 중...</p>';

    let reportsCount = '-';
    let eventsCount = '-';
    if (state.sbConfigured && state.sb) {
      const [repRes, evRes] = await Promise.all([
        state.sb.from('reports').select('*', { count: 'exact', head: true }),
        state.sb.from('analytics_events').select('*', { count: 'exact', head: true }),
      ]);
      reportsCount = repRes.count ?? 0;
      eventsCount = evRes.count ?? 0;
    }

    el.innerHTML = `
      <div class="metric-card"><span>서울 요식업 착한가격업소</span><strong>${state.allRestaurants.length.toLocaleString()}개소</strong></div>
      <div class="metric-card"><span>내 즐겨찾기 (찜)</span><strong>${state.favKeys.size.toLocaleString()}건</strong></div>
      <div class="metric-card"><span>누적 가격·오류 제보</span><strong>${reportsCount}건</strong></div>
      <div class="metric-card"><span>탐색 인터랙션 로그</span><strong>${eventsCount}건</strong></div>
      <div class="metric-card metric-full">
        <span>하이브리드 클라우드 DB 아키텍처</span>
        <p style="margin-top:6px;">
          • 가게 DB: <strong>${escapeHtml(state.dataSourceLabel)}</strong> (최근 동기화: ${escapeHtml(state.lastSyncAt)})<br/>
          • 회원 · 찜 · 제보 DB: <strong>${state.sbConfigured ? 'Supabase 연결됨 ✅' : '미연결 (docs/config.js 설정 필요)'}</strong>
        </p>
      </div>
    `;
  });

  document.getElementById('mobileListToggle').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    const open = sb.classList.toggle('mobile-open');
    document.getElementById('mobileListToggle').textContent = open ? '🗺️ 지도 보기' : '📋 목록 보기';
  });
}

window.addEventListener('DOMContentLoaded', initApp);
