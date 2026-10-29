// "Chaos Monkey Cluster": keep a Service healthy while a chaos monkey breaks a small cluster.
// The simulation lives in sim.js and the kubectl subset in kubectl.js (both DOM-free); this file
// is the board, the prompt and the edit form, plus the registerGame wiring.
import { registerGame } from '../shared/engine.js';
import { createPrompt } from '../shared/prompt.js';
import { el } from '../shared/ui.js';
import {
  IMAGES,
  createWorld,
  editTemplate,
  isLost as simIsLost,
  isWon as simIsWon,
  nodeUsed,
  noteDiagnosis,
  podStatus,
  takeBlind,
  tick as simTick,
} from './sim.js';
import { exec, isMutating, nextWords } from './kubectl.js';

const STRIP_CELLS = 20;
const MAX_TERM_LINES = 400;

// ---------------------------------------------------------------- terminal + commands

function print(state, text) {
  const term = state.dom.term;
  term.append(document.createTextNode(`${text}\n`));
  while (term.childNodes.length > MAX_TERM_LINES) term.firstChild.remove();
  term.scrollTop = term.scrollHeight;
}

const BLIND_COST = 4;

// A fix made before reading about the fault (describe or logs) may work, but it is luck: it costs a little.
function chargeBlind(state, ctx) {
  if (!takeBlind(state)) return;
  state.health = Math.max(0, state.health - BLIND_COST);
  print(state, `You changed the cluster before reading what was wrong (kubectl describe, kubectl logs). If that worked it was luck: it cost ${BLIND_COST}% of the error budget.`);
  ctx.log(`Fixed without diagnosing: -${BLIND_COST}%. Read first (describe, logs).`, { kind: 'warn' });
}

function runCommand(state, ctx, line) {
  print(state, `$ ${line}`);
  const res = exec(state, ctx, line);
  if (res.text) print(state, res.text);
  if (res.edit) openEdit(state, ctx);
  if (/^(kubectl|k)\s+(describe|logs)\b/.test(line.trim()) && !res.error) noteDiagnosis(state);
  if (res.mutated) {
    state.mutations += 1;
    chargeBlind(state, ctx);
  }
  return res;
}

// Reading is always allowed (even paused, even after the game ends); changing the cluster goes
// through the action pipeline so it is counted, scored and blocked while paused.
function submit(state, ctx, line) {
  if (!line) return;
  if (!isMutating(line)) {
    runCommand(state, ctx, line);
    ctx.record(line); // a read is part of the run: the debrief shows what you looked at before you acted
    return;
  }
  state.ran = false;
  ctx.act('kubectl', line);
  if (!state.ran) {
    print(state, `$ ${line}`);
    print(state, 'Nothing changed: the game is paused or over. Resume with "p" to make changes (reading still works).');
  }
}

// ---------------------------------------------------------------- edit form

function field(label, input) {
  return el('label', { class: 'k8s-field' }, el('span', { text: label }), input);
}

function buildEditForm(state, ctx) {
  const images = el('datalist', { id: 'k8s-images' }, ...Object.keys(IMAGES).filter((i) => i.startsWith('web:')).map((i) => el('option', { value: i })));
  const f = {
    image: el('input', { name: 'image', list: 'k8s-images', autocomplete: 'off', spellcheck: 'false' }),
    app: el('input', { name: 'app', autocomplete: 'off', spellcheck: 'false' }),
    request: el('input', { name: 'request', type: 'number', min: 50, max: 2000, step: 50 }),
    limit: el('input', { name: 'limit', type: 'number', min: 50, max: 2000, step: 50 }),
    envKey: el('input', { name: 'envKey', autocomplete: 'off', spellcheck: 'false' }),
    readiness: el('input', { name: 'readiness', type: 'checkbox' }),
    nonRoot: el('input', { name: 'nonRoot', type: 'checkbox' }),
  };
  const apply = el('button', { class: 'cg-btn cg-btn-primary', type: 'submit', text: 'Apply' });
  const cancel = el('button', { class: 'cg-btn', type: 'button', text: 'Cancel' });
  const form = el(
    'form',
    { class: 'k8s-edit', 'aria-label': 'Edit deployment/web' },
    el('h4', { class: 'k8s-edit-title', text: 'kubectl edit deploy/web' }),
    el(
      'div',
      { class: 'k8s-edit-grid' },
      field('image', f.image),
      field('pod label app=', f.app),
      field('memory request (Mi)', f.request),
      field('memory limit (Mi)', f.limit),
      field("ConfigMap key (web-config)", f.envKey),
      field('readinessProbe', f.readiness),
      field('securityContext.runAsNonRoot', f.nonRoot),
    ),
    el('div', { class: 'k8s-edit-actions' }, apply, cancel),
    images,
  );
  form.hidden = true;
  cancel.addEventListener('click', () => {
    form.hidden = true;
    ctx.hold('edit', false);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fields = {
      image: f.image.value,
      app: f.app.value,
      request: f.request.value,
      limit: f.limit.value,
      envKey: f.envKey.value,
      readiness: f.readiness.checked,
      nonRoot: f.nonRoot.checked,
    };
    state.ran = false;
    ctx.act('applyEdit', fields);
    if (!state.ran) print(state, 'Nothing changed: the game is paused or over. Resume with "p" to make changes.');
  });
  state.dom.fields = f;
  return form;
}

function openEdit(state, ctx) {
  ctx.hold('edit', true); // the clock waits while the form is open
  const t = state.deploys.web.template;
  const f = state.dom.fields;
  f.image.value = t.image;
  f.app.value = t.app;
  f.request.value = t.request;
  f.limit.value = t.limit;
  f.envKey.value = t.envKey;
  f.readiness.checked = t.readiness;
  f.nonRoot.checked = t.nonRoot;
  state.dom.edit.hidden = false;
  f.image.focus();
}

// ---------------------------------------------------------------- the pod action sheet

function closeSheet(state, ctx) {
  state.dom.sheet.hidden = true;
  state.sheetPod = null;
  ctx.hold('sheet', false);
}

// Tap a pod: its actions, each with the kubectl it runs, so tapping teaches the command. The clock waits while it is open.
function openSheet(state, ctx, pod) {
  const sheet = state.dom.sheet;
  const { status } = podStatus(state, pod);
  const act = (line) => {
    closeSheet(state, ctx);
    submit(state, ctx, line);
  };
  const choice = (label, line, note) => {
    const b = el('button', { class: 'cg-btn k8s-sheet-btn', type: 'button', 'data-line': line }, el('span', { class: 'k8s-sheet-label', text: label }), el('code', { class: 'k8s-sheet-cmd', text: line }), note ? el('span', { class: 'k8s-sheet-note', text: note }) : null);
    b.addEventListener('click', () => act(line));
    return b;
  };
  const close = el('button', { class: 'cg-btn', type: 'button', 'data-cg': 'close-sheet', text: 'Close' });
  close.addEventListener('click', () => closeSheet(state, ctx));
  const buttons = [choice('Describe', `kubectl describe pod ${pod.name}`, 'Read why it is in this state'), choice('Logs', `kubectl logs ${pod.name}`, 'Read what the container said')];
  if (pod.deploy === 'web') buttons.push(choice('Roll back web', 'kubectl rollout undo deploy/web', 'Undo the last change to the Deployment'));
  buttons.push(choice('Delete pod', `kubectl delete pod ${pod.name}`, pod.deploy ? 'The Deployment makes a new one from the same template' : 'Nothing will bring a bare Pod back'));
  sheet.replaceChildren(el('h4', { class: 'k8s-sheet-title', text: `${pod.name}: ${status}` }), el('div', { class: 'k8s-sheet-actions' }, ...buttons), close);
  sheet.setAttribute('aria-label', `Actions for ${pod.name}`);
  sheet.hidden = false;
  state.sheetPod = pod.name;
  ctx.hold('sheet', true);
  buttons[0].focus({ preventScroll: true });
  sheet.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------- board

function buildBoard(state, ctx) {
  const summary = el('p', { class: 'k8s-summary' });
  const strip = el('div', { class: 'k8s-strip', role: 'img' });
  for (let i = 0; i < STRIP_CELLS; i++) strip.append(el('span', { class: 'k8s-cell' }));
  const nodes = el('div', { class: 'k8s-nodes', role: 'list', 'aria-label': 'Nodes' });
  const pending = el('div', { class: 'k8s-pending', role: 'list', 'aria-label': 'Pods waiting for a node' });
  const term = el('pre', { class: 'k8s-term', tabindex: 0, role: 'log', 'aria-live': 'polite', 'aria-label': 'kubectl output' });
  const cmd = createPrompt({
    label: 'kubectl command',
    placeholder: 'kubectl get pods',
    cls: { form: 'k8s-prompt', ps1: 'k8s-ps1', input: 'k8s-input' },
    next: (words) => nextWords(state, words),
    onSubmit: (line) => submit(state, ctx, line.trim()),
    onActivity: (on) => ctx.hold('prompt', on), // typing is never a race against the tick
  });
  const prompt = el('div', { class: 'k8s-promptbox' }, cmd.form, cmd.tray);

  const sheet = el('section', { class: 'k8s-sheet', role: 'region', hidden: true });
  state.dom = { summary, strip, nodes, pending, term, prompt: cmd, sheet, sig: '' };
  state.edit = null;
  const edit = buildEditForm(state, ctx);
  state.dom.edit = edit;

  ctx.ui.board.append(
    el('div', { class: 'k8s' }, summary, strip, nodes, pending, sheet, el('p', { class: 'k8s-hint', text: 'Tap a pod for its actions, or build a command below. The clock waits while you do.' }), prompt, term, edit),
  );
}

function classify(pod) {
  if (pod.terminating) return 'term';
  if (pod.phase === 'Pending') return 'pending';
  if (pod.phase === 'Running') return 'ok';
  if (pod.phase === 'Starting') return 'starting';
  return 'bad';
}

function podTile(state, ctx, pod) {
  const { status, ready } = podStatus(state, pod);
  const short = pod.name.replace(/^([a-z]+)-\w+-/, '$1-');
  const btn = el(
    'button',
    { class: `k8s-pod k8s-pod-${classify(pod)}`, type: 'button', title: `${pod.name}: tap for actions`, 'data-pod': pod.name },
    el('span', { class: 'k8s-pod-name', text: short }),
    el('span', { class: 'k8s-pod-status', text: status }),
    el('span', { class: 'k8s-pod-meta', text: `ready ${ready}${pod.restarts ? ` · restarts ${pod.restarts}` : ''}${pod.template.app !== 'web' && pod.deploy !== 'batch' ? ` · app=${pod.template.app}` : ''}` }),
  );
  btn.addEventListener('click', () => openSheet(state, ctx, pod));
  return btn;
}

function renderBoard(state, ctx) {
  const d = state.dom;
  const t = state.traffic;
  d.summary.textContent = `Service web-svc routes to ${t.endpoints} pod${t.endpoints === 1 ? '' : 's'} · ${Math.round(t.ok)}% of requests succeeded this tick · load needs ${state.needed} pods' worth of capacity`;
  const okCells = Math.round((t.ok / 100) * STRIP_CELLS);
  [...d.strip.children].forEach((cell, i) => cell.classList.toggle('k8s-cell-fail', i >= okCells));
  d.strip.setAttribute('aria-label', `Requests this tick: ${Math.round(t.ok)} percent succeeded`);

  // Rebuild the pods only when something visible changed, so focus on a tile survives quiet ticks.
  const sig = JSON.stringify([state.pods.map((p) => [p.name, p.phase, p.node, p.restarts, p.terminating, p.age, p.template.app, p.template.readiness]), t.endpoints, Math.round(t.ok)]);
  if (sig === d.sig) return;
  d.sig = sig;
  d.prompt.refresh();

  const byId = (a, b) => a.id - b.id;
  d.nodes.replaceChildren(
    ...state.nodes.map((node) => {
      const used = nodeUsed(state, node.name);
      const pct = Math.round((used / node.capacity) * 100);
      const level = pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
      return el(
        'div',
        { class: 'k8s-node', role: 'listitem' },
        el('div', { class: 'k8s-node-head' }, el('strong', { text: node.name }), el('span', { text: `${used}/${node.capacity}Mi requested` })),
        el('div', { class: 'k8s-bar', 'aria-hidden': 'true' }, el('div', { class: 'k8s-bar-fill', 'data-level': level, style: `width:${Math.min(100, pct)}%` })),
        el('div', { class: 'k8s-pods' }, ...state.pods.filter((p) => p.node === node.name).sort(byId).map((p) => podTile(state, ctx, p))),
      );
    }),
  );
  const waiting = state.pods.filter((p) => p.phase === 'Pending' && !p.terminating).sort(byId);
  d.pending.replaceChildren(
    ...(waiting.length ? [el('div', { class: 'k8s-pending-head', text: 'Pending: no node has room' }), el('div', { class: 'k8s-pods' }, ...waiting.map((p) => podTile(state, ctx, p)))] : []),
  );
}

// ---------------------------------------------------------------- the game

registerGame({
  id: 'kubernetes',
  styles: 'game.css',

  init(state, ctx) {
    Object.assign(state, createWorld(ctx.scenario, ctx.variant ? { seed: ctx.seed } : null));
    buildBoard(state, ctx);
    const web = state.deploys.web;
    ctx.log(`Cluster ready: ${state.nodes.length} nodes, deployment web x${web.replicas}, Service web-svc (needs ${state.needed} pods' worth of capacity).`);
    print(state, 'Welcome to the cluster. Type "help" to see the commands. Reading (get/describe/logs) is free and works while paused.');
  },

  // How a move reads in the debrief and in the efficient path.
  describeMove(name, args) {
    if (name === 'applyEdit') return `Edit the deployment: ${Object.entries(args[0]).map(([k, v]) => `${k} = ${v}`).join(', ')}`;
    return undefined;
  },

  tick: (state, ctx) => simTick(state, ctx),

  actions: {
    kubectl: {
      hidden: true,
      run(state, ctx, line) {
        state.ran = true;
        const res = runCommand(state, ctx, line);
        if (res.mutated) return undefined;
        return isMutating(line) ? false : 'free'; // a read costs nothing but is part of the run
      },
    },
    applyEdit: {
      hidden: true,
      run(state, ctx, fields) {
        state.ran = true;
        print(state, '$ kubectl edit deploy/web');
        const res = editTemplate(state, state.deploys.web, fields, ctx.ticks);
        if (res.error) {
          print(state, `error: ${res.error}`);
          return false;
        }
        if (!res.changed) {
          print(state, 'Edit cancelled, no changes made.');
          return false;
        }
        print(state, 'deployment.apps/web edited');
        state.mutations += 1;
        state.dom.edit.hidden = true;
        ctx.hold('edit', false);
        chargeBlind(state, ctx);
      },
    },
    nextIncident: {
      label: 'Next incident',
      key: 'i',
      run(state, ctx) {
        // Skip the quiet ticks: run the clock to the next scheduled trouble (or a few ticks if none is left).
        const later = (ctx.scenario.schedule || []).map((item) => item.tick).filter((t) => t > ctx.ticks);
        ctx.step(later.length ? Math.min(...later) - ctx.ticks : 5);
        return 'free';
      },
    },
    scaleUp: {
      label: 'Scale web +1',
      key: '+',
      run(state, ctx) {
        state.ran = true;
        const n = state.deploys.web.replicas + 1;
        if (n > 9) return false;
        return runCommand(state, ctx, `kubectl scale deploy/web --replicas=${n}`).mutated ? undefined : false;
      },
    },
    scaleDown: {
      label: 'Scale web -1',
      key: '-',
      run(state, ctx) {
        state.ran = true;
        const n = state.deploys.web.replicas - 1;
        if (n < 0) return false;
        return runCommand(state, ctx, `kubectl scale deploy/web --replicas=${n}`).mutated ? undefined : false;
      },
    },
    rollback: {
      label: 'Roll back web',
      key: 'b',
      run(state, ctx) {
        state.ran = true;
        return runCommand(state, ctx, 'kubectl rollout undo deploy/web').mutated ? undefined : false;
      },
    },
    editDeploy: {
      label: 'Edit web...',
      key: 'e',
      run(state, ctx) {
        state.ran = true;
        runCommand(state, ctx, 'kubectl edit deploy/web');
        return false; // opening the form is free; Apply is what counts
      },
    },
  },

  isWon: (state) => simIsWon(state),
  isLost: (state) => simIsLost(state),
  render: (state, ctx) => renderBoard(state, ctx),
});
