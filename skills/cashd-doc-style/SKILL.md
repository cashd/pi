---
name: cashd-doc-style
description: Applies Cash's pragmatic senior-engineer documentation voice for external Morpho/DeFi technical docs. Use when drafting, editing, or polishing external-facing technical specs, architecture docs, product engineering docs, release notes, and protocol documentation.
---

# Cash Documentation Style

Use this skill for external-facing technical documentation where the user wants the writing to sound like Cash: direct, practical, architecture-aware, and human, while still being publish-grade.

## Core rule

Write in Cash's voice, not Cash's typos. Preserve the cadence, structure, vocabulary, and pragmatic senior-engineer tone, but fix spelling, grammar, broken markdown, and confusing phrasing.

## Voice

- Sound like a senior software engineer explaining a real system to technical readers.
- Be direct, implementation-aware, and concrete.
- Prefer clarity and usefulness over marketing polish.
- Use a slightly informal but competent tone.
- Explain decisions through constraints, tradeoffs, and operational impact.
- Use `we` when describing product/team decisions; use neutral voice for reference-style documentation.

## Structure

Prefer clear, heavily sectioned docs. Useful section patterns include:

1. Summary
2. Lessons / Pain Points / Problems
3. Solutions
4. High Level Overview
5. Tech Stack
6. Application Structure
7. Modules / Architecture
8. Data Layer
9. Testing Strategy
10. Deployments and Monitoring

Use tables for comparisons, module summaries, limitations vs approaches, infrastructure, and release workflows.

```markdown
| Limitation | Approach |
| --- | --- |
| Wallet-derived chain context | Source of truth is derived from URL parameters |
```

Use bullets for capabilities, requirements, responsibilities, and constraints.

## Sentence style

- Mix short declarative sentences with longer explanatory ones.
- Use cause/effect transitions naturally: `This ensures`, `This enables`, `This reduces`, `This prevents`, `This makes it easier to`.
- Use `while` and `since` to explain tradeoffs and rationale.
- Prefer concrete implementation details over generic claims.
- Avoid repeating the same transition too often.

Good:

```markdown
This separation means flow definitions can be built and validated without wallet interaction, while execution remains centralized in the provider.
```

Avoid:

```markdown
The subsystem significantly enhances scalability by optimizing distributed data retrieval patterns.
```

## Formatting habits

- Use consistent, clear technical headings.
- Bold important concepts, providers, layers, and patterns.
- Use code blocks for examples, folder trees, and architecture diagrams.
- Use blockquotes or platform-supported callouts for caveats and implementation notes.
- Use em dashes for short explanatory labels when helpful.

```markdown
**Flow builder** — Pure function, no React dependencies.
```

## Vocabulary to favor

Prefer language like:

- source of truth
- domain logic
- purpose-built UI
- indexing and reconciliation
- centralized / normalized
- hydrated data
- declarative / immutable
- transaction flow
- state machine
- framework concerns
- pathological edge cases
- happy paths
- onchain validation
- wallet interaction
- production deployment
- graceful degradation

## Editing rules

When editing user text:

- Preserve the user's structure unless it is confusing or broken.
- Improve clarity without making the prose sound corporate or generic.
- Keep domain-specific terminology intact.
- Prefer targeted rewrites over full rewrites.
- Make external docs publish-ready: fix spelling, grammar, malformed markdown, broken punctuation, and ambiguous claims.
- Preserve the human cadence and pragmatic tone.
- Remove casual phrases that weaken external credibility unless the surrounding doc intentionally uses an informal voice.

## Documentation priorities

Prioritize, in order:

1. What the system does
2. Why the design exists
3. What problem the design solves
4. How the architecture is organized
5. Testing, deployment, and operational implications

Avoid marketing language, academic tone, unnecessary caveats, and generic best-practice explanations that are not tied to the implementation.
