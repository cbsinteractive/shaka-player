# CMCD refactor: replace shaka-player's custom integration with `@svta/cml-cmcd`

Date: 2026-04-27
Status: Approved design, ready for implementation planning
Tracking: [shaka-player#3619](https://github.com/shaka-project/shaka-player/issues/3619), [common-media-library#40](https://github.com/streaming-video-technology-alliance/common-media-library/issues/40)

## Context

Shaka Player ships a custom CMCD (Common Media Client Data, CTA-5004) integration:

- [`lib/util/cmcd_manager.js`](lib/util/cmcd_manager.js) — 1704 lines, supports CMCD v1 and v2 in request/response/event modes.
- [`test/util/cmcd_manager_unit.js`](test/util/cmcd_manager_unit.js) — 4317 lines, mostly testing CMCD wire-format correctness.
- [`externs/cmcd.js`](externs/cmcd.js) — `CmcdData` typedef.
- [`externs/shaka/player.js`](externs/shaka/player.js) — `shaka.extern.CmcdConfiguration` and `shaka.extern.CmcdTarget` typedefs.

Other major adaptive players (hls.js, dash.js) have already migrated to the
[`@svta/cml-cmcd`](https://github.com/streaming-video-technology-alliance/common-media-library/tree/main/libs/cmcd)
package as the shared reference implementation. See
[hls.js PR #7725](https://github.com/video-dev/hls.js/pull/7725) for the pattern
this design follows.

## Motivation

This refactor pursues three explicit goals:

1. **Standards conformance / single source of truth.** CML is the shared
   reference implementation for CMCD across players. Tracking it gets shaka's
   CMCD output spec-aligned automatically as v2 finalizes.
2. **Reduce maintenance burden.** ~6000 lines of CMCD code (manager + tests)
   carry the full encoding, validation, and state-machine surface. Most of that
   logic is identical in CML. Maintenance can move upstream where multiple
   players amortize it.
3. **Submit upstream PR-friendly to shaka maintainers.** No new runtime npm
   dependency (preserves shaka's hard-won "zero runtime deps" property), no
   build-system upheaval, incremental phasing for review.

## Constraints

These are non-negotiable inputs to the design:

1. **Zero runtime npm dependencies.** [AGENTS.md](AGENTS.md) calls this out as
   a "hard-won property... do not introduce any." Direct npm consumption of
   `@svta/cml-cmcd` is not on the table.
2. **Closure Compiler ADVANCED_OPTIMIZATIONS.** All source uses
   `goog.provide`/`goog.require` with JSDoc type annotations. Externs define
   public types.
3. **TypeScript migration is on the horizon.**
   [shaka-player#8262](https://github.com/shaka-project/shaka-player/issues/8262)
   tracks shaka's planned migration to TypeScript (P2, Backlog as of
   2026-04). Whatever closure-era infrastructure we build is **transitional**
   and gets deleted on migration day. Avoid building durable infrastructure
   that exists only to bridge closure to a TS package.
4. **Public API back-compat.** `shaka.extern.CmcdConfiguration`,
   `shaka.extern.CmcdTarget`, and the `CmcdData` typedef are consumed by
   shaka users. The `shaka.util.CmcdManager.StreamingFormat` enum is
   `@export`ed (see [`cmcd_manager.js:1610`](lib/util/cmcd_manager.js:1610)).
   v1 fields and v2 fields outside the experimental flag must keep their
   existing names. v2-only fields flagged experimental may be renamed.

## Decision summary

- **Strategy: Manual vendored port** of `@svta/cml-cmcd` into
  `third_party/cml-cmcd/`, following the
  [`third_party/closure-uri/`](third_party/closure-uri/) precedent.
- **Scope: Full replacement.** `shaka.util.CmcdManager` becomes a thin
  shaka-specific adapter wrapping `cml.cmcd.CmcdReporter`. State tracking,
  encoding, key filtering, sequence numbers, and event timing all move to the
  reporter.
- **Phasing: Three sequential PRs** (vendor + delegate encoding → dedupe
  constants → adapter rewrite). Each phase is independently reviewable and
  bisectable.
- **Test ownership boundary:** CMCD wire-format tests move to / live in CML
  upstream. Shaka keeps shaka-specific glue tests + a small end-to-end smoke
  set.

Rejected alternatives:

- **CML emits a closure-friendly distribution** (option A in brainstorm).
  Rejected because shaka's TS migration would orphan the closure target in
  CML; not worth the upstream burden.
- **Build-time TS-to-Closure transpiler in shaka** (option B). Rejected
  because tsickle is archived (last push 2024-05) and a custom transformer
  would cost ~500-1500 LoC of throwaway tooling. CML's TS uses `as const`
  enum patterns, type-only imports, intersections, and `ValueOf<>` generics
  that aren't trivial to mechanically translate.
- **Wait for shaka's TS migration before doing CMCD work.** Rejected because
  the migration is in Backlog with no concrete timeline; CMCD work shouldn't
  block on it.

## Architecture

Three layers, each with one job:

```
┌────────────────────────────────────────────────────────────────┐
│ shaka public API (UNCHANGED except experimental v2 renames)    │
│   shaka.extern.CmcdConfiguration   shaka.extern.CmcdTarget     │
│   externs/cmcd.js (CmcdData typedef)                           │
│   shaka.util.CmcdManager.StreamingFormat (the only @export)    │
└────────────────────────────────────────────────────────────────┘
                              ▲
                              │ (back-compat preserved)
┌────────────────────────────────────────────────────────────────┐
│ lib/util/cmcd_manager.js (REFACTORED, ~250 lines target)       │
│   Thin shaka-specific adapter:                                 │
│   - NetworkingEngine integration (applyRequestData /           │
│     applyResponseData) — public method signatures unchanged    │
│   - <video> + Player event listeners → reporter.update(...)   │
│     and reporter.recordEvent(...) (with deduplication)         │
│   - Maps shaka.extern.CmcdConfiguration → CmcdReporterConfig   │
│   - Wires CmcdReporter's `requester` callback to               │
│     NetworkingEngine for event-mode reports (POST + body)      │
└────────────────────────────────────────────────────────────────┘
                              │
                              │ goog.require('cml.cmcd.*')
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ third_party/cml-cmcd/ (NEW, vendored from CML)                 │
│   Closure-annotated JS port of @svta/cml-cmcd source           │
│   Namespace: cml.cmcd.* (mirrors CML's package shape)          │
│   SUMMARY.txt, LICENSE, NOTICE                                 │
└────────────────────────────────────────────────────────────────┘
```

**Future-proofing.** Choosing namespace `cml.cmcd.*` so it mirrors CML's
actual export surface. When shaka migrates to TypeScript:
`goog.require('cml.cmcd.CmcdReporter')` becomes
`import { CmcdReporter } from '@svta/cml-cmcd'`, and the entire
`third_party/cml-cmcd/` directory deletes — no other code changes.

## The vendored port (`third_party/cml-cmcd/`)

### Subset to port

Pulled from `@svta/cml-cmcd` v2.3.0 source at
`libs/cmcd/src/`. Files map one-to-one (CamelCase TS file → snake_case JS file).

**Included (~25 files):**

| Category | Files |
|---|---|
| Reporter (the main class) | `CmcdReporter.ts` |
| Encoders | `encodeCmcd.ts`, `encodePreparedCmcd.ts`, `prepareCmcdData.ts`, `toCmcdHeaders.ts`, `toCmcdQuery.ts`, `toCmcdUrl.ts`, `toCmcdValue.ts`, `appendCmcdHeaders.ts`, `appendCmcdQuery.ts`, `toPreparedCmcdHeaders.ts`, `ensureHeaders.ts` |
| Helpers | `upConvertToV2.ts`, `resolveVersion.ts` |
| Constants | `CMCD_DEFAULT_TIME_INTERVAL.ts`, `CMCD_EVENT_KEYS.ts`, `CMCD_FORMATTER_MAP.ts`, `CMCD_HEADER_MAP.ts`, `CMCD_INNER_LIST_KEYS.ts`, `CMCD_KEYS.ts`, `CMCD_KEY_TYPES.ts`, `CMCD_MIME_TYPE.ts`, `CMCD_PARAM.ts`, `CMCD_REQUEST_KEYS.ts`, `CMCD_RESPONSE_KEYS.ts`, `CMCD_STRING_LENGTH_LIMITS.ts`, `CMCD_TOKEN_VALUES.ts`, `CMCD_V1.ts`, `CMCD_V1_KEYS.ts`, `CMCD_V2.ts` |
| Enums | `CmcdObjectType.ts`, `CmcdStreamingFormat.ts`, `CmcdStreamType.ts`, `CmcdPlayerState.ts`, `CmcdEventType.ts`, `CmcdReportingMode.ts`, `CmcdTransmissionMode.ts`, `CmcdHeaderField.ts` |
| Type definitions (typedefs in closure) | `Cmcd.ts`, `CmcdData.ts`, `CmcdRequest.ts`, `CmcdResponse.ts`, `CmcdEvent.ts`, `CmcdReportConfig.ts`, `CmcdEventReportConfig.ts`, `CmcdReporterConfig.ts`, `CmcdEncodeOptions.ts`, `CmcdRequestReport.ts`, `CmcdRequestReportConfig.ts`, `CmcdFormatter.ts`, `CmcdFormatterMap.ts`, `CmcdFormatterOptions.ts`, `CmcdHeaderKey.ts`, `CmcdHeaderMap.ts`, `CmcdHeaderValue.ts`, `CmcdKey.ts`, `CmcdValue.ts`, `CmcdRequestKey.ts`, `CmcdCustomKey.ts`, `CmcdCustomValue.ts`, `CmcdObjectTypeList.ts`, `CmcdV1.ts`, `CmcdVersion.ts` |

**Excluded (explicitly skipped):**

| Category | Files | Why |
|---|---|---|
| Decoders | `decodeCmcd.ts`, `fromCmcdHeaders.ts`, `fromCmcdQuery.ts`, `fromCmcdUrl.ts`, `groupCmcdHeaders.ts` | Players emit CMCD; they don't parse it. |
| Validators | `validateCmcd.ts`, `validateCmcdEventReport.ts`, `validateCmcdEvents.ts`, `validateCmcdHeaders.ts`, `validateCmcdKeys.ts`, `validateCmcdRequest.ts`, `validateCmcdStructure.ts`, `validateCmcdValues.ts`, `CmcdValidationIssue.ts`, `CmcdValidationOptions.ts`, `CmcdValidationResult.ts`, `CmcdValidationSeverity.ts`, `CmcdDataValidationResult.ts`, `CmcdEventsValidationResult.ts`, `mergeValidationResults.ts`, `isValid.ts` | Tooling-only; large; halves port size. Add later only if shaka adds a debug-mode self-check. |
| Predicates | `isCmcdCustomKey.ts`, `isCmcdEventKey.ts`, `isCmcdRequestKey.ts`, `isCmcdResponseReceivedKey.ts`, `isCmcdV1Data.ts`, `isCmcdV1Key.ts`, `isCmcdV2Data.ts`, `isTokenField.ts` | Tooling-only. |

### `@svta/cml-utils` dependency handling

CML's CMCD package depends on `@svta/cml-utils` for `uuid()`, `HttpRequest`,
`HttpResponse`, and `ValueOf<>`. Type-only imports (`HttpRequest`,
`HttpResponse`, `ValueOf<>`) erase during conversion. Only one runtime
dependency remains: `uuid()`, called at one site (`createCmcdReporterConfig`'s
default for `sid`).

**Approach:** Vendor a tiny `third_party/cml-cmcd/cml_utils.js` (`goog.provide('cml.cmcd.uuid')`)
shimming `crypto.randomUUID()` (already polyfilled in
[`lib/polyfill/random_uuid.js`](lib/polyfill/random_uuid.js)). The vendored
`CmcdReporter` source stays **verbatim** to upstream CML, which makes per-bump
diffs trivial.

The shaka adapter always sets `sid` explicitly when building
`CmcdReporterConfig` (drawn from `shaka.extern.CmcdConfiguration.sessionId` or
generated via shaka's own UUID). The reporter's default-`sid` codepath is dead
at runtime and closure-stripped.

This is invisible at the swap boundary: `goog.require('cml.cmcd.CmcdReporter')`
→ `import { CmcdReporter } from '@svta/cml-cmcd'`. Post-migration, CML's
transitive dep on `@svta/cml-utils` is internal to the npm package; shaka
never imports from cml-utils directly.

### File naming and namespace conventions

- TS file `libs/cmcd/src/CmcdReporter.ts` → JS file `third_party/cml-cmcd/cmcd_reporter.js`.
- `goog.provide('cml.cmcd.CmcdReporter')` — class/symbol name preserved, scoped under `cml.cmcd.*`.
- TS `import { X } from './Y.ts'` → closure `goog.require('cml.cmcd.Y')`.
- One exception: utility module `cml_utils.js` provides `cml.cmcd.uuid`.

### `SUMMARY.txt` format

Extends the [`third_party/SUMMARY.txt`](third_party/SUMMARY.txt) precedent:

```
cml-cmcd
  Common Media Library CMCD encoder + reporter, v2.3.0,
  by Streaming Video Technology Alliance / Casey Occhialini et al.
  Apache 2.0 license.
  https://github.com/streaming-video-technology-alliance/common-media-library
    /tree/main/libs/cmcd
  Source npm: @svta/cml-cmcd

  TRANSITIONAL: This vendored port exists because shaka-player uses Closure
  Compiler. When shaka migrates to TypeScript (issue #8262), delete this
  directory and replace `goog.require('cml.cmcd.X')` with
  `import { X } from '@svta/cml-cmcd'`.

  Local mods:
    - TypeScript source converted to Closure-annotated JS by hand
    - Type-only imports erased; replaced with local closure typedefs
    - Decoders (decodeCmcd, fromCmcd*) omitted: shaka emits CMCD only
    - Validators (validateCmcd*, isCmcd*) omitted: tooling-only utilities
    - cml-utils dep removed: shaka adapter always sets `sid` explicitly;
      a 5-line cml_utils.js shim provides `uuid` for any dead default paths
```

`LICENSE` and `NOTICE` files copied from CML; both Apache 2.0 (matches shaka).

### Build integration

- `third_party/cml-cmcd/*.js` files added to [`build/types/core`](build/types/core)
  alongside the existing `+../../lib/util/cmcd_manager.js` entry. CMCD remains in
  the core build variant.
- Any new vocabulary that fails the spell-checker added to
  [`project-words.txt`](project-words.txt).

## The shaka-side adapter ([`lib/util/cmcd_manager.js`](lib/util/cmcd_manager.js))

Target size: ~250 lines (down from 1704). Three responsibilities:

### 1. Lifecycle and player wiring

- Construct `cml.cmcd.CmcdReporter` on first `configure(config)` call.
  **Reporter is always-on**: even when no `eventTargets` are configured, the
  reporter is the unified path for request-mode encoding (via
  `createRequestReport`). When `eventTargets` are present, the same reporter
  also batches and dispatches event-mode reports.
- Call `reporter.start()` after construction to begin time-interval timers
  for any configured event targets.
- On `reset()`: call `reporter.stop(true)` (where `true` = flush pending
  events before stopping), null out the reporter, remove all `<video>`
  and player event listeners.
- On `configure()` with materially-changed config: call `stop(true)` on
  the old reporter, then construct + `start()` on a new one.
- Subscribe to `<video>` events and `shaka.Player` events; translate state
  changes to `reporter.update(...)` and `reporter.recordEvent(...)` calls
  (see table below).

### 2. Request/response interception

Existing public methods preserved with same signatures:

```js
applyRequestData(type, request, context)
applyResponseData(type, response, context)
```

`applyRequestData` flow:

1. Adapter extracts shaka-specific fields:
   - `objectType` ← `RequestType` + `segment.type`/`segment.mimeType`
   - `bitrate` ← `segmentRef.variant.bandwidth`
   - `duration` ← `segmentRef.endTime - segmentRef.startTime`
   - `topBitrate` ← player ABR / variant constraints
   - `rtp` ← `bitrate × config.rtpSafetyFactor` (computed in adapter; CML's
     reporter doesn't know about a safety factor)
2. Adapter constructs the CMCD data object, applying v2 encoding rules:
   - **Inner-list keys** (`br`, `tb`, `bl`, `mtp`, `nor`) wrap their values
     in single-element arrays when `version >= 2` per CMCD v2 Structured
     Fields encoding: `data.br = [bitrate]`, `data.bl = [bufferLength]`,
     `data.tb = [topBitrate]`, `data.mtp = [throughputKbps]`,
     `data.nor = [nextUrl]`. For v1, these stay as scalars.
   - **NaN guards**: `bl`, `tb`, `mtp` may be `NaN` early in playback
     (buffer not yet established, no top variant chosen, throughput
     estimator not seeded). Adapter checks `Number.isFinite(...)` before
     including these keys; otherwise omits. Required to prevent Structured
     Fields serialization errors in CML's encoder.
3. Adapter calls `reporter.createRequestReport(request, data)`. CML returns
   the original request augmented with applied CMCD encoding (CML signature:
   `R & CmcdRequestReport<R['customData']>` — returns a new object derived
   from the input, not in-place mutation).
4. Adapter copies the CMCD-applied fields (`uris`, `headers`) from CML's
   returned report back onto shaka's `request` object — preserving shaka's
   existing in-place-mutation contract for `applyRequestData` callers.

`v=1` field is omitted from CMCD output per spec (v1 is the default
interpretation if `v` is absent). CML's encoders handle this internally;
adapter does not need to filter explicitly.

`nor` (next object request) URL relativization is a **deliberate
behavioral change**: shaka's existing `urlToRelativePath` produced
**path-relative** URLs; CML uses `url.origin` as `baseUrl` to produce
**root-relative** URLs. This aligns shaka's output with CML's
spec-conformant behavior. Flag this in the Phase 1 PR description as an
intentional wire-format change (consumers parsing `nor` server-side may
need to adjust path-resolution logic).

`applyResponseData` flow:

1. Adapter measures `ttfb`/`ttlb` via existing `requestTimestampMap_` mechanism.
2. Adapter calls `reporter.recordResponseReceived(response, data)`. CML's
   signature is `recordResponseReceived(response: HttpResponse, data:
   Partial<Cmcd> = {})` — both args are CMCD-shaped, not the flat
   `{ttfb, ttlb, rc, url}` shape. Two valid call patterns:
   - **Primary path** (let CML derive): synthesize a `ResourceTiming`
     object on `response.resourceTiming` (`{startTime, responseStart,
     duration}`); CML auto-derives `ts`, `ttfb`, `ttlb`. `rc` comes from
     `response.status`. `url` comes from `response.request.url`.
   - **Override path:** pass `{ttfb, ttlb, rc, url}` (or any subset) as
     the `data` argument. Override values win over auto-derived ones.
   Adapter is free to mix: e.g., supply `resourceTiming` for `ts` while
   passing pre-computed `ttfb`/`ttlb` from `requestTimestampMap_`.
3. `recordResponseReceived` returns `void` — no fields to copy back to
   `response`. Reporter buffers response data for the next emission
   opportunity (and internally fires the v2 `rr` "response received"
   event when configured).

The shaka-specific extraction helpers
(`getObjectType_`, `getBitrate_`, `getDuration_`, `getTopBitrate_`,
`getStreamFormat_`) **stay in the adapter**. They encode "how to read
shaka's variant/stream/segment shapes" — shaka-specific knowledge.

What goes away from the manager: all encoding logic, key filtering,
header/query construction, sequence-number tracking, event-timer code, mode
selection, MSD computation, the various `applyRequest_`/`applyManifestData`
private methods.

### 3. Configuration translation

One function `toReporterConfig_(shakaCmcdConfig)` performs field renames and
shape conversion:

| `shaka.extern.CmcdConfiguration` (post-rename) | `cml.cmcd.CmcdReporterConfig` |
|---|---|
| `enabled: boolean` | (gate at adapter level — adapter no-ops when `false`) |
| `useHeaders: boolean` | `transmissionMode: CMCD_HEADERS \| CMCD_QUERY` |
| `sessionId: string` | `sid: string` (always set explicitly) |
| `contentId: string` | `cid: string` |
| `rtpSafetyFactor: number` | (adapter uses to compute `rtp` per request) |
| `includeKeys: Array<CmcdKey>` | `enabledKeys: Array<CmcdKey>` |
| `version: 1\|2` | `version: CMCD_V1 \| CMCD_V2` |
| **`eventTargets`** *(was `targets`, experimental rename)* | `eventTargets` |
| Per-target: **`includeKeys`** *(was `enabledKeys`, experimental rename)* | Per-target: `enabledKeys` |

The per-target rename mirrors hls.js PR #7725's pattern:
`Omit<CmcdEventReportConfig, 'enabledKeys'> & { includeKeys?: CmcdKey[] }`.
shaka users see `includeKeys` consistently (top-level and per-target); CML
internals see `enabledKeys` per-target.

The experimental flag on shaka's CMCD v2 config (see
[`externs/shaka/player.js:2810-2818`](externs/shaka/player.js)) authorizes
these renames. v1 fields keep their existing names.

**Per-target `eventTargets[]` field shape.** Each entry in `eventTargets`
configures one event-reporting endpoint. Shape (post-rename):

| Per-target field | Type | Purpose |
|---|---|---|
| `url` | `string` | Endpoint URL for CMCD event reports |
| `events` | `Array<CmcdEventType>` | Which events trigger reports (e.g., `[PLAY_STATE, ERROR, RESPONSE_RECEIVED]`); empty / undefined = none |
| `interval` | `number` *(seconds)* | Periodic time-interval reports (`0` disables; CML default `CMCD_DEFAULT_TIME_INTERVAL = 30`). Field name matches CML's `CmcdEventReportConfig.interval`. |
| `batchSize` | `number` | Number of events to batch before dispatch (default `1` = no batching) |
| `includeKeys` | `Array<CmcdKey>` *(was `enabledKeys`)* | Subset of CMCD keys to include in this target's reports |
| `version` | `1 \| 2` | Per-target version override; defaults to top-level `version` |

Shaka maps to CML's `CmcdEventReportConfig` shape:
`Omit<CmcdEventReportConfig, 'enabledKeys'> & {includeKeys?: CmcdKey[]}`,
matching hls.js PR #7725's pattern. The adapter renames `includeKeys` →
`enabledKeys` per-entry when constructing the reporter config.

Update [`externs/shaka/player.js`](externs/shaka/player.js)
`shaka.extern.CmcdTarget` typedef to reflect this shape; existing fields
in the typedef (e.g., `events`) stay; renamed fields are
`enabledKeys` → `includeKeys` and `timeInterval` → `interval` (matches
CML's `CmcdEventReportConfig`).

### Player state ↔ reporter state mapping

State mutation and event emission use **two distinct reporter methods**:

- `reporter.update(partialState)` — mutates persistent state; the next
  emitted payload reflects the change.
- `reporter.recordEvent(eventType, data)` — emits a discrete v2 event.

Many state transitions require **both**: `update()` to persist the new
state, then `recordEvent()` to emit a v2 event noting the transition.

| shaka event/signal | reporter calls |
|---|---|
| Buffering becomes true | `update({playerState: REBUFFERING})` + `recordEvent(PLAY_STATE)` |
| Buffering becomes false | `update({playerState: PLAYING})` + `recordEvent(PLAY_STATE)` |
| Pause | `update({playerState: PAUSED})` + `recordEvent(PLAY_STATE)` |
| Seeking | `update({playerState: SEEKING})` + `recordEvent(PLAY_STATE)` |
| Ended | `update({playerState: ENDED})` + `recordEvent(PLAY_STATE)` |
| Fatal error | `update({playerState: FATAL_ERROR})` + `recordEvent(ERROR)` |
| Variant switch (bitrate change) | `update({br: [newBitrate]})` + `recordEvent(BITRATE_CHANGE)` |
| Content ID changes | `update({cid: newId})` (CML emits the v2 `c` event internally) |
| Visibility → backgrounded | `update({backgrounded: bool})` (CML emits the v2 `b` event internally) |
| Mute | `update({muted: true})` + `recordEvent(MUTE)` |
| Unmute | `update({muted: false})` + `recordEvent(UNMUTE)` |
| Throughput estimate update | `update({mtp: [bandwidthKbps]})` |

**Streaming format and low-latency.** `sf` reflects the manifest type only
(`'d'`/`'h'`/`'s'`/`'o'`) — not the low-latency state. shaka previously
emitted `'ld'`/`'lh'` for LL DASH/HLS, but those values are not in
CTA-5004 or CTA-5004-B; CML correctly omits them. Phase 1 drops the LL
mutation in shaka's `setLowLatency` so that LL DASH emits `sf=d` and LL
HLS emits `sf=h`. This is a wire-format change called out alongside
`nor` URL relativization in the Phase 1 PR description.

Also note manifest type is set once at load time and rarely changes; the
adapter feeds `streamingFormat` via `update()` from the manifest parser,
not from a `setLowLatency` callback.

**Player-state deduplication.** Adapter tracks the last-emitted
`playerState` and skips both `update` and `recordEvent` when the new state
matches. Without this, `<video>` event listeners can fire repeatedly on
stable states (e.g., `playing` after every minor stall), spamming the
reporter and downstream targets:

```js
// in CmcdManager
setPlayerState_(state) {
  if (this.lastPlayerState_ === state) return;
  this.lastPlayerState_ = state;
  this.reporter_.update({playerState: state});
  this.reporter_.recordEvent(cml.cmcd.CmcdEventType.PLAY_STATE);
}
```

MSD is computed internally by `CmcdReporter`; the adapter does not feed it.

### Public-API back-compat details

- **`shaka.util.CmcdManager.StreamingFormat`** stays available, implemented
  as a re-export alias of `cml.cmcd.CmcdStreamingFormat`. `@export`
  annotation preserved. Spec-conformant values: `'d'`, `'h'`, `'s'`, `'o'`.
  shaka's previously-shipped non-spec values `'ld'` (LL-DASH) and `'lh'`
  (LL-HLS) — from an old unreleased CMCD draft, not in CTA-5004 or
  CTA-5004-B — are dropped in Phase 1. Wire-format change: LL DASH emits
  `sf=d`, LL HLS emits `sf=h`.
- **`shaka.util.CmcdManager.{ObjectType,Version,StreamType,CmcdKeys,CmcdV2Constants,CmcdV2Keys,CmcdMode}`**
  are all internal-only (no `@export`). Deleted in Phase 2; references rewritten to `cml.cmcd.*`.
- **`externs/cmcd.js`** (`CmcdData` typedef): kept as the public-facing typedef
  shape. Internally, the adapter and vendored port use `cml.cmcd.CmcdData`.
  The two are structurally equivalent.
- **`shaka.extern.CmcdConfiguration`** typedef: `targets` field renamed to
  `eventTargets`; `shaka.extern.CmcdTarget` typedef gets `enabledKeys` →
  `includeKeys` rename. Both are experimental-flagged so breaking change
  is acceptable.

**New public re-exports for v2 configuration.** Shaka users configuring
`eventTargets[].events` need access to the `CmcdEventType` enum (otherwise
they'd have to hardcode magic strings like `'ps'`, `'e'`, `'rr'`). Minimum
re-exports added to the existing `shaka.util.CmcdManager` class scope (no
new namespace; consistent with where `StreamingFormat` already lives):

| Re-exported symbol | From CML | Purpose |
|---|---|---|
| `shaka.util.CmcdManager.EventType` | `cml.cmcd.CmcdEventType` | Configure `eventTargets[].events` |
| `shaka.util.CmcdManager.PlayerState` | `cml.cmcd.CmcdPlayerState` | Reading player-state field externally |

Both are `@export`ed string-enum aliases of CML symbols (string values
identical, names match). Existing
`shaka.util.CmcdManager.StreamingFormat` stays where it is for back-compat.

Other CML enums and constants (`CmcdObjectType`, `CmcdStreamType`,
`CmcdHeaderField`, `CMCD_V1`, `CMCD_V2`, key arrays) stay internal under
`cml.cmcd.*` until users have a documented need; shaka maintainers may
expand the re-export surface in follow-up PRs based on user feedback. This
is a more conservative public-API expansion than hls.js's
`exports-named.ts` re-exports — appropriate for shaka's generally
conservative API surface.

### Event-mode dispatch via NetworkingEngine

`CmcdReporter`'s constructor takes a `requester: (req) =>
Promise<{status: number}>` callback as its **second positional argument**
(not a `CmcdReporterConfig` field) for dispatching event-mode reports:
`new CmcdReporter(reporterConfig, requesterFn)`. **Event-mode transport
is HTTP POST with a body** — CML constructs each event request as
`method: 'POST'` with the encoded CMCD payload in the body (per dash.js
PR #4816's `Constants.CMCD_MODE_BODY` precedent and CML's reporter source).
This is distinct from request-mode encoding (which mutates an existing
request's URL or headers); event mode emits new requests to dedicated
event-target URLs.

Shaka adapter wires `requester` to `NetworkingEngine` rather than raw `fetch`:

```js
const requester = async (cmcdReq) => {
  const retryParams = shaka.net.NetworkingEngine.defaultRetryParameters();
  const shakaReq = shaka.net.NetworkingEngine.makeRequest(
      [cmcdReq.url], retryParams);
  shakaReq.method = cmcdReq.method || 'POST';
  shakaReq.headers = cmcdReq.headers || {};

  // CML's reporter always emits body as a string (structured-fields
  // encoded by encodeCmcd, joined by '\n'). shaka.extern.Request.body
  // expects BufferSource; convert via UTF-8.
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
```

This routes CMCD event-mode reports through shaka's NetworkingEngine,
inheriting auth-header injection, retry, request filters, etc. — same as
manifests and segments. **No new public config field needed** (vs. hls.js's
`loader` field): users already control transport via NetworkingEngine plugins.

`RequestType.TIMING` is the existing "non-content network operation" bucket.
Dash.js introduced a dedicated `HTTPRequest.CMCD_EVENT` type for similar
purposes. Shaka can later add `RequestType.CMCD_EVENT_REPORT` in a follow-up
PR without changing the adapter contract; defer until maintainers decide.

## CML-side requirements (verify before/during Phase 3)

The adapter assumes CmcdReporter exposes the following surface. Verify against
CML v2.3.0 (or whichever version is current at implementation time); add
upstream in CML if missing.

| Need | Status |
|---|---|
| `reporter.start()` / `reporter.stop(flush)` / `reporter.flush()` lifecycle | confirmed (per CML source inspection) |
| `reporter.update(partialState)` for state mutation | confirmed |
| `reporter.recordEvent(eventType, data)` for discrete event emission | confirmed |
| `reporter.createRequestReport(request, data)` for request-mode encoding | confirmed (CML signature: `R & CmcdRequestReport<R['customData']>`) |
| `reporter.recordResponseReceived(response, data)` | confirmed |
| `requester` constructor parameter (2nd positional arg) for event-mode dispatch | confirmed (CML constructs `method: 'POST'` with string body, `Content-Type: application/cmcd`) |
| Built-in time-interval event timer | confirmed (reporter owns; shaka stops running its own) |
| MSD computed internally by reporter | confirmed |
| Sequence numbers per-target | likely present; verify per v2 spec |

State fields the adapter feeds via `update()`:

| Field | Source | Maps to |
|---|---|---|
| `playerState: CmcdPlayerState` | video events + buffer state | v2 `sta` |
| `streamingFormat: CmcdStreamingFormat` | manifest parser type + LL flag | `sf` |
| `cid: string` | content ID change | `cid` (also triggers v2 `c` event) |
| `backgrounded: boolean` | visibility detection | `bg` (also triggers v2 `b` event) |
| `muted: boolean` | media element state | (v2 `m`/`um` events) |
| `mtp: number` | shaka throughput estimator | `mtp` |
| `bl: number` (buffer length) | shaka playhead | `bl` (per-request, may live on `createRequestReport` data) |

CMCD v2 events the reporter must support emitting (matches shaka's existing
`CmcdV2Events` set in [`cmcd_manager.js:1653-1664`](lib/util/cmcd_manager.js:1653)):

`ps`, `e`, `t`, `c`, `b`, `m`, `um`, `pe`, `pc`, `rr`.

Verify CML's `CmcdEventType` enum includes all of these. If any are missing,
add to CML in a precursor PR before shaka Phase 3 lands.

## Migration phasing

Three sequential PRs. Each is independently reviewable, bisectable, and
behavior-preserving except where explicitly noted.

### Phase 1 — Vendor `third_party/cml-cmcd/` and route encoding through it

- Add `third_party/cml-cmcd/` directory with the closure-annotated port
  (~25 files), `SUMMARY.txt`, `LICENSE`, `NOTICE`.
- Update [`build/types/core`](build/types/core) to include the new files.
- Update [`project-words.txt`](project-words.txt) for any new vocab.
- Refactor shaka's `serialize`/`toQuery`/`appendQueryToUri`/`urlToRelativePath`
  static methods in [`cmcd_manager.js`](lib/util/cmcd_manager.js) to delegate
  to `cml.cmcd.encodeCmcd` / `cml.cmcd.appendCmcdQuery` /
  `cml.cmcd.appendCmcdHeaders`.
- **Near-no behavior change.** State machine, sequence numbers, event
  timing, public API all unchanged. **One known intentional wire-format
  change**: `nor` URLs become root-relative (CML's spec-conformant
  behavior) rather than path-relative. Document in PR description.
- Tests in [`cmcd_manager_unit.js`](test/util/cmcd_manager_unit.js) mostly
  unchanged — `nor` assertions update to root-relative; other wire-output
  assertions stay identical (verify via diff testing).
- **Approximate diff size**: +3000 lines (vendored port), ~500 lines
  changed in `cmcd_manager.js`.

### Phase 2 — Adopt CML's constants/enums; delete shaka's duplicates

- Replace internal references to:
  - `shaka.util.CmcdManager.ObjectType` → `cml.cmcd.CmcdObjectType`
  - `shaka.util.CmcdManager.Version` → `cml.cmcd.CmcdVersion`
  - `shaka.util.CmcdManager.StreamType` → `cml.cmcd.CmcdStreamType`
  - `shaka.util.CmcdManager.CmcdKeys` → CML's `CMCD_*_KEYS` constants
  - `shaka.util.CmcdManager.CmcdV2Constants` → CML equivalents
  - `shaka.util.CmcdManager.CmcdV2Keys` → CML equivalents
  - `shaka.util.CmcdManager.CmcdMode` → `cml.cmcd.CmcdReportingMode`
- Re-export `shaka.util.CmcdManager.StreamingFormat` as alias of
  `cml.cmcd.CmcdStreamingFormat` (keeps `@export`; values match).
- Delete the duplicate constant definitions from
  [`cmcd_manager.js`](lib/util/cmcd_manager.js).
- **No behavior change.** Just deduping.
- **Approximate diff size**: ~150 lines deleted from `cmcd_manager.js`,
  no additions.

### Phase 3 — Replace state machine with `CmcdReporter` (the big one)

- Rewrite [`cmcd_manager.js`](lib/util/cmcd_manager.js) as a thin adapter
  (~250 lines target).
- Construct `cml.cmcd.CmcdReporter` on first config; tear down on reset.
- Wire `<video>` events and player state to `reporter.update(...)`.
- Replace per-request `applyRequest_` logic with
  `reporter.createRequestReport(...)` calls.
- Wire `requester` callback to NetworkingEngine for event-mode reports.
- Apply config renames in [`externs/shaka/player.js`](externs/shaka/player.js):
  - `shaka.extern.CmcdConfiguration.targets` → `eventTargets`
  - `shaka.extern.CmcdTarget.enabledKeys` → `includeKeys`
  - `shaka.extern.CmcdTarget.timeInterval` → `interval`
- Add v2 re-exports: `shaka.util.CmcdManager.EventType` (alias of
  `cml.cmcd.CmcdEventType`), `shaka.util.CmcdManager.PlayerState` (alias of
  `cml.cmcd.CmcdPlayerState`).
- **Wire-format changes (alignment with CML, intentional):** sequence
  numbers shift from 1-based to 0-based (CML uses 0); request-mode `sn`
  becomes a single global counter rather than scoped per-target-hash;
  `sn` resets on `sid` change (CML's `resetSession` triggered from
  `update()` when a new `sid` is set). Flag in PR description.
- Update [`demo/`](demo/) to add a CMCD v2 configuration UI (transmission
  mode picker, version selector, eventTarget editor). Mirrors the
  precedent set by dash.js's `samples/cmcd/cmcd-v2.html` and
  `cmcd-v2-network-interceptors.html`. Lets users validate v2 config in
  the demo without writing code.
- Test rewrite (see Tests section): delete CMCD wire-format tests (~3000+
  lines); add ~500 lines of integration tests focused on shaka-specific
  glue. Add ~100 lines of end-to-end smoke tests.
- **Approximate diff size**: ~1450 lines deleted from `cmcd_manager.js`,
  ~3800 lines deleted from tests, ~750 lines added.

### Phase ordering rationale

- **Why not collapse 1+2:** Phase 1 is purely additive (vendor + delegate);
  Phase 2 is purely deletive (remove duplicates). Mixing them makes review
  harder. Splitting keeps each PR's intent crisp.
- **Why not collapse 2+3:** Phase 3 is the high-risk PR (behavioral rewrite).
  Phase 2 lets us land the constant migration safely first; if Phase 3 needs
  revision in review, Phase 2 still stands on its own.
- **Phase 3 owns the experimental config rename** because the adapter rewrite
  is what consumes the renamed fields. Splitting the rename to its own phase
  would give a transient state where externs name one thing and adapter reads
  another.

### Per-phase verification gates

Each phase must:

- Pass `python3 build/check.py` (lint + type-check + spell + custom rules).
- Pass full test suite (`python3 build/test.py`).
- Pass `python3 build/all.py` (full build, including docs and demo).
- Demo app loads and plays content with CMCD enabled in both query and
  header transmission modes.

## Tests strategy

Three buckets, with explicit ownership boundaries.

### Bucket A — CMCD wire-format / encoding correctness → lives in CML upstream

Tests that exercise "do we produce the right CMCD bytes for these inputs":

- Key serialization, value escaping, header vs query encoding
- v1/v2 mode-specific key filtering
- Inner-list encoding (`br`, `tb`, `bl`, `mtp`, `nor`)
- `upConvertToV2`, `prepareCmcdData`, structured-field serialization
- Sequence-number progression
- Event timing/batching logic in `CmcdReporter`

These tests live in / move to `@svta/cml-cmcd`'s test suite
(`libs/cmcd/test/`). Phase 3 deletes the corresponding ~3000+ lines from
[`test/util/cmcd_manager_unit.js`](test/util/cmcd_manager_unit.js).

### Bucket B — shaka-specific glue → lives in shaka

Tests that exercise the adapter's translation layer, scoped to shaka-side
responsibilities. Target ~500 lines. Mocks `CmcdReporter` with a stub that
records calls; asserts call sequences.

- `RequestType` (MANIFEST, SEGMENT, LICENSE, KEY, TIMING) → `CmcdObjectType` mapping
- `RequestContext.type` → `CmcdStreamingFormat` (DASH/HLS/Smooth/Other; LL DASH and LL HLS map to plain DASH/HLS per CTA-5004-B)
- `shaka.extern.CmcdConfiguration` → `cml.cmcd.CmcdReporterConfig` translation,
  including the experimental renames
- Player-event listener wiring: simulate `<video>` events / player state
  changes, assert `reporter.update(...)` called with the right partial state
- NetworkingEngine routing: stub the reporter's `requester` callback, assert
  it dispatches via `NetworkingEngine.request(RequestType.TIMING, ...)` and
  translates `{status}` correctly
- Lifecycle: construct → configure → reset → reconfigure produces a fresh reporter
- `rtp = bitrate × rtpSafetyFactor` adapter-side computation
- Public-API back-compat: `shaka.util.CmcdManager.StreamingFormat` enum still
  exists with same string values

### Bucket C — end-to-end smoke → lives in shaka

A handful of tests that drive a real `CmcdReporter` (not a stub) through the
adapter and assert wire output, to catch integration regressions across the
boundary. Target ~100 lines.

- One test per transmission mode (`CMCD_QUERY`, `CMCD_HEADERS`)
- One v1 + one v2 config
- One event-mode test that verifies a play-state change produces an
  event-mode dispatch through NetworkingEngine

### Net delta

~4317 lines deleted, ~600 lines added. Test suite shrinks by ~85%. Per
goal A: bugs in encoding output are CML's concern; bugs in
shaka-event-translation are shaka's concern. Clear ownership boundary.

## Open questions

- **CmcdReporter API surface verification.** Marked items in the CML-side
  requirements table need a precursor pass against current CML source before
  Phase 3 starts. Any gaps fill upstream.
- **Phase 1 byte-level output equivalence.** Phase 1 routes encoding through
  CML and is described as behavior-preserving. **One known intentional
  divergence**: `nor` URLs change from path-relative (shaka's
  `urlToRelativePath`) to root-relative (CML's `url.origin` baseUrl). Other
  potential divergences (key ordering, escaping, formatting) are unknown;
  verify with diff testing during Phase 1 implementation. The Phase 1 PR
  description should reframe from "no behavior change" to "alignment with
  CML's spec-conformant output, with `nor` URL relativization as the one
  known intentional change." If diff testing surfaces additional
  divergences, decide per case whether to (a) accept as a spec-conformance
  fix, (b) work around in the adapter, or (c) align CML and shaka via an
  upstream CML PR.
- **Pinned CML version.** Spec assumes `@svta/cml-cmcd` v2.3.0 (current
  latest). If a newer version ships before Phase 1 lands, pin to whatever's
  current at port time and note in `SUMMARY.txt`.
- **CMCD v2 spec changes.** v2 is still finalizing. Any field/event additions
  during the migration period flow into CML first; shaka inherits via
  next-bump.
- **Dedicated `CMCD_EVENT_REPORT` request type.** Phase 3 uses
  `RequestType.TIMING`. If shaka maintainers prefer a dedicated type, it can
  be added in a follow-up PR without changing the adapter contract.

## References

- [shaka-player#3619](https://github.com/shaka-project/shaka-player/issues/3619) — original CMCD support issue
- [shaka-player#8262](https://github.com/shaka-project/shaka-player/issues/8262) — TypeScript migration tracking
- [common-media-library#40](https://github.com/streaming-video-technology-alliance/common-media-library/issues/40) — refactor shaka-player's CMCD integration to use CML
- [hls.js#7725](https://github.com/video-dev/hls.js/pull/7725) — pattern reference (hls.js migration to CML CMCD v2)
- [`@svta/cml-cmcd`](https://github.com/streaming-video-technology-alliance/common-media-library/tree/main/libs/cmcd) — upstream source
- [CTA-5004 spec](https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf) — CMCD v1 specification
- [CTA-5004-B draft](https://cta-wave.github.io/Resources/common-media-client-data--cta-5004-b.html) — CMCD v2 specification (in-progress)
- [`AGENTS.md`](AGENTS.md) — shaka-player agent instructions / project conventions
- [`third_party/closure-uri/`](third_party/closure-uri/) — vendoring precedent
