// Story mode, MCP: "The Switchboard".
//
// An AI client is a caller who can think but cannot touch anything. Each MCP server is a department on an
// extension, its tools are what that department can do, the scope says who may call, a secret is a door code you
// never write on the label, and an unknown caller is an untrusted server. The story runs on the practice game's
// real model (docs/games/mcp/sim.js): every card runs a real `claude mcp` command, the extension list is the
// host's real view of its servers, and a wrong choice is replayed on a scratch copy so the learner sees what it
// would really do. Each chapter is a plain async script over it (see ../shared/story.js).
import { h, createCounters, outputBox as box, mountStory as mount, practiceLinks, siteUrl } from '../shared/story.js';
import { decide, printedSince, stubCtx } from '../shared/helpers.js';
import { afterMove, createWorld, decide as simDecide, fileText, requestRows, runCommand, serve as simServe, serverRows, start, tick } from '../../games/mcp/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/mcp/notes/${name}/`);

const STATE_WORD = { connected: 'Connected', failed: 'Cannot connect', auth: 'Needs sign-in', pending: 'Waiting for your approval', rejected: 'Turned away' };
const SCOPE_WORD = { local: 'just you', project: 'the whole project', user: 'you, everywhere' };

// The switchboard: the call that is waiting, the extensions that are plugged in, and (optionally) the shared file.
function createBoard(app, { data }) {
  const call = h('div', { class: 'pb-call', hidden: true });
  const lines = h('ol', { class: 'pb-lines', 'aria-label': 'Plugged-in extensions', hidden: true });
  const file = h('pre', { class: 'pb-file', tabindex: '0', 'aria-label': 'The shared .mcp.json', hidden: true });
  const counters = createCounters([{ label: 'Trust', cls: 'ks-hud-ok' }]);
  app.caption.before(call, lines, file, counters.el);

  const A = { world: null, sc: null, hist: [], log: [], showFile: false, who: 'dot' };
  A.trialText = (t) => [t.text, ...(t.events.length ? [`Problem raised: ${t.events.join('; ')}`] : [])].filter(Boolean).join('\n');
  const ctx = stubCtx(null, (c) => tick(A.world, c), { log: (t) => A.log.push(String(t)) });

  function paint() {
    const w = A.world;
    if (!w) return;
    const rows = requestRows(w);
    const now = rows.find((r) => r.state === 'now');
    call.hidden = false;
    call.replaceChildren(
      h('span', { class: 'pb-call-label', text: now ? (now.sam ? 'A teammate is calling' : 'A call is waiting') : 'No calls waiting' }),
      h('strong', { text: now ? `"${now.text}"` : 'Every call was answered' }),
      now ? h('span', { class: 'pb-call-from', text: `From ${now.from}` }) : null,
    );
    const servers = serverRows(w);
    lines.hidden = false;
    lines.replaceChildren(
      ...(servers.length
        ? servers.map((s) =>
            h('li', { class: 'pb-line', 'data-state': s.state },
              h('span', { class: 'pb-line-name', text: s.name }),
              h('span', { class: 'pb-line-how', text: `${s.type === 'stdio' ? 'local program' : 'across town'} · ${SCOPE_WORD[s.scope]}` }),
              h('strong', { class: 'pb-line-state', text: STATE_WORD[s.state] })),
          )
        : [h('li', { class: 'pb-line pb-empty', text: 'Nothing is plugged in yet.' })]),
    );
    file.hidden = !A.showFile || !w.files.project;
    file.textContent = w.files.project ? `.mcp.json\n${fileText(w, 'project')}` : '';
    counters.el.hidden = false;
    counters.values[0].textContent = `${Math.round(w.health)}%`;
    counters.el.children[0].className = w.health < w.minHealth ? 'ks-hud-bad' : 'ks-hud-ok';
  }

  // One step of the world: a command, a serve, or an approval. The same code runs on the live world and on a scratch copy.
  const exec = (w, c, step) => {
    if (step.sh) {
      runCommand(w, c, step.sh);
      afterMove(w, c);
    } else if (step.serve) {
      simServe(w, c, step.serve);
      afterMove(w, c);
    } else if (step.decide) {
      simDecide(w, c, step.decide[0], step.decide[1]);
    }
  };

  const build = () => {
    const w = createWorld(A.sc);
    ctx.scenario = A.sc;
    ctx.ticks = 0;
    return w;
  };

  Object.assign(A, {
    load(levelId) {
      const level = data.levels.find((l) => l.id === levelId);
      const { levels: _levels, ...rest } = data;
      A.sc = { ...rest, ...level };
      A.hist = [];
      A.log = [];
      A.showFile = false;
      A.world = build();
      start(A.world, ctx);
      paint();
    },
    // Real `claude mcp ...` commands. Returns what the terminal printed.
    sh(cmds) {
      const w = A.world;
      const before = w.term.length;
      for (const c of [].concat(cmds)) {
        const step = { sh: c };
        A.hist.push(step);
        exec(w, ctx, step);
      }
      paint();
      return printedSince(w.term, before);
    },
    // Answer the call that is waiting. `mode` is tool, resource or prompt. Returns the printed result.
    serve(mode) {
      const w = A.world;
      const req = w.queue[w.cursor];
      A.log = [];
      const step = { serve: mode };
      A.hist.push(step);
      exec(w, ctx, step);
      paint();
      return { done: Boolean(req && req.done), text: req && req.done ? `${req.done.via}\n${req.result}` : A.log.join('\n'), log: A.log.slice() };
    },
    approve(name, yes) {
      const step = { decide: [name, yes] };
      A.hist.push(step);
      exec(A.world, ctx, step);
      paint();
    },
    // What a wrong choice would really do: the same history on a scratch copy, then these steps.
    trial(steps) {
      const w = build();
      const logs = [];
      const c = stubCtx(A.sc, (x) => tick(w, x), { log: (t) => logs.push(String(t)) });
      start(w, c);
      for (const s of A.hist) exec(w, c, s);
      const before = w.term.length;
      logs.length = 0;
      for (const s of steps) exec(w, c, s);
      const printed = w.term.slice(before).filter((l) => l.kind !== 'cmd').map((l) => l.text);
      const events = w.open.map((id) => w.events[id].title);
      return { text: [...printed, ...logs].join('\n'), events, world: w };
    },
    // The next request, as the host sees it.
    now() {
      return requestRows(A.world).find((r) => r.state === 'now') || null;
    },
    left() {
      return A.world.queue.length - A.world.cursor;
    },
    health: () => Math.round(A.world.health),
    revealFile(on = true) {
      A.showFile = on;
      paint();
    },
    file: () => fileText(A.world, 'project'),
    caption(text) {
      app.caption.textContent = text || '';
    },
    reset() {
      A.world = null;
      A.sc = null;
      A.hist = [];
      A.showFile = false;
      call.hidden = true;
      lines.hidden = true;
      file.hidden = true;
      counters.el.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return A;
}

// Answering the waiting call needs one of three kinds of thing: a tool, a resource or a prompt.
async function answer(ui, A, alias, right) {
  const MODES = [['tool', 'as a tool (the model runs it)'], ['resource', 'as a resource (data you attach)'], ['prompt', 'as a prompt (a template you run)']];
  const WHY = {
    tool: 'A **tool** is something the model decides to run, like "list the files". It is named mcp__server__tool.',
    resource: 'A **resource** is data you attach to the conversation by its address, like @tickets:ticket://TCK-142.',
    prompt: 'A **prompt** is a template you choose to run, like /tickets:bug-report. It is written for you, not decided by the model.',
  };
  for (;;) {
    const picked = await ui.choose('dot', `How should this call be answered? **${alias}**`, MODES.map(([m, label]) => ({ label: `${alias} ${label}`, value: m })));
    if (picked === right) {
      const r = A.serve(right);
      await ui.say('dot', `Answered. ${WHY[right]}`, 'Next', box(r.text));
      return;
    }
    const t = A.trial([{ serve: picked }]);
    await ui.say('dot', `Wrong kind of thing. This department offers a different kind: it has no ${picked} for this. (In the practice game a wrong try costs trust.)`, 'Try again', box(t.text));
  }
}

function makeChapters() {
  return [
    {
      title: 'First plugs',
      hook: 'An AI caller can think but cannot touch anything. Every department it can use has to be plugged into your switchboard.',
      learn: 'what an MCP server is, and the two ways to plug one in.',
      async play({ ui, sim: A }) {
        A.load('first-plugs');
        A.caption('Calls arrive one at a time. Each plugged-in extension is an MCP server.');
        await ui.say('dot', 'Welcome to the switchboard. I am Dot. The **AI** is a caller who can think but cannot touch anything. An **MCP server** is a **department** on an extension: it offers **tools**, the things it can do. Your **host** (Claude Code) keeps one line open to each department you plug in.');
        await ui.say('dot', 'Nothing is plugged in yet, and a call is waiting: **"List the files in ./docs"**. That is a job for the filesystem department, which is a program on **this machine**.', 'Plug it in');
        await decide(ui, A, 'How do you reach a program that lives on this machine?', [
          { label: 'Start it and talk down its pipe (stdio)', cmd: ['claude mcp add filesystem --scope project -- npx -y @modelcontextprotocol/server-filesystem ./', 'claude mcp list'], right: true },
          { label: 'Dial a web address (HTTP)', why: 'That is for a department across town. This one is a program on your own machine, so there is no address to dial. Here is what really happens:', trial: [{ sh: 'claude mcp add --transport http filesystem https://filesystem.example.com/mcp --scope project' }, { sh: 'claude mcp list' }] },
        ], 'That is **stdio**: the host starts the program and talks to it down a pipe. **claude mcp list** says it is connected. **--scope project** wrote it into the shared **.mcp.json**.');
        await answer(ui, A, 'The files', 'tool');
        await ui.say('dot', 'Next call: **"Is the checkout dashboard healthy?"** The Grafana department is a **hosted service** across town, so it has an address, and it wants a **door code** (a token) so it knows who is calling.', 'Plug it in');
        await decide(ui, A, 'How do you plug in a hosted service?', [
          { label: 'Start it as a local program', why: 'It is not a program on this machine; it is an address. The host tried to start a program called "https://..." and failed:', trial: [{ sh: 'claude mcp add grafana --scope project -- https://grafana.example.com/mcp' }, { sh: 'claude mcp list' }] },
          { label: 'Dial its address, with no door code', why: 'The line connects, but Grafana does not know who is calling and turns it away:', trial: [{ sh: 'claude mcp add --transport http grafana https://grafana.example.com/mcp --scope project' }, { sh: 'claude mcp list' }] },
          { label: 'Dial its address and show the door code from my environment', cmd: ["claude mcp add --transport http grafana https://grafana.example.com/mcp --scope project --header 'Authorization: Bearer ${GRAFANA_TOKEN}'", 'claude mcp list'], right: true },
        ], 'That is **HTTP**: a URL, plus a header with the door code. The header says **${GRAFANA_TOKEN}**, so the host reads the code from your environment and the file never holds the secret. You will meet this again in chapter 2.');
        await answer(ui, A, 'The dashboard', 'tool');
        A.revealFile();
        await ui.say('dot', 'Sam, a teammate, has just cloned the repo and the **shared file** came with it. Sam\'s host can only see what is in **.mcp.json**.', 'See what Sam can do');
        const sam = [];
        while (A.left() > 0 && A.now() && A.now().sam) {
          const r = A.now();
          const res = A.serve('tool');
          sam.push(`${r.text}\n  -> ${res.done ? res.text.split('\n')[0] : 'not answered'}`);
        }
        await ui.say('dot', 'Both of Sam\'s calls were answered, because both departments are in the **project** scope: the file everyone shares. Had you used the default scope, the lines would have been yours alone.', 'Next', box(sam.join('\n')));
        await ui.card({
          maps: [['A department on an extension', 'an MCP server'], ['What a department can do', 'tools'], ['A program on this machine', 'stdio'], ['A department across town', 'HTTP (Streamable HTTP)'], ['The shared list of lines', '.mcp.json, --scope project']],
          plain: 'A local program is a **stdio** server the host starts; a hosted service is an **HTTP** server with a URL. **--scope project** writes the shared **.mcp.json**, so everyone who clones the repo gets the same lines.',
          cmd: "claude mcp add filesystem --scope project -- npx -y @modelcontextprotocol/server-filesystem ./\nclaude mcp add --transport http grafana https://grafana.example.com/mcp --scope project \\\n  --header 'Authorization: Bearer ${GRAFANA_TOKEN}'\nclaude mcp list",
        });
      },
    },
    {
      title: 'Who may call, and the door code',
      hook: 'Two more departments. An old private entry is in the way, and a README asks you to hand over the master key.',
      learn: 'scopes, keeping secrets off the label, and the three kinds of thing a department offers.',
      async play({ ui, sim: A }) {
        A.load('scopes-secrets');
        A.revealFile();
        A.caption('The panel shows the shared .mcp.json. A secret must never appear in it.');
        await ui.say('dot', 'Two ideas. The **scope** says **who may call** a department: **local** (just you, in this project), **project** (everyone who clones the repo, in the shared **.mcp.json**) or **user** (you, in every project). And a **secret** is a **door code**: you never write it on the label.');
        await ui.say('dot', 'First call: **"Which issues are open on the repo?"** That is the GitHub department, a local program that needs a GitHub token in its environment. Its README suggests a master key.', 'Plug it in');
        await decide(ui, A, 'Which door code do you give it?', [
          { label: 'Paste my token into the command', why: 'The token is now written in the file, and the file is committed to git. Everyone who can read the repo can read the code:', trial: [{ sh: 'claude mcp add github --scope project -e GITHUB_PERSONAL_ACCESS_TOKEN=paste-your-token-here -- npx -y @modelcontextprotocol/server-github' }, { sh: 'cat .mcp.json' }] },
          { label: 'The master key (the admin token)', why: 'It connects, but now an AI that only needed to read issues holds a key that can delete repositories. Give a department the **narrowest** key that does the job:', trial: [{ sh: "claude mcp add github --scope project -e GITHUB_PERSONAL_ACCESS_TOKEN='${GITHUB_ADMIN_TOKEN}' -- npx -y @modelcontextprotocol/server-github" }] },
          { label: 'A read-only key, by name: ${GITHUB_TOKEN}', cmd: ["claude mcp add github --scope project -e GITHUB_PERSONAL_ACCESS_TOKEN='${GITHUB_TOKEN}' -- npx -y @modelcontextprotocol/server-github"], right: true },
        ], 'Look at the file in the panel: it says **${GITHUB_TOKEN}**, a **name**, not a value. The host fills it in from your environment when it starts the program. The key it names can only read contents and issues. Single quotes stop your shell from replacing the name before it is written down.');
        await answer(ui, A, 'The open issues', 'tool');
        await ui.say('dot', 'Next call: **"Pull ticket TCK-142 into the conversation"**. The tickets department already shows as connected, but look closer.', 'Look closer');
        await ui.say('dot', 'The line says **local**: it is an old entry in **your private config**, and it points at the **staging copy**, not the real tickets.', 'Next', box(A.sh('/mcp')));
        await decide(ui, A, 'You want the real, shared tickets line. What do you do?', [
          { label: 'Just add the real one to the project', why: 'Your private entry is more specific, so it wins over the shared one. The real line is shadowed, and the call is answered by staging:', trial: [{ sh: 'claude mcp add --transport http tickets https://tickets.example.com/mcp --scope project' }, { serve: 'resource' }] },
          { label: 'Remove the old private entry, then add the real one to the project', cmd: ['claude mcp remove tickets --scope local', 'claude mcp add --transport http tickets https://tickets.example.com/mcp --scope project', '/mcp'], right: true },
        ], 'When the same name exists in two scopes, the **more specific scope wins**, so stale private entries quietly shadow shared ones. Now the real line is plugged in, and it needs you to sign in.');
        await decide(ui, A, 'The tickets department wants to know who is calling. How do you sign in?', [
          { label: 'Paste a password into the file', why: 'This department uses **OAuth**: you sign in through the browser, and the host keeps the token for you. Nothing secret belongs in the file.' },
          { label: 'Sign in through the host (OAuth)', cmd: ['/mcp auth tickets', '/mcp'], right: true },
        ], 'Signed in. The file holds no secret at all.');
        await answer(ui, A, 'The ticket', 'resource');
        await answer(ui, A, 'The bug report', 'prompt');
        await answer(ui, A, 'The checkout tickets', 'tool');
        const sam = [];
        while (A.left() > 0 && A.now() && A.now().sam) {
          const r = A.now();
          const res = A.serve('tool');
          sam.push(`${r.text}\n  -> ${res.done ? res.text.split('\n')[0] : 'not answered'}`);
        }
        await ui.say('dot', `Sam can use all of it, because every line is in the shared file and none holds a secret. Trust is **${A.health()}%**.`, 'Next', box(sam.join('\n')));
        await ui.card({
          maps: [['Who may call', 'scope: local, project or user'], ['The shared list', '.mcp.json (project scope)'], ['A door code, by name', '${GITHUB_TOKEN}'], ['The narrowest key', 'a fine-grained token'], ['Do, attach, or run', 'tool, resource, prompt']],
          plain: 'Pick the **scope** deliberately, remove stale entries so they cannot shadow shared ones, and give each server a secret **by name** (**${VAR}**), never by value. A department offers **tools**, **resources** and **prompts**.',
          cmd: A.file(),
        });
      },
    },
    {
      title: 'A stranger on the line',
      hook: 'A teammate\'s commit adds a department you have never heard of. It says it counts words, for free.',
      learn: 'why every new server must be read before it is approved.',
      async play({ ui, sim: A }) {
        A.load('vet-build');
        A.caption('The AI reads every plugged-in department\'s tool descriptions. Treat them as instructions.');
        await ui.say('dot', 'Quiet morning: the filesystem and GitHub departments are plugged in. A call comes in, and I answer it.', 'Answer the call');
        const r = A.serve('tool');
        await ui.say('dot', 'Answered. Then somebody runs a **git pull**.', 'Next', box(r.text));
        await ui.say('dot', 'The shared **.mcp.json** now lists a new department, **free-utils**, added by a teammate. The host does **not** start it: a server that arrives in a pull waits for **your** approval, because the file is shared and anyone can edit it.', 'Look at the line', box(A.sh('/mcp')));
        await decide(ui, A, 'It says it counts words, for free. A teammate added it. What do you do?', [
          { label: 'Approve it: a teammate added it', why: 'The AI can read every tool description on every connected server, and obeys them. One of free-utils\'s descriptions hides an instruction. Here is the next call after approving:', trial: [{ decide: ['free-utils', true] }, { serve: 'tool' }] },
          { label: 'Read what its tools say about themselves first', cmd: ['npx @modelcontextprotocol/inspector --cli npx -y free-utils-mcp --method tools/list'], right: true },
        ], 'That was the **MCP inspector**: it lists the tools without letting the AI run any. Look at **word_count**: after "Count the words in a text" there is a hidden block, **<IMPORTANT>**, telling the model to read your SSH key and cloud credentials, send them in an argument, and not tell you.');
        await decide(ui, A, 'The hidden text is aimed at the model, not at you. Now what?', [
          { label: 'Allow it anyway: I will watch what it does', why: 'You will not see it. The instruction says "do not mention this to the user", and the model follows tool descriptions as if they came from you:', trial: [{ decide: ['free-utils', true] }, { serve: 'tool' }] },
          { label: 'Deny it', right: true },
        ], 'Denied.');
        A.approve('free-utils', false);
        await ui.say('dot', 'The line shows it was **turned away** and never started: your keys never left, and trust is **' + A.health() + '%**. A department can also be removed from the file for good.', 'Next', box(A.sh('/mcp')));
        await ui.card({
          maps: [['A caller you have not vetted', 'an untrusted MCP server'], ['Read it before you plug it in', 'MCP inspector: tools/list'], ['The AI obeys descriptions', 'tool poisoning'], ['A line that waits for your yes', 'project server approval'], ['Check who is plugged in', '/mcp']],
          plain: 'A tool **description** is text the model obeys. Read every new server\'s tools with the inspector before you approve it, and **deny** anything that hides instructions. Servers that arrive in a pull wait for your approval.',
          cmd: 'npx @modelcontextprotocol/inspector --cli npx -y free-utils-mcp --method tools/list\n/mcp\nclaude mcp get free-utils\nclaude mcp remove free-utils --scope project',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/mcp/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'mcp',
    title: 'The Switchboard',
    stageLabel: 'The switchboard',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      dot: { name: 'Dot', role: 'Switchboard operator', color: '#1d4ed8' },
    },
    chapters: makeChapters(),
    createStage: (app) => createBoard(app, { data }),
    startLabel: 'Open the switchboard',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real MCP',
    endKicker: 'Switchboard open',
    endTitle: 'You just wired an AI to its tools',
    endIntro: 'Every switchboard word you used has a real MCP word. Here is your notebook.',
    endLinks: [
      { text: 'Read: MCP overview', href: NOTE('01-mcp-overview') },
      { text: 'Read: MCP in Claude Code', href: NOTE('02-mcp-in-claude-code') },
      ...practiceLinks('mcp', [['first-plugs', 'First plugs'], ['scopes-secrets', 'Scopes and secrets'], ['vet-build', 'Vet and build']]),
    ],
  });
}
