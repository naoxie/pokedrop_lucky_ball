(() => {
  'use strict';

  // ── 1. Configuration ──────────────────────────────────────────────────
  const CONFIG = Object.freeze({
    total: 20,
    drawDuration: 7200,
    reducedDuration: 1200,
    musicVolume: 0.15,
    suspenseVolume: 0.05,
    storageKey: 'pokedrop-lucky-ball.game.v1',
    closedImage: 'assets/img/pokeball/pokeball_close.png?v=transparent',
  });
  const byId = (id) => document.getElementById(id);
  const ui = {
    grid: byId('pokeball-grid'), status: byId('game-status'),
    draw: byId('draw-button'),
    resume: byId('resume-button'),
    reset: byId('reset-button'),
    victory: byId('victory-dialog'), resetDialog: byId('reset-dialog'),
    winnerNumber: byId('winner-number'), winnerImage: byId('winner-image'),
    sound: byId('music-toggle'), motion: byId('motion-toggle'),
    rulesButton: byId('rules-button'), rules: byId('rules-dialog'),
    notice: byId('app-notice'), video: byId('background-video'),
  };
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const numberLabel = (number) => String(number).padStart(2, '0');
  const openImage = (number) => `assets/img/pokeball/pokeball_${numberLabel(number)}.png`;
  const goldImage = (number) => `assets/img/goldball/pokeball_gold_${numberLabel(number)}.png`;

  // ── 2. État de la partie ──────────────────────────────────────────────
  function newGameState() {
    return { version: 1, selected: [], phase: 'selecting', winner: null, victoryDismissed: false };
  }
  let game = newGameState();
  // Le son nécessite une activation explicite à chaque ouverture de la page.
  let soundEnabled = false;
  let animationRunning = false;
  let animationFrame = 0;
  let volumeFrame = 0;
  let activeBall = null;
  let motionPaused = motionPreference.matches;
  const ballButtons = new Map();
  const ballAnimations = new Map();
  const assetCache = new Map();

  function notify(message) {
    ui.notice.textContent = message;
    ui.notice.hidden = false;
  }

  // ── 3. Sauvegarde locale et validation des données restaurées ──────────
  function saveGame() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(game));
      return true;
    } catch {
      notify('La sauvegarde locale est indisponible. Gardez cette page ouverte pour conserver la partie.');
      return false;
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) return newGameState();
      const saved = JSON.parse(raw);
      const validNumber = (value) => Number.isInteger(value) && value >= 1 && value <= CONFIG.total;
      if (!saved || saved.version !== 1 || !Array.isArray(saved.selected)
          || !saved.selected.every(validNumber)
          || new Set(saved.selected).size !== saved.selected.length
          || !['selecting', 'drawing', 'complete'].includes(saved.phase)) {
        throw new Error('Sauvegarde non valide');
      }
      const locked = saved.phase !== 'selecting';
      if (locked && (saved.selected.length !== CONFIG.total || !validNumber(saved.winner))) {
        throw new Error('Résultat manquant');
      }
      return {
        version: 1, selected: [...saved.selected].sort((a, b) => a - b),
        phase: saved.phase, winner: locked ? saved.winner : null,
        victoryDismissed: saved.phase === 'complete' && saved.victoryDismissed === true,
      };
    } catch {
      notify('La partie sauvegardée n’a pas pu être restaurée. Une nouvelle grille est prête.');
      return newGameState();
    }
  }

  // ── 4. Affichage de la grille ─────────────────────────────────────────
  function createGrid() {
    const fragment = document.createDocumentFragment();
    for (let number = 1; number <= CONFIG.total; number += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pokeball';
      button.dataset.number = String(number);
      const img = document.createElement('img');
      img.className = 'ball-image';
      img.alt = '';
      img.width = 273;
      img.height = 255;
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('error', () => notify('Une image n’a pas pu être chargée. Vérifiez la présence des fichiers dans assets/img.'));
      const caption = document.createElement('span');
      caption.className = 'ball-caption';
      caption.setAttribute('aria-hidden', 'true');
      const check = document.createElement('i');
      check.className = 'ball-check';
      caption.append(check, `N° ${numberLabel(number)}`);
      button.append(img, caption);
      ballButtons.set(number, button);
      fragment.append(button);
    }
    ui.grid.append(fragment);
  }

  function renderBall(number) {
    const button = ballButtons.get(number);
    const selected = game.selected.includes(number);
    const winner = game.phase === 'complete' && game.winner === number;
    const path = winner ? goldImage(number) : selected ? CONFIG.closedImage : openImage(number);
    const img = button.querySelector('img');
    if (img.getAttribute('src') !== path) img.src = path;
    button.classList.toggle('is-selected', selected);
    button.classList.toggle('is-winner', winner);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `Numéro ${number}${winner ? ', gagnant' : selected ? ', sélectionné' : ', disponible'}`);
    button.disabled = game.phase !== 'selecting';
  }

  function renderGame() {
    ballButtons.forEach((_, number) => renderBall(number));
    const count = game.selected.length;
    const ready = count === CONFIG.total && game.phase === 'selecting';
    const complete = game.phase === 'complete';
    const drawing = game.phase === 'drawing';
    const canRestart = complete && game.victoryDismissed && !ui.victory.open;
    const canResume = drawing && !animationRunning;
    document.body.classList.toggle('is-ready', ready);
    document.body.classList.toggle('is-drawing', animationRunning);
    document.body.classList.toggle('is-complete', complete);
    document.body.classList.toggle('can-restart', canRestart);
    document.body.classList.toggle('is-awaiting-reveal', canResume);
    ui.draw.hidden = !ready;
    ui.draw.disabled = !ready;
    ui.resume.hidden = !canResume;
    ui.reset.hidden = !canRestart;
    ui.reset.disabled = !canRestart;
    ui.rulesButton.disabled = animationRunning;
    ui.grid.setAttribute('aria-busy', String(animationRunning));
    updateAccessibleStatus({ count, ready, complete, drawing });
  }

  function updateAccessibleStatus({ count, ready, complete, drawing }) {
    // Informations destinées aux lecteurs d'écran, sans texte visible sous la grille.
    if (complete) ui.status.textContent = `Numéro gagnant : ${game.winner}.`;
    else if (drawing) ui.status.textContent = animationRunning ? 'Tirage en cours.' : 'Résultat conservé, prêt à être révélé.';
    else ui.status.textContent = `${count} numéros sélectionnés sur ${CONFIG.total}.${ready ? ' Le tirage est prêt.' : ''}`;
  }

  // ── 5. Sélection et désélection, sans changement d'ordre ───────────────
  function toggleSelection(number) {
    if (game.phase !== 'selecting' || !ballButtons.has(number)) return;
    const wasSelected = game.selected.includes(number);
    game.selected = wasSelected ? game.selected.filter((value) => value !== number)
      : [...game.selected, number].sort((a, b) => a - b);
    saveGame();
    renderGame();
    animateSelection(number);
    if (game.selected.length === CONFIG.total) preloadGoldImages();
  }

  // ── 6. Aléatoire uniforme : rejet des valeurs créant un biais modulo ──
  function chooseUniformWinner() {
    if (!globalThis.crypto?.getRandomValues) throw new Error('Aléatoire sécurisé indisponible');
    const range = 2 ** 32;
    const limit = Math.floor(range / CONFIG.total) * CONFIG.total;
    const sample = new Uint32Array(1);
    do { crypto.getRandomValues(sample); } while (sample[0] >= limit);
    return (sample[0] % CONFIG.total) + 1;
  }

  function startDraw() {
    if (game.phase !== 'selecting' || game.selected.length !== CONFIG.total) return;
    let winner;
    try { winner = chooseUniformWinner(); }
    catch {
      notify('Le tirage sécurisé n’est pas disponible dans ce navigateur. Ouvrez la page dans un navigateur récent.');
      return;
    }
    // Une seule détermination. On persiste le résultat AVANT tout effet visuel.
    game = { ...game, phase: 'drawing', winner, victoryDismissed: false };
    saveGame();
    animationRunning = true;
    clearSelectionAnimations();
    renderGame();
    fadeMusic(CONFIG.suspenseVolume, 900);
    animateDraw(winner);
  }

  // ── 7. Animations : chronologie indépendante du calcul du gagnant ──────
  function animationsReduced() { return motionPaused || motionPreference.matches; }

  function animateSelection(number) {
    if (animationsReduced()) return;
    const button = ballButtons.get(number);
    clearTimeout(ballAnimations.get(number));
    button.classList.remove('is-changing');
    // Réinitialiser uniquement la petite tuile concernée pour les appuis rapides.
    void button.offsetWidth;
    button.classList.add('is-changing');
    ballAnimations.set(number, setTimeout(() => {
      button.classList.remove('is-changing');
      ballAnimations.delete(number);
    }, 340));
  }

  function clearSelectionAnimations() {
    ballAnimations.forEach((timer) => clearTimeout(timer));
    ballAnimations.clear();
    ballButtons.forEach((button) => button.classList.remove('is-changing'));
  }

  function createDrawTimeline(winner, duration) {
    // Trois tours complets, puis l'arrêt sur le numéro déterminé auparavant.
    const steps = CONFIG.total * 3 + winner;
    const weights = Array.from({ length: steps }, (_, index) => {
      const progress = index / (steps - 1);
      if (progress < 0.18) return 2.8 - (progress / 0.18) * 2.2;
      if (progress < 0.58) return 0.6;
      return 0.6 + 6.4 * ((progress - 0.58) / 0.42) ** 3;
    });
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    return weights.map((weight) => {
      elapsed += (weight / totalWeight) * duration;
      return elapsed;
    });
  }

  function highlightBall(number) {
    activeBall?.classList.remove('is-active');
    activeBall = number ? ballButtons.get(number) : null;
    activeBall?.classList.add('is-active');
  }

  function animateDraw(winner) {
    const duration = animationsReduced() ? CONFIG.reducedDuration : CONFIG.drawDuration;
    const timeline = createDrawTimeline(winner, duration);
    const startedAt = performance.now();
    let lastStep = -1;
    function frame(now) {
      if (!animationRunning) return;
      const elapsed = now - startedAt;
      if (elapsed >= duration) {
        revealWinner();
        return;
      }
      const step = timeline.findIndex((time) => elapsed < time);
      if (step !== lastStep) {
        highlightBall(animationsReduced() ? null : (step % CONFIG.total) + 1);
        lastStep = step;
      }
      animationFrame = requestAnimationFrame(frame);
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function preloadGoldImages() {
    for (let number = 1; number <= CONFIG.total; number += 1) {
      const path = goldImage(number);
      if (assetCache.has(path)) continue;
      const img = new Image();
      img.src = path;
      assetCache.set(path, img);
    }
  }

  function configureMotion() {
    const paused = animationsReduced();
    document.body.classList.toggle('motion-paused', paused);
    ui.motion.setAttribute('aria-pressed', String(paused));
    const label = paused ? 'Activer les animations' : 'Mettre les animations en pause';
    ui.motion.setAttribute('aria-label', label);
    ui.motion.title = label;
    // La préférence système reste prioritaire ; le bouton indique cette limite.
    ui.motion.disabled = motionPreference.matches;
    if (motionPreference.matches) ui.motion.title = 'Animations réduites dans les réglages de votre appareil';
    if (paused || document.hidden) ui.video.pause();
    else ui.video.play().catch(() => { /* Le poster PNG reste visible. */ });
  }

  // ── 8. Audio : interrupteur global, désactivé au chargement ────────────
  const backgroundAudio = byId('background-audio');
  const victoryAudio = byId('victory-audio');
  backgroundAudio.volume = CONFIG.musicVolume;
  victoryAudio.volume = 1;
  backgroundAudio.muted = true;
  victoryAudio.muted = true;
  let victoryPrimed = false;
  let victoryPriming = false;
  let victoryPlayVersion = 0;
  let musicStarting = false;

  function renderSoundButton() {
    ui.sound.classList.toggle('music-muted', !soundEnabled);
    ui.sound.setAttribute('aria-pressed', String(soundEnabled));
    const label = soundEnabled ? 'Couper tous les sons' : 'Activer les sons';
    ui.sound.setAttribute('aria-label', label);
    ui.sound.title = label;
  }

  async function playBackgroundMusic() {
    if (!soundEnabled || document.hidden || musicStarting || !backgroundAudio.paused) return;
    musicStarting = true;
    try {
      await backgroundAudio.play();
      // Un clic sur « couper » peut survenir pendant la résolution de play().
      if (!soundEnabled || document.hidden) backgroundAudio.pause();
    } catch { /* Une prochaine activation pourra retenter la lecture autorisée. */ }
    finally { musicStarting = false; }
  }

  function primeVictoryAudio() {
    if (victoryPrimed || victoryPriming || game.phase === 'complete') return;
    victoryPriming = true;
    const version = ++victoryPlayVersion;
    // Amorçage silencieux uniquement lors de l'activation du haut-parleur (iOS).
    victoryAudio.muted = true;
    victoryAudio.volume = 0;
    victoryAudio.play().then(() => {
      if (version !== victoryPlayVersion) return;
      victoryAudio.pause();
      victoryAudio.currentTime = 0;
      victoryPrimed = true;
    }).catch(() => { /* Une prochaine activation pourra retenter l'amorçage. */ })
      .finally(() => {
        // Ne pas interrompre une victoire ou réactiver un son coupé entre-temps.
        if (version !== victoryPlayVersion) return;
        victoryPriming = false;
        victoryAudio.volume = 1;
        victoryAudio.muted = !soundEnabled;
      });
  }

  function toggleSound() {
    soundEnabled = !soundEnabled;
    backgroundAudio.muted = !soundEnabled;
    victoryAudio.muted = !soundEnabled;
    renderSoundButton();
    if (soundEnabled) {
      primeVictoryAudio();
      void playBackgroundMusic();
    } else {
      victoryPlayVersion += 1;
      victoryPriming = false;
      backgroundAudio.pause();
      victoryAudio.pause();
      victoryAudio.currentTime = 0;
    }
  }

  function fadeMusic(target, duration) {
    cancelAnimationFrame(volumeFrame);
    const initial = backgroundAudio.volume;
    const startedAt = performance.now();
    function frame(now) {
      const fraction = Math.min((now - startedAt) / duration, 1);
      backgroundAudio.volume = Math.max(0, Math.min(1, initial + (target - initial) * fraction));
      if (fraction < 1) volumeFrame = requestAnimationFrame(frame);
    }
    volumeFrame = requestAnimationFrame(frame);
  }

  function playVictory() {
    victoryPlayVersion += 1;
    victoryPriming = false;
    if (!soundEnabled) return;
    victoryAudio.muted = false;
    victoryAudio.volume = 1;
    victoryAudio.currentTime = 0;
    victoryAudio.play().catch(() => { /* La révélation visuelle reste disponible. */ });
  }

  // ── 9. Révélation et dialogues accessibles ────────────────────────────
  function openRules() {
    if (animationRunning || ui.rules.open) return;
    ui.rulesButton.setAttribute('aria-expanded', 'true');
    ui.rules.showModal();
  }

  function createVictoryParticles() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 20; index += 1) {
      const particle = document.createElement('i');
      // Placement décoratif déterministe : aucun autre tirage aléatoire.
      particle.style.setProperty('--left', `${(index * 37) % 100}%`);
      particle.style.setProperty('--duration', `${4 + (index % 5)}s`);
      particle.style.setProperty('--delay', `${-(index % 7)}s`);
      fragment.append(particle);
    }
    byId('victory-particles').append(fragment);
  }

  function openVictory() {
    if (game.phase !== 'complete') return;
    game.victoryDismissed = false;
    saveGame();
    ui.winnerNumber.textContent = `N° ${numberLabel(game.winner)}`;
    ui.winnerImage.src = goldImage(game.winner);
    ui.winnerImage.alt = `Pokéball dorée du numéro ${game.winner}`;
    if (!ui.victory.open) ui.victory.showModal();
  }

  function revealWinner() {
    if (game.phase !== 'drawing') return;
    cancelAnimationFrame(animationFrame);
    animationRunning = false;
    highlightBall(null);
    // Terminer la partie avant le son empêche de rejouer la fanfare au reload.
    game.phase = 'complete';
    game.victoryDismissed = false;
    saveGame();
    renderGame();
    openVictory();
    playVictory();
    fadeMusic(CONFIG.musicVolume, 1800);
  }

  function requestReset() {
    if (game.phase !== 'complete' || !game.victoryDismissed || ui.victory.open) return;
    ui.resetDialog.showModal();
  }

  // ── 10. Réinitialisation de la partie, sans toucher au choix musical ───
  function resetGame() {
    if (animationRunning) return;
    cancelAnimationFrame(animationFrame);
    cancelAnimationFrame(volumeFrame);
    clearSelectionAnimations();
    highlightBall(null);
    victoryPlayVersion += 1;
    victoryPriming = false;
    victoryAudio.pause();
    victoryAudio.currentTime = 0;
    backgroundAudio.volume = CONFIG.musicVolume;
    if (ui.victory.open) ui.victory.close();
    if (ui.resetDialog.open) ui.resetDialog.close();
    game = newGameState();
    ui.notice.hidden = true;
    saveGame();
    renderGame();
    ballButtons.get(1).focus({ preventScroll: true });
  }

  // ── 11. Événements et initialisation ──────────────────────────────────
  function bindEvents() {
    ui.grid.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-number]');
      if (button) toggleSelection(Number(button.dataset.number));
    });
    ui.draw.addEventListener('click', startDraw);
    ui.resume.addEventListener('click', revealWinner);
    ui.reset.addEventListener('click', requestReset);
    ui.sound.addEventListener('click', toggleSound);
    ui.rulesButton.addEventListener('click', openRules);
    byId('close-rules').addEventListener('click', () => ui.rules.close());
    ui.rules.addEventListener('close', () => {
      ui.rulesButton.setAttribute('aria-expanded', 'false');
      ui.rulesButton.focus({ preventScroll: true });
    });
    ui.motion.addEventListener('click', () => {
      motionPaused = !motionPaused;
      configureMotion();
      if (motionPaused) highlightBall(null);
    });
    byId('close-victory').addEventListener('click', () => ui.victory.close());
    ui.victory.addEventListener('close', () => {
      if (game.phase !== 'complete') return;
      game.victoryDismissed = true;
      saveGame();
      // Le bouton central apparaît uniquement après la fermeture de la victoire.
      renderGame();
      ui.reset.focus({ preventScroll: true });
    });
    byId('cancel-reset').addEventListener('click', () => ui.resetDialog.close());
    byId('confirm-reset').addEventListener('click', resetGame);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { backgroundAudio.pause(); ui.video.pause(); }
      else { void playBackgroundMusic(); configureMotion(); }
    });
    motionPreference.addEventListener('change', () => {
      motionPaused = motionPreference.matches;
      configureMotion();
    });
    ui.video.addEventListener('error', () => { ui.video.hidden = true; });
    ui.video.querySelector('source').addEventListener('error', () => { ui.video.hidden = true; });
    window.addEventListener('pagehide', () => {
      // Enregistrer aussi le résultat pré-calculé lorsqu'un mobile suspend l'onglet.
      saveGame();
      backgroundAudio.pause();
      victoryAudio.pause();
    });
  }

  game = loadGame();
  createGrid();
  createVictoryParticles();
  bindEvents();
  renderSoundButton();
  renderGame();
  configureMotion();
  if (game.selected.length === CONFIG.total) preloadGoldImages();
  // Une modale non fermée manuellement est restaurée, sans rejouer la fanfare.
  if (game.phase === 'complete' && !game.victoryDismissed) openVictory();
})();
