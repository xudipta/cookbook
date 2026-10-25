# Changelog

Generated from this repo's own merged PR history with
`topics/skills/examples/release-notes/`'s `collect_prs.sh` — a real usage example of
that skill, not a hypothetical one. See `topics/skills/examples/release-notes/SKILL.md`
for the process; see `CONTRIBUTING.md` for how to keep this updated.

## Topics

- Refactor into a multi-topic cookbook with per-topic validation CI (#9)
- Add Agent Skills and MCP topics, each with its own validation (#10)
- Add the GitHub / Git topic, split out of CI/CD for a cleaner scope per topic (#13)
- Expand thin getting-started placeholders into full notes across Docker, Linux,
  Terraform, and CI/CD (#12)
- Expand Kubernetes documentation to match its already-substantial example set (#14)
- Add a CI/CD deployment-strategies note, Helm/Kustomize notes, and new Observability
  and Database topics (#15)

## Docs site

- Add the GitHub Pages docs site (MkDocs Material) (#11)
- Polish the docs site: tabbed navigation, theme, a sharper README hook, and per-topic
  diagrams/quickstarts (#16)

## CI/CD and repo setup

- Initial CI setup and a Trivy vulnerability scan fix (#1, #2)
- Add a `kind`-based Kubernetes CI workflow, then iterate on it: use the full
  deployment file, add Service connectivity verification (#3, #4, #5)
- Add a PR template and `CODEOWNERS` (#6, #7, #8)
