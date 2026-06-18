---
description: Create a well-structured Linear backlog ticket
argument-hint: "<brief issue or feature description>"
---
# create-issue

Add a new ticket to the correct Linear backlog project based on scope, with an enforced 3-section description template.

User request: $ARGUMENTS

## Instructions

You are helping the user triage a backlog item. This is a lightweight flow to create a well-structured Linear ticket. Do NOT try to create an implementation plan or branch — this is backlog triage only.

---

## Project Routing Table

Use this table to determine the correct team and project based on scope:

| Scope                                    | Project               | Project ID                             | Team       | Team ID                                |
| ---------------------------------------- | --------------------- | -------------------------------------- | ---------- | -------------------------------------- |
| `apps/curator-*`                         | Curator Backlog       | `d2b6d657-c059-4d9b-8f55-aa98390ab81f` | Curator    | `c07ff95f-03b7-4bee-aa17-c7e04fda8845` |
| `apps/markets-v2-app`                    | Markets v2 App        | `8ba12aa0-ea30-4c12-9134-15184d76c1ab` | Markets v2 | `f9764a7e-c555-4979-b386-c21a1cabba6a` |
| `@repo/*`, infra, tooling, or cross-cutting | Apps Monorepo Backlog | `1127eedb-8ef7-49e8-b8c7-9f9e2e47f9c8` | Apps       | `cc8fe27e-f516-45e8-921e-69b0562c7792` |

---

## Enforced Description Template

Every ticket created by this command MUST use exactly this structure:

```markdown
## Context
[Direct description of the problem or feature — what's wrong or what's needed]

## References
- [file paths with line numbers when known, related issue IDs — omit entire section if none]

## Possible solution
> ⚠️ AI-generated — treat as a starting point, not a prescription.

[Brief suggestion]
```

Rules:

- **Context**: 1–3 sentences, declarative prose. No sub-headers.
- **References**: Bullet list of file paths (with line numbers when known) and related issue IDs. Omit the entire section if there are genuinely none.
- **Possible solution**: Short, non-prescriptive. Always prefixed with the AI warning blockquote.

---

## Flow

1. If `$ARGUMENTS` is empty, ask: _"What should go in the backlog? (brief description)"_
2. Infer scope and route to project using the routing table.
3. Generate a convention-compliant title plus draft description.
4. Present the proposed ticket details and ask the user to confirm or edit:

```text
Title:       <generated title>
Project:     <inferred project name> (<team identifier>)
Description:
---
## Context
...

## References
...

## Possible solution
> ⚠️ AI-generated — treat as a starting point, not a prescription.
...
---
```

Then ask:

- **Label**: `Bug`, `Feature`, `Improvement`, or `Documentation`
- **Priority** (default: Low / 4): 1 = Urgent, 2 = High, 3 = Normal, 4 = Low
- **Estimate** (optional): 1, 2, 3, or 5 points

Allow the user to edit any field before proceeding.

5. Create the ticket using the Linear MCP create issue tool with:
   - `title`
   - `description` (3-section template, formatted as markdown)
   - `team` (team ID from routing table)
   - `project` (project ID from routing table)
   - `labels` (label names as an array, e.g. `["Feature"]`)
   - `priority` (number 1–4)
   - `estimate` (number: 1, 2, 3, or 5 — omit if not specified)
   - Leave `assignee` unassigned by default unless explicitly specified.

6. Confirm:

```text
Created <IDENTIFIER> — <title>
<linear-url>
```

No branch creation — this is backlog triage only.
