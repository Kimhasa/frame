(() => {
  'use strict';
  // Inside FrameConsole.exe the WebView2 bridge drives capture, encoding and serving. Opened from another PC's browser,
  // the same page runs as a viewer only and talks to the server's read-only info and WHEP endpoints.
  const $ = id => document.getElementById(id);
  const bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const remote = !bridge;
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
    { value: 'none', label: '사용 안 함' }, { value: 'system', label: '시스템 소리' },
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
  function syncEncodingOptions() {
    const c = config(), locked = state.running || state.starting;
    $('custom-fps-field').hidden = $('fps').value !== 'custom';
    $('custom-fps').disabled = locked || $('fps').value !== 'custom';
    $('fps-hint').hidden = !Number.isFinite(c.fps) || c.fps <= 60;
    if ($('bitrate-auto').checked) {
      const base = resolutions.find(item => item.value === c.resolution)?.bitrate || 8;
      const fps = Number.isFinite(c.fps) && c.fps >= 30 ? c.fps : 60;
      $('quality').value = Math.min(200, Math.max(0.5, Math.round(base * fps / 60 * 2) / 2));
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
  function badge(id, text, active = false) { $(id).textContent = text; $(id).classList.toggle('active', active); }
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
  function updateAddress() { const c = config(); $('viewer-address').textContent = 'http://' + c.host + ':' + c.viewerPort + '/' + c.path; $('preview-resolution').textContent = c.resolution.split('x')[1] + 'p / ' + (Number.isFinite(c.fps) ? c.fps : '—') + ' fps'; }
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
  async function drawPreview(event) {
    try {
      previewImage.src = 'data:image/jpeg;base64,' + event.jpeg;
      await previewImage.decode();
      if (!state.source) return;
      if (previewCanvas.width !== event.width || previewCanvas.height !== event.height) { previewCanvas.width = event.width; previewCanvas.height = event.height; }
      previewContext.drawImage(previewImage, 0, 0);
    } catch {} finally { native({ cmd: 'previewAck' }); }
  }
  const measure = document.createElement('canvas').getContext('2d');
  function fitLabel(text, width) {
    measure.font = '15px Pretendard, sans-serif';
    if (measure.measureText(text).width <= width) return text;
    let low = 0, high = text.length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (measure.measureText(text.slice(0, mid) + '…').width <= width) low = mid; else high = mid - 1; }
    return text.slice(0, low) + '…';
  }
  function markSelected() { document.querySelectorAll('[data-source]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.source === state.selected))); $('confirm-source').disabled = !state.selected; }
  function renderWindows(items) {
    state.windows = items;
    const box = document.querySelector('.source-options'), counts = {};
    items.forEach(item => counts[item.title] = (counts[item.title] || 0) + 1);
    box.replaceChildren();
    const width = Math.max(120, (box.clientWidth - 14) / 2 - 32);
    for (const item of items) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'source-choice'; button.dataset.source = item.id;
      const name = counts[item.title] > 1 && item.exe ? item.title + ' (' + item.exe + ')' : item.title;
      button.title = name + (item.minimized ? ' (최소화됨)' : '');
      const thumb = document.createElement('span'); thumb.className = 'source-thumb'; thumb.innerHTML = icon('monitor');
      const label = document.createElement('span'); label.className = 'source-label'; label.textContent = fitLabel(name, width);
      button.append(thumb, label);
      button.addEventListener('click', () => { state.selected = item.id; markSelected(); });
      button.addEventListener('dblclick', () => { state.selected = item.id; confirmSource(); });
      box.append(button);
    }
    if (!items.length) { const empty = document.createElement('p'); empty.textContent = '공유할 수 있는 창이 없습니다.'; box.append(empty); }
    if (!items.some(item => item.id === state.selected)) state.selected = null;
    markSelected();
  }
  function showThumb(event) {
    const thumb = document.querySelector('[data-source="' + CSS.escape(event.id) + '"] .source-thumb');
    if (!thumb) return;
    const image = document.createElement('img'); image.alt = ''; image.src = 'data:image/jpeg;base64,' + event.jpeg;
    image.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
    thumb.replaceChildren(image);
  }
  function chooseSource() {
    if (remote) return;
    state.selected = state.source; renderWindows([]); document.querySelector('.source-options').replaceChildren();
    $('confirm-source').disabled = true; $('source-dialog').showModal(); native({ cmd: 'listWindows' });
  }
  function confirmSource() { if (!state.selected) return; native({ cmd: 'selectWindow', id: state.selected }); $('source-dialog').close(); }
  function onSource(event) {
    if (event.ok) { state.source = event.id; state.sourceTitle = event.title; state.failed = ''; showSource(event.title); if (event.minimized) toast('최소화된 창은 다시 표시해야 화면이 갱신됩니다.'); }
    else { if (event.closed || !state.source) { state.source = null; state.sourceTitle = ''; showSource(''); } if (event.message) toast(event.message); }
    senderUI();
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
    lockSettings(true);
    $('start-button').className = 'danger start-button'; $('start-button').innerHTML = icon('stop') + '<span>송출 중지</span>';
    $('metric-fps').textContent = status?.fps || config().fps; $('metric-bitrate').textContent = '—'; senderUI();
  }
  function stoppedUI() {
    state.running = false; state.starting = false; state.stopping = false; lockSettings(false);
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
    $('server-host').value = s.serverHost; $('stream-path').value = s.streamPath; $('resolution').value = s.resolution;
    if (fpsPresets.includes(s.fps)) $('fps').value = String(s.fps); else { $('fps').value = 'custom'; $('custom-fps').value = s.fps; }
    $('bitrate-auto').checked = s.bitrateAuto; $('quality').value = s.bitrateMbps; $('audio-source').value = s.audio;
    $('system-volume').value = s.systemVolume; $('mic-volume').value = s.micVolume; $('publish-port').value = s.publishPort; $('viewer-port').value = s.viewerPort;
    for (const channel of ['system', 'mic']) volumeUI(channel);
    syncEncodingOptions(); updateAddress(); validate(true); senderUI();
  }
  function onInit(event) {
    applySettings(event.settings);
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
  function viewerBase(host) { return (remote ? location.protocol : 'http:') + '//' + host + ':' + (remote ? (location.port || (location.protocol === 'https:' ? '443' : '80')) : config().viewerPort); }
  const isLocalStream = () => !remote && state.stream && state.stream.host.toLowerCase() === config().host.toLowerCase() && state.stream.path === config().path;
  async function fetchInfo(base, path) {
    const response = await fetch(base + '/' + encodeURIComponent(path) + '/info', { cache: 'no-store' });
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
  function applyPlayerVolume(video) { const amount = Number($('player-volume').value); video.volume = amount / 100; video.muted = amount === 0; }
  const renditionPath = (path, quality) => quality === 'auto' || quality === sourceQuality() ? path : path + '/' + resolutions.find(item => item.value === quality).label;
  const sourceQuality = () => state.stream ? state.stream.info.width + 'x' + state.stream.info.height : config().resolution;
  // Starts a WHEP session and swaps it into the player once its first frame is decoded; the old session keeps playing until then.
  async function attach(quality) {
    const stream = state.stream, session = await openSession(stream.base, renditionPath(stream.path, quality), stream.info.iceServers);
    // Muted until it replaces the current picture, so a quality switch never plays two soundtracks.
    const video = makeVideo(); video.srcObject = session.media; video.muted = true;
    try { await video.play().catch(() => {}); await waitFrames(video, 15000); }
    catch (error) { closeSession(session); throw error; }
    if (state.stream !== stream) { closeSession(session); return; }
    const previous = state.session, oldVideo = state.video;
    state.session = session; state.video = video; state.playbackQuality = quality; state.lastBytes = 0;
    if (oldVideo) oldVideo.replaceWith(video); else viewerCanvas.after(video);
    closeSession(previous);
    applyPlayerVolume(video);
    if (!video.muted) await video.play().catch(error => { if (error.name !== 'NotAllowedError') return; video.muted = true; $('player-volume').value = 0; volumeUI('player'); video.play().catch(() => {}); toast('브라우저 설정으로 음소거 상태로 재생합니다.'); });
    if (state.paused) video.pause();
    session.pc.addEventListener('connectionstatechange', () => { if (state.session === session && ['failed', 'closed'].includes(session.pc.connectionState)) lost(); else if (state.session === session && session.pc.connectionState === 'disconnected') setTimeout(() => { if (state.session === session && session.pc.connectionState === 'disconnected') lost(); }, 3000); });
  }
  function infoText() {
    const info = state.stream?.info;
    if (!info) return;
    $('info-fps').textContent = info.fps + ' fps'; $('info-audio').textContent = audioSources.find(item => item.value === info.audio)?.label || '사용 안 함';
    if (!$('info-bitrate').dataset.measured) $('info-bitrate').textContent = Number(info.bitrate).toFixed(1) + ' Mbps';
  }
  function qualityLabel() {
    const height = state.video?.videoHeight || Number((state.playbackQuality === 'auto' ? sourceQuality() : state.playbackQuality).split('x')[1]);
    $('player-quality-label').textContent = height + 'p'; $('player-settings').title = '재생 화질: ' + (state.playbackQuality === 'auto' ? '자동 (' + height + 'p)' : height + 'p');
    $('info-resolution').textContent = height + 'p' + (state.playbackQuality === 'auto' ? ' (자동)' : '');
  }
  function receiver(connected, heading, description, retry = false) {
    state.connected = connected; state.paused = false;
    badge('viewer-status', connected ? '수신 중' : '대기', connected);
    $('no-signal').hidden = connected; $('player-controls').hidden = !connected; $('pause-overlay').hidden = true;
    $('connect-button').textContent = connected ? '연결 해제' : '연결'; $('connect-button').className = connected ? 'danger connect-button' : 'primary connect-button';
    $('viewer-host').disabled = connected; $('viewer-stream').disabled = connected;
    $('viewer-title').textContent = connected ? state.stream.path : '수신 화면';
    if (!connected) { for (const id of ['info-resolution', 'info-fps', 'info-bitrate', 'info-audio']) $(id).textContent = '—'; delete $('info-bitrate').dataset.measured; }
    closePlayerQuality();
    $('retry-button').hidden = connected || !retry;
    if (heading) $('empty-heading').textContent = heading;
    if (description) $('empty-description').textContent = description;
    $('player-pause').innerHTML = icon('pause') + '<span class="control-label">일시정지</span>'; $('player-pause').setAttribute('aria-label', '일시정지'); $('player-pause').title = '일시정지 (Space)';
    if (!connected) { $('viewer-view').classList.remove('is-wide'); $('viewer-wide').setAttribute('aria-pressed', 'false'); $('viewer-wide').setAttribute('aria-label', '넓게 보기'); $('viewer-wide').innerHTML = icon('layout') + '<span class="control-label">넓게 보기</span>'; }
    else { infoText(); qualityLabel(); }
  }
  function endPlayback(heading, description, retry = true) {
    const stream = state.stream;
    state.stream = null; state.connecting = false; clearInterval(state.statsTimer);
    closeSession(state.session); state.session = null;
    if (state.video) { state.video.srcObject = null; state.video.remove(); state.video = null; }
    if (heading) receiver(false, heading, description, retry);
    return stream;
  }
  async function connect() {
    const host = $('viewer-host').value.trim(), path = $('viewer-stream').value.trim();
    fieldError('viewer-host', 'viewer-host-error', validHost(host) ? '' : '서버 주소를 확인하세요.');
    fieldError('viewer-stream', 'viewer-stream-error', validPath(path) ? '' : '스트림 이름을 확인하세요.');
    if (!validHost(host) || !validPath(path)) { receiver(false, '입력한 주소를 확인하세요', '연결 설정을 수정하세요.'); badge('viewer-status', '주소 확인'); (!validHost(host) ? $('viewer-host') : $('viewer-stream')).focus(); return; }
    if (state.connecting) return;
    endPlayback();
    state.connecting = true; $('viewer-host').disabled = true; $('viewer-stream').disabled = true; badge('viewer-status', '연결 중'); $('retry-button').hidden = true;
    const base = viewerBase(host);
    try {
      const info = await fetchInfo(base, path);
      if (!info.running) throw new Error('not-running');
      state.stream = { base, host, path, info, infoAt: Date.now() }; state.playbackQuality = 'auto';
      await attach('auto');
      state.connecting = false; state.attempt = 0;
      receiver(true); log('수신', path + ' 연결');
      state.statsTimer = setInterval(viewerStats, 1000);
    } catch (error) {
      state.connecting = false; endPlayback();
      const ended = error.message === 'not-running';
      receiver(false, ended ? '연결할 수 없습니다' : '연결할 수 없습니다', ended ? '송출 상태와 주소를 확인한 뒤 다시 연결하세요.' : '서버 주소와 방화벽 설정을 확인한 뒤 다시 연결하세요.', true);
      badge('viewer-status', '연결 안 됨'); log('수신', '연결 실패: ' + host + ' ' + path);
    }
  }
  async function lost() {
    if (!state.stream || state.connecting) return;
    const stream = state.stream;
    state.connecting = true; badge('viewer-status', '재연결 중');
    for (let attempt = 1; attempt <= 3 && state.stream === stream; attempt++) {
      try {
        const info = await fetchInfo(stream.base, stream.path);
        if (!info.running) break;
        stream.info = info; stream.infoAt = Date.now();
        await attach(state.playbackQuality);
        state.connecting = false; badge('viewer-status', state.paused ? '일시정지' : '수신 중', !state.paused); log('수신', stream.path + ' 다시 연결');
        return;
      } catch { await sleep(2000 * attempt); }
    }
    if (state.stream !== stream) return;
    let running = false;
    try { running = (await fetchInfo(stream.base, stream.path)).running; } catch {}
    endPlayback(running ? '연결이 끊어졌습니다' : '송출이 종료되었습니다', running ? '네트워크 상태를 확인한 뒤 다시 연결하세요.' : '송출을 다시 시작한 뒤 연결하세요.');
    log('수신', stream.path + (running ? ' 연결 끊김' : ' 송출 종료'));
  }
  async function viewerStats() {
    const session = state.session, stream = state.stream;
    if (!session || !stream) return;
    $('viewer-clock').textContent = clock((stream.info.elapsedMs || 0) + Date.now() - stream.infoAt);
    if (Date.now() - stream.infoAt > 5000 && !state.connecting) {
      try { const info = await fetchInfo(stream.base, stream.path); if (!info.running) { lost(); return; } if (info.elapsedMs < stream.info.elapsedMs) { lost(); return; } stream.info = info; stream.infoAt = Date.now(); infoText(); } catch {}
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
      native({ cmd: 'viewerStats', stats: sample });
    } catch {}
  }
  function pause() {
    if (!state.connected) return;
    state.paused = !state.paused; $('pause-overlay').hidden = !state.paused;
    if (state.video) { if (state.paused) state.video.pause(); else state.video.play().catch(() => {}); }
    const label = state.paused ? '재생' : '일시정지'; $('player-pause').innerHTML = icon(state.paused ? 'play' : 'pause') + '<span class="control-label">' + label + '</span>'; $('player-pause').setAttribute('aria-label', label); $('player-pause').title = label + ' (Space)'; badge('viewer-status', state.paused ? '일시정지' : '수신 중', !state.paused);
  }
  function wide() { if (!state.connected) return; const active = $('viewer-view').classList.toggle('is-wide'); const label = active ? '기본 보기' : '넓게 보기'; $('viewer-wide').setAttribute('aria-pressed', String(active)); $('viewer-wide').setAttribute('aria-label', label); $('viewer-wide').innerHTML = icon('layout') + '<span class="control-label">' + label + '</span>'; $('viewer-wide').title = label + ' (T)'; }
  async function fullscreen(name) { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $(name + '-preview').requestFullscreen(); } catch { toast('전체 화면을 열 수 없습니다.'); } }

  // ---- Event wiring --------------------------------------------------------------------------------------------
  fields.forEach(id => $(id).addEventListener('input', () => { syncEncodingOptions(); updateAddress(); validate(true); senderUI(); }));
  $('sender-form').addEventListener('submit', event => { event.preventDefault(); if (state.starting || state.stopping || remote) return; if (state.running) $('stop-dialog').showModal(); else begin(); });
  $('confirm-stop').addEventListener('click', () => { $('stop-dialog').close(); stop(); });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  // The sender tab only works inside FrameConsole.exe on the broadcasting PC.
  const openSender = () => { if (remote) { toast('송출은 송출 PC의 FRAME Console에서 시작합니다.'); return false; } view('sender'); return true; };
  $('tab-sender').addEventListener('click', openSender); $('tab-viewer').addEventListener('click', () => view('viewer'));
  $('open-viewer').addEventListener('click', () => { if (!state.running) return; $('viewer-host').value = config().host; $('viewer-stream').value = config().path; state.viewerEdited = false; view('viewer'); if (!state.connected) connect(); });
  document.querySelector('[role=tablist]').addEventListener('keydown', event => { if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const target = event.key === 'Home' ? 'sender' : event.key === 'End' ? 'viewer' : $('tab-sender').getAttribute('aria-selected') === 'true' ? 'viewer' : 'sender'; if (target === 'sender' ? openSender() : (view('viewer'), true)) $('tab-' + target).focus(); });
  $('source-empty-button').addEventListener('click', chooseSource); $('source-button').addEventListener('click', chooseSource);
  $('confirm-source').addEventListener('click', confirmSource);
  $('viewer-form').addEventListener('submit', event => { event.preventDefault(); if (state.connected) { endPlayback('연결을 해제했습니다', '다시 보려면 연결하세요.', false); log('수신', '연결 해제'); } else connect(); });
  for (const id of ['viewer-host', 'viewer-stream']) $(id).addEventListener('input', () => { state.viewerEdited = true; fieldError(id, id + '-error', ''); });
  $('player-pause').addEventListener('click', pause); $('viewer-wide').addEventListener('click', wide);
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
    if (channel === 'player') { button.setAttribute('aria-label', muted ? '음소거 해제' : '음소거'); button.title = (muted ? '음소거 해제' : '음소거') + ' (M)'; if (state.video) applyPlayerVolume(state.video); }
    else { $(channel + '-volume-value').textContent = amount + '%'; button.setAttribute('aria-label', (channel === 'system' ? '시스템 소리' : '마이크') + (muted ? ' 음소거 해제' : ' 음소거')); if (notify) native({ cmd: 'setVolume', channel, value: amount }); }
  }
  function toggleVolume(channel) { const range = $(channel + '-volume'); range.value = Number(range.value) > 0 ? 0 : lastVolumes[channel] || 80; volumeUI(channel, true); }
  for (const channel of ['system', 'mic', 'player']) { $(channel + '-volume').addEventListener('input', () => volumeUI(channel, true)); $(channel + '-mute').addEventListener('click', () => toggleVolume(channel)); volumeUI(channel); }
  function closePlayerQuality(restore = false) { $('player-quality-menu').hidden = true; $('player-settings').setAttribute('aria-expanded', 'false'); if (restore) $('player-settings').focus({ preventScroll: true }); }
  // Only qualities the server actually encodes are listed: the original stream and its on-demand lower renditions.
  function renderPlayerQuality() {
    const source = sourceQuality(), sourceHeight = Number(source.split('x')[1]), names = (state.stream?.info.renditions || []).map(item => item.name);
    const choices = [{ value: 'auto', label: '자동', detail: sourceHeight + 'p 원본' }].concat(resolutions.filter(item => item.value === source || names.includes(item.label)).reverse());
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
    state.switching = true;
    try { await attach(value); qualityLabel(); renderPlayerQuality(); log('수신', '재생 화질 ' + (value === 'auto' ? '자동' : resolutions.find(item => item.value === value).label)); }
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
      else if (event.type === 'windows') renderWindows(event.items || []);
      else if (event.type === 'thumb') showThumb(event);
      else if (event.type === 'copied') copied();
      else if (event.type === 'init') onInit(event);
    });
  } else {
    // Viewer page served by the broadcasting PC: the address bar already names the server and the stream.
    const path = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '');
    $('server-host').value = location.hostname; $('viewer-host').value = location.hostname; if (validPath(path)) { $('stream-path').value = path; $('viewer-stream').value = path; }
    state.viewerEdited = true;
  }
  updateAddress(); senderUI(); history.scrollRestoration = 'manual';
  view(remote || new URLSearchParams(location.search).get('view') === 'viewer' ? 'viewer' : 'sender');
  native({ cmd: 'hello' });
})();
