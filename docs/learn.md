# Notes by topic

Short notes with runnable examples, one folder per topic. Each example is built, applied or
deployed in CI on every change, so the commands work as written.

Every topic is taught three ways. Start with the **story** if you are new to it, read the **notes**
for the detail, and use the **practice game** to try the real commands. A story or game sends you to
the exact note section behind each idea, and every topic page shows a banner linking to both.

## A path through the topics

New to infrastructure? Follow the order below: each topic leans on the ones before it. It is a
suggestion, not a lock, so jump straight to any topic you need. The home page shows
the same path and a **Continue** button that remembers where you were, in this browser only.

| Step | Topic | Notes | Story | Practice | Best after |
| --- | --- | --- | --- | --- | --- |
| 1 | [Linux](../topics/linux/README.md) | Shell, text tools, systemd | [The Night Superintendent](stories/linux/index.md) | [Night Shift](games/linux/index.md) | nothing |
| 2 | [GitHub](../topics/github/README.md) | Git, the gh CLI, repo settings | [The Shared Cookbook](stories/github/index.md) | [Merge Conflict Rush](games/github/index.md) | nothing |
| 3 | [Docker](../topics/docker/README.md) | Images, multi-stage builds, caching | [The Layer Cake](stories/docker/index.md) | [Layer Cake](games/docker/index.md) | Linux |
| 4 | [Kubernetes](../topics/kubernetes/README.md) | Pods, probes, config, scaling | [Night Shift at Pizza Palace](stories/kubernetes/index.md) | [Chaos Monkey Cluster](games/kubernetes/index.md) | Docker |
| 5 | [CI/CD](../topics/cicd/README.md) | Actions, patterns, deploy strategies | [The Assembly Line](stories/cicd/index.md) | [Pipeline Panic](games/cicd/index.md) | GitHub, Docker |
| 6 | [Terraform](../topics/terraform/README.md) | Plan, state, workspaces, locks | [The Drift Detective](stories/terraform/index.md) | [Drift Detective](games/terraform/index.md) | Linux |
| 7 | [Observability](../topics/observability/README.md) | Prometheus, alerts, dashboards | [Quiet Hours](stories/observability/index.md) | [Quiet Hours](games/observability/index.md) | Kubernetes |
| 8 | [Database](../topics/database/README.md) | Schemas, migrations, indexes | [The Card Catalogue](stories/database/index.md) | [Index Fund](games/database/index.md) | Linux |
| 9 | [Agent Skills](../topics/skills/README.md) | What they are, how to write one | [The New Hire](stories/skills/index.md) | [Skill Issue](games/skills/index.md) | nothing |
| 10 | [MCP](../topics/mcp/README.md) | The protocol, Claude Code, servers | [The Switchboard](stories/mcp/index.md) | [Patch Bay](games/mcp/index.md) | Agent Skills |
| | [Capstone](../topics/capstone/README.md) | Ship a monitored service, end to end | | | The topics above |

Prefer to browse by area? [Infrastructure](infrastructure.md), [Delivery](delivery.md),
[Operations](operations.md) and [AI Tooling](ai-tooling.md) group the same topics.
