(function () {
  const storage = window.LightShadowStorage;

  const audio = window.LightShadowAudio;
  if (audio && audio.init) audio.init('name');

  const form = document.getElementById('name-form');
  const nameInput = document.getElementById('player-name');
  const countText = document.getElementById('name-count');
  const previewBox = document.getElementById('name-preview');
  const errorText = document.getElementById('name-error');
  const clearButton = document.getElementById('clear-name');
  const introOverlay = document.getElementById('intro-overlay');
  const introStartButton = document.getElementById('intro-start-button');
  const pageShell = document.getElementById('page-shell');

  const NAME_MAX_LENGTH = 12;
  const ALLOWED_NAME_PATTERN = /^[\u4e00-\u9fffA-Za-z0-9_-]+$/;
  const INTRO_SESSION_KEY = 'lightShadow.nameIntroPlayed';

  function updateCount() {
    countText.textContent = `${nameInput.value.length}/${NAME_MAX_LENGTH}`;
  }

  function updatePreview(value) {
    previewBox.textContent = value
      ? `目前顯示名稱：${value}`
      : '目前顯示名稱：未設定';
  }

  function setError(message) {
    errorText.textContent = message;
  }

  function sanitizeName(value) {
    return value.trim();
  }

  function validateName(value) {
    if (!value) return '請輸入玩家名稱。';
    if (value.length > NAME_MAX_LENGTH) return `玩家名稱不可超過 ${NAME_MAX_LENGTH} 個字元。`;
    if (!ALLOWED_NAME_PATTERN.test(value)) return '名稱只能使用中文、英文、數字、底線（_）、減號（-）。';
    return '';
  }

  function fillSavedName() {
    const savedName = storage.getPlayerName();
    if (!savedName) {
      updateCount();
      updatePreview('');
      return;
    }
    nameInput.value = savedName;
    updateCount();
    updatePreview(savedName);
  }

  function hasPlayedIntroThisSession() {
    try {
      return sessionStorage.getItem(INTRO_SESSION_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function markIntroPlayed() {
    try { sessionStorage.setItem(INTRO_SESSION_KEY, '1'); } catch (error) {}
  }

  function revealNamePage() {
    if (pageShell) {
      pageShell.classList.remove('page-shell-hidden');
      pageShell.classList.add('page-shell-ready');
    }
    document.body.classList.remove('intro-pending');
    document.body.style.overflow = '';
    if (introOverlay) {
      introOverlay.classList.add('is-finishing');
      window.setTimeout(() => {
        introOverlay.classList.add('is-hidden');
        introOverlay.setAttribute('aria-hidden', 'true');
      }, 420);
    }
    window.setTimeout(() => {
      if (nameInput) nameInput.focus();
    }, 260);
  }

  function playIntroSequence(mode) {
    if (!introOverlay) {
      revealNamePage();
      return;
    }
    const isShort = mode === 'short';
    introOverlay.classList.remove('is-full', 'is-short', 'is-finishing');
    introOverlay.classList.add('is-playing', isShort ? 'is-short' : 'is-full');
    introOverlay.setAttribute('aria-hidden', 'false');
    const duration = isShort ? 900 : 2550;
    window.setTimeout(() => {
      introOverlay.classList.remove('is-playing', 'is-full', 'is-short');
      revealNamePage();
    }, duration);
  }

  function startIntroFlow() {
    if (introStartButton) introStartButton.disabled = true;
    if (audio && audio.unlockAudioAndPlay) audio.unlockAudioAndPlay();
    const introMode = hasPlayedIntroThisSession() ? 'short' : 'full';
    if (introMode === 'full') markIntroPlayed();
    playIntroSequence(introMode);
  }

  nameInput.addEventListener('input', function () {
    const currentValue = sanitizeName(nameInput.value);
    updateCount();
    updatePreview(currentValue);
    setError('');
  });

  clearButton.addEventListener('click', function () {
    nameInput.value = '';
    storage.clearPlayerName();
    updateCount();
    updatePreview('');
    setError('');
    nameInput.focus();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const cleanName = sanitizeName(nameInput.value);
    const errorMessage = validateName(cleanName);
    if (errorMessage) {
      setError(errorMessage);
      updatePreview(cleanName);
      nameInput.focus();
      return;
    }
    storage.setPlayerName(cleanName);
    updatePreview(cleanName);
    setError('');
    window.location.href = 'character.html';
  });

  if (introStartButton) {
    introStartButton.addEventListener('click', function (event) {
      event.preventDefault();
      startIntroFlow();
    }, { once: true });
  }

  if (introOverlay && introStartButton) {
    introOverlay.addEventListener('click', function () {
      if (!introOverlay.classList.contains('is-playing') && !introOverlay.classList.contains('is-finishing')) {
        introStartButton.click();
      }
    });
  }

  fillSavedName();
})();
