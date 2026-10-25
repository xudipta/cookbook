// A tiny `kubectl` for the Chaos Monkey Cluster game: just the commands that
// topics/kubernetes/notes/01-kubectl-commands.md and 07-probes-and-resources.md teach, with output
// shaped like the real tool. exec() returns { text, error?, mutated?, edit? } and never throws.
import {
  IMAGES,
  deletePod,
  editTemplate,
  endpoints,
  nodeUsed,
  podStatus,
  scaleDeploy,
  setTemplate,
  undoRollout,
} from './sim.js';

// True for commands that change the cluster; the game only lets these run while it is not paused.
export function isMutating(line) {
  const t = line.trim().split(/\s+/);
  const verb = t[1];
  return t[0] !== 'help' && (verb === 'scale' || verb === 'set' || verb === 'delete' || (verb === 'rollout' && t[2] === 'undo'));
}

export const HELP = `Commands this prompt understands (the same ones the Kubernetes notes use):
  kubectl get pods [-o wide] | deploy | endpoints | svc | nodes
  kubectl describe pod <name> | deploy <name> | nodes
  kubectl logs <pod>
  kubectl scale deploy/<name> --replicas=<n>
  kubectl rollout undo deploy/<name>        kubectl rollout status deploy/<name>
  kubectl set image deploy/<name> web=<image>
  kubectl set resources deploy/<name> --requests=memory=300Mi --limits=memory=500Mi
  kubectl edit deploy/<name>                (opens the form below)
  kubectl delete pod <name>
Images in the registry: ${Object.keys(IMAGES).join(', ')}`;

const KINDS = {
  po: 'pods', pod: 'pods', pods: 'pods',
  deploy: 'deploy', deployment: 'deploy', deployments: 'deploy',
  ep: 'endpoints', endpoints: 'endpoints',
  svc: 'svc', service: 'svc', services: 'svc',
  no: 'nodes', node: 'nodes', nodes: 'nodes',
};

const ok = (text, extra = {}) => ({ text, ...extra });
const fail = (text) => ({ text, error: true });

function parse(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      else if (tokens[i + 1] && !tokens[i + 1].startsWith('-')) flags[tok.slice(2)] = tokens[++i];
      else flags[tok.slice(2)] = true;
    } else if (tok === '-o' || tok === '-l' || tok === '-n') {
      flags[tok.slice(1)] = tokens[++i];
    } else {
      positional.push(tok);
    }
  }
  return { flags, positional };
}

// "deploy/web", "deploy web" -> { kind, name }
function target(positional) {
  const first = positional[0];
  if (!first) return {};
  if (first.includes('/')) {
    const [kind, name] = first.split('/');
    return { kind: KINDS[kind], name };
  }
  return { kind: KINDS[first], name: positional[1] };
}

function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((cell, c) => String(cell).padEnd(widths[c] + 3)).join('').trimEnd()).join('\n');
}

const parseMi = (value) => {
  const m = /^(\d+)Mi$/.exec(value || '');
  return m ? Number(m[1]) : null;
};

function findDeploy(w, name) {
  return w.deploys[name];
}

function findPod(w, name) {
  return w.pods.find((p) => p.name === name);
}

function age(ctx, pod) {
  return `${Math.max(0, ctx.ticks - pod.born)}s`;
}

// ---------------------------------------------------------------- get

function getPods(w, ctx, flags) {
  let pods = [...w.pods].sort((a, b) => a.id - b.id);
  if (flags.l) {
    const [key, value] = String(flags.l).split('=');
    if (key !== 'app') return fail(`error: this simulator only supports -l app=<value> (got "${flags.l}")`);
    pods = pods.filter((p) => p.template.app === value);
  }
  if (!pods.length) return ok('No resources found in default namespace.');
  const wide = flags.o === 'wide';
  const rows = [['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE'] : [])]];
  for (const p of pods) {
    const { ready, status } = podStatus(w, p);
    rows.push([p.name, ready, status, p.restarts, age(ctx, p), ...(wide ? [p.ip || '<none>', p.node || '<none>'] : [])]);
  }
  return ok(table(rows));
}

function getDeploys(w) {
  const rows = [['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE']];
  for (const d of Object.values(w.deploys)) {
    if (d.name === 'batch' && d.replicas === 0 && !w.pods.some((p) => p.deploy === 'batch')) continue;
    const owned = w.pods.filter((p) => p.deploy === d.name && !p.terminating);
    const ready = owned.filter((p) => p.phase === 'Running').length;
    rows.push([d.name, `${ready}/${d.replicas}`, owned.filter((p) => p.template.rev === d.template.rev).length, ready]);
  }
  return ok(table(rows));
}

function getEndpoints(w) {
  const eps = endpoints(w);
  return ok(table([['NAME', 'ENDPOINTS'], ['web-svc', eps.length ? eps.map((p) => `${p.ip}:80`).join(',') : '<none>']]));
}

function getNodes(w) {
  return ok(table([['NAME', 'STATUS', 'ROLES'], ...w.nodes.map((n) => [n.name, 'Ready', '<none>'])]));
}

// ---------------------------------------------------------------- describe / logs

function events(w, object) {
  const list = w.k8sEvents.filter((e) => e.object === object).slice(-6);
  if (!list.length) return '  <none>';
  return ['  Type      Reason             Message', ...list.map((e) => `  ${e.type.padEnd(9)} ${e.reason.padEnd(18)} ${e.message}${e.count > 1 ? ` (x${e.count})` : ''}`)].join('\n');
}

function describePod(w, ctx, name) {
  const p = findPod(w, name);
  if (!p) return fail(`Error from server (NotFound): pods "${name}" not found`);
  const t = p.template;
  const { status } = podStatus(w, p);
  const state = {
    Pending: 'Waiting (not scheduled)',
    Terminating: 'Terminated',
    Starting: p.age === 0 ? 'Waiting\n      Reason:       ContainerCreating' : 'Running',
    Running: 'Running',
    ImagePullBackOff: `Waiting\n      Reason:       ImagePullBackOff`,
    CreateContainerConfigError: `Waiting\n      Reason:       CreateContainerConfigError`,
    OOMKilled: `Terminated\n      Reason:       OOMKilled\n      Exit Code:    137`,
    CrashLoopBackOff: `Waiting\n      Reason:       CrashLoopBackOff`,
  }[p.phase] || p.phase;
  const lines = [
    `Name:             ${p.name}`,
    `Namespace:        default`,
    `Node:             ${p.node || '<none>'}`,
    `Labels:           app=${t.app}`,
    `Status:           ${status === 'Running' ? 'Running' : status}`,
    `Controlled By:    ${p.deploy ? `ReplicaSet/${p.deploy}-${p.name.split('-')[1]}` : '<none>'}`,
    `Containers:`,
    `  web:`,
    `    Image:          ${t.image}`,
    `    State:          ${state}`,
  ];
  if (p.lastReason) lines.push(`    Last State:     Terminated (Reason: ${p.lastReason}, Exit Code: 137)`);
  lines.push(
    `    Restart Count:  ${p.restarts}`,
    `    Limits:         memory: ${t.limit}Mi`,
    `    Requests:       memory: ${t.request}Mi`,
    `    Readiness:      ${t.readiness ? 'http-get http://:80/ delay=2s period=5s' : '<none>'}`,
    `    Security:       ${t.nonRoot ? 'runAsNonRoot: true' : '(not set)'}`,
    `    Environment:    APP_MODE: <set to the key '${t.envKey}' of config map 'web-config'>`,
    `Events:`,
    events(w, `pod/${p.name}`),
  );
  return ok(lines.join('\n'));
}

function describeDeploy(w, ctx, name) {
  const d = findDeploy(w, name);
  if (!d) return fail(`Error from server (NotFound): deployments.apps "${name}" not found`);
  const t = d.template;
  const owned = w.pods.filter((p) => p.deploy === d.name && !p.terminating);
  const ready = owned.filter((p) => p.phase === 'Running').length;
  const updated = owned.filter((p) => p.template.rev === t.rev).length;
  return ok(
    [
      `Name:                   ${d.name}`,
      `Selector:               app=${t.app}`,
      `Replicas:               ${d.replicas} desired | ${updated} updated | ${owned.length} total | ${ready} available | ${Math.max(0, d.replicas - ready)} unavailable`,
      `StrategyType:           RollingUpdate`,
      `RollingUpdateStrategy:  25% max unavailable, 25% max surge`,
      `Pod Template:`,
      `  Labels:  app=${t.app}`,
      `  Containers:`,
      `   web:`,
      `    Image:      ${t.image}`,
      `    Port:       80/TCP`,
      `    Limits:     memory: ${t.limit}Mi`,
      `    Requests:   memory: ${t.request}Mi`,
      `    Readiness:  ${t.readiness ? 'http-get http://:80/ delay=2s period=5s' : '<none>'}`,
      `    Security:   ${t.nonRoot ? 'runAsNonRoot: true' : '(not set)'}`,
      `    Environment:`,
      `      APP_MODE:  <set to the key '${t.envKey}' of config map 'web-config'>`,
      `Events:`,
      events(w, `deployment/${d.name}`),
    ].join('\n'),
  );
}

function describeNodes(w) {
  return ok(
    w.nodes
      .map((n) => {
        const used = nodeUsed(w, n.name);
        const here = w.pods.filter((p) => p.node === n.name);
        return [
          `Name:    ${n.name}`,
          `Capacity:`,
          `  memory:  ${n.capacity}Mi`,
          `Allocated resources:`,
          `  memory requests:  ${used}Mi (${Math.round((used / n.capacity) * 100)}%)`,
          `Non-terminated Pods:  (${here.length} in total)`,
          ...here.map((p) => `  ${p.name.padEnd(22)} requests ${p.template.request}Mi`),
        ].join('\n');
      })
      .join('\n\n'),
  );
}

function logs(w, name) {
  const p = findPod(w, name);
  if (!p) return fail(`Error from server (NotFound): pods "${name}" not found`);
  const waiting = (why) => fail(`Error from server (BadRequest): container "web" in pod "${p.name}" is waiting to start: ${why}`);
  switch (p.phase) {
    case 'Pending':
      return fail(`Error from server (BadRequest): pod ${p.name} does not have a host assigned`);
    case 'ImagePullBackOff':
      return waiting('trying and failing to pull image');
    case 'CreateContainerConfigError':
      return waiting('CreateContainerConfigError');
    case 'OOMKilled':
    case 'CrashLoopBackOff':
      return ok(`starting web (mode=prod)\nloading dataset into memory (${(IMAGES[p.template.image] || {}).mem}Mi)...\n(process killed: no further output)`);
    case 'Starting':
      return ok('starting web...\nwarming cache (not ready to serve yet)');
    default:
      return ok(`starting web (mode=prod)\nready, serving on :80\nGET / 200\nGET / 200\nGET /healthz 200`);
  }
}

// ---------------------------------------------------------------- entry point

export function exec(w, ctx, line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return ok('');
  if (tokens[0] === 'help' || tokens[0] === '?') return ok(HELP);
  if (tokens[0] !== 'kubectl' && tokens[0] !== 'k') {
    return fail(`${tokens[0]}: command not found (this prompt only runs kubectl; type "help")`);
  }
  const [, verb, ...rest] = tokens;
  const { flags, positional } = parse(rest);
  const t = ctx.ticks;

  switch (verb) {
    case 'get': {
      const { kind } = target(positional);
      if (kind === 'pods') return getPods(w, ctx, flags);
      if (kind === 'deploy') return getDeploys(w);
      if (kind === 'endpoints') return getEndpoints(w);
      if (kind === 'svc') return ok(table([['NAME', 'TYPE', 'CLUSTER-IP', 'PORT(S)', 'SELECTOR'], ['web-svc', 'ClusterIP', '10.96.0.12', '80/TCP', 'app=web']]));
      if (kind === 'nodes') return getNodes(w);
      return fail(`error: the server doesn't have a resource type "${positional[0] || ''}" (try: pods, deploy, endpoints, svc, nodes)`);
    }
    case 'describe': {
      const { kind, name } = target(positional);
      if (kind === 'pods') return name ? describePod(w, ctx, name) : fail('error: you must specify the name of a pod');
      if (kind === 'deploy') return describeDeploy(w, ctx, name || 'web');
      if (kind === 'nodes') return describeNodes(w);
      return fail('error: describe supports: pod <name>, deploy <name>, nodes');
    }
    case 'logs':
      return positional[0] ? logs(w, positional[0]) : fail('error: expected a pod name: kubectl logs <pod>');
    case 'scale': {
      const { kind, name } = target(positional);
      const d = kind === 'deploy' && findDeploy(w, name);
      if (!d) return fail(`Error from server (NotFound): deployments.apps "${name || ''}" not found`);
      const n = Number(flags.replicas);
      if (!Number.isInteger(n) || n < 0 || n > 9) return fail('error: --replicas must be a whole number from 0 to 9');
      return scaleDeploy(w, d, n, t) ? ok(`deployment.apps/${d.name} scaled`, { mutated: true }) : ok(`deployment.apps/${d.name} unchanged (already ${n} replicas)`);
    }
    case 'rollout': {
      const [sub, ...more] = positional;
      const { kind, name } = target(more);
      const d = kind === 'deploy' && findDeploy(w, name);
      if (!d) return fail(`Error from server (NotFound): deployments.apps "${name || ''}" not found`);
      if (sub === 'undo') {
        return undoRollout(w, d, t)
          ? ok(`deployment.apps/${d.name} rolled back`, { mutated: true })
          : fail(`error: no previous revision found for deployment "${d.name}"`);
      }
      if (sub === 'status') {
        const owned = w.pods.filter((p) => p.deploy === d.name && !p.terminating);
        const updated = owned.filter((p) => p.template.rev === d.template.rev);
        const ready = updated.filter((p) => p.phase === 'Running').length;
        if (ready >= d.replicas && owned.length === d.replicas) return ok(`deployment "${d.name}" successfully rolled out`);
        return ok(`Waiting for deployment "${d.name}" rollout to finish: ${ready} of ${d.replicas} updated replicas are available...`);
      }
      return fail('error: rollout supports: undo, status');
    }
    case 'set': {
      const [sub, ...more] = positional;
      const { kind, name } = target(more);
      const d = kind === 'deploy' && findDeploy(w, name);
      if (!d) return fail(`Error from server (NotFound): deployments.apps "${name || ''}" not found`);
      if (sub === 'image') {
        const pair = more.find((tok) => tok.includes('=') && !tok.includes('/'));
        if (!pair) return fail('error: expected container=image, e.g. web=web:1.0');
        const image = pair.slice(pair.indexOf('=') + 1);
        if (image === d.template.image) return ok(`deployment.apps/${d.name} image updated (no change)`);
        setTemplate(w, d, { image }, t);
        return ok(`deployment.apps/${d.name} image updated`, { mutated: true });
      }
      if (sub === 'resources') {
        const fields = {};
        for (const [flag, key] of [['requests', 'request'], ['limits', 'limit']]) {
          if (flags[flag] === undefined) continue;
          const m = /^memory=(.+)$/.exec(String(flags[flag]));
          const mi = m && parseMi(m[1]);
          if (!mi) return fail(`error: --${flag} must look like memory=300Mi`);
          fields[key] = mi;
        }
        if (!Object.keys(fields).length) return fail('error: pass --requests=memory=<n>Mi and/or --limits=memory=<n>Mi');
        const res = editTemplate(w, d, fields, t);
        if (res.error) return fail(`The Deployment "${d.name}" is invalid: ${res.error}`);
        return res.changed ? ok(`deployment.apps/${d.name} resource requirements updated`, { mutated: true }) : ok(`deployment.apps/${d.name} resource requirements updated (no change)`);
      }
      return fail('error: set supports: image, resources');
    }
    case 'edit': {
      const { kind, name } = target(positional);
      if (kind !== 'deploy' || !findDeploy(w, name)) return fail(`Error from server (NotFound): deployments.apps "${name || ''}" not found`);
      return ok(`Editing deployment.apps/${name}: change the fields in the form below, then Apply.`, { edit: name });
    }
    case 'delete': {
      const { kind, name } = target(positional);
      if (kind !== 'pods') return fail('error: delete supports: pod <name>');
      const p = name && findPod(w, name);
      if (!p) return fail(`Error from server (NotFound): pods "${name || ''}" not found`);
      deletePod(w, p, t);
      return ok(`pod "${p.name}" deleted`, { mutated: true });
    }
    default:
      return fail(`error: unknown command "${verb || ''}" for "kubectl" (type "help")`);
  }
}
