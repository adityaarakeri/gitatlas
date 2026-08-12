# Translating gitatlas

Status: phase 1 shipped, phases 2 to 5 not started. This is the plan of record so the work can be picked up cold.

Phase 1 landed as described below, with the open decisions resolved as noted in that section. Contributor-facing instructions moved to [docs/i18n.md](docs/i18n.md); this file stays the strategy and the reasoning.

The goal is reaching readers who do not read English, not translating everything. Most of this repo should stay in English on purpose, and the reasoning for that is below so it does not get relitigated every six months.

## Scope

Four surfaces carry reader-facing English. They differ by an order of magnitude in cost.

| Surface | Size | Churn | Audience |
| --- | --- | --- | --- |
| `packages/viewer/template.html` UI | ~45 strings | low | everyone, every day |
| `README.md` | 160 lines | high | evaluators deciding to install |
| `docs/*.md` (cli, agents, internals, playground) | ~260 lines | medium | users after install |
| `docs/index.html` landing page | ~60 prose blocks inside 834 lines | medium | evaluators, pre-install |

The viewer is the smallest surface and the highest leverage, so it goes first. The landing page is the largest cost per word, so it goes last.

### Not translated, deliberately

- **`gitatlas brief` output and all MCP tool results.** Machine-facing, consumed by a language model. Translating costs tokens and accuracy and helps no human.
- **CLI stdout and stderr** (37 call sites across `packages/*/src`). Devtool convention, and error strings are what people paste into a search box.
- **Anything code-derived.** Symbol names, module paths, language names, and the `neighborhoodLabels` in the graph JSON all come from the indexed source. They are data, not copy.
- **Schema values on the wire.** `kind`, `confidence`, and field names stay English in the JSON forever. Rule 1 says the extractor and viewer communicate only through the schema; localization is a viewer-side display concern.
- **`CONTRIBUTING.md`, `CLAUDE.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `blog/`.** Contributor-facing, not reader-facing.

## Languages

Wave one, four locales, chosen by where dev-tool readership actually is:

| Locale | Why |
| --- | --- |
| `zh-CN` | Largest non-English OSS devtool audience by a wide margin. First locale for nearly every tool that translates anything. |
| `ja` | High devtool adoption, strong track record of translations that stay maintained. |
| `es` | Best reach per unit of effort. Covers Spain and Latin America. |
| `pt-BR` | Very large and active GitHub population. `pt-BR` specifically, not `pt`. |

Wave two, only after wave one has survived a release cycle with its maintainers intact: `ko`, `de`, `fr`, `ru`, `hi`.

Do not open wave two early. The failure mode of this whole project is four half-finished locales, not too few locales.

## Clear this blocker first

`packages/viewer/template.html:14` and `docs/index.html:26` load Archivo and IBM Plex Mono from Google Fonts, which is unreachable from mainland China. Shipping a Chinese README to readers whose viewer then renders in fallback faces is a bad first impression, and it undercuts the "your code never leaves your machine" claim that the same paragraph makes.

This is already listed under "Honest limitations" in the README and is worth fixing on its own merits. Either self-host the two faces next to the vendored d3, or drop to a system font stack. It should land before, or with, the `zh-CN` README.

## Phase 1: viewer UI (shipped)

Smallest surface, highest daily value, and it is the artifact people actually forward to colleagues.

### What shipped, against what was planned

- Built as described: flat catalogs at `packages/viewer/locales/<code>.json`, no i18n library, all catalogs baked into every generated file, picker beside the theme toggle, `<html lang>` set from the active locale, `gitatlas extract --lang <code>`.
- The string inventory came out at 78 keys rather than the ~45 estimated below. The survey undercounted the detail panel: its meta keys and values (`import degree`, `none supported`, `yes, changes ripple widest here`) are UI copy too.
- Both wrinkles were real. Schema values are now translated through a `kind.*` display map, and the JSON still emits English.
- Decision 1 resolved: all catalogs shipped with a picker, as the plan leaned. Four locales cost about 4 KB.
- Decision 4 resolved the other way from the plan's leaning. A plural hook went in rather than a restructured badge, because `Intl.PluralRules` is built into every browser, so the hook is about eight lines and no invented UI copy. The badge reads exactly as it did.
- Decision 3 is not resolved and should not be treated as resolved. The four non-English catalogs are machine drafts carrying `reviewed: false` and no maintainer. They are labeled as drafts in `docs/i18n.md` and a test refuses `reviewed: true` without a named human. Wave two must not open until they have one.
- Not done, and still blocking a `zh-CN` README: the Google Fonts dependency below.
- One thing the survey missed entirely: `#plate` is a non-wrapping flex row, so adding the picker to it pushed the plate off a phone screen. It wraps under 640px now.

### Approach

- Add a flat `LOCALE` dictionary object to the template: `key -> string`, English inline as the default. No i18n library. Vanilla JS, single file, no build step, per the viewer rules in CONTRIBUTING.md.
- Catalogs live as JSON at `packages/viewer/locales/<code>.json`.
- Set `<html lang>` from the active locale. It is hardcoded `en` at `packages/viewer/template.html:2`.
- Ship all catalogs in every generated file and add a locale picker beside the existing theme toggle, defaulting to `navigator.language` with a manual override. Four catalogs is roughly 4 KB. This costs less than it sounds and it fits the core promise: one file anyone can open. See open decisions below.

### String inventory

Derived by reading the template. Line numbers are current as of this writing and will drift.

| Where | What |
| --- | --- |
| `:6` | document title |
| `:306`, `:315`, `:316`, `:322`, `:327`, `:329`, `:330`, `:335`, `:349` | 9 aria-labels and 2 input placeholders |
| `:317`, `:318` | theme names `BARREL` and `GLASS` |
| `:344` | empty state, 2 sentences |
| `:359` to `:362` | zoom stop labels: TREE, GROUP, MODULE, SYMBOL |
| `:770` to `:777` | BACK TO TREE, BACK TO GROUP, BACK TO MODULES |
| `:584` to `:587` | badge units: `sym`, and `file` / `files` |
| `:647` to `:649` | two glyph tooltips with an interpolated node name |
| `:683` | `neighborhood {n}` fallback label |
| `:428`, `:446`, `:464` | detail panel meta keys, plus the value `none supported` |
| `:817` to `:820` | tree legend: 3 swatch labels and 1 sentence |
| `:828` to `:835` | map legend: kind labels and 6 conditional sentences |
| `:839` | `d.kind` rendered straight into the detail panel |

### Two wrinkles found while surveying

1. **Schema values are rendered as UI text.** `d.kind` at `:839` and the legend kind labels at `:829` print raw schema values (`repo`, `module`, `function`, `class`, `method`, `variable`). Localizing them needs a display map in the viewer. The JSON must keep emitting English. Do not translate at extract time.
2. **There is an English plural rule baked in.** `packages/viewer/template.html:586` picks `file` or `files` on `fileCount === 1`. English has two plural forms, Chinese and Japanese have one, and several wave-two candidates have more. Either give the catalog a minimal plural-form hook or restructure the badge so the count carries no inflected noun.

Six or so strings need interpolation, so the catalog needs simple `{name}` placeholder substitution. It does not need full ICU MessageFormat.

### CLI

Add `gitatlas extract --lang <code>`, default `en`, preserving current behavior. New flags need a README line and a safe default, per CONTRIBUTING.md.

### Tests

- Assert every locale file has exactly the same key set as `en.json`. A missing key fails CI. Never fall back silently to English inside a translated UI; a half-translated panel reads as a bug.
- Verify CJK and long-German strings do not overflow the legend or detail panel. Chinese and Japanese usually run shorter than English, German longer.
- Layout coordinates are computed at extract time from code structure and are unaffected by UI copy, so the determinism tests in `layout.ts` and `packages/analysis` stay green. Confirm this rather than assume it.

## Phase 2: README

Sibling files: `README.zh-CN.md`, `README.ja.md`, `README.es.md`, `README.pt-BR.md`. A language switcher line under the title of each, and an HTML comment at the top recording the source commit SHA it was translated from.

Two things translators need told explicitly:

- **Rewrite, do not transliterate.** "One map. Every repo. Down to the function." and "Agents are brilliant sprinters with amnesia" produce nothing good under literal translation. Translators have permission to find the equivalent line in their language.
- **Translate the alt text.** Badge alt text and the three image alt strings are the part everyone forgets, and they are the part screen reader users depend on.

Command names, flags, and code blocks stay untranslated.

## Phase 3: docs pages

Order by reader value: `docs/cli.md` and `docs/agents.md` first, `docs/playground.md` next, `docs/internals.md` last. Internals has the lowest reader count and the highest churn, which is the worst combination for a translation.

Prose only. Flags, commands, IDs, and JSON stay as they are.

## Phase 4: landing page

`docs/index.html` is 834 lines of hand-written HTML with prose interleaved into the markup. Do not fork it four ways; four copies will diverge within two releases. Extract the prose into `content/<locale>.json` and template it, or leave the landing page English and let the translated README carry the pitch.

Leaving it English is a legitimate outcome. Decide when the phase starts, not now.

## Phase 5: the maintenance contract

Without this, phases 1 through 4 decay into confidently wrong documentation. This phase is not optional.

- `docs/i18n.md`: how to add a locale, what is out of scope, and the tone rules (plain and active, no em dashes, matching the existing style).
- A translation status table in the README: locale, maintainer handle, source commit, freshness.
- A CI check that flags a translation whose recorded source commit is behind `main` on the file it mirrors. This is the same idea as `gitatlas check`, applied to prose, and it is pleasingly on-thesis: a stale artifact is worse than no artifact.
- An explicit deprecation rule. A locale with no maintainer response for two releases is marked unmaintained in the table and dropped on the third.

## Prior art

How comparable projects handle this, roughly by size:

- **Sibling README files.** `README.zh-CN.md` and friends with a switcher line, no tooling. What most popular single-tool repos do. Failure mode: translations rot invisibly and a reader cannot tell a page is six versions stale.
- **Docs-framework i18n.** Docusaurus `i18n/<locale>/` or VitePress, usually wired to Crowdin so translators work in a web UI and a bot opens the PRs. Used by React, Jest, Vite, Babel. Requires a build step, which is exactly the thing this project avoids.
- **Per-locale ownership.** Kubernetes keeps localizations in-tree with `OWNERS` files and requires named approvers plus a minimum page set before accepting a new locale. Vue gives each language its own repo, a designated maintainer, and a public translation status table. MDN went furthest: locales that lost their maintainers were frozen, then removed.

The lesson all three tiers converge on: an unmaintained translation is worse than no translation, because it carries the project's authority while teaching readers things that are no longer true. That is why phase 5 exists.

The right shape for a project this size is sibling README files plus the staleness gate borrowed from the third tier.

## Recommendation on sequencing

Do phases 1 and 2, then stop and measure. A localized viewer plus four translated READMEs is the bulk of the reach for roughly two days of work. Phases 3 and 4 roughly triple the maintained surface and are the first to rot. The staleness gate from phase 5 matters more than any additional locale.

## Open decisions

1. ~~**One locale baked in per file (`--lang`), or all four shipped with a picker?**~~ Resolved in phase 1: all catalogs ship, `--lang` picks the default.
2. **Is the landing page in scope at all?** Highest cost per word of any surface. Possibly better left English. Still open, and phase 4 has not started.
3. **Machine translation for the first draft?** Still open, and now urgent rather than hypothetical: the four catalogs in the tree are machine drafts. They are labeled as such and gated by `reviewed: false`, which is the honest holding position, not an answer. The answer is a named reviewer per locale, or dropping the locales that never get one.
4. ~~**Plural handling in the badge.**~~ Resolved in phase 1 with a plural hook over `Intl.PluralRules`, not a restructured string.
