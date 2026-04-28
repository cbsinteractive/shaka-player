<!--
Cumulative PR draft for the CMCD CML refactor. Phase 1 + Phase 2 are
landed on feat/cmcd-cml-refactor; Phase 3 will append before the eventual
single all-phases PR.
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
- **Phase 3** *(in progress)* rewrites `lib/util/cmcd_manager.js` as a thin adapter around `cml.cmcd.CmcdReporter`, deletes the state machine, ships experimental v2 config renames.

See [`plans/cmcd-cml-refactor/spec.md`](plans/cmcd-cml-refactor/spec.md) and [`plans/cmcd-cml-refactor/plan.md`](plans/cmcd-cml-refactor/plan.md) for full design + rationale.

Phases 1 + 2 are **behavior-preserving** for shaka's public API, modulo three documented intentional wire-format changes that align shaka with CTA-5004 / CTA-5004-B and CML's spec-conformant output.

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

## Diff size (Phases 1 + 2; Phase 3 will append)

- `third_party/cml-cmcd/`: 74 new JS files + LICENSE/NOTICE/SUMMARY (+5017 lines, Phase 1).
- `lib/util/cmcd_manager.js`: +100 / −138 (Phase 1) and +13 / −87 (Phase 2). Cumulative net −112 / +113.
- `test/util/cmcd_manager_unit.js`: +107 / −140 (Phase 1) and +12 / 0 (Phase 2 value-identity test). Cumulative net −33 / +119.
- `build/conformance.textproto`: 2 entries added (`setInterval`, `fetch`).
- `build/types/core`: 74 entries added for the vendored files.
- `plans/cmcd-cml-refactor/`: design + verification docs.

**Total (Phases 1 + 2)**: ~85 files, ~+5800 / ~−500.

(Plan estimated ~3000 lines for the port; actual is ~5000 because of (a) `cml_sfv.js` (~448 LoC RFC 8941 serializer shim — CML uses `@svta/cml-utils`'s SFV encoder, which we vendor inline since the shim doesn't ship as a separate package), (b) 8 spec-excluded files re-included as runtime dependencies, and (c) generous license/notice headers per Apache 2.0.)

## Verification (Phases 1 + 2)

- [x] `python3 build/check.py` exits 0 (lint, conformance, types, spelling).
- [x] `python3 build/all.py` exits 0 (full bundle build: dash/hls/compiled/ui/experimental, debug + release).
- [x] `python3 build/test.py --filter Cmcd` — 125 / 125 pass (Phase 2 added a value-identity test).
- [x] `python3 build/test.py --quick` — 2996 / 2996 pass (no regressions outside CMCD).
- [x] Demo smoke test on `bbb-dark-truths/dash.mpd` — query mode emits `?CMCD=cid="…",ot=m,sf=d,sid="…",sn=N,su,v=2` (no `ts`, no `sf=ld`, tokens unquoted, `v=2` always present); header mode emits `v=2` only in `CMCD-Session` shard (the C2 sub-phase E fix verified end-to-end). Zero JS console errors. See [`plan.md`](plans/cmcd-cml-refactor/plan.md) "Sub-phase F landing notes" for the full capture.

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

The first 4 commits (`79702531e`–`6a851a2d8`) are Phase 0 docs only and could be split off as a docs-only PR if maintainers prefer. The rest are implementation.
