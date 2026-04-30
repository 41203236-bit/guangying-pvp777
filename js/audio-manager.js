(function () {
  const SETTINGS_KEY = 'lightShadow.audio';
  const SESSION_KEY = 'lightShadow.audioSession';
  const DEFAULT_STATE = Object.freeze({
    bgmVolume: 70
  });

  const PLAYLISTS = Object.freeze({
    name_shared: ['sounds/bgm/bgm_name_01.mp3', 'sounds/bgm/bgm_name_02.mp3'],
    lobby: ['sounds/bgm/bgm_lobby_01.mp3', 'sounds/bgm/bgm_lobby_02.mp3'],
    battle_assassin: ['sounds/bgm/bgm_assassin_01.mp3', 'sounds/bgm/bgm_assassin_02.mp3'],
    battle_knight: ['sounds/bgm/bgm_knight_01.mp3', 'sounds/bgm/bgm_knight_02.mp3'],
    battle_mage: ['sounds/bgm/bgm_mage_01.mp3', 'sounds/bgm/bgm_mage_02.mp3']
  });

  const pageConfigs = {
    name: {
      playlistKey: 'name_shared',
      mountMode: 'fixedTopLeft',
      showUnlockOverlay: false
    },
    character: {
      playlistKey: 'name_shared',
      mountMode: 'characterBelowCamp',
      showUnlockOverlay: false
    },
    room: {
      playlistKey: 'lobby',
      mountMode: 'fixedTopLeft',
      showUnlockOverlay: false
    },
    battle: {
      mountMode: 'battleBelowRoomChip',
      showUnlockOverlay: false
    }
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function readSessionJson(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function readState() {
    const parsed = readJson(SETTINGS_KEY, null) || {};
    return {
      bgmVolume: Number.isFinite(parsed.bgmVolume) ? clamp(parsed.bgmVolume, 0, 100) : DEFAULT_STATE.bgmVolume
    };
  }

  function saveState() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state));
    } catch (error) {}
  }

  function readSession() {
    return readSessionJson(SESSION_KEY, null);
  }

  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        playlistKey: currentPlaylistKey,
        trackIndex: currentTrackIndex,
        currentTime: audioEl ? audioEl.currentTime : 0,
        timestamp: Date.now()
      }));
    } catch (error) {}
  }

  const state = readState();


  function isAudioUnlocked() {
    try {
      return sessionStorage.getItem('lightShadow.audioUnlocked') === '1';
    } catch (error) {
      return false;
    }
  }

  function setAudioUnlocked(value) {
    try {
      if (value) sessionStorage.setItem('lightShadow.audioUnlocked', '1');
      else sessionStorage.removeItem('lightShadow.audioUnlocked');
    } catch (error) {}
  }

  function resetFirstPageAudioGate() {
    setAudioUnlocked(false);
    try { sessionStorage.removeItem(SESSION_KEY); } catch (error) {}
  }
  let currentPlaylistKey = '';
  let currentPlaylist = [];
  let currentTrackIndex = 0;
  let pageType = '';
  let audioEl = null;
  let controlRoot = null;
  let overlayEl = null;
  let fadeTimer = null;
  let persistTimer = null;
  let lastSavedTime = -1;

  function ensureAudio() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.volume = state.bgmVolume / 100;
    audioEl.addEventListener('ended', handleTrackEnded);
    audioEl.addEventListener('timeupdate', maybePersistSession);
    window.addEventListener('pagehide', saveSession);
    window.addEventListener('beforeunload', saveSession);
    return audioEl;
  }

  function maybePersistSession() {
    if (!audioEl || !currentPlaylistKey) return;
    const rounded = Math.floor(audioEl.currentTime || 0);
    if (rounded === lastSavedTime) return;
    lastSavedTime = rounded;
    saveSession();
  }

  function getPlaylistForRole(role) {
    if (role === 'assassin') return { key: 'battle_assassin', list: PLAYLISTS.battle_assassin };
    if (role === 'mage') return { key: 'battle_mage', list: PLAYLISTS.battle_mage };
    return { key: 'battle_knight', list: PLAYLISTS.battle_knight };
  }

  function inferBattleRole(explicitRole) {
    if (explicitRole) return explicitRole;
    try {
      if (window.LightShadowStorage && window.LightShadowStorage.getSelectedCharacter) {
        const stored = window.LightShadowStorage.getSelectedCharacter();
        if (stored) return stored;
      }
    } catch (error) {}
    return 'knight';
  }

  function resolvePageConfig(page, options) {
    const config = pageConfigs[page];
    if (!config) return null;
    if (page !== 'battle') return config;
    const role = inferBattleRole(options && options.role);
    const battlePlaylist = getPlaylistForRole(role);
    return {
      playlistKey: battlePlaylist.key,
      playlist: battlePlaylist.list,
      mountMode: config.mountMode,
      showUnlockOverlay: config.showUnlockOverlay,
      role
    };
  }

  function handleTrackEnded() {
    if (!currentPlaylist.length || !audioEl) return;
    currentTrackIndex = (currentTrackIndex + 1) % currentPlaylist.length;
    audioEl.src = currentPlaylist[currentTrackIndex];
    audioEl.currentTime = 0;
    saveSession();
    audioEl.play().catch(() => {});
    syncControlDisplay();
  }

  function clearFadeTimer() {
    if (!fadeTimer) return;
    window.clearInterval(fadeTimer);
    fadeTimer = null;
  }

  function applyVolumeNow() {
    const player = ensureAudio();
    player.volume = state.bgmVolume / 100;
  }

  function setVolume(volume) {
    state.bgmVolume = clamp(volume, 0, 100);
    saveState();
    clearFadeTimer();
    applyVolumeNow();
    syncControlDisplay();
  }

  function resumeMatchingSession(player, playlistKey) {
    const session = readSession();
    if (!session || session.playlistKey !== playlistKey) return false;
    if (!Number.isFinite(session.trackIndex)) return false;
    const index = clamp(session.trackIndex, 0, Math.max(0, currentPlaylist.length - 1));
    currentTrackIndex = index;
    player.src = currentPlaylist[currentTrackIndex];
    player.load();
    const desiredTime = Number.isFinite(session.currentTime) ? Math.max(0, session.currentTime) : 0;
    if (desiredTime > 0) {
      const applyTime = () => {
        try { player.currentTime = desiredTime; } catch (error) {}
      };
      player.addEventListener('loadedmetadata', applyTime, { once: true });
    }
    return true;
  }

  function setPlaylistByKey(playlistKey, opts) {
    const list = PLAYLISTS[playlistKey] || [];
    currentPlaylistKey = playlistKey || '';
    currentPlaylist = Array.isArray(list) ? list.slice() : [];
    currentTrackIndex = 0;
    if (!currentPlaylist.length) {
      syncControlDisplay();
      return;
    }

    const player = ensureAudio();
    clearFadeTimer();
    const shouldResume = !(opts && opts.forceRestart) && resumeMatchingSession(player, currentPlaylistKey);
    if (!shouldResume) {
      player.src = currentPlaylist[0];
      player.currentTime = 0;
      player.load();
      saveSession();
    }
    applyVolumeNow();
    if (isAudioUnlocked()) player.play().catch(() => {});
    syncControlDisplay();
  }

  function unlockAudioAndPlay() {
    setAudioUnlocked(true);
    hideUnlockOverlay();
    if (!currentPlaylist.length) return;
    const player = ensureAudio();
    applyVolumeNow();
    if (!player.src) player.src = currentPlaylist[currentTrackIndex] || currentPlaylist[0];
    saveSession();
    player.play().catch(() => {});
    syncControlDisplay();
  }

  function fadeOutBgm(durationMs) {
    const player = ensureAudio();
    if (!player || player.paused || !player.src) return;
    clearFadeTimer();
    const steps = Math.max(1, Math.round((durationMs || 3000) / 100));
    const startVolume = player.volume;
    let currentStep = 0;
    fadeTimer = window.setInterval(() => {
      currentStep += 1;
      const nextVolume = Math.max(0, startVolume * (1 - currentStep / steps));
      player.volume = nextVolume;
      if (currentStep >= steps) {
        clearFadeTimer();
        player.pause();
        player.currentTime = 0;
        applyVolumeNow();
        saveSession();
        syncControlDisplay();
      }
    }, 100);
  }

  function pauseBgm() {
    const player = ensureAudio();
    if (!player || !player.src || player.paused) return;
    clearFadeTimer();
    player.pause();
    saveSession();
    syncControlDisplay();
  }

  function resumeBgm() {
    const player = ensureAudio();
    if (!player || !player.src || !isAudioUnlocked()) return;
    clearFadeTimer();
    applyVolumeNow();
    player.play().catch(() => {});
    syncControlDisplay();
  }

  function createControlUI() {
    const root = document.createElement('section');
    root.className = 'audio-control-card';
    root.setAttribute('aria-label', 'BGM 音量控制');
    root.innerHTML = `
      <div class="audio-control-title">BGM</div>
      <div class="audio-control-row">
        <input class="audio-volume-slider" type="range" min="0" max="100" step="1" value="${state.bgmVolume}" aria-label="BGM 音量調節">
        <span class="audio-volume-value">${state.bgmVolume}%</span>
      </div>
      <p class="audio-control-track">待命中</p>
    `;
    const slider = root.querySelector('.audio-volume-slider');
    slider.addEventListener('input', function () {
      setVolume(Number(slider.value));
    });
    controlRoot = root;
    return root;
  }

  function syncControlDisplay() {
    if (!controlRoot) return;
    const slider = controlRoot.querySelector('.audio-volume-slider');
    const valueEl = controlRoot.querySelector('.audio-volume-value');
    const trackEl = controlRoot.querySelector('.audio-control-track');
    if (slider) slider.value = String(state.bgmVolume);
    if (valueEl) valueEl.textContent = `${state.bgmVolume}%`;
    if (trackEl) {
      const lockedText = isAudioUnlocked() ? '' : '（等待點擊啟用）';
      const trackName = currentPlaylist[currentTrackIndex]
        ? currentPlaylist[currentTrackIndex].split('/').pop()
        : '待命中';
      trackEl.textContent = `目前播放：${trackName}${lockedText}`;
    }
  }

  function mountControls(mode) {
    const root = createControlUI();
    if (mode === 'characterBelowCamp') {
      const playerPanel = document.querySelector('.character-topbar .player-panel');
      if (playerPanel) {
        root.classList.add('is-character-inline');
        playerPanel.appendChild(root);
        syncControlDisplay();
        return;
      }
    }
    if (mode === 'battleBelowRoomChip') {
      root.classList.add('is-battle-under-room');
      document.body.appendChild(root);
      syncControlDisplay();
      return;
    }
    root.classList.add('is-fixed-top-left');
    document.body.appendChild(root);
    syncControlDisplay();
  }

  function createUnlockOverlay() {
    if (overlayEl) return overlayEl;
    const overlay = document.createElement('button');
    overlay.type = 'button';
    overlay.className = 'audio-unlock-overlay';
    overlay.innerHTML = `
      <span class="audio-unlock-main">點擊空白處開始</span>
      <span class="audio-unlock-sub">啟用 BGM 播放</span>
    `;
    overlay.addEventListener('click', function () {
      unlockAudioAndPlay();
    });
    overlayEl = overlay;
    return overlay;
  }

  function hideUnlockOverlay() {
    if (!overlayEl) return;
    overlayEl.classList.add('is-hidden');
  }

  function maybeMountUnlockOverlay(showOverlay) {
    if (!showOverlay) return;
    if (isAudioUnlocked()) return;
    document.body.appendChild(createUnlockOverlay());
  }

  function injectStyles() {
    if (document.getElementById('audio-manager-styles')) return;
    const style = document.createElement('style');
    style.id = 'audio-manager-styles';
    style.textContent = `
      .audio-control-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(8, 12, 20, 0.82);
        backdrop-filter: blur(10px);
        box-shadow: 0 10px 26px rgba(0,0,0,0.24);
        color: #f5f7ff;
        z-index: 30;
        max-width: 240px;
      }
      .audio-control-card.is-fixed-top-left {
        position: fixed;
        top: 14px;
        left: 14px;
      }
      .audio-control-card.is-character-inline {
        margin-top: 10px;
        align-self: flex-start;
      }
      .audio-control-card.is-battle-under-room {
        position: fixed;
        top: 66px;
        left: 14px;
      }
      .audio-control-title { font-size: 13px; font-weight: 800; letter-spacing: 0.08em; }
      .audio-control-row { display:flex; align-items:center; gap:10px; }
      .audio-volume-slider { flex: 1; }
      .audio-volume-value { min-width: 44px; text-align:right; font-size: 12px; font-weight: 700; }
      .audio-control-track { margin:0; font-size: 11px; opacity: 0.88; word-break: break-all; }
      .audio-unlock-overlay {
        position: fixed;
        inset: 0;
        z-index: 45;
        border: 0;
        background: rgba(6, 8, 16, 0.72);
        color: #fff;
        display:flex;
        flex-direction: column;
        align-items:center;
        justify-content:center;
        gap: 10px;
        cursor: pointer;
      }
      .audio-unlock-overlay.is-hidden { display:none; }
      .audio-unlock-main { font-size: clamp(28px, 4vw, 42px); font-weight: 900; }
      .audio-unlock-sub { font-size: 14px; opacity: 0.86; }
    `;
    document.head.appendChild(style);
  }

  function inferPageType() {
    if (document.body.querySelector('#name-form')) return 'name';
    if (document.body.querySelector('#character-cards')) return 'character';
    if (document.body.querySelector('#room-center-title')) return 'room';
    if (document.body.querySelector('#battle-grid')) return 'battle';
    return '';
  }

  function init(explicitPageType, options) {
    injectStyles();
    pageType = explicitPageType || inferPageType();
    if (pageType === 'name') resetFirstPageAudioGate();
    const config = resolvePageConfig(pageType, options);
    if (!config) return;
    mountControls(config.mountMode);
    setPlaylistByKey(config.playlistKey, { forceRestart: false });
    maybeMountUnlockOverlay(config.showUnlockOverlay);
  }

  window.LightShadowAudio = {
    init,
    setPlaylistByKey,
    unlockAudioAndPlay,
    setVolume,
    fadeOutBgm,
    pauseBgm,
    resumeBgm,
    getState: function () { return { ...state }; },
    getSession: readSession
  };
})();
