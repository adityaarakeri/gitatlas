## What this changes

<!-- One concern per PR. If you are fixing two unrelated things, please open two. -->

## Why

<!-- What was wrong or missing. Link an issue if there is one. -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] One concern only

### If this touches the schema

- [ ] The change is additive (new optional fields), **or** `SCHEMA_VERSION` is bumped and the PR title says so

### If this touches the extractor

- [ ] New or changed language config has a fixture in `fixtures/polyglot-lab`
- [ ] Call-edge resolution still drops ambiguous callees instead of guessing
- [ ] Unresolvable imports still become `pkg:<specifier>` with confidence `exact`

### If this touches layout or analysis

- [ ] Output is still deterministic: sorted iteration, explicit tie-breaking, no `Math.random`, no wall-clock
- [ ] Coordinate-equality and shuffled-input tests pass

### If this touches the viewer

- [ ] Both themes updated together (`data-theme="dark"` and `"light"`)
- [ ] Focus states visible, `prefers-reduced-motion` respected
- [ ] Checked with a keyboard and at a phone viewport

### If this adds a CLI flag

- [ ] The default preserves current behavior
- [ ] `README.md` or `docs/cli.md` documents it
