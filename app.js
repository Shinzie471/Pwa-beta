const STORAGE_KEY = 'jdl-inventory-items';
const installButton = document.getElementById('installButton');
const inventoryBody = document.getElementById('inventoryBody');
const lowStockTotal = document.getElementById('lowStockTotal');
const totalItems = document.getElementById('totalItems');
const onlineStatus = document.getElementById('onlineStatus');
const lowStockFilter = document.getElementById('lowStockFilter');
const searchInput = document.getElementById('searchInput');
const form = document.getElementById('addItemForm');
const toast = document.getElementById('toast');
const storeName = document.getElementById('storeName');
const syncStatus = document.getElementById('syncStatus');
const authBtn = document.getElementById('authBtn');
let deferredPrompt;
let items = [];

// Remote sync state
let remoteEnabled = false;
let remoteDocRef = null;
let isApplyingRemote = false;
let remoteDebounceTimer = null;
let needsPush = false;
let swRegistration = null;
let remoteUnsub = null;
let lastRemoteUpdatedAt = 0;
const remoteBadge = document.getElementById('remoteBadge');
let isAdmin = false;
let viewerMode = false; // when true, no edits allowed
const ADMIN_USER = 'Jdl2026';
const ADMIN_PASSWORD = 'JDL@2026';
const ADMIN_KEY = 'jdl-admin';
const VIEWER_KEY = 'jdl-viewer-mode';
const adminLoginBtn = document.getElementById('adminLoginBtn');
const viewToggleBtn = document.getElementById('viewToggleBtn');

const defaultItems = [
  { id: crypto.randomUUID(), name: 'Blue Denim Jeans', quantity: 4, threshold: 5 },
  { id: crypto.randomUUID(), name: 'Cotton T-Shirts', quantity: 18, threshold: 10 },
  { id: crypto.randomUUID(), name: 'Leather Belts', quantity: 2, threshold: 5 },
  { id: crypto.randomUUID(), name: 'Sneaker Stock', quantity: 22, threshold: 15 }
];
const configWarning = document.getElementById('configWarning');

function updateAuthButtonVisibility() {
  const loggedIn = !!localStorage.getItem('jdl-user') || localStorage.getItem('jdl-admin') === 'true';
  if (authBtn) authBtn.style.display = loggedIn ? 'none' : 'inline-flex';
}

const formatCount = (value) => value.toLocaleString();
const formatDate = (ts) => {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch (e) { return ''; }
};

const saveItems = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  // mark that we have local changes to push
  needsPush = true;
};

const pushRemoteDebounced = () => {
  if (!remoteEnabled || !remoteDocRef || isApplyingRemote) return;
  if (remoteDebounceTimer) clearTimeout(remoteDebounceTimer);
  remoteDebounceTimer = setTimeout(async () => {
    try {
      await remoteDocRef.set({ items, updatedAt: Date.now() });
      console.log('Pushed inventory to remote');
      needsPush = false;
    } catch (err) {
      console.warn('Failed pushing to remote', err);
      showToast('Cloud sync failed');
      needsPush = true;
    }
  }, 700);
};

async function attemptFlushRemote() {
  if (!remoteEnabled || !remoteDocRef) return;
  if (!navigator.onLine) return;
  if (!needsPush) return;
  try {
    await remoteDocRef.set({ items, updatedAt: Date.now() });
    needsPush = false;
    console.log('Flushed local changes to remote');
  } catch (err) {
    console.warn('Flush failed', err);
    needsPush = true;
  }
}

function showRemoteBadge() {
  if (!remoteBadge) return;
  remoteBadge.style.display = 'inline-block';
}

function clearRemoteBadge() {
  if (!remoteBadge) return;
  remoteBadge.style.display = 'none';
}

function initAuth(db) {
  const authBtn = document.getElementById('authBtn');
  const userDisplay = document.getElementById('userDisplay');

  const startListening = (user) => {
    if (!user) {
      // signed out
      userDisplay.textContent = '';
      syncStatus.textContent = 'Sync: local';
      remoteEnabled = false;
      if (remoteUnsub) { remoteUnsub(); remoteUnsub = null; }
      remoteDocRef = null;
      return;
    }
    userDisplay.textContent = user.email || user.uid;
    syncStatus.textContent = 'Sync: cloud';
    // store signed-in state locally so device remembers the login
    try {
      localStorage.setItem('jdl-user', JSON.stringify({ type: 'google', email: user.email || user.uid }));
      localStorage.setItem('jdl-uid', user.uid);
    } catch (e) {}
    // use per-user document path
    const uid = user.uid;
    remoteDocRef = db.collection('inventories').doc(uid);
    remoteEnabled = true;

    // detach old listener
    if (remoteUnsub) { remoteUnsub(); remoteUnsub = null; }

    // Subscribe to remote document changes
    remoteUnsub = remoteDocRef.onSnapshot((snap) => {
      if (!snap.exists) {
        // create initial doc from local
        remoteDocRef.set({ items, updatedAt: Date.now() }).catch(() => {});
        return;
      }
      const data = snap.data() || {};
      const remoteItems = data.items || [];
      const remoteUpdated = data.updatedAt || 0;
      // If remote is newer than last seen and not caused by our push, show badge
      if (remoteUpdated && remoteUpdated > lastRemoteUpdatedAt) {
        // detect whether remote changes will modify local
        const localMap = new Map(items.map(i => [i.id, i]));
        const remoteMap = new Map(remoteItems.map(i => [i.id, i]));
        let willChange = false;
        const ids = new Set([...localMap.keys(), ...remoteMap.keys()]);
        for (const id of ids) {
          const l = localMap.get(id);
          const r = remoteMap.get(id);
          if (!l && r) { willChange = true; break; }
          if (l && !r) { willChange = true; break; }
          if (l && r) {
            const lts = l.updatedAt || 0;
            const rts = r.updatedAt || 0;
            if (rts > lts) { willChange = true; break; }
          }
        }
        if (willChange) showRemoteBadge();
      }
      lastRemoteUpdatedAt = remoteUpdated;

      // Merge remote and local (last-writer-wins)
      isApplyingRemote = true;
      const localMap = new Map(items.map(i => [i.id, i]));
      const remoteMap = new Map(remoteItems.map(i => [i.id, i]));
      const mergedMap = new Map();
      const ids = new Set([...localMap.keys(), ...remoteMap.keys()]);
      for (const id of ids) {
        const local = localMap.get(id);
        const remote = remoteMap.get(id);
        if (local && remote) {
          const lts = local.updatedAt || 0;
          const rts = remote.updatedAt || 0;
          if (rts > lts) mergedMap.set(id, remote);
          else { mergedMap.set(id, local); needsPush = true; }
        } else if (remote && !local) mergedMap.set(id, remote);
        else if (local && !remote) { mergedMap.set(id, local); needsPush = true; }
      }
      items = Array.from(mergedMap.values());
      saveItems();
      renderInventory();
      isApplyingRemote = false;
      // attempt to flush local changes
      attemptFlushRemote();
    }, (err) => {
      console.warn('Remote listener error', err);
      showToast('Cloud sync listener failed');
    });
  };

  // Wire auth button: toggle sign-in/out with Google popup (compat)
  authBtn.addEventListener('click', async () => {
    const user = firebase.auth().currentUser;
    if (!user) {
      const provider = new firebase.auth.GoogleAuthProvider();
      try {
        await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        await firebase.auth().signInWithRedirect(provider);
      } catch (err) {
        console.warn('Sign-in failed', err);
        showToast('Sign-in failed');
      }
    } else {
      await firebase.auth().signOut();
      localStorage.removeItem('jdl-user');
      localStorage.removeItem('jdl-uid');
      clearRemoteBadge();
      userDisplay.textContent = '';
      updateAuthButtonVisibility();
    }
  });

  // listen for auth state changes
  firebase.auth().onAuthStateChanged((user) => {
    startListening(user);
    // update auth button label and visibility
    const u = firebase.auth().currentUser;
    authBtn.textContent = u ? 'Sign out' : 'Sign in';
    updateAuthButtonVisibility();
  });
}

function subscribeRemoteDoc(docRef, label) {
  if (!docRef) return;
  if (remoteUnsub) { remoteUnsub(); remoteUnsub = null; }
  remoteUnsub = docRef.onSnapshot((snap) => {
    if (!snap.exists) {
      docRef.set({ items, updatedAt: Date.now() }).catch(() => {});
      return;
    }
    const data = snap.data() || {};
    const remoteItems = data.items || [];
    const remoteUpdated = data.updatedAt || 0;
    if (remoteUpdated && remoteUpdated > lastRemoteUpdatedAt) {
      const localMap = new Map(items.map(i => [i.id, i]));
      const remoteMap = new Map(remoteItems.map(i => [i.id, i]));
      let willChange = false;
      const ids = new Set([...localMap.keys(), ...remoteMap.keys()]);
      for (const id of ids) {
        const l = localMap.get(id);
        const r = remoteMap.get(id);
        if (!l && r) { willChange = true; break; }
        if (l && !r) { willChange = true; break; }
        if (l && r) {
          const lts = l.updatedAt || 0;
          const rts = r.updatedAt || 0;
          if (rts > lts) { willChange = true; break; }
        }
      }
      if (willChange) showRemoteBadge();
    }
    lastRemoteUpdatedAt = remoteUpdated;

    isApplyingRemote = true;
    const localMap = new Map(items.map(i => [i.id, i]));
    const remoteMap = new Map(remoteItems.map(i => [i.id, i]));
    const mergedMap = new Map();
    const ids = new Set([...localMap.keys(), ...remoteMap.keys()]);
    for (const id of ids) {
      const local = localMap.get(id);
      const remote = remoteMap.get(id);
      if (local && remote) {
        const lts = local.updatedAt || 0;
        const rts = remote.updatedAt || 0;
        if (rts > lts) mergedMap.set(id, remote);
        else { mergedMap.set(id, local); needsPush = true; }
      } else if (remote && !local) mergedMap.set(id, remote);
      else if (local && !remote) { mergedMap.set(id, local); needsPush = true; }
    }
    items = Array.from(mergedMap.values());
    saveItems();
    renderInventory();
    isApplyingRemote = false;
    attemptFlushRemote();
  }, (err) => {
    console.warn('Remote listener error', err);
    showToast('Cloud sync listener failed');
  });
}

function loadAdminState() {
  try {
    isAdmin = localStorage.getItem(ADMIN_KEY) === 'true';
    viewerMode = localStorage.getItem(VIEWER_KEY) === 'true';
  } catch (e) { isAdmin = false; viewerMode = false; }
  // reflect UI
  if (isAdmin) {
    adminLoginBtn.textContent = 'Admin sign out';
    viewToggleBtn.style.display = 'inline-flex';
    viewToggleBtn.textContent = viewerMode ? 'View only: On' : 'View only: Off';
  } else {
    adminLoginBtn.textContent = 'Admin login';
    viewToggleBtn.style.display = 'none';
  }
  applyViewMode();
}

function saveAdminState() {
  try {
    localStorage.setItem(ADMIN_KEY, isAdmin ? 'true' : 'false');
    localStorage.setItem(VIEWER_KEY, viewerMode ? 'true' : 'false');
  } catch (e) {}
}

function setAdminSignedIn(signedIn) {
  isAdmin = !!signedIn;
  if (isAdmin) {
    adminLoginBtn.textContent = 'Admin sign out';
    viewToggleBtn.style.display = 'inline-flex';
  } else {
    adminLoginBtn.textContent = 'Admin login';
    viewToggleBtn.style.display = 'none';
    viewerMode = false;
  }
  saveAdminState();
  applyViewMode();
}

function applyViewMode() {
  // disable the add form and buttons when viewerMode true
  const inputs = form.querySelectorAll('input,button');
  for (const el of inputs) {
    // keep the export/import/search buttons enabled
    if (el.id === 'exportCsv' || el.id === 'importBtn' || el.id === 'searchInput') continue;
    if (el === adminLoginBtn || el === viewToggleBtn || el === document.getElementById('authBtn')) continue;
    el.disabled = !!viewerMode;
  }
  // re-render inventory so action buttons hide
  renderInventory();
}

// Admin login button handling (local fallback admin)
if (adminLoginBtn) {
  adminLoginBtn.addEventListener('click', async () => {
    if (!isAdmin) {
      const user = prompt('Admin username:');
      if (user === null) return;
      const pass = prompt('Admin password:');
      if (pass === null) return;
      if (String(user).trim() === ADMIN_USER && String(pass) === ADMIN_PASSWORD) {
        setAdminSignedIn(true);
        const userDisplay = document.getElementById('userDisplay');
        if (userDisplay) userDisplay.textContent = 'Admin(' + ADMIN_USER + ')';
        showToast('Admin signed in');
      } else {
        showToast('Invalid admin credentials');
      }
    } else {
      setAdminSignedIn(false);
      const userDisplay = document.getElementById('userDisplay');
      if (userDisplay) userDisplay.textContent = '';
      showToast('Admin signed out');
    }
  });
}

if (viewToggleBtn) {
  viewToggleBtn.addEventListener('click', () => {
    // only admin may toggle view mode
    if (!isAdmin) { showToast('Admin required to change view mode'); return; }
    viewerMode = !viewerMode;
    viewToggleBtn.textContent = viewerMode ? 'View only: On' : 'View only: Off';
    saveAdminState();
    applyViewMode();
    showToast('View mode ' + (viewerMode ? 'enabled' : 'disabled'));
  });
}

const loadItems = () => {
  const data = localStorage.getItem(STORAGE_KEY);
  if (data) {
    try {
      items = JSON.parse(data);
      return;
    } catch (error) {
      console.warn('Inventory load failed, resetting inventory.', error);
    }
  }
  items = [...defaultItems];
  saveItems();
};

// Global low-stock rule: quantity below 10 considered low stock
const LOW_STOCK_GLOBAL = 10;
const isLowStock = (item) => (Number(item.quantity) < LOW_STOCK_GLOBAL);

const renderInventory = () => {
  const searchText = searchInput.value.trim().toLowerCase();
  const showOnlyLowStock = lowStockFilter.checked;
  const filteredItems = items.filter((item) => {
    const matchesSearch = item.name.toLowerCase().includes(searchText);
    return matchesSearch && (!showOnlyLowStock || isLowStock(item));
  });

  inventoryBody.innerHTML = filteredItems.map((item) => {
    const lowClass = isLowStock(item) ? 'low-stock' : '';
    return `
      <tr>
        <td>${item.name}</td>
        <td>${formatCount(item.quantity)}</td>
        <td>${formatCount(item.threshold)}</td>
        <td>${formatDate(item.updatedAt)}</td>
        <td class="${lowClass}">${isLowStock(item) ? 'Low stock' : 'OK'}</td>
        <td>
          ${viewerMode ? '<span style="color:#666;font-style:italic;">View only</span>' : `
          <div class="action-group">
            <button type="button" data-action="decrease" data-id="${item.id}">-</button>
            <button type="button" data-action="increase" data-id="${item.id}">+</button>
            <button type="button" data-action="edit" data-id="${item.id}">Edit</button>
            <button type="button" data-action="remove" data-id="${item.id}">Remove</button>
          </div>
          `}
        </td>
      </tr>
    `;
  }).join('');

  totalItems.textContent = formatCount(items.length);
  lowStockTotal.textContent = formatCount(items.filter(isLowStock).length);
};

const showToast = (message) => {
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2400);
};

const updateItem = (id, modifier) => {
  items = items.map((item) => {
    if (item.id !== id) return item;
    const quantity = Math.max(0, item.quantity + modifier);
    const updated = { ...item, quantity, updatedAt: Date.now() };
    logChange(modifier > 0 ? 'increase' : 'decrease', updated);
    return updated;
  });
  saveItems();
  renderInventory();
  pushRemoteDebounced();
};

const removeItem = (id) => {
  const removed = items.find(i => i.id === id);
  items = items.filter((item) => item.id !== id);
  saveItems();
  renderInventory();
  showToast('Inventory item removed');
  if (removed) logChange('remove', removed);
  pushRemoteDebounced();
};

inventoryBody.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'increase') updateItem(id, 1);
  if (action === 'decrease') updateItem(id, -1);
  if (action === 'remove') removeItem(id);
  if (action === 'edit') editItem(id);
});

// Edit item inline via prompt dialogs (simple, cross-platform)
function editItem(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  const name = prompt('Item name:', item.name);
  if (name === null) return; // cancelled
  const quantityStr = prompt('Quantity:', String(item.quantity));
  if (quantityStr === null) return;
  const thresholdStr = prompt('Low stock threshold:', String(item.threshold));
  if (thresholdStr === null) return;
  const notes = prompt('Notes (optional):', item.notes || '');
  if (notes === null) return;
  const quantity = Number(quantityStr) || 0;
  const threshold = Number(thresholdStr) || 0;
  items = items.map(i => i.id === id ? { ...i, name: name.trim(), quantity, threshold, notes, updatedAt: Date.now() } : i);
  saveItems();
  renderInventory();
  pushRemoteDebounced();
  logChange('edit', items.find(i => i.id === id));
  showToast('Item updated');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = form.itemName.value.trim();
  const quantity = Number(form.itemQuantity.value);
  const threshold = Number(form.itemThreshold.value);

  if (!name || quantity < 0 || threshold < 0) {
    showToast('Provide a valid item name, quantity, and threshold.');
    return;
  }

  items.unshift({
    id: crypto.randomUUID(),
    name,
    quantity,
    threshold,
    notes: '',
    updatedAt: Date.now()
  });

  saveItems();
  form.reset();
  renderInventory();
  showToast('Item added to inventory');
  pushRemoteDebounced();
  logChange('add', items[0]);
});

lowStockFilter.addEventListener('change', renderInventory);
searchInput.addEventListener('input', renderInventory);

window.addEventListener('online', () => {
  onlineStatus.textContent = 'Online';
  onlineStatus.classList.remove('offline');
  onlineStatus.classList.add('online');
  showToast('Back online');
  // try to sync pending changes when we come back online
  attemptFlushRemote();
});

window.addEventListener('offline', () => {
  onlineStatus.textContent = 'Offline';
  onlineStatus.classList.remove('online');
  onlineStatus.classList.add('offline');
  showToast('App is now offline');
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  installButton.style.display = 'inline-flex';
});

installButton.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const result = await deferredPrompt.userChoice;
  if (result.outcome === 'accepted') {
    showToast('Install prompt accepted');
  } else {
    showToast('Install prompt dismissed');
  }
  deferredPrompt = null;
  installButton.style.display = 'none';
});

// Open buy list page
const buyListBtn = document.getElementById('buyListBtn');
if (buyListBtn) buyListBtn.addEventListener('click', () => {
  window.location.href = 'buy.html';
});

const init = async () => {
  storeName.textContent = 'Retail Store Inventory';
  onlineStatus.textContent = navigator.onLine ? 'Online' : 'Offline';
  onlineStatus.classList.add(navigator.onLine ? 'online' : 'offline');
  loadItems();
  loadAdminState();
  updateAuthButtonVisibility();
  await initSync();
  if (!await ensureSignedInOrRedirect()) return;
  renderInventory();
  renderChangeLog();
  bindCsvHandlers();
  registerServiceWorker();
};

// run pre-init check is handled after Firebase config/initialization

// --- Auth gating ---------------------------------------------------------
async function ensureSignedInOrRedirect() {
  try {
    const storedUser = localStorage.getItem('jdl-user');
    const admin = localStorage.getItem('jdl-admin') === 'true';
    if (storedUser || admin) return true;

    // If Firebase is configured, wait for auth state persistence to resolve.
    if (window.firebase && firebase.apps && firebase.apps.length > 0) {
      const auth = firebase.auth();
      const currentUser = auth.currentUser;
      if (currentUser) {
        localStorage.setItem('jdl-user', JSON.stringify({ type: 'google', email: currentUser.email || currentUser.uid }));
        localStorage.setItem('jdl-uid', currentUser.uid);
        updateAuthButtonVisibility();
        return true;
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          window.location.href = 'login.html';
          resolve(false);
        }, 1500);
        const unsubscribe = auth.onAuthStateChanged((user) => {
          if (user) {
            clearTimeout(timeout);
            unsubscribe();
            localStorage.setItem('jdl-user', JSON.stringify({ type: 'google', email: user.email || user.uid }));
            localStorage.setItem('jdl-uid', user.uid);
            updateAuthButtonVisibility();
            resolve(true);
          }
        });
      });
    }

    window.location.href = 'login.html';
    return false;
  } catch (e) {
    window.location.href = 'login.html';
    return false;
  }
}

// --- Sync implementation -------------------------------------------------
function getStoredUserMarker() {
  try {
    return JSON.parse(localStorage.getItem('jdl-user') || 'null');
  } catch (e) {
    return null;
  }
}

function isFirebaseConfigValid(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const placeholders = ['YOUR_API_KEY', 'YOUR_PROJECT', 'SENDER_ID', 'APP_ID'];
  return ['apiKey','authDomain','projectId','storageBucket','messagingSenderId','appId'].every((key) => {
    const value = cfg[key];
    return typeof value === 'string' && value.trim() && !placeholders.some((ph) => value.includes(ph));
  });
}

function showConfigWarning() {
  if (!configWarning) return;
  configWarning.style.display = 'block';
}

function hideConfigWarning() {
  if (!configWarning) return;
  configWarning.style.display = 'none';
}

async function initSync() {
  // Try loading a config file `sync-config.json` next to the app.
  try {
    const resp = await fetch('sync-config.json', { cache: 'no-store' });
    if (!resp.ok) {
      syncStatus && (syncStatus.textContent = 'Sync: local');
      showConfigWarning();
      return;
    }
    const cfg = await resp.json();
    if (!cfg || cfg.provider !== 'firebase' || !cfg.firebase || !isFirebaseConfigValid(cfg.firebase)) {
      syncStatus && (syncStatus.textContent = 'Sync: local');
      showConfigWarning();
      return;
    }

    hideConfigWarning();

    // Initialize Firebase (compat) and Firestore, then init auth or admin sync
    try {
      if (!isFirebaseConfigValid(cfg.firebase)) {
        throw new Error('Invalid Firebase config');
      }
      firebase.initializeApp(cfg.firebase);
      const db = firebase.firestore();
      const storedUser = getStoredUserMarker();
      if (storedUser && storedUser.type === 'admin') {
        // Admin login uses a shared admin document if Firebase is configured.
        remoteDocRef = db.collection('inventories').doc('admin');
        remoteEnabled = true;
        syncStatus && (syncStatus.textContent = 'Sync: admin');
        subscribeRemoteDoc(remoteDocRef, 'Admin');
      } else {
        initAuth(db);
        syncStatus && (syncStatus.textContent = 'Sync: auth');
      }
    } catch (err) {
      console.warn('Firebase init failed', err);
      syncStatus && (syncStatus.textContent = 'Sync: local');
      remoteEnabled = false;
    }
  } catch (err) {
    // No config file or network error - remain local-only
    syncStatus && (syncStatus.textContent = 'Sync: local');
    console.log('No sync-config.json found, running local-only');
  }
}

// --- Service Worker update helpers -------------------------------------
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Register (safe to call even if index.html already registered)
    swRegistration = await navigator.serviceWorker.register('sw.js');

    // If there's a waiting worker, show update button
    if (swRegistration.waiting) showUpdateAvailable();

    // Listen for new service worker being installed
    swRegistration.addEventListener('updatefound', () => {
      const installing = swRegistration.installing;
      installing && installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') {
          if (navigator.serviceWorker.controller) showUpdateAvailable();
        }
      });
    });

    // When the controlling service worker changes, reload to apply
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      showToast('Update installed — reloading');
      window.location.reload();
    });

    // Wire update button
    const updateBtn = document.getElementById('updateButton');
    if (updateBtn) updateBtn.addEventListener('click', onUpdateClicked);
  } catch (err) {
    console.warn('ServiceWorker registration failed:', err);
  }
}

function showUpdateAvailable() {
  const btn = document.getElementById('updateButton');
  if (btn) btn.style.display = 'inline-flex';
}

async function onUpdateClicked() {
  const btn = document.getElementById('updateButton');
  if (btn) { btn.disabled = true; }
  try {
    const reg = swRegistration || await navigator.serviceWorker.getRegistration();
    if (!reg) { showToast('No service worker available'); if (btn) btn.disabled=false; return; }
    // Ask SW to check for updates
    await reg.update();
    // If there's a waiting worker, message it to skip waiting and become active
    if (reg.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      showToast('Applying update...');
    } else {
      showToast('No update available');
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    console.warn('Update failed', err);
    showToast('Update failed');
    if (btn) btn.disabled = false;
  }
}

// --- Change log and CSV -----------------------------------------------
const LOG_KEY = 'jdl-inventory-log';
const loadLog = () => {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
};
const saveLog = (log) => localStorage.setItem(LOG_KEY, JSON.stringify(log));
function logChange(action, item) {
  try {
    const log = loadLog();
    log.unshift({ ts: Date.now(), action, id: item.id, name: item.name, qty: item.quantity });
    saveLog(log.slice(0, 200));
    renderChangeLog();
  } catch (e) { /* ignore */ }
}
function renderChangeLog() {
  const container = document.getElementById('changeLog');
  if (!container) return;
  const log = loadLog();
  container.innerHTML = log.slice(0,50).map(entry => `<div style="padding:6px 0;border-bottom:1px solid #eee;font-size:0.95rem;"><strong>${entry.action}</strong> — ${entry.name} <span style="color:#666;">(${entry.qty})</span><div style="color:#888;font-size:0.85rem;">${new Date(entry.ts).toLocaleString()}</div></div>`).join('');
}

function exportCsv() {
  const rows = [['name','quantity','threshold','notes','updatedAt']];
  for (const it of items) rows.push([it.name, it.quantity, it.threshold, it.notes || '', it.updatedAt || '']);
  const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'inventory.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function bindCsvHandlers() {
  const exportBtn = document.getElementById('exportCsv');
  const importBtn = document.getElementById('importBtn');
  const importFile = document.getElementById('importFile');
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);
  if (importBtn && importFile) importBtn.addEventListener('click', () => importFile.click());
  if (importFile) importFile.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const text = await f.text();
    parseAndImportCsv(text);
    importFile.value = '';
  });
}

function parseAndImportCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;
  const headers = lines[0].split(/,|\t/).map(h => h.replace(/"/g,'').trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);
  const newItems = [];
  for (let i=1;i<lines.length;i++){
    const cols = lines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c=>c.trim().replace(/^"|"$/g,''));
    if (!cols.length) continue;
    const name = cols[idx('name')] || cols[0];
    const quantity = Number(cols[idx('quantity')]||cols[1]||0);
    const threshold = Number(cols[idx('threshold')]||cols[2]||0);
    const notes = cols[idx('notes')] || '';
    newItems.push({ id: crypto.randomUUID(), name: name.trim(), quantity, threshold, notes, updatedAt: Date.now() });
  }
  if (newItems.length) {
    items = newItems.concat(items);
    saveItems(); renderInventory(); pushRemoteDebounced();
    for (const it of newItems) logChange('import', it);
    showToast('Imported ' + newItems.length + ' items');
  }
}

init();
