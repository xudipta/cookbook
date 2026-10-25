// Turns a scenario event's `learn` field ({ note, section }) into a link to the
// matching heading on the published docs site.

// Mirrors Python-Markdown's default `toc` slugify closely enough for this repo's headings
// (lowercase, drop punctuation/backticks, spaces to hyphens).
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

// `note` is a repo-relative path such as "topics/kubernetes/notes/02-pods-and-workloads.md".
// The site uses directory URLs, so the .md becomes a trailing slash (README.md is the folder).
export function learnUrl(learn, siteRoot) {
  const path = learn.note.replace(/(^|\/)README\.md$/, '$1').replace(/\.md$/, '/');
  const url = new URL(path, siteRoot);
  if (learn.section) url.hash = slugify(learn.section);
  return url.href;
}

export function learnLink(learn, siteRoot) {
  const a = document.createElement('a');
  a.className = 'cg-learn';
  a.href = learnUrl(learn, siteRoot);
  a.textContent = `Learn why: ${learn.section || learn.note}`;
  return a;
}
