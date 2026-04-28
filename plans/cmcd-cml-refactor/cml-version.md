# Pinned CML version + API verification report

Date: 2026-04-27
Pinned npm version: `@svta/cml-cmcd@2.3.0`
Pinned git tag: `cmcd-v2.3.0`
Pinned commit SHA: `22390e35dfbbe1e53d15648d3aace99cdf71f9dd`
Tag commit subject: `feat(cmcd): add CMCD_MIME_TYPE and validateCmcdEventReport (#333)`
Tag commit date: 2026-04-15
npm release date: 2026-04-15
Source location: `libs/cmcd/src/` (in CML monorepo)
Local checkout used: `/tmp/cml-pinned` (at SHA above)

## Summary

The pinned version (`cmcd-v2.3.0`, npm `2.3.0`) is the latest stable release as of 2026-04-27 — spec assumption confirmed.

Verification surfaced **6 doc/conformance fixes** between the spec and CML's actual public surface. **Zero blockers** — none require CML upstream PRs. Findings #2–#6 are spec/plan doc fixes; finding #1 is a shaka spec-conformance fix (drop non-spec values) applied within Phase 1:

1. **shaka's `'ld'` (LL-DASH) and `'lh'` (LL-HLS) `StreamingFormat` values are non-spec.** They originate from an old, unreleased CMCD draft. CML correctly omits them; CTA-5004 and CTA-5004-B both define only `'d'`/`'h'`/`'s'`/`'o'`. Shaka has been emitting non-conformant `sf` values. **Resolution:** drop `'ld'`/`'lh'` from shaka in Phase 1 alongside encoding delegation. LL DASH emits `sf=d`, LL HLS emits `sf=h`. Wire-format change to flag in Phase 1 PR description.
2. **`CmcdEventReportConfig.timeInterval` is named `interval` in CML.** Spec's per-target table calls it `timeInterval`; the field is `interval` in CML source. Cosmetic spec fix; adapter must use `interval`.
3. **`CmcdEventType` has 17 members, not the 10 listed in the spec.** All 10 spec members are present. CML adds: `BITRATE_CHANGE` (`bc`), `AD_START` (`as`), `AD_END` (`ae`), `AD_BREAK_START` (`abs`), `AD_BREAK_END` (`abe`), `SKIP` (`sk`), `CUSTOM_EVENT` (`ce`). No gap — spec just under-listed.
4. **`recordResponseReceived` data shape uses `response.resourceTiming` (not a flat `{ttfb, ttlb}` data object).** The reporter auto-derives `ttfb`/`ttlb`/`ts` from `response.resourceTiming.{startTime, responseStart, duration}`. The `data` override is still `Partial<Cmcd>` and adapter-supplied `ttfb`/`ttlb`/`rc`/`url` values override the derived ones. Adapter has two valid paths: synthesize a `ResourceTiming`-shaped object on the response, or pass the values directly via the data override. Spec is partially right (field names match) but doesn't reflect the `resourceTiming` indirection.
5. **`createRequestReport` returns a derived object as spec said, but `recordResponseReceived` returns `void`.** Spec is correct on both counts. No `applyResponseData` "copy back" step is required — CML's response flow is purely state-recording (it queues an internal `rr` event for any configured event-mode targets). Adapter's `applyResponseData` does not need to mutate `response` based on CML output.
6. **CML's request-mode sequence numbers are global, not per-target.** Single counter `requestTarget.sn` for all request-mode reports; one counter per event target. Shaka currently has separate `{request, response}` counters per per-config-hash target. CML does not split request from response — `rr` events use the per-event-target counter, request reports use the global `requestTarget` counter. This is a wire-format divergence that should be flagged in the Phase 3 PR.

Beyond the findings above, all other spec assertions verified cleanly: lifecycle methods, `requester` callback contract, `CmcdEventReportConfig` field set (modulo the `interval` rename), per-target `version` IS exposed (spec § Open Questions Q3 resolved — keep the per-target `version` field).

**Recommended next step:** Proceed to Phase 1. CML version pin remains `cmcd-v2.3.0`; no upstream PRs required. Apply the doc fixes (findings #2–#6) and the LL-value drop (finding #1) as part of Phase 1's wire-format-alignment work, alongside the already-planned `nor` URL relativization change.

## Task 0.2 — Lifecycle methods

All five lifecycle methods exist on `class CmcdReporter` in `libs/cmcd/src/CmcdReporter.ts`. Citations:

| Method | File:line | Signature | Returns | Throws |
|---|---|---|---|---|
| `start()` | `CmcdReporter.ts:151` | `start(): void` | `void` | No declared throws. Sets up `setInterval` per event target whose `interval` > 0 and which subscribes to `TIME_INTERVAL`. **Note:** fires an initial time-interval event synchronously (line 164) before the first interval elapses — adapter must populate state before calling `start()`. |
| `stop(flush?)` | `CmcdReporter.ts:173` | `stop(flush: boolean = false): void` | `void` | No declared throws. If `flush` truthy, calls `this.flush()` first (line 174-176), then `clearInterval` on every event target (line 178-180). Default `flush = false`. |
| `flush()` | `CmcdReporter.ts:188` | `flush(): void` | `void` | No declared throws. Forwards to `processEventTargets(true)` (line 189), which dispatches all queued events regardless of batch size. |
| `update(data)` | `CmcdReporter.ts:197` | `update(data: Partial<Cmcd>): void` | `void` | No declared throws. If `data.sid` differs from current `sid`, resets per-target sequence counters (line 198-200, `resetSession()` at line 455). Strips `msd` from persistent state (line 208). |
| `recordEvent(type, data?)` | `CmcdReporter.ts:219` | `recordEvent(type: CmcdEventType, data: Partial<Cmcd> = {}): void` | `void` | No declared throws. Records the event for every event target whose `events` array includes `type`, then runs `processEventTargets()` (line 224). |

**Confirmed:** All five methods exist with signatures compatible with the adapter's intended call sites. None throw on the success path. Adapter's `reset()` should call `reporter.stop(true)` to flush pending events before tearing down.

## Task 0.3 — `CmcdEventType` enum

`libs/cmcd/src/CmcdEventType.ts` defines a 17-member `as const` map. All 10 spec members are present. Mapping:

| Two-letter code | CML constant | CML enum key | File:line |
|---|---|---|---|
| `bc` | `CMCD_EVENT_BITRATE_CHANGE` | `CmcdEventType.BITRATE_CHANGE` | `CmcdEventType.ts:8`, `CmcdEventType.ts:135` |
| `ps` | `CMCD_EVENT_PLAY_STATE` | `CmcdEventType.PLAY_STATE` | `CmcdEventType.ts:15`, `CmcdEventType.ts:140` |
| `e` | `CMCD_EVENT_ERROR` | `CmcdEventType.ERROR` | `CmcdEventType.ts:22`, `CmcdEventType.ts:145` |
| `t` | `CMCD_EVENT_TIME_INTERVAL` | `CmcdEventType.TIME_INTERVAL` | `CmcdEventType.ts:29`, `CmcdEventType.ts:150` |
| `c` | `CMCD_EVENT_CONTENT_ID` | `CmcdEventType.CONTENT_ID` | `CmcdEventType.ts:36`, `CmcdEventType.ts:155` |
| `b` | `CMCD_EVENT_BACKGROUNDED_MODE` | `CmcdEventType.BACKGROUNDED_MODE` | `CmcdEventType.ts:43`, `CmcdEventType.ts:160` |
| `m` | `CMCD_EVENT_MUTE` | `CmcdEventType.MUTE` | `CmcdEventType.ts:50`, `CmcdEventType.ts:165` |
| `um` | `CMCD_EVENT_UNMUTE` | `CmcdEventType.UNMUTE` | `CmcdEventType.ts:57`, `CmcdEventType.ts:170` |
| `pe` | `CMCD_EVENT_PLAYER_EXPAND` | `CmcdEventType.PLAYER_EXPAND` | `CmcdEventType.ts:64`, `CmcdEventType.ts:175` |
| `pc` | `CMCD_EVENT_PLAYER_COLLAPSE` | `CmcdEventType.PLAYER_COLLAPSE` | `CmcdEventType.ts:71`, `CmcdEventType.ts:180` |
| `rr` | `CMCD_EVENT_RESPONSE_RECEIVED` | `CmcdEventType.RESPONSE_RECEIVED` | `CmcdEventType.ts:78`, `CmcdEventType.ts:185` |

Plus 6 additional members not in the spec list, present in CML:

| Two-letter code | CML enum key | File:line |
|---|---|---|
| `as` | `CmcdEventType.AD_START` | `CmcdEventType.ts:85`, `CmcdEventType.ts:190` |
| `ae` | `CmcdEventType.AD_END` | `CmcdEventType.ts:92`, `CmcdEventType.ts:195` |
| `abs` | `CmcdEventType.AD_BREAK_START` | `CmcdEventType.ts:99`, `CmcdEventType.ts:200` |
| `abe` | `CmcdEventType.AD_BREAK_END` | `CmcdEventType.ts:106`, `CmcdEventType.ts:205` |
| `sk` | `CmcdEventType.SKIP` | `CmcdEventType.ts:113`, `CmcdEventType.ts:210` |
| `ce` | `CmcdEventType.CUSTOM_EVENT` | `CmcdEventType.ts:120`, `CmcdEventType.ts:215` |

**Naming clarification (vs plan):** `plan.md:86` (Task 0.3 description) listed several guessed enum names that turned out wrong. Actual CML mappings: `pe → PLAYER_EXPAND` (not `PLAY_END` / `PLAYER_ERROR`); `pc → PLAYER_COLLAPSE` (not `PLAYBACK_CHANGE`); `t → TIME_INTERVAL` (not `TIMEOUT`); `c → CONTENT_ID` (not `CONTENT_ID_CHANGE`); `b → BACKGROUNDED_MODE` (not `BACKGROUNDED`). The Task 0.3 table above has the correct CML names. Plan doc should be updated for any future re-runs of this verification, though the plan's purpose was just to enumerate codes to verify, not to assert names.

**Confirmed:** Every event type the adapter intends to emit (`ps`, `e`, `t`, `c`, `b`, `m`, `um`, `pe`, `pc`, `rr`) has a CML enum value. Note also that `BITRATE_CHANGE` (which the spec uses without giving a code) is `bc`, present in CML.

## Task 0.4 — Request/response report methods

### `createRequestReport(request, data?)`

| Aspect | Finding |
|---|---|
| File:line | `CmcdReporter.ts:347` |
| Signature | `createRequestReport<R extends HttpRequest = HttpRequest>(request: R, data?: Partial<Cmcd>): R & CmcdRequestReport<R['customData']>` |
| Return shape | Defined in `libs/cmcd/src/CmcdRequestReport.ts:9` — `HttpRequest & {customData: {cmcd: Cmcd} & D; headers: Record<string, string>}` |
| Behavior | Returns a derived object (not in-place mutation). Builds new `report` object from spread of `request` (line 348-358). If `enabledKeys.length` is 0 or `report.url` is falsy, returns the bare cloned report with empty `cmcd: {}` (line 360-362). Otherwise applies CMCD data either to query string (line 376-382) or headers (line 384-386) per `transmissionMode`. |

**Confirmed:** Spec assertion `R & CmcdRequestReport<R['customData']>` matches exactly. Adapter MUST adopt the "copy fields back" pattern (CmcdReporter.ts:347 returns a new object; shaka's existing `applyRequestData` mutates in place). Specifically: copy `report.url` and `report.headers` back onto the input `request` to preserve shaka's mutation contract.

### `recordResponseReceived(response, data?)`

| Aspect | Finding |
|---|---|
| File:line | `CmcdReporter.ts:277` |
| Signature | `recordResponseReceived(response: HttpResponse<HttpRequest<{ cmcd?: Cmcd }>>, data: Partial<Cmcd> = {}): void` |
| Returns | `void` — purely state-recording. **No data to copy back.** Adapter's `applyResponseData` does not need to mutate `response` based on CML output. |
| Data param shape | `Partial<Cmcd>` — i.e., partial of the CMCD payload object. Field names are CMCD wire keys (`url`, `rc`, `ttfb`, `ttlb`, `ts`, etc.) — **`rc` not `responseCode`** (spec was right). |
| `response` shape | `HttpResponse` — defined in `libs/utils/src/HttpResponse.ts:10`. Required: `request: HttpRequest`. Optional: `status`, `url`, `redirected`, `statusText`, `type`, `headers`, `data`, `resourceTiming`. |
| Auto-derived fields | `CmcdReporter.ts:289-308`: `url` ← `data.url ?? request.url`; `rc` ← `response.status`; `ts` ← `Math.round(timeOrigin + resourceTiming.startTime)`; `ttfb` ← `Math.round(resourceTiming.responseStart - resourceTiming.startTime)`; `ttlb` ← `Math.round(resourceTiming.duration)`. |
| Override priority | Line 312: `{ ...cmcd, ...derived, ...data }` — `data` wins over derived, derived wins over the per-request `cmcd` data attached to the original request's `customData`. |

**Confirmed (with caveat):** Spec's `recordResponseReceived(response, {ttfb, ttlb, rc, url})` IS a valid call shape — CML accepts `Partial<Cmcd>` and the adapter-supplied keys override CML's auto-derivation. **However**, the adapter has two equivalent paths:
1. Synthesize a `ResourceTiming` object (`{startTime, responseStart, duration}`) on `response.resourceTiming` and let CML derive — closer to "let CML do the work".
2. Pre-compute `ttfb`/`ttlb`/`rc`/`url` and pass via the `data` override — closer to spec's call shape, but means re-computing what shaka already measures via `requestTimestampMap_`.

Spec doc should clarify that the data param is a `Partial<Cmcd>` not a fixed-shape object, and that `resourceTiming` is the canonical input for timing fields. No CML defect — just spec drift.

### Other relevant request methods

- `applyRequestReport(req)` — `CmcdReporter.ts:324`. Marked `@deprecated`; calls `createRequestReport` internally. Adapter should use `createRequestReport` directly.
- `isRequestReportingEnabled()` — `CmcdReporter.ts:333`. Returns `!!this.config.enabledKeys?.length`. Useful for adapter-side fast-path.

## Task 0.5 — `CmcdEventReportConfig` field-by-field diff

Source: `libs/cmcd/src/CmcdEventReportConfig.ts` (extends `CmcdReportConfig` from `libs/cmcd/src/CmcdReportConfig.ts`).

| Spec field | CML field | Type | File:line | Notes |
|---|---|---|---|---|
| `url` | `url` | `string` | `CmcdEventReportConfig.ts:22` | Required. Match. |
| `events` | `events` | `CmcdEventType[]` (optional) | `CmcdEventReportConfig.ts:30` | Match. |
| **`timeInterval`** | **`interval`** | `number` (optional, seconds) | `CmcdEventReportConfig.ts:40` | **Field name mismatch.** CML uses `interval`. Default `CMCD_DEFAULT_TIME_INTERVAL = 30` (`CMCD_DEFAULT_TIME_INTERVAL.ts:6`). Adapter must rename `timeInterval` → `interval`. |
| `batchSize` | `batchSize` | `number` (optional) | `CmcdEventReportConfig.ts:47` | Match. Default `1`. |
| `enabledKeys` | `enabledKeys` | `CmcdKey[]` (optional, inherited from `CmcdReportConfig`) | `CmcdReportConfig.ts:24` | Match. |
| `version` | `version` | `typeof CMCD_V2` (optional) | `CmcdEventReportConfig.ts:17` | **Per-target `version` IS exposed.** Note CML restricts it to `CMCD_V2` (event mode is v2-only — v1 has no event mode). Spec § "Per-target version override" gap-resolution: keep the field. |

Also inherited from `CmcdReportConfig`:
- `version?: CmcdVersion` — overridden by `CmcdEventReportConfig`'s narrower `typeof CMCD_V2` constraint.
- `enabledKeys?: CmcdKey[]`.

**Resolution of spec's open question on per-target `version`:** Keep the per-target `version` field. CML exposes it; behaviorally it's a no-op in v2.x (CML only allows `CMCD_V2`), but mapping shaka's `version` → CML's `version` per-target is harmless and forward-compatible.

**Action items:**
1. Rename `timeInterval` → `interval` in shaka's `shaka.extern.CmcdTarget` typedef during Phase 3, OR add an alias in the adapter's `toReporterConfig_` (`timeInterval` is the experimental v2 config). Spec § public-API section already authorizes experimental renames.
2. Update spec doc § "Per-target eventTargets[] field shape" to use `interval`.

## Task 0.6 — `CmcdStreamingFormat` value parity

| Spec-conformant value | shaka value | CML value | File:line | Status |
|---|---|---|---|---|
| `'d'` (DASH) | `DASH: 'd'` (`cmcd_manager.js:1613`) | `DASH: 'd'` | `CmcdStreamingFormat.ts:16` | **Match** |
| `'h'` (HLS) | `HLS: 'h'` (`cmcd_manager.js:1615`) | `HLS: 'h'` | `CmcdStreamingFormat.ts:21` | **Match** |
| `'s'` (SMOOTH) | `SMOOTH: 's'` (`cmcd_manager.js:1617`) | `SMOOTH: 's'` | `CmcdStreamingFormat.ts:26` | **Match** |
| `'o'` (OTHER) | `OTHER: 'o'` (`cmcd_manager.js:1618`) | `OTHER: 'o'` | `CmcdStreamingFormat.ts:31` | **Match** |
| *(non-spec)* | `LOW_LATENCY_DASH: 'ld'` (`cmcd_manager.js:1614`) | *(correctly omitted)* | n/a | **shaka non-conformant** |
| *(non-spec)* | `LOW_LATENCY_HLS: 'lh'` (`cmcd_manager.js:1616`) | *(correctly omitted)* | n/a | **shaka non-conformant** |

CML defines only DASH/HLS/SMOOTH/OTHER (`CmcdStreamingFormat.ts:12-32`). All 4 spec-conformant values match between shaka and CML.

**Re shaka's `'ld'`/`'lh'` values:** These originate from an old, unreleased CMCD draft and are not present in either CTA-5004 (CMCD v1) or CTA-5004-B (CMCD v2). CML is correct to omit them; shaka has been emitting non-conformant `sf` values. The maintainer (who owns both repos) confirmed CML's omission is intentional.

**Impact:** Phase 2's alias re-export plan is **unblocked** — once shaka drops `'ld'`/`'lh'`, shaka's enum becomes a strict subset of CML's, and `shaka.util.CmcdManager.StreamingFormat = cml.cmcd.CmcdStreamingFormat` works straightforwardly. shaka's internal `setLowLatency` flow (`cmcd_manager.js:177-194` — flipping `sf_` between `DASH ↔ LOW_LATENCY_DASH` and `HLS ↔ LOW_LATENCY_HLS`) needs simplification: LL DASH stays at `'d'`, LL HLS stays at `'h'`.

**Recommended action:** Drop `LOW_LATENCY_DASH` and `LOW_LATENCY_HLS` from `shaka.util.CmcdManager.StreamingFormat` and remove `setLowLatency`'s `sf_` mutation in **Phase 1**, alongside the encoding delegation. This is a wire-format change — flag in the Phase 1 PR description alongside `nor` URL relativization. No CML PR required.

## Task 0.7 — Sequence-number behavior

### CML behavior

Source: `libs/cmcd/src/CmcdReporter.ts`.

- **Request mode:** Single global counter `this.requestTarget.sn` (initialized to 0 at line 111). Incremented on every `createRequestReport` call regardless of target. Line 365: `cmcdData = { ...this.data, ...data, sn: this.requestTarget.sn++ }`.
- **Event mode:** Per-event-target counter `target.sn` (one per `eventTargets[]` entry). Each target's `sn` initialized to 0 at line 137. Incremented on every event recorded for that target. Line 247: `sn: target.sn++`.
- **Reset:** `resetSession()` at `CmcdReporter.ts:455` resets both kinds: every event target's `sn` to 0 (line 456), and the global request-mode `sn` to 0 (line 457). Triggered from `update()` whenever `data.sid` is supplied AND differs from current `sid` (line 198-200).
- **No separation of "request" vs "response" counters.** Response-received events (`rr`) flow through `recordEvent` (line 312), so they share the per-event-target counter with all other event-mode events.

### Shaka's existing behavior

Source: `lib/util/cmcd_manager.js`.

- **State:** `this.cmcdSequenceNumbers_ = {}` keyed by config-target hash (`cmcd_manager.js:93, 148`). Each entry has shape `{request: number, response: number}` (line 739, 781).
- **Request mode:** Counter at `cmcdSequenceNumbers_[hash].request++` per request (line 784). Hash key is `getCmcdTargetHash_({mode: REQUEST, useHeaders, includeKeys})`.
- **Event mode:** Counter at `cmcdSequenceNumbers_[hash].response++` per event (line 742). Hash key is `getCmcdTargetHash_(target)` where `target` is the user-configured event-target object.
- **Reset:** `cmcdSequenceNumbers_ = {}` on `reset()` (line 148). No partial reset on `sid` change.
- **Initial value:** counters start at 1 (line 739, 781), so first emitted `sn` is 1.

### Divergences

| Aspect | shaka | CML |
|---|---|---|
| Request-mode counter scope | Per-target-hash (`{useHeaders, includeKeys}` distinct → distinct counter) | One global counter for all request-mode reports |
| Event-mode counter scope | Per-target (each `eventTargets[]` entry → own counter) | Same — per-target |
| Counter naming | `{request, response}` separate counters per target hash | Single `sn` per target; `rr` events share with other event-mode events |
| Initial value | `1` | `0` |
| Reset on `sid` change | Not reset | Reset (request-mode global + every event-target) |
| Reset on `reset()` | Yes (whole dict cleared) | n/a — adapter must construct a new reporter or call `update({sid: newSid})` |

**Wire-format impact for Phase 3 PR:**
1. **First `sn` shifts from 1 to 0.** Consumers parsing `sn` as a counter index must adjust if they were assuming 1-based indexing.
2. **Request-mode `sn` is no longer scoped to header-vs-query mode.** A shaka session that switched `useHeaders` mid-flight previously got two independent counters; with CML, both modes share one. In practice this is unlikely (shaka doesn't expose runtime mode switching), but it's a behavioral simplification worth flagging.
3. **`sn` resets on `sid` change in CML.** Shaka's existing behavior keeps per-hash counters intact across `sid` rotations within a session. CML resets on each new `sid`. Adapter behavior post-Phase-3 will reset `sn` on session-id rotation.

**Confirmed:** Sequence-number behavior is documented and divergences identified. Adapter doesn't need to do anything special — let CML own the counters; just call out the wire change in the Phase 3 PR description.

## Task 0.8 — `requester` callback contract

Source: `libs/cmcd/src/CmcdReporter.ts`. Type imports from `@svta/cml-utils` (`libs/utils/src/HttpRequest.ts`, `libs/utils/src/HttpResponse.ts`).

### Where `requester` is invoked

`CmcdReporter.ts:432-449` (`sendEventReport` private method):

```typescript
private async sendEventReport(target: CmcdEventReportConfigNormalized, data: Cmcd[]): Promise<void> {
    const options = createEncodingOptions(CMCD_EVENT_MODE, target)
    const response = await this.requester({
        url: target.url,
        method: 'POST',
        headers: {
            'Content-Type': CMCD_MIME_TYPE,
        },
        body: data.map(item => encodeCmcd(item, options)).join('\n') + '\n',
    })
    // ...
}
```

Default requester (`CmcdReporter.ts:50-53`): `(request) => fetch(request.url, request)`. Replaced via constructor's second arg (`CmcdReporter.ts:125`) — no `config.requester` field; it's a constructor parameter.

### Contract

| Aspect | Finding |
|---|---|
| **Request shape** | `{url: string, method: 'POST', headers: {'Content-Type': 'application/cmcd', ...}, body: string}` always. Method is hardcoded `'POST'` (line 436). Headers always include `Content-Type: application/cmcd` (lines 437-439, `CMCD_MIME_TYPE.ts:6`). Body is always a `string` (line 440 — `encodeCmcd(...).join('\n') + '\n'`). The full `HttpRequest` type (`HttpRequest.ts:8`) allows additional fields (`body?: BodyInit`, `responseType`, `credentials`, `mode`, `timeout`, `customData`) but the reporter uses only the four above. |
| **Body type** | **Always `string`.** Spec § "Event-mode dispatch via NetworkingEngine" claims body may be string or Blob — **incorrect for CML 2.3.0.** Adapter's body-conversion logic only needs the string path: `shaka.util.StringUtils.toUTF8(cmcdReq.body)`. The Blob/`BodyInit` path is dead code; removing it simplifies the adapter. (CML's reporter body shape is fixed by the encoder; it never emits JSON or binary.) |
| **Response promise shape** | `Promise<{status: number}>` (line 125, line 50). The full `HttpResponse` type (`HttpResponse.ts:10`) has many more fields, but the reporter only reads `status` (line 443). |
| **Status semantics** | Line 445-449. **`410`** → silently delete the target permanently (`this.eventTargets.delete(target)`). **`429` or `5xx` (500-599)** → throw an Error; the catch in `processEventTargets` (line 413-416) re-queues the failed batch via `target.queue.unshift(...events)`. **All other statuses (including `200`, `204`, `4xx` other than `410`/`429`)** → silent success; events are NOT re-queued. |
| **Rejection vs non-2xx** | Asymmetric. A **rejected promise** is caught by `processEventTargets` (line 413: `.catch(() => target.queue.unshift(...events))`) — re-queues the batch. A **resolved-with-410** is treated specially; **resolved-with-200..499 (excluding 410, 429)** is silent success. **Resolved-with-429 or 5xx** throws inside `sendEventReport` → re-queues. So: rejection ≡ "retry"; non-2xx other than `410`/`429`/`5xx` ≡ "drop silently"; `410` ≡ "stop using this target". |
| **No body on response** | Reporter never reads `response.body` or `response.data` from the requester — only `status`. Adapter's requester shim need not preserve the response body. |

**Confirmed:** Adapter's requester shim has a tight, well-defined contract. The `try/catch` example in spec (lines 477-485) returns `{status: 200}` on success and `{status: err.status || 0}` on failure. With CML's status-code handling above, that's correct: rejection → re-queue (good); non-2xx returned as resolved → silent drop unless `429`/`5xx`. **Recommendation:** Adapter SHOULD distinguish between recoverable network errors (DNS/timeout/abort) and HTTP errors. NetworkingEngine throws on retries-exhausted with `error.severity` and `error.code`; adapter could map to `{status: 0}` (rejection-equivalent) for retry, or `{status: 410}` (poison the target) for permanent failures. Spec's example reasonably maps both to `{status: err.status || 0}` which falls through to "silent drop" — acceptable for an MVP but loses the re-queue-on-transient-failure benefit. This is a Phase 3 design refinement, not a Phase 0 blocker.

## Gaps found

No CML defects. All findings are doc fixes (spec/plan accuracy) or shaka spec-conformance fixes:

1. **shaka's `'ld'`/`'lh'` `StreamingFormat` values are non-spec; drop in Phase 1.** These come from an old unreleased CMCD draft. CML correctly omits them per CTA-5004 / CTA-5004-B.
   - **Spec assertion that fails:** Spec § "Public-API back-compat details" lines 411-412 ("Verified values match: `'d'`, `'ld'`, `'h'`, `'lh'`, `'s'`, `'o'`.") — claim is wrong on the LL variants.
   - **Recommended action:** Drop `'ld'`/`'lh'` from `shaka.util.CmcdManager.StreamingFormat` in Phase 1. Wire-format change: LL DASH emits `sf=d`, LL HLS emits `sf=h` (instead of `sf=ld`/`sf=lh`). Flag in Phase 1 PR description. No CML PR required.

2. **`CmcdEventReportConfig.timeInterval` is `interval` in CML.** Spec doc uses `timeInterval` throughout § "Per-target eventTargets[] field shape" and the experimental rename table.
   - **Spec assertion that fails:** Spec § "Per-target eventTargets[] field shape" row 3 (`timeInterval`).
   - **Recommended action:** Update spec doc to say `interval` (or document the shaka-side `timeInterval` rename explicitly as a third experimental rename layered on the existing `enabledKeys → includeKeys` and `targets → eventTargets` renames). Implementation-wise, the adapter's `toReporterConfig_` already renames per-target fields, so this is mechanically trivial.

3. **`recordResponseReceived` data shape is `Partial<Cmcd>`, not `{ttfb, ttlb, rc, url}`.** Spec implies a fixed shape; CML accepts any partial CMCD object. Auto-derived fields come from `response.resourceTiming`.
   - **Spec assertion that fails:** `spec.md:299` ("Adapter calls `reporter.recordResponseReceived(response, {ttfb, ttlb, rc, url})`.").
   - **Recommended action:** Update spec to clarify the data param is `Partial<Cmcd>` and that the adapter has two valid paths (synthesize `resourceTiming` or pass overrides). No CML defect.

4. **Sequence-number scope and reset semantics differ from shaka's existing behavior.** Detailed in Task 0.7. Wire-format change.
   - **Spec assertion that fails:** Spec § "CML-side requirements" row "Sequence numbers per-target — likely present; verify per v2 spec" (verified, but with divergence from shaka's existing semantics).
   - **Recommended action:** Document in Phase 3 PR description as an intentional alignment-with-CML wire change. No code change required in CML or adapter.

5. **`CmcdEventType` constant name mappings (in `plan.md`, not `spec.md`).** `plan.md:86` (Task 0.3 description) guessed names for several codes that turned out wrong. Actual CML names: `pe → PLAYER_EXPAND` (plan guessed `PLAY_END or PLAYER_ERROR`); `pc → PLAYER_COLLAPSE` (plan guessed `PLAYBACK_CHANGE`); `t → TIME_INTERVAL` (plan guessed `TIMEOUT or similar`); `c → CONTENT_ID` (plan guessed `CONTENT_ID_CHANGE`); `b → BACKGROUNDED_MODE` (plan guessed `BACKGROUNDED`). `spec.md:530-534` lists only the two-letter codes (no full names) and is unaffected.
   - **Spec/plan assertion that fails:** `plan.md:86`.
   - **Recommended action:** Plan doc fix only. No CML defect, no spec.md change required.

6. **`requester` is a constructor parameter, not a config field.** Two places in `spec.md` describe it as a config field:
   - `spec.md:449` ("`CmcdReporter` accepts a `requester: (req) => Promise<{status: number}>` config option")
   - `spec.md:511` (CML-side requirements table row: "`requester` config field for event-mode dispatch")
   - It's actually the **second positional arg to the constructor**, not a `CmcdReporterConfig` field.
   - **Spec assertion that fails:** `spec.md:449` and `spec.md:511`.
   - **Recommended action:** Spec doc fix at both locations. Implementation-wise, the adapter calls `new CmcdReporter(reporterConfig, requesterFn)` instead of `new CmcdReporter({...reporterConfig, requester: requesterFn})`. Mechanically equivalent.

Minor: The spec § "Event-mode dispatch via NetworkingEngine" body-conversion code path handles Blob (line 471-474 of spec.md: `else if (cmcdReq.body instanceof Blob) { ... }`). CML never produces Blob bodies. The Blob branch is dead code and the adapter can drop it.

## Recommended next step

**Proceed to Phase 1.** CML version pin remains `cmcd-v2.3.0` (`22390e35`); no upstream PRs required. Apply the doc updates below, fold the `'ld'`/`'lh'` drop into Phase 1 alongside encoding delegation, then begin Phase 1 implementation.

**Doc-only updates (no code impact):**

### Update plan.md
- `plan.md:86` (Task 0.3 description) — replace the enum-name guesses with the correct CML constant names from Task 0.3's table above. Specifically: `pe → PLAYER_EXPAND` (was `PLAY_END or PLAYER_ERROR`); `pc → PLAYER_COLLAPSE` (was `PLAYBACK_CHANGE`); `t → TIME_INTERVAL` (was `TIMEOUT or similar`); `c → CONTENT_ID` (was `CONTENT_ID_CHANGE`); `b → BACKGROUNDED_MODE` (was `BACKGROUNDED`).
- `plan.md` Phase 1 — add a sub-task to drop `'ld'`/`'lh'` from `shaka.util.CmcdManager.StreamingFormat` and simplify `setLowLatency`'s `sf_` mutation. Phase 1 wire-format-change callout extends to cover both `nor` URL relativization and the LL value drop.
- `plan.md` Phase 2 Task 2.3 (StreamingFormat re-export) — add a one-line note that after the Phase 1 LL drop, shaka's enum is a strict subset of CML's, so the alias re-export is straightforward.
- `plan.md` Phase 3 Task 3.6 (player event listeners) — drop the `setLowLatency` → `update({streamingFormat: LOW_LATENCY_*})` step.
- `plan.md` "Spec gaps surfaced during planning" gap #10 — update to reflect the actual finding (shaka emits non-spec values, CML is correct, drop in Phase 1).

### Update spec.md
- `spec.md:296-302` (`applyResponseData` flow step 2) — clarify that `recordResponseReceived` takes `Partial<Cmcd>` and auto-derives `ttfb`/`ttlb`/`ts` from `response.resourceTiming`. The flat `{ttfb, ttlb, rc, url}` override path still works but is the secondary path; the primary path is to synthesize a `ResourceTiming` object on `response.resourceTiming` and let CML derive timing fields.
- `spec.md:346` — rename per-target `timeInterval` field to `interval` (matches CML's `CmcdEventReportConfig.ts:40`).
- `spec.md:381-382` — drop both `setLowLatency(true) + DASH/HLS → update({streamingFormat: LOW_LATENCY_*})` rows from the "Player state ↔ reporter state mapping" table. Add a brief note that `sf` no longer reflects LL state in CMCD v2.
- `spec.md:412` — update "Verified values match: `'d'`, `'ld'`, `'h'`, `'lh'`, `'s'`, `'o'`" to drop the LL variants and note shaka's non-spec values are dropped in Phase 1.
- `spec.md:449` and `spec.md:511` — fix both references to `requester` as a "config field"; it's the `CmcdReporter` constructor's second positional arg, not a `CmcdReporterConfig` member.
- `spec.md:469-475` (adapter requester sketch) — drop the Blob branch. CML's reporter only emits `body: string`; the Blob path is dead code.
- `spec.md` Phase 3 section — add a note that sequence-number reset on `sid` change and the request-mode counter scope change (per-target-hash → global) are intentional alignment-with-CML wire changes, not regressions.
