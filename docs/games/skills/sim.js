// The rules of "Skill Issue". Pure logic, no DOM, importable from Node.
//
// It models what topics/skills/notes teach and nothing that contradicts them:
//   * progressive disclosure: every installed skill's name + description is always in context, the
//     SKILL.md body loads only when the skill is chosen, bundled files only when the body points at them;
//   * the agent chooses from name + description alone, so a vague description never triggers (or
//     triggers on the wrong job);
//   * a skill is only discoverable in a skills directory, and `scripts/check_skill.py` is the lint gate;
//   * `allowed-tools` restricts what a skill may use while it is active.
//
// SIMPLIFICATION, on purpose: the "agent" here picks a skill by counting overlapping words between the
// request and each description (see scoreSkill). That is a transparent stand-in, not how a real model
// chooses. The lint rules (checkSkill) are a line-for-line port of scripts/check_skill.py, and
// scripts/check_skills_game.py runs both on the same fixtures in CI so they cannot drift apart.

// ---------------------------------------------------------------- the lint gate (port of check_skill.py)

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESC_MAX = 1024;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// A small YAML subset: what real SKILL.md frontmatter uses (scalars, quoted strings, flow and block
// lists, folded and literal block scalars, comments). Anything PyYAML rejects for the usual reasons
// (an unquoted `: ` inside a value, an unterminated quote, a line with no colon) is an error here too.
const KEY_RE = /^((?:"[^"]*"|'[^']*'|[^\s#'"[\]{}>|&*!%@`,?-][^:]*?))\s*:(?:[ \t]+(.*))?$/;
const indentOf = (line) => /^\s*/.exec(line)[0].length;
const isBlank = (line) => !line.trim() || /^\s*#/.test(line);

function resolvePlain(text) {
  const t = text.trim();
  if (t === '' || t === '~' || /^(null|Null|NULL)$/.test(t)) return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(t)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(t)) return false;
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

// Read a quoted scalar that starts at text[0]; `more()` supplies the next line when it continues.
function readQuoted(text, more) {
  const q = text[0];
  let s = text.slice(1);
  let out = '';
  for (;;) {
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (q === "'" && c === "'") {
        if (s[k + 1] === "'") {
          out += "'";
          k++;
          continue;
        }
        return { ok: true, value: out, rest: s.slice(k + 1).trim() };
      }
      if (q === '"' && c === '\\') {
        const e = s[k + 1];
        out += { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', 0: '\0' }[e] ?? e ?? '';
        k++;
        continue;
      }
      if (q === '"' && c === '"') return { ok: true, value: out, rest: s.slice(k + 1).trim() };
      out += c;
    }
    const next = more();
    if (next === null) return { ok: false, error: 'found unexpected end of stream while scanning a quoted scalar' };
    out += next.trim() === '' ? '\n' : ' ';
    s = next.trim();
  }
}

function plainScalar(text) {
  const t = text.replace(/(^|\s)#.*$/, '').trim();
  if (/^[@`]/.test(t)) return { ok: false, error: `found character '${t[0]}' that cannot start any token` };
  if (/^-(\s|$)/.test(t)) return { ok: false, error: 'sequence entries are not allowed here' };
  if (/:(\s|$)/.test(t)) return { ok: false, error: 'mapping values are not allowed here' };
  return { ok: true, value: resolvePlain(t) };
}

function inlineScalar(text, more) {
  const t = text.trim();
  if (t[0] === '"' || t[0] === "'") {
    const q = readQuoted(t, more);
    if (!q.ok) return q;
    if (q.rest && !q.rest.startsWith('#')) return { ok: false, error: 'did not find expected key' };
    return { ok: true, value: q.value };
  }
  return plainScalar(t);
}

function splitFlow(inner) {
  const items = [];
  let cur = '';
  let quote = null;
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() || items.length) items.push(cur);
  return items;
}

export function parseYaml(raw, lineOffset = 0) {
  const lines = raw.split('\n');
  const n = lines.length;
  let i = 0;
  const err = (message, at) => ({ ok: false, error: `${message} (line ${at + 1 + lineOffset})` });
  const skipBlank = () => {
    while (i < n && isBlank(lines[i])) i++;
  };

  skipBlank();
  if (i >= n) return { ok: true, value: null };
  if (/^-(\s|$)/.test(lines[i])) return { ok: true, value: ['-'] };
  if (!KEY_RE.test(lines[i])) {
    // A document that is a single plain scalar (not a mapping): fine for YAML, not for a SKILL.md.
    const rest = lines.slice(i).filter((l) => !isBlank(l));
    if (rest.some((l) => /:(\s|$)/.test(l))) return err('mapping values are not allowed here', i);
    return { ok: true, value: rest.map((l) => l.trim()).join(' ') };
  }

  const out = {};
  for (;;) {
    skipBlank();
    if (i >= n) break;
    const line = lines[i];
    if (/^\s/.test(line)) return err('bad indentation of a mapping entry', i);
    const m = KEY_RE.exec(line);
    if (!m) return err("could not find expected ':'", i);
    const key = m[1].replace(/^(["'])(.*)\1$/, '$2');
    const rest = (m[2] ?? '').trim();
    const at = i;
    i++;

    // Empty value: a block list, a nested mapping, a multi-line plain scalar, or null.
    if (rest === '' || rest.startsWith('#')) {
      let j = i;
      while (j < n && isBlank(lines[j])) j++;
      if (j < n && /^\s*-(\s|$)/.test(lines[j])) {
        const base = indentOf(lines[j]);
        const items = [];
        while (j < n) {
          const ln = lines[j];
          if (isBlank(ln)) {
            j++;
            continue;
          }
          if (indentOf(ln) !== base || !/^\s*-(\s|$)/.test(ln)) break;
          const r = inlineScalar(ln.replace(/^\s*-\s*/, ''), () => null);
          if (!r.ok) return err(r.error, j);
          items.push(r.value);
          j++;
        }
        i = j;
        out[key] = items;
        continue;
      }
      if (j < n && /^\s/.test(lines[j])) {
        const parts = [];
        let k = i;
        while (k < n && (!lines[k].trim() || /^\s/.test(lines[k]))) {
          if (/^\s*#/.test(lines[k])) break;
          parts.push(lines[k].trim());
          k++;
        }
        i = k;
        if (parts.some((p) => /^[\w-]+:(\s|$)/.test(p))) {
          out[key] = { nested: true };
          continue;
        }
        const r = plainScalar(parts.filter(Boolean).join(' '));
        if (!r.ok) return err(r.error, at + 1);
        out[key] = r.value;
        continue;
      }
      out[key] = null;
      continue;
    }

    // Block scalar: > folds lines, | keeps them.
    const block = /^([>|])([+-]?)([1-9]?)\s*(?:#.*)?$/.exec(rest);
    if (block) {
      const [, style, chomp] = block;
      const body = [];
      let k = i;
      while (k < n && (!lines[k].trim() || /^\s/.test(lines[k]))) {
        body.push(lines[k]);
        k++;
      }
      i = k;
      const first = body.find((l) => l.trim());
      const pad = first ? indentOf(first) : 0;
      const text = body.map((l) => (l.trim() ? l.slice(Math.min(pad, indentOf(l))) : ''));
      let trailing = 0;
      while (text.length && text[text.length - 1] === '') {
        text.pop();
        trailing++;
      }
      let value;
      if (style === '|') value = text.join('\n');
      else {
        value = '';
        let blanks = 0;
        for (const l of text) {
          if (l === '') blanks++;
          else {
            if (value) value += blanks ? '\n'.repeat(blanks) : ' ';
            value += l;
            blanks = 0;
          }
        }
      }
      if (value) value += chomp === '-' ? '' : chomp === '+' ? '\n'.repeat(1 + trailing) : '\n';
      out[key] = value;
      continue;
    }

    // Flow sequence.
    if (rest[0] === '[') {
      let s = rest;
      const close = () => {
        let q = null;
        for (let k = 0; k < s.length; k++) {
          if (q) {
            if (s[k] === q) q = null;
          } else if (s[k] === '"' || s[k] === "'") q = s[k];
          else if (s[k] === ']') return k;
        }
        return -1;
      };
      let end = close();
      while (end < 0) {
        if (i >= n) return err("did not find expected ',' or ']'", at);
        s += ` ${lines[i].trim()}`;
        i++;
        end = close();
      }
      const tail = s.slice(end + 1).trim();
      if (tail && !tail.startsWith('#')) return err('did not find expected key', at);
      const items = [];
      for (const part of splitFlow(s.slice(1, end))) {
        const r = inlineScalar(part, () => null);
        if (!r.ok) return err(r.error, at);
        items.push(r.value);
      }
      out[key] = items;
      continue;
    }
    if (rest[0] === '{') {
      out[key] = { flow: true };
      continue;
    }

    // Quoted or plain scalar (a plain one may continue on indented lines).
    if (rest[0] === '"' || rest[0] === "'") {
      const q = readQuoted(rest, () => (i < n ? lines[i++] : null));
      if (!q.ok) return err(q.error, at);
      if (q.rest && !q.rest.startsWith('#')) return err('did not find expected key', at);
      out[key] = q.value;
      continue;
    }
    let text = rest;
    while (i < n && lines[i].trim() && /^\s/.test(lines[i]) && !/^\s*#/.test(lines[i])) {
      text += ` ${lines[i].trim()}`;
      i++;
    }
    const r = plainScalar(text);
    if (!r.ok) return err(r.error, at);
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

const truthy = (v) =>
  v !== null && v !== undefined && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

// Python's str() for the values a frontmatter can hold.
function pyStr(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return 'None';
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'string' ? `'${x}'` : pyStr(x))).join(', ')}]`;
  if (typeof v === 'object') return '{...}';
  return String(v);
}
const pyLen = (s) => [...s].length;

// Same checks, same messages, same order as check_skill.check(). `dirname` is the folder holding SKILL.md.
export function checkSkill(text, dirname) {
  const errors = [];
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return ["missing '---' YAML frontmatter block at the top of the file"];
  const [, raw, body] = m;
  const parsed = parseYaml(raw, 1);
  if (!parsed.ok) return [`frontmatter is not valid YAML: ${parsed.error}`];
  let meta = parsed.value;
  if (!truthy(meta)) meta = {};
  if (typeof meta !== 'object' || Array.isArray(meta)) return ['frontmatter must be a mapping of keys to values'];

  let name = meta.name;
  if (!truthy(name) || !pyStr(name).trim()) errors.push("frontmatter is missing a 'name'");
  else {
    name = pyStr(name).trim();
    if (pyLen(name) > NAME_MAX) errors.push(`'name' is ${pyLen(name)} chars (max ${NAME_MAX})`);
    if (!NAME_RE.test(name)) errors.push(`'name' '${name}' is not lowercase kebab-case`);
    if (name !== dirname) errors.push(`'name' '${name}' does not match directory '${dirname}'`);
  }

  const desc = meta.description;
  if (!truthy(desc) || !pyStr(desc).trim()) errors.push("frontmatter is missing a 'description'");
  else if (pyLen(pyStr(desc)) > DESC_MAX) errors.push(`'description' is ${pyLen(pyStr(desc))} chars (max ${DESC_MAX})`);

  if (!body.trim()) errors.push('no instructions found in the body after the frontmatter');
  return errors;
}

// What `python scripts/check_skill.py <path>` prints.
export function lintReport(path, errors) {
  return errors.length ? [`FAIL ${path}`, ...errors.map((e) => `  - ${e}`)] : [`ok   ${path}`];
}

// Advice that is not part of the gate (check_skill.py does not enforce it) but the notes teach.
export function hintsFor(text) {
  const m = FRONTMATTER_RE.exec(text);
  const parsed = m ? parseYaml(m[1]) : null;
  if (!parsed || !parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return [];
  const desc = pyStr(parsed.value.description ?? '');
  const hints = [];
  if (desc.trim() && !splitDescription(desc).when) hints.push("description has no 'Use when ...' clause: say when to use the skill, in the words a user would type");
  if (/\b(I|you|your|my)\b/.test(desc)) hints.push("description should be in the third person ('Generates ...', not 'I generate ...')");
  if (parsed.value['allowed-tools'] === undefined) hints.push('no allowed-tools: the skill is not restricted to any set of tools');
  return hints;
}

export function parseSkillFile(text) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  const parsed = parseYaml(m[1]);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return null;
  const meta = parsed.value;
  let allowed = null;
  const raw = meta['allowed-tools'];
  if (Array.isArray(raw)) allowed = raw.map((x) => String(x).trim()).filter(Boolean);
  else if (typeof raw === 'string' && raw.trim()) allowed = raw.split(/[\s,]+/).filter(Boolean);
  return {
    name: meta.name === undefined || meta.name === null ? '' : pyStr(meta.name).trim(),
    description: meta.description === undefined || meta.description === null ? '' : pyStr(meta.description).trim(),
    allowed,
    body: m[2],
  };
}

// ---------------------------------------------------------------- how the "agent" chooses a skill

export const THRESHOLD = 2; // fewest points that make the agent pick a skill at all
export const WHEN_POINTS = 2; // a word from the 'Use when ...' clause
export const WHAT_POINTS = 1; // a word from the rest of the description, or from the name

const STOP = new Set(
  ('a an the and or of to in on at by for with from into onto as is are was were be been it its this that these those you your i me my we our us they them their he she his her ' +
    'what whats when whenever where which who whom how why use uses used user users ask asks asked asking want wants need needs please can could would should will do does did not no so if then than ' +
    'any all some one also just about up out over per via there here very much more most thanks thank')
    .split(' '),
);

export function stem(word) {
  let s = word;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (s.endsWith(suffix) && s.length - suffix.length >= 3) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s.slice(0, 5);
}

// [{ word, stem }] for the words that carry meaning.
export function tokens(text) {
  const words = text.toLowerCase().replace(/['’]s\b/g, '').match(/[a-z]+/g) || [];
  return words.filter((w) => w.length >= 3 && !STOP.has(w)).map((word) => ({ word, stem: stem(word) }));
}

// The part of a description after "Use when ..." is the trigger clause; the rest says what the skill does.
export function splitDescription(desc) {
  const m = /\b(?:use|used|trigger(?:ed)?)\s+(?:\w+\s+){0,3}?(?:when|if|for)\b|\bwhen the user\b/i.exec(desc);
  return m ? { what: desc.slice(0, m.index), when: desc.slice(m.index) } : { what: desc, when: '' };
}

// Points for one skill on one request: 2 per request word found in the 'Use when' clause, 1 per word
// found in the rest of the description or in the name. Each request word counts once, at its best.
export function scoreSkill(skill, requestText) {
  const { what, when } = splitDescription(skill.description);
  const whenSet = new Set(tokens(when).map((t) => t.stem));
  const whatSet = new Set([...tokens(what), ...tokens(skill.name.replace(/-/g, ' '))].map((t) => t.stem));
  const seen = new Set();
  let score = 0;
  const matches = [];
  for (const { word, stem: s } of tokens(requestText)) {
    if (seen.has(s)) continue;
    seen.add(s);
    const points = whenSet.has(s) ? WHEN_POINTS : whatSet.has(s) ? WHAT_POINTS : 0;
    if (points) {
      score += points;
      matches.push({ word, points });
    }
  }
  return { name: skill.name, score, matches };
}

// The best score wins if it reaches THRESHOLD; a tie goes to the skill listed first (alphabetical).
export function pickSkill(skills, requestText) {
  const scores = skills.map((s) => scoreSkill(s, requestText)).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const best = scores[0];
  return { pick: best && best.score >= THRESHOLD ? best.name : null, scores };
}

// ---------------------------------------------------------------- the world

export const LAYERS = ['frontmatter', 'body', 'bundled'];
export const LAYER_LABEL = { frontmatter: 'Frontmatter', body: 'Body', bundled: 'Bundled file' };
export const SKILL_DIRS = ['.claude/skills', '~/.claude/skills'];
export const POINTER_TOKENS = 12;
const estTokens = (s) => Math.ceil(s.length / 4);
const clone = (o) => JSON.parse(JSON.stringify(o));

export function createWorld(sc) {
  const w = {
    mode: sc.mode,
    health: 100,
    minHealth: sc.minHealth ?? 60,
    penalty: sc.penalty ?? 20,
    window: sc.window,
    base: sc.base,
    library: clone(sc.library),
    installed: [...(sc.installed || [])],
    requests: clone(sc.requests),
    schedule: clone(sc.schedule || []),
    cursor: 0,
    results: [],
    last: null,
    broken: null, // a bundled file that has gone stale
    explained: new Set(),
    watch: [],
    requireScope: Boolean(sc.requireScope),
    skillName: sc.skillName,
  };
  if (sc.mode === 'layers') {
    w.chunks = clone(sc.chunks);
    w.layers = { ...sc.start };
    w.skill = { dir: sc.skillName, location: '.claude/skills', files: {} };
  } else {
    w.skill = clone(sc.skill);
  }
  return w;
}

// The files of the skill as they stand. In layers mode they are built from the chunk placement.
export function skillFiles(w) {
  if (w.mode !== 'layers') {
    return { text: w.skill.text, bundled: w.skill.files, fmTokens: null, bodyTokens: null, pointers: [] };
  }
  const fm = [];
  const body = [];
  const bundled = {};
  const pointers = [];
  let fmTokens = 0;
  let bodyTokens = 0;
  for (const c of w.chunks) {
    const layer = w.layers[c.id];
    if (layer === 'frontmatter') {
      fm.push(c.fm ?? `x-${c.id}: "(${c.tokens} tokens: ${c.label})"`);
      fmTokens += c.tokens;
    } else if (layer === 'body') {
      body.push(c.body ?? `<${c.label}, about ${c.tokens} tokens>`);
      bodyTokens += c.tokens;
    } else if (layer === 'bundled') {
      bundled[c.file] = c.tokens;
      if (c.pointer) {
        pointers.push(c.pointer);
        bodyTokens += POINTER_TOKENS;
      }
    }
  }
  const text = `---\n${fm.join('\n')}\n---\n${[...body, ...pointers].join('\n')}`;
  return { text, bundled, fmTokens, bodyTokens, pointers };
}

// Everything the game knows about the player's skill right now.
export function skillStatus(w) {
  const f = skillFiles(w);
  const errors = checkSkill(f.text, w.skill.dir);
  const info = parseSkillFile(f.text);
  const located = SKILL_DIRS.includes(w.skill.location);
  const fmTokens = f.fmTokens ?? (info ? estTokens(info.name) + estTokens(info.description) : 0);
  const bodyTokens = f.bodyTokens ?? (info ? estTokens(info.body) : 0);
  return {
    text: f.text,
    errors,
    located,
    discoverable: !errors.length && located && Boolean(info),
    name: info ? info.name : '',
    description: info ? info.description : '',
    allowed: info ? info.allowed : null,
    body: info ? info.body : '',
    fmTokens,
    bodyTokens,
    bundled: f.bundled,
    path: `${w.skill.location}/${w.skill.dir}/SKILL.md`,
  };
}

// The skills the agent can see right now: the installed library plus the player's, if discoverable.
export function candidates(w) {
  const list = w.installed.map((id) => {
    const s = w.library[id];
    return { name: id, description: s.description, fmTokens: estTokens(id) + estTokens(s.description), bodyTokens: s.bodyTokens, mine: false };
  });
  const sk = skillStatus(w);
  if (sk.discoverable) list.push({ name: sk.name, description: sk.description, fmTokens: sk.fmTokens, bodyTokens: sk.bodyTokens, mine: true });
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- serving a request

// What would happen to this request right now? Pure, so the UI can preview the whole queue.
export function evaluate(w, req) {
  const sk = skillStatus(w);
  const cands = candidates(w);
  const { pick, scores } = pickSkill(cands, req.text);
  const chosen = cands.find((c) => c.name === pick) || null;
  const want = req.want;
  const mine = want === w.skillName;

  const loads = { base: w.base, meta: cands.reduce((n, c) => n + c.fmTokens, 0), body: 0, bundled: 0 };
  const missingPointer = [];
  const inlined = [];
  if (chosen) {
    loads.body = chosen.bodyTokens;
    if (chosen.mine) {
      for (const need of req.needs || []) {
        if (w.mode === 'layers') {
          const layer = w.layers[need];
          const chunk = w.chunks.find((c) => c.id === need);
          if (layer === 'bundled') loads.bundled += chunk.tokens;
          else inlined.push(need);
        } else if (sk.body.includes(need)) loads.bundled += sk.bundled[need] || 0;
        else missingPointer.push(need);
      }
    }
  }
  const total = loads.base + loads.meta + loads.body + loads.bundled;
  const out = { req, pick, scores, loads, total, window: w.window, mine, outcome: 'ok', ok: true, message: '' };
  const fail = (outcome, message) => Object.assign(out, { outcome, ok: false, message });

  if (total > w.window) return fail('overflow', `Context overflow: this needs ${total} tokens and the window holds ${w.window}.`);

  if (!pick) {
    if (want === null) return Object.assign(out, { message: 'No skill matched, so the agent answered directly. That was right.' });
    if (mine && sk.errors.length) return fail('lint-rejected', `${w.skillName} never loaded: the lint gate rejected it (${sk.errors.length} error${sk.errors.length > 1 ? 's' : ''}).`);
    if (mine && !sk.located) return fail('not-discovered', `${w.skillName} sits in ${w.skill.location}/, which the agent does not scan.`);
    const best = scores[0] ? scores[0].score : 0;
    return fail('missed', `No skill reached ${THRESHOLD} points (best: ${best}), so ${want} never triggered.`);
  }
  if (want === null) return fail('false-trigger', `${pick} triggered on a request that needed no skill.`);
  if (pick !== want) return fail('wrong', `${pick} answered, but the right skill was ${want}.`);

  if (chosen.mine) {
    const away = w.mode === 'layers' ? w.chunks.find((c) => c.core && w.layers[c.id] !== 'body') : null;
    if (away) return fail('no-procedure', `The skill triggered, but its body holds no procedure: "${away.label}" is in the ${LAYER_LABEL[w.layers[away.id]].toLowerCase()} layer.`);
    if (inlined.some((id) => id === w.broken)) return fail('stale', `The logic for ${w.broken} is copied inside the skill, and that copy is broken. It has to be fixed everywhere it was pasted.`);
    if (missingPointer.length) return fail('incomplete', `The body never mentions ${missingPointer[0]}, so the agent did not know to run it.`);
    if (req.tools && sk.allowed) {
      const missing = req.tools.find((t) => !sk.allowed.includes(t));
      if (missing) return fail('blocked', `${missing} is not in allowed-tools, so the skill could not do its job.`);
    }
    if (req.risky) {
      const open = sk.allowed ? req.risky.find((t) => sk.allowed.includes(t)) : req.risky[0];
      if (open) return fail('scope', sk.allowed ? `allowed-tools includes ${open}, so the skill did what the request asked, outside its job.` : 'No allowed-tools: the skill could use any tool, so it did what the request asked, outside its job.');
      out.message = `${pick} drafted the notes and was stopped at the write: ${req.risky.join(' and ')} are not in allowed-tools.`;
      return out;
    }
  }
  out.message = `${pick} loaded and answered.`;
  return out;
}

export const EVENT_FOR = {
  overflow: 'context-overflow',
  missed: 'never-triggered',
  wrong: 'wrong-skill',
  'false-trigger': 'false-trigger',
  'lint-rejected': 'lint-rejected',
  'not-discovered': 'not-discovered',
  stale: 'stale-script',
  incomplete: 'body-no-pointer',
  'no-procedure': 'no-procedure',
  blocked: 'tool-blocked',
  scope: 'scope-creep',
};

function explain(w, ctx, id, detail) {
  if (!w.explained.has(id)) {
    w.explained.add(id);
    ctx.fire(id, detail);
  }
  ctx.resolve(id);
}

function serveNext(w, ctx) {
  const index = w.cursor;
  const req = w.requests[index];
  w.cursor += 1;
  const r = evaluate(w, req);
  r.index = index;
  w.results.push(r);
  w.last = r;
  if (!r.ok) w.health = Math.max(0, w.health - w.penalty);
  ctx.log(`Request ${index + 1}: "${req.text}". ${r.message}`, { kind: r.ok ? 'good' : 'warn' });
  if (!r.ok) explain(w, ctx, EVENT_FOR[r.outcome]);
  if (req.teach) explain(w, ctx, req.teach);
  for (const id of w.watch) ctx.resolve(id);
  w.watch = [];
}

// One turn: scheduled trouble first, then the next request from the queue.
export function tick(w, ctx) {
  for (const item of w.schedule) {
    if (item.tick !== ctx.ticks) continue;
    if (item.install) w.installed.push(item.install);
    if (item.window) w.window = item.window;
    if (item.breaks) w.broken = item.breaks;
    w.explained.add(item.event);
    ctx.fire(item.event, item.detail);
    if (item.install || item.window) w.watch.push(item.event);
  }
  if (w.cursor < w.requests.length) serveNext(w, ctx);
}

// ---------------------------------------------------------------- the player's moves

// Layers mode: put a chunk of the skill in one layer. False when nothing would change.
export function place(w, id, layer) {
  if (w.mode !== 'layers' || !LAYERS.includes(layer) || !w.chunks.some((c) => c.id === id) || w.layers[id] === layer) return false;
  w.layers[id] = layer;
  return true;
}

// File mode: save the SKILL.md text. False when it is unchanged.
export function saveText(w, text) {
  if (w.mode !== 'file' || typeof text !== 'string' || text === w.skill.text) return false;
  w.skill.text = text;
  return true;
}

export function setDir(w, name) {
  const dir = String(name ?? '').trim();
  if (w.mode !== 'file' || !dir || dir === w.skill.dir || /[\\/]/.test(dir)) return false;
  w.skill.dir = dir;
  return true;
}

export function setLocation(w, location) {
  const options = ['skills', 'docs/skills', ...SKILL_DIRS];
  if (w.mode !== 'file' || !options.includes(location) || location === w.skill.location) return false;
  w.skill.location = location;
  return true;
}

export const LOCATIONS = ['skills', 'docs/skills', ...SKILL_DIRS];

// ---------------------------------------------------------------- win and lose

// Nothing left broken: the skill passes the gate, sits where the agent looks, and is not left open
// (a stale pasted copy of a script, or write access it should not have).
export function isClean(w) {
  const sk = skillStatus(w);
  if (!sk.discoverable) return false;
  if (w.mode === 'layers' && w.broken && w.layers[w.broken] !== 'bundled') return false;
  if (w.requireScope && (!sk.allowed || ['Write', 'Edit'].some((t) => sk.allowed.includes(t)))) return false;
  return true;
}

const done = (w) => w.cursor >= w.requests.length;
export const isLost = (w) => w.health < w.minHealth || (done(w) && !isClean(w));
export const isWon = (w) => done(w) && w.health >= w.minHealth && isClean(w);

// The always-loaded footprint: every installed skill's name and description.
export const footprint = (w) => candidates(w).reduce((n, c) => n + c.fmTokens, 0);
