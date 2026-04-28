<!--
Phase 1 PR draft. Temporary file (not committed). Move title to PR title
and body to PR body when opening. Per Task 1.12 step 5 / Task 1.14 of
plans/cmcd-cml-refactor/plan.md.
-->

# Title

```
refactor(cmcd): vendor @svta/cml-cmcd, delegate encoding to CML (1/3)
```

# Body

## Summary

Phase 1 of 3 in the CMCD CML refactor. Replaces shaka's custom CMCD wire-format encoding with a vendored Closure port of [`@svta/cml-cmcd`](https://github.com/streaming-video-technology-alliance/common-media-library) (CML) under `third_party/cml-cmcd/`. Phases 2 and 3 will adopt CML's constants/enums (Phase 2) and rewrite `cmcd_manager.js` as a thin adapter around `CmcdReporter` (Phase 3) — see [`plans/cmcd-cml-refactor/spec.md`](plans/cmcd-cml-refactor/spec.md) and [`plans/cmcd-cml-refactor/plan.md`](plans/cmcd-cml-refactor/plan.md).

This PR is **behavior-preserving** for shaka's public API, modulo three documented intentional wire-format changes that align shaka with CTA-5004 / CTA-5004-B and CML's spec-conformant output.

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

## Diff size

- `third_party/cml-cmcd/`: 74 new JS files + LICENSE/NOTICE/SUMMARY (+5017 lines).
- `lib/util/cmcd_manager.js`: +100 / −138 lines (net −38).
- `test/util/cmcd_manager_unit.js`: +107 / −140 lines (net −33; mostly assertion updates and the deleted `urlToRelativePath` describe block).
- `build/conformance.textproto`: 2 entries added (`setInterval`, `fetch`).
- `build/types/core`: 74 entries added for the vendored files.
- `plans/cmcd-cml-refactor/`: design + verification docs.

**Total**: 84 files, +5797 / −327.

(Plan estimated ~3000 lines for the port; actual is ~5000 because of (a) `cml_sfv.js` (~448 LoC RFC 8941 serializer shim — CML uses `@svta/cml-utils`'s SFV encoder, which we vendor inline since the shim doesn't ship as a separate package), (b) 8 spec-excluded files re-included as runtime dependencies, and (c) generous license/notice headers per Apache 2.0.)

## Verification

- [x] `python3 build/check.py` exits 0 (lint, conformance, types, spelling).
- [x] `python3 build/all.py` exits 0 (full bundle build: dash/hls/compiled/ui/experimental, debug + release).
- [x] `python3 build/test.py --filter Cmcd` — 124 / 124 pass.
- [x] `python3 build/test.py --quick` — 2995 / 2995 pass (no regressions outside CMCD).
- [x] Demo smoke test on `bbb-dark-truths/dash.mpd` — query mode emits `?CMCD=cid="…",ot=m,sf=d,sid="…",sn=N,su,v=2` (no `ts`, no `sf=ld`, tokens unquoted, `v=2` always present); header mode emits `v=2` only in `CMCD-Session` shard (the C2 sub-phase E fix verified end-to-end). Zero JS console errors. See [`plan.md`](plans/cmcd-cml-refactor/plan.md) "Sub-phase F landing notes" for the full capture.

## Plan / spec docs

This PR includes the design + verification docs under `plans/cmcd-cml-refactor/`:

- [`spec.md`](plans/cmcd-cml-refactor/spec.md) — canonical spec, file lists, type translations, encoding rules, lifecycle tables.
- [`plan.md`](plans/cmcd-cml-refactor/plan.md) — phase-by-phase implementation plan with sub-phase landing notes.
- [`cml-version.md`](plans/cmcd-cml-refactor/cml-version.md) — Phase 0 CML API verification report (pin SHA, method-by-method confirmation against CML source).

These remain in the repo as Phase 2 + 3 reference. They can be deleted once Phase 3 merges if maintainers prefer.

## Phase 1 commit list (for reviewer convenience)

```
79702531e docs(cmcd): add Phase 0 CML version pin + API verification report
33c7c78ab docs(cmcd): fix doc cross-references in Phase 0 verification report
be97afe47 docs(cmcd): restructure Phase 0 doc-update checklist into plan vs spec lists
6a851a2d8 docs(cmcd): apply Phase 0 verification findings to spec and plan
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
```

The first 5 commits (`79702531e`–`6a851a2d8`) are Phase 0 docs only and could be split off as a docs-only PR if maintainers prefer. The rest are Phase 1 proper.
