# Skill Issue

An agent picks a skill from its name and description alone, inside a limited context window. Author a `SKILL.md`, then see whether the agent would trigger it.

<div id="game" data-game="skills">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- The agent always has every installed skill's **name and description** in context. The **body** loads only
  when it picks a skill, and a **bundled file** only when the body points at it. Everything must fit the window.
- Edit the skill, then press **Send next request** (`g`). The queue previews what the agent would do right now.
  Editing and saving cost a move; **Check** and reading the queue are free. A request that goes wrong costs
  health, and a win needs a skill that passes the gate and is not left open.
- Level 3 runs the same rules as `scripts/check_skill.py` and adds where the folder lives and which tools it may use.
- The agent here is a deliberately simple stand-in: it scores shared words (2 points for a word in the
  "Use when" part, 1 elsewhere, 2 points to trigger). A real model is not this simple.

## Syntax worth remembering

```markdown
---
name: release-notes          # kebab-case, at most 64 chars, same as the folder name
description: >-              # at most 1024 chars: what it does, and when to use it
  Generate release notes from merged pull requests since the last git tag. Use when the
  user asks for a changelog, release notes, or "what changed since <version>".
allowed-tools: [Bash, Read]  # optional (Claude Code): the only tools it may use
---
```

```text
.claude/skills/release-notes/   # project skill; ~/.claude/skills/ is personal
  SKILL.md                      # required: frontmatter + the procedure
  scripts/collect_prs.sh        # the body points at it: Run `scripts/collect_prs.sh`
```

```bash
python scripts/check_skill.py .claude/skills/*/SKILL.md
```

| Mechanism | Use it for |
| --- | --- |
| Skill | a procedure for a kind of task; advisory |
| Hook | something that must run every time on an event |

Notes behind it: [What are Agent Skills](../../../topics/skills/notes/01-what-are-agent-skills.md),
[Authoring a skill](../../../topics/skills/notes/02-authoring-skills.md) and
[Skills in Claude Code](../../../topics/skills/notes/03-skills-in-claude-code.md).
