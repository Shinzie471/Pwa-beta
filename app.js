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
let deferredPrompt;
let items = [];

// Remote sync state
let remoteEnabled = false;
let remoteDocRef = null;
let isApplyingRemote = false;
let remoteDebounceTimer = null;

const defaultItems = [
  { id: crypto.randomUUID(), name: 'Blue Denim Jeans', quantity: 4, threshold: 5 },
  { id: crypto.randomUUID(), name: 'Cotton T-Shirts', quantity: 18, threshold: 10 },
  { id: crypto.randomUUID(), name: 'Leather Belts', quantity: 2, threshold: 5 },
  { id: crypto.randomUUID(), name: 'Sneaker Stock', quantity: 22, threshold: 15 }
];

const formatCount = (value) => value.toLocaleString();

const saveItems = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
};

const pushRemoteDebounced = () => {
  if (!remoteEnabled || !remoteDocRef || isApplyingRemote) return;
  if (remoteDebounceTimer) clearTimeout(remoteDebounceTimer);
  remoteDebounceTimer = setTimeout(async () => {
    try {
      await remoteDocRef.set({ items, updatedAt: Date.now() });
      console.log('Pushed inventory to remote');
    } catch (err) {
      console.warn('Failed pushing to remote', err);
      showToast('Cloud sync failed');
    }
  }, 700);
};

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

const isLowStock = (item) => item.quantity <= item.threshold;

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
        <td class="${lowClass}">${isLowStock(item) ? 'Low stock' : 'OK'}</td>
        <td>
          <div class="action-group">
            <button type="button" data-action="decrease" data-id="${item.id}">-</button>
            <button type="button" data-action="increase" data-id="${item.id}">+</button>
            <button type="button" data-action="remove" data-id="${item.id}">Remove</button>
          </div>
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
    return { ...item, quantity };
  });
  saveItems();
  renderInventory();
  pushRemoteDebounced();
};

const removeItem = (id) => {
  items = items.filter((item) => item.id !== id);
  saveItems();
  renderInventory();
  showToast('Inventory item removed');
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
});

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
    threshold
  });

  saveItems();
  form.reset();
  renderInventory();
  showToast('Item added to inventory');
  pushRemoteDebounced();
});

lowStockFilter.addEventListener('change', renderInventory);
searchInput.addEventListener('input', renderInventory);

window.addEventListener('online', () => {
  onlineStatus.textContent = 'Online';
  onlineStatus.classList.remove('offline');
  onlineStatus.classList.add('online');
  showToast('Back online');
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

const init = () => {
  storeName.textContent = 'Retail Store Inventory';
  onlineStatus.textContent = navigator.onLine ? 'Online' : 'Offline';
  onlineStatus.classList.add(navigator.onLine ? 'online' : 'offline');
  loadItems();
  renderInventory();
  initSync();
};
 
init();

// --- Sync implementation -------------------------------------------------
async function initSync() {
  // Try loading a config file `sync-config.json` next to the app.
  try {
    const resp = await fetch('sync-config.json', { cache: 'no-store' });
    if (!resp.ok) {
      syncStatus && (syncStatus.textContent = 'Sync: local');
      return;
    }
    const cfg = await resp.json();
    if (!cfg || cfg.provider !== 'firebase' || !cfg.firebase) {
      syncStatus && (syncStatus.textContent = 'Sync: local');
      return;
    }

    // Initialize Firebase (compat) and Firestore
    try {
      firebase.initializeApp(cfg.firebase);
      const db = firebase.firestore();
      remoteDocRef = db.collection('inventories').doc('default');
      remoteEnabled = true;
      syncStatus && (syncStatus.textContent = 'Sync: cloud');

      // Listen for remote updates
      remoteDocRef.onSnapshot((snap) => {
        if (!snap.exists) return;
        const data = snap.data();
        if (!data) return;
        const remoteItems = data.items || [];
        // Avoid clobbering local edits while applying remote
        isApplyingRemote = true;
        items = remoteItems.map((it) => ({ ...it }));
        saveItems();
        renderInventory();
        isApplyingRemote = false;
      }, (err) => {
        console.warn('Remote listener error', err);
        showToast('Cloud sync listener failed');
      });

      // Ensure remote has an initial document
      const current = await remoteDocRef.get();
      if (!current.exists) {
        await remoteDocRef.set({ items, updatedAt: Date.now() });
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

init();
