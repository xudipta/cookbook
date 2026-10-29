// A command prompt for the terminal-style games. It is the one place that knows how to be pleasant
// on a phone: 16px text (no iOS zoom), no autocorrect or autocapitalise, history buttons instead of
// arrow keys, and a tray of chips that offers the next word (or a whole command) so a level can be
// played without opening the keyboard.
//
// The game supplies data only:
//   next(words, line) -> candidates for the next word, given the completed words before the cursor.
//     A candidate is a string, or { text, label?, full?, run? }:
//       word chip (default)   replaces the word being typed and adds a space
//       raw: true             like a word chip, but with no space after it (a directory: keep going)
//       full: true            replaces the whole line; with run: true it is also submitted
//   onSubmit(line)  -> called with the raw line when the player presses Enter or Run
//   onActivity(active) -> true while the player is composing (the field has focus or text), false when idle:
//     a game on a clock holds it while true, so typing is not a race
//
// Desktop behaviour is unchanged: type, Enter to run, ArrowUp/ArrowDown for history.
import { el } from './ui.js';

const MAX_CHIPS = 20;
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const norm = (c) => (typeof c === 'string' ? { text: c } : c);

export function createPrompt({
  ps1 = '$',
  label = 'Terminal command',
  placeholder = '',
  multiline = false,
  enterkeyhint = 'go',
  cls = {},
  next = () => [],
  onSubmit,
  onKeydown,
  onActivity,
}) {
  const history = [];
  let at = 0;
  let disabled = false;

  const attrs = { class: `cg-prompt-input ${cls.input || ''}`.trim(), 'aria-label': label, placeholder, autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint };
  const input = multiline ? el('textarea', { ...attrs, rows: 2 }) : el('input', { ...attrs, type: 'text' });
  const ps1El = el('span', { class: `cg-prompt-ps1 ${cls.ps1 || ''}`.trim(), 'aria-hidden': 'true', text: ps1 });
  const run = el('button', { class: `cg-prompt-run ${cls.run || 'cg-btn'}`, type: 'submit', text: 'Run' });
  const form = el('form', { class: `cg-prompt ${cls.form || ''}`.trim() }, ps1El, input, run);

  const prev = el('button', { class: `${cls.chip || 'cg-btn'} cg-hist`, type: 'button', 'aria-label': 'Previous command', text: '↑' });
  const nextBtn = el('button', { class: `${cls.chip || 'cg-btn'} cg-hist`, type: 'button', 'aria-label': 'Next command', text: '↓' });
  const chips = el('span', { class: 'cg-chip-list', role: 'group', 'aria-label': 'Suggested words and commands' });
  const tray = el('div', { class: `cg-chips ${cls.chips || ''}`.trim() }, prev, nextBtn, chips);

  const focus = () => {
    if (!coarse() && !disabled) input.focus({ preventScroll: true });
  };
  const put = (value) => {
    input.value = value;
    refresh();
  };
  const goto = (index) => {
    at = Math.max(0, Math.min(history.length, index));
    put(history[at] || '');
  };

  function partialOf(line) {
    const m = /(\S*)$/.exec(line);
    return { partial: m[1], head: line.slice(0, m.index) };
  }

  function candidates() {
    const line = input.value;
    const { partial, head } = partialOf(line);
    const words = head.trim() ? head.trim().split(/\s+/) : [];
    const out = [];
    for (const raw of next(words, line) || []) {
      const c = norm(raw);
      if (c.full ? !c.text.startsWith(line.trimStart()) || c.text === line.trim() : partial && !c.text.startsWith(partial)) continue;
      if (!c.full && c.text === partial && partial) continue;
      out.push(c);
    }
    return out.slice(0, MAX_CHIPS);
  }

  function choose(c) {
    if (disabled) return;
    if (c.full) {
      input.value = c.text;
      if (c.run) return submit();
    } else {
      const { head } = partialOf(input.value);
      input.value = `${head}${c.text}${c.raw ? '' : ' '}`;
    }
    refresh();
    focus();
  }

  const activity = () => onActivity && onActivity(document.activeElement === input || input.value.trim() !== '');

  function refresh() {
    activity();
    const list = candidates().map((c) => {
      const b = el('button', { class: `cg-chip ${cls.chip || 'cg-btn'} ${c.full ? 'cg-chip-cmd' : ''}`.trim(), type: 'button', 'data-cmd': c.full ? c.text : null, 'data-text': c.text, 'data-run': c.run ? 'true' : null, text: c.label || c.text });
      b.disabled = disabled;
      b.addEventListener('click', () => choose(c));
      return b;
    });
    chips.replaceChildren(...list);
    prev.disabled = disabled || at <= 0;
    nextBtn.disabled = disabled || at >= history.length;
  }

  function submit() {
    if (disabled) return;
    const line = input.value;
    input.value = '';
    const text = line.trim();
    if (text && history[history.length - 1] !== text) history.push(text);
    at = history.length;
    onSubmit(line);
    refresh();
    focus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener('input', refresh);
  input.addEventListener('focus', activity);
  input.addEventListener('blur', activity);
  prev.addEventListener('click', () => goto(at - 1));
  nextBtn.addEventListener('click', () => goto(at + 1));
  input.addEventListener('keydown', (e) => {
    if (onKeydown && onKeydown(e, input) === true) return refresh();
    if (multiline && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return form.requestSubmit();
    }
    const single = !multiline || !input.value.includes('\n');
    if (e.key === 'ArrowUp' && single && at > 0) {
      e.preventDefault();
      goto(at - 1);
    } else if (e.key === 'ArrowDown' && single && (!multiline || at < history.length)) {
      e.preventDefault();
      goto(at + 1);
    }
  });

  refresh();
  return {
    form,
    tray,
    input,
    run,
    ps1: ps1El,
    history,
    focus,
    refresh,
    // Append a word to the line (used when a player taps an item on the board).
    insert(text) {
      const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
      put(`${input.value}${sep}${text} `);
      focus();
    },
    setDisabled(value) {
      disabled = value;
      input.disabled = value;
      run.disabled = value;
      refresh();
    },
  };
}
