/*! @license
 * Copyright 2024 Streaming Video Technology Alliance
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('cml.cmcd.Cmcd');

goog.require('cml.cmcd.CmcdEvent');
goog.require('cml.cmcd.CmcdRequest');
goog.require('cml.cmcd.CmcdResponse');


/**
 * Common Media Client Data (CMCD) version 2.
 *
 * The intersection of `CmcdRequest`, `CmcdResponse`, and `CmcdEvent`,
 * combining all keys from all reporting modes.
 *
 * Closure typedefs cannot express type intersection; the resolved
 * superset of fields lives on `cml.cmcd.CmcdResponse` already (which
 * extends `CmcdRequest`) plus event-only fields from `CmcdEvent`.
 * Callers should treat `cml.cmcd.Cmcd` as having any field that any
 * of the three modes defines. All members optional.
 *
 * @see {@link https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf}
 *
 * @typedef {{
 *   ab: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   bg: (boolean|undefined),
 *   bl: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   br: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   bs: (boolean|undefined),
 *   bsa: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   bsd: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   bsda: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   cdn: (string|undefined),
 *   cen: (string|undefined),
 *   cid: (string|undefined),
 *   cmsdd: (string|undefined),
 *   cmsds: (string|undefined),
 *   cs: (string|undefined),
 *   d: (number|undefined),
 *   dfa: (number|undefined),
 *   dl: (number|undefined),
 *   e: (string|undefined),
 *   ec: (!Array<string>|undefined),
 *   h: (string|undefined),
 *   lab: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   lb: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   ltc: (number|undefined),
 *   msd: (number|undefined),
 *   mtp: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   nor: (!Array<*>|undefined),
 *   nr: (boolean|undefined),
 *   ot: (string|undefined),
 *   pb: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   pr: (number|undefined),
 *   pt: (number|undefined),
 *   rc: (number|undefined),
 *   rtp: (number|undefined),
 *   sf: (string|undefined),
 *   sid: (string|undefined),
 *   smrt: (string|undefined),
 *   sn: (number|undefined),
 *   st: (string|undefined),
 *   sta: (string|undefined),
 *   su: (boolean|undefined),
 *   tab: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   tb: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   tbl: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   tpb: (cml.cmcd.CmcdObjectTypeList|undefined),
 *   ts: (number|undefined),
 *   ttfb: (number|undefined),
 *   ttfbb: (number|undefined),
 *   ttlb: (number|undefined),
 *   url: (string|undefined),
 *   v: (number|undefined)
 * }}
 */
cml.cmcd.Cmcd;
