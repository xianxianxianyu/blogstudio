# Blog Studio

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` in this repo — the
`origin` remote is a self-hosted git host with no issue API. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label string = role name. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: `CONTEXT-MAP.md` at the root points to each context's `CONTEXT.md` (currently `pdfstudio/CONTEXT.md`; Blog Studio has design docs only). System-wide ADRs in `docs/adr/`, context-specific in `<context>/docs/adr/`. See `docs/agents/domain.md`.

## Language

Human-facing prose — docs, comments, commit messages, chat replies — is written in Chinese. Technical and domain terms stay in English (`pdf.js`, `reducer`, `Clip`, `context`).
