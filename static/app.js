/* 착한한끼 · 서울시 대학생 가성비 요식업 지도 프론트엔드 */

const state = {
  hubs: [],
  gus: [],
  restaurants: [],
  user: null,
  token: localStorage.getItem('chakhan_token') || '',
  selectedId: null,
  selectedRestaurant: null,
  pendingFavoriteKey: null,

  // Active reference point (default: 강남/교대 or 신촌역 - let's start at 신촌 대학가 and support 서울 전체)
  refLat: 37.5551,
  refLng: 126.9368,
  refLabel: '신촌역 (연대·서강·이대)',
  activeHubId: 'sinchon',
  isGpsActive: false,

  // Filters
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
let markerById = new Map();
let searchDebounce = null;

// Utility helpers
function fmtPrice(num) {
  return Number(num || 0).toLocaleString('ko-KR') + '원';
}

function fmtShortPrice(num) {
  const n = Number(num || 0);
  if (n >= 10000 && n % 1000 === 0) {
    return (n / 10000) + '만';
  }
  return n.toLocaleString('ko-KR') + '원';
}

function fmtDistance(m) {
  if (m === null || m === undefined) return '';
  if (m < 1000) return `${m}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function apiFetch(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `요청 오류 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function logEvent(eventType, payload = {}) {
  fetch('/api/analytics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: eventType, payload }),
  }).catch(() => {});
}

// Initialize Leaflet + OpenStreetMap
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
      .bindTooltip(state.isGpsActive ? '📍 내 현재 위치' : `🎓 기준: ${state.refLabel}`, {
        direction: 'top',
      })
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

// Render Map Pins
function renderMapPins() {
  clusterGroup.clearLayers();
  markerById.clear();

  const markers = state.restaurants.map((r) => {
    const isSelected = state.selectedId === r.id;
    const html = `<div class="price-pin cat-${r.category} ${isSelected ? 'active' : ''} ${r.is_favorite ? 'liked' : ''}">
      ${r.is_favorite ? '♥ ' : ''}${fmtShortPrice(r.min_price)}
    </div>`;

    const icon = L.divIcon({
      className: 'price-pin-wrap',
      html,
      iconSize: [0, 0],
    });

    const marker = L.marker([r.lat, r.lng], { icon });
    marker.bindTooltip(
      `<strong>${r.name}</strong><br>${r.category} · ${r.main_menu} ${fmtPrice(r.main_price)}`,
      { direction: 'top', offset: [0, -10] }
    );
    marker.on('click', () => openDetail(r.id));
    markerById.set(r.id, marker);
    return marker;
  });

  clusterGroup.addLayers(markers);

  if (state.favoritesOnly && state.restaurants.length > 0) {
    const bounds = L.latLngBounds(state.restaurants.map((r) => [r.lat, r.lng]));
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  }
}

// Render Sidebar List
function renderList() {
  const listEl = document.getElementById('restaurantList');
  const countEl = document.getElementById('resultCount');
  const refEl = document.getElementById('activeRefLabel');

  countEl.textContent = state.restaurants.length.toLocaleString('ko-KR');
  if (state.favoritesOnly) {
    refEl.textContent = '· 내 즐겨찾기 모아보기';
  } else if (state.gu !== '전체') {
    refEl.textContent = `· ${state.gu}`;
  } else if (state.radiusM > 0) {
    refEl.textContent = `· ${state.refLabel} 반경 ${fmtDistance(state.radiusM)}`;
  } else {
    refEl.textContent = '· 서울특별시 전체';
  }

  if (state.restaurants.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        조건에 맞는 착한가격업소가 없어요.<br/>
        <strong>검색 반경을 넓히거나</strong> 가격·업종 필터를 조정해 보세요!
      </div>
    `;
    return;
  }

  // Cap DOM render to 250 cards for snappy scrolling while all pins render on map
  const visible = state.restaurants.slice(0, 250);
  const frag = document.createDocumentFragment();

  visible.forEach((r) => {
    const card = document.createElement('div');
    card.className = `r-card ${state.selectedId === r.id ? 'selected' : ''}`;
    card.dataset.id = r.id;

    const distText = r.distance_m != null ? fmtDistance(r.distance_m) : r.gu;
    card.innerHTML = `
      <div class="r-card-top">
        <div class="r-title-row">
          <span class="cat-badge cat-${r.category}">${r.category}</span>
          <span class="r-name">${escapeHtml(r.name)}</span>
        </div>
        <button type="button" class="heart-mini ${r.is_favorite ? 'liked' : ''}" data-fav-key="${escapeHtml(r.external_key)}" title="즐겨찾기">
          ${r.is_favorite ? '♥' : '♡'}
        </button>
      </div>
      <div class="r-menu-row">
        <span class="r-menu-name">${escapeHtml(r.main_menu)} ${r.menus.length > 1 ? `외 ${r.menus.length - 1}개` : ''}</span>
        <span class="r-price">최저 ${fmtPrice(r.min_price)}</span>
      </div>
      <div class="r-foot">
        <span>${escapeHtml(r.gu)} ${escapeHtml(r.dong)}</span>
        <span class="r-dist">${distText}</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      const favBtn = e.target.closest('.heart-mini');
      if (favBtn) {
        e.stopPropagation();
        toggleFavorite(r.external_key);
        return;
      }
      openDetail(r.id, true);
    });

    frag.appendChild(card);
  });

  listEl.innerHTML = '';
  listEl.appendChild(frag);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Fetch Restaurants from Backend API
async function loadRestaurants(fitMap = false) {
  const params = new URLSearchParams();
  if (state.category && state.category !== '전체') params.set('category', state.category);
  if (state.maxPrice) params.set('max_price', state.maxPrice);
  if (state.gu && state.gu !== '전체') params.set('gu', state.gu);
  if (state.query) params.set('q', state.query);
  if (state.sort) params.set('sort', state.sort);
  if (state.favoritesOnly) params.set('favorites_only', '1');

  if (state.refLat != null && state.refLng != null) {
    params.set('lat', state.refLat);
    params.set('lng', state.refLng);
    if (state.radiusM > 0 && state.gu === '전체' && !state.favoritesOnly && !state.query) {
      params.set('radius_m', state.radiusM);
    }
  }

  try {
    const data = await apiFetch(`/api/restaurants?${params.toString()}`);
    state.restaurants = data.items || [];
    updateReferenceOverlay(fitMap);
    renderMapPins();
    renderList();
  } catch (err) {
    showToast(err.message);
  }
}

// Open 3.0 Restaurant Detail Drawer
async function openDetail(id, panMap = false) {
  state.selectedId = id;
  renderList();

  try {
    const data = await apiFetch(`/api/restaurants/${id}`);
    const r = data.item;
    state.selectedRestaurant = r;

    if (panMap && map) {
      map.setView([r.lat, r.lng], Math.max(map.getZoom(), 16), { animate: true });
      // On mobile, switch back to map view so user sees the pin + detail drawer
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

    const listMatch = state.restaurants.find((item) => item.id === r.id);
    const distLabel = listMatch && listMatch.distance_m != null
      ? `${state.refLabel} 기준 ${fmtDistance(listMatch.distance_m)}`
      : `${r.gu} ${r.dong}`;
    document.getElementById('detailDistance').textContent = distLabel;

    updateDetailFavButton(r.is_favorite, r.favorite_count);

    const menuList = document.getElementById('detailMenuList');
    menuList.innerHTML = r.menus
      .map(
        (m) => `
        <li class="menu-item">
          <span>${escapeHtml(m.name)}</span>
          <strong>${fmtPrice(m.price)}</strong>
        </li>
      `
      )
      .join('');

    // External map deep links (Naver Map, KakaoMap, OpenStreetMap)
    const encodedQuery = encodeURIComponent(`${r.name} ${r.gu}`);
    document.getElementById('naverMapLink').href = `https://map.naver.com/p/search/${encodedQuery}`;
    document.getElementById('kakaoMapLink').href = `https://map.kakao.com/link/to/${encodeURIComponent(r.name)},${r.lat},${r.lng}`;
    document.getElementById('osmMapLink').href = `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=17/${r.lat}/${r.lng}`;

    renderReportHistory(r.reports || []);
    renderMapPins();
    logEvent('view_restaurant', { id: r.id, gu: r.gu, category: r.category });
  } catch (err) {
    showToast(err.message);
  }
}

function updateDetailFavButton(isFav, count) {
  const btn = document.getElementById('detailFavBtn');
  btn.classList.toggle('liked', isFav);
  btn.textContent = isFav ? `♥ 찜 완료 (${count})` : `♡ 찜하기 (${count})`;
}

function renderReportHistory(reports) {
  const ul = document.getElementById('reportHistory');
  const typeLabel = {
    price_change: '가격 변동',
    menu_error: '메뉴 오류',
    closed: '폐업/휴업',
    location_error: '위치 오차',
  };
  if (!reports.length) {
    ul.innerHTML = '';
    return;
  }
  ul.innerHTML = reports
    .map((rep) => {
      const priceStr = rep.reported_price ? ` (${fmtPrice(rep.reported_price)})` : '';
      return `<li><strong>[${typeLabel[rep.report_type] || rep.report_type}${priceStr}]</strong> ${escapeHtml(rep.detail)} · <em>${rep.status}</em></li>`;
    })
    .join('');
}

// Favorites Toggle (with login trigger per IA 3.5 -> 5.0 -> 4.1)
async function toggleFavorite(restaurantKey) {
  if (!state.user) {
    state.pendingFavoriteKey = restaurantKey;
    openModal('authModal');
    showToast('찜하기를 저장하려면 먼저 로그인해 주세요!');
    return;
  }

  try {
    const res = await apiFetch('/api/favorites/toggle', {
      method: 'POST',
      body: JSON.stringify({ restaurant_key: restaurantKey }),
    });
    showToast(res.is_favorite ? '내 즐겨찾기에 저장했어요 ♥' : '즐겨찾기에서 해제했어요');
    await refreshFavBadge();
    if (state.selectedRestaurant && state.selectedRestaurant.external_key === restaurantKey) {
      state.selectedRestaurant.is_favorite = res.is_favorite;
      state.selectedRestaurant.favorite_count = res.favorite_count;
      updateDetailFavButton(res.is_favorite, res.favorite_count);
    }
    await loadRestaurants(false);
  } catch (err) {
    showToast(err.message);
  }
}

async function refreshFavBadge() {
  const badge = document.getElementById('favCountBadge');
  if (!state.user) {
    badge.textContent = '0';
    return;
  }
  try {
    const data = await apiFetch('/api/favorites');
    badge.textContent = (data.items || []).length;
  } catch {
    badge.textContent = '0';
  }
}

// Auth UI & Actions (5.0 회원 관리)
function updateAuthUI() {
  const authBtn = document.getElementById('authBtn');
  const loggedOut = document.getElementById('loggedOutView');
  const loggedIn = document.getElementById('loggedInView');

  if (state.user) {
    authBtn.textContent = `👤 ${state.user.nickname}`;
    authBtn.classList.remove('btn-primary');
    authBtn.classList.add('btn-outline');
    loggedOut.classList.add('hidden');
    loggedIn.classList.remove('hidden');
    document.getElementById('authModalTitle').textContent = '👤 내 계정 관리';
    document.getElementById('profileNickname').textContent = state.user.nickname;
    document.getElementById('profileEmail').textContent = state.user.email;
    document.getElementById('profileUniv').textContent = state.user.university || '서울 대학생';
  } else {
    authBtn.textContent = '로그인 / 가입';
    authBtn.classList.add('btn-primary');
    authBtn.classList.remove('btn-outline');
    loggedOut.classList.remove('hidden');
    loggedIn.classList.add('hidden');
    document.getElementById('authModalTitle').textContent = '🎓 착한한끼 로그인';
  }
}

async function completeAuth(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('chakhan_token', data.token);
  updateAuthUI();
  closeModal('authModal');
  await refreshFavBadge();

  if (state.pendingFavoriteKey) {
    const key = state.pendingFavoriteKey;
    state.pendingFavoriteKey = null;
    await toggleFavorite(key);
  } else {
    await loadRestaurants(false);
  }
}

// Modal helpers
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Bootstrap Meta & Event Listeners
async function initApp() {
  initMap();

  try {
    const meta = await apiFetch('/api/meta');
    state.hubs = meta.hubs || [];
    state.gus = meta.gus || [];
    state.user = meta.user || null;

    // Populate campus hubs
    const hubContainer = document.getElementById('hubChips');
    hubContainer.innerHTML = state.hubs
      .map(
        (h) => `
        <button type="button" class="hub-chip ${h.id === state.activeHubId ? 'active' : ''}" data-hub="${h.id}">
          ${escapeHtml(h.name)}
        </button>
      `
      )
      .join('');

    // Populate Seoul 25 Gus dropdown
    const guSelect = document.getElementById('guSelect');
    state.gus.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.gu;
      opt.textContent = `${g.gu} (${g.count})`;
      guSelect.appendChild(opt);
    });

    // Update Google Sheet sync status text
    const syncInfo = meta.sync || {};
    const countStr = syncInfo.row_count ? `${Number(syncInfo.row_count).toLocaleString()}개소` : '연동됨';
    document.getElementById('syncStatusText').textContent = `구글시트 · ${countStr}`;

    updateAuthUI();
    await refreshFavBadge();
    await loadRestaurants(true);
  } catch (err) {
    showToast('초기 데이터 로딩 중 오류: ' + err.message);
  }

  bindEvents();
}

function bindEvents() {
  // Brand reset
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
    loadRestaurants(true);
  });

  document.getElementById('closeIntroBtn').addEventListener('click', () => {
    document.getElementById('introBanner').classList.add('hidden');
  });

  // Hub click
  document.getElementById('hubChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.hub-chip');
    if (!btn) return;
    const hub = state.hubs.find((h) => h.id === btn.dataset.hub);
    if (!hub) return;

    state.activeHubId = hub.id;
    state.isGpsActive = false;
    state.refLat = hub.lat;
    state.refLng = hub.lng;
    state.refLabel = hub.name;
    state.gu = '전체';
    state.favoritesOnly = false;
    if (hub.id === 'seoul_all') {
      state.radiusM = 0;
    } else if (state.radiusM === 0) {
      state.radiusM = 2000;
    }

    document.getElementById('guSelect').value = '전체';
    document.getElementById('favOnlyCheck').checked = false;
    document.getElementById('favModeBtn').classList.remove('active');
    document.getElementById('gpsBtn').classList.remove('active');

    document.querySelectorAll('.hub-chip').forEach((el) => el.classList.toggle('active', el === btn));
    syncFilterChipStates();
    logEvent('select_hub', { hub: hub.id, name: hub.name });
    loadRestaurants(true);
  });

  // Gu dropdown
  document.getElementById('guSelect').addEventListener('change', (e) => {
    state.gu = e.target.value;
    state.favoritesOnly = false;
    document.getElementById('favOnlyCheck').checked = false;
    document.getElementById('favModeBtn').classList.remove('active');
    if (state.gu !== '전체') {
      logEvent('select_gu', { gu: state.gu });
    }
    loadRestaurants(true);
  });

  // GPS button
  document.getElementById('gpsBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('브라우저가 위치 정보를 지원하지 않습니다.');
      return;
    }
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
        loadRestaurants(true);
        showToast('현재 위치 주변 가성비 식당을 찾았어요!');
      },
      () => {
        showToast('위치 권한이 거부되었거나 확인할 수 없습니다. 대학가 칩을 선택해 보세요.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  // Category chips
  document.getElementById('categoryChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.category = btn.dataset.cat;
    syncFilterChipStates();
    logEvent('filter_category', { category: state.category });
    loadRestaurants(false);
  });

  // Price chips
  document.getElementById('priceChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.maxPrice = btn.dataset.price;
    syncFilterChipStates();
    logEvent('filter_price', { max_price: state.maxPrice || 'all' });
    loadRestaurants(false);
  });

  // Radius chips
  document.getElementById('radiusChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.radiusM = Number(btn.dataset.radius);
    if (state.radiusM > 0) {
      state.gu = '전체';
      document.getElementById('guSelect').value = '전체';
    }
    syncFilterChipStates();
    loadRestaurants(true);
  });

  // Search input
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value.trim();
    clearSearchBtn.classList.toggle('hidden', !state.query);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (state.query) logEvent('search_query', { q: state.query });
      loadRestaurants(false);
    }, 240);
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    clearSearchBtn.classList.add('hidden');
    loadRestaurants(false);
  });

  // Sort select
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    loadRestaurants(false);
  });

  // Favorites Only Toggle (checkbox + header button)
  const toggleFavOnly = (forceVal = null) => {
    if (!state.user) {
      openModal('authModal');
      showToast('즐겨찾기 모아보기는 로그인 후 이용할 수 있어요!');
      document.getElementById('favOnlyCheck').checked = false;
      return;
    }
    state.favoritesOnly = forceVal !== null ? forceVal : !state.favoritesOnly;
    document.getElementById('favOnlyCheck').checked = state.favoritesOnly;
    document.getElementById('favModeBtn').classList.toggle('active', state.favoritesOnly);
    loadRestaurants(true);
  };

  document.getElementById('favOnlyCheck').addEventListener('change', (e) => {
    toggleFavOnly(e.target.checked);
  });
  document.getElementById('favModeBtn').addEventListener('click', () => {
    toggleFavOnly();
  });

  // Detail Drawer actions
  document.getElementById('closeDetailBtn').addEventListener('click', () => {
    document.getElementById('detailDrawer').classList.add('hidden');
    state.selectedId = null;
    renderList();
    renderMapPins();
  });

  document.getElementById('detailFavBtn').addEventListener('click', () => {
    if (state.selectedRestaurant) {
      toggleFavorite(state.selectedRestaurant.external_key);
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
    const text = `[착한한끼] ${r.name} (${r.category}) - ${r.main_menu} ${fmtPrice(r.main_price)} | ${r.address}`;
    navigator.clipboard?.writeText(text);
    showToast('식당 정보를 클립보드에 복사했어요!');
  });

  // Price / Error Report form
  document.getElementById('reportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedRestaurant) return;
    const report_type = document.getElementById('reportType').value;
    const reported_price = document.getElementById('reportPrice').value;
    const detail = document.getElementById('reportDetail').value.trim();

    try {
      await apiFetch('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          restaurant_key: state.selectedRestaurant.external_key,
          restaurant_name: state.selectedRestaurant.name,
          report_type,
          reported_price,
          detail,
        }),
      });
      document.getElementById('reportPrice').value = '';
      document.getElementById('reportDetail').value = '';
      showToast('소중한 제보가 반영을 위해 등록되었어요! 감사합니다.');
      openDetail(state.selectedRestaurant.id, false);
    } catch (err) {
      showToast(err.message);
    }
  });

  // Google Sheets Live Sync button
  document.getElementById('syncNowBtn').addEventListener('click', async () => {
    showToast('구글 스프레드시트에서 최신 데이터를 동기화하고 있어요...');
    try {
      const res = await apiFetch('/api/sync', { method: 'POST' });
      document.getElementById('syncStatusText').textContent = `구글시트 · ${res.count.toLocaleString()}개소`;
      showToast(`동기화 완료 (${res.source}, ${res.count}개소)`);
      await loadRestaurants(false);
    } catch (err) {
      showToast('동기화 실패: ' + err.message);
    }
  });

  // Auth Modal triggers
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
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('loginEmail').value,
          password: document.getElementById('loginPassword').value,
        }),
      });
      showToast(`환영합니다, ${data.user.nickname}님!`);
      await completeAuth(data);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('demoLoginBtn').addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'student@seoul.ac.kr', password: 'demo1234!' }),
      });
      showToast(`체험 계정(${data.user.nickname})으로 로그인했어요!`);
      await completeAuth(data);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('regEmail').value,
          password: document.getElementById('regPassword').value,
          nickname: document.getElementById('regNickname').value,
          university: document.getElementById('regUniv').value,
          agreed_terms: document.getElementById('regTerms').checked,
        }),
      });
      showToast('회원가입이 완료되었어요!');
      await completeAuth(data);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.token = '';
    state.user = null;
    state.favoritesOnly = false;
    localStorage.removeItem('chakhan_token');
    document.getElementById('favOnlyCheck').checked = false;
    document.getElementById('favModeBtn').classList.remove('active');
    updateAuthUI();
    closeModal('authModal');
    await refreshFavBadge();
    await loadRestaurants(false);
    showToast('로그아웃되었습니다.');
  });

  document.getElementById('viewMyFavMapBtn').addEventListener('click', () => {
    closeModal('authModal');
    toggleFavOnly(true);
  });

  // Metrics Modal
  document.getElementById('metricsBtn').addEventListener('click', async () => {
    openModal('metricsModal');
    const el = document.getElementById('metricsContent');
    el.innerHTML = '<p class="metric-full">데이터 불러오는 중...</p>';
    try {
      const s = await apiFetch('/api/analytics/summary');
      const meta = await apiFetch('/api/meta');
      const eventsHtml = (s.events_by_type || [])
        .map((ev) => `<code>${ev.event_type}: ${ev.cnt}회</code>`)
        .join(' · ');
      el.innerHTML = `
        <div class="metric-card"><span>서울 요식업 착한가격업소</span><strong>${s.restaurants.toLocaleString()}개소</strong></div>
        <div class="metric-card"><span>가입 대학생 / 사용자</span><strong>${s.users.toLocaleString()}명</strong></div>
        <div class="metric-card"><span>누적 즐겨찾기(찜)</span><strong>${s.favorites.toLocaleString()}건</strong></div>
        <div class="metric-card"><span>가격변동 · 오류 제보</span><strong>${s.reports.toLocaleString()}건</strong></div>
        <div class="metric-card metric-full">
          <span>Google Spreadsheet 백엔드 연동 상태</span>
          <p style="margin-top:6px;">출처: <strong>${escapeHtml(meta.sync?.last_source || 'snapshot')}</strong><br/>
          최근 동기화: ${escapeHtml(meta.sync?.last_sync_at || '-')}<br/>
          사용자 인터랙션 이벤트(총 ${s.events_total}건): ${eventsHtml || '기록 대기 중'}</p>
        </div>
      `;
    } catch (err) {
      el.innerHTML = `<p class="metric-full">${err.message}</p>`;
    }
  });

  // Mobile sidebar toggle
  document.getElementById('mobileListToggle').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    const open = sb.classList.toggle('mobile-open');
    document.getElementById('mobileListToggle').textContent = open ? '🗺️ 지도 보기' : '📋 목록 보기';
  });
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

window.addEventListener('DOMContentLoaded', initApp);
