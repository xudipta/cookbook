// Story mode, Linux: "The Night Superintendent".
//
// The server is a building and you are the night superintendent: the disk is the storeroom, the load is the
// lift, services are the doors, permissions are the keys. The story runs on the practice game's real
// simulated shell (docs/games/linux/sim.js): every card runs a real command and the box shows what the
// server printed. Each chapter is a plain async script over it (see ../shared/story.js).
import { h, createCounters, outputBox, mountStory as mount, practiceLinks, siteUrl } from '../shared/story.js';
import { createWorld, run, start, status, tick } from '../../games/linux/sim.js';

const HUB = siteUrl('docs/games/');
const NOTE = (name) => siteUrl(`topics/linux/notes/${name}/`);

const UNIT_WORD = { active: 'open', activating: 'restarting', failed: 'broken', inactive: 'closed' };

const box = (text) => outputBox(text);

// The building: the pager, the storeroom (disk), the lift (load) and a door for every service.
function createBuilding(app, { data }) {
  const pager = h('ol', { class: 'nl-pager', 'aria-label': 'Pager messages', hidden: true });
  const tiles = h('div', { class: 'nl-tiles', role: 'list', 'aria-label': 'The building', hidden: true });
  const counters = createCounters([{ label: 'Service health', cls: 'ks-hud-ok' }]);
  app.caption.before(pager, tiles, counters.el);

  const A = { world: null, sc: null, level: null };
  const ctx = { ticks: 0, fire() {}, resolve() {}, log() {}, step() {}, rng: () => 0.5, scenario: null };
  ctx.step = () => {
    ctx.ticks += 1;
    tick(A.world, ctx);
  };

  const tile = (label, value, level) =>
    h('span', { class: 'nl-tile', role: 'listitem', 'data-level': level }, h('span', { class: 'nl-tile-label', text: label }), h('strong', { text: value }));

  function paint() {
    const w = A.world;
    if (!w) return;
    const s = status(w);
    const disk = s.diskPct >= 100 ? 'bad' : s.diskPct >= 90 ? 'warn' : 'ok';
    const load = s.load >= w.cores * 2 ? 'bad' : s.load >= w.cores ? 'warn' : 'ok';
    tiles.hidden = false;
    tiles.replaceChildren(
      tile('Storeroom (disk)', `${s.diskPct}% full`, disk),
      tile('Lift (load)', s.load < 1 ? 'quiet' : s.load.toFixed(1), load),
      ...s.units.map((u) => tile(`Door: ${u.name}`, UNIT_WORD[u.active] || u.active, u.active === 'active' ? 'ok' : 'bad')),
    );
    pager.hidden = !w.pager.length;
    pager.replaceChildren(
      ...[...w.pager].reverse().slice(0, 3).map((p) =>
        h('li', { class: 'nl-page', 'data-state': p.state }, h('span', { class: 'nl-page-state', text: p.state === 'open' ? 'Paging' : 'Cleared' }), h('span', { text: p.text })),
      ),
    );
    counters.el.hidden = false;
    counters.values[0].textContent = `${Math.round(w.health)}%`;
  }

  Object.assign(A, {
    // Start a chapter from one of the game's levels.
    load(levelId) {
      const level = data.levels.find((l) => l.id === levelId);
      const { levels: _levels, ...rest } = data;
      A.sc = { ...rest, ...level };
      ctx.scenario = A.sc;
      ctx.ticks = 0;
      A.world = createWorld(A.sc);
      start(A.world, ctx);
      paint();
    },
    // One command, run on the simulated server. A command that changes something costs a minute.
    sh(cmd) {
      const w = A.world;
      const before = w.term.length;
      const result = run(w, ctx, cmd);
      const out = w.term.slice(before).map((l) => l.text).join('\n');
      if (result === true) ctx.step();
      paint();
      return out;
    },
    wait() {
      ctx.step();
      paint();
    },
    health() {
      return Math.round(A.world.health);
    },
    caption(text) {
      app.caption.textContent = text || '';
    },
    reset() {
      A.world = null;
      A.sc = null;
      pager.hidden = true;
      pager.replaceChildren();
      tiles.hidden = true;
      tiles.replaceChildren();
      counters.el.hidden = true;
      app.caption.textContent = '';
    },
    stop() {},
  });
  return A;
}

// One decision: the learner picks what to check or change. The right card runs the real command and shows
// what the server printed; a wrong card is explained and the question is asked again.
async function decide(ui, A, ask, options, after) {
  for (;;) {
    const picked = await ui.choose('mo', ask, options.map((o) => ({ label: o.label, value: o.label })));
    const opt = options.find((o) => o.label === picked);
    if (opt.right) {
      const out = A.sh(opt.cmd);
      await ui.say('mo', after, 'Next', box(out));
      return out;
    }
    await ui.say('mo', opt.why, 'Try again');
  }
}

// A look that is not a decision: one button, then the real output.
async function look(ui, A, text, button, cmd, after) {
  await ui.say('mo', text, button);
  const out = A.sh(cmd);
  await ui.say('mo', after, 'Next', box(out));
  return out;
}

function makeChapters() {
  return [
    {
      title: 'First night',
      hook: 'Your first night as the superintendent of a building with one server. The pager goes off three times.',
      learn: 'look before you change: keys, the lift and the storeroom.',
      async play({ ui, sim: A }) {
        A.load('first-night');
        A.caption('The pager lists what is wrong. Service health drops while a problem stays open.');
        await ui.say('mo', 'Welcome to the night shift. The building is a **server**. The pager tells you what is wrong, and the rule of the house is: **look first, change one thing, look again.**');
        await ui.say('mo', 'First page: the deploy crew says "**Permission denied**" on the deploy script. A script is a door, and running it needs a key.');
        await decide(ui, A, 'Where do you look first?', [
          { label: 'Look at the keys on that door', cmd: 'ls -l /opt/deploy', right: true },
          { label: 'Restart the whole building', why: 'A restart drops everyone and hides the cause. Look at the door first.' },
          { label: 'Delete the script and write it again', why: 'The script is fine. Something about who may use it is wrong. Look at the keys.' },
        ], 'That was **ls -l**. The left column is the keys: **-rw-r--r--** has an r (read) and a w (write) but **no x**. The x is the key that lets someone run it, and nobody has it.');
        await decide(ui, A, 'How do you fix it?', [
          { label: 'Cut the run-key for this one script', cmd: 'chmod +x /opt/deploy/deploy.sh', right: true },
          { label: 'Give everybody every key in the whole wing', why: 'That is chmod 777 on a folder: everyone could rewrite everything. Cut only the key you need.' },
        ], 'Done with **chmod +x**: the script now has its x. The first page cleared.');
        await ui.say('mo', 'Take a breath. A minute passes.', 'Wait a minute');
        A.wait();
        await ui.say('mo', 'Second page: the **lift** is stuck. The load average is 38 on a building with 4 lifts.', 'Next');
        await decide(ui, A, 'The lift is jammed. How do you find who is hogging it?', [
          { label: 'List the people working, busiest first', cmd: 'ps aux --sort=-%cpu | head -5', right: true },
          { label: 'Switch the lift off and on again', why: 'Rebooting would kick out everyone, and whoever is hogging it would start again. Find them first.' },
        ], 'That was **ps aux**. Sorted by CPU, the top line is the hog: a reports job using nearly 4 lifts at once.');
        await decide(ui, A, 'How do you stop it?', [
          { label: 'Cut its power at once', why: 'That is kill -9: no tidying up, and it can leave a lock file behind. Ask politely first.' },
          { label: 'Ask it politely to stop', cmd: 'kill 2291', right: true },
        ], 'That was **kill 2291**, a polite request (SIGTERM). It cleans up and leaves. Only if it ignores you do you cut its power.');
        await ui.say('mo', 'Another minute goes by.', 'Wait a minute');
        A.wait();
        await ui.say('mo', 'Third page: "**No space left on device**". The storeroom is full.', 'Next');
        await decide(ui, A, 'How full is it?', [
          { label: 'Ask each room how full it is', cmd: 'df -h', right: true },
          { label: 'Throw things out until it feels better', why: 'That is guessing. Measure first, so you throw out the right thing.' },
        ], 'That was **df -h**. The root of the disk is **100%** used. Now: which shelf is the biggest?');
        await look(ui, A, 'Weigh each shelf in the log room.', 'Weigh the shelves', 'du -sh /var/log/*', 'That was **du -sh**. One log is huge, and the app that writes it is still running.');
        await decide(ui, A, 'What do you do with the giant log?', [
          { label: 'Throw the log away', why: 'The app still holds it open, so the space is not even freed, and the app has nowhere to write. Empty it instead.' },
          { label: 'Empty the log but keep the file', cmd: 'truncate -s 0 /var/log/app/app.log', right: true },
        ], 'That was **truncate -s 0**: the file stays, the app keeps writing to it, and the space comes back.');
        await ui.say('mo', 'Watch the building for a few minutes to be sure it stays quiet.', 'Wait it out');
        for (let i = 0; i < 3; i++) A.wait();
        await ui.say('mo', `All three pages are cleared and service health is **${A.health()}%**. You looked, changed one thing, and looked again.`, 'Next');
        await ui.card({
          maps: [['A key on the door', 'file permission (x bit)'], ['Who is using the lift', 'ps aux --sort=-%cpu'], ['Ask politely first', 'kill PID, then kill -9'], ['The storeroom is full', 'df -h, du -sh'], ['Empty, do not throw away', 'truncate -s 0']],
          plain: 'Read before you change. **ls -l** shows the keys, **ps** names the hog, **df** and **du** find a full disk, and a log that a program holds open is **truncated**, not deleted.',
          cmd: 'ls -l /opt/deploy\nchmod +x /opt/deploy/deploy.sh\nps aux --sort=-%cpu | head -5\nkill <pid>\ndf -h && du -sh /var/log/*\ntruncate -s 0 /var/log/app/app.log',
        });
      },
    },
    {
      title: 'The front desk',
      hook: 'Customers cannot get in: a service keeps restarting, errors flood in and a door nobody can reach.',
      learn: 'reading logs and sockets: is it running, who is knocking, who is listening.',
      async play({ ui, sim: A }) {
        A.load('web-tier');
        A.caption('Services are doors. Open, restarting or closed.');
        await ui.say('mo', 'Morning at the **front desk**. The page says the web door is down. Every service in the building is a door, and this one keeps swinging open and shut.');
        await decide(ui, A, 'Where do you start?', [
          { label: 'Ask the door how it is doing', cmd: 'systemctl status web', right: true },
          { label: 'Reboot the building', why: 'Everyone else loses their work, and the door would break again. Ask the door first.' },
        ], 'That was **systemctl status**. "activating (auto-restart)" means it starts, fails and starts again. The restart counter says it has done that 30 times.');
        await decide(ui, A, 'The door will not say why. Where is the reason written?', [
          { label: 'Keep restarting it until it works', why: 'It has restarted itself 30 times already. The answer is in its diary.' },
          { label: 'Read its diary', cmd: 'journalctl -u web -n 5', right: true },
        ], 'That was **journalctl -u web**, the service\'s own log: "cannot open config /opt/web/conf.yml: no such file". It is looking for its settings in the wrong place.');
        await look(ui, A, 'Is the file somewhere else?', 'Look in both rooms', 'ls /etc/web /opt/web', 'The settings file is in **/etc/web**, not **/opt/web**. The door\'s service file points at the wrong room.');
        await decide(ui, A, 'How do you fix it?', [
          { label: 'Just restart it again, harder', why: 'It would look in the same wrong place. The service file itself has to change, and systemd must re-read it.' },
          { label: 'Point it at the right room, reload and restart', cmd: "sed -i 's#/opt/web/conf.yml#/etc/web/conf.yml#' /etc/systemd/system/web.service && systemctl daemon-reload && systemctl restart web", right: true },
        ], 'Changed one line in the unit file, then **daemon-reload** (so systemd reads it) and **restart**. Now look again.');
        await look(ui, A, 'Look again: never trust a fix you have not checked.', 'Look at the door', 'systemctl status web', '"active (running)": the web door is open. Next page.');
        await ui.say('mo', 'Time passes.', 'Wait a minute');
        A.wait();
        await ui.say('mo', 'Page: customers see **500 errors**. Someone is hammering the site. The log of every visitor is in the access log.', 'Next');
        await look(ui, A, 'Count the visitors, busiest first.', 'Count visitors', "awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -3", 'The busiest visitor is **10.0.0.5**, with 32 requests. Tempting to block them. But busy is not the same as guilty.');
        await decide(ui, A, 'What next?', [
          { label: 'Block the busiest visitor', why: 'You have not checked that they cause the errors. A busy visitor can be a good one. Count the errors, not the visits.' },
          { label: 'Count who is behind the error lines', cmd: "grep 500 /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -3", right: true },
        ], 'Different answer: **10.0.3.17** caused almost all the 500s. The busy visitor was fine.');
        await decide(ui, A, 'How do you stop that one visitor?', [
          { label: 'Shut the front door for everyone', why: 'That takes the whole shop down to stop one visitor. Block only the guilty address.' },
          { label: 'Add one line to the block list and reload', cmd: "echo 'deny 10.0.3.17;' >> /etc/nginx/conf.d/blocklist.conf && systemctl reload nginx", right: true },
        ], 'One **deny** line and a **reload** (not a restart): nginx re-reads its settings without dropping the other customers.');
        await ui.say('mo', 'Later...', 'Wait a minute');
        A.wait();
        await ui.say('mo', 'Page: the load balancer cannot reach the **api on port 8080**: connection refused. Who is listening on which door?', 'Next');
        await decide(ui, A, 'How do you check which doors are open?', [
          { label: 'Restart nginx', why: 'nginx is not the problem; the api is. First see what is actually listening.' },
          { label: 'List every listening door', cmd: 'ss -tlnp', right: true },
        ], 'That was **ss -tlnp**. Nothing is on **8080**. The api listens on **127.0.0.1:18080**: a door that opens only inside the building, on the wrong number.');
        await look(ui, A, 'Knock on 8080 to see it fail.', 'Knock', 'curl -I 10.0.2.15:8080', 'That was **curl -I**: "Failed to connect". It matches what the load balancer sees.');
        await look(ui, A, 'Read the api\'s settings.', 'Read the settings', 'cat /etc/api/api.conf', '**bind = 127.0.0.1** means inside only, and **port = 18080** is the wrong number.');
        await decide(ui, A, 'Which fix is right?', [
          { label: 'Open the firewall for 18080', why: 'The door is bolted from the inside (127.0.0.1) and the number is wrong. A firewall rule changes neither.' },
          { label: 'Bind to all addresses on port 8080 and restart', cmd: "sed -i 's/127.0.0.1/0.0.0.0/;s/18080/8080/' /etc/api/api.conf && systemctl restart api", right: true },
        ], 'Changed the bind address and port, then **restart**. Now knock again.');
        await look(ui, A, 'Check that it answers.', 'Knock again', 'curl -I 10.0.2.15:8080', '**200 OK**. Fixed, and verified.');
        await ui.say('mo', 'Stay a few minutes to make sure the problems stay gone.', 'Wait it out');
        for (let i = 0; i < 3; i++) A.wait();
        await ui.say('mo', `Quiet front desk and service health **${A.health()}%**. Status, logs, then sockets, then the one change that fixes it.`, 'Next');
        await ui.card({
          maps: [['Is the door open?', 'systemctl status NAME'], ['The door\'s diary', 'journalctl -u NAME -n 50'], ['Who is knocking the most errors', 'grep 500 | awk | sort | uniq -c'], ['Who is listening on which door', 'ss -tlnp'], ['Knock on a door', 'curl -I host:port']],
          plain: 'Follow the order: **status**, **logs**, **resources**, **network**. After editing a unit file run **daemon-reload**, then restart, then check again.',
          cmd: 'systemctl status web\njournalctl -u web -n 20\nss -tlnp\nawk \'{print $1}\' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head\nsystemctl daemon-reload && systemctl restart web\ncurl -I localhost:8080',
        });
      },
    },
    {
      title: 'Bad Friday',
      hook: 'Four problems at once, and one of them is silent. Decide what matters first, and what not to delete.',
      learn: 'triage, scripts that lie, stubborn processes and what is safe to delete.',
      async play({ ui, sim: A }) {
        A.load('bad-friday');
        A.caption('Several pages can be open at once. Triage: fix what hurts customers first.');
        await ui.say('mo', 'It is Friday night and the building is busy. First page is a **quiet** one: the nightly backups are only **45 bytes**, but the job says it worked. A backup that lies is the worst kind.');
        await look(ui, A, 'What does the schedule run?', 'Read the schedule', 'cat /etc/cron.d/backup', 'It copies **/srv/dta** into /backups. Look closely: "**dta**". That should be "data".');
        await look(ui, A, 'Why did the job say "ok" with nothing to copy?', 'Read the script', 'cat /opt/scripts/backup.sh', 'The script prints "backup ok" no matter what happened. It has no **set -e**, so a failed tar does not stop it.');
        await decide(ui, A, 'How do you fix it for good?', [
          { label: 'Delete the 45-byte backups', why: 'That hides the evidence but fixes nothing. Fix the typo and make the script stop on errors.' },
          { label: 'Fix the typo and make the script fail loudly', cmd: "sed -i '2i set -euo pipefail' /opt/scripts/backup.sh && sed -i 's#/srv/dta#/srv/data#' /etc/cron.d/backup", right: true },
        ], 'Added **set -euo pipefail** (stop on any error) and fixed the typo. Never trust a fix you have not run.');
        await decide(ui, A, 'How do you prove it works?', [
          { label: 'Wait for tomorrow night', why: 'Then you only learn tomorrow, and the data is unprotected in between. Run it now.' },
          { label: 'Run it once now and check the exit code', cmd: '/opt/scripts/backup.sh /srv/data /backups; echo $?', right: true },
        ], 'Exit code **0** means success this time. Check the size of the new archive.');
        await look(ui, A, 'Look at what it made.', 'Look at /backups', 'ls -l /backups', 'A real backup, over a gigabyte, next to two useless ones of 45 bytes.');
        await ui.say('mo', 'Page: the **lift** is stuck again. A java export job is using a whole lift.', 'Next');
        await look(ui, A, 'Find the hog.', 'List the busy ones', 'ps aux --sort=-%cpu | head -4', 'PID **3310**, at 99% for over an hour.');
        await decide(ui, A, 'First try:', [
          { label: 'Cut its power at once', why: 'Start polite. SIGTERM gives it a chance to tidy up, and you only escalate if it ignores you.' },
          { label: 'Ask it politely to stop', cmd: 'kill 3310', right: true },
        ], 'You asked politely. Look: is it still there?');
        await look(ui, A, 'Check again.', 'List the busy ones', 'ps aux --sort=-%cpu | head -4', 'Still running at 99%. It ignored the polite request. **Now** it is fair to cut its power.');
        await decide(ui, A, 'It ignored you. Now what?', [
          { label: 'Restart the whole building', why: 'There is one bad process, not a bad building. Target only that process.' },
          { label: 'Now cut its power: it ignored the polite request', cmd: 'kill -9 3310', right: true },
        ], '**kill -9** (SIGKILL) cannot be ignored. It is the last resort, after the polite kill failed.');
        await ui.say('mo', 'Another page: the **worker** door is not opening. Customers\' jobs are piling up.', 'Next');
        await look(ui, A, 'Ask the door.', 'Ask the door', 'journalctl -u worker -n 4', '"**cannot write to /var/lib/worker: permission denied**". The worker cannot write in its own room.');
        await look(ui, A, 'Who owns that room?', 'Check the owner', 'ls -ld /var/lib/worker', 'The room belongs to **root**. The worker is not allowed in.');
        await decide(ui, A, 'How do you fix it?', [
          { label: 'Give everybody every key (chmod 777)', why: 'Everyone could then read and change the worker\'s data. Make its owner the worker instead.' },
          { label: 'Make the worker the owner', cmd: 'chown worker:worker /var/lib/worker', right: true },
        ], '**chown** gives the room to the worker, and only the worker.');
        await ui.say('mo', 'The building is not done yet: the **storeroom is 100% full** and writes are failing.', 'Next');
        await look(ui, A, 'How full is it?', 'Ask each room', 'df -h', 'Full. Now find what is taking the space. Not by guessing.');
        await look(ui, A, 'Find files over 1 GB that are older than two days.', 'Search', 'find / -type f -size +1G -mtime +2', 'One match: an old temporary export. Big, old and temporary: a likely thing to delete.');
        await decide(ui, A, 'Which file do you delete?', [
          { label: 'The biggest backup', why: 'That is the only good backup you have. The biggest file is not always the right one to delete.' },
          { label: 'The old temporary export', cmd: 'rm /var/tmp/export-20261020.tmp', right: true },
        ], 'You deleted the stale **temp** file, and kept the data.');
        await ui.say('mo', 'Watch the building until the shift ends.', 'Wait it out');
        for (let i = 0; i < 4; i++) A.wait();
        await ui.say('mo', `Shift over. Backups work, the lift is free, the worker is running and there is space. Service health is **${A.health()}%**.`, 'Next');
        await ui.card({
          maps: [['A backup that lies', 'set -euo pipefail'], ['Ask politely, then insist', 'kill PID, then kill -9 PID'], ['Whose room is it?', 'ls -ld, chown user:group'], ['Find what is eating the disk', 'find / -type f -size +1G'], ['Delete the temp file, not the data', 'rm /var/tmp/...']],
          plain: 'Make scripts **fail loudly**, try **kill** before **kill -9**, check **ownership** with ls -ld, and delete the **stale temp file**, never the data.',
          cmd: 'sed -i \'2i set -euo pipefail\' /opt/scripts/backup.sh\nkill <pid>; sleep 2; kill -9 <pid>\nchown worker:worker /var/lib/worker\nfind / -type f -size +1G -mtime +2',
        });
      },
    },
  ];
}

export async function mountStory(host) {
  const res = await fetch(new URL('../../games/linux/scenarios.json', import.meta.url));
  if (!res.ok) throw new Error(`scenarios.json: HTTP ${res.status}`);
  const data = await res.json();
  mount(host, {
    id: 'linux',
    title: 'The Night Superintendent',
    stageLabel: 'The building',
    exitHref: HUB,
    exitLabel: 'Back to the games',
    characters: {
      mo: { name: 'Mo', role: 'Night superintendent', color: '#7a3fa8' },
    },
    chapters: makeChapters(),
    createStage: (app) => createBuilding(app, { data }),
    startLabel: 'Start the shift',
    nextChapterLabel: 'Start the chapter',
    cardKicker: 'Now in real Linux',
    endKicker: 'Shift complete',
    endTitle: 'You just ran a night shift on a server',
    endIntro: 'Every building word you used has a real command behind it. Here is your notebook.',
    endLinks: [
      { text: 'Read: Shell fundamentals', href: NOTE('01-shell-fundamentals') },
      { text: 'Read: systemd and networking', href: NOTE('03-systemd-and-networking') },
      ...practiceLinks('linux', [['first-night', 'First night'], ['web-tier', 'The web tier'], ['bad-friday', 'Bad Friday']]),
    ],
  });
}
