// Per-level progress for the games, kept in this browser only (localStorage). Every access is wrapped:
// storage can be blocked or full, and a game must work without it.
//
//   cookbook-game-progress:<game>  JSON { levels: { <levelId>: { best, won, stars, plays, last } } }
//   cookbook-game-best:<game>      the older single best score, still written (as the best over all levels)
//                                  and still read, so scores saved before per-level progress are kept.

const PROGRESS_KEY = 'cookbook-game-progress:';
const BEST_KEY = 'cookbook-game-best:';
const NO_LEVEL = '_'; // games without levels record under this id

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked or full: the run still counts for this page view.
  }
}

export function readProgress(game) {
  try {
    const parsed = JSON.parse(read(PROGRESS_KEY + game));
    if (parsed && typeof parsed.levels === 'object' && parsed.levels) return parsed;
  } catch {
    // Missing or corrupt: start fresh.
  }
  return { levels: {} };
}

const legacyBest = (game) => Number(read(BEST_KEY + game)) || 0;

// Best score over every level (and the older single key).
export function bestScore(game) {
  const levels = Object.values(readProgress(game).levels);
  return Math.max(legacyBest(game), ...levels.map((l) => l.best || 0));
}

export function levelBest(game, levelId) {
  return readProgress(game).levels[levelId || NO_LEVEL]?.best || 0;
}

export function completedLevels(game) {
  const { levels } = readProgress(game);
  return Object.keys(levels).filter((id) => levels[id].won);
}

// Stars (1-3) for a level: 0 until it is won. A win saved before stars existed counts as one star.
const starsOf = (entry) => (entry && entry.won ? Math.max(1, Math.min(3, entry.stars || 1)) : 0);

export function levelStars(game, levelId) {
  return starsOf(readProgress(game).levels[levelId || NO_LEVEL]);
}

// { levelId: stars } for every level won so far (the level picker shows these).
export function starsByLevel(game) {
  const { levels } = readProgress(game);
  return Object.fromEntries(Object.keys(levels).filter((id) => levels[id].won).map((id) => [id, starsOf(levels[id])]));
}

export function starsEarned(game) {
  return Object.values(starsByLevel(game)).reduce((sum, n) => sum + n, 0);
}

// Records a finished run. Returns the best score for that level after this run.
export function recordRun(game, levelId, { score, won, stars = 0 }) {
  const progress = readProgress(game);
  const id = levelId || NO_LEVEL;
  const entry = progress.levels[id] || { best: 0, won: false, plays: 0, last: 0 };
  entry.best = Math.max(entry.best || 0, score);
  entry.won = entry.won || Boolean(won);
  if (won) entry.stars = Math.max(entry.stars || 0, stars);
  entry.plays = (entry.plays || 0) + 1;
  entry.last = Date.now();
  progress.levels[id] = entry;
  write(PROGRESS_KEY + game, JSON.stringify(progress));
  write(BEST_KEY + game, String(Math.max(legacyBest(game), entry.best)));
  return entry.best;
}

// Forget everything saved for one game, or for all of them when `games` is a list of ids.
export function resetProgress(games) {
  for (const game of games) {
    try {
      localStorage.removeItem(PROGRESS_KEY + game);
      localStorage.removeItem(BEST_KEY + game);
    } catch {
      // Nothing to reset if storage is blocked.
    }
  }
}
