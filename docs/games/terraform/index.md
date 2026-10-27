# Drift Detective

Reality drifts from what Terraform's state says. Read every plan, and end each day with config, state and the real world in agreement.

<div id="game" data-game="terraform">
  <noscript>This game needs JavaScript.</noscript>
</div>

## Rules

- Type commands in the terminal (or use the buttons). Reading a plan, listing state and checking
  the workspace are free. Changing something (`apply`, `import`, `state rm`, `force-unlock`) costs a
  move, and saving a config edit does too.
- **Next day** (`d`) ends the day. Anything still out of sync overnight costs trust, and new
  trouble shows up. Win by reaching the last day with nothing out of sync and trust above the line.
- The panes show your config, the state for the current workspace, and what really exists there.
  Terraform compares the first two, after refreshing state against the third, only when you plan.
- Destroying a database or bucket (including a `-/+` replacement) takes the data with it.
- Level 4 is a refactor: **Extract module** moves resources into a module, which changes their
  addresses. Make Terraform move the state (a `moved` block or `state mv`) before you apply.

## Syntax worth remembering

```bash
terraform init                      # providers + backend
terraform plan                      # refresh, then diff config vs state
terraform apply                     # show the plan, then answer: yes
terraform import aws_s3_bucket.assets acme-assets   # adopt an existing object
terraform workspace select prod     # each workspace has its own state
terraform init -migrate-state       # move local state into a new backend
terraform force-unlock LOCK_ID      # only after confirming nothing is running
terraform state mv aws_instance.web_a module.svc_a.aws_instance.web   # one-off; or a moved { from, to } block
```

| In a plan | Meaning |
| --- | --- |
| `+` | create |
| `~` | update in place |
| `-/+` and `# forces replacement` | destroy, then create: data loss for stateful resources |
| `-` | destroy |
| "Objects have changed outside of Terraform" | drift; the plan proposes to revert it |

Notes behind it: [Core workflow](../../../topics/terraform/notes/01-core-workflow.md),
[Variables, outputs, and modules](../../../topics/terraform/notes/02-variables-and-modules.md) and
[Remote state, locking, and workspaces](../../../topics/terraform/notes/03-state-and-workspaces.md).
