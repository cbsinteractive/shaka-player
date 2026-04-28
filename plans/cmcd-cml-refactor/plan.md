# CMCD CML Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace shaka-player's 1700-line custom `shaka.util.CmcdManager` and ~4300 lines of CMCD wire-format tests with a vendored Closure port of `@svta/cml-cmcd` plus a thin shaka-specific adapter (~250 lines), shipped as three sequential reviewable PRs.

**Architecture:** Three layers — public shaka API (back-compat preserved except experimental v2 renames) → thin shaka adapter (`lib/util/cmcd_manager.js`) → vendored CML port (`third_party/cml-cmcd/`, namespace `cml.cmcd.*`). When shaka migrates to TypeScript ([#8262](https://github.com/shaka-project/shaka-player/issues/8262)), the vendored directory deletes and `goog.require('cml.cmcd.X')` becomes `import { X } from '@svta/cml-cmcd'` — no other code changes.

**Tech stack:** JavaScript with `goog.provide`/`goog.require`, JSDoc type annotations, Closure Compiler `ADVANCED_OPTIMIZATIONS`, Python build system (`build/check.py`, `build/test.py`, `build/all.py`), Karma + Jasmine for tests.

**Canonical input:** [spec.md](spec.md) (~600 lines) — file lists, type translations, encoding rules, lifecycle tables, and rationale all live there. This plan sequences the work and identifies risks; it does not duplicate the spec.

---

## Current status (last updated 2026-04-28)

This refactor is actively in progress on branch `feat/cmcd-cml-refactor`. Read this section first before resuming work in a new session.

| Phase | Status | Commits / Notes |
|---|---|---|
| **Phase 0** — CML verification | ✅ Complete | Verification report at [`cml-version.md`](cml-version.md). CML pin: `cmcd-v2.3.0` / commit `22390e35dfbbe1e53d15648d3aace99cdf71f9dd`. **No upstream CML PRs needed.** Five spec/plan doc fixes already applied. |
| **Phase 1A** — Skeleton + typedefs + enums + constants + utils (Tasks 1.1-1.5) | ✅ Complete | 6 commits, ending at `e6cb2563d`. 44 files added under `third_party/cml-cmcd/`. |
| **Phase 1B** — Encoders + helpers + cml-utils/sfv shims + deferred `CMCD_FORMATTER_MAP` (Tasks 1.6-1.7) | ✅ Complete | 5 commits, ending at `9bcf6614e`. 23 new files. Re-included 8 spec-excluded files (predicates + `is_valid.js` + `group_cmcd_headers.js`) that were genuinely runtime-required by encoders. New shim `cml_sfv.js` (~448 LoC, RFC 8941 §4.1 serializer). |
| **Phase 1C** — `CmcdReporter` + 5 deferred typedefs (Task 1.8) | ✅ Complete | 3 commits, ending at `d682bb1bb`. 6 new files. The vendored port is now structurally complete. |
| **Phase 1D** — Encoding delegation in `cmcd_manager.js` + drop non-spec `'ld'`/`'lh'` (Tasks 1.10, 1.10b) | ✅ Complete | 2 commits, ending at `adfdfab05`. Net −168 LoC across `lib/util/cmcd_manager.js` and `test/util/cmcd_manager_unit.js`. `python3 build/check.py` exits 0. `build/test.py` deferred to sub-phase E (Tasks 1.11-1.12 catalog and update wire-format-divergence assertions). |
| **Phase 1E** — Diff testing + assertion updates (Tasks 1.11-1.12) | ⏳ **Resume here.** | Needs human judgment on divergence classification. |
| **Phase 1F** — Demo verification + Phase 1 PR (Tasks 1.13-1.14) | ⏳ Not started | Phase 1 ships as PR after this. |
| **Phase 2** — Adopt CML constants, dedupe shaka duplicates | ⏳ Not started | After Phase 1 merges. |
| **Phase 3** — Adapter rewrite (the big behavioral change) | ⏳ Not started | After Phase 2 merges. |

**Vendored port summary:** [`third_party/cml-cmcd/`](../../third_party/cml-cmcd/) holds 68 JS files (typedefs + enums + constants + encoders + helpers + shims + `CmcdReporter`) + `LICENSE` + `NOTICE` + `SUMMARY.txt`. At HEAD (`adfdfab05`), `python3 build/check.py` exits 0. `python3 build/build.py` was last clean at `d682bb1bb` and is not expected to break under sub-phase D's source-only changes; not re-run this session.

### Sub-phase D landing notes (Tasks 1.10 + 1.10b)

- **Encoding paths now delegate through CML.** `serialize` / `toQuery` / `toHeaders` thread an optional `cml.cmcd.CmcdEncodeOptions` and route to `cml.cmcd.encodeCmcd`. `appendQueryToUri` retained as a thin `goog.Uri`-based adapter (CML's `appendCmcdQuery` takes a data object, not a pre-encoded query string — incompatible signature; Phase 3 deletes the call sites entirely).
- **`urlToRelativePath` deleted** from `cmcd_manager.js` (and its 9 unit tests). `data.nor` is set to the absolute next-segment URL in `getDataForSegment_`; CML's `nor` formatter (in `cmcd_formatter_map_const.js`) relativizes against `options.baseUrl`. New private helper `shaka.util.CmcdManager.getEncodeOptions_(uri)` derives `baseUrl` from `new URL(uri).origin` (with `offline:`/parse-error guards) and is invoked at all four CMCD-encoding call sites: `appendSrcData`, `appendTextTrackData`, `sendCmcdRequest_`, `applyCmcdDataToRequest_`.
- **Two intentional wire-format changes shipped:**
  1. `nor` URLs become root-relative instead of path-relative (matching CTA-5004-B + CML's spec-conformant output).
  2. `'ld'` / `'lh'` `StreamingFormat` values dropped — LL DASH now emits `sf=d`, LL HLS now emits `sf=h`. `setLowLatency` no longer mutates `sf_`; `getStreamFormat_` no longer branches on `lowLatency_`.
- **No tests asserted `sf=ld`/`sf=lh`** (verified via repo-wide grep). The `urlToRelativePath` describe-block (9 tests) was the only test deletion in sub-phase D.

### Key architectural decisions in the port — surface in Phase 1 PR description

These were judgment calls during sub-phases B+C; maintainers should weigh in before merge:

1. **`setInterval` whitelisted** in `build/conformance.textproto` for `third_party/cml-cmcd/cmcd_reporter.js`. The reporter calls `setInterval` directly for periodic time-interval event reporting. Alternatives considered: (a) patching the vendored reporter to use `shaka.util.Timer` (breaks verbatim parity), (b) filing a CML upstream PR for injectable-timer support (delays Phase 1). Whitelist is pragmatic but means **Phase 3 tests cannot inject a fake timer** — will need `jasmine.clock()`-based interval testing.
2. **`fetch` whitelisted** in `build/conformance.textproto` for `third_party/cml-cmcd/cml_utils.js`. Used by `cml.cmcd.defaultRequester` — dead code at runtime because the shaka adapter always supplies a custom `requester` via `NetworkingEngine`. Closure ADVANCED is expected to strip the dead path, but the conformance check runs first.
3. **`defaultRequester` relocated** from `CmcdReporter.ts` module scope into `cml_utils.js` as `cml.cmcd.defaultRequester`. Done to centralize the `fetch` whitelist scope to a single file. **Per-bump CML diff workflow needs to know** `defaultRequester` lives here, not in the reporter — otherwise CML 2.4.0+ bumps will look like the function vanished.

### Open hygiene items (user-owned, untouched by this session)

Two git stashes exist:
- `stash@{0}: On feat/cmcd-cml-refactor: accidental-stash-pop-recovery` — created during a sub-phase B subagent's `git stash pop` mishap. Contains contaminated working state from that incident.
- `stash@{1}: On task/revert-cmcd-v1: CMCD STUFF` — pre-existing user stash. Preserved.

### Resuming work in a new session — sub-phase E prep

- **Verify CML pinned clone** is still at `/tmp/cml-pinned/`. Run `cd /tmp/cml-pinned && git rev-parse HEAD` — should output `22390e35dfbbe1e53d15648d3aace99cdf71f9dd`. If missing or wrong SHA, re-clone:
  ```bash
  rm -rf /tmp/cml-pinned
  git clone https://github.com/streaming-video-technology-alliance/common-media-library.git /tmp/cml-pinned
  cd /tmp/cml-pinned && git checkout 22390e35dfbbe1e53d15648d3aace99cdf71f9dd
  ```
- **Sub-phase E scope (Tasks 1.11-1.12):** capture pre-delegation baseline + post-delegation wire output for the existing `test/util/cmcd_manager_unit.js` suite, diff, and classify each divergence as (a) intentional spec-conformance fix, (b) acceptable alignment with CML, or (c) bug to fix before shipping Phase 1. Update assertions for (a)/(b); resolve (c) before Phase 1 PR.
- **Capturing the pre-delegation baseline** requires reverting sub-phase D temporarily. Cleanest: `git checkout 0f69e7f0e -- lib/util/cmcd_manager.js test/util/cmcd_manager_unit.js`, dump test wire output, reset, re-dump post-delegation. (The plan's literal `git stash`/`git stash pop` flow assumed sub-phase D was uncommitted; since it's now committed across `d8d614ce3` + `adfdfab05`, the checkout-from-prior-SHA flow is the equivalent.)
- **Expected divergence categories** (pre-judgment): `nor` URLs path-relative → root-relative (intentional); CML's SFV encoder vs shaka's old comma-separated encoder may differ on string escaping, key ordering, and whether `v=2` is auto-added per shard in `toHeaders` (CML's `prepareCmcdData` adds `v` for V2; shaka's old encoder didn't). The `v=2` per-shard auto-add is the most likely (c)-class bug — shaka groups data into 4 shards before encoding, so without intervention every shard will emit `v=2`.

---

## Plan structure

- **Phase 0** — CML-side verification & upstream precursor PRs (no shaka commits).
- **Phase 1** — Vendor `third_party/cml-cmcd/`, delegate encoding through it. Behavior preserved except documented `nor` change.
- **Phase 2** — Replace shaka's duplicate constants/enums with CML's; pure dedupe.
- **Phase 3** — Rewrite `cmcd_manager.js` as adapter around `CmcdReporter`; delete state machine; rewrite tests; update demo and externs.

Each phase ships as one PR. Phases 1 and 2 are behavior-preserving (modulo the documented `nor` change); Phase 3 is the behavioral rewrite and carries the migration risk.

## Spec gaps surfaced during planning

The spec is mature, but these items need explicit attention during execution rather than being deferred to "we'll figure it out":

1. **`setMediaElement` not in the lifecycle map.** Spec § "Lifecycle and player wiring" lists `configure`/`reset` flows but omits `setMediaElement`, which `Player` calls after constructing the manager. The adapter must subscribe to `<video>` events here, not at construction (the video element doesn't exist yet at construction time). Captured as Task 3.3.
2. **`bl` (buffer length) appears in both persistent state and per-request data.** Spec § "State fields the adapter feeds via update()" lists `bl` and notes "per-request, may live on `createRequestReport` data". The adapter should treat `bl` as per-request only — persistent state would emit stale buffer values to event-mode targets. Captured as Task 3.4.
3. **Per-target `version` override field.** Spec § "Per-target eventTargets[] field shape" lists a `version` per-target field. Whether CML's `CmcdEventReportConfig` exposes this needs verification (Task 0.5).
4. **`sessionId` auto-generation path.** The existing shaka API auto-generates `sessionId` on each `load()` if the user doesn't set one. Spec says the adapter "always sets `sid` explicitly", but doesn't say where the value comes from when the user didn't supply one. Adapter must fall through to shaka's existing UUID path (`shaka.util.Functional` / `lib/polyfill/random_uuid.js`), not CML's `cml.cmcd.uuid`. Captured as Task 3.8.
5. **`applyResponseData` mutation contract.** Spec defines the call as `reporter.recordResponseReceived(response, {ttfb, ttlb, rc, url})` but shaka's existing `applyResponseData(type, response, context)` is expected to mutate `response` in place (matching `applyRequestData`'s contract). CML's signature for `recordResponseReceived` needs verification — if it returns data, adapter must copy back like Phase 3's request flow (Task 0.4 + Task 3.5).
6. **Always-on reporter vs. hls.js [#7725](https://github.com/video-dev/hls.js/pull/7725).** hls.js uses CML's encoders for request mode and reporter for event mode only. Our spec chose always-on reporter for a single integration boundary. **Risk**: in v1-only request-mode-only configurations, we instantiate timers and event infrastructure that the user doesn't need. Captured as Task 3.3.
7. **`enabled: false` early-out.** Spec says "adapter no-ops when `false`", but the CmcdReporter shouldn't be constructed at all when disabled to avoid timer creation. The lifecycle code must check `enabled` before construction, not just before each `apply*` call. Captured as Task 3.3.
8. **Demo scope for Phase 3.** Spec § Phase 3 says "Update demo/ to add a CMCD v2 configuration UI" but doesn't enumerate which controls. Pinning a minimum scope: transmission mode toggle, version selector, single eventTarget editor with URL + events checklist. More expansive UI deferred. Captured as Task 3.13.
9. **`StreamingFormat` value parity.** Phase 0 verified: shaka emits 6 values but CTA-5004 / CTA-5004-B / CML define only 4 (`'d'`/`'h'`/`'s'`/`'o'`). shaka's `'ld'` and `'lh'` come from an old unreleased CMCD draft and are non-spec. Captured as Phase 1 Task 1.10b (drop `'ld'`/`'lh'`); Phase 2 alias re-export then becomes a straightforward identity map (Task 2.3).
10. **CML `CmcdEventType` enum membership.** Phase 0 verified: CML cmcd-v2.3.0 includes all 10 event types shaka needs (`ps`/`e`/`t`/`c`/`b`/`m`/`um`/`pe`/`pc`/`rr`) plus 7 more (`bc` bitrate change, ad events, skip, custom). Correct CML constant names listed at `plan.md:86`. No upstream PR needed.

---

## Phase 0: CML-side verification & upstream precursor PRs

**Goal:** Lock the CML version we'll port from, and confirm/fill any gaps in `CmcdReporter`'s public surface so Phase 3 doesn't get stuck on missing CML capabilities mid-rewrite.

**No shaka-player commits in this phase.** Output is (a) a pinned CML commit/tag, (b) a one-page verification report that maps spec assertions to CML source, and (c) any merged CML PRs that close gaps.

### Task 0.1: Pin the CML version

**Files:**
- Note in: `plans/cmcd-cml-refactor/cml-version.md` (new — short doc, not a code file)

- [ ] **Step 1: Inspect current `@svta/cml-cmcd` releases.**

```bash
npm view @svta/cml-cmcd versions --json | tail -20
```

Pick the latest stable release (spec assumes v2.3.0 as of 2026-04-27; confirm or update). Capture: tag name, commit SHA, npm version, release date.

- [ ] **Step 2: Clone CML at the pinned commit into a sibling directory for reference.**

```bash
cd /tmp && git clone https://github.com/streaming-video-technology-alliance/common-media-library.git cml-pinned
cd cml-pinned && git checkout <pinned-sha>
```

- [ ] **Step 3: Write `plans/cmcd-cml-refactor/cml-version.md`** with: pinned version, SHA, date, source path (`libs/cmcd/src/`), and one-line "what changed since v2.3.0" if applicable.

**Acceptance:** Pinned version selected; reproducible checkout in a known location for the rest of Phase 0.

### Task 0.2: Verify `CmcdReporter` lifecycle methods

The spec's "CML-side requirements" table marks these as "confirmed":
`reporter.start()`, `reporter.stop(flush)`, `reporter.flush()`, `reporter.update(partialState)`, `reporter.recordEvent(eventType, data)`.

- [ ] **Step 1: Open `libs/cmcd/src/CmcdReporter.ts` in the pinned checkout.** Search for each method by name; confirm signatures.

- [ ] **Step 2: For each method, record:** name, parameter types, return type, and any thrown-error contract. Save as a checklist in `plans/cmcd-cml-refactor/cml-version.md` (append).

**Acceptance:** All five lifecycle methods exist with signatures compatible with the spec's call sites.

### Task 0.3: Verify `CmcdEventType` enum membership

- [ ] **Step 1: Open `libs/cmcd/src/CmcdEventType.ts` in the pinned checkout.**

- [ ] **Step 2: Verify members and their CML constant names:** `ps → PLAY_STATE`, `e → ERROR`, `t → TIME_INTERVAL`, `c → CONTENT_ID`, `b → BACKGROUNDED_MODE`, `m → MUTE`, `um → UNMUTE`, `pe → PLAYER_EXPAND`, `pc → PLAYER_COLLAPSE`, `rr → RESPONSE_RECEIVED`. (Names verified against CML cmcd-v2.3.0 in `cml-version.md` Task 0.3.)

- [ ] **Step 3: For any missing member, file a CML PR adding it.** Example: if `pc` is absent, file `feat(cmcd): add CmcdEventType.PLAYBACK_CHANGE` upstream.

**Acceptance:** Every event type the shaka adapter intends to emit has a CML enum value, either in the pinned version or in a merged-and-released CML PR.

### Task 0.4: Verify request/response report methods

Spec calls these out: `createRequestReport(request, data)` and `recordResponseReceived(response, data)`.

- [ ] **Step 1: Open `CmcdReporter.ts` and inspect both methods.**

- [ ] **Step 2: For `createRequestReport`:** confirm the return type is `R & CmcdRequestReport<R['customData']>` (a derived object, not in-place mutation) — this drives the adapter's "copy fields back" pattern.

- [ ] **Step 3: For `recordResponseReceived`:** confirm whether the method returns anything (data the adapter must copy back to the response object) or is purely a state-recording call. Document the answer.

- [ ] **Step 4: Verify the data parameter shape for `recordResponseReceived` matches the spec's `{ttfb, ttlb, rc, url}`.** Note any field name mismatches (e.g., CML may use `responseCode` instead of `rc`).

**Acceptance:** Adapter's response-flow contract is unambiguous — we know whether to copy data back or not.

### Task 0.5: Verify `CmcdEventReportConfig` per-target shape

Spec's per-target field table includes `url`, `events`, `timeInterval`, `batchSize`, `enabledKeys`, `version`.

- [ ] **Step 1: Open `libs/cmcd/src/CmcdEventReportConfig.ts` (or wherever the type lives in the pinned tree).**

- [ ] **Step 2: Diff field-by-field against the spec's table.** Note any missing fields, extra fields, or type mismatches.

- [ ] **Step 3: Specifically confirm:** does `CmcdEventReportConfig` expose a `version` override field per target? If not, decide whether to (a) drop the per-target `version` from shaka's externs (simpler, defer to top-level only), or (b) file a CML PR to add it. Default to (a) unless there's a known shaka user need.

**Acceptance:** Spec's `CmcdTarget` typedef post-rename matches a real CML type, with any field-level differences explicitly resolved.

### Task 0.6: Verify `CmcdStreamingFormat` value parity

- [ ] **Step 1: Open `libs/cmcd/src/CmcdStreamingFormat.ts`.**

- [ ] **Step 2: Confirm string values:** `'d'` (DASH), `'ld'` (LL-DASH), `'h'` (HLS), `'lh'` (LL-HLS), `'s'` (Smooth), `'o'` (Other). These must match shaka's existing `shaka.util.CmcdManager.StreamingFormat` values exactly — Phase 2's alias re-export depends on this.

- [ ] **Step 3: If any value differs**, file CML upstream to align (CML is the spec source of truth, so shaka adapts; but check spec compliance first).

**Acceptance:** `cml.cmcd.CmcdStreamingFormat` and `shaka.util.CmcdManager.StreamingFormat` have identical string values.

### Task 0.7: Verify sequence-number behavior

Spec marks this "likely present; verify per v2 spec".

- [ ] **Step 1: Search `CmcdReporter.ts` and the encoders for `sn` handling.** Determine: does the reporter own per-target sequence counters? Does it reset on `sid` change?

- [ ] **Step 2: Compare to shaka's current behavior** in [`cmcd_manager.js`](../../lib/util/cmcd_manager.js) (search for `cmcdSequenceNumbers_`). If CML's behavior differs from shaka's existing behavior (e.g., per-target vs. per-mode), document the difference. This is a Phase 3 wire-format change to call out.

**Acceptance:** Sequence-number behavior is documented; if it diverges from shaka's existing behavior, the divergence is in the Phase 3 PR description.

### Task 0.8: Verify `requester` callback contract

- [ ] **Step 1: Open `CmcdReporter.ts`; find where `config.requester` is invoked.**

- [ ] **Step 2: Confirm:** the request object passed in has `{url, method, headers, body}` shape; the response promise must resolve to `{status: number}`; rejection vs. resolution-with-non-200 semantics.

- [ ] **Step 3: Confirm body type.** Spec says CML emits string (structured-fields) or Blob (JSON). Verify both code paths exist; this informs the adapter's body-conversion logic in Task 3.9.

**Acceptance:** Adapter's `requester` shim (Task 3.9) has a complete contract to match.

### Task 0.9: Resolve any CML gaps via upstream PRs

- [ ] **Step 1: Aggregate any gaps found in Tasks 0.2–0.8.**

- [ ] **Step 2: For each gap, decide:** (a) work around in adapter (acceptable for small things), (b) file CML PR (preferred — single source of truth principle from spec § Motivation), or (c) drop the dependent feature from this refactor (defer to follow-up).

- [ ] **Step 3: File and merge CML PRs as needed.** Pin the new CML version after release and update `cml-version.md`.

- [ ] **Step 4: Re-run Tasks 0.2–0.8 against the new pinned version** if changes shipped.

**Acceptance:** Every spec assertion about CML's API is either confirmed against the pinned CML version or has an actionable plan (work around / drop / wait for upstream).

### Phase 0 verification gate

- [ ] `plans/cmcd-cml-refactor/cml-version.md` lists the pinned CML version and a complete CML-API verification checklist.
- [ ] All "confirmed" items in spec's CML-side requirements table are re-confirmed in writing.
- [ ] All "verify" items are resolved.
- [ ] No new shaka-player commits.

---

## Phase 1: Vendor `third_party/cml-cmcd/` and route encoding through it

**Goal:** Add the vendored Closure port of `@svta/cml-cmcd`. Refactor shaka's static encoding helpers (`serialize`, `toQuery`, `appendQueryToUri`, `urlToRelativePath`) to delegate to CML's encoders. State machine, sequence numbers, event timing, and public API stay unchanged.

**Behavior:** Preserved, with **two documented intentional wire-format changes** for spec conformance:

1. `nor` URLs become root-relative (CML's spec-conformant output) rather than path-relative.
2. `sf` (streaming format) drops the non-spec values `'ld'` (LL-DASH) and `'lh'` (LL-HLS); LL DASH emits `sf=d`, LL HLS emits `sf=h`. Per Phase 0 verification (`cml-version.md` finding #1): `'ld'`/`'lh'` come from an old unreleased CMCD draft and are not in CTA-5004 or CTA-5004-B; CML correctly omits them.

Phase 1 PR description must call out both. Diff testing during this phase surfaces any other unintentional divergences for case-by-case decisions.

**Reference PRs to consult for patterns:**
- [hls.js #7725](https://github.com/video-dev/hls.js/pull/7725) — note: their request-mode encoding uses CML encoders directly without going through `CmcdReporter`. Our Phase 3 changes that to always-on reporter; Phase 1 is closer to their request-mode pattern (encoders only).
- [`third_party/closure-uri/`](../../third_party/closure-uri/) — vendoring layout precedent.

### Task 1.1: Skeleton

**Files:**
- Create: `third_party/cml-cmcd/SUMMARY.txt`
- Create: `third_party/cml-cmcd/LICENSE`
- Create: `third_party/cml-cmcd/NOTICE`
- Modify: `third_party/SUMMARY.txt` — append `cml-cmcd` entry per spec § "SUMMARY.txt format"

- [ ] **Step 1: Copy CML's `LICENSE` and `NOTICE` files** from the pinned checkout into `third_party/cml-cmcd/`.

- [ ] **Step 2: Write `third_party/cml-cmcd/SUMMARY.txt`** using the format from spec § "SUMMARY.txt format". Include the pinned version + SHA from `cml-version.md`.

- [ ] **Step 3: Append the `cml-cmcd` block to `third_party/SUMMARY.txt`** following the existing entry style for `closure-uri` and `language-mapping-list`.

- [ ] **Step 4: Commit:**

```
chore(third_party): add cml-cmcd vendoring skeleton (LICENSE, NOTICE, SUMMARY.txt)
```

**Acceptance:** `third_party/cml-cmcd/` directory exists with license metadata; `third_party/SUMMARY.txt` references it.

### Task 1.2: Port type definitions (typedefs)

The spec § "Subset to port" enumerates ~25 typedef files. These translate to closure `@typedef` declarations under `cml.cmcd.*`.

**Files:** Create files per spec's "Type definitions" row (e.g., `third_party/cml-cmcd/cmcd.js`, `cmcd_data.js`, `cmcd_request.js`, etc.) — file names follow the snake_case convention from spec § "File naming and namespace conventions".

- [ ] **Step 1: For each TS type-only file in the spec's list, port to a `.js` file** with a single `goog.provide('cml.cmcd.X')` and a JSDoc `@typedef`.

  Mapping pattern for an interface like `CmcdReporterConfig`:
  ```typescript
  // CmcdReporterConfig.ts
  export interface CmcdReporterConfig {
    sid?: string;
    cid?: string;
    transmissionMode?: CmcdTransmissionMode;
    // ...
  }
  ```
  becomes:
  ```javascript
  // third_party/cml-cmcd/cmcd_reporter_config.js
  goog.provide('cml.cmcd.CmcdReporterConfig');

  /**
   * @typedef {{
   *   sid: (string|undefined),
   *   cid: (string|undefined),
   *   transmissionMode: (cml.cmcd.CmcdTransmissionMode|undefined),
   *   ...
   * }}
   */
  cml.cmcd.CmcdReporterConfig;
  ```
  No runtime code — just the typedef.

- [ ] **Step 2: For union types (`CmcdValue`, `CmcdKey`, etc.) and `ValueOf<>` generics**, expand to closure-friendly union typedefs. `ValueOf<CmcdObjectType>` becomes the literal string union (e.g., `('m'|'a'|'v'|'av'|'i'|'c'|'tt'|'k'|'o')`).

- [ ] **Step 3: Skip Phase 1 for any typedef that's only consumed by `CmcdReporter`** (which we port in Task 1.8). They're easier to add when the consumer exists.

- [ ] **Step 4: Run Closure type-check via `python3 build/check.py`.** Fix any unresolved-type errors. Files don't need to be in `build/types/core` yet — that happens in Task 1.9.

- [ ] **Step 5: Commit:**

```
chore(cmcd): port cml-cmcd type definitions as closure typedefs
```

**Acceptance:** All type-definition files compile; no runtime behavior change.

### Task 1.3: Port enums

**Files:** Create per spec's "Enums" row (e.g., `cmcd_object_type.js`, `cmcd_streaming_format.js`, `cmcd_player_state.js`, `cmcd_event_type.js`, `cmcd_reporting_mode.js`, `cmcd_transmission_mode.js`, `cmcd_header_field.js`, `cmcd_stream_type.js`).

- [ ] **Step 1: For each TS string-enum file, port to a closure `@enum {string}`.**

  Example pattern for CML's `as const` enum:
  ```typescript
  // CmcdStreamingFormat.ts (CML cmcd-v2.3.0)
  export const CmcdStreamingFormat = {
    DASH: 'd',
    HLS: 'h',
    SMOOTH: 's',
    OTHER: 'o',
  } as const;
  export type CmcdStreamingFormat = ValueOf<typeof CmcdStreamingFormat>;
  ```
  becomes:
  ```javascript
  // third_party/cml-cmcd/cmcd_streaming_format.js
  goog.provide('cml.cmcd.CmcdStreamingFormat');

  /** @enum {string} */
  cml.cmcd.CmcdStreamingFormat = {
    DASH: 'd',
    HLS: 'h',
    SMOOTH: 's',
    OTHER: 'o',
  };
  ```

- [ ] **Step 2: Verify enum string values** against the pinned CML source one last time before committing — typos here are silent until runtime.

- [ ] **Step 3: Run `python3 build/check.py`.**

- [ ] **Step 4: Commit:**

```
chore(cmcd): port cml-cmcd enums to closure @enum
```

**Acceptance:** All enum files compile; values match Task 0.6's verification.

### Task 1.4: Port constants

**Files:** Create per spec's "Constants" row (~16 files: `cmcd_default_time_interval.js`, `cmcd_event_keys.js`, `cmcd_formatter_map.js`, etc.).

- [ ] **Step 1: For each TS constant module, port to a closure module with `goog.provide('cml.cmcd.X')` and a `const` export.**

  TS pattern:
  ```typescript
  // CMCD_KEYS.ts
  export const CMCD_KEYS = ['br', 'd', 'ot', /* ... */] as const;
  ```
  Closure pattern:
  ```javascript
  // third_party/cml-cmcd/cmcd_keys.js
  goog.provide('cml.cmcd.CMCD_KEYS');

  /** @const {!Array<cml.cmcd.CmcdKey>} */
  cml.cmcd.CMCD_KEYS = ['br', 'd', 'ot', /* ... */];
  ```

- [ ] **Step 2: For `CMCD_FORMATTER_MAP` (the most complex constant — function map):** preserve function references; declare types as `!Object<string, function(...)>`. Verify Closure ADVANCED can rename the keys safely (it can, since they're string literals).

- [ ] **Step 3: Run `python3 build/check.py`.** Iterate on type annotations until clean.

- [ ] **Step 4: Commit:**

```
chore(cmcd): port cml-cmcd constants to closure modules
```

**Acceptance:** All constant files compile; values match upstream.

### Task 1.5: Port `cml_utils.js` (uuid shim)

Per spec § "@svta/cml-utils dependency handling".

**Files:**
- Create: `third_party/cml-cmcd/cml_utils.js`

- [ ] **Step 1: Write the shim:**

```javascript
// third_party/cml-cmcd/cml_utils.js
goog.provide('cml.cmcd.uuid');

/**
 * UUID shim for the vendored @svta/cml-cmcd port. The shaka adapter always
 * sets `sid` explicitly, so this codepath should be dead at runtime — the
 * Closure compiler will strip it. Kept for verbatim parity with upstream
 * CmcdReporter source so per-bump diffs stay trivial.
 *
 * @return {string}
 */
cml.cmcd.uuid = function() {
  return crypto.randomUUID();
};
```

- [ ] **Step 2: Confirm `crypto.randomUUID()` is polyfilled** by [`lib/polyfill/random_uuid.js`](../../lib/polyfill/random_uuid.js). It is — but verify the polyfill loads before any path that calls `cml.cmcd.uuid` (it shouldn't be called at runtime per Task 3.8, but defense in depth).

- [ ] **Step 3: Commit:**

```
chore(cmcd): add cml-cmcd uuid shim wrapping crypto.randomUUID
```

**Acceptance:** `cml.cmcd.uuid` exists; runs in browsers (verified post-polyfill).

### Task 1.6: Port encoders

**Files:** Create per spec's "Encoders" row (~12 files: `encode_cmcd.js`, `encode_prepared_cmcd.js`, `prepare_cmcd_data.js`, `to_cmcd_headers.js`, `to_cmcd_query.js`, `to_cmcd_url.js`, `to_cmcd_value.js`, `append_cmcd_headers.js`, `append_cmcd_query.js`, `to_prepared_cmcd_headers.js`, `ensure_headers.js`).

- [ ] **Step 1: Port each encoder file as a closure module** with `goog.provide('cml.cmcd.encodeCmcd')` (or the appropriate name) and the function as the provided symbol.

  TS pattern (top-level functional export):
  ```typescript
  export function encodeCmcd(data: CmcdData, options?: CmcdEncodeOptions): string { /* ... */ }
  ```
  Closure pattern:
  ```javascript
  goog.provide('cml.cmcd.encodeCmcd');
  goog.require('cml.cmcd.CmcdData');
  goog.require('cml.cmcd.CmcdEncodeOptions');
  // ... other requires

  /**
   * @param {cml.cmcd.CmcdData} data
   * @param {cml.cmcd.CmcdEncodeOptions=} options
   * @return {string}
   */
  cml.cmcd.encodeCmcd = function(data, options) { /* port body */ };
  ```

- [ ] **Step 2: Translate TS-only constructs as you encounter them:**
  - Type-only imports → drop (already declared as typedefs in Task 1.2).
  - `as const` → not needed; const literals are inferred narrowly enough.
  - Optional-chaining (`a?.b`) → fine in modern JS; targets are evergreen browsers.
  - Nullish coalescing (`??`) → fine.
  - Type guards / narrowing → expand to explicit `if (typeof x === 'string')` etc.
  - Generic functions → drop type params; rely on JSDoc unions.

- [ ] **Step 3: Preserve algorithm logic verbatim.** The whole point of the port is wire-format compliance via shared logic. Don't "improve" or rearrange — keeping a small diff to upstream means future bumps are mechanical.

- [ ] **Step 4: Run `python3 build/check.py` after each batch of 3-4 files** to keep type-check feedback loops short.

- [ ] **Step 5: Commit:**

```
chore(cmcd): port cml-cmcd encoders to closure
```

**Acceptance:** Every encoder file from spec's list exists, type-checks, and is structurally identical to the upstream TS modulo erased types.

### Task 1.7: Port helpers (`upConvertToV2`, `resolveVersion`)

**Files:**
- Create: `third_party/cml-cmcd/up_convert_to_v2.js`
- Create: `third_party/cml-cmcd/resolve_version.js`

- [ ] **Step 1: Port both helpers** following the same pattern as encoders (Task 1.6).

- [ ] **Step 2: Run `python3 build/check.py`.**

- [ ] **Step 3: Commit:**

```
chore(cmcd): port cml-cmcd version-resolution helpers
```

**Acceptance:** Both helpers compile.

### Task 1.8: Port `CmcdReporter`

**Files:**
- Create: `third_party/cml-cmcd/cmcd_reporter.js`

This is the largest single file (the reporter class itself). Even though Phase 1 doesn't *use* `CmcdReporter` (Phase 3 does), porting it now means Phase 3 only has to write the adapter.

- [ ] **Step 1: Port the class verbatim** from `libs/cmcd/src/CmcdReporter.ts`.
  - `goog.provide('cml.cmcd.CmcdReporter')`.
  - `goog.require` all needed encoders, helpers, and typedefs.
  - Class methods preserve TS signatures translated to JSDoc.

- [ ] **Step 2: Cml-utils dependency erasure.** TS source imports `uuid()` from `@svta/cml-utils`. Replace with `goog.require('cml.cmcd.uuid')` and `cml.cmcd.uuid()` calls. (Per spec, the adapter always supplies `sid`, so this codepath is dead — but keep it for upstream-diff parity.)

- [ ] **Step 3: Type-only `HttpRequest`/`HttpResponse` imports erase.** Replace with local typedefs declared in Task 1.2 if needed, or with the `cml.cmcd.CmcdRequest`/`CmcdResponse` typedefs.

- [ ] **Step 4: Run `python3 build/check.py`.** Expect to iterate on Closure-strict type errors here; the reporter is the most complex single file.

- [ ] **Step 5: Commit:**

```
chore(cmcd): port cml-cmcd CmcdReporter to closure
```

**Acceptance:** `cml.cmcd.CmcdReporter` compiles. Not yet wired to anything.

### Task 1.9: Build integration

**Files:**
- Modify: `build/types/core` — add `+../../third_party/cml-cmcd/*.js` entries (one per ported file)
- Modify: `shaka-player.uncompiled.js` — only if any vendored file is self-registering; almost certainly none are, since the port is pure library code.
- Modify: `project-words.txt` — add CMCD vocabulary that fails the spell-checker

- [ ] **Step 1: Append vendored file paths to `build/types/core`** alphabetically among the existing `third_party/` entries (currently `closure-uri/uri.js`, `closure-uri/utils.js`, `language-mapping-list/language-mapping-list.js`). Insert the `cml-cmcd/*.js` entries in order.

- [ ] **Step 2: Run `python3 build/check.py`.** This is the first check that builds with the vendored port included in the bundle. Closure may flag unused symbols, missing requires, or type drift.

- [ ] **Step 3: Run `python3 build/build.py`.** Confirm the bundle compiles with the vendored port inside.

- [ ] **Step 4: Append spell-checker vocab to `project-words.txt`.** New CMCD-only words: `Cmcd` (likely already present), `cml`, `svta`, `mtp`, `nrr`, `cmsd`, `cmsds`, `cmsdd`, `ttfb`, `ttlb`, `ps`, `bg`, `pe`, `pc`, `rr`, `um`, `sta`, ... Run `python3 build/check.py` to see which are missing; add only those. (Note: `ld` and `lh` are dropped in Task 1.10b as non-spec values; if they were previously in `project-words.txt`, remove them.)

- [ ] **Step 5: Commit:**

```
build(cmcd): wire third_party/cml-cmcd into the core build variant
```

**Acceptance:** `build/all.py` succeeds with the vendored port included; spell-checker passes.

### Task 1.10: Refactor shaka encoders to delegate

**Files:**
- Modify: `lib/util/cmcd_manager.js` — replace static methods `serialize`, `toQuery`, `appendQueryToUri`, `urlToRelativePath` with delegations to CML

Per spec § Phase 1.

- [ ] **Step 1: Identify the static methods.** Grep:
  ```bash
  grep -n "static serialize\|static toQuery\|static appendQueryToUri\|static urlToRelativePath" lib/util/cmcd_manager.js
  ```

- [ ] **Step 2: Replace each method body with a call to the CML equivalent.**
  - `serialize(data)` → `cml.cmcd.encodeCmcd(data)` (or whichever encoder produces the same shape).
  - `toQuery(data)` → `cml.cmcd.toCmcdQuery(data)`.
  - `appendQueryToUri(uri, query)` → `cml.cmcd.appendCmcdQuery(uri, query)` (verify signature; may need an adapter function).
  - `urlToRelativePath(url, base)` → drop entirely; CML's `appendCmcdQuery` and `prepareCmcdData` handle `nor` URL relativization internally using `url.origin` as `baseUrl`. **Wire-format change**: produces root-relative URLs instead of path-relative.

- [ ] **Step 3: Add `goog.require('cml.cmcd.encodeCmcd')` etc.** to the file's `goog.require` block.

- [ ] **Step 4: Run `python3 build/check.py`.** Fix any type or import errors.

**Acceptance:** All four static methods now delegate. Manager file is shorter by the deleted method bodies.

### Task 1.10b: Drop non-spec `'ld'`/`'lh'` from `StreamingFormat`

**Files:**
- Modify: `lib/util/cmcd_manager.js`

Per Phase 0 finding #1 (`cml-version.md` Task 0.6): shaka's `'ld'` (LOW_LATENCY_DASH) and `'lh'` (LOW_LATENCY_HLS) values are not in CTA-5004 or CTA-5004-B. CML correctly omits them. Drop them from shaka in Phase 1 alongside encoding delegation; this is the second of Phase 1's two intentional wire-format changes (the other is `nor` URL relativization).

- [ ] **Step 1: Remove the non-spec values from the enum** in `lib/util/cmcd_manager.js:1612-1619`:

```javascript
shaka.util.CmcdManager.StreamingFormat = {
  DASH: 'd',
  HLS: 'h',
  SMOOTH: 's',
  OTHER: 'o',
};
```

- [ ] **Step 2: Simplify `setLowLatency` body** at `cmcd_manager.js:177-194`. The function currently flips `this.sf_` between `DASH ↔ LOW_LATENCY_DASH` and `HLS ↔ LOW_LATENCY_HLS`; after the drop, the LL state has no effect on `sf_`. Either delete the `if (this.lowLatency_)` branches entirely (preferred — `sf_` is set at manifest-load time and stays put), or leave a no-op stub for the LL flag if other code reads it.

- [ ] **Step 3: Grep for remaining LL enum references.**
  ```bash
  grep -n "LOW_LATENCY_DASH\|LOW_LATENCY_HLS\|StreamingFormat\.LOW_LATENCY" lib/ test/
  ```
  Update any callers to drop the LL branches. Likely candidates: `getStreamFormat_` and any tests that asserted `sf=ld`/`sf=lh`.

- [ ] **Step 4: Update tests** in `test/util/cmcd_manager_unit.js` that expected `sf=ld` or `sf=lh`. After this change, LL DASH content emits `sf=d`; LL HLS emits `sf=h`. The assertions become identical to their non-LL counterparts.

- [ ] **Step 5: Run `python3 build/check.py` and `python3 build/test.py`.** Fix any compile errors and update broken assertions per Step 4.

- [ ] **Step 6: Commit:**

```
fix(cmcd): drop non-spec 'ld'/'lh' StreamingFormat values

CTA-5004 and CTA-5004-B define only 'd', 'h', 's', 'o' for the sf key.
shaka's 'ld' (LOW_LATENCY_DASH) and 'lh' (LOW_LATENCY_HLS) come from an
old unreleased draft and are not in either spec. CML correctly omits
them. Wire change: LL DASH now emits sf=d, LL HLS now emits sf=h.
```

**Acceptance:** Enum has 4 values (DASH, HLS, SMOOTH, OTHER). `setLowLatency` no longer mutates `sf_`. Tests pass with non-LL `sf` values for LL content. Phase 1 PR description lists this as the second intentional wire-format change alongside `nor` URL relativization.

### Task 1.11: Diff testing — capture baseline

Before changing test assertions, capture what the current (pre-delegation) wire output looks like for representative scenarios. The baseline is what we compare against after delegation.

**Files:**
- Create: `plans/cmcd-cml-refactor/diff-test-baseline.json` (temporary, deleted before Phase 1 ships)

- [ ] **Step 1: Stash Task 1.10's changes** so the manager is back to pre-delegation behavior.

```bash
git stash
```

- [ ] **Step 2: Run the existing unit tests with output capture.** Add a test-only dump that serializes every wire output produced during the suite to JSON: keyed by test name, value `{query, headers, nor}`. Run the suite, write `diff-test-baseline.json`.

- [ ] **Step 3: Restore Task 1.10's changes:**

```bash
git stash pop
```

- [ ] **Step 4: Run the suite again** with the same dumping logic; produce `diff-test-after.json`.

- [ ] **Step 5: Diff the two JSON files.**

```bash
diff -u plans/cmcd-cml-refactor/diff-test-baseline.json plans/cmcd-cml-refactor/diff-test-after.json
```

- [ ] **Step 6: For each diff, classify:**
  - **`nor` URLs path → root-relative** — expected per spec; document in PR description.
  - **Key ordering differences** — if CML emits keys in a different sorted order, accept (it's spec-conformant) and update assertions.
  - **Escaping differences** — if CML escapes string values differently (spec § Structured Fields), accept and update assertions.
  - **Numeric formatting** (rounding, integer vs. float) — investigate; one of CML or shaka is likely off-spec. Decide per case: align via CML upstream PR or accept as a fix.
  - **Missing or extra keys** — investigate; this is a state-machine vs. encoder boundary issue. Likely something in the manager still does its own filtering.
  - **`v=1` field present when v=1** — spec calls out CML omits `v` for v=1. If shaka's tests expected `v=1` present, that's a wire-format alignment.

- [ ] **Step 7: Catalog all classified diffs** in `plans/cmcd-cml-refactor/diff-test-classification.md` (also temporary; eventually summarized in PR description).

**Acceptance:** Every encoding-output diff between pre-delegation and post-delegation is classified as: (a) intentional alignment with CML, (b) acceptable spec-conformance fix, or (c) bug to fix before shipping Phase 1.

### Task 1.12: Update test assertions for accepted divergences

**Files:**
- Modify: `test/util/cmcd_manager_unit.js` — update `nor` assertions to root-relative, update other assertions per Task 1.11 classifications.

- [ ] **Step 1: Update `nor` URL assertions.** Search:
  ```bash
  grep -n "nor.*=" test/util/cmcd_manager_unit.js
  ```
  Convert path-relative expected values to root-relative.

- [ ] **Step 2: Apply each Task 1.11 (a)/(b) classification** to its corresponding assertion(s).

- [ ] **Step 3: For (c) classifications** (bugs), open separate sub-tasks: fix in CML upstream if it's a CML bug, or fix in the adapter's pre-encoding step if it's a shaka-specific data-shaping issue. **Do not ship Phase 1 with unresolved (c)-classified diffs.**

- [ ] **Step 4: Run `python3 build/test.py`.** All tests must pass.

- [ ] **Step 5: Delete temporary diff-test files:**
  ```bash
  rm plans/cmcd-cml-refactor/diff-test-baseline.json
  rm plans/cmcd-cml-refactor/diff-test-after.json
  rm plans/cmcd-cml-refactor/diff-test-classification.md
  ```
  But preserve a one-paragraph summary of accepted changes for the PR description.

**Acceptance:** Test suite passes; intentional wire-format changes are documented; no unresolved bugs.

### Task 1.13: Demo smoke test

- [ ] **Step 1: Run `python3 build/all.py`** to produce the full bundle including demo.

- [ ] **Step 2: Serve the demo locally** (per shaka's standard demo serve instructions in `demo/`).

- [ ] **Step 3: Configure CMCD enabled** with both query and header transmission modes; load a test stream; verify CMCD data appears in network requests as expected (use browser DevTools network tab, look for `CMCD-Request` headers or `?CMCD=` query strings).

- [ ] **Step 4: Compare to the same flow on `main` branch** if any visual irregularity. The wire output should match expected post-delegation behavior (root-relative `nor`, etc.).

**Acceptance:** Demo plays content with CMCD enabled in both transmission modes; no JS errors in console.

### Task 1.14: Phase 1 PR

**Files:**
- Modify: `MEMORY.md` (this plan, not project memory) — mark Phase 1 done

- [ ] **Step 1: Stage all Phase 1 commits.** Verify the diff totals approximately match spec § Phase 1 (~3000 lines added in `third_party/cml-cmcd/`, ~500 changed in `cmcd_manager.js`).

- [ ] **Step 2: Open PR with title:**
  ```
  refactor(cmcd): vendor @svta/cml-cmcd, delegate encoding to CML (1/3)
  ```

- [ ] **Step 3: PR description includes:**
  - Overview: "Phase 1 of 3 in the CMCD CML refactor (see [spec.md](plans/cmcd-cml-refactor/spec.md))."
  - What's vendored (link to spec § "The vendored port").
  - **Wire-format changes**: enumerate the accepted divergences from Task 1.11 classifications, headlining `nor` URL relativization.
  - Behavior preserved otherwise: state machine, sequence numbers, event timing, public API.
  - Pinned CML version + SHA from `cml-version.md`.
  - Build/test verification: paste output of `python3 build/check.py` and `python3 build/test.py`.

- [ ] **Step 4: Wait for review; address feedback; merge.**

**Acceptance:** PR merged; main branch builds, tests pass, demo works.

### Phase 1 verification gate

- [ ] `python3 build/check.py` passes.
- [ ] `python3 build/test.py` passes.
- [ ] `python3 build/all.py` passes (bundle, docs).
- [ ] Demo loads and plays content with CMCD enabled in both query and header modes.
- [ ] Wire-format diff classifications resolved (no class (c) remainders).
- [ ] Phase 1 PR merged.

---

## Phase 2: Adopt CML's constants/enums; delete shaka's duplicates

**Goal:** Replace shaka's internal `shaka.util.CmcdManager.{ObjectType, Version, StreamType, CmcdKeys, CmcdV2Constants, CmcdV2Keys, CmcdMode}` with `cml.cmcd.*` equivalents. Re-export `shaka.util.CmcdManager.StreamingFormat` as an alias of `cml.cmcd.CmcdStreamingFormat` to preserve the only `@export`ed enum.

**Behavior:** Pure dedupe. No behavioral change. ~150 lines deleted from the manager.

### Task 2.1: Map shaka constants to CML equivalents

- [ ] **Step 1: For each shaka constant/enum, identify its CML twin.**

  | Shaka | CML |
  |---|---|
  | `shaka.util.CmcdManager.ObjectType` | `cml.cmcd.CmcdObjectType` |
  | `shaka.util.CmcdManager.Version` | `cml.cmcd.CmcdVersion` (numeric `1`/`2`) |
  | `shaka.util.CmcdManager.StreamType` | `cml.cmcd.CmcdStreamType` |
  | `shaka.util.CmcdManager.CmcdKeys` | `cml.cmcd.CMCD_KEYS` (or split: `CMCD_REQUEST_KEYS`, `CMCD_RESPONSE_KEYS`, etc.) |
  | `shaka.util.CmcdManager.CmcdV2Constants` | scattered across `cml.cmcd.CMCD_V2`, `CMCD_V2_KEYS`, etc. |
  | `shaka.util.CmcdManager.CmcdV2Keys` | `cml.cmcd.CMCD_V2_KEYS` (verify exact name) |
  | `shaka.util.CmcdManager.CmcdMode` | `cml.cmcd.CmcdReportingMode` |

- [ ] **Step 2: Verify every value matches.** For each shaka constant, dump its values; compare to CML's. Any mismatch is a Phase 2 blocker.

- [ ] **Step 3: Document mappings** (one line each) inline in the cmcd_manager.js commit, or in a brief `plans/cmcd-cml-refactor/phase2-mapping.md`.

**Acceptance:** Every shaka constant has a confirmed CML equivalent with matching values.

### Task 2.2: Replace internal references

**Files:**
- Modify: `lib/util/cmcd_manager.js` — rewrite each `shaka.util.CmcdManager.X` reference to `cml.cmcd.Y`

- [ ] **Step 1: Add `goog.require` lines** for each CML symbol used.

- [ ] **Step 2: Use a search-and-replace approach.** For each mapping in Task 2.1, find all references:
  ```bash
  grep -n "shaka\.util\.CmcdManager\.ObjectType" lib/util/cmcd_manager.js
  ```
  And replace with the CML name.

- [ ] **Step 3: Run `python3 build/check.py`** after each constant migration to catch broken references.

**Acceptance:** No internal references to the soon-to-be-deleted shaka constants remain.

### Task 2.3: Re-export `StreamingFormat`

**Files:**
- Modify: `lib/util/cmcd_manager.js` — add the alias

After Phase 1 Task 1.10b dropped the non-spec `'ld'`/`'lh'` values, shaka's `StreamingFormat` enum is a strict subset of CML's: same 4 spec-conformant values (`'d'`/`'h'`/`'s'`/`'o'`), same constant names (DASH/HLS/SMOOTH/OTHER). The alias re-export is straightforward; no derived/extended enum needed.

- [ ] **Step 1: Add the re-export:**

```javascript
/**
 * @enum {string}
 * @export
 */
shaka.util.CmcdManager.StreamingFormat = cml.cmcd.CmcdStreamingFormat;
```

- [ ] **Step 2: Verify the `@export` annotation is preserved.** Closure ADVANCED depends on this exactly — any drift renames the public symbol.

- [ ] **Step 3: Run `python3 build/check.py`.** If Closure flags this as needing a different alias pattern (e.g., per-key copy), use the pattern that preserves both the `@export` and the value identity.

**Acceptance:** `shaka.util.CmcdManager.StreamingFormat` is a CML alias; values identical; export preserved.

### Task 2.4: Delete duplicate definitions

**Files:**
- Modify: `lib/util/cmcd_manager.js` — delete the now-unused constant definitions

- [ ] **Step 1: Delete `shaka.util.CmcdManager.ObjectType`, `Version`, `StreamType`, `CmcdKeys`, `CmcdV2Constants`, `CmcdV2Keys`, `CmcdMode`.** Keep `StreamingFormat` (the alias).

- [ ] **Step 2: Run `python3 build/check.py`.** Closure must complain if anything still references a deleted symbol.

- [ ] **Step 3: Run `python3 build/test.py`.** Tests must still pass — they use the manager's public surface, which doesn't expose these internals.

**Acceptance:** Manager file shrinks by ~150 lines; check + tests pass.

### Task 2.5: Demo smoke test

- [ ] **Step 1: Run `python3 build/all.py`.** Same as Task 1.13.
- [ ] **Step 2: Verify demo with CMCD enabled.** Same as Task 1.13.

**Acceptance:** Demo works.

### Task 2.6: Phase 2 PR

- [ ] **Step 1: Open PR with title:**
  ```
  refactor(cmcd): adopt CML constants/enums, delete shaka duplicates (2/3)
  ```

- [ ] **Step 2: PR description includes:**
  - Overview: "Phase 2 of 3 in the CMCD CML refactor."
  - List of constants migrated (link to Task 2.1 mapping table).
  - Public-API note: `shaka.util.CmcdManager.StreamingFormat` re-exported as alias; values unchanged.
  - Behavior: no change.
  - Build/test verification.

- [ ] **Step 3: Merge.**

**Acceptance:** Phase 2 PR merged.

### Phase 2 verification gate

- [ ] `python3 build/check.py` passes.
- [ ] `python3 build/test.py` passes.
- [ ] `python3 build/all.py` passes.
- [ ] Demo works with CMCD enabled.
- [ ] Phase 2 PR merged.

---

## Phase 3: Replace state machine with `CmcdReporter`

**Goal:** Rewrite [`lib/util/cmcd_manager.js`](../../lib/util/cmcd_manager.js) as a thin adapter (~250 lines) that delegates state, encoding, and event timing to `cml.cmcd.CmcdReporter`. Apply experimental v2 config renames. Delete CMCD wire-format tests; add adapter glue + smoke tests.

**Behavior:** Behavior shifts — this is the high-risk PR. Watch for: state-transition timing differences (CML vs. shaka's existing transitions), per-target sequence-number behavior (Task 0.7), event-mode dispatch shape.

### Task 3.1: Re-verify CML-side requirements

CML may have evolved between Phase 0 and Phase 3 if Phases 1+2 took weeks.

- [ ] **Step 1: Re-run Tasks 0.2–0.8** against the currently pinned CML version (which may need a bump if upstream landed relevant changes).

- [ ] **Step 2: If a bump is warranted**, update the vendored port and re-validate Phase 1 + Phase 2. (This is unusual but possible.)

- [ ] **Step 3: Update `plans/cmcd-cml-refactor/cml-version.md`** with current pinned version and verification status.

**Acceptance:** CML-side requirements all confirmed at the version we'll ship Phase 3 against.

### Task 3.2: Sketch adapter file structure

Before writing code, plan the adapter's internal layout. The spec already gives the broad shape; this task fixes the file structure.

- [ ] **Step 1: Decide whether to keep all adapter logic in one file or split.** Recommend: keep in `lib/util/cmcd_manager.js` (shaka convention; the adapter is small enough). Don't pre-emptively split into `cmcd_adapter.js` + `cmcd_state.js` — that's premature.

- [ ] **Step 2: Outline the file as a comment block at the top of the new manager:**

```
// Adapter responsibilities:
//   1. Lifecycle: construct/start/stop CmcdReporter from configure() and reset()
//   2. Player wiring: <video> + Player events → reporter.update + recordEvent
//   3. Request mode: applyRequestData → reporter.createRequestReport
//   4. Response mode: applyResponseData → reporter.recordResponseReceived
//   5. Event mode: requester callback → NetworkingEngine.request
//   6. Config translation: shaka.extern.CmcdConfiguration → CmcdReporterConfig
//   7. Public-API back-compat: re-exports for StreamingFormat, EventType, PlayerState
```

- [ ] **Step 3: Identify which existing methods stay vs. go.** Keep: `setMediaElement`, `configure`, `reset`, `applyRequestData`, `applyResponseData`. Delete: all `applyRequest_`/`applyManifestData`/`applyManifestRequest_`/`getObjectType_` (kept) / `getBitrate_` (kept) / `getDuration_` (kept) / encoder helpers (gone after Phase 1, but verify) / event timer code / sequence-number tracking / MSD computation.

**Acceptance:** Clear picture of what gets written, what gets kept, what gets deleted.

### Task 3.3: Lifecycle wiring

**Files:**
- Modify: `lib/util/cmcd_manager.js`

The lifecycle is the foundation; all other tasks depend on the reporter being constructed correctly.

- [ ] **Step 1: Write the constructor** to store the player and config but NOT construct the reporter yet. The reporter needs `setMediaElement` to have been called and `enabled: true` to be set.

- [ ] **Step 2: Write `setMediaElement(mediaElement)`:**
  - Save `this.video_ = mediaElement`.
  - If `this.config_.enabled` and reporter not yet constructed, construct it now via `this.maybeStartReporter_()`.
  - Subscribe to `<video>` events (per spec's lifecycle table).

- [ ] **Step 3: Write `configure(newConfig)`:**
  - If `enabled: false → enabled: true`: construct reporter via `maybeStartReporter_`.
  - If `enabled: true → enabled: false`: call `this.reporter_.stop(true)`; null out `this.reporter_`; remove event listeners.
  - If `enabled: true → enabled: true` and material change (sessionId, contentId, version, transmissionMode, eventTargets): tear down + reconstruct (spec § "On configure() with materially-changed config").
  - If only `includeKeys` changed: `this.reporter_.update(...)` may be enough — verify against CML.

- [ ] **Step 4: Write `reset()`:**
  - If reporter exists: `this.reporter_.stop(true)`; null out.
  - Remove all event listeners (existing `eventManager_.removeAll()`).

- [ ] **Step 5: Write `maybeStartReporter_()`:**
  - Only if `this.config_.enabled` AND `this.video_` (need media element for state).
  - Build `CmcdReporterConfig` via `toReporterConfig_(this.config_)` (Task 3.8).
  - Construct: `this.reporter_ = new cml.cmcd.CmcdReporter(reporterConfig)`.
  - Call `this.reporter_.start()`.

- [ ] **Step 6: Implement `enabled: false` short-circuit** in `applyRequestData` and `applyResponseData` — both early-return if `!this.reporter_`.

- [ ] **Step 7: Run `python3 build/check.py`.**

**Acceptance:** Lifecycle compiles. No tests yet — Task 3.13 adds them.

### Task 3.4: `applyRequestData` rewrite

**Files:**
- Modify: `lib/util/cmcd_manager.js`

- [ ] **Step 1: Reimplement `applyRequestData(type, request, context)`:**
  - Early-return if `!this.reporter_` (disabled).
  - Extract shaka-specific fields via existing helpers: `getObjectType_(type, context)`, `getBitrate_(context.segmentRef)`, `getDuration_(context.segmentRef)`, `getTopBitrate_(context.segmentRef)`, `getStreamFormat_(context.type)`. Keep these helpers — they encode shaka knowledge.
  - Build the per-request `CmcdData` object:
    ```javascript
    const data = {};
    if (objectType) data.ot = objectType;
    if (Number.isFinite(bitrate)) {
      data.br = (this.config_.version >= 2) ? [bitrate] : bitrate;
    }
    if (Number.isFinite(topBitrate)) {
      data.tb = (this.config_.version >= 2) ? [topBitrate] : topBitrate;
    }
    if (Number.isFinite(bufferLength)) {
      data.bl = (this.config_.version >= 2) ? [bufferLength] : bufferLength;
    }
    if (Number.isFinite(throughputKbps)) {
      data.mtp = (this.config_.version >= 2) ? [throughputKbps] : throughputKbps;
    }
    if (nextUrl) {
      data.nor = (this.config_.version >= 2) ? [nextUrl] : nextUrl;
    }
    if (Number.isFinite(duration)) data.d = duration;
    if (Number.isFinite(rtp)) data.rtp = rtp;  // bitrate * rtpSafetyFactor, computed adapter-side
    ```
  - Call `const cmldRequest = this.reporter_.createRequestReport(request, data);`.
  - Copy the CMCD-applied fields back onto the input request:
    ```javascript
    if (cmldRequest.uris) request.uris = cmldRequest.uris;
    if (cmldRequest.headers) Object.assign(request.headers, cmldRequest.headers);
    ```

- [ ] **Step 2: Resolve spec gap #2 (`bl` placement).** Treat `bl` strictly as per-request data here — never pass `bl` to `reporter.update()`. The spec's persistent-state table mentioning `bl` is misleading; the comment "may live on createRequestReport data" is the operative model.

- [ ] **Step 3: Run `python3 build/check.py`.**

**Acceptance:** `applyRequestData` compiles; mutates the request object; uses CML reporter for encoding.

### Task 3.5: `applyResponseData` rewrite

**Files:**
- Modify: `lib/util/cmcd_manager.js`

- [ ] **Step 1: Reimplement `applyResponseData(type, response, context)`:**
  - Early-return if `!this.reporter_`.
  - Compute `ttfb`/`ttlb` from existing `requestTimestampMap_` mechanism (keep this; it's shaka knowledge).
  - Extract `rc` (response code) and `url` from response.
  - Call `this.reporter_.recordResponseReceived(response, {ttfb, ttlb, rc, url})`.

- [ ] **Step 2: Apply Task 0.4's findings.** If `recordResponseReceived` returns data the adapter should propagate, copy it back to `response`. If it's a fire-and-forget call, don't.

- [ ] **Step 3: Run `python3 build/check.py`.**

**Acceptance:** `applyResponseData` compiles; preserves shaka's existing in-place mutation contract.

### Task 3.6: Player event listeners

**Files:**
- Modify: `lib/util/cmcd_manager.js`

Per spec § "Player state ↔ reporter state mapping" table.

- [ ] **Step 1: Subscribe to `<video>` events** in `setMediaElement` (already partially set up by Task 3.3). For each event, translate to reporter calls per the spec's table. Examples:

```javascript
this.eventManager_.listen(this.video_, 'pause', () => {
  this.setPlayerState_(cml.cmcd.CmcdPlayerState.PAUSED);
});
this.eventManager_.listen(this.video_, 'seeking', () => {
  this.setPlayerState_(cml.cmcd.CmcdPlayerState.SEEKING);
});
this.eventManager_.listen(this.video_, 'ended', () => {
  this.setPlayerState_(cml.cmcd.CmcdPlayerState.ENDED);
});
// ... volumechange → muted/unmuted, visibilitychange → backgrounded
```

- [ ] **Step 2: Subscribe to `shaka.Player` events** for buffering, variant changes, fatal errors:

```javascript
this.eventManager_.listen(this.player_, 'buffering', (e) => {
  if (e.buffering) {
    this.setPlayerState_(cml.cmcd.CmcdPlayerState.REBUFFERING);
  } else {
    this.setPlayerState_(cml.cmcd.CmcdPlayerState.PLAYING);
  }
});
this.eventManager_.listen(this.player_, 'adaptation', () => {
  const variant = this.player_.getVariantTracks().find((t) => t.active);
  if (variant) {
    this.reporter_.update({br: [variant.bandwidth]});
    this.reporter_.recordEvent(cml.cmcd.CmcdEventType.BITRATE_CHANGE);
  }
});
this.eventManager_.listen(this.player_, 'error', () => {
  this.setPlayerState_(cml.cmcd.CmcdPlayerState.FATAL_ERROR);
  this.reporter_.recordEvent(cml.cmcd.CmcdEventType.ERROR);
});
```

- [ ] **Step 3: Implement throughput-update wiring.** Whatever shaka's existing throughput-change signal is (likely `shaka.abr.EwmaBandwidthEstimator` updates flowing through `shaka.Player`), feed `mtp` into `reporter.update(...)` as it changes.

- [ ] **Step 4: Set `streamingFormat` once at manifest-load time.** Feed `update({streamingFormat: ...})` from the manifest parser type (DASH → `'d'`, HLS → `'h'`, Smooth → `'s'`, otherwise `'o'`). **Do NOT mutate `streamingFormat` on `setLowLatency` callbacks** — Phase 1 dropped the non-spec `'ld'`/`'lh'` values, and `sf` is per CTA-5004-B a stable manifest-type indicator, not an LL flag.

- [ ] **Step 5: Run `python3 build/check.py`.**

**Acceptance:** All player/video events from spec's table have a listener that calls the right reporter method.

### Task 3.7: Player-state deduplication

**Files:**
- Modify: `lib/util/cmcd_manager.js`

Per spec § "Player-state deduplication".

- [ ] **Step 1: Implement `setPlayerState_(state)`:**

```javascript
setPlayerState_(state) {
  if (this.lastPlayerState_ === state) return;
  this.lastPlayerState_ = state;
  this.reporter_.update({playerState: state});
  this.reporter_.recordEvent(cml.cmcd.CmcdEventType.PLAY_STATE);
}
```

- [ ] **Step 2: Initialize `this.lastPlayerState_ = null`** in the constructor.

- [ ] **Step 3: Reset `this.lastPlayerState_`** in `reset()` so a re-load doesn't suppress the first `PLAYING` event.

- [ ] **Step 4: Apply this dedup pattern only to `playerState`.** Other reporter.update fields (`mtp`, `cid`, `backgrounded`, `muted`) don't need dedup at this layer — either CML deduplicates internally, or the underlying signals are already deduplicated.

- [ ] **Step 5: Run `python3 build/check.py`.**

**Acceptance:** Player-state transitions don't emit duplicate `ps` events.

### Task 3.8: Configuration translation (`toReporterConfig_`)

**Files:**
- Modify: `lib/util/cmcd_manager.js`

Per spec § "3. Configuration translation".

- [ ] **Step 1: Implement `toReporterConfig_(shakaCmcdConfig)`:**

```javascript
toReporterConfig_(cfg) {
  const reporterConfig = {
    sid: cfg.sessionId || this.generateSessionId_(),
    cid: cfg.contentId,
    transmissionMode: cfg.useHeaders
        ? cml.cmcd.CmcdTransmissionMode.CMCD_HEADERS
        : cml.cmcd.CmcdTransmissionMode.CMCD_QUERY,
    enabledKeys: cfg.includeKeys,
    version: cfg.version === 2
        ? cml.cmcd.CMCD_V2
        : cml.cmcd.CMCD_V1,
    requester: this.makeRequester_(),
  };
  if (cfg.eventTargets && cfg.eventTargets.length) {
    reporterConfig.eventTargets = cfg.eventTargets.map((target) => ({
      url: target.url,
      events: target.events,
      interval: target.interval,          // CML field name (was timeInterval)
      batchSize: target.batchSize,
      enabledKeys: target.includeKeys,    // rename: includeKeys (shaka) → enabledKeys (CML)
      version: target.version,            // CML supports per-target version (Task 0.5 confirmed)
    }));
  }
  return reporterConfig;
}
```

- [ ] **Step 2: Resolve spec gap #4 (`sessionId` auto-generation).** Implement `generateSessionId_()`:

```javascript
generateSessionId_() {
  // Existing shaka pattern; check what cmcd_manager.js currently does on
  // the load() path to auto-generate sessionId, and preserve that exact
  // codepath here. Probably crypto.randomUUID() (already polyfilled).
  return crypto.randomUUID();
}
```

  This means `cml.cmcd.uuid` (the shim from Task 1.5) is genuinely dead code at runtime — the adapter always supplies `sid`.

- [ ] **Step 3: Apply Task 0.5 outcome to per-target `version`.** If CML doesn't expose per-target version, drop that line from the `map(...)` body and document the limitation in the externs (Task 3.11).

- [ ] **Step 4: Run `python3 build/check.py`.**

**Acceptance:** `toReporterConfig_` produces a valid `CmcdReporterConfig`; field renames applied per spec.

### Task 3.9: `requester` callback wiring

**Files:**
- Modify: `lib/util/cmcd_manager.js`

Per spec § "Event-mode dispatch via NetworkingEngine".

- [ ] **Step 1: Implement `makeRequester_()`** (exact code from spec § "Event-mode dispatch via NetworkingEngine"):

```javascript
makeRequester_() {
  const RequestType = shaka.net.NetworkingEngine.RequestType;
  return async (cmcdReq) => {
    const retryParams = shaka.net.NetworkingEngine.defaultRetryParameters();
    const shakaReq = shaka.net.NetworkingEngine.makeRequest(
        [cmcdReq.url], retryParams);
    shakaReq.method = cmcdReq.method || 'POST';
    shakaReq.headers = cmcdReq.headers || {};

    // CML's reporter always emits body as a string (structured-fields
    // encoded by encodeCmcd, joined by '\n'). Convert to BufferSource.
    shakaReq.body = shaka.util.StringUtils.toUTF8(cmcdReq.body);

    try {
      await this.networkingEngine_
          .request(RequestType.TIMING, shakaReq, {type: 'cmcd-event'})
          .promise;
      return {status: 200};
    } catch (err) {
      return {status: err.status || 0};
    }
  };
}
```

- [ ] **Step 2: Body type is fixed to `string`** per Phase 0 Task 0.8 verification (`cml-version.md`): CML's `sendEventReport` constructs `body: data.map(item => encodeCmcd(item, options)).join('\n') + '\n'` — never Blob, never Uint8Array. The Blob branch from earlier sketches is dead code.

- [ ] **Step 3: Stash `this.networkingEngine_` reference** somewhere in the constructor or `setMediaElement` (the existing `cmcd_manager.js` likely already has this; verify).

- [ ] **Step 4: Run `python3 build/check.py`.**

**Acceptance:** `requester` callback compiles; routes through NetworkingEngine.

### Task 3.10: Delete obsolete code

**Files:**
- Modify: `lib/util/cmcd_manager.js`

- [ ] **Step 1: Delete:**
  - All encoding helpers (already partially deleted in Phase 1; verify nothing remains).
  - Sequence-number tracking (`this.cmcdSequenceNumbers_`).
  - Event-timer infrastructure (`this.eventTimers_`).
  - MSD computation (`this.msdSent_`, etc.).
  - Mode-selection logic (request mode vs. response mode vs. event mode dispatch — CML's reporter handles this).
  - Private helpers: `applyRequest_`, `applyManifestData`, `applyManifestRequest_`, etc.

- [ ] **Step 2: Keep:**
  - `getObjectType_`, `getBitrate_`, `getDuration_`, `getTopBitrate_`, `getStreamFormat_` — shaka knowledge, the adapter's job to translate.
  - `requestTimestampMap_` — TTFB/TTLB measurement; CML reporter doesn't have access to send time.

- [ ] **Step 3: Run `python3 build/check.py`.** No dead-code warnings; if Closure flags unused private fields, delete them.

- [ ] **Step 4: Verify line count.** Spec target is ~250 lines for the adapter.

**Acceptance:** Manager file shrunk to ~250 lines; only adapter logic and shaka-knowledge helpers remain.

### Task 3.11: Externs renames

**Files:**
- Modify: `externs/shaka/player.js` — rename `targets` → `eventTargets`, per-target `enabledKeys` → `includeKeys`
- Modify: `externs/cmcd.js` — review for v2-key updates if needed (likely no change)

Per spec § "Public-API back-compat details".

- [ ] **Step 1: Rename `shaka.extern.CmcdConfiguration.targets` → `eventTargets`.** Lines 2771, 2819 in `externs/shaka/player.js` (per the grep earlier).

- [ ] **Step 2: Rename per-target field in `shaka.extern.CmcdTarget`.** The current typedef at line 2760 doesn't show all fields in my read — verify the field is `enabledKeys` and rename to `includeKeys`. Update JSDoc descriptions accordingly.

- [ ] **Step 3: Update the JSDoc comment block** for `CmcdConfiguration` to reflect the new field name. Add `@deprecated` or migration note if maintainers prefer.

- [ ] **Step 4: Verify Player code doesn't read `cfg.targets`.** Grep:
  ```bash
  grep -rn "cmcd.targets\|\.targets" lib/player.js
  ```
  Update any remaining references to the old name.

- [ ] **Step 5: Run `python3 build/check.py`.**

**Acceptance:** Externs renamed; no internal references to old names.

### Task 3.12: v2 re-exports

**Files:**
- Modify: `lib/util/cmcd_manager.js`

Per spec § "New public re-exports for v2 configuration".

- [ ] **Step 1: Add re-exports:**

```javascript
/**
 * @enum {string}
 * @export
 */
shaka.util.CmcdManager.EventType = cml.cmcd.CmcdEventType;

/**
 * @enum {string}
 * @export
 */
shaka.util.CmcdManager.PlayerState = cml.cmcd.CmcdPlayerState;
```

- [ ] **Step 2: Verify `@export` works for alias re-exports.** Closure ADVANCED may need a different pattern (e.g., per-key copy) to preserve the export. Use whatever pattern the existing `StreamingFormat` re-export from Task 2.3 ended up using.

- [ ] **Step 3: Run `python3 build/check.py` and grep the compiled output** for `EventType` / `PlayerState` to confirm they appear in the public API:
  ```bash
  python3 build/build.py && grep -o "EventType\|PlayerState" dist/shaka-player.compiled.js | head
  ```

**Acceptance:** Both re-exports appear in compiled bundle's public surface.

### Task 3.13: Test rewrite

**Files:**
- Modify (large delete): `test/util/cmcd_manager_unit.js`
- Add: new test sections per spec § "Tests strategy"

Per spec § "Phase 3 — Test rewrite".

- [ ] **Step 1: Delete CMCD wire-format tests** (Bucket A — encoder correctness, key serialization, value escaping, header vs query, v1/v2 mode-specific filtering, inner-list encoding, structured-field serialization, sequence-number progression, event timing/batching). Spec estimates ~3000+ lines deleted.

- [ ] **Step 2: Add Bucket B tests** (~500 lines, shaka-specific glue). Use a stubbed `CmcdReporter` that records calls. Cover:
  - `RequestType` (MANIFEST, SEGMENT, LICENSE, KEY, TIMING) → `CmcdObjectType` mapping.
  - `RequestContext.type` → `CmcdStreamingFormat` mapping (DASH/HLS/Smooth/Other; LL DASH and LL HLS map to plain DASH/HLS per Phase 1 Task 1.10b).
  - Config translation (`toReporterConfig_` outputs given various `shaka.extern.CmcdConfiguration` inputs).
  - Player-event listener wiring: simulate `<video>` events, assert `reporter.update(...)` and `recordEvent(...)` calls.
  - NetworkingEngine routing: stub the reporter's `requester` callback; assert it dispatches via `NetworkingEngine.request(RequestType.TIMING, ...)`; assert error → `{status: 0}` translation.
  - Lifecycle: construct → configure → reset → reconfigure produces a fresh reporter.
  - `rtp = bitrate × rtpSafetyFactor` computed in adapter.
  - `enabled: false` → no reporter constructed; apply* short-circuits.
  - `setMediaElement` triggers reporter construction (resolves spec gap #1).
  - `bl` is per-request, never persistent state (resolves spec gap #2).
  - Player-state deduplication: repeated `playing` events → single `recordEvent`.
  - Public-API back-compat: `shaka.util.CmcdManager.StreamingFormat`/`EventType`/`PlayerState` enums available with expected values.

- [ ] **Step 3: Add Bucket C tests** (~100 lines, end-to-end smoke). Drive a real `CmcdReporter` (not a stub) through the adapter; assert wire output. Cover:
  - One v1 + one v2 config × two transmission modes (`CMCD_QUERY`, `CMCD_HEADERS`) = at least 4 cases.
  - One event-mode test: configure an `eventTarget`; trigger play-state change; assert NetworkingEngine receives an event-mode POST with expected body.

- [ ] **Step 4: Run `python3 build/test.py` until green.** Iterate.

**Acceptance:** Test suite passes. ~4317 lines deleted, ~600 lines added (per spec estimate).

### Task 3.14: Demo update

**Files:**
- Modify: `demo/` — add CMCD v2 config UI

Per spec § "Phase 3", and resolving spec gap #8 (demo scope).

- [ ] **Step 1: Identify the existing demo CMCD UI.** Grep:
  ```bash
  grep -rn "cmcd" demo/
  ```

- [ ] **Step 2: Add minimum v2 controls:**
  - Transmission mode toggle (query / headers).
  - Version selector (1 / 2).
  - Single eventTarget editor: URL input + checkboxes for which event types to subscribe to (`PLAY_STATE`, `ERROR`, `RESPONSE_RECEIVED`, etc.) + numeric input for `timeInterval`.
  - Reuse existing CMCD UI for `enabled`, `sessionId`, `contentId`, `includeKeys`, `useHeaders`.

- [ ] **Step 3: Wire config changes to `player.configure({cmcd: ...})`.**

- [ ] **Step 4: Verify the demo loads and the new controls work** — load a stream, change settings live, verify CMCD output changes accordingly via DevTools network tab.

**Acceptance:** Demo has v2 config UI. Mirrors precedent from dash.js's `cmcd-v2.html` per spec.

### Task 3.15: Phase 3 verification

- [ ] **Step 1: `python3 build/check.py` passes.**
- [ ] **Step 2: `python3 build/test.py` passes.**
- [ ] **Step 3: `python3 build/all.py` passes.**
- [ ] **Step 4: Demo verification:**
  - v1 config + query mode: stream plays; CMCD in query string; expected keys present.
  - v1 config + headers mode: stream plays; CMCD in `CMCD-Request` header.
  - v2 config + query mode: stream plays; v2 keys present (`sta`, `sn`, etc.); inner-list keys are arrays (`br=[1234]`).
  - v2 config + eventTarget configured: trigger play/pause/seek; verify event-mode POSTs to the eventTarget URL.
- [ ] **Step 5: Manual regression check** for non-CMCD playback: unconfigure CMCD; verify nothing about playback changed.

**Acceptance:** All phases of verification pass.

### Task 3.16: Phase 3 PR

- [ ] **Step 1: Open PR with title:**
  ```
  refactor(cmcd): replace state machine with cml.cmcd.CmcdReporter (3/3)
  ```

- [ ] **Step 2: PR description includes:**
  - Overview: "Phase 3 of 3 in the CMCD CML refactor."
  - **Public-API renames** (experimental v2 only):
    - `shaka.extern.CmcdConfiguration.targets` → `eventTargets`.
    - Per-target `enabledKeys` → `includeKeys`.
  - **New public re-exports**: `shaka.util.CmcdManager.EventType`, `shaka.util.CmcdManager.PlayerState`.
  - **Behavioral changes**: enumerate any state-transition or timing differences vs. the pre-refactor manager.
  - **Sequence numbers** (Task 0.7 outcome): if CML's per-target sequencing differs from shaka's prior per-mode sequencing, call out as a wire-format change.
  - **Event-mode dispatch**: now flows through NetworkingEngine; inherits auth/retry/filters.
  - Test surface: ~4317 lines deleted (wire-format coverage now in CML upstream), ~600 lines added (adapter glue + smoke).
  - **Deferred**: `RequestType.CMCD_EVENT_REPORT` (using `RequestType.TIMING` for now; can be added in follow-up PR without changing adapter contract).

- [ ] **Step 3: Wait for review; address feedback; merge.**

**Acceptance:** PR merged; CMCD refactor complete.

### Phase 3 verification gate

- [ ] `python3 build/check.py` passes.
- [ ] `python3 build/test.py` passes.
- [ ] `python3 build/all.py` passes.
- [ ] Demo plays content with CMCD v1 + v2 in both transmission modes.
- [ ] Demo dispatches event-mode reports through NetworkingEngine.
- [ ] Phase 3 PR merged.

---

## Risks and mitigations

| Risk | Phase | Mitigation |
|---|---|---|
| Closure ADVANCED renames an `@export` symbol | All | After each `@export` change, verify the symbol appears in compiled output (`grep` on `dist/shaka-player.compiled.js`). |
| Wire-format diff during Phase 1 surfaces (c)-class bugs (real divergence, not alignment) | 1 | Block Phase 1 ship; resolve via CML upstream PR or adapter workaround; re-run diff test. |
| CML's `CmcdReporter` API doesn't match spec assumptions | 0, 3 | Phase 0 verification catches; Task 3.1 re-verifies before Phase 3 commits. |
| State-transition timing differences (CML emits events at slightly different times than shaka used to) | 3 | Bucket C smoke tests catch egregious cases; PR description calls out any known timing changes; demo regression check. |
| Per-target sequence numbering differs from shaka's per-mode prior behavior | 3 | Task 0.7 documents the difference; Phase 3 PR description notes it; downstream consumers parsing `sn` need to adapt. |
| `enabled: false → true` mid-session dynamic reconfiguration leaves the adapter in a broken state | 3 | Bucket B test covers this lifecycle path. |
| Demo regression: existing CMCD-disabled flows break | 3 | Manual regression check (Task 3.15.5); test-suite already covers `enabled: false`. |
| Memory leak from forgotten event listeners on `reset()` | 3 | `reset()` calls `eventManager_.removeAll()` (existing pattern); Bucket B test asserts listener count returns to zero. |
| CML version pinning becomes stale between Phase 0 and Phase 3 | All | Task 3.1 re-pins if upstream landed relevant changes; small risk this triggers a Phase 1 revisit. |
| `crypto.randomUUID()` not available in some shaka-supported browser | 3 | Use shaka's existing UUID-generation path (whatever `cmcd_manager.js` currently uses) rather than `crypto.randomUUID()` directly; the polyfill already covers this. |

---

## Out of scope (deferred follow-ups)

- **`RequestType.CMCD_EVENT_REPORT` dedicated request type.** Phase 3 uses `RequestType.TIMING`. Follow-up PR can add a dedicated type without changing adapter contract.
- **CMCD validators in the vendored port.** Spec § "Excluded" lists ~16 validator files. Add only if shaka adds a debug-mode self-check feature.
- **Expanded public re-export surface.** Beyond `StreamingFormat`/`EventType`/`PlayerState`, additional CML enums (`CmcdObjectType`, `CmcdStreamType`, `CmcdHeaderField`, etc.) stay internal until users have a documented need.
- **TypeScript migration.** Out of scope per spec; the vendored port is transitional and deletes when [#8262](https://github.com/shaka-project/shaka-player/issues/8262) lands.

---

## Self-review (post-write)

- [x] **Spec coverage check.** Each spec section maps to a phase: Constraints → Phase 0 verification + AGENTS.md adherence; Architecture → Phase 1 + Phase 3; Vendored port → Phase 1; Adapter → Phase 3; CML-side requirements → Phase 0 + Task 3.1; Migration phasing → plan structure; Tests → Tasks 1.11/1.12/3.13; Open questions → Tasks 0.1/0.7 + Task 1.11 + Risk table.
- [x] **Placeholder scan.** No "TBD", "fill in details", "implement later", or generic "add error handling" — every step has actionable content or a verification command.
- [x] **Type consistency.** Method names used consistently: `setPlayerState_`, `maybeStartReporter_`, `toReporterConfig_`, `makeRequester_`, `generateSessionId_`, `lastPlayerState_`. CML symbols consistently `cml.cmcd.X`.
- [x] **Spec gaps surfaced.** 10 gaps listed at the top with their resolving tasks identified.
- [x] **Risks identified.** Risk table covers Closure export drift, wire-format divergence, API mismatches, state-timing differences, sequence-numbering, demo regressions, listener leaks, version drift, and UUID polyfill.
- [x] **Acceptance criteria per phase.** Each phase has a verification-gate checklist (`build/check.py`, `build/test.py`, `build/all.py`, demo).
