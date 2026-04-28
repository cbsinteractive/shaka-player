/*! @license
 * Copyright 2024 Streaming Video Technology Alliance
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('cml.cmcd.uuid');


/**
 * UUID shim for the vendored @svta/cml-cmcd port.
 *
 * Upstream CML's `CmcdReporter` imports `uuid()` from `@svta/cml-utils`
 * and uses it as the default for `sid` in `createCmcdReporterConfig`.
 * The shaka adapter always sets `sid` explicitly, so this codepath is
 * dead at runtime — Closure ADVANCED will strip it. Kept for verbatim
 * parity with upstream CmcdReporter source so per-bump diffs stay
 * trivial.
 *
 * `crypto.randomUUID()` is polyfilled in browsers without native
 * support by `lib/polyfill/random_uuid.js`.
 *
 * @return {string}
 */
cml.cmcd.uuid = () => crypto.randomUUID();
