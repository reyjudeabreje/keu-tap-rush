const scoreEl = document.getElementById("score");
const timeEl = document.getElementById("time");
const comboEl = document.getElementById("combo");
const gameArea = document.getElementById("gameArea");
const target = document.getElementById("target");
const modeScreen = document.getElementById("modeScreen");
const gameScreen = document.getElementById("gameScreen");
const leaderboardScreen = document.getElementById("leaderboardScreen");
const profileScreen = document.getElementById("profileScreen");
const modeButtons = document.querySelectorAll(".mode-btn");
const filterButtons = document.querySelectorAll(".leaderboard-filters .filter-btn");
const startBtn = document.getElementById("startBtn");
const startHint = document.getElementById("startHint");
const nicknameInput = document.getElementById("nickname");
const gameOver = document.getElementById("gameOver");
const results = document.getElementById("results");
const onlineResult = document.getElementById("onlineResult");
const submitScoreBtn = document.getElementById("submitScoreBtn");
const restartBtn = document.getElementById("restartBtn");
const changeModeBtn = document.getElementById("changeModeBtn");
const modeName = document.getElementById("modeName");
const bestScoreEl = document.getElementById("bestScore");
const onlineStatus = document.getElementById("onlineStatus");
const leaderboardRows = document.getElementById("leaderboardRows");
const leaderboardStatus = document.getElementById("leaderboardStatus");
const activePlayersRows = document.getElementById("activePlayersRows");
const activePlayersStatus = document.getElementById("activePlayersStatus");
const profileStatus = document.getElementById("profileStatus");
const levelCard = document.getElementById("levelCard");
const profilePlayerId = document.getElementById("profilePlayerId");
const profileNickname = document.getElementById("profileNickname");
const profileCards = document.getElementById("profileCards");
const modeStatsRows = document.getElementById("modeStatsRows");
const achievementRows = document.getElementById("achievementRows");
const badgeDetail = document.getElementById("badgeDetail");
const myScoresRows = document.getElementById("myScoresRows");
const levelUpNotice = document.getElementById("levelUpNotice");
const installAppBtn = document.getElementById("installAppBtn");

const API_BASE = (window.LEADERBOARD_API || "/api").replace(/\/$/, "");
const modes = {
  easy: { name: "EASY", duration: 30, targetSize: 104, minSize: 70, respawn: 850, multiplier: 1 },
  normal: { name: "NORMAL", duration: 30, targetSize: 82, minSize: 54, respawn: 650, multiplier: 1 },
  hard: { name: "HARD", duration: 25, targetSize: 66, minSize: 42, respawn: 480, multiplier: 2 },
  superHard: { name: "SUPER HARD", duration: 20, targetSize: 54, minSize: 34, respawn: 330, multiplier: 3 },
  god: { name: "GOD MODE", duration: 15, targetSize: 44, minSize: 26, respawn: 210, multiplier: 5 }
};

let score = 0;
let timeLeft = 30;
let combo = 0;
let totalTaps = 0;
let highestCombo = 0;
let gameRunning = false;
let scoreSubmitted = false;
let selectedMode = null;
let currentFilter = "all";
let currentProfileFilter = "all";
let profileData = null;
let timer;
let movementTimer;
let heartbeatTimer;
let livePlayersTimer;
let gameSession = null;
let supabaseConnected = false;
let deferredInstallPrompt = null;
const HEARTBEAT_INTERVAL_MS = 12000;
const LIVE_PLAYERS_REFRESH_MS = 8000;

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallButton() {
  installAppBtn.classList.toggle("hidden", isStandaloneMode() || !deferredInstallPrompt);
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallButton();
});

installAppBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  updateInstallButton();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

function bestStorageKey() { return `keuTapRushBest-${selectedMode}`; }
function getBestScore() { return Number(localStorage.getItem(bestStorageKey()) || 0); }
function getSpeedBonus() { return totalTaps > 0 ? Math.round((score / totalTaps) * 100) : 0; }

function getMultiplier() {
  let multiplier = modes[selectedMode].multiplier;
  if (combo >= 20) multiplier += 4;
  else if (combo >= 10) multiplier += 2;
  else if (combo >= 5) multiplier += 1;
  return multiplier;
}

function updateComboDisplay() { comboEl.textContent = `${combo} ×${getMultiplier()}`; }

function moveTarget() {
  const targetSize = target.offsetWidth;
  const maxX = Math.max(targetSize, gameArea.clientWidth - targetSize);
  const maxY = Math.max(targetSize, gameArea.clientHeight - targetSize);
  target.style.left = `${targetSize / 2 + Math.random() * (maxX - targetSize / 2)}px`;
  target.style.top = `${targetSize / 2 + Math.random() * (maxY - targetSize / 2)}px`;
}

function createTapEffect(x, y) {
  const effect = document.createElement("div");
  effect.className = "tap-effect";
  effect.style.left = `${x}px`;
  effect.style.top = `${y}px`;
  gameArea.appendChild(effect);
  setTimeout(() => effect.remove(), 350);
}

function updateTargetSize() {
  const mode = modes[selectedMode];
  const newSize = Math.max(mode.minSize, mode.targetSize - Math.floor(combo / 4) * 3);
  target.style.width = `${newSize}px`;
  target.style.height = `${newSize}px`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Online leaderboard unavailable");
  return data;
}

async function checkSupabaseConnection() {
  try {
    const status = await requestJson("/config");
    supabaseConnected = status.connected === true;
  } catch (error) {
    supabaseConnected = false;
  }
  if (!supabaseConnected) {
    onlineStatus.textContent = "SUPABASE NOT CONNECTED";
    leaderboardStatus.textContent = "SUPABASE NOT CONNECTED";
    activePlayersStatus.textContent = "LIVE PLAYERS UNAVAILABLE";
  }
}

async function beginOnlineSession() {
  try {
    const session = await requestJson("/games/start", {
      method: "POST",
      body: JSON.stringify({ mode: selectedMode, nickname: nicknameInput.value.trim() })
    });
    if (session.online !== true) {
      gameSession = null;
      onlineStatus.textContent = "SUPABASE NOT CONNECTED";
      return;
    }
    gameSession = session;
    if (gameRunning) {
      onlineStatus.textContent = "ONLINE / PLAYING";
      sendHeartbeat();
    }
    else removeActivePlayer();
  } catch (error) {
    gameSession = null;
    onlineStatus.textContent = "SUPABASE NOT CONNECTED";
  }
}

async function sendHeartbeat() {
  if (!gameSession || !gameRunning) return;
  try {
    await requestJson("/presence/heartbeat", {
      method: "POST",
      body: JSON.stringify({ sessionId: gameSession.sessionId, score })
    });
  } catch (error) {
    // A disconnected leaderboard must not interrupt the game.
  }
}

async function removeActivePlayer() {
  if (!gameSession) return;
  const sessionId = gameSession.sessionId;
  try {
    await requestJson("/presence/stop", {
      method: "POST",
      keepalive: true,
      body: JSON.stringify({ sessionId })
    });
  } catch (error) {
    // The server also removes stale players automatically.
  }
}

function startGame() {
  const nickname = nicknameInput.value.trim();
  if (!selectedMode) {
    startHint.textContent = "Choose a mode first.";
    return;
  }
  if (!nickname || nickname.length > 16) {
    startHint.textContent = "Enter a nickname from 1 to 16 characters.";
    nicknameInput.focus();
    return;
  }

  const mode = modes[selectedMode];
  score = 0;
  timeLeft = mode.duration;
  combo = 0;
  totalTaps = 0;
  highestCombo = 0;
  scoreSubmitted = false;
  gameSession = null;
  levelUpNotice.classList.add("hidden");
  gameRunning = true;
  scoreEl.textContent = score;
  timeEl.textContent = timeLeft;
  modeName.textContent = mode.name;
  bestScoreEl.textContent = getBestScore();
  updateComboDisplay();
  target.style.display = "block";
  target.style.width = `${mode.targetSize}px`;
  target.style.height = `${mode.targetSize}px`;
  modeScreen.classList.add("hidden");
  leaderboardScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  gameOver.classList.add("hidden");
  document.body.classList.toggle("god-active", selectedMode === "god");
  onlineStatus.textContent = "CONNECTING…";
  moveTarget();
  clearInterval(timer);
  clearInterval(movementTimer);
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  movementTimer = setInterval(moveTarget, mode.respawn);
  timer = setInterval(() => {
    timeLeft -= 1;
    timeEl.textContent = timeLeft;
    if (timeLeft <= 0) endGame();
  }, 1000);
  beginOnlineSession();
}

function tapTarget(event) {
  if (!gameRunning) return;
  totalTaps += 1;
  combo += 1;
  highestCombo = Math.max(highestCombo, combo);
  score += getMultiplier();
  scoreEl.textContent = score;
  updateComboDisplay();
  const rect = gameArea.getBoundingClientRect();
  createTapEffect(event.clientX - rect.left, event.clientY - rect.top);
  updateTargetSize();
  moveTarget();
}

function endGame() {
  if (!gameRunning) return;
  gameRunning = false;
  clearInterval(timer);
  clearInterval(movementTimer);
  clearInterval(heartbeatTimer);
  removeActivePlayer();
  target.style.display = "none";
  const oldBest = getBestScore();
  if (score > oldBest) localStorage.setItem(bestStorageKey(), score);
  results.innerHTML = `Mode: <b>${modes[selectedMode].name}</b><br>Final Score: <b>${score}</b><br>Best Score: <b>${Math.max(score, oldBest)}</b><br>Total Taps: <b>${totalTaps}</b><br>Highest Combo: <b>${highestCombo}</b><br>Speed Bonus: <b>${getSpeedBonus()}%</b>`;
  onlineResult.textContent = "Score not submitted yet.";
  submitScoreBtn.disabled = false;
  submitScoreBtn.textContent = "SUBMIT SCORE";
  gameScreen.classList.add("hidden");
  gameOver.classList.remove("hidden");
  document.body.classList.remove("god-active");
  onlineStatus.textContent = "OFFLINE";
}

async function submitScore() {
  if (scoreSubmitted) return;
  submitScoreBtn.disabled = true;
  onlineResult.textContent = "Submitting score…";
  try {
    const response = await requestJson("/scores", {
      method: "POST",
      body: JSON.stringify({
        sessionId: gameSession && gameSession.sessionId,
        nickname: nicknameInput.value.trim(), mode: selectedMode, score,
        highestCombo, totalTaps, speedBonus: getSpeedBonus()
      })
    });
    scoreSubmitted = true;
    onlineResult.innerHTML = `My Score: <b>${response.score}</b> · My Rank: <b>${response.rank}</b> · My Best Score: <b>${response.bestScore}</b>`;
    if (response.levelUp === true) {
      levelUpNotice.innerHTML = `<strong>LEVEL UP!</strong><span>LEVEL ${response.level}</span><b>${escapeHtml(response.title)}</b><small>+${response.xpEarned} XP earned</small>`;
      levelUpNotice.classList.remove("hidden");
    }
    submitScoreBtn.textContent = "SCORE SUBMITTED";
    loadLeaderboard();
  } catch (error) {
    submitScoreBtn.disabled = false;
    onlineResult.textContent = error.message === "Online leaderboard unavailable" ? "SUPABASE NOT CONNECTED" : error.message;
  }
}

function showModeScreen() {
  clearInterval(timer);
  clearInterval(movementTimer);
  clearInterval(heartbeatTimer);
  clearInterval(livePlayersTimer);
  gameRunning = false;
  removeActivePlayer();
  target.style.display = "none";
  gameOver.classList.add("hidden");
  gameScreen.classList.add("hidden");
  leaderboardScreen.classList.add("hidden");
  profileScreen.classList.add("hidden");
  modeScreen.classList.remove("hidden");
  document.body.classList.remove("god-active");
  startBtn.textContent = selectedMode ? "START GAME" : "SELECT A MODE";
  startBtn.disabled = !selectedMode || !nicknameInput.value.trim();
}

function showLeaderboard() {
  clearInterval(timer);
  clearInterval(movementTimer);
  clearInterval(heartbeatTimer);
  clearInterval(livePlayersTimer);
  gameRunning = false;
  removeActivePlayer();
  modeScreen.classList.add("hidden");
  gameScreen.classList.add("hidden");
  gameOver.classList.add("hidden");
  profileScreen.classList.add("hidden");
  leaderboardScreen.classList.remove("hidden");
  loadLeaderboard();
  loadActivePlayers();
  livePlayersTimer = setInterval(loadActivePlayers, LIVE_PLAYERS_REFRESH_MS);
}

function rankLabel(rank) { return rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : rank; }
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function renderLeaderboard(entries) {
  leaderboardRows.innerHTML = entries.length ? entries.map((entry, index) => `<div class="leaderboard-row${entry.isCurrentPlayer ? " current-player" : ""}" role="row"><span class="rank">${rankLabel(index + 1)}</span><strong>${escapeHtml(entry.nickname)}${entry.isCurrentPlayer ? ' <em>YOU</em>' : ""}</strong><span>${escapeHtml(modes[entry.mode]?.name || entry.mode)}</span><b>${entry.score}</b><span class="combo-value">${entry.highest_combo}</span></div>`).join("") : '<p class="empty-board">No verified scores yet.</p>';
}

async function loadLeaderboard() {
  leaderboardStatus.textContent = "Loading verified scores…";
  try {
    const query = currentFilter === "all" ? "" : `?mode=${encodeURIComponent(currentFilter)}`;
    const data = await requestJson(`/leaderboard${query}`);
    renderLeaderboard(data.entries);
    leaderboardStatus.textContent = "ONLINE LEADERBOARD · VERIFIED SCORES";
  } catch (error) {
    leaderboardRows.innerHTML = "";
    leaderboardStatus.textContent = "SUPABASE NOT CONNECTED";
  }
}

function renderActivePlayers(players) {
  activePlayersRows.innerHTML = players.length ? players.map((player) => `<div class="active-player"><span class="online-dot" aria-label="Online"></span><strong>${escapeHtml(player.nickname)}${player.isCurrentPlayer ? ' <em>YOU</em>' : ""}</strong><span>${escapeHtml(modes[player.mode]?.name || player.mode)}</span><b>PLAYING</b></div>`).join("") : '<p class="empty-live">NO OTHER PLAYERS ONLINE</p>';
  activePlayersStatus.textContent = `${players.length} PLAYING`;
}

async function loadActivePlayers() {
  activePlayersRows.innerHTML = '<p class="empty-live">Loading live players...</p>';
  try {
    const data = await requestJson("/players/live");
    renderActivePlayers(data.players);
  } catch (error) {
    activePlayersRows.innerHTML = "";
    activePlayersStatus.textContent = "LIVE PLAYERS UNAVAILABLE";
    activePlayersRows.innerHTML = '<p class="empty-live">LIVE PLAYERS UNAVAILABLE</p>';
  }
}

function showProfile() {
  clearInterval(timer);
  clearInterval(movementTimer);
  clearInterval(heartbeatTimer);
  clearInterval(livePlayersTimer);
  gameRunning = false;
  removeActivePlayer();
  modeScreen.classList.add("hidden");
  gameScreen.classList.add("hidden");
  gameOver.classList.add("hidden");
  leaderboardScreen.classList.add("hidden");
  profileScreen.classList.remove("hidden");
  loadProfile();
}

function renderProfile(data) {
  profileData = data;
  profilePlayerId.textContent = data.playerIdShort;
  profileNickname.value = data.nickname;
  const stats = data.stats || data;
  const levelLabel = data.level >= 10 && data.xp >= 10000 ? "LEVEL 10+" : `LEVEL ${data.level}`;
  const nextLevel = data.nextLevelXp === null ? "LEVEL 10+" : `${data.nextLevelXp - data.xp} XP`;
  const levelStart = data.level >= 10 ? 10000 : [0, 100, 250, 500, 1000, 2000, 3500, 5000, 7500][data.level - 1];
  const progress = data.nextLevelXp === null ? 100 : Math.max(0, Math.min(100, ((data.xp - levelStart) / (data.nextLevelXp - levelStart)) * 100));
  levelCard.innerHTML = `<p id="levelCardTitle" class="profile-label">PLAYER LEVEL</p><strong class="level-number">${levelLabel}</strong><b class="level-title">${escapeHtml(data.title)}</b><div class="xp-line"><span>XP</span><strong>${data.xp}${data.nextLevelXp === null ? "" : ` / ${data.nextLevelXp}`}</strong></div><div class="xp-track" aria-label="XP progress"><span style="width: ${progress}%"></span></div><div class="next-level"><span>NEXT LEVEL</span><strong>${nextLevel}</strong></div>`;
  const cards = [["BEST SCORE", stats.bestScore], ["TOTAL GAMES", stats.gamesPlayed], ["TOTAL TAPS", stats.totalTaps], ["BEST COMBO", stats.highestCombo], ["CURRENT RANK", stats.currentRank || "N/A"]];
  profileCards.innerHTML = cards.map(([label, value]) => `<div class="profile-card"><span>${label}</span><strong>${value}</strong></div>`).join("");
  renderModeStats();
  achievementRows.innerHTML = data.badges.map((badge) => `<button type="button" class="achievement ${badge.unlocked ? "unlocked" : "locked"}" data-badge-id="${escapeHtml(badge.id)}"><strong>${badge.icon} ${escapeHtml(badge.name)}</strong><span>${badge.unlocked ? "UNLOCKED" : "LOCKED"}</span></button>`).join("");
  badgeDetail.classList.add("hidden");
}

function showBadgeDetail(badge) {
  badgeDetail.innerHTML = `<strong>${badge.icon} ${escapeHtml(badge.name)}</strong><span>${badge.unlocked ? "UNLOCKED" : "LOCKED"}</span><p>${escapeHtml(badge.requirement)}</p>`;
  badgeDetail.classList.remove("hidden");
}

function renderModeStats() {
  if (!profileData) return;
  const rows = currentProfileFilter === "all" ? profileData.modeStats : profileData.modeStats.filter((entry) => entry.mode === currentProfileFilter);
  modeStatsRows.innerHTML = rows.map((entry) => `<div class="mode-stats-row"><strong>${modes[entry.mode].name}</strong><span>${entry.bestScore}</span><span>${entry.highestCombo}</span><span>${entry.gamesPlayed}</span></div>`).join("");
}

function renderMyScores(scores) {
  myScoresRows.innerHTML = scores.length ? scores.map((entry) => `<div class="my-score-row"><time>${escapeHtml(new Date(entry.created_at).toLocaleString())}</time><strong>${modes[entry.mode].name}</strong><span>SCORE <b>${entry.score}</b></span><span>COMBO <b>${entry.highest_combo}</b></span><span>TAPS <b>${entry.total_taps}</b></span></div>`).join("") : '<p class="empty-board">No verified scores yet.</p>';
}

async function loadProfile() {
  profileStatus.textContent = "Loading verified profile data…";
  try {
    const data = await requestJson("/profile");
    renderProfile(data);
    await loadMyScores();
    profileStatus.textContent = `VERIFIED PROFILE · BEST RANK ${data.bestRank || "N/A"}`;
  } catch (error) {
    profileData = null;
    levelCard.innerHTML = "";
    profileCards.innerHTML = "";
    modeStatsRows.innerHTML = "";
    achievementRows.innerHTML = "";
    myScoresRows.innerHTML = '<p class="empty-board">PROFILE DATA UNAVAILABLE — CONNECT TO SUPABASE</p>';
    profileStatus.textContent = "PROFILE DATA UNAVAILABLE — CONNECT TO SUPABASE";
  }
}

async function loadMyScores() {
  const query = currentProfileFilter === "all" ? "" : `?mode=${encodeURIComponent(currentProfileFilter)}`;
  try {
    const data = await requestJson(`/my-scores${query}`);
    renderMyScores(data.scores);
  } catch (error) {
    myScoresRows.innerHTML = '<p class="empty-board">PROFILE DATA UNAVAILABLE — CONNECT TO SUPABASE</p>';
  }
}

async function saveNickname() {
  const nickname = profileNickname.value.trim();
  if (!nickname || nickname.length > 16) {
    profileStatus.textContent = "Nickname must be 1 to 16 characters.";
    return;
  }
  try {
    const data = await requestJson("/profile/nickname", { method: "PATCH", body: JSON.stringify({ nickname }) });
    profileNickname.value = data.nickname;
    nicknameInput.value = data.nickname;
    profileStatus.textContent = "NICKNAME UPDATED · IDENTITY UNCHANGED";
  } catch (error) {
    profileStatus.textContent = error.message;
  }
}

modeButtons.forEach((button) => button.addEventListener("click", () => {
  modeButtons.forEach((modeButton) => modeButton.classList.remove("selected"));
  button.classList.add("selected");
  selectedMode = button.dataset.mode;
  startBtn.disabled = !nicknameInput.value.trim();
  startBtn.textContent = startBtn.disabled ? "ENTER NICKNAME" : "START GAME";
  startHint.textContent = "";
}));

nicknameInput.addEventListener("input", () => {
  startBtn.disabled = !selectedMode || !nicknameInput.value.trim();
  startBtn.textContent = startBtn.disabled ? (selectedMode ? "ENTER NICKNAME" : "SELECT A MODE") : "START GAME";
});
gameArea.addEventListener("click", (event) => {
  if (gameRunning && event.target === gameArea) { combo = 0; updateComboDisplay(); }
});
target.addEventListener("click", tapTarget);
startBtn.addEventListener("click", startGame);
submitScoreBtn.addEventListener("click", submitScore);
restartBtn.addEventListener("click", startGame);
changeModeBtn.addEventListener("click", showModeScreen);
document.getElementById("playNavBtn").addEventListener("click", showModeScreen);
document.getElementById("leaderboardNavBtn").addEventListener("click", showLeaderboard);
document.getElementById("profileNavBtn").addEventListener("click", showProfile);
document.getElementById("refreshLeaderboardBtn").addEventListener("click", loadLeaderboard);
document.getElementById("refreshProfileBtn").addEventListener("click", loadProfile);
document.getElementById("saveNicknameBtn").addEventListener("click", saveNickname);
achievementRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-badge-id]");
  const badge = profileData?.badges?.find((entry) => entry.id === button?.dataset.badgeId);
  if (badge) showBadgeDetail(badge);
});
filterButtons.forEach((button) => button.addEventListener("click", () => {
  filterButtons.forEach((filterButton) => filterButton.classList.remove("selected"));
  button.classList.add("selected");
  currentFilter = button.dataset.filter;
  loadLeaderboard();
}));
document.querySelectorAll(".profile-filter").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".profile-filter").forEach((filterButton) => filterButton.classList.remove("selected"));
  button.classList.add("selected");
  currentProfileFilter = button.dataset.profileFilter;
  renderModeStats();
  loadMyScores();
}));

window.addEventListener("pagehide", removeActivePlayer);

showModeScreen();
checkSupabaseConnection();
loadLeaderboard();
updateInstallButton();
