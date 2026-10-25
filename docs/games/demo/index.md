# Replica Rescue (demo)

A tiny game that exists to prove the shared game shell works end to end. Your service
needs **3 pods** serving to carry its traffic, and a chaos monkey is killing pods. A
Deployment's ReplicaSet replaces them, but not instantly, and every tick with too few pods
serving burns your **error budget**. Spare replicas are not free either.

Survive 20 ticks with your budget above 70%.

<div id="game" data-game="demo">
  <noscript>This game needs JavaScript.</noscript>
</div>

## How to play

- **Add replica** (`a`) and **Remove replica** (`d`) change how many pods you run.
- **Pause** (`p`) and **Restart** (`r`) work any time. Click the game first so it has keyboard focus.
- Add `?seed=42` to the URL for a different (but repeatable) run.

When the game ends, each chaos event links to the note that explains what it was about. For this
demo that is [Pods and workloads](../../../topics/kubernetes/notes/02-pods-and-workloads.md).
