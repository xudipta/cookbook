// Loaded on every docs page (see extra_javascript in mkdocs.yml). Does nothing unless the page
// contains <div id="game" data-game="<id>">, in which case it loads that game and mounts it.
// The page text after the board ("Rules", "Syntax worth remembering") folds into collapsible panels.
// They start open on a first visit and closed afterwards, so a returning player sees the board first.
const SEEN_KEY = 'cookbook-games-seen';

function seenBefore() {
  try {
    const seen = localStorage.getItem(SEEN_KEY) === '1';
    localStorage.setItem(SEEN_KEY, '1');
    return seen;
  } catch {
    return false; // storage blocked: behave like a first visit
  }
}

function foldSections(host) {
  const open = !seenBefore();
  let node = host.nextElementSibling;
  while (node && node.tagName !== 'H2') node = node.nextElementSibling;
  while (node) {
    const heading = node;
    const body = [];
    node = node.nextElementSibling;
    while (node && node.tagName !== 'H2') {
      body.push(node);
      node = node.nextElementSibling;
    }
    const panel = document.createElement('details');
    panel.className = 'cg-fold';
    panel.id = heading.id;
    panel.open = open;
    const summary = document.createElement('summary');
    summary.textContent = heading.textContent.replace(/¶$/, '').trim();
    heading.replaceWith(panel);
    panel.append(summary, ...body);
  }
}

async function mount() {
  const host = document.querySelector('#game[data-game]');
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = '1';
  const id = host.dataset.game;
  try {
    const { mountGame } = await import('./engine.js');
    await import(`../${id}/game.js`);
    await mountGame(host, { id });
    foldSections(host);
  } catch (err) {
    host.textContent = `Could not load the "${id}" game: ${err.message}`;
    console.error(err);
  }
}

// Material's instant navigation swaps page content without a reload; document$ fires on each swap.
if (window.document$) window.document$.subscribe(mount);
else document.addEventListener('DOMContentLoaded', mount);
