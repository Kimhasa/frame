(() => {
  'use strict';
  // Inside FrameConsole.exe the WebView2 bridge drives capture, encoding and serving. Opened from another PC's browser,
  // the same page runs as a viewer only and talks to the server's read-only info and WHEP endpoints.
  const $ = id => document.getElementById(id);
  const bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const remote = !bridge;
  if (bridge) document.documentElement.classList.add('frame-native');
  if (window.visualViewport) {
    const fitVisual = () => document.documentElement.style.setProperty('--frame-visual-height', Math.round(visualViewport.height * (visualViewport.scale || 1)) + 'px');
    visualViewport.addEventListener('resize', fitVisual); fitVisual();
  }
  const volumeReadOnly = (() => { const v = document.createElement('video'); try { v.volume = 0.5; } catch { return true; } return Math.abs(v.volume - 0.5) > 0.01; })();
  if (volumeReadOnly) document.documentElement.classList.add('volume-readonly');
  const native = message => { if (bridge) bridge.postMessage(JSON.stringify(message)); };
  const state = { running: false, starting: false, stopping: false, connected: false, connecting: false, paused: false, source: null, sourceTitle: '', selected: null, windows: [], startedAt: 0, logs: [], viewerEdited: false, playbackQuality: 'auto', stream: null, session: null, video: null, attempt: 0, infoAt: 0, statsTimer: 0, lastBytes: 0, lastBytesAt: 0, failed: '' };
  const fields = ['server-host', 'stream-path', 'resolution', 'fps', 'custom-fps', 'quality', 'audio-source', 'bitrate-auto', 'publish-port', 'viewer-port'];
  const resolutions = [
    { value: '426x240', label: '240p', detail: '426 × 240', bitrate: 0.5 },
    { value: '640x360', label: '360p', detail: '640 × 360', bitrate: 1 },
    { value: '854x480', label: '480p', detail: '854 × 480', bitrate: 2 },
    { value: '1280x720', label: '720p', detail: '1280 × 720', bitrate: 4 },
    { value: '1920x1080', label: '1080p', detail: '1920 × 1080', bitrate: 8 },
    { value: '2560x1440', label: '1440p', detail: '2560 × 1440', bitrate: 16 },
    { value: '3840x2160', label: '2160p', detail: '3840 × 2160', bitrate: 35 }
  ];
  const audioSources = [
    { value: 'none', label: '사용 안 함' }, { value: 'system', label: '시스템 오디오' },
    { value: 'mic', label: '마이크' }, { value: 'mix', label: '시스템 + 마이크' }
  ];
  const fpsPresets = [30, 60, 90, 120, 144, 165];
  const pickers = FrameControls.mount({ resolution: [...resolutions].reverse(), fps: fpsPresets.map(value => ({ value: String(value), label: value + ' fps' })).concat({ value: 'custom', label: '직접 입력' }), 'audio-source': audioSources });
  const timeText = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let toastTimer, copiedTimer;
  function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 2400); }
  function clock(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  }
  function config() { return { host: $('server-host').value.trim(), path: $('stream-path').value.trim(), resolution: $('resolution').value, fps: Number($('fps').value === 'custom' ? $('custom-fps').value : $('fps').value), bitrate: Number($('quality').value), audio: $('audio-source').value, publishPort: Number($('publish-port').value), viewerPort: Number($('viewer-port').value) }; }
  // Same rules as the native encoder setup: the output keeps the source's aspect ratio inside the selected size and is never
  // upscaled; the automatic bitrate (the cap in VBR mode) follows the real output size, frame rate and encoder.
  function autoBitrate(width, height, fps) {
    const f = Number.isFinite(fps) && fps >= 30 ? fps : 60, factor = state.encoder === 'libx264' ? 0.85 : 1;
    return Math.min(200, Math.max(0.5, Math.round(0.07 * width * height * 60 * Math.pow(f / 60, 0.75) * factor / 1e6 * 2) / 2));
  }
  function syncEncodingOptions() {
    const c = config(), locked = state.running || state.starting;
    $('custom-fps-field').hidden = $('fps').value !== 'custom';
    $('custom-fps').disabled = locked || $('fps').value !== 'custom';
    $('fps-hint').hidden = !Number.isFinite(c.fps) || c.fps <= 60;
    if ($('bitrate-auto').checked && !locked) {
      const [boxW, boxH] = c.resolution.split('x').map(Number);
      $('quality').value = autoBitrate(boxW, boxH, c.fps);
    }
    $('quality').disabled = locked || $('bitrate-auto').checked;
    $('system-channel').hidden = !['system', 'mix'].includes(c.audio);
    $('mic-channel').hidden = !['mic', 'mix'].includes(c.audio);
    pickers.sync();
  }
  function validHost(host) {
    if (!host || host.length > 253) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host.split('.').every(part => Number(part) <= 255);
    return /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(host);
  }
  const validPath = path => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(path);
  const validPort = port => Number.isInteger(port) && port >= 1 && port <= 65535;
  function fieldError(field, id, message) { $(id).textContent = message; $(id).hidden = !message; $(field).setAttribute('aria-invalid', String(Boolean(message))); }
  function validate(report = false) {
    const c = config();
    const errors = [
      { field: 'server-host', id: 'host-error', message: validHost(c.host) ? '' : '올바른 IP 주소나 호스트 이름을 입력하세요.' },
      { field: 'stream-path', id: 'stream-error', message: validPath(c.path) ? '' : '영문, 숫자, 하이픈, 밑줄로 1~64자 입력하세요.' },
      { field: 'custom-fps', id: 'fps-error', message: Number.isInteger(c.fps) && c.fps >= 30 && c.fps <= 165 ? '' : '30~165 사이의 정수로 입력하세요.' },
      { field: 'quality', id: 'bitrate-error', message: Number.isFinite(c.bitrate) && c.bitrate >= 0.5 && c.bitrate <= 200 ? '' : '0.5~200 Mbps 사이로 입력하세요.' },
      { field: 'publish-port', id: 'port-error', message: validPort(c.publishPort) && validPort(c.viewerPort) ? (c.publishPort === c.viewerPort ? '송출 포트와 시청 포트는 서로 달라야 합니다.' : '') : '포트는 1~65535 사이의 정수로 입력하세요.' }
    ];
    if (report) {
      errors.forEach(error => fieldError(error.field, error.id, error.message));
      $('viewer-port').setAttribute('aria-invalid', String(!validPort(c.viewerPort) || c.publishPort === c.viewerPort));
      if (errors.some(error => ['port-error', 'bitrate-error'].includes(error.id) && error.message)) $('advanced-settings').open = true;
    }
    return errors.find(error => error.message);
  }
  function badge(id, text, active = false) { const element = $(id); if (element) { element.textContent = text; element.classList.toggle('active', active); } }
  function senderUI() {
    syncEncodingOptions();
    const error = validate();
    $('start-button').disabled = state.starting || state.stopping || (!state.running && (!state.source || Boolean(error)));
    $('start-button').title = !state.source ? '공유할 창을 먼저 선택하세요.' : error ? error.message : '';
    badge('sender-status', state.running ? '송출 중' : state.starting ? '준비 중' : state.stopping ? '종료 중' : !state.source ? '창 선택 필요' : error ? '설정 확인' : state.failed ? '송출 실패' : '준비됨', state.running);
    $('copy-address').disabled = !state.running;
    $('open-viewer').disabled = !state.running;
    $('share-hint').hidden = state.running;
    $('settings-lock').hidden = !state.running && !state.starting;
    $('sender-fullscreen').disabled = !state.source;
  }
  function updateAddress() { const c = config(); $('viewer-address').textContent = (state.publicUrl || 'http://' + c.host + ':' + c.viewerPort) + '/' + c.path; $('preview-resolution').textContent = c.resolution.split('x')[1] + 'p / ' + (Number.isFinite(c.fps) ? c.fps : '—') + ' fps'; }
  function renderLog() {
    $('log-list').replaceChildren();
    for (const item of state.logs) { const row = document.createElement('tr'); for (const key of ['time', 'kind', 'message']) { const cell = document.createElement('td'); cell.textContent = item[key]; row.append(cell); } $('log-list').append(row); }
    $('log-count').textContent = state.logs.length; $('export-log').disabled = !state.logs.length;
  }
  // A keyed entry (the periodic performance line) is updated in place instead of pushing other events out.
  function log(kind, message, key) {
    const existing = key && state.logs.find(item => item.key === key);
    if (existing) { existing.time = timeText(); existing.message = message; } else { state.logs.unshift({ time: timeText(), kind, message, key }); state.logs = state.logs.slice(0, 20); }
    renderLog();
  }
  function view(name) {
    for (const tab of ['sender', 'viewer']) { const active = tab === name; $('tab-' + tab).setAttribute('aria-selected', String(active)); $('tab-' + tab).tabIndex = active ? 0 : -1; $(tab + '-view').hidden = !active; }
    if (name === 'viewer' && !remote && !state.connected && !state.connecting && !state.viewerEdited) { $('viewer-host').value = config().host; $('viewer-stream').value = config().path; }
    window.scrollTo({ top: 0, behavior: 'auto' });
    native({ cmd: 'previewVisible', visible: name === 'sender' && !document.hidden });
    document.dispatchEvent(new CustomEvent('frame:view', {detail:{name}}));
    if (!remote) try { const url = new URL(location.href); url.searchParams.set('view', name); history.replaceState(null, '', url); } catch {}
  }

  // ---- Sender: window selection and live preview -------------------------------------------------------------
  const previewCanvas = $('sender-canvas'), previewContext = previewCanvas.getContext('2d');
  const previewImage = new Image();
  previewImage.decoding = 'async';
  function showSource(title) {
    $('source-name').textContent = title; $('sender-empty').hidden = !!title; $('source-row').hidden = !title;
    if (!title) previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }
  // Canvas in the shape of the encoder output (the selected resolution), at most 1280x720.
  function previewFrame() {
    const [w, h] = config().resolution.split('x').map(Number), scale = Math.min(1280 / w, 720 / h, 1);
    return [Math.round(w * scale), Math.round(h * scale)];
  }
  async function drawPreview(event) {
    if (event.sourceWidth && (!state.sourceSize || state.sourceSize[0] !== event.sourceWidth || state.sourceSize[1] !== event.sourceHeight)) {
      state.sourceSize = [event.sourceWidth, event.sourceHeight];
      if (!state.running && !state.starting) syncEncodingOptions();
    }
    try {
      previewImage.src = 'data:image/jpeg;base64,' + event.jpeg;
      await previewImage.decode();
      if (!state.source) return;
      const [fw, fh] = previewFrame(), scale = Math.min(fw / event.width, fh / event.height);
      const w = Math.round(event.width * scale), h = Math.round(event.height * scale);
      if (previewCanvas.width !== fw || previewCanvas.height !== fh) { previewCanvas.width = fw; previewCanvas.height = fh; }
      previewContext.fillStyle = '#000'; previewContext.fillRect(0, 0, fw, fh);
      previewContext.drawImage(previewImage, Math.round((fw - w) / 2), Math.round((fh - h) / 2), w, h);
    } catch {} finally { native({ cmd: 'previewAck' }); }
  }
  function markSelected() { document.querySelectorAll('[data-source]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.source === state.selected))); $('confirm-source').disabled = !state.selected; }
  // Window thumbnails arrive after the names, with a state per window (native WindowThumbnails). Each card keeps its
  // size; a short status and, after the automatic attempts, a small retry button sit inside the thumbnail area. Events
  // carry the list generation and a request id, so a late image never lands on another window or a newer list.
  const thumbLabels = { queued: '대기 중', loading: '불러오는 중', timeout: '응답이 늦습니다', failed: '미리보기를 가져오지 못했습니다', minimized: '최소화된 창', closed: '창이 닫혔습니다', excluded: '캡처가 제외된 창' };
  const thumbReasons = {
    'first-frame-timeout': '창이 제한 시간 안에 화면을 보내지 않았습니다.', 'dwm-timeout': '창의 화면을 제한 시간 안에 받지 못했습니다.', 'dwm-empty': '창의 화면이 아직 그려지지 않았습니다.',
    'capture-start': '이 창의 캡처를 시작하지 못했습니다.', 'dwm-register': '이 창의 화면을 가져오지 못했습니다.', 'dwm-update': '이 창의 화면을 가져오지 못했습니다.', 'dwm-size': '창의 크기를 확인하지 못했습니다.',
    'dwm-capture-start': '이 창의 화면을 가져오지 못했습니다.', convert: '화면을 이미지로 바꾸지 못했습니다.', jpeg: '화면을 이미지로 바꾸지 못했습니다.', decode: '미리보기 이미지를 표시하지 못했습니다.',
    gpu: '그래픽 장치를 사용할 수 없어 미리보기를 만들 수 없습니다.', excluded: '이 앱이 창을 화면 캡처에서 제외했습니다.', 'minimized-empty': '최소화된 창에 표시할 화면이 남아 있지 않습니다.'
  };
  const thumbTimeouts = ['first-frame-timeout', 'dwm-timeout', 'dwm-empty'];
  let thumbObserver = null, thumbPriorityTimer = 0;
  const sourceCard = id => document.querySelector('.source-options [data-source="' + CSS.escape(id) + '"]');
  // Shown until the window's own icon arrives, and when it has none: a plain application window, same size.
  const defaultAppIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17M6.5 6.8h.01M9 6.8h.01"/></svg>';
  // Device-pixel sizes of a card's 16:9 thumbnail and of its 24 px icon, so native images are not stretched up.
  function sourceSizes() {
    const box = document.querySelector('.source-options'), style = getComputedStyle(box);
    const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1, gap = parseFloat(style.columnGap) || 0;
    const width = (box.clientWidth - gap * (columns - 1)) / columns - 2;
    return { thumbWidth: Math.round(width * devicePixelRatio), iconSize: Math.round(24 * devicePixelRatio) };
  }
  const thumbAge = image => Math.max(1, Math.round((image.ageMs + Date.now() - image.at) / 1000)) + '초 전에 가져온 화면입니다.';
  function thumbDetail(t) {
    const reason = thumbReasons[t.stage] || '';
    if (t.state === 'minimized') return t.image ? (t.image.source === 'cache' ? thumbAge(t.image) : '최소화되기 전에 마지막으로 그려진 화면입니다.') + ' 창을 다시 표시하면 현재 화면으로 바뀝니다.' : (reason ? reason + ' ' : '') + '창을 다시 표시하면 미리보기를 가져옵니다.';
    if (t.state === 'closed') return t.stage === 'hidden' ? '창이 화면에서 숨겨졌습니다. 다시 표시되면 미리보기를 가져옵니다.' : '창이 닫혀 선택할 수 없습니다.';
    if (t.state === 'timeout' || t.state === 'failed') return (reason || '미리보기를 가져오지 못했습니다.') + (t.attempt ? ' ' + t.attempt + '번 시도했습니다.' : '') + (t.image ? ' 보이는 화면은 이전에 가져온 것입니다.' : '');
    if (t.state === 'retrying') return reason + ' 다시 시도하고 있습니다.';
    if (t.state === 'excluded') return thumbReasons.excluded;
    if (t.image && !t.image.fresh) return thumbAge(t.image) + ' 현재 화면을 불러오고 있습니다.';
    return '';
  }
  function applyThumb(id) {
    const t = state.thumbs[id], button = sourceCard(id);
    if (!t || !button) return;
    const item = button.parentElement, chip = item.querySelector('.source-state'), retry = item.querySelector('.source-retry');
    let label = '';
    if (t.state === 'queued' || t.state === 'loading') {
      // Most windows finish within a few tens of ms: the wait label appears only when the wait lasts (no flicker).
      const waited = performance.now() - t.since;
      if (t.image && !t.image.fresh) label = '이전 화면';
      else if (t.manual || waited >= 400) label = thumbLabels[t.state];
      else setTimeout(() => applyThumb(id), 420 - waited);
    } else if (t.state === 'retrying') label = thumbTimeouts.includes(t.stage) ? '응답이 늦습니다' : '다시 시도하는 중';
    else if (t.state === 'closed') label = t.stage === 'hidden' ? '창이 숨겨졌습니다' : thumbLabels.closed;
    else if (t.state !== 'ready') label = thumbLabels[t.state] || '';
    const detail = thumbDetail(t);
    chip.textContent = label; chip.hidden = !label; chip.title = detail;
    button.title = t.name + (detail ? '\n' + detail : '');
    button.dataset.thumbState = t.state;
    if (t.image) button.dataset.thumbFresh = String(t.image.fresh); else delete button.dataset.thumbFresh;
    retry.hidden = !(t.state === 'timeout' || t.state === 'failed') || t.stage === 'gpu';
    retry.disabled = false;
    // A closed window cannot be shared; a window without a thumbnail still can (the capture itself reports its result).
    button.disabled = t.state === 'closed';
    if (button.disabled && state.selected === id) { state.selected = null; markSelected(); }
  }
  function thumbPriority() {
    clearTimeout(thumbPriorityTimer);
    thumbPriorityTimer = setTimeout(() => {
      if (state.windowGen == null) return;
      const ids = [...document.querySelectorAll('.source-options [data-source]')].map(button => button.dataset.source).filter(id => state.visibleSources.has(id));
      native({ cmd: 'thumbPriority', gen: state.windowGen, ids, selected: state.selected || '' });
    }, 120);
  }
  function retryThumb(id) {
    const t = state.thumbs[id];
    if (!t || state.windowGen == null || !(t.state === 'timeout' || t.state === 'failed')) return;
    t.state = 'queued'; t.manual = true; t.since = performance.now(); applyThumb(id);
    native({ cmd: 'thumbRetry', gen: state.windowGen, id });
  }
  function closeThumbs() {
    if (state.windowGen == null) return;
    state.windowGen = null; thumbObserver?.disconnect(); native({ cmd: 'thumbCancel' });
  }
  function renderWindows(items, gen) {
    state.windows = items; state.windowGen = gen ?? null; state.thumbs = {}; state.visibleSources = new Set();
    thumbObserver?.disconnect(); thumbObserver = null;
    const box = document.querySelector('.source-options'), counts = {};
    items.forEach(item => counts[item.title] = (counts[item.title] || 0) + 1);
    box.replaceChildren();
    if (items.length) thumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) state.visibleSources[entry.isIntersecting ? 'add' : 'delete'](entry.target.dataset.source);
      thumbPriority();
    });
    items.forEach((item, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'source-choice'; button.dataset.source = item.id;
      // Same title: the program name; same title and program: also its number, the least that tells the cards apart.
      const twins = items.filter(other => other.title === item.title && other.exe === item.exe), number = twins.indexOf(item) + 1;
      const name = counts[item.title] > 1 && item.exe ? item.title + ' (' + item.exe + (twins.length > 1 ? ' ' + number : '') + ')' : item.title;
      button.title = name;
      const thumb = document.createElement('span'); thumb.className = 'source-thumb'; thumb.innerHTML = icon('monitor');
      // Title row: app icon + window title on one line (CSS ellipsis; the full title is the button's name and tooltip).
      const label = document.createElement('span'); label.className = 'source-label';
      const appIcon = document.createElement('span'); appIcon.className = 'source-app-icon'; appIcon.innerHTML = defaultAppIcon;
      const text = document.createElement('span'); text.className = 'source-window-name'; text.textContent = name;
      label.append(appIcon, text);
      button.append(thumb, label);
      button.addEventListener('click', () => { if (button.disabled) return; state.selected = item.id; markSelected(); thumbPriority(); });
      button.addEventListener('dblclick', () => { if (button.disabled) return; state.selected = item.id; confirmSource(); });
      // Status and retry sit over the thumbnail but outside the card button (no nested buttons; the card keeps its role).
      const overlay = document.createElement('span'); overlay.className = 'source-overlay';
      const chip = document.createElement('span'); chip.className = 'source-state'; chip.id = 'source-state-' + index; chip.hidden = true;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'source-retry'; retry.hidden = true;
      retry.innerHTML = icon('refresh') + '<span>다시 시도</span>'; retry.setAttribute('aria-label', name + ' 미리보기 다시 시도');
      retry.addEventListener('click', () => { retry.disabled = true; retryThumb(item.id); });
      overlay.append(chip, retry);
      button.setAttribute('aria-describedby', chip.id);
      const wrap = document.createElement('div'); wrap.className = 'source-item'; wrap.append(button, overlay);
      box.append(wrap);
      state.thumbs[item.id] = { name, req: 0, state: 'queued', stage: '', attempt: 0, image: null, since: performance.now(), manual: false };
      applyThumb(item.id);
      thumbObserver?.observe(button);
    });
    if (!items.length) { const empty = document.createElement('p'); empty.textContent = '공유할 수 있는 창이 없습니다.'; box.append(empty); }
    if (!items.some(item => item.id === state.selected)) state.selected = null;
    markSelected();
  }
  function onThumbState(event) {
    const t = state.thumbs[event.id];
    if (event.gen !== state.windowGen || !t || event.req < t.req) return;
    if ((event.state === 'queued' || event.state === 'loading') && !(t.state === 'queued' || t.state === 'loading')) t.since = performance.now();
    if (event.req > t.req && t.req && !t.manual) t.since = performance.now();
    if (!(event.state === 'queued' || event.state === 'loading')) t.manual = false;
    Object.assign(t, { req: event.req, state: event.state, stage: event.stage || '', attempt: event.attempt || 0 });
    applyThumb(event.id);
  }
  async function showIcon(event) {
    const box = event.gen === state.windowGen ? sourceCard(event.id)?.querySelector('.source-app-icon') : null;
    if (!box) return;
    const image = document.createElement('img'); image.alt = ''; image.src = 'data:image/png;base64,' + event.png;
    try { await image.decode(); } catch { return; }  // the default icon stays
    if (event.gen === state.windowGen && box.isConnected) box.replaceChildren(image);
  }
  async function showThumb(event) {
    const current = () => event.gen === state.windowGen && state.thumbs[event.id] && (event.source === 'cache' ? !state.thumbs[event.id].image : event.req >= state.thumbs[event.id].req);
    if (!current()) return;
    const image = document.createElement('img'), started = performance.now(); image.alt = ''; image.src = 'data:image/jpeg;base64,' + event.jpeg;
    let ok = true;
    try { await image.decode(); } catch { ok = false; }
    if (!current()) return;
    const t = state.thumbs[event.id];
    // The UI side of the result goes to the native log: a native success that never reached the card is visible there.
    if (event.source !== 'cache') native({ cmd: 'thumbShown', gen: event.gen, id: event.id, req: event.req, ok, ms: event.ms, decodeMs: Math.round(performance.now() - started) });
    if (!ok) { if (event.source !== 'cache') { t.state = 'failed'; t.stage = 'decode'; applyThumb(event.id); } return; }
    image.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
    sourceCard(event.id)?.querySelector('.source-thumb').replaceChildren(image);
    t.image = { fresh: event.fresh !== false, source: event.source, ageMs: event.ageMs || 0, at: Date.now() };
    applyThumb(event.id);
  }
  function chooseSource() {
    if (remote) return;
    state.selected = state.source; renderWindows([]); document.querySelector('.source-options').replaceChildren();
    $('confirm-source').disabled = true; $('source-dialog').showModal(); native({ cmd: 'listWindows', ...sourceSizes() });
  }
  function confirmSource() { if (!state.selected) return; native({ cmd: 'selectWindow', id: state.selected }); $('source-dialog').close(); }
  function onSource(event) {
    if (event.ok) {
      if (state.source !== event.id) state.sourceSize = null;
      state.source = event.id; state.sourceTitle = event.title; state.failed = ''; showSource(event.title);
      if (event.kind === 'monitor' && $('source-dialog').open) $('source-dialog').close();
      if (event.minimized) toast('최소화된 창은 다시 표시해야 화면이 갱신됩니다.');
    }
    else {
      if (event.closed || !state.source) { state.source = null; state.sourceTitle = ''; state.sourceSize = null; showSource(''); }
      if (event.kind === 'monitor' && $('source-dialog').open) { $('monitor-message').textContent = event.message || '모니터를 선택할 수 없습니다.'; $('monitor-message').hidden = false; }
      if (event.message) toast(event.message);
    }
    senderUI();
  }
  // Full-screen tab: real monitors from the native side; the selection goes through its own validated command.
  document.addEventListener('frame:request-monitors', () => { if (!bridge) return; $('monitor-message').textContent = '모니터 목록을 불러오는 중입니다.'; $('monitor-message').hidden = false; native({ cmd: 'listMonitors' }); });
  document.addEventListener('frame:select-monitor', ({ detail }) => { if (bridge && detail && typeof detail.id === 'string') native({ cmd: 'selectMonitor', id: detail.id }); });
  function onMonitors(items) {
    window.FrameUI?.setMonitors(items);
    if (!items.length) { $('monitor-message').textContent = '사용할 수 있는 모니터가 없습니다.'; $('monitor-message').hidden = false; }
  }

  // ---- Sender: start, running state and measurements -----------------------------------------------------------
  function lockSettings(locked) { fields.forEach(id => $(id).disabled = locked); $('source-button').disabled = locked; if (!locked) syncEncodingOptions(); }
  function begin() {
    if (!state.source) { chooseSource(); return; }
    const error = validate(true); if (error) { $(error.field).focus(); return; }
    const c = config();
    state.starting = true; state.failed = ''; lockSettings(true); $('start-button').textContent = '준비 중'; senderUI();
    native({ cmd: 'start', settings: { host: c.host, path: c.path, resolution: c.resolution, fps: c.fps, bitrate: c.bitrate, bitrateAuto: $('bitrate-auto').checked, audio: c.audio, systemVolume: Number($('system-volume').value), micVolume: Number($('mic-volume').value), publishPort: c.publishPort, viewerPort: c.viewerPort } });
  }
  function runningUI(status) {
    state.starting = false; state.stopping = false; state.running = true; state.startedAt = Date.now() - (status?.elapsedMs || 0);
    document.dispatchEvent(new CustomEvent('frame:sender-state',{detail:{running:true,status:status||null}}));
    lockSettings(true);
    $('start-button').className = 'danger start-button'; $('start-button').innerHTML = icon('stop') + '<span>송출 종료</span>';
    // The encoder's applied value (the automatic one depends on the real output size and encoder).
    if (status && Number.isFinite(status.bitrate)) $('quality').value = status.bitrate;
    if (status?.encoder) state.encoder = status.encoder;
    $('metric-fps').textContent = status?.fps || config().fps; $('metric-bitrate').textContent = '—'; senderUI();
    // With an internet relay the broadcast's chat room lives on the relay, where its internet viewers are.
    if (status?.broadcastId && (state.relayChat || state.viewerServerPort)) chatOpen('sender', state.relayChat || 'http://127.0.0.1:' + state.viewerServerPort, status.path || config().path, status.broadcastId);
  }
  function stoppedUI() {
    state.running = false; state.starting = false; state.stopping = false; lockSettings(false);
    chatClose('sender');
    document.dispatchEvent(new CustomEvent('frame:sender-state',{detail:{running:false}}));
    $('start-button').className = 'primary start-button'; $('start-button').innerHTML = icon('play') + '<span>송출 시작</span>';
    $('metric-fps').textContent = '—'; $('metric-bitrate').textContent = '—'; $('metric-viewers').textContent = '0'; senderUI();
  }
  const fieldErrors = { 'server-host': 'host-error', 'stream-path': 'stream-error', 'custom-fps': 'fps-error', quality: 'bitrate-error', 'publish-port': 'port-error', 'viewer-port': 'port-error' };
  function onState(event) {
    if (event.state === 'starting') { state.starting = true; senderUI(); return; }
    if (event.state === 'running') { runningUI(event.status); return; }
    const wasRunning = state.running;
    state.failed = event.state === 'failed' ? event.message || '송출 실패' : '';
    stoppedUI();
    if (event.state === 'failed') {
      if (fieldErrors[event.field]) { fieldError(event.field === 'viewer-port' ? 'publish-port' : event.field, fieldErrors[event.field], event.message); if (fieldErrors[event.field] === 'port-error') $('advanced-settings').open = true; }
      toast(event.message || '송출을 시작할 수 없습니다.');
    }
    if (wasRunning && state.connected && isLocalStream()) endPlayback('송출이 종료되었습니다', '송출을 다시 시작한 뒤 연결하세요.');
    senderUI();
  }
  function onStats(event) {
    if (!state.running) return;
    $('metric-bitrate').textContent = event.bitrateMbps > 0 ? event.bitrateMbps.toFixed(1) : '—';
    $('metric-viewers').textContent = String(event.viewers || 0);
  }
  function applySettings(s) {
    // Internet viewing address (relay or this PC behind a public name) and whether chat runs on a relay.
    state.publicUrl = s.publicUrl || ''; state.relayChat = s.relayPublishUrl ? s.relayApiUrl || s.publicUrl || '' : '';
    $('server-host').value = s.serverHost; $('stream-path').value = s.streamPath; $('resolution').value = s.resolution;
    if (fpsPresets.includes(s.fps)) $('fps').value = String(s.fps); else { $('fps').value = 'custom'; $('custom-fps').value = s.fps; }
    $('bitrate-auto').checked = s.bitrateAuto; $('quality').value = s.bitrateMbps; $('audio-source').value = s.audio;
    $('system-volume').value = s.systemVolume; $('mic-volume').value = s.micVolume; $('publish-port').value = s.publishPort; $('viewer-port').value = s.viewerPort;
    for (const channel of ['system', 'mic']) volumeUI(channel);
    syncEncodingOptions(); updateAddress(); validate(true); senderUI();
  }
  function onInit(event) {
    state.viewerServerPort = event.viewerServer || 0; state.encoderSetting = event.settings.encoder;
    if (event.viewerServerError) log('오류', event.viewerServerError);
    applySettings(event.settings);
    if (!state.viewerEdited) $('viewer-receive-port').value = event.settings.viewerPort;
    if (event.source) { state.source = event.source.id; state.sourceTitle = event.source.title; showSource(event.source.title); }
    if (event.status?.running) { const s = event.status; $('resolution').value = s.resolution; runningUI(s); }
    senderUI();
  }
  function stop() { state.stopping = true; senderUI(); native({ cmd: 'stop' }); }

  // ---- Viewer: WHEP playback in the approved player -----------------------------------------------------------
  const viewerCanvas = $('viewer-canvas');
  viewerCanvas.style.display = 'none';
  function makeVideo() {
    const video = document.createElement('video');
    video.playsInline = true; video.autoplay = true; video.setAttribute('aria-label', '수신 영상');
    video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
    return video;
  }
  const isLocalStream = () => !remote && state.stream && state.stream.host.toLowerCase() === config().host.toLowerCase() && state.stream.path === config().path;
  function busyError(response) { const error = new Error('busy'); error.retryAfter = Math.min(30, Math.max(1, Number(response.headers.get('Retry-After')) || 2)); return error; }
  async function fetchInfo(base, path) {
    const response = await fetch(base + '/' + encodeURIComponent(path) + '/info', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.status === 503) throw busyError(response);
    if (!response.ok) throw new Error('info ' + response.status);
    return response.json();
  }
  function gathered(pc, timeout) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => { const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } }; pc.addEventListener('icegatheringstatechange', done); setTimeout(resolve, timeout); });
  }
  async function openSession(base, path, iceServers) {
    const pc = new RTCPeerConnection({ iceServers: Array.isArray(iceServers) ? iceServers : [], bundlePolicy: 'max-bundle' });
    pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
    const media = new MediaStream();
    pc.addEventListener('track', event => media.addTrack(event.track));
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, 2000);
      const response = await fetch(base + '/' + path + '/whep', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
      if (response.status === 503) throw busyError(response);
      if (response.status !== 201) throw new Error(response.status === 404 ? 'not-running' : 'whep ' + response.status);
      const resource = response.headers.get('Location');
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      return { pc, media, resource: resource ? new URL(resource, base + '/').href : '' };
    } catch (error) { pc.close(); throw error; }
  }
  function closeSession(session) {
    if (!session) return;
    session.closed = true;
    try { session.pc.close(); } catch {}
    if (session.resource) fetch(session.resource, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
  // A hidden page (minimised browser) does not decode video, so there the stream metadata is enough to proceed.
  function waitFrames(video, timeout) {
    return new Promise((resolve, reject) => {
      const ready = () => video.readyState >= 2 || (document.hidden && video.readyState >= 1);
      if (ready()) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('timeout')), timeout);
      const check = () => { if (!ready()) return; clearTimeout(timer); for (const name of ['loadedmetadata', 'loadeddata']) video.removeEventListener(name, check); document.removeEventListener('visibilitychange', check); resolve(); };
      for (const name of ['loadedmetadata', 'loadeddata']) video.addEventListener(name, check);
      document.addEventListener('visibilitychange', check);
    });
  }
  // The browser refused sound without a user gesture (mobile autoplay policy): play muted, say so, and keep the volume
  // control in view until the viewer turns the sound on. Playing muted is not reported as playing with sound.
  function mutedByBrowser(video) {
    video.muted = true; $('player-volume').value = 0; volumeUI('player'); video.play().catch(() => {});
    state.mutedByBrowser = true; noteEvent('muted-by-browser'); toast('소리 없이 재생 중입니다. 음량 버튼을 눌러 소리를 켜세요.'); log('수신', '브라우저 정책으로 음소거 재생'); controlsActive();
  }
  function applyPlayerVolume(video) { const amount = Number($('player-volume').value); video.volume = amount / 100; video.muted = amount === 0; }
  const renditionPath = (path, quality) => quality === 'auto' || quality === sourceQuality() ? path : path + '/' + resolutions.find(item => item.value === quality).label;
  const sourceQuality = () => state.stream ? state.stream.info.width + 'x' + state.stream.info.height : config().resolution;
  // The quality to (re)open live: the manual choice, or in automatic mode the one that was last playing.
  const liveQuality = () => state.playbackQuality === 'auto' ? state.playing || 'auto' : state.playbackQuality;
  // Starts a WHEP session and swaps it into the player once its first frame is decoded; the old session keeps playing until then.
  async function attach(quality) {
    const stream = state.stream, session = await openSession(stream.base, renditionPath(stream.path, quality), stream.info.iceServers);
    // Muted until it replaces the current picture, so a quality switch never plays two soundtracks.
    const video = makeVideo(); video.srcObject = session.media; video.muted = true;
    // play() of a live stream settles only with its first frame: not awaited, so the 15 s limit always applies (a
    // switch that never gets a frame used to hang here and stop automatic quality; tools/netem measured 219 s).
    try { video.play().catch(() => {}); await waitFrames(video, 15000); }
    catch (error) { closeSession(session); throw error; }
    if (state.stream !== stream) { closeSession(session); return false; }
    const previous = state.session, oldVideo = state.video, oldHistory = state.history;
    state.session = session; state.video = video; state.history = null; state.playing = quality === 'auto' ? sourceQuality() : quality; state.lastBytes = 0; abrReset();
    if (oldVideo && document.pictureInPictureElement === oldVideo) document.exitPictureInPicture().catch(() => {});
    if (oldVideo) oldVideo.replaceWith(video); else viewerCanvas.after(video);
    closeSession(previous); closeHistory(oldHistory);
    applyPlayerVolume(video);
    if (!video.muted) await video.play().catch(error => { if (error.name !== 'NotAllowedError') return; mutedByBrowser(video); });
    if (state.paused) video.pause();
    document.dispatchEvent(new CustomEvent('frame:media')); 
    session.pc.addEventListener('connectionstatechange', () => { if (state.session === session && ['failed', 'closed'].includes(session.pc.connectionState)) lost(); else if (state.session === session && session.pc.connectionState === 'disconnected') setTimeout(() => { if (state.session === session && session.pc.connectionState === 'disconnected') lost(); }, 3000); });
    return true;
  }
  // Fallback when this browser or network cannot use WebRTC: the server's low-latency HLS of the original stream, played
  // by the browser itself (Safari and other browsers with native HLS). Longer delay than WebRTC, one quality, and no
  // rewind bar where Media Source Extensions are missing. Chosen per connection and kept for its reconnects.
  const nativeHls = () => !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  async function attachHls() {
    const stream = state.stream, video = makeVideo(); video.muted = true;
    // Native HLS players only load a video that is in the document: it waits in the player, invisible, until its first frame.
    const stop = () => { video.removeAttribute('src'); video.load(); video.remove(); };
    video.style.position = 'absolute'; video.style.inset = '0'; video.style.opacity = '0'; viewerCanvas.after(video);
    const variants = stream.info.hlsVariants || {}, safe = v => typeof v === 'string' && /^[a-z0-9_-]+(\/[a-z0-9_-]+)*\/index\.m3u8$/i.test(v) ? v : '';
    const needsAac = stream.info.audio && stream.info.audio !== 'none' && !video.canPlayType('audio/mp4; codecs="opus"');
    video.src = stream.base + '/' + encodeURIComponent(stream.path) + '/' + ((needsAac && safe(variants.aac)) || safe(variants.opus) || 'hls/index.m3u8');
    try { video.play().catch(() => {}); await waitFrames(video, 20000); }
    catch (error) { stop(); throw error; }
    if (state.stream !== stream) { stop(); return false; }
    const previous = state.session, oldVideo = state.video, oldHistory = state.history;
    state.session = null; state.video = video; state.history = null; state.playing = sourceQuality(); state.lastBytes = 0;
    if (oldVideo && document.pictureInPictureElement === oldVideo) document.exitPictureInPicture().catch(() => {});
    video.style.position = video.style.inset = video.style.opacity = '';
    if (oldVideo) oldVideo.remove();
    closeSession(previous); closeHistory(oldHistory);
    applyPlayerVolume(video);
    if (!video.muted) await video.play().catch(error => { if (error.name === 'NotAllowedError') mutedByBrowser(video); });
    if (state.paused) video.pause();
    video.addEventListener('error', () => { if (state.video === video) lost(); });
    document.dispatchEvent(new CustomEvent('frame:media'));
    return true;
  }
  // Opens live playback for the current connection with the transport it settled on.
  const openLive = quality => state.useHls ? attachHls() : attach(quality);
  function infoText() {
    const info = state.stream?.info;
    if (!info) return;
    $('info-fps').textContent = info.fps + ' fps'; $('info-audio').textContent = audioSources.find(item => item.value === info.audio)?.label || '사용 안 함';
    if (!$('info-bitrate').dataset.measured) $('info-bitrate').textContent = Number(info.bitrate).toFixed(1) + ' Mbps';
  }
  function qualityLabel() {
    const height = state.video?.videoHeight || Number((state.playing || sourceQuality()).split('x')[1]);
    $('player-quality-label').textContent = height + 'p'; $('player-settings').title = '재생 화질: ' + (state.playbackQuality === 'auto' ? '자동 (' + height + 'p)' : height + 'p');
    $('info-resolution').textContent = height + 'p' + (state.playbackQuality === 'auto' ? ' (자동)' : '');
  }
  // ---- Player controls: hidden while playing, back on pointer movement, tap, keyboard or menu -------------------------
  // Hidden controls are transparent and take no pointer events, so a click on the picture still pauses and resumes; the
  // overlay never changes the layout. Kept visible while paused, while the pointer is on them, while a slider is dragged,
  // while the quality menu is open and while a control has keyboard focus.
  const playerBox = $('viewer-preview'), playerControls = $('player-controls');
  const idle = { timer: 0, over: false, dragging: false, tapShown: false };
  function controlsPinned() {
    const focused = document.activeElement;
    return !state.connected || state.paused || state.mutedByBrowser || idle.over || idle.dragging || !$('player-quality-menu').hidden ||
      !!(focused && (playerControls.contains(focused) || $('player-quality-menu').contains(focused)) && focused.matches(':focus-visible'));
  }
  function hideControls() { clearTimeout(idle.timer); if (!controlsPinned()) playerBox.classList.add('controls-idle'); }
  // Shows the controls and starts the idle countdown (about 2.5 s); a pinned state simply outlasts the countdown.
  function controlsActive() { clearTimeout(idle.timer); playerBox.classList.remove('controls-idle'); if (state.connected) idle.timer = setTimeout(hideControls, 2500); }
  playerBox.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') controlsActive(); });
  playerBox.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') { idle.over = false; hideControls(); } });
  playerControls.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') idle.over = true; });
  playerControls.addEventListener('pointerleave', () => { idle.over = false; controlsActive(); });
  playerBox.addEventListener('pointerdown', event => {
    idle.tapShown = false;
    // A tap on hidden controls only reveals them; it must not also pause or resume.
    if (event.pointerType === 'touch' && playerBox.classList.contains('controls-idle')) { idle.tapShown = true; controlsActive(); return; }
    if (event.target.matches('input[type=range]')) idle.dragging = true;
    controlsActive();
  });
  document.addEventListener('pointerup', () => { if (idle.dragging) { idle.dragging = false; controlsActive(); } });
  document.addEventListener('pointercancel', () => { if (idle.dragging) { idle.dragging = false; controlsActive(); } });
  // The tap that only revealed the controls ends here, whatever is under the finger once they are visible.
  playerBox.addEventListener('click', event => { if (!idle.tapShown) return; idle.tapShown = false; event.preventDefault(); event.stopPropagation(); }, true);
  playerBox.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) controlsActive(); });
  playerBox.addEventListener('focusout', () => setTimeout(() => { if (playerBox.contains(document.activeElement)) controlsActive(); else hideControls(); }, 0));
  playerBox.addEventListener('keydown', () => controlsActive());
  function receiver(connected, heading, description, retry = false) {
    state.connected = connected; state.paused = false;
    badge('viewer-status', connected ? '수신 중' : '대기', connected);
    $('no-signal').hidden = connected; $('player-controls').hidden = !connected; $('pause-overlay').hidden = true;
    $('connect-button').textContent = '수신 시작'; $('connect-button').className = 'primary connect-button';
    $('viewer-host').disabled = connected; $('viewer-stream').disabled = connected;
    $('viewer-title').textContent = connected ? state.stream.info.title || state.stream.path : '수신 화면';
    if (!connected) { for (const id of ['info-resolution', 'info-fps', 'info-bitrate', 'info-audio']) $(id).textContent = '—'; delete $('info-bitrate').dataset.measured; }
    closePlayerQuality();
    $('retry-button').hidden = connected || !retry;
    if (heading) $('empty-heading').textContent = heading;
    if (description) $('empty-description').textContent = description;
    $('player-pause').innerHTML = icon('pause') + '<span class="control-label">일시정지</span>'; $('player-pause').setAttribute('aria-label', '일시정지'); $('player-pause').title = '일시정지 (Space)';
    if (!connected) { $('viewer-view').classList.remove('is-wide'); $('viewer-wide').setAttribute('aria-pressed', 'false'); $('viewer-wide').setAttribute('aria-label', '확대 보기'); $('viewer-wide').innerHTML = icon('layout') + '<span class="control-label">확대 보기</span>'; }
    else { infoText(); qualityLabel(); }
    controlsActive();
    document.dispatchEvent(new CustomEvent('frame:receiver', { detail: { connected, heading, description, connecting: state.connecting } }));
  }
  function endPlayback(heading, description, retry = true) {
    state.connectionVersion = (state.connectionVersion || 0) + 1;
    const stream = state.stream;
    chatClose('viewer');
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    state.stream = null; state.connecting = false; clearInterval(state.statsTimer);
    closeSession(state.session); state.session = null;
    closeHistory(state.history); state.history = null; state.pausedLive = null; dvrStop(); state.mutedByBrowser = false;
    if (state.video) { state.video.srcObject = null; if (state.video.getAttribute('src')) { state.video.removeAttribute('src'); state.video.load(); } state.video.remove(); state.video = null; }
    state.useHls = false;
    controlsActive();
    if (heading) receiver(false, heading, description, retry);
    return stream;
  }
  // target: { base, host, port, path } from a list card, "시청하기" or a retry; without it the manual form's fields are used.
  async function connect(target) {
    const manual = !target || typeof target !== 'object';
    const host = manual ? $('viewer-host').value.trim() : String(target.host || ''), path = manual ? $('viewer-stream').value.trim() : String(target.path || '');
    const port = manual ? Number($('viewer-receive-port').value) : Number(target.port);
    if (manual) {
      fieldError('viewer-host', 'viewer-host-error', validHost(host) ? '' : '서버 주소를 확인하세요.');
      fieldError('viewer-stream', 'viewer-stream-error', validPath(path) ? '' : '스트림 ID을 확인하세요.');
      fieldError('viewer-receive-port', 'viewer-receive-port-error', validPort(port) ? '' : '1~65535 사이의 포트를 입력하십시오.');
      if (!validPort(port)) { $('viewer-receive-port').focus(); return; }
    }
    if (!validHost(host) || !validPath(path) || !validPort(port)) { if (!state.connected) receiver(false, '입력한 주소를 확인하세요', '연결 설정을 수정하세요.'); if (manual) (!validHost(host) ? $('viewer-host') : $('viewer-stream')).focus(); return; }
    if (state.connecting) return;
    endPlayback();
    const connectionVersion = state.connectionVersion;
    state.connecting = true; $('viewer-host').disabled = true; $('viewer-stream').disabled = true; badge('viewer-status', '연결 중'); $('retry-button').hidden = true;
    document.dispatchEvent(new CustomEvent('frame:connecting'));
    const base = manual ? (remote ? location.protocol : 'http:') + '//' + host + ':' + port : target.base;
    state.lastTarget = { base, host, port, path };
    try {
      let info = null;
      for (let attempt = 0; ; attempt++) {
        try {
          info = await fetchInfo(base, path);
          if (connectionVersion !== state.connectionVersion) return;
          if (!info.running) throw new Error('not-running');
          state.stream = { base, host, path, info, infoAt: Date.now() }; state.playbackQuality = 'auto'; state.playing = null; abr.holdUpMs = ABR.minHoldUpMs; abr.failed = {};
          state.useHls = typeof RTCPeerConnection !== 'function';
          if (state.useHls && !nativeHls()) throw new Error('unsupported');
          try { await openLive('auto'); }
          catch (error) {
            // WebRTC could not deliver media (blocked UDP/TCP media ports, no TURN): try HTTP-delivered HLS where the browser plays it.
            if (state.useHls || error.message === 'busy' || error.message === 'not-running' || !nativeHls()) throw error;
            state.useHls = true; noteEvent('hls-fallback'); log('수신', 'WebRTC 연결 실패, HLS로 재생합니다'); await attachHls();
          }
          break;
        } catch (error) {
          if (error.message !== 'busy' || attempt >= 4 || connectionVersion !== state.connectionVersion) throw error;
          const wait = error.retryAfter * 1000 * (attempt + 1) * (0.7 + Math.random() * 0.6);
          noteEvent('busy-retry'); badge('viewer-status', '대기 중'); toast('접속자가 많아 ' + Math.ceil(wait / 1000) + '초 뒤 다시 연결합니다.'); log('수신', '서버 혼잡(503), ' + Math.ceil(wait / 1000) + '초 뒤 재시도');
          await sleep(wait);
          if (connectionVersion !== state.connectionVersion) return;
        }
      }
      if (connectionVersion !== state.connectionVersion) return;
      state.connecting = false; state.attempt = 0;
      receiver(true); log('수신', path + ' 연결'); dvrStart();
      if (manual) rememberManual({ host, port, path });
      if (info.broadcastId) chatOpen('viewer', base, path, info.broadcastId);
      state.statsTimer = setInterval(viewerStats, 1000);
    } catch (error) {
      if (connectionVersion !== state.connectionVersion) return;
      state.connecting = false; endPlayback();
      const ended = error.message === 'not-running', busy = error.message === 'busy', unsupported = error.message === 'unsupported';
      receiver(false, busy ? '접속자가 많습니다' : '연결할 수 없습니다', ended ? '송출 상태와 주소를 확인한 뒤 다시 연결하세요.' : busy ? '잠시 후 다시 연결하세요.' : unsupported ? '이 브라우저는 실시간 재생 방식(WebRTC, HLS)을 지원하지 않습니다.' : '서버 주소와 방화벽 설정을 확인한 뒤 다시 연결하세요.', true);
      badge('viewer-status', '연결 안 됨'); log('수신', '연결 실패: ' + host + ' ' + path);
    }
  }
  const manualKey = 'frame.manualTarget';
  function rememberManual(value) { state.manualApplied = value; try { localStorage.setItem(manualKey, JSON.stringify(value)); } catch {} }
  function appliedManual() {
    if (state.manualApplied) return state.manualApplied;
    try { const v = JSON.parse(localStorage.getItem(manualKey) || 'null'); if (v && validHost(v.host) && validPath(v.path) && validPort(Number(v.port))) return (state.manualApplied = v); } catch {}
    return null;
  }
  // Opening the manual dialog shows the last manual connection that worked (or the defaults), never an earlier failed or
  // cancelled edit; a failed attempt keeps the typed values only while the dialog stays open, to be corrected.
  function prepareManual() {
    const v = appliedManual();
    if (v) { $('viewer-host').value = v.host; $('viewer-receive-port').value = v.port; $('viewer-stream').value = v.path; }
    else if (remote) { $('viewer-host').value = location.hostname; $('viewer-receive-port').value = location.port || (location.protocol === 'https:' ? '443' : '80'); }
    else { $('viewer-host').value = config().host; $('viewer-receive-port').value = config().viewerPort; $('viewer-stream').value = config().path; }
    for (const id of ['viewer-host', 'viewer-stream', 'viewer-receive-port']) fieldError(id, id + '-error', '');
  }
  async function lost() {
    if (!state.stream || state.connecting) return;
    noteEvent('reconnect');
    const stream = state.stream;
    state.connecting = true; badge('viewer-status', '재연결 중');
    dvr.token++; closeHistory(dvr.pending); dvr.pending = null;
    const giveUpAt = Date.now() + 45000;
    for (let attempt = 1; state.stream === stream; attempt++) {
      let wait = Math.min(8000, 1500 * attempt);
      try {
        const info = await fetchInfo(stream.base, stream.path);
        if (!info.running) break;
        const previousId = stream.info.broadcastId;
        stream.info = info; stream.infoAt = Date.now();
        if (info.mediaReady === false) { badge('viewer-status', '신호 대기'); throw new Error('media not ready'); }
        if (!(await openLive(liveQuality())) || state.stream !== stream) return;
        state.connecting = false; badge('viewer-status', state.paused ? '일시정지' : '수신 중', !state.paused); log('수신', stream.path + ' 다시 연결');
        if (info.broadcastId !== previousId) { if (info.broadcastId) chatOpen('viewer', stream.base, stream.path, info.broadcastId); dvrStart(); }
        return;
      } catch (error) {
        if (error && error.message === 'busy') { noteEvent('busy-retry'); wait = error.retryAfter * 1000 * (0.7 + Math.random() * 0.6); }
      }
      if (Date.now() + wait > giveUpAt) break;
      await sleep(wait);
    }
    if (state.stream !== stream) return;
    let running = false;
    try { running = (await fetchInfo(stream.base, stream.path)).running; } catch {}
    endPlayback(running ? '연결이 끊어졌습니다' : '송출이 종료되었습니다', running ? '네트워크 상태를 확인한 뒤 다시 연결하세요.' : '송출을 다시 시작한 뒤 연결하세요.');
    log('수신', stream.path + (running ? ' 연결 끊김' : ' 송출 종료'));
  }
  // Every 15 s the page reports how playback really goes (transport, quality, frame rate, loss, freezes, automatic quality
  // switches, the last error) to the server it watches from, for operations. Anonymous: a random id per page load.
  const statsSession = Math.random().toString(36).slice(2, 12);
  function noteEvent(text) { state.lastEvent = text; }
  function reportStats() {
    const stream = state.stream, v = state.video, last = abr.samples.at(-1);
    if (!stream || !v || !navigator.sendBeacon) return;
    const d = abr.decisions.at(-1);
    const body = { sid: statsSession, broadcast: stream.info.broadcastId || '', transport: state.history ? 'dvr' : state.useHls ? 'hls' : 'webrtc', mode: state.playbackQuality === 'auto' ? 'auto' : 'manual',
      quality: (state.playing || '').split('x')[1] ? state.playing.split('x')[1] + 'p' : '', height: v.videoHeight || 0, fps: last ? +last.fps.toFixed(1) : undefined,
      lossPct: last ? +(last.loss * 100).toFixed(2) : undefined, jitterMs: last && last.jitterMs != null ? Math.round(last.jitterMs) : undefined,
      freezes: abr.samples.filter(x => x.freeze).length, mbps: Number($('info-bitrate').dataset.measured ? parseFloat($('info-bitrate').textContent) : 0) || undefined,
      abrSwitches: abr.decisions.length, lastSwitch: d ? d.from + '>' + d.to + ' ' + d.reason : '', event: state.lastEvent || '',
      device: matchMedia('(pointer: coarse)').matches ? 'touch' : 'desktop' };
    try { navigator.sendBeacon(stream.base + '/' + encodeURIComponent(stream.path) + '/stats', JSON.stringify(body)); } catch {}
    state.lastEvent = '';
  }
  async function viewerStats() {
    const session = state.session, stream = state.stream, history = state.history;
    if (!stream || (!session && !history && !state.useHls)) return;
    if ((state.statsTick = (state.statsTick || 0) + 1) % 15 === 0) reportStats();
    $('viewer-clock').textContent = clock((stream.info.elapsedMs || 0) + Date.now() - stream.infoAt);
    if (Date.now() - stream.infoAt > 5000 && !state.connecting) {
      try { const info = await fetchInfo(stream.base, stream.path); state.infoFailures = 0; if (!info.running || info.mediaReady === false) { lost(); return; } if (info.elapsedMs < stream.info.elapsedMs) { lost(); return; } stream.info = info; stream.infoAt = Date.now(); infoText(); }
      catch { if (history && ++state.infoFailures >= 3) { state.infoFailures = 0; lost(); return; } }
    }
    if (!session && !history) { qualityLabel(); return; }  // HLS: the browser's own player has no WebRTC statistics
    if (!session) {
      // Recorded playback: the average bitrate of the recording actually loaded, not a WebRTC measurement.
      if (history && history.mediaMs > 1000) { $('info-bitrate').textContent = (history.bytes * 8 / (history.mediaMs / 1000) / 1e6).toFixed(1) + ' Mbps'; $('info-bitrate').dataset.measured = '1'; }
      qualityLabel(); return;
    }
    try {
      const report = await session.pc.getStats(), sample = {};
      report.forEach(item => {
        if (item.type === 'inbound-rtp' && item.kind === 'video') Object.assign(sample, { fps: item.framesPerSecond || 0, width: item.frameWidth || 0, height: item.frameHeight || 0, framesDecoded: item.framesDecoded || 0, framesDropped: item.framesDropped || 0, packetsLost: item.packetsLost || 0, bytes: item.bytesReceived || 0, jitterBufferMs: item.jitterBufferEmittedCount ? item.jitterBufferDelay / item.jitterBufferEmittedCount * 1000 : 0 });
        if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') sample.rttMs = (item.currentRoundTripTime || 0) * 1000;
      });
      const now = performance.now();
      if (state.lastBytes && sample.bytes >= state.lastBytes) { const mbps = (sample.bytes - state.lastBytes) * 8 / ((now - state.lastBytesAt) / 1000) / 1e6; $('info-bitrate').textContent = mbps.toFixed(1) + ' Mbps'; $('info-bitrate').dataset.measured = '1'; sample.mbps = mbps; }
      state.lastBytes = sample.bytes; state.lastBytesAt = now;
      qualityLabel();
      abrStep(report, session);
      native({ cmd: 'viewerStats', stats: sample });
    } catch {}
  }
  // ---- Automatic playback quality, per viewer ----------------------------------------------------------------------
  // Chooses among the qualities the server really encodes (the original and its shared lower renditions) from this
  // viewer's own session: freezes, packet loss, jitter-buffer growth, decoded frame rate against the stream's, frames the
  // device drops while the network is fine (decoding limit), and the size the picture is shown at. It steps down quickly
  // when playback suffers and up one step only after a calm period; an up-step that fails soon doubles the wait before the
  // next try, so a line near a quality boundary does not flip back and forth. The received bitrate is not taken as the
  // line's capacity (it is only what the current quality uses). Every switch and its reason goes to the event log.
  const ABR = { downWindow: 3, upWindow: 12, lossDown: 0.04, lossUp: 0.005, jitterDownMs: 450, jitterUpMs: 180, fpsDown: 0.72, fpsUp: 0.92,
    stallMs: 1200, minDownGapMs: 3000, minHoldUpMs: 12000, maxHoldUpMs: 120000, failWindowMs: 12000, sizeSlack: 0.9, sizeDownMs: 8000 };
  const abr = { samples: [], last: null, lastSwitchAt: 0, holdUpMs: ABR.minHoldUpMs, upAt: 0, upFrom: null, failed: {}, sizeSince: 0, sizeLimited: false, decisions: [] };
  function abrReset() { abr.samples = []; abr.last = null; abr.lastSwitchAt = performance.now(); }
  // Qualities from the highest (the original) down, as the server announced them.
  function abrLadder() {
    const info = state.stream?.info; if (!info) return [];
    const source = { value: sourceQuality(), label: info.height + 'p', height: info.height, mbps: Number(info.bitrate) || 0, original: true };
    const lower = (info.renditions || []).map(r => ({ value: resolutions.find(item => item.label === r.name)?.value, label: r.name, height: r.height, mbps: r.mbps || 0 })).filter(r => r.value && r.height < info.height);
    return [source, ...lower.sort((a, b) => b.height - a.height)];
  }
  // Height the picture really occupies on screen, in device pixels (the player frame keeps its layout; the video is contained).
  function shownHeight() {
    const v = state.video; if (!v || !v.videoWidth) return 0;
    const box = v.getBoundingClientRect(), scale = Math.min(box.width / v.videoWidth, box.height / v.videoHeight);
    return v.videoHeight * scale * (window.devicePixelRatio || 1);
  }
  function abrStep(report, session) {
    const now = performance.now(), v = state.video;
    let r = null; report.forEach(item => { if (item.type === 'inbound-rtp' && item.kind === 'video') r = item; });
    if (!r || !v) return;
    const cur = { t: now, lost: r.packetsLost || 0, recv: r.packetsReceived || 0, decoded: r.framesDecoded || 0, dropped: r.framesDropped || 0,
      freezes: r.freezeCount, jbDelay: r.jitterBufferDelay || 0, jbCount: r.jitterBufferEmittedCount || 0, shownDropped: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().droppedVideoFrames : 0 };
    const prev = abr.last; abr.last = cur;
    if (!prev || state.paused || document.hidden) return;  // pauses and hidden tabs are not network trouble
    const dt = (now - prev.t) / 1000, packets = cur.recv - prev.recv + Math.max(0, cur.lost - prev.lost);
    const sample = { t: now, loss: packets > 0 ? Math.max(0, cur.lost - prev.lost) / packets : 0, fps: (cur.decoded - prev.decoded) / dt,
      jitterMs: cur.jbCount > prev.jbCount ? (cur.jbDelay - prev.jbDelay) / (cur.jbCount - prev.jbCount) * 1000 : null,
      freeze: cur.freezes != null && prev.freezes != null ? cur.freezes > prev.freezes : cur.decoded === prev.decoded && dt * 1000 >= ABR.stallMs,
      decodeDrop: (cur.dropped - prev.dropped) + (cur.shownDropped - prev.shownDropped) };
    abr.samples.push(sample); if (abr.samples.length > 60) abr.samples.shift();
    if (state.playbackQuality !== 'auto' || state.switching || state.history) return;
    const ladder = abrLadder(); if (ladder.length < 2) return;
    let index = Math.max(0, ladder.findIndex(level => level.value === (state.playing || sourceQuality())));
    const target = Number(state.stream.info.fps) || 60, recent = abr.samples.slice(-ABR.downWindow), calm = abr.samples.slice(-ABR.upWindow);
    const avg = (list, key) => { const xs = list.map(x => x[key]).filter(x => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; };
    const lossNow = avg(recent, 'loss'), fpsNow = avg(recent, 'fps'), jitterNow = avg(recent, 'jitterMs'), freezeNow = recent.some(x => x.freeze);
    // Largest quality worth sending to the size the picture is shown at.
    const shown = shownHeight();
    let sizeCap = 0;
    if (shown > 0) { sizeCap = ladder.length - 1; for (let i = ladder.length - 1; i >= 0; i--) { sizeCap = i; if (ladder[i].height >= shown * ABR.sizeSlack) break; } }
    let next = index, reason = '';
    if (recent.length >= ABR.downWindow && now - abr.lastSwitchAt >= ABR.minDownGapMs && index < ladder.length - 1) {
      const decodeLimited = lossNow < ABR.lossUp && fpsNow < target * ABR.fpsDown && recent.every(x => x.decodeDrop > 0);
      if (freezeNow) reason = '재생 끊김';
      else if (lossNow > ABR.lossDown) reason = '패킷 손실 ' + (lossNow * 100).toFixed(1) + '%';
      else if (jitterNow > ABR.jitterDownMs) reason = '수신 지연 증가 ' + Math.round(jitterNow) + 'ms';
      else if (decodeLimited) reason = '기기 디코딩 한계 ' + fpsNow.toFixed(0) + 'fps';
      else if (fpsNow < target * ABR.fpsDown && lossNow > ABR.lossUp) reason = '수신 프레임 부족 ' + fpsNow.toFixed(0) + 'fps';
      if (reason) { next = Math.min(ladder.length - 1, index + (freezeNow && lossNow > 0.15 ? 2 : 1)); abr.sizeLimited = false; }
    }
    if (!reason && index < sizeCap) {
      // Shown smaller than this quality for a while (player shrank or rotated): no need to receive the larger picture.
      if (!abr.sizeSince) abr.sizeSince = now;
      if (now - abr.sizeSince >= ABR.sizeDownMs) { next = sizeCap; reason = '표시 크기 ' + Math.round(shown) + 'px'; abr.sizeLimited = true; }
    } else abr.sizeSince = 0;
    // Lowered only because the picture was shown small: once it is shown larger and playback is calm, go straight to the size it needs.
    if (!reason && abr.sizeLimited && index > sizeCap && recent.length >= ABR.downWindow && recent.every(x => !x.freeze && x.loss <= ABR.lossUp) && now - abr.lastSwitchAt >= ABR.minDownGapMs) {
      next = sizeCap; reason = '표시 크기 ' + Math.round(shown) + 'px'; abr.sizeLimited = sizeCap > 0;
    }
    if (!reason && next === index && index > 0 && index - 1 >= sizeCap && calm.length >= ABR.upWindow && now - abr.lastSwitchAt >= abr.holdUpMs &&
        !(abr.failed[ladder[index - 1].value] > now)) {
      const steady = calm.every(x => !x.freeze && x.loss <= ABR.lossUp && (x.jitterMs == null || x.jitterMs <= ABR.jitterUpMs) && x.fps >= target * ABR.fpsUp);
      if (steady) { next = index - 1; reason = '안정 ' + Math.round(calm.length) + '초'; }
    }
    // An up-step that runs into trouble soon after is a failed probe: wait twice as long before trying that quality again.
    if (next > index && abr.upFrom !== null && now - abr.upAt < ABR.failWindowMs) {
      abr.holdUpMs = Math.min(ABR.maxHoldUpMs, abr.holdUpMs * 2); abr.failed[ladder[index].value] = now + abr.holdUpMs; abr.upFrom = null;
    } else if (next === index && abr.upFrom !== null && now - abr.upAt > 60000) { abr.upFrom = null; abr.holdUpMs = ABR.minHoldUpMs; }
    if (next !== index) abrSwitch(ladder[index], ladder[next], reason, next < index);
  }
  async function abrSwitch(from, to, reason, up) {
    if (state.switching) return;
    state.switching = true; abr.lastSwitchAt = performance.now();
    const at = performance.now();
    try {
      await attach(to.value);
      if (up) { abr.upFrom = from.value; abr.upAt = performance.now(); }
      const ms = Math.round(performance.now() - at);
      abr.decisions.push({ at: Date.now(), from: from.label, to: to.label, reason, ms }); if (abr.decisions.length > 50) abr.decisions.shift();
      log('화질', '자동 ' + from.label + ' → ' + to.label + ' (' + reason + ', 전환 ' + (ms / 1000).toFixed(1) + '초)');
      qualityLabel(); if (!$('player-quality-menu').hidden) renderPlayerQuality();
    } catch {
      // The quality could not start (e.g. its encoder failed): keep playing the current one and do not retry it soon.
      abr.failed[to.value] = performance.now() + ABR.maxHoldUpMs;
      abr.decisions.push({ at: Date.now(), from: from.label, to: to.label, reason: reason + ', 시작 실패', ms: Math.round(performance.now() - at) });
      log('화질', '자동 ' + to.label + ' 전환 실패, ' + from.label + ' 유지');
    } finally { state.switching = false; abr.lastSwitchAt = performance.now(); }
  }
  function pause() {
    if (!state.connected) return;
    state.paused = !state.paused; $('pause-overlay').hidden = !state.paused;
    const resumeAt = !state.paused && !state.history && state.pausedLive && performance.now() - state.pausedLive.at > 3000 ? state.pausedLive.positionMs : null;
    state.pausedLive = state.paused && !state.history && dvr.index && dvrSupported(state.stream.info) ? { at: performance.now(), positionMs: liveEdge() + Math.min(2500, performance.now() - dvr.at) } : null;
    if (state.video) {
      const playLive = () => { if (!state.paused && state.video) state.video.play().catch(() => {}); };
      if (state.paused) state.video.pause();
      else if (resumeAt !== null) seekTo(resumeAt).then(ok => { if (!ok) playLive(); }, playLive);
      else state.video.play().catch(() => {});
    }
    showTimeline();
    controlsActive();
    const label = state.paused ? '재생' : '일시정지'; $('player-pause').innerHTML = icon(state.paused ? 'play' : 'pause') + '<span class="control-label">' + label + '</span>'; $('player-pause').setAttribute('aria-label', label); $('player-pause').title = label + ' (Space)'; badge('viewer-status', state.paused ? '일시정지' : '수신 중', !state.paused);
  }
  function wide() { if (!state.connected) return; const active = $('viewer-view').classList.toggle('is-wide'); const label = active ? '기본 보기' : '확대 보기'; $('viewer-wide').setAttribute('aria-pressed', String(active)); $('viewer-wide').setAttribute('aria-label', label); $('viewer-wide').innerHTML = icon('layout') + '<span class="control-label">' + label + '</span>'; $('viewer-wide').title = label + ' (T)'; }
  async function fullscreen(name) {
    // iPhone Safari has no element full screen: there only the video itself can go full screen (with the system's controls).
    const box = $(name + '-preview'), video = name === 'viewer' ? state.video : null;
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
    try { if (box.requestFullscreen && document.fullscreenEnabled !== false) { await box.requestFullscreen(); return; } } catch {}
    try { if (video && video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; } } catch {}
    toast('이 브라우저에서는 전체 화면을 열 수 없습니다.');
  }
  // Hidden where neither element nor video full screen exists, instead of a button that can only fail.
  if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && !('webkitEnterFullscreen' in HTMLVideoElement.prototype)) $('viewer-fullscreen').hidden = true;

  // ---- DVR: the whole broadcast from the server's recording, and the return to live -------------------------------
  // Each viewer plays its own position: recorded fMP4 chunks of a few seconds (aligned to the keyframe grid of the
  // segment files) are appended to a MediaSource, and only a window around the playback position stays in memory.
  // Positions are the broadcasting PC's epoch milliseconds, the axis of the server's index; the live WebRTC session is
  // closed while history plays so there is only one soundtrack.
  const dvr = { index: null, at: 0, timer: 0, loading: false, dragging: false, token: 0, pending: null };
  const KEY_EPS = 2;  // request just after a keyframe so the server starts the chunk on it, not one GOP earlier
  const dvrUrl = (stream, suffix) => stream.base + '/' + encodeURIComponent(stream.path) + '/dvr' + suffix;
  const liveEdge = () => { const ranges = dvr.index?.ranges; return ranges && ranges.length ? ranges[ranges.length - 1].endMs : 0; };
  const historyPosition = h => h.base + h.video.currentTime * 1000;
  const mseType = info => 'video/mp4; codecs="avc1.640028' + (info.audio && info.audio !== 'none' ? ',opus' : '') + '"';
  // Recorded playback needs Media Source Extensions; browsers without it (e.g. iPhone Safari) keep live playback only.
  const dvrSupported = info => typeof MediaSource === 'function' && MediaSource.isTypeSupported(mseType(info));
  async function dvrRefresh() {
    const stream = state.stream;
    if (!stream || !stream.info.dvr || dvr.loading || !dvrSupported(stream.info)) return;
    dvr.loading = true;
    try {
      const response = await fetch(dvrUrl(stream, ''), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const index = response.ok ? await response.json() : null;
      if (state.stream !== stream) return;
      dvr.index = index && index.running && index.dvr && index.id === stream.info.broadcastId && Array.isArray(index.ranges) ? index : null;
      dvr.at = performance.now();
    } catch {} finally { dvr.loading = false; }
    showTimeline();
  }
  function dvrStart() { dvrStop(); if (state.stream?.info.dvr && dvrSupported(state.stream.info)) { dvrRefresh(); dvr.timer = setInterval(dvrRefresh, 2000); } showTimeline(); }
  function dvrStop() { clearInterval(dvr.timer); dvr.timer = 0; dvr.index = null; dvr.token++; dvr.dragging = false; closeHistory(dvr.pending); dvr.pending = null; }
  // The recorded range runs from the first recorded moment to the newest part on disk (about a second behind live).
  function showTimeline() {
    if (dvr.dragging || !window.FrameUI) return;
    const ranges = dvr.index?.ranges;
    if (!state.connected || !ranges || !ranges.length || liveEdge() - ranges[0].startMs < 2000) { window.FrameUI.setTimeline(null); return; }
    const h = state.history, pausedLive = !h && state.paused && state.pausedLive;
    window.FrameUI.setTimeline({ startMs: ranges[0].startMs, endMs: liveEdge(), positionMs: h ? historyPosition(h) : pausedLive ? state.pausedLive.positionMs : liveEdge(), mode: h || pausedLive ? 'history' : 'live' });
  }
  function keyAnchor(t) { let anchor = null; for (const start of dvr.index?.segments || []) { if (start <= t + 5) anchor = start; else break; } return anchor; }
  function alignDown(t) { const a = keyAnchor(t), gop = dvr.index?.gopMs || 1000; return a === null ? t : a + Math.max(0, Math.floor((t - a - KEY_EPS) / gop + 1e-6)) * gop + KEY_EPS; }
  function alignUp(t) { const a = keyAnchor(t), gop = dvr.index?.gopMs || 1000; return a === null ? t : a + Math.max(0, Math.ceil((t - a - KEY_EPS) / gop - 1e-6)) * gop + KEY_EPS; }
  const nextRangeStart = t => { const range = (dvr.index?.ranges || []).find(r => r.startMs > t + 1); return range ? range.startMs : null; };
  function createHistory(stream, positionMs) {
    const video = makeVideo(), source = new MediaSource(), mbps = Math.max(1, Number(stream.info.bitrate) || 8);
    // About 16 MB per request and 60 MB ahead / 30 MB behind at the stream's bitrate cap.
    const h = { stream, video, source, buffer: null, url: URL.createObjectURL(source), base: positionMs, next: positionMs, exact: true, started: false, closed: false, abort: null, waitUntil: 0, bytes: 0,
      chunkMs: Math.min(10000, Math.max(1000, Math.round(128 / mbps) * 1000)), aheadMs: Math.min(30000, Math.max(2000, 480 / mbps * 1000)), behindMs: Math.min(30000, Math.max(1000, 240 / mbps * 1000)) };
    video.muted = true; video.src = h.url;
    video.addEventListener('timeupdate', () => { if (state.history === h) showTimeline(); });
    video.addEventListener('waiting', () => gapJump(h));
    return h;
  }
  function closeHistory(h) {
    if (!h || h.closed) return;
    h.closed = true;
    if (!h.started && h.fail) h.fail(new Error('closed'));  // a seek still waiting for its first chunk ends now
    try { h.abort?.abort(); } catch {}
    try { h.video.pause(); h.video.removeAttribute('src'); h.video.load(); } catch {}
    URL.revokeObjectURL(h.url);
  }
  function bufferOp(h, run) {
    return new Promise((resolve, reject) => {
      const b = h.buffer, done = () => { b.removeEventListener('updateend', done); b.removeEventListener('error', fail); resolve(); }, fail = () => { b.removeEventListener('updateend', done); b.removeEventListener('error', fail); reject(new Error('append')); };
      b.addEventListener('updateend', done); b.addEventListener('error', fail);
      try { run(b); } catch (error) { b.removeEventListener('updateend', done); b.removeEventListener('error', fail); reject(error); }
    });
  }
  async function trimBehind(h, keepMs = h.behindMs) {
    const b = h.buffer, until = h.video.currentTime - keepMs / 1000;
    if (b && !b.updating && b.buffered.length && until > b.buffered.start(0) + 0.5) await bufferOp(h, buffer => buffer.remove(0, until)).catch(() => {});
  }
  function bufferedEndFrom(h, offset) { const b = h.buffer.buffered; let end = offset; for (let i = 0; i < b.length; i++) if (b.start(i) <= offset + 0.25 && b.end(i) > end) end = b.end(i); return end; }
  // Playback stalls at a hole in the buffer where recording was paused: continue with the next recorded part.
  function gapJump(h) {
    if (h.closed || !h.buffer) return;
    const b = h.buffer.buffered, t = h.video.currentTime;
    for (let i = 1; i < b.length; i++) if (t >= b.end(i - 1) - 0.3 && t < b.start(i)) { h.video.currentTime = b.start(i) + 0.01; return; }
  }
  async function fetchChunk(h, start, duration) {
    h.abort = new AbortController();
    const signal = AbortSignal.any ? AbortSignal.any([h.abort.signal, AbortSignal.timeout(20000)]) : h.abort.signal;
    const response = await fetch(dvrUrl(h.stream, '/media') + '?id=' + h.stream.info.broadcastId + '&start=' + start.toFixed(3) + '&duration=' + Math.round(duration), { cache: 'no-store', signal });
    return { status: response.status, data: response.status === 200 ? await response.arrayBuffer() : null };
  }
  async function historyLoop(h) {
    let failures = 0;
    while (!h.closed) {
      if (h !== state.history && h.token !== dvr.token) return;
      if (h.started) {
        if (h.video.readyState < 3) gapJump(h);
        if (h.next - historyPosition(h) > h.aheadMs || performance.now() < h.waitUntil) { await trimBehind(h); await sleep(250); continue; }
      }
      const start = h.exact ? h.next : alignDown(h.next), duration = Math.max(500, alignUp(start + h.chunkMs) - start);
      let result;
      try { result = await fetchChunk(h, start, duration); }
      catch (error) { if (h.closed) return; if (++failures > 5) throw error; await sleep(1000); continue; }
      if (h.closed) return;
      if (result.status === 409) throw new Error('changed');
      if (result.status === 404) {
        // Nothing recorded at that time: a pause in recording (skip to the next part) or the newest part is not on disk yet.
        await dvrRefresh();
        const after = nextRangeStart(start);
        if (after !== null) { h.next = after; h.exact = true; continue; }
        if (!h.started) throw new Error('no-data');
        h.waitUntil = performance.now() + 1000; continue;
      }
      if (result.status !== 200) { if (++failures > 5) throw new Error('chunk ' + result.status); await sleep(1000); continue; }
      failures = 0;
      const offset = (start - h.base) / 1000;
      try { await bufferOp(h, b => { b.timestampOffset = offset; b.appendBuffer(result.data); }); }
      catch (error) {
        if (h.closed) return;
        if (error.name !== 'QuotaExceededError') throw error;
        // Buffer full: drop what was played and fetch this part again once playback has used some of the buffer.
        await trimBehind(h, 1000); h.waitUntil = performance.now() + 1000; continue;
      }
      h.bytes += result.data.byteLength;
      const end = h.base + bufferedEndFrom(h, offset) * 1000;
      h.exact = false;
      if (end < start + duration - 200) {
        // Short chunk: recording paused there (continue at the next part) or this is the newest part (wait for more).
        const after = nextRangeStart(end);
        if (after !== null && after > end + 500) { h.next = after; h.exact = true; } else { h.next = end; h.waitUntil = performance.now() + 1000; }
      } else h.next = start + duration;
      h.mediaMs = (h.mediaMs || 0) + Math.max(0, end - start);
      if (!h.started) { h.started = true; h.ready(); }
    }
  }
  async function startHistory(h) {
    await new Promise((resolve, reject) => { if (h.source.readyState === 'open') resolve(); else { h.source.addEventListener('sourceopen', resolve, { once: true }); setTimeout(() => reject(new Error('mse')), 5000); } });
    h.buffer = h.source.addSourceBuffer(mseType(h.stream.info));
    const ready = new Promise((resolve, reject) => { h.ready = resolve; h.fail = reject; });
    historyLoop(h).catch(error => { h.error = error; if (!h.started) h.fail(error); else if (!h.closed && state.history === h) historyFailed(error); });
    await Promise.race([ready, sleep(15000).then(() => { throw new Error('timeout'); })]);
    const b = h.buffer.buffered;
    if (b.length) h.video.currentTime = Math.max(0, b.start(0));
    await h.video.play().catch(() => {});
    await waitFrames(h.video, 10000);
  }
  function historyFailed(error) {
    if (error.message === 'changed') { lost(); return; }
    toast('지난 구간을 더 불러올 수 없어 실시간으로 돌아갑니다.'); goLive(true);
  }
  // Starts playback at positionMs from the recording; the current picture keeps playing until the first chunk is decoded.
  async function seekTo(positionMs) {
    const stream = state.stream, ranges = dvr.index?.ranges;
    if (!stream || !state.connected || !ranges || !ranges.length || state.switching || !dvrSupported(stream.info)) { showTimeline(); return false; }
    const token = ++dvr.token;
    closeHistory(dvr.pending); dvr.pending = null;
    let target = Math.max(ranges[0].startMs, positionMs);
    if (!ranges.some(r => target >= r.startMs && target < r.endMs)) { const after = nextRangeStart(target); if (after === null) { if (state.history) goLive(); else showTimeline(); return false; } target = after; }
    if (liveEdge() - target < 1500) { if (state.history) goLive(); else showTimeline(); return false; }
    const current = state.history;
    if (current && current.started) {
      const t = (target - current.base) / 1000, b = current.buffer.buffered;
      for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t < b.end(i) - 0.5) { current.video.currentTime = t; showTimeline(); return true; }
    }
    let h = null;
    try {
      h = createHistory(stream, target); h.token = token; dvr.pending = h;
      await startHistory(h);
      if (h.error) throw h.error;
      if (token !== dvr.token || state.stream !== stream || !state.connected || state.switching) { closeHistory(h); return false; }
    } catch (error) {
      closeHistory(h);
      if (dvr.pending === h) dvr.pending = null;
      if (token === dvr.token) { if (error.message === 'changed') lost(); else toast('선택한 시점을 재생할 수 없습니다.'); showTimeline(); }
      return false;
    }
    dvr.pending = null;
    const oldVideo = state.video, oldHistory = state.history, oldSession = state.session;
    state.history = h; state.video = h.video; state.session = null; state.pausedLive = null;
    if (oldVideo && document.pictureInPictureElement === oldVideo) document.exitPictureInPicture().catch(() => {});
    if (oldVideo) oldVideo.replaceWith(h.video); else viewerCanvas.after(h.video);
    closeSession(oldSession); closeHistory(oldHistory);
    applyPlayerVolume(h.video);
    if (state.paused) h.video.pause();
    else if (!h.video.muted) await h.video.play().catch(error => { if (error.name !== 'NotAllowedError') return; mutedByBrowser(h.video); });
    document.dispatchEvent(new CustomEvent('frame:media'));
    qualityLabel(); showTimeline(); log('수신', '지난 구간 재생 ' + clock(target - ranges[0].startMs));
    return true;
  }
  async function goLive(afterFailure = false) {
    if (!state.stream || state.switching) return;
    if (!state.history) {
      // Paused on live: forget the paused moment and continue with the live picture.
      if (state.pausedLive) { state.pausedLive = null; if (state.paused) pause(); else showTimeline(); }
      return;
    }
    dvr.token++; closeHistory(dvr.pending); dvr.pending = null; state.switching = true;
    const resume = state.paused;
    let failed = false;
    try { await openLive(liveQuality()); state.pausedLive = null; if (resume && state.paused) pause(); log('수신', '실시간으로 복귀'); }
    catch { failed = true; if (!afterFailure) toast('실시간 영상으로 돌아갈 수 없습니다.'); }
    finally { state.switching = false; qualityLabel(); showTimeline(); }
    if (failed && afterFailure) lost();
  }
  $('player-seek').addEventListener('pointerdown', () => { dvr.dragging = true; });
  document.addEventListener('pointerup', () => { if (dvr.dragging) setTimeout(() => { dvr.dragging = false; }, 0); });
  document.addEventListener('frame:seek', ({ detail }) => { dvr.dragging = false; if (detail && Number.isFinite(detail.positionMs)) seekTo(detail.positionMs); });
  document.addEventListener('frame:live', () => goLive());

  // ---- Chat: one WebSocket per panel (sender, viewer) to the broadcast's own server ------------------------------
  // The server confirms every message and name; nothing is shown as sent before its acknowledgement arrives.
  const chats = { sender: null, viewer: null };
  const chatUi = (method, data, context) => window.FrameUI && window.FrameUI[method](data, context);
  const savedChatName = () => { try { return localStorage.getItem('frame.chatName') || ''; } catch { return ''; } };
  function chatOpen(context, base, path, broadcastId) {
    if (chats[context] && chats[context].broadcastId === broadcastId && chats[context].base === base) return;
    chatClose(context);
    const entry = { context, base, path, broadcastId, ws: null, retry: 0, closed: false, timer: 0, serverName: '', pending: new Map() };
    chats[context] = entry;
    chatUi('setChatState', { connected: false, canSend: false, broadcastId, error: '' }, context);
    chatConnect(entry);
  }
  function chatClose(context) {
    const entry = chats[context];
    if (!entry) return;
    entry.closed = true; clearTimeout(entry.timer); chats[context] = null;
    for (const clientId of entry.pending.keys()) chatUi('ackMessage', { clientId, ok: false, error: '채팅 연결이 종료되었습니다.' }, context);
    try { entry.ws?.close(); } catch {}
    chatUi('setChatState', { connected: false, canSend: false }, context);
  }
  function chatConnect(entry) {
    if (entry.closed) return;
    let ws;
    try { ws = new WebSocket(entry.base.replace(/^http/, 'ws') + '/' + encodeURIComponent(entry.path) + '/chat'); }
    catch { chatRetry(entry); return; }
    entry.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', broadcastId: entry.broadcastId, name: savedChatName() })));
    ws.addEventListener('message', ({ data }) => { if (entry.ws === ws) chatEvent(entry, data); });
    ws.addEventListener('close', () => {
      if (entry.ws !== ws) return;
      entry.ws = null;
      for (const clientId of entry.pending.keys()) chatUi('ackMessage', { clientId, ok: false, error: '채팅 서버와 연결이 끊어져 전송하지 못했습니다.' }, entry.context);
      entry.pending.clear();
      if (entry.closed) return;
      chatUi('setChatState', { connected: false, canSend: false, error: '채팅 서버와 연결이 끊어졌습니다. 다시 연결하는 중입니다.' }, entry.context);
      chatRetry(entry);
    });
  }
  function chatRetry(entry) {
    if (entry.closed) return;
    const delay = Math.min(10000, 1000 * Math.pow(2, entry.retry++));
    entry.timer = setTimeout(() => chatConnect(entry), delay);
  }
  function chatEvent(entry, data) {
    let event; try { event = JSON.parse(data); } catch { return; }
    const context = entry.context, message = item => ({ id: item.id, broadcastId: item.broadcastId, author: item.author, text: item.text });
    if (event.type === 'state') {
      entry.retry = 0;
      if (event.connected) entry.serverName = event.displayName || '';
      const update = { connected: !!event.connected, canSend: !!event.canSend, broadcastId: event.broadcastId || entry.broadcastId, error: event.error || '' };
      if (event.connected) update.displayName = event.displayName || '';
      chatUi('setChatState', update, context);
      if (!event.connected) { entry.closed = true; }
    } else if (event.type === 'history') chatUi('setMessages', (event.messages || []).map(message), context);
    else if (event.type === 'message') chatUi('appendMessage', message(event), context);
    else if (event.type === 'ack') { entry.pending.delete(event.clientId); chatUi('ackMessage', { clientId: event.clientId, ok: !!event.ok, error: event.error || '' }, context); }
    else if (event.type === 'name') {
      entry.serverName = event.displayName || '';
      chatUi('setChatState', { displayName: entry.serverName, error: event.ok ? '' : event.error || '이름을 바꿀 수 없습니다.' }, context);
      if (event.ok) try { localStorage.setItem('frame.chatName', entry.serverName); } catch {}
    } else if (event.type === 'closed') { entry.closed = true; chatUi('setChatState', { connected: false, canSend: false, error: event.reason || '방송이 종료되었습니다.' }, context); }
  }
  document.addEventListener('frame:send-message', ({ detail }) => {
    const entry = detail && chats[detail.context === 'sender' ? 'sender' : 'viewer'];
    if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN || detail.broadcastId !== entry.broadcastId) {
      chatUi('ackMessage', { clientId: detail?.clientId, ok: false, error: '채팅 서버에 연결되어 있지 않습니다.' }, detail?.context === 'sender' ? 'sender' : 'viewer');
      return;
    }
    // The server keeps the name per connection; bring it in line with the name chosen in this browser before sending.
    if (detail.displayName && detail.displayName !== entry.serverName) entry.ws.send(JSON.stringify({ type: 'name', name: detail.displayName }));
    entry.pending.set(detail.clientId, true);
    entry.ws.send(JSON.stringify({ type: 'send', clientId: detail.clientId, text: detail.text }));
  });
  document.addEventListener('frame:set-chat-name', ({ detail }) => {
    const entry = detail && chats[detail.context === 'sender' ? 'sender' : 'viewer'];
    if (entry && entry.ws && entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({ type: 'name', name: detail.name }));
  });

  // ---- Event wiring --------------------------------------------------------------------------------------------
  fields.forEach(id => $(id).addEventListener('input', () => { syncEncodingOptions(); updateAddress(); validate(true); senderUI(); }));
  $('sender-form').addEventListener('submit', event => { event.preventDefault(); if ($('sender-settings-dialog').open || state.starting || state.stopping || remote) return; if (state.running) $('stop-dialog').showModal(); else begin(); });
  $('confirm-stop').addEventListener('click', () => { $('stop-dialog').close(); stop(); });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('source-dialog').addEventListener('close', closeThumbs);
  // The sender tab only works inside FrameConsole.exe on the broadcasting PC.
  const openSender = () => { if (remote) { toast('송출은 송출 PC의 FRAME Console에서 시작합니다.'); return false; } view('sender'); return true; };
  $('tab-sender').addEventListener('click', openSender); $('tab-viewer').addEventListener('click', () => view('viewer'));
  $('open-viewer').addEventListener('click', () => { if (!state.running) return; view('viewer'); if (!state.connected) connect({ base: 'http://' + config().host + ':' + config().viewerPort, host: config().host, port: config().viewerPort, path: config().path }); });
  document.querySelector('[role=tablist]').addEventListener('keydown', event => { if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const target = event.key === 'Home' ? 'sender' : event.key === 'End' ? 'viewer' : $('tab-sender').getAttribute('aria-selected') === 'true' ? 'viewer' : 'sender'; if (target === 'sender' ? openSender() : (view('viewer'), true)) $('tab-' + target).focus(); });
  $('source-empty-button').addEventListener('click', chooseSource); $('source-button').addEventListener('click', chooseSource);
  $('confirm-source').addEventListener('click', confirmSource);
  // "다시 연결" repeats the last attempt (a list card or a manual entry); the dialog's submit uses the typed fields.
  $('viewer-form').addEventListener('submit', event => { event.preventDefault(); connect(event.submitter && event.submitter.id === 'retry-button' && state.lastTarget ? state.lastTarget : undefined); });
  for (const id of ['viewer-host', 'viewer-stream']) $(id).addEventListener('input', () => { state.viewerEdited = true; fieldError(id, id + '-error', ''); });
  $('player-pause').addEventListener('click', pause); $('viewer-wide').addEventListener('click', wide);
  // Buttons replace their icon while handling a click, so the clicked icon may already be detached when the click reaches
  // the player: decide by the path the click took, not by where its target is now.
  const fromControl = event => event.composedPath().some(node => node instanceof Element && node.matches('button,input,[role="menu"],.player-controls,.player-quality-menu'));
  $('viewer-preview').addEventListener('click', event => { if (fromControl(event)) return; pause(); });
  $('viewer-preview').addEventListener('keydown', event => { if (event.target.closest('button,input,[role="menu"]') || event.ctrlKey || event.metaKey || event.altKey) return; const key = event.key.toLowerCase(); if (key === ' ' || key === 'k') { event.preventDefault(); pause(); } else if (key === 'f' && state.connected) { event.preventDefault(); fullscreen('viewer'); } else if (key === 't') { event.preventDefault(); wide(); } else if (key === 'm' && state.connected) { event.preventDefault(); toggleVolume('player'); } });
  for (const name of ['sender', 'viewer']) $(name + '-fullscreen').addEventListener('click', () => fullscreen(name));
  $('copy-address').addEventListener('click', async () => {
    if (!state.running) return;
    if (bridge) { native({ cmd: 'copyText', text: $('viewer-address').textContent }); return; }
    try { await navigator.clipboard.writeText($('viewer-address').textContent); copied(); }
    catch { const selection = getSelection(), range = document.createRange(); range.selectNodeContents($('viewer-address')); selection.removeAllRanges(); selection.addRange(range); toast('Ctrl+C로 복사하세요.'); }
  });
  function copied() { $('copy-label').textContent = '복사 완료'; clearTimeout(copiedTimer); copiedTimer = setTimeout(() => $('copy-label').textContent = '주소 복사', 1800); }
  $('export-log').addEventListener('click', () => { const text = [...state.logs].reverse().map(item => item.time + '\t' + item.kind + '\t' + item.message).join('\n'); const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'frame-events.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  const lastVolumes = { system: 80, mic: 100, player: 80 };
  // Sender volumes change the broadcast mix live; the player volume only affects this viewer's local playback.
  function volumeUI(channel, notify = false) {
    const range = $(channel + '-volume'), amount = Number(range.value), muted = amount === 0;
    if (amount > 0) lastVolumes[channel] = amount;
    range.style.setProperty('--fill', amount + '%'); range.setAttribute('aria-valuetext', amount + '%');
    const button = $(channel + '-mute'); button.innerHTML = icon(muted ? 'volume-off' : 'volume'); button.setAttribute('aria-pressed', String(muted));
    if (channel === 'player' && amount > 0 && state.mutedByBrowser) { state.mutedByBrowser = false; controlsActive(); }
    if (channel === 'player') { button.setAttribute('aria-label', muted ? '음소거 해제' : '음소거'); button.title = (muted ? '음소거 해제' : '음소거') + ' (M)'; if (state.video) applyPlayerVolume(state.video); }
    else { $(channel + '-volume-value').textContent = amount + '%'; button.setAttribute('aria-label', (channel === 'system' ? '시스템 오디오' : '마이크') + (muted ? ' 음소거 해제' : ' 음소거')); if (notify) native({ cmd: 'setVolume', channel, value: amount }); }
  }
  function toggleVolume(channel) { const range = $(channel + '-volume'); range.value = Number(range.value) > 0 ? 0 : lastVolumes[channel] || 80; volumeUI(channel, true); }
  for (const channel of ['system', 'mic', 'player']) { $(channel + '-volume').addEventListener('input', () => volumeUI(channel, true)); $(channel + '-mute').addEventListener('click', () => toggleVolume(channel)); volumeUI(channel); }
  function closePlayerQuality(restore = false) { $('player-quality-menu').hidden = true; $('player-settings').setAttribute('aria-expanded', 'false'); controlsActive(); if (restore) $('player-settings').focus({ preventScroll: true }); }
  // Only qualities the server actually encodes are listed: the original stream and its on-demand lower renditions.
  function renderPlayerQuality() {
    const source = sourceQuality(), sourceHeight = Number(source.split('x')[1]), names = (state.stream?.info.renditions || []).map(item => item.name);
    // The recording keeps the original stream only, so past parts play in the original quality.
    const playingHeight = state.video?.videoHeight || Number((state.playing || source).split('x')[1]);
    const detail = state.history ? sourceHeight + 'p 원본 (녹화)' : '현재 ' + playingHeight + 'p' + ((state.playing || source) === source ? ' 원본' : '');
    const choices = [{ value: 'auto', label: '자동', detail }].concat(resolutions.filter(item => item.value === source || (!state.history && !state.useHls && names.includes(item.label))).reverse());
    $('player-quality-options').replaceChildren();
    for (const choice of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quality-menu-option'; button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(state.playbackQuality === choice.value));
      const text = document.createElement('span'); text.className = 'quality-option-copy'; const label = document.createElement('span'); label.textContent = choice.label; text.append(label);
      if (choice.value === 'auto') { const detail = document.createElement('small'); detail.textContent = choice.detail; text.append(detail); }
      const check = document.createElement('span'); check.innerHTML = icon('check'); button.append(text, check.firstChild);
      button.addEventListener('click', () => { applyPlaybackQuality(choice.value); closePlayerQuality(true); }); $('player-quality-options').append(button);
    }
  }
  async function applyPlaybackQuality(value) {
    if (!state.connected || value === state.playbackQuality || state.switching) return;
    if (state.history || state.useHls || value === 'auto') {
      // Automatic mode starts from what is playing now; recorded playback is the original only (live keeps the choice).
      state.playbackQuality = value; abr.holdUpMs = ABR.minHoldUpMs; abr.lastSwitchAt = performance.now(); qualityLabel(); renderPlayerQuality();
      if (!state.history) log('화질', '재생 화질 자동');
      return;
    }
    dvr.token++; closeHistory(dvr.pending); dvr.pending = null;
    state.switching = true;
    try { await attach(value); state.playbackQuality = value; qualityLabel(); renderPlayerQuality(); log('화질', '재생 화질 ' + resolutions.find(item => item.value === value).label + ' (수동)'); }
    catch { toast('선택한 화질로 바꿀 수 없습니다.'); }
    finally { state.switching = false; }
  }
  $('player-settings').addEventListener('click', () => { const open = $('player-quality-menu').hidden; pickers.close(); renderPlayerQuality(); $('player-quality-menu').hidden = !open; $('player-settings').setAttribute('aria-expanded', String(open)); if (open) $('player-quality-options').querySelector('[aria-checked="true"]')?.focus(); });
  $('player-quality-menu').addEventListener('keydown', event => {
    const items = [...$('player-quality-options').querySelectorAll('button')], index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePlayerQuality(true); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next].focus(); }
    else if (event.key === 'Tab') closePlayerQuality(true);
  });
  document.addEventListener('pointerdown', event => { if (!$('player-quality-menu').hidden && !$('player-quality-menu').contains(event.target) && !$('player-settings').contains(event.target)) closePlayerQuality(); });
  document.addEventListener('visibilitychange', () => native({ cmd: 'previewVisible', visible: !document.hidden && !$('sender-view').hidden }));
  setInterval(() => { if (state.running) $('metric-duration').textContent = clock(Date.now() - state.startedAt); else if (!state.starting) $('metric-duration').textContent = '00:00:00'; }, 250);
  window.addEventListener('pagehide', () => closeSession(state.session));

  if (bridge) {
    bridge.addEventListener('message', ({ data: event }) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'preview') drawPreview(event);
      else if (event.type === 'stats') onStats(event);
      else if (event.type === 'perf') log('성능', event.message, 'perf');
      else if (event.type === 'log') log(event.kind, event.message);
      else if (event.type === 'state') onState(event);
      else if (event.type === 'source') onSource(event);
      else if (event.type === 'windows') { if ($('source-dialog').open) renderWindows(event.items || [], event.gen); else native({ cmd: 'thumbCancel' }); }
      else if (event.type === 'thumb') showThumb(event);
      else if (event.type === 'thumbState') onThumbState(event);
      else if (event.type === 'icon') showIcon(event);
      else if (event.type === 'copied') copied();
      else if (event.type === 'monitors') onMonitors(event.items || []);
      else if (event.type === 'encoders') { state.encoder = state.encoderSetting && state.encoderSetting !== 'auto' ? state.encoderSetting : (event.available || [])[0]; if (!state.running && !state.starting) syncEncodingOptions(); }
      else if (event.type === 'init') onInit(event);
    });
  } else {
    // Viewer page served by the broadcasting PC: the address bar already names the server and the stream.
    const path = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '');
    $('server-host').value = location.hostname; $('viewer-host').value = location.hostname; if (validPath(path)) { $('stream-path').value = path; $('viewer-stream').value = path; }
    state.viewerEdited = true;
  }
  $('viewer-receive-port').value = remote ? (location.port || (location.protocol === 'https:' ? '443' : '80')) : config().viewerPort;
  window.FrameRuntime = {
    connect, validate, view, chooseSource, notify: toast,
    disconnect() { endPlayback('수신을 종료했습니다', '목록에서 영상을 선택하십시오.', false); },
    get connected() { return state.connected; }, get connecting() { return state.connecting; },
    get remote() { return remote; }, get running() { return state.running; },
    get video() { return state.video; }, get stream() { return state.stream; },
    // Playback position source for measurements: the recording's time axis while history plays.
    get abr() { return { mode: state.playbackQuality, playing: state.playing, holdUpMs: abr.holdUpMs, decisions: abr.decisions.slice(-20), last: abr.samples.at(-1) || null }; },
    get playback() { return { mode: state.history ? 'history' : 'live', base: state.history ? state.history.base : null, ranges: dvr.index ? dvr.index.ranges : null }; },
    prepareManual,
    get catalogBase() { return remote ? '' : state.viewerServerPort ? 'http://127.0.0.1:' + state.viewerServerPort : null; }
  };
  updateAddress(); senderUI(); history.scrollRestoration = 'manual';
  view(remote || new URLSearchParams(location.search).get('view') === 'viewer' ? 'viewer' : 'sender');
  native({ cmd: 'hello' });
})();
