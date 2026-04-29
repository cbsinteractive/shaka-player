<!--
Cumulative PR draft for the CMCD CML refactor. All three phases (Phase 1
vendor + delegate, Phase 2 dedupe, Phase 3 adapter rewrite) are landed
locally on feat/cmcd-cml-refactor and ready for the single all-phases PR.
-->

# Title

```
refactor(cmcd): vendor @svta/cml-cmcd, replace custom encoder + state machine
```

# Body

## Summary

Replaces shaka's custom CMCD wire-format encoding and state machine with a vendored Closure port of [`@svta/cml-cmcd`](https://github.com/streaming-video-technology-alliance/common-media-library) (CML) under `third_party/cml-cmcd/`. Implementation in three sequential phases off `feat/cmcd-cml-refactor`:

- **Phase 1** (Tasks 1.1-1.13) vendors the port and routes shaka's encoders through it. Three intentional wire-format changes (`nor` URL relativization, `'ld'`/`'lh'` dropped, V2 SFV-conformant encoding).
- **Phase 2** (Tasks 2.1-2.5) dedupes shaka's internal enums and key arrays in favor of `cml.cmcd.*` equivalents. Pure dedupe; no behavior change.
- **Phase 3** (Tasks 3.1-3.15) rewrites `lib/util/cmcd_manager.js` (1580 → ~700 LoC) as a thin adapter around `cml.cmcd.CmcdReporter`. Deletes the state machine, sequence-number tracking, event timing, and mode-selection logic. Ships experimental v2 config renames (`targets`→`eventTargets`, per-target `timeInterval`→`interval`) and adds public `EventType` / `PlayerState` re-exports. Three additional wire-format alignments inherited from CML.

See [`plans/cmcd-cml-refactor/spec.md`](plans/cmcd-cml-refactor/spec.md) and [`plans/cmcd-cml-refactor/plan.md`](plans/cmcd-cml-refactor/plan.md) for full design + rationale.

Phases 1 + 2 are **behavior-preserving** for shaka's public API, modulo documented intentional wire-format changes that align shaka with CTA-5004 / CTA-5004-B and CML's spec-conformant output. Phase 3 is the load-bearing behavioral change — the manager's external surface stays compatible, but the internal state machine, sequence-number scope, and event-mode dispatch path all flow through CML's reporter.

## What's vendored

`third_party/cml-cmcd/` mirrors the CML repo's `libs/cmcd/src/` plus two shim files (`cml_utils.js`, `cml_sfv.js`):

| Group | Files | Notes |
|---|---|---|
| Typedefs | 23 | TS interfaces ported as Closure `@typedef` records. |
| Enums | 5 | `CmcdEventType`, `CmcdPlayerState`, `CmcdReportingMode`, `CmcdStreamingFormat`, `CmcdTransmissionMode`. |
| Constants | 8 | Per-mode keysets, formatter map, header map, etc. |
| Encoders | 14 | `encodeCmcd`, `toCmcdQuery`, `toCmcdHeaders`, `appendCmcdQuery`, `appendCmcdHeaders`, plus internals. |
| Helpers | 4 | `prepareCmcdData`, `upConvertToV2`, `resolveVersion`, `groupCmcdHeaders`. |
| Predicates | 6 | `isCmcdRequestKey`, `isCmcdEventKey`, etc. |
| Reporter | 1 | `cmcd_reporter.js` (CmcdReporter class — used by Phase 3). |
| Shims | 2 | `cml_utils.js` (uuid + URL helpers + dead-code `defaultRequester`); `cml_sfv.js` (RFC 8941 §4.1 SFV serializer). |
| Legal | 3 | `LICENSE` (Apache 2.0), `NOTICE`, `SUMMARY.txt`. |

CML pin: **`cmcd-v2.3.0` / commit `22390e35dfbbe1e53d15648d3aace99cdf71f9dd`**. See [`plans/cmcd-cml-refactor/cml-version.md`](plans/cmcd-cml-refactor/cml-version.md) for the full Phase 0 verification report.

When shaka migrates to TypeScript ([#8262](https://github.com/shaka-project/shaka-player/issues/8262)), the vendored directory deletes and each `goog.require('cml.cmcd.X')` becomes `import { X } from '@svta/cml-cmcd'` — no other code changes.

## Architectural decisions in the port

These are judgment calls during sub-phase B+C; please weigh in:

1. **`setInterval` whitelisted** in `build/conformance.textproto` for `third_party/cml-cmcd/cmcd_reporter.js`. The reporter calls `setInterval` directly for periodic time-interval event reporting. Alternatives considered: (a) patching the vendored reporter to use `shaka.util.Timer` (breaks verbatim parity, complicates per-bump diff workflow), (b) filing a CML upstream PR for injectable-timer support (delays Phase 1). Whitelist is pragmatic but means **Phase 3 tests can't inject a fake timer** — will need `jasmine.clock()` for interval testing.
2. **`fetch` whitelisted** in `build/conformance.textproto` for `third_party/cml-cmcd/cml_utils.js`. Used by `cml.cmcd.defaultRequester` — dead code at runtime because the shaka adapter always supplies a custom `requester` via `NetworkingEngine`. Closure ADVANCED is expected to strip the dead path; the conformance check runs first.
3. **`defaultRequester` relocated** from `CmcdReporter.ts` module scope into `cml_utils.js` as `cml.cmcd.defaultRequester`. Done to centralize the `fetch` whitelist scope to a single file. **Per-bump CML diff workflow needs to know** `defaultRequester` lives here, not in the reporter — otherwise CML 2.4.0+ bumps will look like the function vanished.

## Wire-format changes (intentional)

Three changes; all align shaka with CTA-5004-B and CML's spec-conformant output. Test assertions updated to match.

**1. `nor` URLs become root-relative + V2 inner-list format.**

- **V1**: `nor="next-seg.m4v"` (path-relative against request URL).
- **V2**: `nor=("next-seg.m4v")` (RFC 8941 inner-list, root-relative against request origin per CTA-5004-B § 4.1).

`cmcd_manager.js` no longer pre-relativizes `data.nor`; CML's `nor` formatter relativizes against `options.baseUrl` (request URL's origin). For event-mode reports sent to a different-origin collector, `nor` stays absolute.

**2. `'ld'` and `'lh'` `StreamingFormat` values dropped.**

CTA-5004 / CTA-5004-B define only `'d'` (DASH), `'h'` (HLS), `'s'` (Smooth), `'o'` (Other). `'ld'` and `'lh'` were from an old unreleased CMCD draft and are non-spec. **Wire change**: low-latency DASH content now emits `sf=d`; low-latency HLS now emits `sf=h`. `setLowLatency()` no longer mutates `sf_`; the LL flag is preserved for any external readers but has no effect on the encoded `sf` value.

**3. V2 SFV-conformant encoding.**

CML uses RFC 8941 Structured Field Values for V2 output; old shaka used a JSON-stringify-shaped quoting rule. Concrete differences:

- **Token vs string formatting** for `e` (event type) and `sta` (player state) values. Old: `e="ps"`, `sta="s"`. New: `e=ps`, `sta=s`. Per CTA-5004-B these values are spec-defined single-character tokens; SFV tokens don't take quotes.
- **`v=2` always present in V2 output.** Per CTA-5004-B § 4.1, V2 output MUST include `v`. Old shaka emitted `v` only when explicitly present in input data. CML's `prepareCmcdData` enforces this, even when the user filters `v` out via `includeKeys`.
- **`ts` no longer in request-mode output.** Per CTA-5004-B `ts` is event-mode only. Old shaka emitted `ts=<timestamp>` in request-mode CMCD; CML's request-mode filter correctly drops it. (Event-mode and response-received reports continue to include `ts`.)

## Behavior preserved otherwise

The state machine, sequence numbers (`cmcdSequenceNumbers_` per-target counters), event timing, request/response routing, and the public `shaka.util.CmcdManager` API are unchanged. The `setLowLatency`, `setMediaElement`, `configure`, `reset`, `applyRequestData`, `applyResponseData`, `appendSrcData`, `appendTextTrackData` entry points retain their existing signatures and semantics. Phase 2 dedupes constants/enums; Phase 3 rewrites the state machine as a thin adapter around `CmcdReporter` and is the load-bearing behavioral change.

## Implementation summary

`shaka.util.CmcdManager` static encoders now delegate:

- `serialize(data, options)` → `cml.cmcd.encodeCmcd(data, options)`.
- `toQuery(data, options)` → `cml.cmcd.encodeCmcd(data, options)` (preserves shaka's "raw value, no `CMCD=` prefix" contract — CML's `toCmcdQuery` returns the prefixed form, which would break callers).
- `toHeaders(data, options)` → `cml.cmcd.prepareCmcdData(data, options)` once on the full input, then bucketed into shaka's existing 4-shard `headerMap`, then `cml.cmcd.encodePreparedCmcd` per shard. Calling the high-level `encodeCmcd` per shard would re-run `prepareCmcdData` and re-add `v=2` to every non-empty shard.
- `appendQueryToUri(uri, query)` retained as a `goog.Uri`-based adapter — CML's `appendCmcdQuery(url, cmcd, options)` takes a data object, not a pre-encoded query string, so direct delegation isn't possible. Phase 3 deletes call sites entirely.
- `urlToRelativePath` deleted; the helper and its 9 unit tests are gone.

A new private `getEncodeOptions_(uri, version, reportingMode)` static helper builds `cml.cmcd.CmcdEncodeOptions` objects at the four CMCD-encoding call sites: `appendSrcData`, `appendTextTrackData`, `sendCmcdRequest_` (event/response path), `applyCmcdDataToRequest_` (request path). It threads `this.config_.version` and the reporting mode (`CMCD_REQUEST_MODE` for request paths, `CMCD_EVENT_MODE` for `sendCmcdRequest_`).

## Phase 2 implementation summary

Pure dedupe — no behavioral change beyond what Phase 1 shipped. Single commit `67443aacb`.

**7 internal shaka enums deleted** (none were `@export`ed, so deletion is internal-only):

| Shaka (deleted) | Replacement | Notes |
|---|---|---|
| `ObjectType` | `cml.cmcd.CmcdObjectType` | 1:1 value match (9 entries) |
| `Version` | `cml.cmcd.CMCD_V1` / `CMCD_V2` literals | Was a 2-entry enum wrapping `1` / `2` |
| `StreamType` | `cml.cmcd.CmcdStreamType` | CML adds `LOW_LATENCY: 'll'`; harmless superset |
| `CmcdMode` | `cml.cmcd.CmcdReportingMode` | Dropped unused `RESPONSE` value |
| `CmcdKeys` | various CML key arrays | `V1Keys` → `CMCD_V1_KEYS`; `V2Common ∪ V2Request` → `CMCD_REQUEST_KEYS`; `V2Common ∪ V2Event` → `CMCD_REQUEST_KEYS ∪ CMCD_RESPONSE_KEYS ∪ CMCD_EVENT_KEYS`; `CmcdV2Events` → `Object.values(CmcdEventType)`; `CmcdV2PlayStates` → `Object.values(CmcdPlayerState)` |
| `CmcdV2Constants` | inlined | `TIME_INTERVAL_DEFAULT_VALUE = 10` inlined as a magic number with a comment. CML uses `30`; Phase 3's `CmcdReporter` will adopt the CML default. |
| `CmcdV2Keys` | inlined / aliased | `TIMESTAMP` inlined as the literal `'ts'`; `TIME_INTERVAL_EVENT` → `cml.cmcd.CMCD_EVENT_TIME_INTERVAL` |

**`StreamingFormat` retained as a literal `@enum`** (not aliased to CML). Closure's `clutz` TypeScript-defs generator and shaka's `generateExterns.js` both reject `@export`ed `@enum`s whose RHS is anything other than an inline `ObjectExpression` with literal values. Workaround patterns (alias, per-key copy with `MemberExpression` values, `@const` instead of `@enum`) all hit the same wall. The 4 values match `cml.cmcd.CmcdStreamingFormat` exactly; a new `preserves value-identity with cml.cmcd.CmcdStreamingFormat` unit test asserts this so Phase 3 can rely on it. Internal type annotations (`sf_` private field, `getStreamFormat_` return type) refer to `cml.cmcd.CmcdStreamingFormat` directly; the `@export`ed `shaka.util.CmcdManager.StreamingFormat` is the public-facing form.

**Permissive behavior changes from CML key-set adoption:**
- V2 request mode now accepts `br`, `bsa`, `bsd`, `bsda`, `cs`, `dfa`, `nr`, `pb`, `sn` in `includeKeys` (previously rejected by shaka's narrower `V2RequestModeKeys`). All are CMCD V2 spec keys; shaka's omission was non-spec.
- V2 request mode now rejects `ts` in `includeKeys` (was accepted previously). `ts` is event-only per CTA-5004-B; the encoder filtered it out anyway since Phase 1 sub-phase E B2 — this aligns the upstream `includeKeys` validator with the encoder filter.
- Event-mode validation accepts a strict superset of what shaka's old `V2EventModeKeys` allowed.
- `isValidEvent_` accepts CML's 17 event types instead of shaka's 10 (adds the 7 ad / skip / custom-event types). shaka doesn't emit these, so user-facing impact is nil.

## Phase 3 implementation summary

The behavioral rewrite. `lib/util/cmcd_manager.js` shrinks from 1580 LoC to ~700, becoming a thin adapter around `cml.cmcd.CmcdReporter`. The reporter owns CMCD state, encoding, key filtering, sequence numbering, and event-mode dispatch; the adapter translates shaka's request/response/player events into reporter calls. The bulk of the LoC win is in tests: ~3500 lines of wire-format coverage (Bucket A) deleted because that responsibility now lives in CML upstream; ~600 lines of adapter-glue + smoke (Bucket B/C) added.

**Two commits:**
1. `965ba69f8` — `refactor(cmcd): rewrite shaka.util.CmcdManager as thin adapter around CmcdReporter`. The full behavioral rewrite + externs renames + v2 re-exports + test rewrite + demo update.
2. `43cc7f332` — `fix(cmcd): preserve video_ across reset() so configure() can rebuild reporter`. Smoke-surfaced bug: shaka keeps the video element attached across `unload()`/`load()` cycles, so the manager's `video_` field must NOT be cleared in `reset()` — otherwise a post-unload `configure(materialChange)` can't reconstruct the reporter.

**Public-API renames** (experimental v2 surface in `shaka.extern.CmcdConfiguration`):
- top-level `targets` → `eventTargets`
- per-target `timeInterval` → `interval` (matches CML's field name)
- per-target typedef gains `batchSize` and per-target `version` fields

**New public re-exports** (literal-form `@export` per Phase 2's Closure-tooling constraint; value-identity unit tests assert parity with the corresponding `cml.cmcd.*` enums):
- `shaka.util.CmcdManager.EventType` — 17 entries (superset of shaka's old 10).
- `shaka.util.CmcdManager.PlayerState` — 10 entries (superset of shaka's old 4).

**Wire-format changes inherited from CML alignment:**
1. **`sn` shifts from 1-based to 0-based.** CML's reporter initializes `sn = 0`; old shaka started at `1`. Consumers parsing `sn` as a counter index must adjust.
2. **Request-mode `sn` becomes a single global counter** (was per-target-hash, where header-vs-query distinct configs got distinct counters); resets on `sid` change. In practice shaka doesn't expose runtime mode switching, so the practical impact is mostly the `sid`-rotation reset semantic.
3. **`CMCD_DEFAULT_TIME_INTERVAL` adopts CML's `30`** (was shaka's `10`) when the user does not specify a per-target `interval`. Pre-Phase-3, `setupEventModeTimeInterval_` defaulted to 10 seconds; Phase 3 routes through CML's reporter, which uses the v2-default of 30.

**Adapter design choices worth flagging:**
1. **`enabledKeys` defaults to all valid keys for the version** when the user's `includeKeys` is empty/missing. Without this expansion, CML's `createRequestReport` early-returns on an empty `enabledKeys` array — old shaka treated empty `includeKeys` as "include all", and existing user configs depend on that semantic.
2. **`appendSrcData` / `appendTextTrackData` bypass the reporter** and call `cml.cmcd.appendCmcdQuery` directly with a synthesized CMCD object. `<video src=…>` and sidecar text-track loads can't carry custom request headers, so query-mode encoding is forced regardless of `useHeaders`. Per-request `sn` is omitted on this path.
3. **Multi-URI requests** (alternate-CDN retry lists; rare) get the same CMCD encoding applied to every URI. The first URI is rewritten via `createRequestReport`; the encoded `CMCD=…` param is extracted and applied to the remaining URIs via URL parsing. All URIs share one `sn`.
4. **`networkingEngine_` is read lazily** in `makeRequester_()` via `this.player_.getNetworkingEngine()`. No separate field — keeps the manager simple and avoids stale-reference issues if NetworkingEngine is recreated.
5. **`m`/muted is event-only, not persistent state.** CTA-5004-B defines `m`/`um` as event types, not data keys; the adapter emits `MUTE`/`UNMUTE` events but does NOT call `update({m: …})`.
6. **`reset()` preserves `video_`.** Shaka's lifecycle keeps the video element attached across `unload()`/`load()` cycles; only `detach()` releases it. Preserving `video_` is what lets a post-unload `configure(materialChange)` rebuild the reporter and re-attach event listeners on the same video element.

**Event-mode dispatch via NetworkingEngine.** CmcdReporter takes a `requester: (req) => Promise<{status: number}>` callback as its second positional arg for dispatching event-mode reports. Shaka wires this to `NetworkingEngine.request(RequestType.TIMING, ...)` instead of raw `fetch`, so event-mode reports inherit auth/retry/filters — same as manifests and segments. **No new public config field needed**; users already control transport via NetworkingEngine plugins. CML's reporter constructs `method: 'POST'` with a string body (structured-fields encoded by `encodeCmcd`, joined by `'\n'`), which the adapter wraps via `shaka.util.StringUtils.toUTF8` before passing to NetworkingEngine.

**Demo update.** Adds an `Event Targets (JSON)` text input that JSON-parses on change and `player.configure({cmcd: {eventTargets: [...]}})`s the result. Mirrors dash.js's `cmcd-v2.html` minimum scope. Version field converted to a numeric input.

**Deferred follow-ups** (out of scope for this PR):
- Dedicated `RequestType.CMCD_EVENT_REPORT` request type. Phase 3 uses `RequestType.TIMING`; a follow-up PR can add a dedicated type without changing the adapter contract.
- Expanded public re-export surface (`CmcdObjectType`, `CmcdStreamType`, `CmcdHeaderField`, etc.). These stay internal under `cml.cmcd.*` until users have a documented need.
- TypeScript migration (tracked in [#8262](https://github.com/shaka-project/shaka-player/issues/8262)). The vendored directory deletes when this lands.

## Diff size (all three phases)

- `third_party/cml-cmcd/`: 74 new JS files + LICENSE/NOTICE/SUMMARY (+5017 lines, Phase 1).
- `lib/util/cmcd_manager.js`: +100 / −138 (Phase 1), +13 / −87 (Phase 2), and +~700 / −1580 (Phase 3 — full rewrite). Cumulative net −920 / +810.
- `test/util/cmcd_manager_unit.js`: +107 / −140 (Phase 1), +12 / 0 (Phase 2), and +~880 / −4296 (Phase 3 rewrite). Cumulative net −3550 / +1000.
- `externs/shaka/player.js`: experimental `CmcdConfiguration` / `CmcdTarget` typedef updates (Phase 3).
- `lib/util/player_configuration.js`: `cmcd.targets` → `cmcd.eventTargets` default (Phase 3).
- `demo/config.js`: `Event Targets (JSON)` input added (Phase 3).
- `test/demo/demo_unit.js`: `cmcd.eventTargets` added to the array-typed-config exceptions set.
- `build/conformance.textproto`: 2 entries added (`setInterval`, `fetch`).
- `build/types/core`: 74 entries added for the vendored files.
- `plans/cmcd-cml-refactor/`: design + verification docs.

**Total (all three phases)**: ~90 files, ~+6500 / ~−4400. Net positive ~+2100 lines (mostly the vendored CML port; net delete in shaka-side code is dramatic — ~3700 LoC removed from `lib/util/cmcd_manager.js` + tests).

(Plan estimated ~3000 lines for the port; actual is ~5000 because of (a) `cml_sfv.js` (~448 LoC RFC 8941 serializer shim — CML uses `@svta/cml-utils`'s SFV encoder, which we vendor inline since the shim doesn't ship as a separate package), (b) 8 spec-excluded files re-included as runtime dependencies, and (c) generous license/notice headers per Apache 2.0.)

## Verification (all three phases)

- [x] `python3 build/check.py --force` exits 0 (lint, conformance, types, spelling).
- [x] `python3 build/all.py --force` exits 0 (full bundle build: dash/hls/compiled/ui/experimental, debug + release).
- [x] `python3 build/test.py --filter Cmcd` — 57 / 57 pass (Phase 3 deletes ~125 wire-format tests now in CML, adds adapter glue + smoke).
- [x] `python3 build/test.py --quick` — 2927 / 2927 pass (no regressions outside CMCD; 4 environmental skips on this branch are unrelated to this work).
- [x] Demo smoke test on `bbb-dark-truths/dash.mpd` — V1+query, V2+query, V2+headers (with `unload→configure({useHeaders: true})→load` cycle) all emit correct CMCD output. Sequence numbers 0-based, reset on `sid` change. `v=2` only in `CMCD-Session` shard. Public re-exports (`EventType`, `PlayerState`, `StreamingFormat`) all readable at runtime from the compiled bundle. Zero CMCD-related console errors.

## Plan / spec docs

This PR includes the design + verification docs under `plans/cmcd-cml-refactor/`:

- [`spec.md`](plans/cmcd-cml-refactor/spec.md) — canonical spec, file lists, type translations, encoding rules, lifecycle tables.
- [`plan.md`](plans/cmcd-cml-refactor/plan.md) — phase-by-phase implementation plan with sub-phase landing notes.
- [`cml-version.md`](plans/cmcd-cml-refactor/cml-version.md) — Phase 0 CML API verification report (pin SHA, method-by-method confirmation against CML source).

These remain in the repo as Phase 2 + 3 reference. They can be deleted once Phase 3 merges if maintainers prefer.

## Commit list (for reviewer convenience)

**Phase 0 — CML verification (5 commits, docs-only):**
```
79702531e docs(cmcd): add Phase 0 CML version pin + API verification report
33c7c78ab docs(cmcd): fix doc cross-references in Phase 0 verification report
be97afe47 docs(cmcd): restructure Phase 0 doc-update checklist into plan vs spec lists
6a851a2d8 docs(cmcd): apply Phase 0 verification findings to spec and plan
```

**Phase 1 — Vendor port + encoder delegation (~20 commits):**
```
a8d855179 chore(third_party): add cml-cmcd vendoring skeleton
0027abbe1 chore(cmcd): port cml-cmcd type definitions as closure typedefs
ae92000c7 chore(cmcd): port cml-cmcd enums to closure
c4d84a2d8 chore(cmcd): port cml-cmcd constants to closure
1e539e703 chore(cmcd): port cml-cmcd uuid shim
e6cb2563d chore(cmcd): wire phase 1A port into build, add doc consistency
1b51edfc5 chore(cmcd): vendor cml-utils + cml-sfv shims for encoder port
7a27aaacf chore(cmcd): port CMCD_FORMATTER_MAP (deferred from sub-phase A)
3d6d5ae27 chore(cmcd): port cml-cmcd encoders to closure
d9aa2f9a1 chore(cmcd): port cml-cmcd version-resolution helpers
9bcf6614e fix(cmcd): restore typedef requireType in cmcd.js/event/response, polish cml_sfv
988712ea6 chore(cmcd): port CmcdReporter-only typedefs (deferred from sub-phase A)
3de73b29b chore(cmcd): port cml-cmcd CmcdReporter to closure
d682bb1bb fix(cmcd): tighten transmissionMode typedef, unify ?? fallbacks in reporter
0f69e7f0e docs(cmcd): add Phase 1 sub-phase A-C completion status to plan
d8d614ce3 refactor(cmcd): delegate encoding to vendored cml-cmcd
adfdfab05 fix(cmcd): drop non-spec 'ld'/'lh' StreamingFormat values
4aa5ff76b docs(cmcd): mark Phase 1 sub-phase D complete in plan
27cd16907 fix(cmcd): thread version/reportingMode + prepare-once for header shards
b94f7ebca test(cmcd): update assertions for CML wire-format alignments
0e3883181 docs(cmcd): mark Phase 1 sub-phase E complete in plan
d663f6c12 docs(cmcd): mark Phase 1 sub-phase F complete; add all-phases PR draft
```

**Phase 2 — Adopt CML constants/enums (1 commit):**
```
67443aacb refactor(cmcd): adopt CML constants/enums; delete shaka duplicates
```

**Phase 3 — Adapter rewrite (2 commits):**
```
965ba69f8 refactor(cmcd): rewrite shaka.util.CmcdManager as thin adapter around CmcdReporter
43cc7f332 fix(cmcd): preserve video_ across reset() so configure() can rebuild reporter
```

The first 4 commits (`79702531e`–`6a851a2d8`) are Phase 0 docs only and could be split off as a docs-only PR if maintainers prefer. The rest are implementation.
