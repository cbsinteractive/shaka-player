/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.util.CmcdManager');

goog.require('cml.cmcd.CMCD_EVENT_KEYS');
goog.require('cml.cmcd.CMCD_EVENT_MODE');
goog.require('cml.cmcd.CMCD_EVENT_TIME_INTERVAL');
goog.require('cml.cmcd.CMCD_REQUEST_KEYS');
goog.require('cml.cmcd.CMCD_REQUEST_MODE');
goog.require('cml.cmcd.CMCD_RESPONSE_KEYS');
goog.require('cml.cmcd.CMCD_V1_KEYS');
goog.require('cml.cmcd.CMCD_V2');
goog.require('cml.cmcd.CmcdEventType');
goog.require('cml.cmcd.CmcdObjectType');
goog.require('cml.cmcd.CmcdPlayerState');
goog.require('cml.cmcd.CmcdReportingMode');
goog.require('cml.cmcd.CmcdStreamType');
goog.require('cml.cmcd.CmcdStreamingFormat');
goog.require('cml.cmcd.encodeCmcd');
goog.require('cml.cmcd.encodePreparedCmcd');
goog.require('cml.cmcd.prepareCmcdData');
goog.require('goog.Uri');

goog.require('shaka.log');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.util.ArrayUtils');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.Timer');

goog.requireType('cml.cmcd.Cmcd');
goog.requireType('cml.cmcd.CmcdEncodeOptions');
goog.requireType('shaka.media.SegmentReference');
goog.requireType('shaka.Player');

/**
 * @summary
 * A CmcdManager maintains CMCD state as well as a collection of utility
 * functions.
 */
shaka.util.CmcdManager = class {
  /**
   * @param {shaka.Player} player
   * @param {shaka.extern.CmcdConfiguration} config
   */
  constructor(player, config) {
    /** @private {?shaka.extern.CmcdConfiguration} */
    this.config_ = config;

    /** @private {?shaka.Player} */
    this.player_ = player;

    /** @private {!Map<!shaka.extern.Request, number>} */
    this.requestTimestampMap_ = new Map();

    /**
     * Streaming format
     *
     * @private {(cml.cmcd.CmcdStreamingFormat|undefined)}
     */
    this.sf_ = undefined;

    /**
     * @private {boolean}
     */
    this.playbackStarted_ = false;

    /**
     * @private {boolean}
     */
    this.buffering_ = true;

    /**
     * @private {boolean}
     */
    this.starved_ = false;

    /**
     * @private {boolean}
     */
    this.lowLatency_ = false;

    /**
     * @private {number|undefined}
     */
    this.playbackPlayTime_ = undefined;

    /**
     * @private {number|undefined}
     */
    this.playbackPlayingTime_ = undefined;

    /**
     * @private {number}
     */
    this.startTimeOfLoad_ = 0;

    /**
     * @private {{request: boolean, event: boolean}}
     */
    this.msdSent_ = {
      request: false,
      event: false,
    };

    /**
     * @private {!Object<string, {request: number, response: number}>}
     */
    this.cmcdSequenceNumbers_ = {};

    /**
     * @private {shaka.util.EventManager}
     */
    this.eventManager_ = new shaka.util.EventManager();

    /** @private {Array<shaka.util.Timer>} */
    this.eventTimers_ = [];

    /** @private {HTMLMediaElement} */
    this.video_ = null;
  }


  /**
   * Set media element and setup event listeners
   * @param {HTMLMediaElement} mediaElement The video element
   */
  setMediaElement(mediaElement) {
    this.video_ = mediaElement;
    this.setupEventListeners_();
  }

  /**
   * Called by the Player to provide an updated configuration any time it
   * changes.
   *
   * @param {shaka.extern.CmcdConfiguration} config
   */
  configure(config) {
    this.config_ = config;
    this.setupEventModeTimeInterval_();
  }


  /**
   * Resets the CmcdManager.
   */
  reset() {
    this.requestTimestampMap_.clear();
    this.playbackStarted_ = false;
    this.buffering_ = true;
    this.starved_ = false;
    this.lowLatency_ = false;
    this.playbackPlayTime_ = 0;
    this.playbackPlayingTime_ = 0;
    this.startTimeOfLoad_ = 0;
    this.msdSent_ = {
      request: false,
      response: false,
      event: false,
    };

    this.stopAndClearEventTimers_();
    this.cmcdSequenceNumbers_ = {};

    this.video_ = null;
    this.eventManager_.removeAll();
  }

  /**
   * Set the buffering state
   *
   * @param {boolean} buffering
   */
  setBuffering(buffering) {
    if (!buffering && !this.playbackStarted_) {
      this.playbackStarted_ = true;
    }

    if (this.playbackStarted_ && buffering) {
      this.starved_ = true;
      this.reportEvent_('ps', {'sta': 'r'});
    }

    this.buffering_ = buffering;
  }

  /**
   * Set the low latency.
   *
   * Note: low-latency content emits the same `sf` value as its non-LL
   * counterpart (DASH → 'd', HLS → 'h'). CTA-5004 / CTA-5004-B do not
   * define separate low-latency StreamingFormat values, and CML's
   * CmcdStreamingFormat omits them.
   *
   * @param {boolean} lowLatency
   */
  setLowLatency(lowLatency) {
    this.lowLatency_ = lowLatency;
  }

  /**
   * Set start time of load if autoplay is enabled
   *
   * @param {number} startTimeOfLoad
   */
  setStartTimeOfLoad(startTimeOfLoad) {
    if (!this.config_ || !this.config_.enabled) {
      return;
    }

    this.reportEvent_('ps', {'sta': 'd'});
    if (this.video_ && this.video_.autoplay) {
      const playResult = this.video_.play();
      if (playResult) {
        playResult.then(() => {
          this.startTimeOfLoad_ = startTimeOfLoad;
        }).catch((e) => {
          this.startTimeOfLoad_ = 0;
        });
      }
    }
  }

  /**
   * Apply CMCD data to a request.
   *
   * @param {!shaka.net.NetworkingEngine.RequestType} type
   *   The request type
   * @param {!shaka.extern.Request} request
   *   The request to apply CMCD data to
   * @param {shaka.extern.RequestContext=} context
   *   The request context
   */
  applyRequestData(type, request, context = {}) {
    if (!this.config_.enabled) {
      return;
    }

    if (request.method === 'HEAD') {
      this.applyRequest_(request, {});
      return;
    }

    const RequestType = shaka.net.NetworkingEngine.RequestType;
    const ObjectType = cml.cmcd.CmcdObjectType;

    switch (type) {
      case RequestType.MANIFEST:
        this.applyManifestData(request, context);
        break;

      case RequestType.SEGMENT:
        this.applyRequestSegmentData(request, context);
        break;

      case RequestType.LICENSE:
      case RequestType.SERVER_CERTIFICATE:
      case RequestType.KEY:
        this.applyRequest_(request, {ot: ObjectType.KEY});
        break;

      case RequestType.TIMING:
        this.applyRequest_(request, {ot: ObjectType.OTHER});
        break;
    }
  }

  /**
   * Apply CMCD data to a response.
   *
   * @param {!shaka.net.NetworkingEngine.RequestType} type
   *   The request type
   * @param {!shaka.extern.Response} response
   *   The response to apply CMCD data to
   * @param {shaka.extern.RequestContext=} context
   *   The request context
   */
  applyResponseData(type, response, context = {}) {
    if (!this.hasResponseReceived_()) {
      return;
    }

    const RequestType = shaka.net.NetworkingEngine.RequestType;

    switch (type) {
      case RequestType.SEGMENT:
        this.applyResponseSegmentData(response, context);
        break;
    }
  }

  /**
   * Apply CMCD data to a manifest request.
   *
   * @param {!shaka.extern.Request} request
   *   The request to apply CMCD data to
   * @param {shaka.extern.RequestContext} context
   *   The request context
   */
  applyManifestData(request, context) {
    try {
      if (!this.config_.enabled) {
        return;
      }

      if (context.type) {
        this.sf_ = this.getStreamFormat_(context.type);
      }

      this.applyRequest_(request, {
        ot: cml.cmcd.CmcdObjectType.MANIFEST,
        su: !this.playbackStarted_,
      });
    } catch (error) {
      shaka.log.warnOnce('CMCD_MANIFEST_ERROR',
          'Could not generate manifest CMCD data.', error);
    }
  }

  /**
   * Apply CMCD data to a segment response
   *
   * @param {!shaka.extern.Response} response
   * @param {shaka.extern.RequestContext} context
   *   The request context
   */
  applyResponseSegmentData(response, context) {
    try {
      const data = this.getDataForSegment_(context, response.uri);

      if (response.originalRequest &&
          response.originalRequest.timeToFirstByte != null) {
        data.ttfb = response.originalRequest.timeToFirstByte;
      }

      if (response.timeMs != null) {
        data.ttlb = response.timeMs;
      }

      const originalRequestUrl = response.originalUri || response.uri;
      data.url = this.removeCmcdQueryFromUri_(
          originalRequestUrl);

      data.rc = response.status || 0;

      if (this.requestTimestampMap_.has(response.originalRequest)) {
        data.ts = this.requestTimestampMap_.get(response.originalRequest);
        this.requestTimestampMap_.delete(response.originalRequest);
      } else if (!data.ts) {
        data.ts = Date.now();
      }

      if (response.headers && response.headers['CMSD-Static']) {
        data.cmsds = btoa(response.headers['CMSD-Static']);
      }

      if (response.headers && response.headers['CMSD-Dynamic']) {
        data.cmsdd = btoa(response.headers['CMSD-Dynamic']);
      }

      this.applyResponse_(response, data);
    } catch (error) {
      shaka.log.warnOnce(
          'CMCD_SEGMENT_ERROR',
          'Could not generate response segment CMCD data.',
          error,
      );
    }
  }

  /**
   * Apply CMCD data to a segment request
   *
   * @param {!shaka.extern.Request} request
   * @param {shaka.extern.RequestContext} context
   *   The request context
   */
  applyRequestSegmentData(request, context) {
    try {
      if (!this.config_.enabled) {
        return;
      }

      const data = this.getDataForSegment_(context, request.uris[0]);
      data.ts = Date.now();

      // prevents memory leaks from retries/duplicates
      if (this.requestTimestampMap_.has(request)) {
        this.requestTimestampMap_.delete(request);
      }
      this.requestTimestampMap_.set(request, data.ts);
      this.applyRequest_(request, data);
    } catch (error) {
      shaka.log.warnOnce(
          'CMCD_SEGMENT_ERROR',
          'Could not generate segment CMCD data.', error,
      );
    }
  }

  /**
   * Apply CMCD data to a text request
   *
   * @param {!shaka.extern.Request} request
   */
  applyTextData(request) {
    try {
      if (!this.config_.enabled) {
        return;
      }

      this.applyRequest_(request, {
        ot: cml.cmcd.CmcdObjectType.CAPTION,
        su: true,
      });
    } catch (error) {
      shaka.log.warnOnce('CMCD_TEXT_ERROR',
          'Could not generate text CMCD data.', error);
    }
  }

  /**
   * Removes the CMCD query parameter from a URI.
   *
   * @param {string} uri
   * @return {string}
   * @private
   */
  removeCmcdQueryFromUri_(uri) {
    if (!uri.includes('CMCD=')) {
      return uri;
    }

    try {
      const url = new URL(uri);
      url.searchParams.delete('CMCD');

      return url.toString();
    } catch (error) {
      shaka.log.error('Failed to parse URI for CMCD removal:', uri, error);
      return uri;
    }
  }

  /**
   * Apply CMCD data to streams loaded via src=.
   *
   * @param {string} uri
   * @param {string} mimeType
   * @return {string}
   */
  appendSrcData(uri, mimeType) {
    try {
      if (!this.config_.enabled) {
        return uri;
      }

      const data = this.createData_();
      data.ot = this.getObjectTypeFromMimeType_(mimeType);
      data.su = true;

      const query = shaka.util.CmcdManager.toQuery(
          data,
          shaka.util.CmcdManager.getEncodeOptions_(
              uri, this.config_.version, cml.cmcd.CMCD_REQUEST_MODE));

      return shaka.util.CmcdManager.appendQueryToUri(uri, query);
    } catch (error) {
      shaka.log.warnOnce('CMCD_SRC_ERROR',
          'Could not generate src CMCD data.', error);
      return uri;
    }
  }

  /**
   * Apply CMCD data to side car text track uri.
   *
   * @param {string} uri
   * @return {string}
   */
  appendTextTrackData(uri) {
    try {
      if (!this.config_.enabled) {
        return uri;
      }

      const data = this.createData_();
      data.ot = cml.cmcd.CmcdObjectType.CAPTION;
      data.su = true;

      const query = shaka.util.CmcdManager.toQuery(
          data,
          shaka.util.CmcdManager.getEncodeOptions_(
              uri, this.config_.version, cml.cmcd.CMCD_REQUEST_MODE));

      return shaka.util.CmcdManager.appendQueryToUri(uri, query);
    } catch (error) {
      shaka.log.warnOnce('CMCD_TEXT_TRACK_ERROR',
          'Could not generate text track CMCD data.', error);
      return uri;
    }
  }

  /**
   * Set playbackPlayTime_ when the play event is triggered
   * @private
   */
  onPlaybackPlay_() {
    if (!this.playbackPlayTime_) {
      this.playbackPlayTime_ = Date.now();
      this.reportEvent_('ps', {'sta': 's'});
    }
  }

  /**
   * Set playbackPlayingTime_
   * @private
   */
  onPlaybackPlaying_() {
    if (!this.playbackPlayingTime_) {
      this.playbackPlayingTime_ = Date.now();
    }
  }

  /**
   * Setup event listeners.
   * @private
   */
  setupEventListeners_() {
    this.eventManager_.listen(
        this.video_, 'playing', () => {
          this.onPlaybackPlaying_();
          this.reportEvent_('ps', {'sta': 'p'});
        },
    );

    // Mute/Unmute
    this.eventManager_.listen(this.video_, 'volumechange', () => {
      this.reportEvent_(this.video_.muted ? 'm' : 'um');
    });

    // Play
    this.eventManager_.listen(this.video_, 'play', () => {
      this.onPlaybackPlay_();
    });

    // Pause
    this.eventManager_.listen(this.video_, 'pause', () => {
      this.reportEvent_('ps', {'sta': 'a'});
    });

    // Waiting
    this.eventManager_.listen(this.player_, 'buffering', () => {
      this.reportEvent_('ps', {'sta': 'w'});
    });

    // Seeking
    this.eventManager_.listen(this.video_, 'seeking', () =>
      this.reportEvent_('ps', {'sta': 'k'}),
    );

    // Fullscreen/PiP Change (Player Expand/Collapse)
    this.eventManager_.listen(document, 'fullscreenchange', () => {
      const isFullScreen = !!document.fullscreenElement;
      this.reportEvent_(isFullScreen ? 'pe' : 'pc');
    });

    const video = /** @type {HTMLVideoElement} */(this.video_);
    if (video.webkitPresentationMode || video.webkitSupportsFullscreen) {
      this.eventManager_.listen(video, 'webkitpresentationmodechanged', () => {
        if (video.webkitPresentationMode) {
          this.reportEvent_(
            video.webkitPresentationMode !== 'inline' ?'pe' : 'pc');
        } else if (video.webkitSupportsFullscreen) {
          this.reportEvent_(video.webkitDisplayingFullscreen ?'pe' : 'pc');
        }
      });
    }

    this.eventManager_.listen(this.video_, 'enterpictureinpicture', () => {
      this.reportEvent_('pe');
    });

    this.eventManager_.listen(this.video_, 'leavepictureinpicture', () => {
      this.reportEvent_('pc');
    });

    if ('documentPictureInPicture' in window) {
      this.eventManager_.listen(window.documentPictureInPicture, 'enter',
          (e) => {
            this.reportEvent_('pe');

            const event = /** @type {DocumentPictureInPictureEvent} */(e);
            const pipWindow = event.window;
            this.eventManager_.listenOnce(pipWindow, 'pagehide', () => {
              this.reportEvent_('pc');
            });
          });
    }

    // Background Mode
    this.eventManager_.listen(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.reportEvent_('b', {'bg': true});
      } else {
        this.reportEvent_('b');
      }
    });

    this.eventManager_.listen(this.player_, 'complete', () => {
      this.reportEvent_('ps', {'sta': 'e'});
    });
  }

  /**
   * Sets up TimeInterval timer for CMCD 'EVENT' mode targets.
   * @private
   */
  setupEventModeTimeInterval_() {
    this.stopAndClearEventTimers_();

    const eventTargets = this.getEventModeEnabledTargets_();

    for (const target of eventTargets) {
      let timeInterval = target.timeInterval;

      // Checking for `timeInterval === undefined` since
      // timeInterval = 0 is used to turn TimeInterval off
      if (timeInterval === undefined) {
        // Phase 2 keeps shaka's historical default of 10 seconds.
        // CML's `CMCD_DEFAULT_TIME_INTERVAL` is `30`; Phase 3 swaps to
        // CmcdReporter, which uses the CML default natively.
        timeInterval = 10;
      }

      if (timeInterval >= 1) {
        const eventModeTimer = new shaka.util.Timer(
            () => this.reportEvent_(
                cml.cmcd.CMCD_EVENT_TIME_INTERVAL));
        eventModeTimer.tickEvery(timeInterval);
        this.eventTimers_.push(eventModeTimer);
      }
    }
  }

  /**
   * Stops and clears all the event timers for timeInterval
   * @private
   */
  stopAndClearEventTimers_() {
    if (this.eventTimers_) {
      for (const timer of this.eventTimers_) {
        timer.stop();
      }
    }
    this.eventTimers_ = [];
  }

  /**
   * @return {!Array<shaka.extern.CmcdTarget>}
   * @private
   */
  getEventModeEnabledTargets_() {
    const targets = this.config_.targets;
    if (!targets) {
      return [];
    }
    return targets.filter(
        (target) => target.enabled);
  }

  /**
   * @return {boolean}
   * @private
   */
  hasResponseReceived_() {
    const targets = this.config_.targets;
    if (!targets) {
      return false;
    }
    return targets.some(
        (target) => target.events &&
          target.events.includes('rr') && target.enabled);
  }

  /**
   * Create baseline CMCD data
   *
   * @return {CmcdData}
   * @private
   */
  createData_() {
    if (!this.config_.sessionId) {
      this.config_.sessionId = window.crypto.randomUUID();
    }
    return {
      v: this.config_.version,
      sf: this.sf_,
      sid: this.config_.sessionId,
      cid: this.config_.contentId,
      mtp: this.player_.getBandwidthEstimate() / 1000,
    };
  }

  /**
   * @param {string} eventType
   * @param {CmcdData} extraData
   * @private
   */
  reportEvent_(eventType, extraData = {}) {
    const baseEventData = {
      e: eventType,
      ts: Date.now(),
    };

    const eventData = Object.assign(baseEventData, extraData);
    const rawOutput = this.getGenericData_(eventData,
        cml.cmcd.CmcdReportingMode.EVENT);

    const version = this.config_.version;
    const targets = this.config_.targets;
    if (version < cml.cmcd.CMCD_V2 || !targets) {
      return;
    }

    const eventTargets = this.getEventModeEnabledTargets_();

    // CML's event-mode encoder accepts the union of request, response,
    // and event keys (see `cml.cmcd.isCmcdEventKey`). Mirror that here
    // for `includeKeys` validation so users can specify keys from any
    // of the three buckets.
    const allowedKeys = Array.from(new Set([
      ...cml.cmcd.CMCD_REQUEST_KEYS,
      ...cml.cmcd.CMCD_RESPONSE_KEYS,
      ...cml.cmcd.CMCD_EVENT_KEYS,
    ]));

    for (const target of eventTargets) {
      const includeKeys = target.includeKeys || [];
      const allowedKeysEventMode = this.checkValidKeys_(
          includeKeys,
          allowedKeys,
          cml.cmcd.CmcdReportingMode.EVENT,
      );

      // `ts` and `e` are required for every event report; CML's
      // `prepareCmcdData` adds them automatically, but shaka pre-
      // filters via `filterKeys_` before encoding, so they must
      // survive the filter.
      if (!allowedKeysEventMode.includes('ts')) {
        allowedKeysEventMode.push('ts');
      }

      if (!allowedKeysEventMode.includes('e')) {
        allowedKeysEventMode.push('e');
      }

      const targetKey = this.getCmcdTargetHash_(target);
      if (!this.cmcdSequenceNumbers_[targetKey]) {
        this.cmcdSequenceNumbers_[targetKey] = {request: 1, response: 1};
      }

      rawOutput.sn = this.cmcdSequenceNumbers_[targetKey].response++;

      const output = this.filterKeys_(rawOutput, allowedKeysEventMode);

      const includeEvents = target.events || [];

      if (!this.isValidEvent_(includeEvents, output)) {
        continue;
      }

      this.sendCmcdRequest_(output, target);
    }
  }

  /**
   * Apply CMCD data to a request.
   *
   * @param {!shaka.extern.Request} request The request to apply CMCD data to
   * @param {!CmcdData} data The data object
   * @private
   */
  applyRequest_(request, data) {
    if (!this.config_.enabled) {
      return;
    }

    const rawOutput = this.getGenericData_(
        data, cml.cmcd.CmcdReportingMode.REQUEST,
    );

    const requestTargetConfig = {
      mode: cml.cmcd.CmcdReportingMode.REQUEST,
      useHeaders: this.config_.useHeaders,
      includeKeys: this.config_.includeKeys || [],
    };

    const targetKey = this.getCmcdTargetHash_(requestTargetConfig);

    if (!this.cmcdSequenceNumbers_[targetKey]) {
      this.cmcdSequenceNumbers_[targetKey] = {request: 1, response: 1};
    }

    rawOutput.sn = this.cmcdSequenceNumbers_[targetKey].request++;

    const includeKeys = this.config_.includeKeys || [];
    const version = this.config_.version;
    const allowedKeys = (version == cml.cmcd.CMCD_V2) ?
        Array.from(cml.cmcd.CMCD_REQUEST_KEYS) :
        cml.cmcd.CMCD_V1_KEYS;

    const allowedKeysRequestMode = this.checkValidKeys_(
        includeKeys,
        allowedKeys,
        cml.cmcd.CmcdReportingMode.REQUEST,
    );

    const output = this.filterKeys_(rawOutput, allowedKeysRequestMode);

    this.applyCmcdDataToRequest_(output, request, this.config_.useHeaders);
  }

  /**
   * Apply CMCD data to a response.
   *
   * @param {!shaka.extern.Response} response The request to apply CMCD data to
   * @param {!CmcdData} data The data object
   * @private
   */
  applyResponse_(response, data) {
    this.reportEvent_('rr', data);
  }

  /**
   * Creates and sends a new, out-of-band request to a CMCD endpoint.
   * This is used for event and response reporting.
   *
   * @param {!CmcdData} cmcdData The CMCD data to send.
   * @param {shaka.extern.CmcdTarget} target The CMCD target configuration.
   * @param {shaka.extern.Response=} response Optional response object
   *  to update, used by the applyResponse flow.
   * @private
   */
  sendCmcdRequest_(cmcdData, target, response) {
    const retryParams = shaka.net.NetworkingEngine.defaultRetryParameters();
    let request = null;
    const baseURL = target.url;
    // Event-mode reports (event/response) skip baseUrl: the collector
    // URL is generally a different origin from segment URLs, so passing
    // it would not relativize `nor` the way old shaka did. Match CML's
    // reporter, which omits baseUrl in event mode.
    const encodeOptions = shaka.util.CmcdManager.getEncodeOptions_(
        undefined, this.config_.version, cml.cmcd.CMCD_EVENT_MODE);

    if (target.useHeaders) {
      const headers =
          shaka.util.CmcdManager.toHeaders(cmcdData, encodeOptions);
      if (!Object.keys(headers).length) {
        return;
      }
      if (response) {
        Object.assign(response.headers, headers);
      }
      request = shaka.net.NetworkingEngine.makeRequest([baseURL], retryParams);
      Object.assign(request.headers, headers);
    } else {
      const queryString =
          shaka.util.CmcdManager.toQuery(cmcdData, encodeOptions);
      if (!queryString) {
        return;
      }
      const finalUri = shaka.util.CmcdManager.appendQueryToUri(
          baseURL, queryString);
      if (response) {
        response.uri = finalUri;
      }
      request = shaka.net.NetworkingEngine.makeRequest([finalUri], retryParams);
    }
    const requestType = shaka.net.NetworkingEngine.RequestType.CMCD;
    const networkingEngine = this.player_.getNetworkingEngine();
    networkingEngine.request(requestType, request);
  }

  /**
   * Modifies an existing request object by adding CMCD data to it.
   *
   * @param {!CmcdData} output The CMCD data to apply.
   * @param {!shaka.extern.Request} request The request object to modify.
   * @param {boolean} useHeaders Whether to use headers or query parameters.
   * @private
   */
  applyCmcdDataToRequest_(output, request, useHeaders) {
    const encodeOptions = shaka.util.CmcdManager.getEncodeOptions_(
        request.uris[0],
        this.config_.version,
        cml.cmcd.CMCD_REQUEST_MODE);
    if (useHeaders) {
      const headers = shaka.util.CmcdManager.toHeaders(output, encodeOptions);
      if (!Object.keys(headers).length) {
        return;
      }

      Object.assign(request.headers, headers);
    } else {
      const query = shaka.util.CmcdManager.toQuery(output, encodeOptions);
      if (!query) {
        return;
      }

      request.uris = request.uris.map((uri) => {
        return shaka.util.CmcdManager.appendQueryToUri(uri, query);
      });
    }

    // Clean up timestamp entry after CMCD data has been attached to request
    if (!this.hasResponseReceived_() &&
          this.requestTimestampMap_.has(request)) {
      this.requestTimestampMap_.delete(request);
    }
  }

  /**
   * Checks if the keys in `includeKeys` are valid against a list of
   * `allowedKeys`. It logs an error for any invalid key and returns a new array
   * containing only the valid keys. If `includeKeys` is empty or not provided,
   * it returns all `allowedKeys`.
   *
   * @param {Array<string>} includeKeys Keys to validate.
   * @param {Array<string>} allowedKeys The list of allowed keys.
   * @param {string} mode Mode ('query', 'header' or 'event') for error logging.
   *
   * @return {Array<string>} A new array containing only the valid keys.
   * @private
   */
  checkValidKeys_(includeKeys, allowedKeys, mode) {
    if (!includeKeys || includeKeys.length === 0) {
      return allowedKeys;
    }

    for (const key of includeKeys) {
      if (!allowedKeys.includes(key)) {
        shaka.log.error(`CMCD Key "${key}" is not allowed for ${mode} mode`);
      }
    }

    includeKeys = includeKeys.filter((key) =>
      allowedKeys.includes(key),
    );

    return includeKeys;
  }

  /**
   * Filter the CMCD data object to include only the keys specified in the
   * configuration.
   *
   * @param {CmcdData} data
   * @param {Array<string>} includeKeys
   *
   * @return {CmcdData}
   * @private
   */
  filterKeys_(data, includeKeys) {
    return Object.keys(data).reduce((acc, key) => {
      if (includeKeys.includes(key)) {
        acc[key] = data[key];
      }
      return acc;
    }, {});
  }

  /**
   * @param {Array<string>} includeEvents
   * @param {CmcdData} data
   * @private
   *
   * @return {boolean}
   */
  isValidEvent_(includeEvents, data) {
    const allowedEvents = Object.values(cml.cmcd.CmcdEventType);
    const allowedPlayStates = Object.values(cml.cmcd.CmcdPlayerState);

    const event = data['e'];
    const playState = data['sta'];

    if (event) {
      if (!allowedEvents.includes(event)) {
        return false;
      }

      if (event === 'ps') {
        if (!playState || !allowedPlayStates.includes(playState)) {
          return false;
        }
      }

      if (includeEvents && includeEvents.length > 0 &&
          !includeEvents.includes(event)) {
        return false;
      }
    }

    return true;
  }

  /**
   * The CMCD object type.
   *
   * @param {shaka.extern.RequestContext} context
   *   The request context
   * @return {cml.cmcd.CmcdObjectType|undefined}
   * @private
   */
  getObjectType_(context) {
    if (context.type ===
        shaka.net.NetworkingEngine.AdvancedRequestType.INIT_SEGMENT) {
      return cml.cmcd.CmcdObjectType.INIT;
    }

    const stream = context.stream;

    if (!stream) {
      return undefined;
    }

    const type = stream.type;

    if (type == 'video') {
      if (stream.codecs && stream.codecs.includes(',')) {
        return cml.cmcd.CmcdObjectType.MUXED;
      }
      return cml.cmcd.CmcdObjectType.VIDEO;
    }

    if (type == 'audio') {
      return cml.cmcd.CmcdObjectType.AUDIO;
    }

    if (type == 'text') {
      if (stream.mimeType === 'application/mp4') {
        return cml.cmcd.CmcdObjectType.TIMED_TEXT;
      }
      return cml.cmcd.CmcdObjectType.CAPTION;
    }

    return undefined;
  }

  /**
   * The CMCD object type from mimeType.
   *
   * @param {!string} mimeType
   * @return {(cml.cmcd.CmcdObjectType|undefined)}
   * @private
   */
  getObjectTypeFromMimeType_(mimeType) {
    switch (mimeType.toLowerCase()) {
      case 'audio/mp4':
      case 'audio/webm':
      case 'audio/ogg':
      case 'audio/mpeg':
      case 'audio/aac':
      case 'audio/flac':
      case 'audio/wav':
        return cml.cmcd.CmcdObjectType.AUDIO;

      case 'video/webm':
      case 'video/mp4':
      case 'video/mpeg':
      case 'video/mp2t':
        return cml.cmcd.CmcdObjectType.MUXED;

      case 'application/x-mpegurl':
      case 'application/vnd.apple.mpegurl':
      case 'application/dash+xml':
      case 'video/vnd.mpeg.dash.mpd':
      case 'application/vnd.ms-sstr+xml':
        return cml.cmcd.CmcdObjectType.MANIFEST;

      default:
        return undefined;
    }
  }

  /**
   * Creates a stable string key from a configuration object.
   * This is used to uniquely identify a CMCD target.
   *
   * @param {!Object} obj The object to hash.
   * @return {string}
   * @private
   */
  getCmcdTargetHash_(obj) {
    const sortedObj = Object.keys(obj).sort().reduce(
        (acc, key) => {
          if (key !== 'enabled') {
            acc[key] = obj[key];
          }
          return acc;
        },
        {},
    );
    return JSON.stringify(sortedObj);
  }

  /**
   * Get the buffer length for a media type in milliseconds
   *
   * @param {string} type
   * @return {number}
   * @private
   */
  getBufferLength_(type) {
    const ranges = this.player_.getBufferedInfo()[type];

    if (!ranges.length) {
      return NaN;
    }

    const start = this.getCurrentTime_();
    const range = ranges.find((r) => r.start <= start && r.end >= start);

    if (!range) {
      return NaN;
    }

    return (range.end - start) * 1000;
  }

  /**
   * Get the remaining buffer length for a media type in milliseconds
   *
   * @param {string} type
   * @return {number}
   * @private
   */
  getRemainingBufferLength_(type) {
    const ranges = this.player_.getBufferedInfo()[type];

    if (!ranges.length) {
      return 0;
    }

    const start = this.getCurrentTime_();
    const range = ranges.find((r) => r.start <= start && r.end >= start);

    if (!range) {
      return 0;
    }

    return (range.end - start) * 1000;
  }

  /**
   * Calculate measured start delay
   *
   * @return {number|undefined}
   * @private
   */
  calculateMSD_() {
    if (this.playbackPlayingTime_ &&
        this.playbackPlayTime_) {
      const startTime = this.startTimeOfLoad_ || this.playbackPlayTime_;
      return this.playbackPlayingTime_ - startTime;
    }
    return undefined;
  }


  /**
   * Calculate requested maximum throughput
   *
   * @param {shaka.extern.Stream} stream
   * @param {shaka.media.SegmentReference} segment
   * @return {number}
   * @private
   */
  calculateRtp_(stream, segment) {
    const playbackRate = this.player_.getPlaybackRate() || 1;
    const currentBufferLevel =
        this.getRemainingBufferLength_(stream.type) || 500;
    const bandwidth = stream.bandwidth;
    if (!bandwidth) {
      return NaN;
    }
    const segmentDuration = segment.endTime - segment.startTime;
    // Calculate file size in kilobits
    const segmentSize = bandwidth * segmentDuration / 1000;
    // Calculate time available to load file in seconds
    const timeToLoad = (currentBufferLevel / playbackRate) / 1000;
    // Calculate the exact bandwidth required
    const minBandwidth = segmentSize / timeToLoad;
    // Include a safety buffer
    return minBandwidth * this.config_.rtpSafetyFactor;
  }

  /**
   * Get the stream format
   *
   * @param {shaka.net.NetworkingEngine.AdvancedRequestType} type
   *   The request's advanced type
   * @return {(cml.cmcd.CmcdStreamingFormat|undefined)}
   * @private
   */
  getStreamFormat_(type) {
    const AdvancedRequestType = shaka.net.NetworkingEngine.AdvancedRequestType;

    switch (type) {
      case AdvancedRequestType.MPD:
        return cml.cmcd.CmcdStreamingFormat.DASH;

      case AdvancedRequestType.MASTER_PLAYLIST:
      case AdvancedRequestType.MEDIA_PLAYLIST:
        return cml.cmcd.CmcdStreamingFormat.HLS;
    }

    return undefined;
  }

  /**
   * Get the stream type
   *
   * @return {cml.cmcd.CmcdStreamType}
   * @private
   */
  getStreamType_() {
    const isLive = this.player_.isLive();
    if (isLive) {
      return cml.cmcd.CmcdStreamType.LIVE;
    } else {
      return cml.cmcd.CmcdStreamType.VOD;
    }
  }

  /**
   * Get the highest bandwidth for a given type.
   *
   * @param {cml.cmcd.CmcdObjectType|undefined} type
   * @return {number}
   * @private
   */
  getTopBandwidth_(type) {
    const variants = this.player_.getVariantTracks();
    if (!variants.length) {
      return NaN;
    }

    let top = variants[0];

    for (const variant of variants) {
      if (variant.type === 'variant' && variant.bandwidth > top.bandwidth) {
        top = variant;
      }
    }

    const ObjectType = cml.cmcd.CmcdObjectType;

    switch (type) {
      case ObjectType.VIDEO:
        return top.videoBandwidth || NaN;

      case ObjectType.AUDIO:
        return top.audioBandwidth || NaN;

      default:
        return top.bandwidth;
    }
  }

  /**
   * Get CMCD data for a segment.
   *
   * @param {shaka.extern.RequestContext} context
   *   The request context
   * @param {?string} requestUri
   * @return {!CmcdData}
   * @private
   */
  getDataForSegment_(context, requestUri) {
    const segment = context.segment;

    let duration = 0;
    if (segment) {
      duration = segment.endTime - segment.startTime;
    }

    const data = {
      d: duration * 1000,
      st: this.getStreamType_(),
    };

    data.ot = this.getObjectType_(context);

    const ObjectType = cml.cmcd.CmcdObjectType;
    const isMedia = data.ot === ObjectType.VIDEO ||
        data.ot === ObjectType.AUDIO ||
        data.ot === ObjectType.MUXED ||
        data.ot === ObjectType.TIMED_TEXT;

    const stream = context.stream;
    if (stream) {
      const playbackRate = this.player_.getPlaybackRate();
      if (isMedia) {
        data.bl = this.getBufferLength_(stream.type);
        if (data.ot !== ObjectType.TIMED_TEXT) {
          const remainingBufferLength =
              this.getRemainingBufferLength_(stream.type);
          if (playbackRate) {
            data.dl = remainingBufferLength / Math.abs(playbackRate);
          } else {
            data.dl = remainingBufferLength;
          }
        }
      }

      if (stream.bandwidth) {
        data.br = stream.bandwidth / 1000;
      }

      if (stream.segmentIndex && segment) {
        const reverse = playbackRate < 0;
        const iterator = stream.segmentIndex.getIteratorForTime(
            segment.endTime, /* allowNonIndependent= */ true, reverse);
        if (iterator) {
          const nextSegment = iterator.next().value;
          if (nextSegment && nextSegment != segment) {
            if (requestUri && !shaka.util.ArrayUtils.equal(
                segment.getUris(), nextSegment.getUris())) {
              data.nor = nextSegment.getUris()[0];
            }
            if ((nextSegment.startByte || nextSegment.endByte) &&
                (segment.startByte != nextSegment.startByte ||
                segment.endByte != nextSegment.endByte)) {
              let range = nextSegment.startByte + '-';
              if (nextSegment.endByte) {
                range += nextSegment.endByte;
              }
              data.nrr = range;
            }
          }
        }
        const rtp = this.calculateRtp_(stream, segment);
        if (!isNaN(rtp)) {
          data.rtp = rtp;
        }
      }
    }

    if (isMedia && data.ot !== ObjectType.TIMED_TEXT) {
      data.tb = this.getTopBandwidth_(data.ot) / 1000;
    }

    return data;
  }

  /**
   * Get player time.
   *
   * @private
   * @return {number}
   */
  getCurrentTime_() {
    return this.video_ ? this.video_.currentTime : 0;
  }

  /**
   * Get generic CMCD data.
   *
   * @param {!CmcdData} data The data object
   * @param {!cml.cmcd.CmcdReportingMode} mode
   * @return {!CmcdData}
   * @private
   */
  getGenericData_(data, mode) {
    // Apply baseline data
    Object.assign(data, this.createData_());

    data.pr = this.player_.getPlaybackRate();

    const isVideo = data.ot === cml.cmcd.CmcdObjectType.VIDEO ||
        data.ot === cml.cmcd.CmcdObjectType.MUXED;

    if (this.starved_ && isVideo) {
      data.bs = true;
      data.su = true;
      this.starved_ = false;
    }

    if (data.su == null) {
      data.su = this.buffering_;
    }

    if (this.player_.isLive()) {
      const liveLatency = this.player_.getLiveLatency();
      data.ltc = liveLatency || undefined;
    }

    if (document.hidden) {
      data.bg = true;
    }

    const msd = this.calculateMSD_();
    if (msd != undefined && !this.msdSent_[mode]) {
      data.msd = msd;
      this.msdSent_[mode] = true;
    }

    return data;
  }

  /**
   * Serialize a CMCD data object according to the rules defined in the
   * section 3.2 of
   * [CTA-5004](https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf).
   *
   * @param {CmcdData} data The CMCD data object
   * @param {cml.cmcd.CmcdEncodeOptions=} options Encoding options
   *   (e.g. `baseUrl` to root-relativize `nor` URLs).
   * @return {string}
   */
  static serialize(data, options) {
    return cml.cmcd.encodeCmcd(
        /** @type {cml.cmcd.Cmcd} */ (data), options);
  }

  /**
   * Convert a CMCD data object to request headers according to the rules
   * defined in the section 2.1 and 3.2 of
   * [CTA-5004](https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf).
   *
   * Two-step encode (rather than calling `serialize` per shard):
   *   1. Run CML's `prepareCmcdData` once on the full input so version
   *      auto-add, key filtering, and per-key formatters (incl. the
   *      `nor` baseUrl rewrite) all apply once.
   *   2. Bucket the prepared keys into shaka's four shards, then call
   *      `encodePreparedCmcd` per shard so each shard SFV-encodes
   *      without re-preparing — which would otherwise re-add `v=2` to
   *      every non-empty shard.
   *
   * @param {CmcdData} data The CMCD data object
   * @param {cml.cmcd.CmcdEncodeOptions=} options Encoding options
   *   (e.g. `baseUrl` to root-relativize `nor` URLs).
   * @return {!Object}
   */
  static toHeaders(data, options) {
    const prepared = cml.cmcd.prepareCmcdData(
        /** @type {!Object<string, *>} */ (data), options);
    const headers = {};
    const headerNames = ['Object', 'Request', 'Session', 'Status'];
    const headerGroups = [{}, {}, {}, {}];
    const headerMap = {
      br: 0, d: 0, ot: 0, tb: 0, url: 0,
      bl: 1, dl: 1, mtp: 1, nor: 1, nrr: 1, su: 1, ltc: 1, ttfb: 1, ttlb: 1,
      ts: 1, rc: 1, cmsdd: 1, cmsds: 1, sn: 1,
      cid: 2, pr: 2, sf: 2, sid: 2, st: 2, v: 2, msd: 2,
      bs: 3, rtp: 3, bg: 3,
    };

    for (const key of Object.keys(prepared)) {
      // Unmapped fields are mapped to the Request header.
      const index = (headerMap[key] != null) ? headerMap[key] : 1;
      headerGroups[index][key] = prepared[key];
    }

    for (let i = 0; i < headerGroups.length; i++) {
      const value = cml.cmcd.encodePreparedCmcd(
          /** @type {!cml.cmcd.Cmcd} */ (headerGroups[i]));
      if (value) {
        headers[`CMCD-${headerNames[i]}`] = value;
      }
    }

    return headers;
  }

  /**
   * Convert a CMCD data object to query args according to the rules
   * defined in the section 2.2 and 3.2 of
   * [CTA-5004](https://cdn.cta.tech/cta/media/media/resources/standards/pdfs/cta-5004-final.pdf).
   *
   * @param {CmcdData} data The CMCD data object
   * @param {cml.cmcd.CmcdEncodeOptions=} options Encoding options
   *   (e.g. `baseUrl` to root-relativize `nor` URLs).
   * @return {string}
   */
  static toQuery(data, options) {
    return shaka.util.CmcdManager.serialize(data, options);
  }

  /**
   * Append query args to a uri.
   *
   * Note: the URL-append step itself is NOT delegated to CML's
   * `cml.cmcd.appendCmcdQuery`, which takes a CMCD data object plus encode
   * options. Shaka's signature here is `(uri, encodedQuery)` — used as a
   * thin adapter for callers that have already encoded via `toQuery`.
   * Phase 3 will replace these call sites with `cml.cmcd.appendCmcdQuery`
   * directly.
   *
   * @param {string} uri
   * @param {string} query
   * @return {string}
   */
  static appendQueryToUri(uri, query) {
    if (!query) {
      return uri;
    }

    if (uri.includes('offline:')) {
      return uri;
    }

    const url = new goog.Uri(uri);
    url.getQueryData().set('CMCD', query);
    return url.toString();
  }

  /**
   * Build encoder options for a CMCD encode call.
   *
   * @param {(string|undefined)} uri Source URL whose origin becomes
   *   `baseUrl` so CML can rewrite `nor` URLs root-relative. Skipped
   *   for `offline:` storage URIs and unparsable URIs.
   * @param {number=} version `1` or `2`. Threads `this.config_.version`
   *   to CML so V1 configurations get V1 keyset filtering and no
   *   auto-`v=2`.
   * @param {string=} reportingMode `'request'` or `'event'`. CML's
   *   `prepareCmcdData` filters keys by mode (e.g. `e`/`ts` are
   *   event-only). Defaults to CML's request mode if omitted.
   * @return {!cml.cmcd.CmcdEncodeOptions}
   * @private
   */
  static getEncodeOptions_(uri, version, reportingMode) {
    /** @type {!cml.cmcd.CmcdEncodeOptions} */
    const options = /** @type {!cml.cmcd.CmcdEncodeOptions} */ ({});
    if (uri && !uri.includes('offline:')) {
      try {
        options.baseUrl = new URL(uri).origin;
      } catch (e) {
        // Unparsable URI; skip baseUrl. CML's `nor` formatter passes
        // values through unchanged when baseUrl is absent.
      }
    }
    if (version != null) {
      options.version = version;
    }
    if (reportingMode != null) {
      options.reportingMode = reportingMode;
    }
    return options;
  }
};

/**
 * Phase 1 dropped the non-spec `'ld'` / `'lh'` values, so shaka's enum
 * is now value-identical to `cml.cmcd.CmcdStreamingFormat` (4 spec-
 * conformant values: `'d'`/`'h'`/`'s'`/`'o'`). The literal definition
 * is retained — Closure's `clutz` TypeScript-defs generator and shaka's
 * `generateExterns.js` both expect `@export`ed `@enum`s to have an
 * inline `ObjectExpression` with literal values, not an alias. The
 * value identity is asserted in unit tests.
 *
 * Other shaka enums (`ObjectType`, `Version`, `StreamType`, `CmcdMode`,
 * `CmcdKeys`, `CmcdV2Constants`, `CmcdV2Keys`) were never `@export`ed
 * and have been deleted in favor of `cml.cmcd.*` equivalents.
 *
 * @enum {string}
 * @export
 */
shaka.util.CmcdManager.StreamingFormat = {
  DASH: 'd',
  HLS: 'h',
  SMOOTH: 's',
  OTHER: 'o',
};
