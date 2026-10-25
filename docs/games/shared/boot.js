// Loaded on every docs page (see extra_javascript in mkdocs.yml). Does nothing unless the page
// contains <div id="game" data-game="<id>">, in which case it loads that game and mounts it.
async function mount() {
  const host = document.querySelector('#game[data-game]');
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = '1';
  const id = host.dataset.game;
  try {
    const { mountGame } = await import('./engine.js');
    await import(`../${id}/game.js`);
    await mountGame(host, { id });
  } catch (err) {
    host.textContent = `Could not load the "${id}" game: ${err.message}`;
    console.error(err);
  }
}

// Material's instant navigation swaps page content without a reload; document$ fires on each swap.
if (window.document$) window.document$.subscribe(mount);
else document.addEventListener('DOMContentLoaded', mount);
