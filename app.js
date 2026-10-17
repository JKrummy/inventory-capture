/* JK Personal Inventory System - phone capture.
   Phase 2: photos and a draft record go straight to Dropbox.
   The Mac side turns inbox drafts into real INV- numbered items. */

const VERSION = '1.0.3';

const LS = {
  appKey:  'jkinv.appKey',
  refresh: 'jkinv.refreshToken',
  access:  'jkinv.accessToken',
  expires: 'jkinv.accessExpires',
  verifier:'jkinv.pkceVerifier',
  root:    'jkinv.root',
  account: 'jkinv.accountName',
  filed:   'jkinv.filedCount',
  owners:  'jkinv.knownOwners',
  places:  'jkinv.knownLocations'
};

/* Same list the Mac database is seeded with. 'full' means a serial is wanted. */
const CATEGORIES = [
  ['Firearms', 'full'],
  ['Optics and gun accessories', 'full'],
  ['Ammunition', 'full'],
  ['Jewelry and watches', 'full'],
  ['Vehicles and trailers', 'full'],
  ['Electronics', 'light'],
  ['Tools and equipment', 'light'],
  ['Furniture', 'light'],
  ['Everything else', 'light']
];

const MAX_EDGE = 2048;      // long edge in pixels after downscaling
const JPEG_QUALITY = 0.85;

const $ = (id) => document.getElementById(id);

/* The item currently being worked on. One bucket, open until Save or Discard. */
let bucket = null;

/* ============================================================ storage */

const DB_NAME = 'jkinv';
const STORE = 'drafts';
let idb = null;

function openIDB() {
  if (idb) return Promise.resolve(idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { idb = req.result; resolve(idb); };
    req.onerror = () => reject(req.error);
  });
}

function idbRun(mode, fn) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => reject(tx.error);
  }));
}

const putDraft  = (d)  => idbRun('readwrite', (s) => s.put(d));
const killDraft = (id) => idbRun('readwrite', (s) => s.delete(id));
const allDrafts = ()   => idbRun('readonly',  (s) => s.getAll());

/* ============================================================ helpers */

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

/* Dropbox-API-Arg travels in an HTTP header, so it has to be plain ASCII. */
function asciiJSON(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function draftId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
                `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const tail = Math.random().toString(36).slice(2, 6);
  return `draft-${stamp}-${tail}`;
}

function say(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function root() {
  const r = (localStorage.getItem(LS.root) || '/Inventory').trim();
  return ('/' + r.replace(/^\/+|\/+$/g, '')).replace(/\/+/g, '/');
}

function remember(key, value) {
  if (!value) return;
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  if (!list.includes(value)) {
    list.push(value);
    localStorage.setItem(key, JSON.stringify(list.slice(-40)));
  }
}

function fillDatalist(elId, key, extras) {
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  const all = Array.from(new Set((extras || []).concat(list)));
  $(elId).innerHTML = all.map((v) =>
    `<option value="${v.replace(/"/g, '&quot;')}">`).join('');
}

/* ============================================================ dropbox auth */

function isConnected() {
  return !!localStorage.getItem(LS.refresh);
}

async function accessToken() {
  const now = Date.now();
  const token = localStorage.getItem(LS.access);
  const expires = Number(localStorage.getItem(LS.expires) || 0);
  if (token && now < expires - 120000) return token;

  const refresh = localStorage.getItem(LS.refresh);
  const appKey = localStorage.getItem(LS.appKey);
  if (!refresh || !appKey) throw new Error('Not connected to Dropbox yet.');

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: appKey
    })
  });
  if (!res.ok) {
    throw new Error('Dropbox would not refresh the connection. ' +
                    'Open Settings and connect again.');
  }
  const data = await res.json();
  localStorage.setItem(LS.access, data.access_token);
  localStorage.setItem(LS.expires, String(Date.now() + (data.expires_in || 14400) * 1000));
  return data.access_token;
}

async function dbxRPC(endpoint, body) {
  const token = await accessToken();
  const res = await fetch('https://api.dropboxapi.com/2/' + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: body === null ? 'null' : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dropbox said: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function dbxUpload(path, blob) {
  const token = await accessToken();
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': asciiJSON({
        path: path,
        mode: 'add',
        autorename: true,
        mute: true,
        strict_conflict: false
      })
    },
    body: blob
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/* ============================================================ images */

/* iPhone photos are 4000px and several megabytes. 2048px is plenty for an
   insurance claim and uploads in a fraction of the time. */
function shrinkImage(file) {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) return resolve(file);

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      if (scale === 1 && file.size < 1_500_000) {
        URL.revokeObjectURL(url);
        return resolve(file);
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => resolve(blob || file),
        'image/jpeg',
        JPEG_QUALITY
      );
    };

    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/* ============================================================ screens */

const SCREENS = ['connect', 'home', 'item', 'queue', 'settings'];

function show(name) {
  SCREENS.forEach((s) => { $('screen-' + s).hidden = (s !== name); });
  $('btn-settings').hidden = (name === 'settings' || name === 'connect');
  window.scrollTo(0, 0);
}

/* ============================================================ the bucket */

function newBucket() {
  bucket = {
    id: draftId(),
    createdAt: new Date().toISOString(),
    photos: [],
    receipts: [],
    /* These only ever count up. Numbering by array length would hand out a
       name twice once a photo is removed, and two files would collide. */
    seq: { photos: 0, receipts: 0 }
  };

  ['f-name', 'f-make', 'f-model', 'f-serial', 'f-year', 'f-location',
   'f-attached', 'f-price', 'f-pdate', 'f-seller', 'f-condition',
   'f-notes'].forEach((id) => { $(id).value = ''; });
  $('f-quantity').value = '1';
  $('f-owner').value = 'Me';
  $('f-price-est').checked = false;
  $('f-category').value = 'Everything else';

  renderThumbs();
  updateNag();
  say($('item-status'), '', '');
  $('item-bucket-note').textContent =
    'Bucket ' + bucket.id + ' is open. Every photo you take now belongs to this one ' +
    'item, until you tap Save or Discard.';
  show('item');
}

function renderThumbs() {
  for (const kind of ['photos', 'receipts']) {
    const host = $('thumbs-' + kind);
    host.innerHTML = '';
    bucket[kind].forEach((entry, index) => {
      const cell = document.createElement('div');
      cell.className = 'thumb';

      if (entry.blob.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.alt = `${kind === 'photos' ? 'Photo' : 'Document'} ${index + 1}`;
        img.src = URL.createObjectURL(entry.blob);
        img.onload = () => URL.revokeObjectURL(img.src);
        cell.appendChild(img);
      } else {
        const doc = document.createElement('div');
        doc.className = 'doc';
        doc.textContent = entry.name;
        cell.appendChild(doc);
      }

      const x = document.createElement('button');
      x.className = 'thumb-x';
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${kind === 'photos' ? 'photo' : 'document'} ${index + 1}`);
      x.onclick = () => { bucket[kind].splice(index, 1); renderThumbs(); };
      cell.appendChild(x);

      host.appendChild(cell);
    });
    $('count-' + kind).textContent = String(bucket[kind].length);
  }
}

async function addFiles(fileList, kind) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  say($('item-status'), `Adding ${files.length} file${files.length > 1 ? 's' : ''}...`, 'busy');
  for (const file of files) {
    const blob = await shrinkImage(file);
    const isImage = blob.type.startsWith('image/');
    const n = (bucket.seq[kind] += 1);
    const ext = isImage ? 'jpg' : (file.name.split('.').pop() || 'bin').toLowerCase();
    bucket[kind].push({
      name: String(n).padStart(2, '0') + '.' + ext,
      originalName: file.name,
      blob: blob
    });
  }
  renderThumbs();
  say($('item-status'), 'Added. Keep snapping, or tap Save Item.', 'ok');
}

function depthOf(category) {
  const found = CATEGORIES.find((c) => c[0] === category);
  return found ? found[1] : 'light';
}

function updateNag() {
  const full = depthOf($('f-category').value) === 'full';
  $('serial-nag').hidden = !(full && !$('f-serial').value.trim());
}

function collectFields() {
  const estimated = [];
  if ($('f-price-est').checked) {
    ['purchase_price', 'purchase_date', 'seller'].forEach((f) => {
      if ($({purchase_price: 'f-price', purchase_date: 'f-pdate', seller: 'f-seller'}[f]).value.trim()) {
        estimated.push(f);
      }
    });
  }
  return {
    name: $('f-name').value.trim(),
    category: $('f-category').value,
    make: $('f-make').value.trim(),
    model: $('f-model').value.trim(),
    serial: $('f-serial').value.trim(),
    quantity: parseInt($('f-quantity').value, 10) || 1,
    year_made: $('f-year').value.trim(),
    owner: $('f-owner').value.trim() || 'Me',
    location: $('f-location').value.trim(),
    attached_to: $('f-attached').value.trim().toUpperCase(),
    purchase_price: $('f-price').value.trim(),
    purchase_date: $('f-pdate').value.trim(),
    seller: $('f-seller').value.trim(),
    condition: $('f-condition').value.trim(),
    notes: $('f-notes').value.trim(),
    estimated_fields: estimated
  };
}

async function saveItem() {
  const fields = collectFields();

  if (!bucket.photos.length && !bucket.receipts.length && !fields.name) {
    say($('item-status'), 'Nothing to save yet. Take a photo, or at least give it a name.', 'bad');
    return;
  }

  const draft = {
    id: bucket.id,
    createdAt: bucket.createdAt,
    savedAt: new Date().toISOString(),
    appVersion: VERSION,
    fields: fields,
    photos: bucket.photos,
    receipts: bucket.receipts,
    status: 'pending',
    error: ''
  };

  await putDraft(draft);
  remember(LS.owners, fields.owner);
  remember(LS.places, fields.location);

  bucket = null;
  show('home');
  say($('home-status'), 'Saved on this phone. Sending to Dropbox...', 'busy');
  await refreshCounts();
  flushQueue();
}

/* ============================================================ uploading */

let flushing = false;

async function uploadDraft(draft) {
  const base = `${root()}/inbox/${draft.id}`;
  const uploaded = { photos: [], receipts: [] };

  for (const kind of ['photos', 'receipts']) {
    for (const entry of draft[kind]) {
      await dbxUpload(`${base}/${kind}/${entry.name}`, entry.blob);
      uploaded[kind].push(entry.name);
    }
  }

  const record = {
    draft_id: draft.id,
    created_at: draft.createdAt,
    saved_at: draft.savedAt,
    uploaded_at: new Date().toISOString(),
    app_version: draft.appVersion,
    source: 'phone',
    fields: draft.fields,
    photos: uploaded.photos,
    receipts: uploaded.receipts
  };

  /* item.json goes up last, on purpose. The Mac only ingests a folder once
     item.json is there, so a half-finished upload is never picked up. */
  await dbxUpload(
    `${base}/item.json`,
    new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' })
  );
}

async function flushQueue() {
  if (flushing) return;
  if (!isConnected()) return;

  flushing = true;
  try {
    const drafts = (await allDrafts()).filter((d) => d.status !== 'done');
    if (!drafts.length) { say($('home-status'), '', ''); return; }

    let sent = 0;
    for (const draft of drafts) {
      try {
        say($('home-status'), `Sending ${sent + 1} of ${drafts.length} to Dropbox...`, 'busy');
        await uploadDraft(draft);
        await killDraft(draft.id);
        sent += 1;
        const filed = Number(localStorage.getItem(LS.filed) || 0) + 1;
        localStorage.setItem(LS.filed, String(filed));
      } catch (err) {
        draft.status = 'error';
        draft.error = String(err.message || err);
        await putDraft(draft);
      }
    }

    await refreshCounts();
    const left = (await allDrafts()).length;
    if (left === 0) {
      say($('home-status'), `All filed in Dropbox. ${sent} item${sent === 1 ? '' : 's'} sent.`, 'ok');
    } else {
      say($('home-status'),
          `${left} item${left === 1 ? '' : 's'} still waiting. Tap below to try again.`, 'bad');
    }
  } finally {
    flushing = false;
    await refreshCounts();
  }
}

async function refreshCounts() {
  const drafts = await allDrafts();
  $('num-waiting').textContent = String(drafts.length);
  $('num-filed').textContent = localStorage.getItem(LS.filed) || '0';
  $('btn-upload-now').hidden = drafts.length === 0;
}

async function renderQueue() {
  const drafts = await allDrafts();
  const host = $('queue-list');
  if (!drafts.length) {
    host.innerHTML = '<p class="hint">Nothing waiting. Everything is in Dropbox.</p>';
    return;
  }
  host.innerHTML = '';
  drafts.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'queue-row' + (d.status === 'error' ? ' is-error' : '');
    const name = d.fields.name || '(no name yet)';
    const photos = d.photos.length;
    const receipts = d.receipts.length;
    row.innerHTML =
      `<h4></h4><p>${photos} photo${photos === 1 ? '' : 's'}, ` +
      `${receipts} document${receipts === 1 ? '' : 's'} &middot; ${d.id}</p>` +
      (d.status === 'error' ? `<p class="why"></p>` : '');
    row.querySelector('h4').textContent = name;
    if (d.status === 'error') row.querySelector('.why').textContent = d.error;
    host.appendChild(row);
  });
}

/* ============================================================ wiring */

function wire() {
  $('version-label').textContent = 'JK Inventory · version ' + VERSION;

  $('f-category').innerHTML = CATEGORIES.map(
    ([name]) => `<option value="${name}">${name}</option>`).join('');
  $('f-category').value = 'Everything else';

  fillDatalist('known-owners', LS.owners, ['Me']);
  fillDatalist('known-locations', LS.places, []);

  /* --- connect --- */
  $('in-appkey').value = localStorage.getItem(LS.appKey) || '';

  $('btn-authorize').onclick = async () => {
    const appKey = $('in-appkey').value.trim();
    if (!appKey) {
      say($('connect-status'), 'Paste your Dropbox App Key in step 1 first.', 'bad');
      return;
    }
    localStorage.setItem(LS.appKey, appKey);

    const verifier = randomVerifier();
    localStorage.setItem(LS.verifier, verifier);
    const challenge = await challengeFor(verifier);

    const url = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: appKey,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline'
    });
    say($('connect-status'),
        'Dropbox is opening. Tap Allow, copy the code it shows, then come back here.', 'busy');
    window.open(url, '_blank');
  };

  $('btn-paste').onclick = async () => {
    try {
      $('in-authcode').value = (await navigator.clipboard.readText()).trim();
      say($('connect-status'), 'Pasted. Now tap Finish connecting.', 'ok');
    } catch {
      say($('connect-status'), 'I could not read the clipboard. Tap the box and paste by hand.', 'bad');
    }
  };

  $('btn-finish-connect').onclick = async () => {
    const code = $('in-authcode').value.trim();
    const appKey = localStorage.getItem(LS.appKey);
    const verifier = localStorage.getItem(LS.verifier);
    if (!code)     return say($('connect-status'), 'Paste the code from Dropbox first.', 'bad');
    if (!verifier) return say($('connect-status'), 'Tap Open Dropbox in step 2 first.', 'bad');

    say($('connect-status'), 'Connecting...', 'busy');
    try {
      const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: code,
          grant_type: 'authorization_code',
          client_id: appKey,
          code_verifier: verifier
        })
      });
      const data = await res.json();
      if (!res.ok || !data.refresh_token) {
        throw new Error(data.error_description || data.error ||
                        'Dropbox did not accept that code. Start again at step 2 for a fresh one.');
      }
      localStorage.setItem(LS.refresh, data.refresh_token);
      localStorage.setItem(LS.access, data.access_token);
      localStorage.setItem(LS.expires, String(Date.now() + (data.expires_in || 14400) * 1000));
      localStorage.removeItem(LS.verifier);
      $('in-authcode').value = '';

      try {
        const who = await dbxRPC('users/get_current_account', null);
        localStorage.setItem(LS.account, who.name.display_name + ' (' + who.email + ')');
      } catch { /* the connection works; the name is just nice to have */ }

      say($('connect-status'), 'Connected.', 'ok');
      show('home');
      await refreshCounts();
      flushQueue();
    } catch (err) {
      say($('connect-status'), String(err.message || err), 'bad');
    }
  };

  /* --- home --- */
  $('btn-new-item').onclick = newBucket;
  $('btn-upload-now').onclick = flushQueue;
  $('tile-queue').onclick = async () => { await renderQueue(); show('queue'); };

  /* --- item --- */
  $('in-photos').onchange = (e) => { addFiles(e.target.files, 'photos'); e.target.value = ''; };
  $('in-receipts').onchange = (e) => { addFiles(e.target.files, 'receipts'); e.target.value = ''; };
  $('f-category').onchange = updateNag;
  $('f-serial').oninput = updateNag;
  $('btn-save-item').onclick = saveItem;
  $('btn-discard-item').onclick = () => {
    const count = bucket.photos.length + bucket.receipts.length;
    if (count && !confirm(`Throw away this item and its ${count} photo${count === 1 ? '' : 's'}?`)) return;
    bucket = null;
    show('home');
  };

  /* --- queue --- */
  $('btn-queue-upload').onclick = async () => {
    say($('queue-status'), 'Trying...', 'busy');
    await flushQueue();
    await renderQueue();
    say($('queue-status'), $('home-status').textContent, '');
  };
  $('btn-queue-back').onclick = () => show('home');

  /* --- settings --- */
  $('btn-settings').onclick = () => {
    $('f-root').value = root();
    $('settings-account').textContent = isConnected()
      ? 'Connected to Dropbox: ' + (localStorage.getItem(LS.account) || 'signed in')
      : 'Not connected to Dropbox.';
    say($('settings-status'), '', '');
    show('settings');
  };
  $('btn-settings-back').onclick = () => show(isConnected() ? 'home' : 'connect');

  $('btn-save-root').onclick = () => {
    localStorage.setItem(LS.root, $('f-root').value.trim() || '/Inventory');
    $('f-root').value = root();
    say($('settings-status'), 'Folder saved: ' + root(), 'ok');
  };

  $('btn-test').onclick = async () => {
    say($('settings-status'), 'Checking...', 'busy');
    try {
      const who = await dbxRPC('users/get_current_account', null);
      localStorage.setItem(LS.account, who.name.display_name + ' (' + who.email + ')');
      await dbxRPC('files/list_folder', { path: root(), limit: 1 });
      say($('settings-status'),
          `Working. Signed in as ${who.name.display_name}, and ${root()} is there.`, 'ok');
    } catch (err) {
      say($('settings-status'), String(err.message || err), 'bad');
    }
  };

  $('btn-disconnect').onclick = () => {
    if (!confirm('Disconnect Dropbox on this phone?')) return;
    [LS.refresh, LS.access, LS.expires, LS.account].forEach((k) => localStorage.removeItem(k));
    say($('settings-status'), 'Disconnected.', 'ok');
    show('connect');
  };

  /* --- app-wide --- */
  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flushQueue();
  });
}

async function start() {
  wire();
  await refreshCounts();
  if (isConnected()) {
    show('home');
    flushQueue();
  } else {
    show('connect');
  }

  if ('serviceWorker' in navigator) {
    /* updateViaCache 'none' stops the browser serving sw.js from its own
       HTTP cache, so an update is picked up on the next open. */
    navigator.serviceWorker
      .register('sw.js', { updateViaCache: 'none' })
      .catch(() => { /* fine without it, the app just will not open offline */ });
  }
}

start();
