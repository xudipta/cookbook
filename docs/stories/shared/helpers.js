// Helpers the stories share, so a fix to how a question is asked reaches every story (they used to be copied into
// each story.js and drifted). Like the rest of docs/stories/shared/, this file is topic-free: scripts/story_check.cjs
// fails if a topic word appears here. A story supplies what is topic-specific (its simulator, its words) through
// the `A` object it already builds (`A.sh`, `A.trial`, `A.who`, `A.trialText`) and through its options.
import { outputBox } from './story.js';

// A small seeded random number generator (mulberry32), for a simulator that wants a reproducible "random".
export const seededRng = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The stand-in for the games' engine context that a story passes to a simulator. `onTick(ctx)` is what one step of
// the clock does (omit it for a simulator the story ticks by hand); `log` receives what the simulator logs.
export function stubCtx(scenario, onTick = null, { log = () => {}, rng = () => 0.5 } = {}) {
  const ctx = { ticks: 0, fire() {}, resolve() {}, log, rng, scenario, step() {} };
  if (onTick) {
    ctx.step = () => {
      ctx.ticks += 1;
      onTick(ctx);
    };
  }
  return ctx;
}

// What a terminal printed since line `from` (the terminal is a list of { text } lines).
export const printedSince = (term, from) => term.slice(from).map((l) => l.text).join('\n');

// The question loop every story uses: ask, and keep asking until the learner picks a right option.
// `key(option)` is the value a button reports (the label by default); `right(option, value)` runs when the pick is
// right and its result is returned; `wrong(option)` runs for a wrong pick, and then the question is asked again.
export async function askUntilRight(ui, who, ask, options, { key = (o) => o.label, right, wrong }) {
  for (;;) {
    const picked = await ui.choose(who, ask, options.map((o) => ({ label: o.label, value: key(o) })));
    const opt = options.find((o) => key(o) === picked);
    if (opt.right) return right(opt, picked);
    await wrong(opt);
  }
}

const text = (value, arg) => (typeof value === 'function' ? value(arg) : value);

// What the right option does: `run()`, or a command (`cmd`, a string, a list or a function) sent to `A.sh`.
const runRight = (A, opt) => {
  if (opt.run) return opt.run();
  if (typeof opt.cmd === 'function') return opt.cmd();
  return opt.cmd != null ? A.sh(opt.cmd) : '';
};

// One decision. The learner picks what to check or change. The right option runs for real and its output is shown
// (`after` is the text under it, or a function of the output); a wrong option is explained (`why`, or a function of
// the trial) and the question is asked again. A wrong option may carry a `trial`: the story's `A.trial(trial)` replays
// it on a scratch copy of the simulator, and what that printed is shown under the explanation (`A.trialText(trial)`,
// or the option's own `show(trial)`; `show: false` hides it). A right option may carry `show(out)` to choose what is
// shown instead of the output.
export function decide(ui, A, ask, options, after) {
  return askUntilRight(ui, A.who, ask, options, {
    async right(opt) {
      const out = runRight(A, opt);
      const shown = opt.show ? opt.show(out) : out;
      await ui.say(A.who, text(after, out), 'Next', shown ? outputBox(shown) : null);
      return out;
    },
    async wrong(opt) {
      const trial = opt.trial && A.trial ? A.trial(opt.trial) : null;
      let shown = null;
      if (trial && opt.show !== false) shown = opt.show ? opt.show(trial) : A.trialText ? A.trialText(trial) : null;
      await ui.say(A.who, text(opt.why, trial), 'Try again', shown ? outputBox(shown) : null);
    },
  });
}

// A look that is not a decision: one button, then the real output of `cmd`.
export async function look(ui, A, intro, button, cmd, after) {
  await ui.say(A.who, intro, button);
  const out = A.sh(cmd);
  await ui.say(A.who, text(after, out), 'Next', out ? outputBox(out) : null);
  return out;
}
