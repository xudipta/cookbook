# Play

Short browser games that turn each topic's ideas into things you operate instead of read:
something breaks, you diagnose it, you fix it. They run entirely in your browser, with no
server and nothing to install.

Every chaos event in a game links to the note that explains it, so a loss is a pointer to the
right section. Every game is also checked in CI: its scenarios must reference real note
sections, and a scripted winning run must actually win.

| Game | Topic | Status |
| --- | --- | --- |
| [Chaos Monkey Cluster](kubernetes/index.md) | Kubernetes | Playable: 3 levels, 9 failure types, a `kubectl` prompt |
| [Layer Cake](docker/index.md) | Docker | Playable: 5 levels, a layer-cache simulator, `docker build`-style logs |
| [Drift Detective](terraform/index.md) | Terraform | Playable: 3 levels, a plan/apply/state simulator, a `terraform` prompt |
| [Skill Issue](skills/index.md) | Agent Skills | Playable: 3 levels, a context-window and trigger simulator, the `check_skill.py` lint gate |
| [Replica Rescue (demo)](demo/index.md) | Kubernetes basics | Playable; exists to prove the shell |

Topic games are planned for every topic; follow the
[epic on GitHub](https://github.com/xudipta/cookbook/issues/36) for progress.

Building one yourself? See "Adding a game" in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
