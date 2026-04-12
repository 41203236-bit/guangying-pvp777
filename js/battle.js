(function () {
  const storage = window.LightShadowStorage;
  const characters = window.LightShadowCharacterData || [];
  const firebaseApi = window.LightShadowFirebase;
  const BATTLE_PATH = 'battle_v3';
  const ROOMS_PATH = 'rooms_v3';
  const TURN_DURATION_MS = 20000;
  const TIMEOUT_POLL_MS = 500;

  const audio = window.LightShadowAudio;
  if (audio && audio.init) audio.init('battle', { role: storage.getSelectedCharacter() || 'knight' });


  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  const BASE_LINE_SP = 20;
  const CENTER_LINE_BONUS = 20;

  const els = {
    roomCode: document.getElementById('battle-room-code'),
    turnIndicator: document.getElementById('turn-indicator'),
    roundNumber: document.getElementById('battle-round-number'),
    timerValue: document.getElementById('battle-timer-value'),
    grid: document.getElementById('battle-grid'),
    boardTurnOverlay: document.getElementById('board-turn-overlay'),
    page: document.querySelector('.battle-page'),

    myIdentityBadge: document.getElementById('my-identity-badge'),
    myPortrait: document.getElementById('my-battle-portrait'),
    myName: document.getElementById('my-battle-name'),
    myRole: document.getElementById('my-battle-role'),
    myCampEffect: document.getElementById('my-camp-effect'),
    myHpPercent: document.getElementById('my-hp-percent'),
    mySpStars: document.getElementById('my-sp-stars'),
    mySpValue: document.getElementById('my-sp-value'),
    myUltStars: document.getElementById('my-ult-stars'),
    myUltValue: document.getElementById('my-ult-value'),

    enemyIdentityBadge: document.getElementById('enemy-identity-badge'),
    enemyPortrait: document.getElementById('enemy-battle-portrait'),
    enemyName: document.getElementById('enemy-battle-name'),
    enemyRole: document.getElementById('enemy-battle-role'),
    enemyCampEffect: document.getElementById('enemy-camp-effect'),
    enemyHpPercent: document.getElementById('enemy-hp-percent'),
    myFighterSide: document.getElementById('my-fighter-side'),
    enemyFighterSide: document.getElementById('enemy-fighter-side'),
    myHpBarLoss: document.getElementById('my-hp-bar-loss'),
    enemyHpBarLoss: document.getElementById('enemy-hp-bar-loss'),
    enemySpStars: document.getElementById('enemy-sp-stars'),
    enemySpValue: document.getElementById('enemy-sp-value'),
    enemyUltStars: document.getElementById('enemy-ult-stars'),
    enemyUltValue: document.getElementById('enemy-ult-value'),

    skillUsageDots: document.getElementById('skill-usage-dots'),
    endTurnButton: document.querySelector('.end-turn-button'),
    skillButtons: Array.from(document.querySelectorAll('.skill-button')),
    resultOverlay: document.getElementById('result-overlay'),
    resultTitle: document.getElementById('result-title'),
    resultQuote: document.getElementById('result-quote'),
    resultSubtitle: document.getElementById('result-subtitle'),
    resultCountdown: document.getElementById('result-countdown'),
    resultRoomButton: document.getElementById('result-room-button'),
    resultRematchButton: document.getElementById('result-rematch-button'),
    resultChoiceHint: document.getElementById('result-choice-hint'),
    ultReadyBanner: document.getElementById('ult-ready-banner'),
    ultVideoOverlay: document.getElementById('ult-video-overlay'),
    ultVideoPlayer: document.getElementById('ult-video-player'),
    ultVideoCaption: document.getElementById('ult-video-caption'),
    winVideoOverlay: document.getElementById('win-video-overlay'),
    winVideoPlayer: document.getElementById('win-video-player'),
    winVideoCaption: document.getElementById('win-video-caption')
  };

  const state = {
    roomId: '',
    unsubscribeBattle: null,
    unsubscribeRoom: null,
    selfMark: storage.getCurrentRoomMark() || storage.getPendingBattleMark() || 'O',
    disconnectTasks: [],
    battleLoaded: false,
    currentBattle: null,
    actionInFlight: false,
    timerTicker: null,
    timeoutChecker: null,
    missingBattleTimer: null,
    entryStable: false,
    entryStableTimer: null,
    opponentLeftHandled: false,
    isRedirecting: false,
    exitCleanupSent: false,
    timeoutInFlight: false,
    lineEffectTimer: null,
    shownFeedbackIds: new Set(),
    resultTimer: null,
    uiMode: 'idle',
    activeSkill: null,
    selectedSourceIndex: null,
    selectedUltPrimaryIndex: null,
    ultReadyBannerTimer: null,
    lastUltValueByMark: { O: null, X: null },
    bgmFadedForResult: false,
    handledUltVideoIds: new Set(),
    handledWinVideoIds: new Set(),
    isUltCinematicPlaying: false,
    isWinCinematicPlaying: false,
    currentUltVideoEventId: '',
    currentWinVideoEventId: '',
    lastResultVideoEventId: '',
    cinematicFailSafeTimer: null,
    frozenTimerText: ''
  };


  const SKILL_CONFIG = {
    atk: { cost: 1, ultGain: 25, damage: 10, sound: 'atk' },
    def: { cost: 2, ultGain: 20, sound: 'def' },
    hel: { cost: 2, ultGain: 20, heal: 8, sound: 'hel' }
  };

  const sounds = {
    tap: new Audio('sounds/tap.mp3'),
    atk: new Audio('sounds/atk.mp3'),
    def: new Audio('sounds/def.mp3'),
    hel: new Audio('sounds/hel.mp3')
  };

  function playSound(name) {
    const audio = sounds[name];
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch (error) {}
  }

  function getCharacter(id) {
    return characters.find((item) => item.id === id) || null;
  }

  function isInteractionLocked() {
    return !!(state.isUltCinematicPlaying || state.isWinCinematicPlaying);
  }

  function setCinematicPageState(active) {
    if (!els.page) return;
    els.page.classList.toggle('is-cinematic-playing', !!active);
  }

  function clearCinematicFailSafe() {
    if (!state.cinematicFailSafeTimer) return;
    window.clearTimeout(state.cinematicFailSafeTimer);
    state.cinematicFailSafeTimer = null;
  }

  function setCinematicFailSafe(callback, durationMs) {
    clearCinematicFailSafe();
    state.cinematicFailSafeTimer = window.setTimeout(() => {
      state.cinematicFailSafeTimer = null;
      callback();
    }, Math.max(1000, Number(durationMs || 6000)));
  }

  function createCinematicEvent(role, actorMark, kind) {
    return {
      id: `${kind || 'evt'}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      role,
      actorMark,
      kind: kind || 'ult',
      createdAt: Date.now()
    };
  }

  function getUltVideoPath(role) {
    if (role === 'assassin') return 'videos/ult/ult_assassin.mp4';
    if (role === 'mage') return 'videos/ult/ult_mage.mp4';
    return 'videos/ult/ult_knight.mp4';
  }

  function getWinVideoPath(role) {
    if (role === 'assassin') return 'videos/win/win_assassin.mp4';
    if (role === 'mage') return 'videos/win/win_mage.mp4';
    return 'videos/win/win_knight.mp4';
  }

  function getRoleDisplayName(role) {
    if (role === 'assassin') return '刺客';
    if (role === 'mage') return '法師';
    return '騎士';
  }

  function getResultVideoEvent(battle) {
    const winner = battle?.result?.winner;
    if (!winner || !battle?.players?.[winner]) return null;
    const role = battle.players[winner].role || 'knight';
    return {
      id: `${battle.roomId || state.roomId || ''}:${normalizeNumber(battle.createdAt, 0)}:${winner}:${battle.result?.loser || ''}:${battle.result?.reason || ''}`,
      role,
      winnerMark: winner
    };
  }

  function pauseBattleBgm() {
    if (audio && audio.pauseBgm) audio.pauseBgm();
  }

  function resumeBattleBgm() {
    if (audio && audio.resumeBgm) audio.resumeBgm();
  }

  function finishUltCinematic() {
    if (!state.isUltCinematicPlaying) return;
    clearCinematicFailSafe();
    state.isUltCinematicPlaying = false;
    state.currentUltVideoEventId = '';
    if (els.ultVideoPlayer) {
      try { els.ultVideoPlayer.pause(); } catch (error) {}
      els.ultVideoPlayer.currentTime = 0;
      els.ultVideoPlayer.removeAttribute('src');
      els.ultVideoPlayer.load();
    }
    if (els.ultVideoOverlay) {
      els.ultVideoOverlay.classList.remove('is-visible');
      els.ultVideoOverlay.setAttribute('aria-hidden', 'true');
    }
    state.frozenTimerText = '';
    setCinematicPageState(isInteractionLocked());
    resumeBattleBgm();
    updateActionStates(getMyBattle());
    renderBoard(getMyBattle()?.board, getMyBattle());
    updateTimerDisplay();
  }

  function playUltCinematic(event) {
    if (!event?.id || !event?.role) return;
    if (state.handledUltVideoIds.has(event.id) || state.currentUltVideoEventId === event.id) return;
    state.handledUltVideoIds.add(event.id);
    state.currentUltVideoEventId = event.id;
    state.isUltCinematicPlaying = true;
    state.frozenTimerText = els.timerValue ? els.timerValue.textContent : '';
    setCinematicPageState(true);
    pauseBattleBgm();
    if (els.ultVideoCaption) els.ultVideoCaption.textContent = `${getRoleDisplayName(event.role)}大招演出中`;
    const player = els.ultVideoPlayer;
    if (!player || !els.ultVideoOverlay) {
      finishUltCinematic();
      return;
    }
    clearCinematicFailSafe();
    player.onended = finishUltCinematic;
    player.onerror = finishUltCinematic;
    player.src = getUltVideoPath(event.role);
    try { player.currentTime = 0; } catch (error) {}
    els.ultVideoOverlay.classList.add('is-visible');
    els.ultVideoOverlay.setAttribute('aria-hidden', 'false');
    const playPromise = player.play();
    setCinematicFailSafe(finishUltCinematic, 8000);
    if (playPromise && playPromise.catch) playPromise.catch(() => finishUltCinematic());
  }

  function finishWinCinematic() {
    if (!state.isWinCinematicPlaying) return;
    clearCinematicFailSafe();
    state.isWinCinematicPlaying = false;
    state.currentWinVideoEventId = '';
    if (els.winVideoPlayer) {
      try { els.winVideoPlayer.pause(); } catch (error) {}
      els.winVideoPlayer.currentTime = 0;
      els.winVideoPlayer.removeAttribute('src');
      els.winVideoPlayer.load();
    }
    if (els.winVideoOverlay) {
      els.winVideoOverlay.classList.remove('is-visible');
      els.winVideoOverlay.setAttribute('aria-hidden', 'true');
    }
    state.frozenTimerText = '';
    setCinematicPageState(isInteractionLocked());
    updateResultOverlay(getMyBattle());
  }

  function playWinCinematic(event) {
    if (!event?.id || !event?.role) return;
    if (state.handledWinVideoIds.has(event.id) || state.currentWinVideoEventId === event.id) return;
    state.handledWinVideoIds.add(event.id);
    state.currentWinVideoEventId = event.id;
    state.lastResultVideoEventId = event.id;
    state.isWinCinematicPlaying = true;
    setCinematicPageState(true);
    if (els.winVideoCaption) els.winVideoCaption.textContent = `${getRoleDisplayName(event.role)}勝利演出`;
    const player = els.winVideoPlayer;
    if (!player || !els.winVideoOverlay) {
      finishWinCinematic();
      return;
    }
    clearCinematicFailSafe();
    player.onended = finishWinCinematic;
    player.onerror = finishWinCinematic;
    player.src = getWinVideoPath(event.role);
    try { player.currentTime = 0; } catch (error) {}
    els.winVideoOverlay.classList.add('is-visible');
    els.winVideoOverlay.setAttribute('aria-hidden', 'false');
    const playPromise = player.play();
    setCinematicFailSafe(finishWinCinematic, 8000);
    if (playPromise && playPromise.catch) playPromise.catch(() => finishWinCinematic());
  }

  function maybeHandleCinematics(battle) {
    if (!battle) return;
    const now = Date.now();
    const ultEvent = battle?.cinematics?.ultEvent;
    if (ultEvent?.id && battle.phase === 'IN_GAME' && Math.abs(now - normalizeNumber(ultEvent.createdAt, now)) <= 10000) {
      playUltCinematic(ultEvent);
    }
    if (battle.phase === 'GAME_OVER' || battle.phase === 'RESULT_CHOICE') {
      const resultEvent = getResultVideoEvent(battle);
      if (resultEvent?.id && state.lastResultVideoEventId !== resultEvent.id) playWinCinematic(resultEvent);
    }
  }

  function campLabel(camp) {
    return camp === 'dark' ? '暗' : '光';
  }

  function identityLabel(prefix, camp, mark) {
    return `${prefix}・${campLabel(camp)} / ${mark}`;
  }

  function clearLocalRoomEntry() {
    if (storage.clearRoomSession) storage.clearRoomSession();
    else {
      storage.clearCurrentRoomId();
      storage.clearCurrentRoomMark();
    }
  }

  function clearPendingEntryOnly() {
    if (storage.clearPendingBattleEntry) storage.clearPendingBattleEntry();
  }

  function redirectToRoom() {
    if (state.isRedirecting) return;
    state.isRedirecting = true;
    stopTurnLoops();
    clearLocalRoomEntry();
    window.location.replace('room.html');
  }

  function safeAlert(message) {
    try { window.alert(message); } catch (error) {}
  }

  function handleOpponentLeft(message) {
    if (state.opponentLeftHandled || state.isRedirecting) return;
    state.opponentLeftHandled = true;
    safeAlert(message || '對手已離開，請重回菜單。');
    redirectToRoom();
  }

  function cancelDisconnectTasks() {
    if (!state.disconnectTasks.length) return;
    state.disconnectTasks.forEach((task) => {
      try { task.cancel(); } catch (error) {}
    });
    state.disconnectTasks = [];
  }

  function sendExitCleanupKeepalive() {
    if (state.exitCleanupSent || state.isRedirecting || !firebaseApi || !firebaseApi.isReady || !state.roomId || !state.selfMark) return;
    state.exitCleanupSent = true;
    try {
      if (state.selfMark === 'O') {
        firebaseApi.restDelete(`${ROOMS_PATH}/${state.roomId}`, { keepalive: true }).catch(() => {});
        firebaseApi.restDelete(`${BATTLE_PATH}/${state.roomId}`, { keepalive: true }).catch(() => {});
        return;
      }
      firebaseApi.restPut(`${ROOMS_PATH}/${state.roomId}/players/X`, { clientId: '', name: '', faction: '', role: '', joined: false, ready: false }, { keepalive: true }).catch(() => {});
      firebaseApi.restPut(`${ROOMS_PATH}/${state.roomId}/phase`, 'lobby', { keepalive: true }).catch(() => {});
      firebaseApi.restDelete(`${BATTLE_PATH}/${state.roomId}`, { keepalive: true }).catch(() => {});
    } catch (error) {}
  }

  function registerDisconnectTasks() {
    if (!firebaseApi || !firebaseApi.isReady || !state.roomId || !state.selfMark) return;
    cancelDisconnectTasks();
    const roomRef = firebaseApi.db.ref(`${ROOMS_PATH}/${state.roomId}`);
    const battleRef = firebaseApi.db.ref(`${BATTLE_PATH}/${state.roomId}`);
    if (state.selfMark === 'O') {
      const roomDisconnect = roomRef.onDisconnect();
      roomDisconnect.remove();
      const battleDisconnect = battleRef.onDisconnect();
      battleDisconnect.remove();
      state.disconnectTasks = [roomDisconnect, battleDisconnect];
      return;
    }
    const guestDisconnect = roomRef.child('players/X').onDisconnect();
    guestDisconnect.set({ clientId: '', name: '', faction: '', role: '', joined: false, ready: false });
    const phaseDisconnect = roomRef.child('phase').onDisconnect();
    phaseDisconnect.set('lobby');
    const battleDisconnect = battleRef.onDisconnect();
    battleDisconnect.remove();
    state.disconnectTasks = [guestDisconnect, phaseDisconnect, battleDisconnect];
  }

  function getCampEffect(camp, stacks) {
    if (camp === 'light') return '直排連線 +8HP';
    return `目前增傷層數：${Math.max(0, Math.min(2, stacks || 0))}`;
  }


  function getDisplayAccents(battle) {
    const oCamp = battle?.players?.O?.camp || 'light';
    const xCamp = battle?.players?.X?.camp || 'dark';
    if (oCamp === xCamp) return { O: 'gold', X: 'violet' };
    return {
      O: oCamp === 'dark' ? 'violet' : 'gold',
      X: xCamp === 'dark' ? 'violet' : 'gold'
    };
  }

  function getAccentClass(accent) {
    return accent === 'violet' ? 'accent-violet' : 'accent-gold';
  }

  function getRoleMarkerMeta(effectKey) {
    switch (effectKey) {
      case 'mage_seal':
        return { iconKey: 'icon_mage_lock', label: '法封', tone: 'mage-lock', title: '法師封格' };
      case 'mage_afterimage':
        return { iconKey: 'icon_mage_afterimage', label: '法殘', tone: 'mage-afterimage', title: '法師殘影' };
      case 'assassin_fragile':
        return { iconKey: 'icon_assassin_fragile', label: '刺脆', tone: 'assassin-fragile', title: '刺客脆弱' };
      case 'assassin_isolated':
        return { iconKey: 'icon_assassin_rift', label: '刺斷', tone: 'assassin-rift', title: '刺客斷界' };
      case 'knight_guarded':
        return { iconKey: 'icon_knight_guard', label: '騎守', tone: 'knight-guard', title: '騎士鎮守' };
      default:
        return null;
    }
  }

  function createRoleMarkerBadge(effectKey, accent) {
    const meta = getRoleMarkerMeta(effectKey);
    if (!meta) return null;
    const badge = document.createElement('span');
    badge.className = `cell-effect-badge role-marker-badge ${meta.tone} ${getAccentClass(accent || 'gold')}`;
    badge.dataset.iconKey = meta.iconKey;
    badge.setAttribute('aria-label', meta.title);
    badge.title = meta.title;
    const text = document.createElement('span');
    text.className = 'role-marker-text';
    text.textContent = meta.label;
    badge.appendChild(text);
    return badge;
  }


  function buildEnergyStars(container, value, onSrc, offSrc, className) {
    if (!container) return;
    const lit = Math.floor((value || 0) / 20);
    const remainder = (value || 0) % 20;
    container.innerHTML = '';
    for (let index = 0; index < 5; index += 1) {
      const image = document.createElement('img');
      image.className = className;
      const reversedIndex = 4 - index;
      const isOn = reversedIndex < lit;
      image.src = isOn ? onSrc : offSrc;
      if (!isOn && reversedIndex === lit && remainder > 0) image.classList.add('preview-next');
      container.appendChild(image);
    }
  }

  function buildUsageDots(container, used, total) {
    if (!container) return;
    container.innerHTML = '';
    const remaining = Math.max(0, total - used);
    for (let index = 0; index < total; index += 1) {
      const dot = document.createElement('span');
      dot.className = 'usage-dot';
      if (index < remaining) dot.classList.add('is-active');
      container.appendChild(dot);
    }
  }

  function getMyBattle() {
    return state.currentBattle || null;
  }

  function isMyTurn(battle) {
    return battle && battle.turn && battle.turn.turnPlayer === state.selfMark;
  }

  function canUseSkillWindow(battle) {
    if (!battle || !battle.turn) return false;
    if (!isMyTurn(battle)) return false;
    if (battle.turn.isResolving) return false;
    return !!battle.turn.piecePlacedThisTurn;
  }

  function updateTimerDisplay() {
    if (isInteractionLocked() && state.frozenTimerText && els.timerValue) {
      els.timerValue.textContent = state.frozenTimerText;
      return;
    }
    const battle = getMyBattle();
    if (!battle || !battle.turn) return;
    const endsAt = Number(battle.turn.turnEndsAt || 0);
    const remaining = endsAt ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : Math.ceil(TURN_DURATION_MS / 1000);
    if (els.timerValue) els.timerValue.textContent = String(remaining);
  }

  function stopTurnLoops() {
    if (state.timerTicker) window.clearInterval(state.timerTicker);
    if (state.timeoutChecker) window.clearInterval(state.timeoutChecker);
    if (state.lineEffectTimer) window.clearTimeout(state.lineEffectTimer);
    state.timerTicker = null;
    state.timeoutChecker = null;
    state.lineEffectTimer = null;
  }

  function beginTurnLoops() {
    stopTurnLoops();
    state.timerTicker = window.setInterval(updateTimerDisplay, 250);
    state.timeoutChecker = window.setInterval(checkTimeoutAndResolve, TIMEOUT_POLL_MS);
    updateTimerDisplay();
  }

  function normalizeBoard(board) {
    if (Array.isArray(board)) {
      return Array.from({ length: 9 }, (_, index) => {
        const value = board[index];
        return value === 'O' || value === 'X' ? value : null;
      });
    }
    if (board && typeof board === 'object') {
      return Array.from({ length: 9 }, (_, index) => {
        const value = board[index] ?? board[String(index)] ?? null;
        return value === 'O' || value === 'X' ? value : null;
      });
    }
    return Array(9).fill(null);
  }
  function normalizePieceOrder(pieceOrder) {
    const raw = Array.isArray(pieceOrder)
      ? pieceOrder
      : pieceOrder && typeof pieceOrder === 'object'
        ? Object.values(pieceOrder)
        : [];
    return raw
      .map((item, index) => {
        if (typeof item === 'number') return { index: item, placedOrder: index + 1, pieceId: null };
        if (item && typeof item === 'object') {
          const normalizedIndex = Number(item.index);
          if (!Number.isFinite(normalizedIndex) || normalizedIndex < 0 || normalizedIndex > 8) return null;
          return {
            index: normalizedIndex,
            placedOrder: Number(item.placedOrder || index + 1),
            pieceId: typeof item.pieceId === 'string' && item.pieceId ? item.pieceId : null
          };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.placedOrder - b.placedOrder);
  }

  function createPieceId(mark) {
    return `${mark}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function ensurePieceIds(pieceOrder, mark) {
    return normalizePieceOrder(pieceOrder).map((item) => ({
      index: Number(item.index),
      placedOrder: Number(item.placedOrder || 0),
      pieceId: item.pieceId || createPieceId(mark)
    }));
  }

  function findPieceRecordAtIndex(current, index, mark) {
    const order = ensurePieceIds(current?.players?.[mark]?.pieceOrder, mark);
    return order.find((item) => Number(item.index) === Number(index)) || null;
  }

  function getOldestPieceIndex(battle, mark, cells) {
    const order = normalizePieceOrder(battle?.players?.[mark]?.pieceOrder);
    if (order.length !== 3) return null;
    const oldestIndex = Number(order[0]?.index);
    if (!Number.isFinite(oldestIndex) || oldestIndex < 0 || oldestIndex > 8) return null;
    return cells && cells[oldestIndex] === mark ? oldestIndex : null;
  }

  function normalizeNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }


  function ensureBattleStateLayers(current) {
    if (!current || typeof current !== 'object') return;
    current.tileEffects = current.tileEffects && typeof current.tileEffects === 'object' ? current.tileEffects : {};
    current.pieceStatus = current.pieceStatus && typeof current.pieceStatus === 'object' ? current.pieceStatus : {};
    current.playerStates = current.playerStates && typeof current.playerStates === 'object' ? current.playerStates : {};
    current.delayedRemoval = current.delayedRemoval && typeof current.delayedRemoval === 'object' ? current.delayedRemoval : {};
    current.cinematics = current.cinematics && typeof current.cinematics === 'object' ? current.cinematics : {};
    current.cinematics.ultEvent = current.cinematics.ultEvent && typeof current.cinematics.ultEvent === 'object' ? {
      id: current.cinematics.ultEvent.id || '',
      role: current.cinematics.ultEvent.role || '',
      actorMark: current.cinematics.ultEvent.actorMark === 'X' ? 'X' : 'O',
      kind: current.cinematics.ultEvent.kind || 'ult',
      createdAt: normalizeNumber(current.cinematics.ultEvent.createdAt, 0)
    } : null;
    ['O', 'X'].forEach((mark) => {
      const existing = current.playerStates[mark] && typeof current.playerStates[mark] === 'object' ? current.playerStates[mark] : {};
      current.playerStates[mark] = {
        ownTurnStarts: normalizeNumber(existing.ownTurnStarts, 0),
        magePassiveReadyAtOwnTurnStart: normalizeNumber(existing.magePassiveReadyAtOwnTurnStart, 1),
        assassinPassiveReadyAtOwnTurnStart: normalizeNumber(existing.assassinPassiveReadyAtOwnTurnStart, 1),
        knightPassiveReadyAtOwnTurnStart: normalizeNumber(existing.knightPassiveReadyAtOwnTurnStart, 1),
        commonSkillTax: existing.commonSkillTax && typeof existing.commonSkillTax === 'object' ? existing.commonSkillTax : null,
        recentAfterimageTrigger: existing.recentAfterimageTrigger && typeof existing.recentAfterimageTrigger === 'object' ? existing.recentAfterimageTrigger : null,
        recentFragileTrigger: existing.recentFragileTrigger && typeof existing.recentFragileTrigger === 'object' ? existing.recentFragileTrigger : null,
        recentKnightPassiveTrigger: existing.recentKnightPassiveTrigger && typeof existing.recentKnightPassiveTrigger === 'object' ? existing.recentKnightPassiveTrigger : null,
        nextAtkBonus: existing.nextAtkBonus && typeof existing.nextAtkBonus === 'object' ? existing.nextAtkBonus : null,
        activeSkillLock: existing.activeSkillLock && typeof existing.activeSkillLock === 'object' ? existing.activeSkillLock : null,
        knightUltHealPending: existing.knightUltHealPending && typeof existing.knightUltHealPending === 'object' ? {
          amount: Math.max(0, normalizeNumber(existing.knightUltHealPending.amount, 0)),
          remainingOpponentTurnEnds: Math.max(0, normalizeNumber(existing.knightUltHealPending.remainingOpponentTurnEnds, 0))
        } : null
      };
      const delayed = current.delayedRemoval[mark];
      current.delayedRemoval[mark] = delayed && typeof delayed === 'object' ? {
        pieceId: delayed.pieceId || '',
        ownerMark: delayed.ownerMark === 'X' ? 'X' : 'O',
        remainingOpponentTurnEnds: Math.max(0, normalizeNumber(delayed.remainingOpponentTurnEnds, 0))
      } : null;
    });
  }

  function normalizeTileEffects(raw) {
    if (!raw || typeof raw !== 'object') return {};
    return Object.entries(raw).reduce((acc, [key, value]) => {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index > 8) return acc;
      if (!value || typeof value !== 'object') return acc;
      acc[index] = value;
      return acc;
    }, {});
  }

  function getPlayerState(current, mark) {
    ensureBattleStateLayers(current);
    return current.playerStates[mark] || null;
  }

  function getOpponentMark(mark) {
    return mark === 'O' ? 'X' : 'O';
  }

  function getDelayedRemovalEntry(current, mark) {
    ensureBattleStateLayers(current);
    return current?.delayedRemoval?.[mark] || null;
  }

  function canTriggerKnightPassive(current, actorMark) {
    if (!current?.players?.[actorMark]) return false;
    if ((current.players[actorMark].role || '') !== 'knight') return false;
    if (getDelayedRemovalEntry(current, actorMark)) return false;
    const playerState = getPlayerState(current, actorMark);
    return normalizeNumber(playerState?.ownTurnStarts, 0) >= normalizeNumber(playerState?.knightPassiveReadyAtOwnTurnStart, 1);
  }

  function findPieceRecordById(current, mark, pieceId) {
    if (!pieceId) return null;
    const order = ensurePieceIds(current?.players?.[mark]?.pieceOrder, mark);
    return order.find((item) => item.pieceId === pieceId) || null;
  }

  function removePieceById(current, ownerMark, pieceId) {
    if (!current || !ownerMark || !pieceId) return false;
    const board = normalizeBoard(current.board);
    const record = findPieceRecordById(current, ownerMark, pieceId);
    if (!record) {
      if (current?.pieceStatus?.[pieceId]) delete current.pieceStatus[pieceId];
      return false;
    }
    const index = Number(record.index);
    if (Number.isInteger(index) && index >= 0 && index <= 8 && board[index] === ownerMark) {
      board[index] = null;
      current.board = board;
    }
    current.players[ownerMark].pieceOrder = ensurePieceIds(current.players[ownerMark].pieceOrder, ownerMark).filter((item) => item.pieceId !== pieceId);
    if (current.pieceStatus[pieceId]) delete current.pieceStatus[pieceId];
    return true;
  }

  function resolveKnightDelayedRemoval(current, endingMark) {
    ensureBattleStateLayers(current);
    ['O', 'X'].forEach((ownerMark) => {
      const entry = current.delayedRemoval[ownerMark];
      if (!entry || typeof entry !== 'object') return;
      if (endingMark !== getOpponentMark(ownerMark)) return;
      entry.remainingOpponentTurnEnds = Math.max(0, normalizeNumber(entry.remainingOpponentTurnEnds, 0) - 1);
      if (entry.remainingOpponentTurnEnds > 0) return;
      removePieceById(current, ownerMark, entry.pieceId);
      current.delayedRemoval[ownerMark] = null;
    });
  }

  function resolveKnightGuardedStatuses(current, endingMark) {
    ensureBattleStateLayers(current);
    Object.keys(current.pieceStatus || {}).forEach((pieceId) => {
      const status = current.pieceStatus[pieceId];
      if (!status || typeof status !== 'object') return;
      if (status.statusType !== 'knight_guarded') return;
      if (endingMark !== status.opponentMark) return;
      status.remainingOpponentTurnEnds = Math.max(0, normalizeNumber(status.remainingOpponentTurnEnds, 0) - 1);
      if (status.remainingOpponentTurnEnds <= 0) delete current.pieceStatus[pieceId];
    });
  }

  function resolveKnightUltimateHeal(current, endingMark) {
    ensureBattleStateLayers(current);
    ['O', 'X'].forEach((ownerMark) => {
      const playerState = getPlayerState(current, ownerMark);
      const pending = playerState?.knightUltHealPending;
      if (!pending || typeof pending !== 'object') return;
      if (endingMark !== getOpponentMark(ownerMark)) return;
      pending.remainingOpponentTurnEnds = Math.max(0, normalizeNumber(pending.remainingOpponentTurnEnds, 0) - 1);
      if (pending.remainingOpponentTurnEnds > 0) return;
      const actor = current.players?.[ownerMark];
      if (actor) actor.hp = Math.min(100, normalizeNumber(actor.hp, 100) + Math.max(0, normalizeNumber(pending.amount, 0)));
      playerState.knightUltHealPending = null;
      current.feedback = {
        id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        events: [createFeedbackEvent(ownerMark, 'heal', Math.max(0, normalizeNumber(pending.amount, 0)))],
        expiresAt: Date.now() + 2200
      };
    });
  }

  function getCommonSkillExtraCost(current, actorMark) {
    const playerState = current?.playerStates?.[actorMark];
    const tax = playerState?.commonSkillTax;
    if (!tax || typeof tax !== 'object') return 0;
    return Math.max(0, normalizeNumber(tax.amount, 0));
  }

  function getCommonSkillCost(current, actorMark, skill) {
    const cfg = SKILL_CONFIG[skill];
    if (!cfg) return 0;
    return cfg.cost + getCommonSkillExtraCost(current, actorMark);
  }

  function canTriggerMagePassive(current, actorMark) {
    if (!current?.players?.[actorMark]) return false;
    if ((current.players[actorMark].role || '') !== 'mage') return false;
    const playerState = getPlayerState(current, actorMark);
    return normalizeNumber(playerState?.ownTurnStarts, 0) >= normalizeNumber(playerState?.magePassiveReadyAtOwnTurnStart, 1);
  }

  function createAfterimageEffect(ownerMark, targetMark, createdTurn) {
    return {
      effectType: 'mage_afterimage',
      ownerMark,
      ownerRole: 'mage',
      createdTurn: normalizeNumber(createdTurn, 1),
      expiresAtTurnEndOf: targetMark,
      iconKey: 'icon_mage_afterimage'
    };
  }

  function cleanupEndOfTurnEffects(current, endingMark) {
    ensureBattleStateLayers(current);
    resolveKnightDelayedRemoval(current, endingMark);
    resolveKnightGuardedStatuses(current, endingMark);
    resolveKnightUltimateHeal(current, endingMark);
    const effects = normalizeTileEffects(current.tileEffects);
    Object.keys(effects).forEach((key) => {
      const effect = effects[key];
      if (!effect || normalizeNumber(effect.expiresAtTurnEndOf, NaN)) {}
      if (effect.expiresAtTurnEndOf === endingMark) delete current.tileEffects[key];
    });
    Object.keys(current.pieceStatus || {}).forEach((pieceId) => {
      const status = current.pieceStatus[pieceId];
      if (!status || typeof status !== 'object') return;
      if (status.expiresAtTurnEndOf === endingMark) {
        delete current.pieceStatus[pieceId];
      }
    });
    ['O', 'X'].forEach((mark) => {
      const playerState = current.playerStates[mark];
      if (!playerState) return;
      if (playerState.commonSkillTax && playerState.commonSkillTax.expiresAtTurnEndOf === endingMark) {
        playerState.commonSkillTax = null;
      }
      if (playerState.activeSkillLock && playerState.activeSkillLock.expiresAtTurnEndOf === endingMark) {
        playerState.activeSkillLock = null;
      }
      if (playerState.nextAtkBonus && playerState.nextAtkBonus.expiresAtTurnEndOf === endingMark) {
        playerState.nextAtkBonus = null;
      }
    });
  }

  function applyTurnStartBookkeeping(current, nextPlayer) {
    ensureBattleStateLayers(current);
    Object.values(current.playerStates || {}).forEach((playerState) => {
      if (!playerState) return;
      if (playerState.recentAfterimageTrigger && playerState.recentAfterimageTrigger.clearOnOwnTurnStart === nextPlayer) {
        playerState.recentAfterimageTrigger = null;
      }
      if (playerState.recentFragileTrigger && playerState.recentFragileTrigger.clearOnOwnTurnStart === nextPlayer) {
        playerState.recentFragileTrigger = null;
      }
      if (playerState.recentKnightPassiveTrigger && playerState.recentKnightPassiveTrigger.clearOnOwnTurnStart === nextPlayer) {
        playerState.recentKnightPassiveTrigger = null;
      }
    });
    const playerState = current.playerStates[nextPlayer];
    if (!playerState) return;
    playerState.ownTurnStarts = normalizeNumber(playerState.ownTurnStarts, 0) + 1;
  }

  function getRoleStatusNotes(battle, mark) {
    ensureBattleStateLayers(battle);
    const notes = [];
    const player = battle?.players?.[mark] || {};
    const playerState = battle?.playerStates?.[mark] || {};
    const tax = getCommonSkillExtraCost(battle, mark);
    if (tax > 0) notes.push(`殘影影響中：共通技能消耗 +${tax} SP`);
    else if (playerState?.recentAfterimageTrigger?.amount > 0) notes.push(`殘影觸發：本回合共通技能 +${playerState.recentAfterimageTrigger.amount} SP`);
    if (playerState?.activeSkillLock?.source === 'mage_ult') notes.push('虛空法庭影響中：本回合主動技已封鎖');
    if ((player.role || '') === 'mage') {
      const ownTurnStarts = normalizeNumber(playerState.ownTurnStarts, 0);
      const readyAt = normalizeNumber(playerState.magePassiveReadyAtOwnTurnStart, 1);
      const remaining = Math.max(0, readyAt - ownTurnStarts - 1);
      if (remaining > 0) notes.push(`法師被動冷卻：剩 ${remaining} 個法師回合`);
      if (mark === state.selfMark && state.uiMode === 'mage_active_targeting' && state.activeSkill === 'mage_seal') {
        notes.push('法師主動：請選 1 個空格施加封格，對手下回合不可落子於該格，Esc 可取消');
      }
    }
    if ((player.role || '') === 'assassin') {
      if (playerState?.recentFragileTrigger?.targetIndex >= 0) notes.push(`弱點標記觸發：最新保留棋進入脆弱`);
      const ownTurnStarts = normalizeNumber(playerState.ownTurnStarts, 0);
      const readyAt = normalizeNumber(playerState.assassinPassiveReadyAtOwnTurnStart, 1);
      const remaining = Math.max(0, readyAt - ownTurnStarts - 1);
      if (remaining > 0) notes.push(`刺客被動冷卻：剩 ${remaining} 個刺客回合`);
      if (mark === state.selfMark && state.activeSkill === 'assassin_swap') {
        if (state.uiMode === 'assassin_active_source') notes.push('刺客主動：先選 1 顆自己的棋，再選 1 顆上下左右相鄰的敵棋交換位置');
        if (state.uiMode === 'assassin_active_target') notes.push('刺客主動：再選 1 顆上下左右相鄰的敵棋完成交換，鎮守棋不可被換，Esc 可取消');
      }
      if (mark === state.selfMark && state.activeSkill === 'assassin_ult') {
        if (state.uiMode === 'assassin_ult_primary') notes.push('刺客大招：先選 1 顆敵棋施加斷界，本回合無法參與連線');
        if (state.uiMode === 'assassin_ult_secondary') notes.push('刺客大招：可再選 1 顆主目標八方格內的敵棋一同進入斷界，點空白處可略過');
      }
      if (playerState?.nextAtkBonus?.amount > 0) notes.push(`刺客大招已生效：本回合下一次 atk +${playerState.nextAtkBonus.amount}`);
    }
    if ((player.role || '') === 'knight') {
      if (mark === state.selfMark && state.activeSkill === 'knight_push') {
        if (state.uiMode === 'knight_active_source') notes.push('騎士主動：先選 1 顆可推進的己方棋，再選上下左右相鄰空格前進 1 格');
        if (state.uiMode === 'knight_active_target') notes.push('騎士主動：請選上下左右相鄰的空格完成推進，Esc 可取消');
      }
      if (mark === state.selfMark && state.activeSkill === 'knight_ult' && state.uiMode === 'knight_ult_target') {
        notes.push('騎士大招：請指定 1 顆己方棋進入鎮守，並立刻獲得 2 層護盾與回復 15 HP');
      }
      const delayed = getDelayedRemovalEntry(battle, mark);
      if (delayed?.pieceId) notes.push('騎士被動生效中：暫留棋將於對手回合結束時移除');
      const ownTurnStarts = normalizeNumber(playerState.ownTurnStarts, 0);
      const readyAt = normalizeNumber(playerState.knightPassiveReadyAtOwnTurnStart, 1);
      const remaining = Math.max(0, readyAt - ownTurnStarts - 1);
      if (remaining > 0) notes.push(`騎士被動冷卻：剩 ${remaining} 個騎士回合`);
      if (playerState?.recentKnightPassiveTrigger?.triggered) notes.push('堅守陣線觸發：最舊棋暫留至對手回合結束');
      const pendingHeal = playerState?.knightUltHealPending;
      if (pendingHeal?.amount > 0) notes.push(`王城鐵律後續：對手回合結束後再回 ${pendingHeal.amount} HP`);
      const guardedPieces = Object.values(battle?.pieceStatus || {}).filter((status) => status && status.statusType === 'knight_guarded' && status.targetMark === mark);
      if (guardedPieces.length) {
        const maxRemain = guardedPieces.reduce((m, s) => Math.max(m, normalizeNumber(s.remainingOpponentTurnEnds, 0)), 0);
        notes.push(`鎮守生效中：${guardedPieces.length} 顆棋，剩 ${maxRemain} 次對手回合結束`);
      }
    }
    return notes;
  }

  function getCandidateLines(board, mark) {
    return WIN_LINES.filter((line) => line.every((index) => board[index] === mark));
  }

  function lineContainsDisabledPiece(current, line, mark) {
    return line.some((index) => {
      const record = findPieceRecordAtIndex(current, index, mark);
      if (!record?.pieceId) return false;
      const status = current?.pieceStatus?.[record.pieceId];
      return !!(status && ((status.statusType === 'assassin_fragile' && status.targetMark === mark) || isIsolatedStatus(status, mark)));
    });
  }

  function findCompletedLines(current, board, mark) {
    return getCandidateLines(board, mark).filter((line) => !lineContainsDisabledPiece(current, line, mark));
  }

  function getLineSpReward(line) {
    return BASE_LINE_SP + (line.includes(4) ? CENTER_LINE_BONUS : 0);
  }

  function isVerticalLine(line) {
    const sorted = line.slice().sort((a, b) => a - b);
    return (sorted[0] === 0 && sorted[1] === 3 && sorted[2] === 6) ||
      (sorted[0] === 1 && sorted[1] === 4 && sorted[2] === 7) ||
      (sorted[0] === 2 && sorted[1] === 5 && sorted[2] === 8);
  }

  function createFeedbackEvent(targetMark, type, amount) {
    return {
      id: `${type}-${targetMark}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      targetMark,
      type,
      amount: Number(amount || 0)
    };
  }

  function getLineEffectPayload(lines, ownerMark) {
    if (!lines.length) return null;
    const firstLine = lines[0];
    if (!firstLine || firstLine.length !== 3) return null;
    return {
      indexes: firstLine.slice(),
      ownerMark: ownerMark === 'X' ? 'X' : 'O',
      expiresAt: Date.now() + 900
    };
  }

  function normalizeLineEffect(effect) {
    if (!effect || typeof effect !== 'object') return null;
    const indexes = Array.isArray(effect.indexes) ? effect.indexes.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0 && v <= 8) : [];
    if (indexes.length !== 3) return null;
    const expiresAt = Number(effect.expiresAt || 0);
    return {
      indexes,
      ownerMark: effect.ownerMark === 'X' ? 'X' : 'O',
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0
    };
  }

  function lineEffectClass(indexes) {
    const sorted = indexes.slice().sort((a, b) => a - b).join('-');
    switch (sorted) {
      case '0-1-2': return 'line-top';
      case '3-4-5': return 'line-middle';
      case '6-7-8': return 'line-bottom';
      case '0-3-6': return 'line-left';
      case '1-4-7': return 'line-center';
      case '2-5-8': return 'line-right';
      case '0-4-8': return 'line-diag-main';
      case '2-4-6': return 'line-diag-anti';
      default: return '';
    }
  }

  function removeIndexesFromPieceOrder(pieceOrder, indexesToRemove) {
    const removeSet = new Set(indexesToRemove);
    const kept = normalizePieceOrder(pieceOrder).filter((item) => !removeSet.has(Number(item.index)));
    return kept.map((item, index) => ({ index: Number(item.index), placedOrder: index + 1, pieceId: item.pieceId || null }));
  }

  function clearPieceStatusByIndexes(current, indexesToRemove) {
    ensureBattleStateLayers(current);
    const removeSet = new Set(indexesToRemove.map((v) => Number(v)));
    ['O','X'].forEach((mark) => {
      const order = normalizePieceOrder(current?.players?.[mark]?.pieceOrder);
      order.forEach((item) => {
        if (removeSet.has(Number(item.index)) && item.pieceId && current.pieceStatus[item.pieceId]) {
          delete current.pieceStatus[item.pieceId];
        }
      });
    });
  }

  function applyLineResolutionToCurrent(current, board, lineOwner, lines) {
    if (!lines.length) return board;
    const clearIndexes = Array.from(new Set(lines.flat())).sort((a, b) => a - b);
    const nextBoard = board.slice();
    clearIndexes.forEach((index) => {
      nextBoard[index] = null;
    });

    const reward = lines.reduce((sum, line) => sum + getLineSpReward(line), 0);
    current.players = current.players || {};
    current.players[lineOwner] = current.players[lineOwner] || {};
    const actingPlayer = current.players[lineOwner];
    actingPlayer.sp = Math.min(100, normalizeNumber(actingPlayer.sp, 0) + reward);

    const feedbackEvents = [];
    if (reward > 0) feedbackEvents.push(createFeedbackEvent(lineOwner, 'sp', reward));
    const actingCamp = actingPlayer.camp || 'light';
    const hasVerticalLine = lines.some(isVerticalLine);
    if (hasVerticalLine) {
      if (actingCamp === 'light') {
        actingPlayer.hp = Math.min(100, normalizeNumber(actingPlayer.hp, 100) + 8);
        feedbackEvents.push(createFeedbackEvent(lineOwner, 'heal', 8));
      } else {
        actingPlayer.darkStacks = Math.min(2, normalizeNumber(actingPlayer.darkStacks, 0) + 1);
      }
    }

    clearPieceStatusByIndexes(current, clearIndexes);
    ['O', 'X'].forEach((mark) => {
      if (!current.players[mark]) return;
      current.players[mark].pieceOrder = removeIndexesFromPieceOrder(current.players[mark].pieceOrder, clearIndexes);
    });

    current.lineEffect = getLineEffectPayload(lines, lineOwner);
    current.feedback = feedbackEvents.length ? {
      id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      events: feedbackEvents,
      expiresAt: Date.now() + 2200
    } : null;
    return nextBoard;
  }




  function renderLineEffect(effect, battle) {
    const shell = document.getElementById('board-shell');
    if (!shell) return;
    const previous = shell.querySelector('.board-line-effect');
    if (previous) previous.remove();
    if (state.lineEffectTimer) {
      window.clearTimeout(state.lineEffectTimer);
      state.lineEffectTimer = null;
    }
    const normalized = normalizeLineEffect(effect);
    if (!normalized) return;
    const remaining = normalized.expiresAt ? normalized.expiresAt - Date.now() : 0;
    if (remaining <= 0) return;
    const cls = lineEffectClass(normalized.indexes);
    if (!cls) return;
    const accents = getDisplayAccents(battle || getMyBattle());
    const accent = getAccentClass(accents[normalized.ownerMark] || 'gold');
    const line = document.createElement('div');
    line.className = `board-line-effect ${accent} ${cls}`;
    shell.appendChild(line);
    state.lineEffectTimer = window.setTimeout(() => {
      line.remove();
      state.lineEffectTimer = null;
    }, remaining);
  }


  function showTopFloat(targetMark, amount, kind) {
    const type = kind === 'sp' ? 'sp' : kind === 'ult' ? 'ult' : kind === 'damage' ? 'damage' : kind === 'block' ? 'block' : 'hp';
    const isSelf = targetMark === state.selfMark;
    const host = type === 'sp'
      ? (isSelf ? els.mySpStars : els.enemySpStars)
      : type === 'ult'
        ? (isSelf ? els.myUltStars : els.enemyUltStars)
        : (isSelf ? els.myHpPercent?.parentElement : els.enemyHpPercent?.parentElement);
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const float = document.createElement('div');
    float.className = `top-float-text ${type}`;
    const safeAmount = Math.abs(Number(amount || 0));
    if (type === 'damage') float.textContent = `-${safeAmount} HP`;
    else if (type === 'block') float.textContent = 'BLOCK';
    else float.textContent = `+${safeAmount} ${type.toUpperCase()}`;
    let x = rect.left + rect.width / 2;
    let y = rect.top + 10;
    if (type === 'hp') {
      x = isSelf ? rect.left + rect.width * 0.58 : rect.left + rect.width * 0.42;
      y = rect.top + 24;
    } else {
      y = rect.top - 8;
    }
    float.style.left = `${Math.round(x)}px`;
    float.style.top = `${Math.round(y)}px`;
    document.body.appendChild(float);
    window.setTimeout(() => float.remove(), 2100);
  }



  function updateHpLossOverlay(targetMark, hpValue) {
    const isSelf = targetMark === state.selfMark;
    const overlay = isSelf ? els.myHpBarLoss : els.enemyHpBarLoss;
    if (!overlay) return;
    const hp = Math.max(0, Math.min(100, normalizeNumber(hpValue, 100)));
    overlay.style.height = `${100 - hp}%`;
  }

  function pickSlashVariant(seedSource) {
    const seed = String(seedSource || '');
    let total = 0;
    for (let i = 0; i < seed.length; i += 1) total += seed.charCodeAt(i);
    return total % 3;
  }

  function triggerAttackHitEffect(targetMark, seedSource) {
    const isSelf = targetMark === state.selfMark;
    const fighterSide = isSelf ? els.myFighterSide : els.enemyFighterSide;
    const hpColumn = (isSelf ? els.myHpPercent : els.enemyHpPercent)?.closest('.hp-column');
    [fighterSide, hpColumn].forEach((node) => {
      if (!node) return;
      node.classList.remove('hit-shake');
      void node.offsetWidth;
      node.classList.add('hit-shake');
    });
    const targetRect = (fighterSide || hpColumn)?.getBoundingClientRect();
    if (!targetRect) return;
    const slash = document.createElement('div');
    const variant = pickSlashVariant(seedSource || `${targetMark}:${Date.now()}`);
    slash.className = `attack-slash-effect slash-variant-${variant}`;
    slash.style.left = `${Math.round(targetRect.left + targetRect.width * 0.5)}px`;
    slash.style.top = `${Math.round(targetRect.top + targetRect.height * 0.42)}px`;
    for (let i = 0; i < 7; i += 1) {
      const particle = document.createElement('span');
      particle.className = 'slash-particle';
      particle.style.setProperty('--p-x', `${-18 + (i * 6)}px`);
      particle.style.setProperty('--p-y', `${-6 + ((i % 3) * 5)}px`);
      particle.style.setProperty('--p-r', `${(i - 3) * 8}deg`);
      particle.style.animationDelay = `${i * 18}ms`;
      slash.appendChild(particle);
    }
    document.body.appendChild(slash);
    window.setTimeout(() => slash.remove(), 560);
  }

  function renderFeedback(feedback) {
    if (!feedback || !feedback.id || state.shownFeedbackIds.has(feedback.id)) return;
    state.shownFeedbackIds.add(feedback.id);
    const events = Array.isArray(feedback.events) ? feedback.events : [];
    events.forEach((event) => {
      if (!event) return;
      if (event.type === 'heal') showTopFloat(event.targetMark, event.amount, 'hp');
      if (event.type === 'sp') showTopFloat(event.targetMark, event.amount, 'sp');
      if (event.type === 'ult') showTopFloat(event.targetMark, event.amount, 'ult');
      if (event.type === 'damage') { showTopFloat(event.targetMark, event.amount, 'damage'); triggerAttackHitEffect(event.targetMark, `${feedback.id}:damage:${event.targetMark}`); }
      if (event.type === 'block') { showTopFloat(event.targetMark, event.amount, 'block'); triggerAttackHitEffect(event.targetMark, `${feedback.id}:damage:${event.targetMark}`); }
    });
    if (state.shownFeedbackIds.size > 20) {
      state.shownFeedbackIds = new Set(Array.from(state.shownFeedbackIds).slice(-10));
    }
  }

  function renderBoard(board, battle) {
    if (!els.grid) return;
    const currentBattle = battle || getMyBattle();
    const cells = normalizeBoard(board);
    ensureBattleStateLayers(currentBattle || {});
    const tileEffects = normalizeTileEffects(currentBattle?.tileEffects);
    const allowPlace = !isInteractionLocked() && !!currentBattle && isMyTurn(currentBattle) && !currentBattle.turn.piecePlacedThisTurn && !currentBattle.turn.isResolving;
    const allowMageSealTargeting = !isInteractionLocked() && !!currentBattle && state.uiMode === 'mage_active_targeting' && state.activeSkill === 'mage_seal' && isMageActiveAvailable(currentBattle, state.selfMark);
    const allowAssassinSourceTargeting = !isInteractionLocked() && !!currentBattle && state.uiMode === 'assassin_active_source' && state.activeSkill === 'assassin_swap' && isAssassinActiveAvailable(currentBattle, state.selfMark);
    const allowAssassinTargetTargeting = !isInteractionLocked() && !!currentBattle && state.uiMode === 'assassin_active_target' && state.activeSkill === 'assassin_swap' && Number.isInteger(state.selectedSourceIndex) && isAssassinActiveAvailable(currentBattle, state.selfMark);
    const allowKnightSourceTargeting = !isInteractionLocked() && !!currentBattle && state.uiMode === 'knight_active_source' && state.activeSkill === 'knight_push' && isKnightActiveAvailable(currentBattle, state.selfMark);
    const allowKnightTargetTargeting = !isInteractionLocked() && !!currentBattle && state.uiMode === 'knight_active_target' && state.activeSkill === 'knight_push' && Number.isInteger(state.selectedSourceIndex) && isKnightActiveAvailable(currentBattle, state.selfMark);
    const allowAssassinUltPrimary = !isInteractionLocked() && !!currentBattle && state.uiMode === 'assassin_ult_primary' && state.activeSkill === 'assassin_ult' && isAssassinUltimateAvailable(currentBattle, state.selfMark);
    const allowAssassinUltSecondary = !isInteractionLocked() && !!currentBattle && state.uiMode === 'assassin_ult_secondary' && state.activeSkill === 'assassin_ult' && Number.isInteger(state.selectedUltPrimaryIndex) && isAssassinUltimateAvailable(currentBattle, state.selfMark);
    const allowKnightUltTargeting = !isInteractionLocked() && !!currentBattle && state.uiMode === 'knight_ult_target' && state.activeSkill === 'knight_ult' && isKnightUltimateAvailable(currentBattle, state.selfMark);
    const assassinSourceIndexes = allowAssassinSourceTargeting ? new Set(getAssassinSourceIndexes(currentBattle, state.selfMark)) : new Set();
    const assassinTargetIndexes = allowAssassinTargetTargeting ? new Set(getAssassinSwapTargetIndexes(currentBattle, state.selfMark, state.selectedSourceIndex)) : new Set();
    const knightSourceIndexes = allowKnightSourceTargeting ? new Set(getKnightSourceIndexes(currentBattle, state.selfMark)) : new Set();
    const knightTargetIndexes = allowKnightTargetTargeting ? new Set(getKnightTargetIndexes(currentBattle, state.selfMark, state.selectedSourceIndex)) : new Set();
    const assassinUltPrimaryIndexes = allowAssassinUltPrimary ? new Set(getAssassinUltPrimaryIndexes(currentBattle, state.selfMark)) : new Set();
    const assassinUltSecondaryIndexes = allowAssassinUltSecondary ? new Set(getAssassinUltSecondaryIndexes(currentBattle, state.selfMark, state.selectedUltPrimaryIndex)) : new Set();
    const knightUltTargetIndexes = allowKnightUltTargeting ? new Set(getKnightUltTargetIndexes(currentBattle, state.selfMark)) : new Set();
    const warningIndex = allowPlace ? getOldestPieceIndex(currentBattle, state.selfMark, cells) : null;
    const accents = getDisplayAccents(currentBattle);
    els.grid.innerHTML = '';
    for (let index = 0; index < 9; index += 1) {
      const mark = cells[index];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'grid-cell';
      if (mark === 'O') button.classList.add('mark-o', getAccentClass(accents.O));
      if (mark === 'X') button.classList.add('mark-x', getAccentClass(accents.X));
      if (!mark && allowPlace) button.classList.add('is-clickable');
      button.dataset.cellIndex = String(index);
      const glyph = document.createElement('span');
      glyph.className = 'grid-mark';
      if (warningIndex === index) glyph.classList.add('is-oldest-warning');
      glyph.textContent = mark === 'O' ? '○' : mark === 'X' ? '✕' : '';
      button.appendChild(glyph);
      const pieceRecord = mark ? findPieceRecordAtIndex(currentBattle, index, mark) : null;
      const pieceStatus = pieceRecord?.pieceId ? currentBattle?.pieceStatus?.[pieceRecord.pieceId] : null;
      if (pieceStatus && pieceStatus.statusType === 'assassin_fragile') {
        const badge = createRoleMarkerBadge('assassin_fragile', getDisplayAccents(currentBattle)[pieceStatus.ownerMark] || 'violet');
        if (badge) button.appendChild(badge);
      }
      if (pieceStatus && pieceStatus.statusType === 'assassin_isolated') {
        const badge = createRoleMarkerBadge('assassin_isolated', getDisplayAccents(currentBattle)[pieceStatus.ownerMark] || 'violet');
        if (badge) button.appendChild(badge);
      }
      if (pieceStatus && pieceStatus.statusType === 'knight_guarded') {
        const badge = createRoleMarkerBadge('knight_guarded', getDisplayAccents(currentBattle)[pieceStatus.ownerMark] || 'gold');
        if (badge) button.appendChild(badge);
      }
      const cellEffect = tileEffects[index];
      if (cellEffect && cellEffect.effectType === 'mage_afterimage') {
        const badge = createRoleMarkerBadge('mage_afterimage', getDisplayAccents(currentBattle)[cellEffect.ownerMark] || 'gold');
        if (badge) button.appendChild(badge);
      }
      if (cellEffect && cellEffect.effectType === 'mage_seal') {
        const badge = createRoleMarkerBadge('mage_seal', getDisplayAccents(currentBattle)[cellEffect.ownerMark] || 'gold');
        if (badge) button.appendChild(badge);
      }
      const canTargetSeal = allowMageSealTargeting && !mark;
      const canTargetAssassinSource = allowAssassinSourceTargeting && assassinSourceIndexes.has(index);
      const canTargetAssassinSwap = allowAssassinTargetTargeting && assassinTargetIndexes.has(index);
      const canTargetKnightSource = allowKnightSourceTargeting && knightSourceIndexes.has(index);
      const canTargetKnightMove = allowKnightTargetTargeting && knightTargetIndexes.has(index);
      const canTargetAssassinUltPrimary = allowAssassinUltPrimary && assassinUltPrimaryIndexes.has(index);
      const canTargetAssassinUltSecondary = allowAssassinUltSecondary && assassinUltSecondaryIndexes.has(index);
      const canTargetKnightUlt = allowKnightUltTargeting && knightUltTargetIndexes.has(index);
      if (canTargetSeal || canTargetAssassinSwap || canTargetKnightMove || canTargetAssassinUltPrimary || canTargetKnightUlt) button.classList.add('is-active-target');
      if (canTargetAssassinUltSecondary) {
        button.classList.add('is-active-target', 'is-active-target-pulse');
      }
      if (canTargetAssassinSource || canTargetKnightSource) button.classList.add('is-active-source');
      if ((allowAssassinTargetTargeting || allowKnightTargetTargeting) && Number(state.selectedSourceIndex) === index) button.classList.add('is-active-source-selected');
      let disabled = (!!mark || !allowPlace);
      if (allowMageSealTargeting) disabled = !canTargetSeal;
      else if (allowAssassinSourceTargeting) disabled = !canTargetAssassinSource;
      else if (allowAssassinTargetTargeting) disabled = !(canTargetAssassinSwap || Number(state.selectedSourceIndex) === index);
      else if (allowKnightSourceTargeting) disabled = !canTargetKnightSource;
      else if (allowKnightTargetTargeting) disabled = !(canTargetKnightMove || Number(state.selectedSourceIndex) === index);
      else if (allowAssassinUltPrimary) disabled = !canTargetAssassinUltPrimary;
      else if (allowAssassinUltSecondary) disabled = !(canTargetAssassinUltSecondary || Number(state.selectedUltPrimaryIndex) === index);
      else if (allowKnightUltTargeting) disabled = !canTargetKnightUlt;
      button.disabled = disabled;
      if (disabled) button.classList.add('is-disabled');
      els.grid.appendChild(button);
    }
  }

  function fillSide(prefix, mark, player, accent) {
    const safePlayer = player || { hp: 100, sp: 0, ult: 0, camp: 'light', role: 'mage', name: prefix === 'my' ? '你' : '對手', darkStacks: 0 };
    const character = getCharacter(safePlayer.role);
    const refs = prefix === 'my' ? {
      identityBadge: els.myIdentityBadge,
      portrait: els.myPortrait,
      name: els.myName,
      role: els.myRole,
      campEffect: els.myCampEffect,
      hpPercent: els.myHpPercent,
      spStars: els.mySpStars,
      spValue: els.mySpValue,
      ultStars: els.myUltStars,
      ultValue: els.myUltValue,
      label: '你'
    } : {
      identityBadge: els.enemyIdentityBadge,
      portrait: els.enemyPortrait,
      name: els.enemyName,
      role: els.enemyRole,
      campEffect: els.enemyCampEffect,
      hpPercent: els.enemyHpPercent,
      spStars: els.enemySpStars,
      spValue: els.enemySpValue,
      ultStars: els.enemyUltStars,
      ultValue: els.enemyUltValue,
      label: '對手'
    };

    refs.identityBadge.textContent = identityLabel(refs.label, safePlayer.camp, mark);
    refs.identityBadge.classList.remove('accent-gold', 'accent-violet');
    refs.identityBadge.classList.add(getAccentClass(accent));
    refs.portrait.closest('.portrait-frame')?.classList.remove('accent-gold', 'accent-violet');
    refs.portrait.closest('.portrait-frame')?.classList.add(getAccentClass(accent));
    refs.campEffect.closest('.info-strip')?.classList.remove('accent-gold', 'accent-violet', 'shield-one', 'shield-two');
    refs.campEffect.closest('.info-strip')?.classList.add(getAccentClass(accent));
    const hpColumn = refs.hpPercent?.closest('.hp-column');
    hpColumn?.classList.remove('shield-one', 'shield-two');
    refs.campEffect.classList.remove('shield-one', 'shield-two');
    refs.portrait.src = character ? character.image : 'assets/characters/knight.png';
    refs.name.textContent = safePlayer.name || (character ? `${character.name}・${character.englishName}` : '--');
    refs.role.textContent = character ? character.role : '等待同步角色資料';
        const baseCampEffect = getCampEffect(safePlayer.camp, safePlayer.darkStacks);
    const statusNotes = getRoleStatusNotes(getMyBattle() || state.currentBattle || {}, mark);
    const infoStrip = refs.campEffect.closest('.info-strip');
    if (infoStrip) infoStrip.classList.toggle('has-status', statusNotes.length > 0);
    refs.campEffect.innerHTML = statusNotes.length
      ? `${baseCampEffect}<span class="info-sep">✦</span>${statusNotes.join('<span class="info-sep">✦</span>')}`
      : baseCampEffect;
    refs.hpPercent.textContent = `${safePlayer.hp}%`;
    updateHpLossOverlay(mark, safePlayer.hp);
    const shieldStacks = normalizeNumber(safePlayer.shieldStacks, 0);
    if (shieldStacks >= 2) {
      hpColumn?.classList.add('shield-two');
      refs.campEffect.classList.add('shield-two');
    } else if (shieldStacks === 1) {
      hpColumn?.classList.add('shield-one');
      refs.campEffect.classList.add('shield-one');
    }
    buildEnergyStars(refs.spStars, safePlayer.sp || 0, 'assets/ui/sp_on.png', 'assets/ui/sp_off.png', 'energy-star');
    if (refs.spValue) refs.spValue.textContent = `SP ${normalizeNumber(safePlayer.sp, 0)} / 100`;
    buildEnergyStars(refs.ultStars, safePlayer.ult || 0, 'assets/ui/ult_on.png', 'assets/ui/ult_off.png', 'ult-star');
    if (refs.ultValue) refs.ultValue.textContent = `ULT ${normalizeNumber(safePlayer.ult, 0)} / 100`;
  }

  function updateActionStates(battle) {
    const currentBattle = battle || getMyBattle();
    if (isInteractionLocked()) {
      if (els.endTurnButton) {
        els.endTurnButton.disabled = true;
        els.endTurnButton.classList.remove('is-clickable');
      }
      els.skillButtons.forEach((button) => {
        button.disabled = true;
        button.classList.remove('is-clickable', 'is-armed');
      });
      return;
    }
    const phase = currentBattle?.phase || '';
    const locked = phase === 'GAME_OVER' || phase === 'RESULT_CHOICE';
    const myTurn = isMyTurn(currentBattle);
    const placed = !!currentBattle?.turn?.piecePlacedThisTurn;
    const resolving = !!currentBattle?.turn?.isResolving;
    const canEndTurn = myTurn && placed && !resolving;
    const myPlayer = currentBattle?.players?.[state.selfMark] || {};
    if (els.endTurnButton) {
      const disabled = locked || !canEndTurn || state.actionInFlight;
      els.endTurnButton.disabled = disabled;
      els.endTurnButton.classList.toggle('is-clickable', !disabled);
    }
    const myRole = (myPlayer.role || '');
    const canUseMageActive = !locked && !state.actionInFlight && isMageActiveAvailable(currentBattle, state.selfMark);
    const canUseAssassinActive = !locked && !state.actionInFlight && isAssassinActiveAvailable(currentBattle, state.selfMark);
    const canUseKnightActive = !locked && !state.actionInFlight && isKnightActiveAvailable(currentBattle, state.selfMark);
    const canUseRoleActive = myRole === 'mage' ? canUseMageActive : myRole === 'assassin' ? canUseAssassinActive : myRole === 'knight' ? canUseKnightActive : false;
    const canUseMageUlt = !locked && !state.actionInFlight && isMageUltimateAvailable(currentBattle, state.selfMark);
    const canUseAssassinUlt = !locked && !state.actionInFlight && isAssassinUltimateAvailable(currentBattle, state.selfMark);
    const canUseKnightUlt = !locked && !state.actionInFlight && isKnightUltimateAvailable(currentBattle, state.selfMark);
    if (!canUseRoleActive && !canUseMageUlt && !canUseAssassinUlt && !canUseKnightUlt && state.uiMode !== 'idle') resetUiMode();
    els.skillButtons.forEach((button) => {
      const skill = button.dataset.skill || '';
      let disabled = true;
      if (skill === 'atk' || skill === 'def' || skill === 'hel') {
        const actualCost = getCommonSkillCost(currentBattle, state.selfMark, skill);
        disabled = locked || state.actionInFlight || !canUseSkillWindow(currentBattle) || normalizeNumber(currentBattle?.turn?.skillUsedCount,0) >= 3 || normalizeNumber(myPlayer.sp,0) < actualCost;
      } else if (skill === 'active') {
        disabled = !canUseRoleActive;
        const isArmed = (state.uiMode === 'mage_active_targeting' && state.activeSkill === 'mage_seal')
          || ((state.uiMode === 'assassin_active_source' || state.uiMode === 'assassin_active_target') && state.activeSkill === 'assassin_swap')
          || ((state.uiMode === 'knight_active_source' || state.uiMode === 'knight_active_target') && state.activeSkill === 'knight_push');
        button.classList.toggle('is-armed', isArmed && !disabled);
      } else if (skill === 'ult') {
        const isArmedUlt = ((state.uiMode === 'assassin_ult_primary' || state.uiMode === 'assassin_ult_secondary') && state.activeSkill === 'assassin_ult')
          || (state.uiMode === 'knight_ult_target' && state.activeSkill === 'knight_ult');
        button.classList.toggle('is-armed', isArmedUlt && !disabled);
        disabled = myRole === 'mage' ? !canUseMageUlt : myRole === 'assassin' ? !canUseAssassinUlt : myRole === 'knight' ? !canUseKnightUlt : true;
      } else {
        button.classList.remove('is-armed');
        disabled = true;
      }
      button.disabled = disabled;
      button.classList.toggle('is-clickable', !disabled);
    });
  }



  function stopResultTimer() {
    if (state.resultTimer) window.clearInterval(state.resultTimer);
    state.resultTimer = null;
  }

  function winnerTextForSelf(battle) {
    const result = battle?.result || {};
    if (!result.winner || !result.loser) return null;
    return result.winner === state.selfMark ? '勝利' : '失敗';
  }


  const VICTORY_QUOTES = [
    '凡夫終究是凡夫。',
    '菜就多練，輸不起就別玩。',
    '終究只是沒有活在我那個年代的凡夫而已。'
  ];

  const DEFEAT_QUOTES = [
    '活該，輸一輩子。',
    '很抱歉，沒有讓勝利的那一方盡興。',
    '哇操，有外掛。'
  ];

  function pickResultQuote(battle, resultText) {
    const pool = resultText === '勝利' ? VICTORY_QUOTES : DEFEAT_QUOTES;
    const key = `${state.roomId || ''}:${battle?.result?.winner || ''}:${battle?.result?.loser || ''}:${resultText}`;
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) hash = ((hash << 5) - hash) + key.charCodeAt(index);
    const selected = Math.abs(hash) % pool.length;
    return pool[selected];
  }

  function updateResultOverlay(battle) {
    const phase = battle?.phase || '';
    const rawVisible = phase === 'GAME_OVER' || phase === 'RESULT_CHOICE';
    const resultEvent = rawVisible ? getResultVideoEvent(battle) : null;
    const deferForWinVideo = !!(rawVisible && resultEvent?.id && !state.handledWinVideoIds.has(resultEvent.id));
    const isVisible = rawVisible && !deferForWinVideo && !state.isWinCinematicPlaying;
    if (!els.resultOverlay) return;
    els.resultOverlay.classList.toggle('is-visible', isVisible);
    els.resultOverlay.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
    if (els.page) els.page.classList.toggle('is-game-over', rawVisible);
    if (!isVisible) {
      stopResultTimer();
      return;
    }
    const resultText = winnerTextForSelf(battle) || '本局結束';
    if (els.resultTitle) {
      els.resultTitle.textContent = resultText;
      els.resultTitle.classList.toggle('is-loss', resultText === '失敗');
    }
    if (els.resultOverlay) els.resultOverlay.classList.toggle('is-loss', resultText === '失敗');
    const resultCard = els.resultOverlay ? els.resultOverlay.querySelector('.result-card') : null;
    if (resultCard) resultCard.classList.toggle('is-loss', resultText === '失敗');
    if (els.resultQuote) els.resultQuote.textContent = pickResultQuote(battle, resultText);
    if (els.resultSubtitle) els.resultSubtitle.textContent = battle?.result?.reason ? `結束原因：${battle.result.reason}` : '本局已結束';
    const rematch = battle?.rematch || {};
    const expiresAt = Number(rematch.expiresAt || 0);
    const updateCountdown = () => {
      const seconds = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0;
      if (els.resultCountdown) els.resultCountdown.textContent = `${seconds} 秒後返回房間`;
      const myChoice = state.selfMark === 'O' ? rematch.OChoice : rematch.XChoice;
      const enemyChoice = state.selfMark === 'O' ? rematch.XChoice : rematch.OChoice;
      if (els.resultChoiceHint) {
        const myLabel = myChoice === 'rematch' ? '你已選擇重新戰鬥' : myChoice === 'room' ? '你已選擇回菜單' : '等待你的選擇';
        const enemyLabel = enemyChoice === 'rematch' ? '對手選擇重新戰鬥' : enemyChoice === 'room' ? '對手選擇回菜單' : '等待對手選擇';
        els.resultChoiceHint.textContent = `${myLabel}｜${enemyLabel}`;
      }
      const disableSelf = myChoice === 'rematch' || myChoice === 'room' || seconds <= 0;
      if (els.resultRoomButton) els.resultRoomButton.disabled = disableSelf || state.actionInFlight;
      if (els.resultRematchButton) els.resultRematchButton.disabled = disableSelf || state.actionInFlight;
    };
    stopResultTimer();
    updateCountdown();
    state.resultTimer = window.setInterval(updateCountdown, 250);
  }

  function normalizeRematch(rematch) {
    return {
      status: rematch?.status || 'idle',
      expiresAt: Number(rematch?.expiresAt || 0),
      OChoice: rematch?.OChoice || 'none',
      XChoice: rematch?.XChoice || 'none'
    };
  }

  function buildFreshBattleState(current) {
    const players = current?.players || {};
    return {
      roomId: state.roomId,
      createdAt: Date.now(),
      phase: 'IN_GAME',
      board: Array(9).fill(null),
      players: {
        O: {
          hp: 100, sp: 0, ult: 0, camp: players.O?.camp || 'light', role: players.O?.role || 'mage', name: players.O?.name || '玩家一',
          shieldStacks: 0, darkStacks: 0, pieceOrder: [], online: true, mark: 'O'
        },
        X: {
          hp: 100, sp: 0, ult: 0, camp: players.X?.camp || 'dark', role: players.X?.role || 'knight', name: players.X?.name || '玩家二',
          shieldStacks: 0, darkStacks: 0, pieceOrder: [], online: true, mark: 'X'
        }
      },
      turn: { turnPlayer: 'O', turnNumber: 1, turnEndsAt: Date.now() + TURN_DURATION_MS, piecePlacedThisTurn: false, skillUsedCount: 0, isResolving: false },
      result: { winner: null, loser: null, reason: null },
      rematch: { status: 'idle', expiresAt: 0, OChoice: 'none', XChoice: 'none' },
      tileEffects: {},
      pieceStatus: {},
      delayedRemoval: { O: null, X: null },
      cinematics: { ultEvent: null },
      playerStates: {
        O: { ownTurnStarts: 1, magePassiveReadyAtOwnTurnStart: 1, assassinPassiveReadyAtOwnTurnStart: 1, knightPassiveReadyAtOwnTurnStart: 1, commonSkillTax: null, recentFragileTrigger: null, recentKnightPassiveTrigger: null, nextAtkBonus: null, knightUltHealPending: null },
        X: { ownTurnStarts: 0, magePassiveReadyAtOwnTurnStart: 1, assassinPassiveReadyAtOwnTurnStart: 1, knightPassiveReadyAtOwnTurnStart: 1, commonSkillTax: null, recentFragileTrigger: null, recentKnightPassiveTrigger: null, nextAtkBonus: null, knightUltHealPending: null }
      },
      feedback: null,
      lineEffect: null
    };
  }

  function applyGameOverIfNeeded(current, reason) {
    if (!current || !current.players) return;
    const oHp = normalizeNumber(current.players.O?.hp, 100);
    const xHp = normalizeNumber(current.players.X?.hp, 100);
    if (oHp > 0 && xHp > 0) return;
    let winner = null;
    let loser = null;
    if (oHp <= 0 && xHp <= 0) { winner = state.selfMark === 'O' ? 'X' : 'O'; loser = state.selfMark; }
    else if (oHp <= 0) { winner = 'X'; loser = 'O'; }
    else { winner = 'O'; loser = 'X'; }
    current.phase = 'RESULT_CHOICE';
    current.result = { winner, loser, reason: reason || 'HP歸零' };
    current.rematch = { status: 'waiting', expiresAt: Date.now() + 10000, OChoice: 'none', XChoice: 'none' };
    if (current.turn) current.turn.isResolving = false;
  }

  async function chooseResultAction(choice) {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    if (!(battle.phase === 'GAME_OVER' || battle.phase === 'RESULT_CHOICE')) return;
    state.actionInFlight = true;
    updateResultOverlay(battle);
    try {
      await transactionBattle((current) => {
        if (!current || !(current.phase === 'GAME_OVER' || current.phase === 'RESULT_CHOICE')) return current;
        const rematch = normalizeRematch(current.rematch);
        if (rematch.expiresAt && Date.now() > rematch.expiresAt) return current;
        const key = state.selfMark === 'O' ? 'OChoice' : 'XChoice';
        if (rematch[key] === choice) return current;
        rematch[key] = choice;
        current.phase = 'RESULT_CHOICE';
        if (choice === 'room' || rematch.OChoice === 'room' || rematch.XChoice === 'room') {
          rematch.status = 'return_room';
          current.rematch = rematch;
          return current;
        }
        if (rematch.OChoice === 'rematch' && rematch.XChoice === 'rematch') {
          const fresh = buildFreshBattleState(current);
          fresh.rematch = { status: 'idle', expiresAt: 0, OChoice: 'none', XChoice: 'none' };
          return fresh;
        }
        rematch.status = 'waiting';
        current.rematch = rematch;
        return current;
      });
    } catch (error) { console.error('chooseResultAction failed', error); }
    finally { state.actionInFlight = false; updateResultOverlay(getMyBattle()); }
  }

  function renderBattle(snapshotValue) {
    if (!snapshotValue) return;
    ensureBattleStateLayers(snapshotValue);
    state.currentBattle = snapshotValue;
    els.roomCode.textContent = snapshotValue.roomId || state.roomId || '--';
    els.roundNumber.textContent = String(snapshotValue.turn?.turnNumber || 1);
    const turnPlayer = snapshotValue.turn?.turnPlayer || 'O';
    const myTurn = turnPlayer === state.selfMark;
    const turnCamp = snapshotValue.players?.[turnPlayer]?.camp || 'light';
    if (els.page) {
      els.page.classList.toggle('is-my-turn', myTurn);
      els.page.classList.toggle('is-waiting-turn', !myTurn);
    }
    if (els.boardTurnOverlay) {
      els.boardTurnOverlay.textContent = myTurn ? '' : '對方操作中';
      els.boardTurnOverlay.setAttribute('aria-hidden', myTurn ? 'true' : 'false');
    }
    const turnBaseText = myTurn
      ? `目前回合：${campLabel(turnCamp)} / ${turnPlayer}（輪到你）`
      : `目前回合：${campLabel(turnCamp)} / ${turnPlayer}（輪到對手）`;
    els.turnIndicator.textContent = turnBaseText;

    const myMark = state.selfMark || 'O';
    const enemyMark = myMark === 'O' ? 'X' : 'O';
    maybeHandleCinematics(snapshotValue);
    const accents = getDisplayAccents(snapshotValue);
    fillSide('my', myMark, snapshotValue.players?.[myMark], accents[myMark]);
    fillSide('enemy', enemyMark, snapshotValue.players?.[enemyMark], accents[enemyMark]);
    buildUsageDots(els.skillUsageDots, snapshotValue.turn?.skillUsedCount || 0, 3);
    updateActionStates(snapshotValue);
    renderLineEffect(snapshotValue.lineEffect, snapshotValue);
    renderFeedback(snapshotValue.feedback);
    renderBoard(snapshotValue.board, snapshotValue);
    maybeShowUltReadyBanner(snapshotValue);
    const resultNowVisible = snapshotValue.phase === 'GAME_OVER' || snapshotValue.phase === 'RESULT_CHOICE';
    if (resultNowVisible && !state.bgmFadedForResult && audio && audio.fadeOutBgm) {
      audio.fadeOutBgm(3000);
      state.bgmFadedForResult = true;
    }
    if (!resultNowVisible) {
      state.bgmFadedForResult = false;
      state.lastResultVideoEventId = '';
    }
    updateResultOverlay(snapshotValue);
    updateTimerDisplay();
  }


  function clearUltReadyBanner() {
    if (state.ultReadyBannerTimer) {
      window.clearTimeout(state.ultReadyBannerTimer);
      state.ultReadyBannerTimer = null;
    }
    if (els.ultReadyBanner) {
      els.ultReadyBanner.textContent = '';
      els.ultReadyBanner.classList.remove('is-visible');
      els.ultReadyBanner.setAttribute('aria-hidden', 'true');
    }
  }

  function showUltReadyBanner(message) {
    if (!els.ultReadyBanner || !message) return;
    clearUltReadyBanner();
    els.ultReadyBanner.textContent = message;
    els.ultReadyBanner.classList.add('is-visible');
    els.ultReadyBanner.setAttribute('aria-hidden', 'false');
    state.ultReadyBannerTimer = window.setTimeout(() => {
      clearUltReadyBanner();
    }, 5000);
  }

  function maybeShowUltReadyBanner(battle) {
    if (!battle?.players || !battle?.turn) return;
    const myMark = state.selfMark || 'O';
    const currentUlt = normalizeNumber(battle.players?.[myMark]?.ult, 0);
    const previousUlt = state.lastUltValueByMark?.[myMark];
    state.lastUltValueByMark[myMark] = currentUlt;
    if (previousUlt === null || previousUlt === undefined) return;
    if (battle.turn.turnPlayer !== myMark) return;
    if (previousUlt >= 100 || currentUlt < 100) return;
    const myCamp = battle.players?.[myMark]?.camp || 'light';
    showUltReadyBanner(`${campLabel(myCamp)}方陣營大招已可釋放，按空白鍵可立即施放`);
  }

  function subscribeRoomGuard() {
    const ref = firebaseApi.db.ref(`${ROOMS_PATH}/${state.roomId}`);
    const handler = ref.on('value', (snapshot) => {
      const room = snapshot.val();
      const enemyMark = state.selfMark === 'O' ? 'X' : 'O';
      if (!room) {
        if (state.entryStable) handleOpponentLeft('對手已離開，請重回菜單。');
        else redirectToRoom();
        return;
      }
      const player = room.players?.[state.selfMark];
      if (!player || !player.joined) {
        redirectToRoom();
        return;
      }
      const enemy = room.players?.[enemyMark];
      if (state.entryStable && (!enemy || !enemy.joined)) {
        handleOpponentLeft('對手已離開，請重回菜單。');
      }
    });
    state.unsubscribeRoom = () => ref.off('value', handler);
  }

  function bindLifecycleCleanup() {
    const handleExit = () => {
      if (state.unsubscribeBattle) state.unsubscribeBattle();
      if (state.unsubscribeRoom) state.unsubscribeRoom();
      if (state.entryStableTimer) window.clearTimeout(state.entryStableTimer);
      if (state.missingBattleTimer) window.clearTimeout(state.missingBattleTimer);
      stopTurnLoops();
      sendExitCleanupKeepalive();
      cancelDisconnectTasks();
      clearLocalRoomEntry();
    };
    window.addEventListener('pagehide', handleExit);
    window.addEventListener('beforeunload', handleExit);
  }

  function transactionBattle(mutator) {
    const ref = firebaseApi.db.ref(`${BATTLE_PATH}/${state.roomId}`);
    return new Promise((resolve, reject) => {
      ref.transaction((current) => mutator(current), (error, committed, snapshot) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ committed, snapshot: snapshot ? snapshot.val() : null });
      }, false);
    });
  }

  function createNextTurnState(previousTurn, currentBattle) {
    const nextPlayer = previousTurn.turnPlayer === 'O' ? 'X' : 'O';
    if (currentBattle && currentBattle.players && currentBattle.players[nextPlayer]) {
      currentBattle.players[nextPlayer].shieldStacks = 0;
    }
    if (currentBattle) {
      cleanupEndOfTurnEffects(currentBattle, previousTurn.turnPlayer);
      applyTurnStartBookkeeping(currentBattle, nextPlayer);
    }
    return {
      turnPlayer: nextPlayer,
      turnNumber: Number(previousTurn.turnNumber || 1) + 1,
      turnEndsAt: Date.now() + TURN_DURATION_MS,
      piecePlacedThisTurn: false,
      skillUsedCount: 0,
      isResolving: false
    };
  }

  function createSkillFeedback(targetMark, kind, amount) {
    const events = [createFeedbackEvent(targetMark, kind, amount)];
    return {
      id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      events,
      expiresAt: Date.now() + 2200
    };
  }

  function spendUltGain(player, amount) {
    player.ult = Math.min(100, normalizeNumber(player.ult, 0) + amount);
  }


  function canUseUltimateNow(player, battleTurn) {
    if (!player || !battleTurn) return false;
    if (!battleTurn.piecePlacedThisTurn) return false;
    if (battleTurn.isResolving) return false;
    return normalizeNumber(player.ult, 0) >= 100;
  }

  function isMageUltimateAvailable(current, actorMark) {
    if (!current || !current.turn || !current.players) return false;
    const actor = current.players[actorMark];
    if (!actor || (actor.role || '') !== 'mage') return false;
    if (current.turn.turnPlayer !== actorMark) return false;
    const playerState = getPlayerState(current, actorMark);
    if (playerState?.activeSkillLock) return false;
    return canUseUltimateNow(actor, current.turn);
  }

  function isMageActiveAvailable(current, actorMark) {
    if (!current || !current.turn || !current.players) return false;
    const actor = current.players[actorMark];
    if (!actor || (actor.role || '') !== 'mage') return false;
    if (current.turn.turnPlayer !== actorMark) return false;
    if (!current.turn.piecePlacedThisTurn) return false;
    if (current.turn.isResolving) return false;
    if (normalizeNumber(current.turn.skillUsedCount, 0) >= 3) return false;
    const playerState = getPlayerState(current, actorMark);
    if (playerState?.activeSkillLock) return false;
    if (normalizeNumber(actor.sp, 0) < 3) return false;
    const board = normalizeBoard(current.board);
    const tileEffects = normalizeTileEffects(current.tileEffects);
    return board.some((mark, index) => !mark && !(tileEffects[index] && tileEffects[index].effectType === 'mage_seal' && tileEffects[index].blockedMark === actorMark));
  }

  function createMageSealEffect(ownerMark, targetMark, createdTurn) {
    return {
      effectType: 'mage_seal',
      ownerMark,
      ownerRole: 'mage',
      blockedMark: targetMark,
      createdTurn: normalizeNumber(createdTurn, 1),
      expiresAtTurnEndOf: targetMark,
      iconKey: 'icon_mage_seal'
    };
  }


  function isGuardedStatus(status) {
    if (!status || typeof status !== 'object') return false;
    return status.statusType === 'knight_guarded' || status.statusType === 'guarded';
  }

  function getOrthogonalAdjacentIndexes(index) {
    const value = Number(index);
    if (!Number.isInteger(value) || value < 0 || value > 8) return [];
    const row = Math.floor(value / 3);
    const col = value % 3;
    const results = [];
    if (row > 0) results.push(value - 3);
    if (row < 2) results.push(value + 3);
    if (col > 0) results.push(value - 1);
    if (col < 2) results.push(value + 1);
    return results;
  }

  function getAdjacentEightIndexes(index) {
    const value = Number(index);
    if (!Number.isInteger(value) || value < 0 || value > 8) return [];
    const row = Math.floor(value / 3);
    const col = value % 3;
    const results = [];
    for (let r = row - 1; r <= row + 1; r += 1) {
      for (let c = col - 1; c <= col + 1; c += 1) {
        if (r === row && c === col) continue;
        if (r < 0 || r > 2 || c < 0 || c > 2) continue;
        results.push(r * 3 + c);
      }
    }
    return results;
  }

  function isIsolatedStatus(status, targetMark) {
    if (!status || typeof status !== 'object') return false;
    return status.statusType === 'assassin_isolated' && (!targetMark || status.targetMark === targetMark);
  }

  function getAssassinSwapTargetIndexes(current, actorMark, sourceIndex) {
    if (!current || !current.players) return [];
    const enemyMark = actorMark === 'O' ? 'X' : 'O';
    const board = normalizeBoard(current.board);
    return getOrthogonalAdjacentIndexes(sourceIndex).filter((targetIndex) => {
      if (board[targetIndex] !== enemyMark) return false;
      const enemyRecord = findPieceRecordAtIndex(current, targetIndex, enemyMark);
      const enemyStatus = enemyRecord?.pieceId ? current?.pieceStatus?.[enemyRecord.pieceId] : null;
      return !isGuardedStatus(enemyStatus);
    });
  }

  function getAssassinSourceIndexes(current, actorMark) {
    if (!current || !current.players) return [];
    const board = normalizeBoard(current.board);
    return board
      .map((mark, index) => ({ mark, index }))
      .filter((entry) => entry.mark === actorMark)
      .map((entry) => entry.index)
      .filter((index) => getAssassinSwapTargetIndexes(current, actorMark, index).length > 0);
  }

  function isAssassinActiveAvailable(current, actorMark) {
    if (!current || !current.turn || !current.players) return false;
    const actor = current.players[actorMark];
    if (!actor || (actor.role || '') !== 'assassin') return false;
    if (current.turn.turnPlayer !== actorMark) return false;
    if (!current.turn.piecePlacedThisTurn) return false;
    if (current.turn.isResolving) return false;
    if (normalizeNumber(current.turn.skillUsedCount, 0) >= 3) return false;
    const playerState = getPlayerState(current, actorMark);
    if (playerState?.activeSkillLock) return false;
    if (normalizeNumber(actor.sp, 0) < 3) return false;
    return getAssassinSourceIndexes(current, actorMark).length > 0;
  }

  function getAssassinUltPrimaryIndexes(current, actorMark) {
    if (!current || !current.players) return [];
    const enemyMark = actorMark === 'O' ? 'X' : 'O';
    const board = normalizeBoard(current.board);
    return board
      .map((mark, index) => ({ mark, index }))
      .filter((entry) => entry.mark === enemyMark)
      .map((entry) => entry.index)
      .filter((index) => {
        const record = findPieceRecordAtIndex(current, index, enemyMark);
        const status = record?.pieceId ? current?.pieceStatus?.[record.pieceId] : null;
        return !isGuardedStatus(status);
      });
  }

  function getAssassinUltSecondaryIndexes(current, actorMark, primaryIndex) {
    if (!current || !current.players) return [];
    const enemyMark = actorMark === 'O' ? 'X' : 'O';
    const board = normalizeBoard(current.board);
    return getAdjacentEightIndexes(primaryIndex).filter((index) => {
      if (index === Number(primaryIndex)) return false;
      if (board[index] !== enemyMark) return false;
      const record = findPieceRecordAtIndex(current, index, enemyMark);
      const status = record?.pieceId ? current?.pieceStatus?.[record.pieceId] : null;
      return !isGuardedStatus(status);
    });
  }

  function isAssassinUltimateAvailable(current, actorMark) {
    if (!current || !current.turn || !current.players) return false;
    const actor = current.players[actorMark];
    if (!actor || (actor.role || '') !== 'assassin') return false;
    return canUseUltimateNow(actor, current.turn) && getAssassinUltPrimaryIndexes(current, actorMark).length > 0;
  }

  function getKnightSourceIndexes(current, actorMark) {
    if (!current || !current.players) return [];
    const board = normalizeBoard(current.board);
    return board
      .map((mark, index) => ({ mark, index }))
      .filter(({ mark, index }) => mark === actorMark && getKnightTargetIndexes(current, actorMark, index).length > 0)
      .map(({ index }) => index);
  }

  function getKnightTargetIndexes(current, actorMark, sourceIndex) {
    if (!current || !current.players) return [];
    const board = normalizeBoard(current.board);
    if (board[sourceIndex] !== actorMark) return [];
    return getOrthogonalAdjacentIndexes(sourceIndex).filter((index) => board[index] === null);
  }

  function isKnightActiveAvailable(current, actorMark) {
    if (!current || !current.turn || !current.players) return false;
    const actor = current.players[actorMark];
    if (!actor || (actor.role || '') !== 'knight') return false;
    if (current.turn.turnPlayer !== actorMark) return false;
    if (!current.turn.piecePlacedThisTurn) return false;
    if (current.turn.isResolving) return false;
    if (normalizeNumber(current.turn.skillUsedCount, 0) >= 3) return false;
    const playerState = getPlayerState(current, actorMark);
    if (playerState?.activeSkillLock) return false;
    if (normalizeNumber(actor.sp, 0) < 3) return false;
    return getKnightSourceIndexes(current, actorMark).length > 0;
  }

  function getKnightUltTargetIndexes(current, actorMark) {
    if (!current || !current.players) return [];
    const board = normalizeBoard(current.board);
    return board
      .map((mark, index) => ({ mark, index }))
      .filter(({ mark }) => mark === actorMark)
      .map(({ index }) => index);
  }

  function isKnightUltimateAvailable(current, actorMark) {
    if (!current || !current.turn || !current.players) return false;
    const actor = current.players[actorMark];
    if (!actor || (actor.role || '') !== 'knight') return false;
    if (current.turn.turnPlayer !== actorMark) return false;
    const playerState = getPlayerState(current, actorMark);
    if (playerState?.activeSkillLock) return false;
    if (!canUseUltimateNow(actor, current.turn)) return false;
    return getKnightUltTargetIndexes(current, actorMark).length > 0;
  }

  function resetUiMode() {
    state.uiMode = 'idle';
    state.activeSkill = null;
    state.selectedSourceIndex = null;
    state.selectedUltPrimaryIndex = null;
  }

  function canUseAnyPostPlaceAction(current, actorMark) {
    if (!current || !current.turn || !current.players) return false;
    const actor = current.players[actorMark];
    if (!actor) return false;
    if (current.turn.turnPlayer !== actorMark) return false;
    if (!current.turn.piecePlacedThisTurn) return false;
    if (current.turn.isResolving) return false;
    const used = normalizeNumber(current.turn.skillUsedCount, 0);
    const sp = normalizeNumber(actor.sp, 0);
    const canUseCommon = used < 3 && (
      sp >= getCommonSkillCost(current, actorMark, 'atk') ||
      sp >= getCommonSkillCost(current, actorMark, 'def') ||
      sp >= getCommonSkillCost(current, actorMark, 'hel')
    );
    if (canUseCommon) return true;
    if (isMageActiveAvailable(current, actorMark)) return true;
    if (isAssassinActiveAvailable(current, actorMark)) return true;
    if (isKnightActiveAvailable(current, actorMark)) return true;
    if ((actor.role || '') === 'mage' && isMageUltimateAvailable(current, actorMark)) return true;
    if ((actor.role || '') === 'assassin' && isAssassinUltimateAvailable(current, actorMark)) return true;
    if ((actor.role || '') === 'knight' && isKnightUltimateAvailable(current, actorMark)) return true;
    return false;
  }


  function resolveDarkStackAttackBonus(current, actor, target) {
    const stacks = Math.max(0, Math.min(2, normalizeNumber(actor?.darkStacks, 0)));
    if (stacks <= 0) return 0;
    if (stacks === 1) return 4;
    const seedParts = [
      state.roomId || '',
      current?.turn?.turnNumber || 0,
      current?.turn?.skillUsedCount || 0,
      actor?.hp || 0,
      actor?.sp || 0,
      target?.hp || 0
    ].join(':');
    let hash = 0;
    for (let i = 0; i < seedParts.length; i += 1) hash = (hash * 33 + seedParts.charCodeAt(i)) % 1000;
    const roll = hash % 100;
    if (roll < 40) return 6;
    if (roll < 80) return 8;
    return 4;
  }

  async function useCommonSkill(skill) {
    const battle = getMyBattle();
    const cfg = SKILL_CONFIG[skill];
    if (!battle || !cfg || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn || !current.players) return current;
        if (current.turn.turnPlayer !== state.selfMark) return;
        if (current.turn.isResolving) return;
        if (!current.turn.piecePlacedThisTurn) return;
        if (normalizeNumber(current.turn.skillUsedCount, 0) >= 3) return;
        const actor = current.players[state.selfMark];
        const enemyMark = state.selfMark === 'O' ? 'X' : 'O';
        const target = current.players[enemyMark];
        if (!actor || !target) return;
        const actualCost = getCommonSkillCost(current, state.selfMark, skill);
        if (normalizeNumber(actor.sp, 0) < actualCost) return;
        actor.sp = Math.max(0, normalizeNumber(actor.sp, 0) - actualCost);
        current.turn.skillUsedCount = normalizeNumber(current.turn.skillUsedCount, 0) + 1;
        let events = [];
        if (skill === 'def') {
          actor.shieldStacks = Math.min(2, normalizeNumber(actor.shieldStacks, 0) + 1);
          spendUltGain(actor, cfg.ultGain);
          events.push(createFeedbackEvent(state.selfMark, 'ult', cfg.ultGain));
        }
        if (skill === 'hel') {
          actor.hp = Math.min(100, normalizeNumber(actor.hp, 100) + cfg.heal);
          spendUltGain(actor, cfg.ultGain);
          events.push(createFeedbackEvent(state.selfMark, 'heal', cfg.heal));
          events.push(createFeedbackEvent(state.selfMark, 'ult', cfg.ultGain));
        }
        if (skill === 'atk') {
          const shields = normalizeNumber(target.shieldStacks, 0);
          const darkBonus = (actor.camp === 'dark') ? resolveDarkStackAttackBonus(current, actor, target) : 0;
          const playerState = getPlayerState(current, state.selfMark);
          const ultAtkBonus = normalizeNumber(playerState?.nextAtkBonus?.amount, 0);
          const finalDamage = cfg.damage + darkBonus + ultAtkBonus;
          if (shields > 0) {
            target.shieldStacks = Math.max(0, shields - 1);
            events.push(createFeedbackEvent(enemyMark, 'block', 0));
          } else {
            target.hp = Math.max(0, normalizeNumber(target.hp, 100) - finalDamage);
            events.push(createFeedbackEvent(enemyMark, 'damage', finalDamage));
          }
          if (actor.camp === 'dark' && normalizeNumber(actor.darkStacks, 0) > 0) actor.darkStacks = 0;
          const attackerState = getPlayerState(current, state.selfMark);
          if (attackerState?.nextAtkBonus) attackerState.nextAtkBonus = null;
          spendUltGain(actor, cfg.ultGain);
          events.push(createFeedbackEvent(state.selfMark, 'ult', cfg.ultGain));
        }
        applyGameOverIfNeeded(current, skill === 'atk' ? '攻擊擊倒' : null);
        current.feedback = events.length ? {
          id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          events,
          expiresAt: Date.now() + 2200
        } : null;
        return current;
      });
      if (result && result.committed) playSound(cfg.sound);
    } catch (error) {
      console.error(`useCommonSkill(${skill}) failed`, error);
    } finally {
      state.actionInFlight = false;
      updateActionStates(getMyBattle());
    }
  }

  async function useMageActiveSeal(cellIndex) {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn || !current.players) return current;
        if (!isMageActiveAvailable(current, state.selfMark)) return current;
        ensureBattleStateLayers(current);
        const board = normalizeBoard(current.board);
        if (board[cellIndex]) return current;
        current.tileEffects = normalizeTileEffects(current.tileEffects);
        const existingEffect = current.tileEffects[cellIndex];
        if (existingEffect && existingEffect.effectType === 'mage_seal' && existingEffect.blockedMark === state.selfMark) return current;
        const actor = current.players[state.selfMark];
        if (!actor) return current;
        actor.sp = Math.max(0, normalizeNumber(actor.sp, 0) - 3);
        spendUltGain(actor, 35);
        current.turn.skillUsedCount = normalizeNumber(current.turn.skillUsedCount, 0) + 1;
        const enemyMark = state.selfMark === 'O' ? 'X' : 'O';
        current.tileEffects[cellIndex] = createMageSealEffect(state.selfMark, enemyMark, current.turn.turnNumber);
        current.feedback = createSkillFeedback(state.selfMark, 'ult', 35);
        return current;
      });
      if (result && result.committed) playSound('def');
    } catch (error) {
      console.error('useMageActiveSeal failed', error);
    } finally {
      state.actionInFlight = false;
      resetUiMode();
      updateActionStates(getMyBattle());
    }
  }


  async function useAssassinActiveSwap(sourceIndex, targetIndex) {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn || !current.players) return current;
        if (!isAssassinActiveAvailable(current, state.selfMark)) return current;
        ensureBattleStateLayers(current);
        const board = normalizeBoard(current.board);
        const enemyMark = state.selfMark === 'O' ? 'X' : 'O';
        if (board[sourceIndex] !== state.selfMark) return current;
        if (board[targetIndex] !== enemyMark) return current;
        if (!getOrthogonalAdjacentIndexes(sourceIndex).includes(Number(targetIndex))) return current;
        const legalTargets = getAssassinSwapTargetIndexes(current, state.selfMark, sourceIndex);
        if (!legalTargets.includes(Number(targetIndex))) return current;
        const actor = current.players[state.selfMark];
        if (!actor) return current;
        actor.sp = Math.max(0, normalizeNumber(actor.sp, 0) - 3);
        spendUltGain(actor, 35);
        current.turn.skillUsedCount = normalizeNumber(current.turn.skillUsedCount, 0) + 1;

        const sourceRecord = findPieceRecordAtIndex(current, sourceIndex, state.selfMark);
        const targetRecord = findPieceRecordAtIndex(current, targetIndex, enemyMark);
        if (!sourceRecord?.pieceId || !targetRecord?.pieceId) return current;

        board[sourceIndex] = enemyMark;
        board[targetIndex] = state.selfMark;

        current.players[state.selfMark].pieceOrder = ensurePieceIds(current.players[state.selfMark].pieceOrder, state.selfMark).map((item) => (
          item.pieceId === sourceRecord.pieceId ? { ...item, index: Number(targetIndex) } : item
        ));
        current.players[enemyMark].pieceOrder = ensurePieceIds(current.players[enemyMark].pieceOrder, enemyMark).map((item) => (
          item.pieceId === targetRecord.pieceId ? { ...item, index: Number(sourceIndex) } : item
        ));

        let nextBoard = board;
        const completedLines = findCompletedLines(current, nextBoard, state.selfMark);
        if (completedLines.length) {
          current.turn.isResolving = true;
          nextBoard = applyLineResolutionToCurrent(current, nextBoard, state.selfMark, completedLines);
        }

        current.board = nextBoard;
        current.turn.isResolving = false;
        current.feedback = {
          id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          events: [createFeedbackEvent(state.selfMark, 'ult', 35)],
          expiresAt: Date.now() + 2200
        };
        if (!canUseAnyPostPlaceAction(current, state.selfMark)) {
          current.turn = createNextTurnState(current.turn, current);
        }
        return current;
      });
      if (result && result.committed) playSound('def');
    } catch (error) {
      console.error('useAssassinActiveSwap failed', error);
    } finally {
      state.actionInFlight = false;
      resetUiMode();
      updateActionStates(getMyBattle());
    }
  }


  async function useKnightActiveMove(sourceIndex, targetIndex) {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn || !current.players) return current;
        if (!isKnightActiveAvailable(current, state.selfMark)) return current;
        ensureBattleStateLayers(current);
        const board = normalizeBoard(current.board);
        if (board[sourceIndex] !== state.selfMark) return current;
        if (board[targetIndex] !== null) return current;
        const legalTargets = getKnightTargetIndexes(current, state.selfMark, sourceIndex);
        if (!legalTargets.includes(Number(targetIndex))) return current;
        const actor = current.players[state.selfMark];
        if (!actor) return current;
        actor.sp = Math.max(0, normalizeNumber(actor.sp, 0) - 3);
        spendUltGain(actor, 35);
        current.turn.skillUsedCount = normalizeNumber(current.turn.skillUsedCount, 0) + 1;

        const sourceRecord = findPieceRecordAtIndex(current, sourceIndex, state.selfMark);
        if (!sourceRecord?.pieceId) return current;

        board[sourceIndex] = null;
        board[targetIndex] = state.selfMark;
        current.players[state.selfMark].pieceOrder = ensurePieceIds(current.players[state.selfMark].pieceOrder, state.selfMark).map((item) => (
          item.pieceId === sourceRecord.pieceId ? { ...item, index: Number(targetIndex) } : item
        ));

        let nextBoard = board;
        const completedLines = findCompletedLines(current, nextBoard, state.selfMark);
        if (completedLines.length) {
          current.turn.isResolving = true;
          nextBoard = applyLineResolutionToCurrent(current, nextBoard, state.selfMark, completedLines);
        }

        current.board = nextBoard;
        current.turn.isResolving = false;
        current.feedback = {
          id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          events: [createFeedbackEvent(state.selfMark, 'ult', 35)],
          expiresAt: Date.now() + 2200
        };
        if (!canUseAnyPostPlaceAction(current, state.selfMark)) {
          current.turn = createNextTurnState(current.turn, current);
        }
        return current;
      });
      if (result && result.committed) playSound('def');
    } catch (error) {
      console.error('useKnightActiveMove failed', error);
    } finally {
      state.actionInFlight = false;
      resetUiMode();
      updateActionStates(getMyBattle());
    }
  }


  async function useKnightUltimate(targetIndex) {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn || !current.players) return current;
        if (!isKnightUltimateAvailable(current, state.selfMark)) return current;
        ensureBattleStateLayers(current);
        const actor = current.players[state.selfMark];
        const board = normalizeBoard(current.board);
        if (!actor || board[targetIndex] !== state.selfMark) return current;
        const legalTargets = getKnightUltTargetIndexes(current, state.selfMark);
        if (!legalTargets.includes(Number(targetIndex))) return current;
        const targetRecord = findPieceRecordAtIndex(current, targetIndex, state.selfMark);
        if (!targetRecord?.pieceId) return current;
        actor.ult = 0;
        actor.shieldStacks = Math.min(2, normalizeNumber(actor.shieldStacks, 0) + 2);
        actor.hp = Math.min(100, normalizeNumber(actor.hp, 100) + 15);
        const actorState = getPlayerState(current, state.selfMark);
        actorState.knightUltHealPending = {
          amount: 15,
          remainingOpponentTurnEnds: 1
        };
        current.pieceStatus[targetRecord.pieceId] = {
          statusType: 'knight_guarded',
          ownerMark: state.selfMark,
          targetMark: state.selfMark,
          opponentMark: getOpponentMark(state.selfMark),
          remainingOpponentTurnEnds: 2
        };
        current.feedback = {
          id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          events: [createFeedbackEvent(state.selfMark, 'heal', 15)],
          expiresAt: Date.now() + 2200
        };
        current.cinematics.ultEvent = createCinematicEvent('knight', state.selfMark, 'ult');
        return current;
      });
      if (result && result.committed) playSound('stn');
    } catch (error) {
      console.error('useKnightUltimate failed', error);
    } finally {
      state.actionInFlight = false;
      resetUiMode();
      updateActionStates(getMyBattle());
    }
  }

  async function useMageUltimate() {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn || !current.players) return current;
        if (!isMageUltimateAvailable(current, state.selfMark)) return current;
        ensureBattleStateLayers(current);
        const actor = current.players[state.selfMark];
        const enemyMark = state.selfMark === 'O' ? 'X' : 'O';
        const enemyState = getPlayerState(current, enemyMark);
        if (!actor || !enemyState) return current;
        actor.ult = 0;
        actor.sp = Math.min(100, normalizeNumber(actor.sp, 0) + 30);
        enemyState.activeSkillLock = {
          source: 'mage_ult',
          ownerMark: state.selfMark,
          amount: 1,
          expiresAtTurnEndOf: enemyMark
        };
        current.feedback = {
          id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          events: [
            createFeedbackEvent(state.selfMark, 'sp', 30)
          ],
          expiresAt: Date.now() + 2200
        };
        current.cinematics.ultEvent = createCinematicEvent('mage', state.selfMark, 'ult');
        return current;
      });
      if (result && result.committed) playSound('stn');
    } catch (error) {
      console.error('useMageUltimate failed', error);
    } finally {
      state.actionInFlight = false;
      updateActionStates(getMyBattle());
    }
  }

  async function useAssassinUltimate(primaryIndex, secondaryIndex) {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn || !current.players) return current;
        if (!isAssassinUltimateAvailable(current, state.selfMark)) return current;
        ensureBattleStateLayers(current);
        const actor = current.players[state.selfMark];
        const enemyMark = state.selfMark === 'O' ? 'X' : 'O';
        const board = normalizeBoard(current.board);
        if (!actor || board[primaryIndex] !== enemyMark) return current;
        const legalPrimary = getAssassinUltPrimaryIndexes(current, state.selfMark);
        if (!legalPrimary.includes(Number(primaryIndex))) return current;
        let targets = [Number(primaryIndex)];
        const legalSecondary = getAssassinUltSecondaryIndexes(current, state.selfMark, primaryIndex).filter((idx) => idx !== Number(primaryIndex));
        if (secondaryIndex !== null && secondaryIndex !== undefined) {
          if (!legalSecondary.includes(Number(secondaryIndex))) return current;
          targets.push(Number(secondaryIndex));
        }
        actor.ult = 0;
        const actorState = getPlayerState(current, state.selfMark);
        actorState.nextAtkBonus = {
          source: 'assassin_ult',
          amount: 6,
          expiresAtTurnEndOf: state.selfMark
        };
        targets.forEach((index) => {
          const record = findPieceRecordAtIndex(current, index, enemyMark);
          if (!record?.pieceId) return;
          current.pieceStatus[record.pieceId] = {
            statusType: 'assassin_isolated',
            ownerMark: state.selfMark,
            targetMark: enemyMark,
            expiresAtTurnEndOf: enemyMark
          };
        });
        current.feedback = null;
        current.cinematics.ultEvent = createCinematicEvent('assassin', state.selfMark, 'ult');
        return current;
      });
      if (result && result.committed) playSound('stn');
    } catch (error) {
      console.error('useAssassinUltimate failed', error);
    } finally {
      state.actionInFlight = false;
      resetUiMode();
      updateActionStates(getMyBattle());
    }
  }

  async function placePiece(cellIndex) {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn) return current;
        if (current.phase === 'GAME_OVER' || current.phase === 'RESULT_CHOICE') return current;
        if (current.turn.isResolving) return current;
        if (current.turn.turnPlayer !== state.selfMark) return current;
        if (current.turn.piecePlacedThisTurn) return current;
        ensureBattleStateLayers(current);
        const board = normalizeBoard(current.board);
        if (board[cellIndex]) return current;
        const currentTileEffects = normalizeTileEffects(current.tileEffects);
        const targetEffect = currentTileEffects[cellIndex];
        if (targetEffect && targetEffect.effectType === 'mage_seal' && targetEffect.blockedMark === state.selfMark) return current;

        current.players = current.players || {};
        current.players[state.selfMark] = current.players[state.selfMark] || { pieceOrder: [] };
        const enemyMark = state.selfMark === 'O' ? 'X' : 'O';
        current.players[enemyMark] = current.players[enemyMark] || { pieceOrder: [] };
        current.tileEffects = currentTileEffects;
        ensureBattleStateLayers(current);
        current.players[state.selfMark].pieceOrder = ensurePieceIds(current.players[state.selfMark].pieceOrder, state.selfMark);
        current.players[enemyMark].pieceOrder = ensurePieceIds(current.players[enemyMark].pieceOrder, enemyMark);

        let nextOrder = normalizePieceOrder(current.players[state.selfMark].pieceOrder);
        if (nextOrder.length >= 3) {
          const oldest = nextOrder[0];
          if (oldest && board[oldest.index] === state.selfMark) {
            const shouldTriggerMagePassive = canTriggerMagePassive(current, state.selfMark);
            const shouldTriggerAssassinPassive = (current.players[state.selfMark].role || '') === 'assassin' && normalizeNumber(getPlayerState(current, state.selfMark)?.ownTurnStarts, 0) >= normalizeNumber(getPlayerState(current, state.selfMark)?.assassinPassiveReadyAtOwnTurnStart, 1);
            const shouldTriggerKnightPassive = canTriggerKnightPassive(current, state.selfMark);
            if (shouldTriggerKnightPassive && oldest.pieceId) {
              current.delayedRemoval[state.selfMark] = {
                pieceId: oldest.pieceId,
                ownerMark: state.selfMark,
                remainingOpponentTurnEnds: 1
              };
              const ownerState = getPlayerState(current, state.selfMark);
              ownerState.knightPassiveReadyAtOwnTurnStart = normalizeNumber(ownerState.ownTurnStarts, 0) + 3;
              ownerState.recentKnightPassiveTrigger = { triggered: true, clearOnOwnTurnStart: state.selfMark };
            } else {
              board[oldest.index] = null;
              if (oldest.pieceId && current.pieceStatus[oldest.pieceId]) delete current.pieceStatus[oldest.pieceId];
              if (shouldTriggerMagePassive) {
                current.tileEffects[oldest.index] = createAfterimageEffect(state.selfMark, enemyMark, current.turn.turnNumber);
                const ownerState = getPlayerState(current, state.selfMark);
                ownerState.magePassiveReadyAtOwnTurnStart = normalizeNumber(ownerState.ownTurnStarts, 0) + 4;
              }
              if (shouldTriggerAssassinPassive) {
                const enemyOrder = normalizePieceOrder(current.players[enemyMark].pieceOrder).filter((item) => board[item.index] === enemyMark);
                const latestEnemy = enemyOrder.length ? enemyOrder[enemyOrder.length - 1] : null;
                if (latestEnemy?.pieceId) {
                  current.pieceStatus[latestEnemy.pieceId] = {
                    statusType: 'assassin_fragile',
                    ownerMark: state.selfMark,
                    targetMark: enemyMark,
                    expiresAtTurnEndOf: enemyMark
                  };
                  const ownerState = getPlayerState(current, state.selfMark);
                  ownerState.assassinPassiveReadyAtOwnTurnStart = normalizeNumber(ownerState.ownTurnStarts, 0) + 4;
                  ownerState.recentFragileTrigger = { targetIndex: latestEnemy.index, clearOnOwnTurnStart: state.selfMark };
                }
              }
              nextOrder = nextOrder.slice(1);
            }
          }
        }

        board[cellIndex] = state.selfMark;
        const afterimage = current.tileEffects[cellIndex];
        if (afterimage && afterimage.effectType === 'mage_afterimage' && afterimage.ownerMark !== state.selfMark) {
          const actorState = getPlayerState(current, state.selfMark);
          actorState.commonSkillTax = { amount: 20, source: 'mage_afterimage', expiresAtTurnEndOf: state.selfMark };
          actorState.recentAfterimageTrigger = { amount: 20, clearOnOwnTurnStart: state.selfMark };
          delete current.tileEffects[cellIndex];
        }
        const maxPlacedOrder = nextOrder.reduce((maxValue, item) => Math.max(maxValue, Number(item.placedOrder || 0)), 0);
        nextOrder.push({ index: cellIndex, placedOrder: maxPlacedOrder + 1, pieceId: createPieceId(state.selfMark) });

        let nextBoard = board;
        current.players[state.selfMark].pieceOrder = nextOrder;
        const completedLines = findCompletedLines(current, nextBoard, state.selfMark);
        if (completedLines.length) {
          current.turn.isResolving = true;
          nextBoard = applyLineResolutionToCurrent(current, nextBoard, state.selfMark, completedLines);
        }

        current.board = nextBoard;
        current.turn.piecePlacedThisTurn = true;
        current.turn.isResolving = false;
        if (!canUseAnyPostPlaceAction(current, state.selfMark)) {
          current.turn = createNextTurnState(current.turn, current);
        }
        return current;
      });
      if (result && result.committed) playSound('tap');
    } catch (error) {
      console.error('placePiece failed', error);
    } finally {
      state.actionInFlight = false;
      updateActionStates(getMyBattle());
    }
  }

  async function endTurn() {
    const battle = getMyBattle();
    if (!battle || state.actionInFlight) return;
    state.actionInFlight = true;
    updateActionStates(battle);
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn) return current;
        if (current.turn.turnPlayer !== state.selfMark) return;
        if (current.turn.isResolving) return;
        if (!current.turn.piecePlacedThisTurn) return;
        current.turn = createNextTurnState(current.turn, current);
        return current;
      });
    } catch (error) {
      console.error('endTurn failed', error);
    } finally {
      state.actionInFlight = false;
      updateActionStates(getMyBattle());
    }
  }

  async function checkTimeoutAndResolve() {
    const battle = getMyBattle();
    if (!battle || state.timeoutInFlight || state.actionInFlight) return;
    if (battle.phase === 'RESULT_CHOICE') {
      const expiresAt = Number(battle.rematch?.expiresAt || 0);
      if (expiresAt && Date.now() >= expiresAt) {
        state.timeoutInFlight = true;
        try {
          await transactionBattle((current) => {
            if (!current || current.phase !== 'RESULT_CHOICE') return current;
            const rematch = normalizeRematch(current.rematch);
            if (rematch.expiresAt && Date.now() < rematch.expiresAt) return current;
            rematch.status = 'return_room';
            current.rematch = rematch;
            return current;
          });
        } catch (error) { console.error('result timeout failed', error); } finally { state.timeoutInFlight = false; }
      }
      return;
    }
    if (!battle.turn) return;
    if (battle.turn.turnPlayer !== state.selfMark) return;
    const endsAt = Number(battle.turn.turnEndsAt || 0);
    if (!endsAt || Date.now() < endsAt) return;
    state.timeoutInFlight = true;
    try {
      const result = await transactionBattle((current) => {
        if (!current || !current.turn) return current;
        if (current.turn.turnPlayer !== state.selfMark) return;
        if (current.turn.isResolving) return current;
        const currentEndsAt = Number(current.turn.turnEndsAt || 0);
        if (currentEndsAt && Date.now() < currentEndsAt) return current;
        current.turn = createNextTurnState(current.turn, current);
        return current;
      });
    } catch (error) {
      console.error('timeout failed', error);
    } finally {
      state.timeoutInFlight = false;
    }
  }

  function bindUiActions() {
    if (els.grid) {
      els.grid.addEventListener('click', (event) => {
        const cell = event.target.closest('.grid-cell');
        if (!cell) return;
        const index = Number(cell.dataset.cellIndex || '-1');
        if (index < 0) return;
        if (state.uiMode === 'mage_active_targeting' && state.activeSkill === 'mage_seal') {
          useMageActiveSeal(index);
          return;
        }
        if (state.uiMode === 'assassin_active_source' && state.activeSkill === 'assassin_swap') {
          const battle = getMyBattle();
          const legalSources = getAssassinSourceIndexes(battle, state.selfMark);
          if (!legalSources.includes(index)) return;
          state.selectedSourceIndex = index;
          state.uiMode = 'assassin_active_target';
          renderBattle(getMyBattle());
          return;
        }
        if (state.uiMode === 'assassin_active_target' && state.activeSkill === 'assassin_swap') {
          if (Number(state.selectedSourceIndex) === index) {
            state.uiMode = 'assassin_active_source';
            state.selectedSourceIndex = null;
            renderBattle(getMyBattle());
            return;
          }
          useAssassinActiveSwap(state.selectedSourceIndex, index);
          return;
        }
        if (state.uiMode === 'knight_active_source' && state.activeSkill === 'knight_push') {
          const battle = getMyBattle();
          const legalSources = getKnightSourceIndexes(battle, state.selfMark);
          if (!legalSources.includes(index)) return;
          state.selectedSourceIndex = index;
          state.uiMode = 'knight_active_target';
          renderBattle(getMyBattle());
          return;
        }
        if (state.uiMode === 'knight_active_target' && state.activeSkill === 'knight_push') {
          if (Number(state.selectedSourceIndex) === index) {
            state.uiMode = 'knight_active_source';
            state.selectedSourceIndex = null;
            renderBattle(getMyBattle());
            return;
          }
          useKnightActiveMove(state.selectedSourceIndex, index);
          return;
        }
        if (state.uiMode === 'assassin_ult_primary' && state.activeSkill === 'assassin_ult') {
          const battle = getMyBattle();
          const legalPrimary = getAssassinUltPrimaryIndexes(battle, state.selfMark);
          if (!legalPrimary.includes(index)) return;
          const secondary = getAssassinUltSecondaryIndexes(battle, state.selfMark, index);
          state.selectedUltPrimaryIndex = index;
          if (!secondary.length) {
            useAssassinUltimate(index, null);
          } else {
            state.uiMode = 'assassin_ult_secondary';
            renderBattle(getMyBattle());
          }
          return;
        }
        if (state.uiMode === 'assassin_ult_secondary' && state.activeSkill === 'assassin_ult') {
          const battle = getMyBattle();
          const legalSecondary = getAssassinUltSecondaryIndexes(battle, state.selfMark, state.selectedUltPrimaryIndex).filter((idx) => idx !== Number(state.selectedUltPrimaryIndex));
          if (legalSecondary.includes(index)) {
            useAssassinUltimate(state.selectedUltPrimaryIndex, index);
            return;
          }
          const board = normalizeBoard(battle?.board);
          if (board[index] === null) {
            useAssassinUltimate(state.selectedUltPrimaryIndex, null);
          }
          return;
        }
        if (state.uiMode === 'knight_ult_target' && state.activeSkill === 'knight_ult') {
          const battle = getMyBattle();
          const legalTargets = getKnightUltTargetIndexes(battle, state.selfMark);
          if (!legalTargets.includes(index)) return;
          useKnightUltimate(index);
          return;
        }
        placePiece(index);
      });
    }
    if (els.endTurnButton) {
      els.endTurnButton.addEventListener('click', () => {
        if (isInteractionLocked()) return;
        endTurn();
      });
    }
    if (els.resultRoomButton) els.resultRoomButton.addEventListener('click', () => chooseResultAction('room'));
    if (els.resultRematchButton) els.resultRematchButton.addEventListener('click', () => chooseResultAction('rematch'));
    els.skillButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        if (isInteractionLocked()) return;
        const skill = button.dataset.skill || '';
        if (skill === 'atk' || skill === 'def' || skill === 'hel') {
          useCommonSkill(skill);
          return;
        }
        if (skill === 'active') {
          const battle = getMyBattle();
          const role = (battle?.players?.[state.selfMark]?.role || '');
          if (role === 'mage') {
            if (!isMageActiveAvailable(battle, state.selfMark)) return;
            if (state.uiMode === 'mage_active_targeting' && state.activeSkill === 'mage_seal') resetUiMode();
            else {
              state.uiMode = 'mage_active_targeting';
              state.activeSkill = 'mage_seal';
            }
          } else if (role === 'assassin') {
            if (!isAssassinActiveAvailable(battle, state.selfMark)) return;
            if ((state.uiMode === 'assassin_active_source' || state.uiMode === 'assassin_active_target') && state.activeSkill === 'assassin_swap') resetUiMode();
            else {
              state.uiMode = 'assassin_active_source';
              state.activeSkill = 'assassin_swap';
              state.selectedSourceIndex = null;
            }
          } else if (role === 'knight') {
            if (!isKnightActiveAvailable(battle, state.selfMark)) return;
            if ((state.uiMode === 'knight_active_source' || state.uiMode === 'knight_active_target') && state.activeSkill === 'knight_push') resetUiMode();
            else {
              state.uiMode = 'knight_active_source';
              state.activeSkill = 'knight_push';
              state.selectedSourceIndex = null;
            }
          } else {
            return;
          }
          renderBattle(getMyBattle());
          return;
        }
        if (skill === 'ult') {
          const battle = getMyBattle();
          const role = (battle?.players?.[state.selfMark]?.role || '');
          if (role === 'mage') {
            useMageUltimate();
          } else if (role === 'assassin') {
            if (!isAssassinUltimateAvailable(battle, state.selfMark)) return;
            if ((state.uiMode === 'assassin_ult_primary' || state.uiMode === 'assassin_ult_secondary') && state.activeSkill === 'assassin_ult') resetUiMode();
            else {
              state.uiMode = 'assassin_ult_primary';
              state.activeSkill = 'assassin_ult';
              state.selectedUltPrimaryIndex = null;
            }
            renderBattle(getMyBattle());
          } else if (role === 'knight') {
            if (!isKnightUltimateAvailable(battle, state.selfMark)) return;
            if (state.uiMode === 'knight_ult_target' && state.activeSkill === 'knight_ult') resetUiMode();
            else {
              state.uiMode = 'knight_ult_target';
              state.activeSkill = 'knight_ult';
            }
            renderBattle(getMyBattle());
          }
        }
      });
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.uiMode !== 'idle') {
        resetUiMode();
        renderBattle(getMyBattle());
        return;
      }
      const isSpace = event.code === 'Space' || event.key === ' ';
      if (!isSpace) return;
      const tag = document.activeElement?.tagName || '';
      const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable;
      if (isTyping) return;
      if (state.uiMode !== 'idle') return;
      if (isInteractionLocked()) return;
      const battle = getMyBattle();
      const role = (battle?.players?.[state.selfMark]?.role || '');
      if (role === 'mage') {
        if (!isMageUltimateAvailable(battle, state.selfMark)) return;
        event.preventDefault();
        useMageUltimate();
        return;
      }
      if (role === 'assassin') {
        if (!isAssassinUltimateAvailable(battle, state.selfMark)) return;
        event.preventDefault();
        state.uiMode = 'assassin_ult_primary';
        state.activeSkill = 'assassin_ult';
        state.selectedUltPrimaryIndex = null;
        renderBattle(getMyBattle());
        return;
      }
      if (role === 'knight') {
        if (!isKnightUltimateAvailable(battle, state.selfMark)) return;
        event.preventDefault();
        state.uiMode = 'knight_ult_target';
        state.activeSkill = 'knight_ult';
        renderBattle(getMyBattle());
      }
    });
  }

  function subscribeBattle() {
    const ref = firebaseApi.db.ref(`${BATTLE_PATH}/${state.roomId}`);
    const handler = ref.on('value', (snapshot) => {
      const battle = snapshot.val();
      if (!battle) {
        if (!state.missingBattleTimer) {
          state.missingBattleTimer = window.setTimeout(() => {
            if (!state.battleLoaded) redirectToRoom();
            else handleOpponentLeft('對手已離開，請重回菜單。');
          }, state.battleLoaded ? 700 : 3000);
        }
        return;
      }
      state.battleLoaded = true;
      if (state.missingBattleTimer) {
        window.clearTimeout(state.missingBattleTimer);
        state.missingBattleTimer = null;
      }
      if (!state.entryStable) {
        if (state.entryStableTimer) window.clearTimeout(state.entryStableTimer);
        state.entryStableTimer = window.setTimeout(() => {
          state.entryStable = true;
        }, 900);
      }
      clearPendingEntryOnly();
      renderBattle(battle);
      beginTurnLoops();
      if (battle.phase === 'RESULT_CHOICE' && battle.rematch?.status === 'return_room' && !state.isRedirecting) {
        window.setTimeout(() => redirectToRoom(), 250);
      }
    });
    state.unsubscribeBattle = () => ref.off('value', handler);
  }

  function init() {
    const params = new URLSearchParams(window.location.search);
    state.roomId = params.get('room') || storage.getPendingBattleRoomId() || storage.getCurrentRoomId() || '';

    if (!firebaseApi || !firebaseApi.isReady || !state.roomId || !state.selfMark) {
      redirectToRoom();
      return;
    }

    storage.setCurrentRoomId(state.roomId);
    storage.setCurrentRoomMark(state.selfMark);
    bindUiActions();
    bindLifecycleCleanup();
    registerDisconnectTasks();
    subscribeRoomGuard();
    subscribeBattle();
  }

  init();
})();
