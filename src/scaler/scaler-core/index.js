/* Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License
 */

/*
 * Autoscaler Scaler function
 *
 * * Receives metrics from the Autoscaler Poller pertaining to a single Spanner
 * instance.
 * * Determines if the Spanner instance can be autoscaled
 * * Selects a scaling method, and gets a number of suggested nodes
 * * Autoscales the Spanner instance by the number of suggested nodes
 */
// eslint-disable-next-line no-unused-vars -- for type checking only.
const express = require('express');
// eslint-disable-next-line no-unused-vars -- for type checking only.
const {google: GoogleApis, spanner_v1: spannerRest} = require('googleapis');
// eslint-disable-next-line no-unused-vars -- spannerProtos used for type checks
const {Spanner, protos: spannerProtos} = require('@google-cloud/spanner');
const Counters = require('./counters.js');
const sanitize = require('sanitize-filename');
const {convertMillisecToHumanReadable} = require('./utils.js');
const {logger} = require('../../autoscaler-common/logger');
const {publishProtoMsgDownstream} = require('./utils.js');
const State = require('./state.js');
const fs = require('fs');
const {AutoscalerUnits} = require('../../autoscaler-common/types');
const {version: packageVersion} = require('../../../package.json');

/**
 * @typedef {import('../../autoscaler-common/types').AutoscalerSpanner
 * } AutoscalerSpanner
 * @typedef {import('./state.js').StateData} StateData
 * @typedef {spannerProtos.google.spanner.admin.instance.v1.UpdateInstanceMetadata
 * } UpdateInstanceMetadata
 */

// The Node.JS spanner library has no way of getting an Operation status
// without an Operation object, and no way of getting an Operation object
// from just an Operation ID. So we use the Spanner REST api to get the
// Operation status.
// https://github.com/googleapis/nodejs-spanner/issues/2022
const spannerRestApi = GoogleApis.spanner({
  version: 'v1',
  auth: new GoogleApis.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spanner.admin'],
  }),
});

/**
 * Get scaling method function by name.
 *
 * @param {AutoscalerSpanner} spanner
 * @return {{
 *  calculateSize: function(AutoscalerSpanner):number,
 *  calculateNumNodes: function(AutoscalerSpanner): number
 * }}
 */
function getScalingMethod(spanner) {
  const SCALING_METHODS_FOLDER = './scaling-methods/';
  const DEFAULT_METHOD_NAME = 'STEPWISE';

  // sanitize the method name before using
  // to prevent risk of directory traversal.
  const methodName = sanitize(spanner.scalingMethod);
  let scalingMethod;
  try {
    scalingMethod = require(SCALING_METHODS_FOLDER + methodName.toLowerCase());
  } catch (err) {
    logger.warn({
      message: `Unknown scaling method '${methodName}'`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
    });
    scalingMethod = require(
      SCALING_METHODS_FOLDER + DEFAULT_METHOD_NAME.toLowerCase(),
    );
    spanner.scalingMethod = DEFAULT_METHOD_NAME;
  }
  logger.info({
    message: `Using scaling method: ${spanner.scalingMethod}`,
    projectId: spanner.projectId,
    instanceId: spanner.instanceId,
  });
  return scalingMethod;
}

/**
 * Build metadata object.
 *
 * @param {number} suggestedSize
 * @param {AutoscalerUnits} units
 * @return {spannerProtos.google.spanner.admin.instance.v1.IInstance}}
 */
function getNewMetadata(suggestedSize, units) {
  const metadata =
    units === AutoscalerUnits.NODES
      ? {nodeCount: suggestedSize}
      : {processingUnits: suggestedSize};
  return metadata;
}

/**
 * Scale the specified spanner instance to the specified size
 *
 * @param {AutoscalerSpanner} spanner
 * @param {number} suggestedSize
 * @return {Promise<string?>} operationId
 */
async function scaleSpannerInstance(spanner, suggestedSize) {
  logger.info({
    message: `----- ${spanner.projectId}/${spanner.instanceId}: Scaling Spanner instance to ${suggestedSize} ${spanner.units} -----`,
    projectId: spanner.projectId,
    instanceId: spanner.instanceId,
  });

  const spannerClient = new Spanner({
    projectId: spanner.projectId,
    // @ts-ignore -- hidden property of ServiceOptions.
    userAgent: `cloud-solutions/spanner-autoscaler-scaler-usage-v${packageVersion}`,
  });

  try {
    const [operation] = await spannerClient
      .instance(spanner.instanceId)
      .setMetadata(getNewMetadata(suggestedSize, spanner.units));

    logger.debug({
      message: `Cloud Spanner started the scaling operation: ${operation.name}`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
    });

    const updateInstanceMetadata =
      /** @type {spannerProtos.google.spanner.admin.instance.v1.IUpdateInstanceMetadata} */ (
        operation.metadata
      );
    if (
      updateInstanceMetadata.expectedFulfillmentPeriod ===
      spannerProtos.google.spanner.admin.instance.v1.FulfillmentPeriod
        .FULFILLMENT_PERIOD_EXTENDED
    ) {
      logger.warn({
        message: `Cloud Spanner scaling operation returned FULFILLMENT_PERIOD_EXTENDED and may take up to 1hr (id: ${operation.name})`,
        projectId: spanner.projectId,
        instanceId: spanner.instanceId,
      });
    }

    return operation.name || null;
  } finally {
    spannerClient.close();
  }
}

/**
 * Publish scaling PubSub event.
 *
 * @param {string} eventName
 * @param {AutoscalerSpanner} spanner
 * @param {number} suggestedSize
 * @return {Promise<Void>}
 */
async function publishDownstreamEvent(eventName, spanner, suggestedSize) {
  const message = {
    projectId: spanner.projectId,
    instanceId: spanner.instanceId,
    currentSize: spanner.currentSize,
    suggestedSize: suggestedSize,
    units: spanner.units,
    metrics: spanner.metrics,
  };

  return publishProtoMsgDownstream(
    eventName,
    message,
    spanner.downstreamPubSubTopic,
  );
}

/**
 * Test to see if spanner instance is in post-scale cooldown.
 *
 * @param {AutoscalerSpanner} spanner
 * @param {number} suggestedSize
 * @param {StateData} autoscalerState
 * @param {number} now timestamp in millis since epoch
 * @return {boolean}
 */
function withinCooldownPeriod(spanner, suggestedSize, autoscalerState, now) {
  const MS_IN_1_MIN = 60000;
  const scaleOutSuggested = suggestedSize - spanner.currentSize > 0;
  let cooldownPeriodOver;
  let duringOverload = '';

  logger.debug({
    message: `-----  ${spanner.projectId}/${spanner.instanceId}: Verifying if scaling is allowed -----`,
    projectId: spanner.projectId,
    instanceId: spanner.instanceId,
  });

  // Use the operation completion time if present, else use the launch time
  // of the scaling op.
  const lastScalingMillisec = autoscalerState.lastScalingCompleteTimestamp
    ? autoscalerState.lastScalingCompleteTimestamp
    : autoscalerState.lastScalingTimestamp;

  const operation = scaleOutSuggested
    ? {
        description: 'scale out',
        coolingMillisec: spanner.scaleOutCoolingMinutes * MS_IN_1_MIN,
      }
    : {
        description: 'scale in',
        coolingMillisec: spanner.scaleInCoolingMinutes * MS_IN_1_MIN,
      };

  if (spanner.isOverloaded) {
    if (spanner.overloadCoolingMinutes == null) {
      spanner.overloadCoolingMinutes = spanner.scaleOutCoolingMinutes;
      logger.info({
        message:
          '\tNo cooldown period defined for overload situations. ' +
          `Using default: ${spanner.scaleOutCoolingMinutes} minutes`,
        projectId: spanner.projectId,
        instanceId: spanner.instanceId,
      });
    }
    operation.coolingMillisec = spanner.overloadCoolingMinutes * MS_IN_1_MIN;
    duringOverload = ' during overload';
  }

  if (lastScalingMillisec == 0) {
    cooldownPeriodOver = true;
    logger.debug({
      message: `\tNo previous scaling operation found for this Spanner instance`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
    });
  } else {
    const elapsedMillisec = now - lastScalingMillisec;
    cooldownPeriodOver = elapsedMillisec >= operation.coolingMillisec;
    logger.debug({
      message: `\tLast scaling operation was ${convertMillisecToHumanReadable(
        now - lastScalingMillisec,
      )} ago.`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
    });
    logger.debug({
      message: `\tCooldown period for ${operation.description}${duringOverload} is ${convertMillisecToHumanReadable(
        operation.coolingMillisec,
      )}.`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
    });
  }
  if (cooldownPeriodOver) {
    logger.info({
      message: `\t=> Autoscale allowed`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
    });
    return false;
  } else {
    logger.info({
      message: `\t=> Autoscale NOT allowed yet`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
    });
    return true;
  }
}

/**
 * Get Suggested size from config using scalingMethod
 * @param {AutoscalerSpanner} spanner
 * @return {number}
 */
function getSuggestedSize(spanner) {
  const scalingMethod = getScalingMethod(spanner);
  if (scalingMethod.calculateSize) {
    return scalingMethod.calculateSize(spanner);
  } else if (scalingMethod.calculateNumNodes) {
    logger.warn(
      `scaling method ${spanner.scalingMethod} uses deprecated calculateNumNodes function`,
    );
    return scalingMethod.calculateNumNodes(spanner);
  } else {
    throw new Error(
      `no calculateSize() in scaling method ${spanner.scalingMethod}`,
    );
  }
}

/**
 * Process the request to check a spanner instance for scaling
 *
 * @param {AutoscalerSpanner} spanner
 * @param {State} autoscalerState
 */
async function processScalingRequest(spanner, autoscalerState) {
  logger.info({
    message: `----- ${spanner.projectId}/${spanner.instanceId}: Scaling request received`,
    projectId: spanner.projectId,
    instanceId: spanner.instanceId,
    payload: spanner,
  });

  // Check for ongoing LRO
  const {savedState, expectedFulfillmentPeriod} =
    await readStateCheckOngoingLRO(spanner, autoscalerState);

  const suggestedSize = getSuggestedSize(spanner);
  if (
    suggestedSize === spanner.currentSize &&
    spanner.currentSize === spanner.maxSize
  ) {
    logger.info({
      message: `----- ${spanner.projectId}/${spanner.instanceId}: has ${spanner.currentSize} ${spanner.units}, no scaling possible - at maxSize`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
      payload: spanner,
    });
    await Counters.incScalingDeniedCounter(spanner, suggestedSize, 'MAX_SIZE');
    return;
  } else if (suggestedSize === spanner.currentSize) {
    logger.info({
      message: `----- ${spanner.projectId}/${spanner.instanceId}: has ${spanner.currentSize} ${spanner.units}, no scaling needed - at current size`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
      payload: spanner,
    });
    await Counters.incScalingDeniedCounter(
      spanner,
      suggestedSize,
      'CURRENT_SIZE',
    );
    return;
  }

  if (
    savedState.scalingOperationId &&
    expectedFulfillmentPeriod ===
      spannerProtos.google.spanner.admin.instance.v1.FulfillmentPeriod
        .FULFILLMENT_PERIOD_EXTENDED &&
    savedState.scalingRequestedSize !== suggestedSize
  ) {
    // There is an ongoing scaling operation with extended fulfulment period,
    // but the scaling calculations have evaluated a different size to what
    // was previously requested.
    // TODO handle this better: https://github.com/cloudspannerecosystem/autoscaler/issues/283
    logger.warn({
      message: `----- ${spanner.projectId}/${spanner.instanceId}: has ongoing scaling operation to ${savedState.scalingRequestedSize} ${spanner.units} with FULFILLMENT_PERIOD_EXTENDED`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
      payload: spanner,
    });
  }

  if (!savedState.scalingOperationId) {
    // no ongoing operation, check cooldown...
    if (
      !withinCooldownPeriod(
        spanner,
        suggestedSize,
        savedState,
        autoscalerState.now,
      )
    ) {
      let eventType;
      try {
        const operationId = await scaleSpannerInstance(spanner, suggestedSize);
        await autoscalerState.updateState({
          ...savedState,
          scalingOperationId: operationId,
          lastScalingTimestamp: autoscalerState.now,
          lastScalingCompleteTimestamp: null,
          scalingMethod: spanner.scalingMethod,
          scalingPreviousSize: spanner.currentSize,
          scalingRequestedSize: suggestedSize,
        });
        eventType = 'SCALING';
      } catch (err) {
        logger.error({
          message: `----- ${spanner.projectId}/${spanner.instanceId}: Unsuccessful scaling attempt: ${err}`,
          projectId: spanner.projectId,
          instanceId: spanner.instanceId,
          payload: spanner,
          err: err,
        });
        eventType = 'SCALING_FAILURE';
        await Counters.incScalingFailedCounter(
          spanner,
          spanner.scalingMethod,
          spanner.currentSize,
          suggestedSize,
        );
      }
      await publishDownstreamEvent(eventType, spanner, suggestedSize);
    } else {
      logger.info({
        message: `----- ${spanner.projectId}/${spanner.instanceId}: has ${spanner.currentSize} ${spanner.units}, no scaling possible - within cooldown period`,
        projectId: spanner.projectId,
        instanceId: spanner.instanceId,
        payload: spanner,
      });
      await Counters.incScalingDeniedCounter(
        spanner,
        suggestedSize,
        'WITHIN_COOLDOWN',
      );
    }
  } else {
    logger.info({
      message:
        `----- ${spanner.projectId}/${spanner.instanceId}: has ${spanner.currentSize} ${spanner.units}, no scaling possible ` +
        `- last scaling operation to ${savedState.scalingRequestedSize} ${spanner.units} still in progress. Started: ${convertMillisecToHumanReadable(
          autoscalerState.now - savedState.lastScalingTimestamp,
        )} ago).`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
      payload: spanner,
    });
    await Counters.incScalingDeniedCounter(
      spanner,
      suggestedSize,
      'IN_PROGRESS',
    );
  }
}

/**
 * Handle scale request from a PubSub event.
 *
 * Called by Cloud Run functions Scaler deployment.
 *
 * @param {{data:string}} pubSubEvent -- a CloudEvent object.
 * @param {*} context
 */
async function scaleSpannerInstancePubSub(pubSubEvent, context) {
  try {
    const payload = Buffer.from(pubSubEvent.data, 'base64').toString();
    const spanner = JSON.parse(payload);
    try {
      const state = State.buildFor(spanner);

      await processScalingRequest(spanner, state);
      await state.close();
      await Counters.incRequestsSuccessCounter();
    } catch (err) {
      logger.error({
        message: `Failed to process scaling request: ${err}`,
        projectId: spanner.projectId,
        instanceId: spanner.instanceId,
        payload: spanner,
        err: err,
      });
      await Counters.incRequestsFailedCounter();
    }
  } catch (err) {
    logger.error({
      message: `Failed to parse pubSub scaling request: ${err}`,
      payload: pubSubEvent.data,
      err: err,
    });
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Test to handle scale request from a HTTP call with fixed payload
 * For testing with: https://cloud.google.com/functions/docs/functions-framework
 * @param {express.Request} req
 * @param {express.Response} res
 */
async function scaleSpannerInstanceHTTP(req, res) {
  try {
    const payload = fs.readFileSync(
      'src/scaler/scaler-core/test/samples/parameters.json',
      'utf-8',
    );
    const spanner = JSON.parse(payload);
    try {
      const state = State.buildFor(spanner);

      await processScalingRequest(spanner, state);
      await state.close();

      res.status(200).end();
      await Counters.incRequestsSuccessCounter();
    } catch (err) {
      logger.error({
        message: `Failed to process scaling request: ${err}`,
        payload: payload,
        err: err,
      });
      res.status(500).contentType('text/plain').end('An Exception occurred');
      await Counters.incRequestsFailedCounter();
    }
  } catch (err) {
    logger.error({
      message: `Failed to parse http scaling request: ${err}`,
      err: err,
    });
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Handle scale request from a HTTP call with JSON payload
 *
 * Called by the Scaler service on GKE deployments
 *
 * @param {express.Request} req
 * @param {express.Response} res
 */
async function scaleSpannerInstanceJSON(req, res) {
  const spanner = req.body;
  try {
    const state = State.buildFor(spanner);

    await processScalingRequest(spanner, state);
    await state.close();

    res.status(200).end();
    await Counters.incRequestsSuccessCounter();
  } catch (err) {
    logger.error({
      message: `Failed to process scaling request: ${err}`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
      payload: spanner,
      err: err,
    });
    res.status(500).contentType('text/plain').end('An Exception occurred');
    await Counters.incRequestsFailedCounter();
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * Handle scale request from local function call
 *
 * Called by unified poller/scaler on GKE deployments
 *
 * @param {AutoscalerSpanner} spanner
 */
async function scaleSpannerInstanceLocal(spanner) {
  try {
    const state = State.buildFor(spanner);

    await processScalingRequest(spanner, state);
    await state.close();
    await Counters.incRequestsSuccessCounter();
  } catch (err) {
    logger.error({
      message: `Failed to process scaling request: ${err}`,
      projectId: spanner.projectId,
      instanceId: spanner.instanceId,
      payload: spanner,
      err: err,
    });
  } finally {
    await Counters.tryFlush();
  }
}

/**
 * @typedef {{
 *  savedState: StateData,
 *  expectedFulfillmentPeriod: spannerProtos.google.spanner.admin.instance.v1.FulfillmentPeriod | undefined
 * }} LroInfo
 */

/**
 * Read state and check status of any LRO...
 *
 *
 * @param {AutoscalerSpanner} spanner
 * @param {State} autoscalerState
 * @return {Promise<LroInfo>}
 */
async function readStateCheckOngoingLRO(spanner, autoscalerState) {
  const savedState = await autoscalerState.get();

  if (!savedState.scalingOperationId) {
    // no LRO ongoing.
    return {
      savedState,
      expectedFulfillmentPeriod: undefined,
    };
  }
  /** @type {?spannerRest.Schema$UpdateInstanceMetadata} */
  try {
    // Check LRO status using REST API.
    const {data: operationState} =
      await spannerRestApi.projects.instances.operations.get({
        name: savedState.scalingOperationId,
      });

    if (!operationState) {
      throw new Error(
        `GetOperation(${savedState.scalingOperationId}) returned no results`,
      );
    }
    // Check metadata type
    if (
      !operationState.metadata ||
      operationState.metadata['@type'] !==
        spannerProtos.google.spanner.admin.instance.v1.UpdateInstanceMetadata.getTypeUrl()
    ) {
      throw new Error(
        `GetOperation(${savedState.scalingOperationId}) contained no UpdateInstanceMetadata`,
      );
    }

    const metadata = /** @type {spannerRest.Schema$UpdateInstanceMetadata} */ (
      operationState.metadata
    );

    // scalingRequestedSize should be in the savedState object, but as a
    // fallback get it from the metadata.
    // TODO: remove this when we no longer support V2.0.x backward compatibilty
    if (savedState.scalingRequestedSize == null) {
      savedState.scalingRequestedSize =
        (spanner.units === AutoscalerUnits.NODES
          ? metadata.instance?.nodeCount
          : metadata.instance?.processingUnits) ||
        // one of the previous 2 values should always be set, but as a fallback
        // set the currentSize
        spanner.currentSize;
    }

    const requestedSize =
      spanner.units === AutoscalerUnits.NODES
        ? {nodeCount: savedState.scalingRequestedSize}
        : {processingUnits: savedState.scalingRequestedSize};
    const displayedRequestedSize = JSON.stringify(requestedSize);

    if (operationState.done) {
      if (!operationState.error) {
        // Completed successfully.
        const endTimestamp =
          metadata.endTime == null ? 0 : Date.parse(metadata.endTime);
        logger.info({
          message: `----- ${spanner.projectId}/${spanner.instanceId}: Last scaling request for ${displayedRequestedSize} SUCCEEDED. Started: ${metadata.startTime}, completed: ${metadata.endTime}`,
          projectId: spanner.projectId,
          instanceId: spanner.instanceId,
          requestedSize: requestedSize,
          payload: spanner,
        });

        // Set completion time in savedState
        if (endTimestamp) {
          savedState.lastScalingCompleteTimestamp = endTimestamp;
        } else {
          // invalid end date, assume start date...
          logger.warn(
            `Failed to parse operation endTime : ${metadata.endTime}`,
          );
          savedState.lastScalingCompleteTimestamp =
            savedState.lastScalingTimestamp;
        }

        // Record success counters.
        await Counters.recordScalingDuration(
          savedState.lastScalingCompleteTimestamp -
            savedState.lastScalingTimestamp,
          spanner,
          savedState.scalingMethod,
          savedState.scalingPreviousSize,
          savedState.scalingRequestedSize,
        );
        await Counters.incScalingSuccessCounter(
          spanner,
          savedState.scalingMethod,
          savedState.scalingPreviousSize,
          savedState.scalingRequestedSize,
        );

        // Clear last scaling operation from savedState.
        savedState.scalingOperationId = null;
        savedState.scalingMethod = null;
        savedState.scalingPreviousSize = null;
        savedState.scalingRequestedSize = null;
      } else {
        // Last operation failed with an error
        logger.error({
          message: `----- ${spanner.projectId}/${spanner.instanceId}: Last scaling request for ${displayedRequestedSize} FAILED: ${operationState.error?.message}. Started: ${metadata.startTime}, completed: ${metadata.endTime}`,
          projectId: spanner.projectId,
          instanceId: spanner.instanceId,
          requestedSize: requestedSize,
          error: operationState.error,
          payload: spanner,
        });

        await Counters.incScalingFailedCounter(
          spanner,
          savedState.scalingMethod,
          savedState.scalingPreviousSize,
          savedState.scalingRequestedSize,
        );
        // Clear last scaling operation from savedState.
        savedState.lastScalingCompleteTimestamp = 0;
        savedState.lastScalingTimestamp = 0;
        savedState.scalingOperationId = null;
        savedState.scalingMethod = null;
        savedState.scalingPreviousSize = null;
        savedState.scalingRequestedSize = null;
      }
      return {
        savedState,
        expectedFulfillmentPeriod: undefined,
      };
    } else {
      const expectedFulfillmentPeriodString =
        metadata.expectedFulfillmentPeriod || '';

      // last scaling operation is still ongoing
      logger.info({
        message: `----- ${spanner.projectId}/${spanner.instanceId}: Last scaling request for ${displayedRequestedSize} IN PROGRESS. Started: ${metadata?.startTime} ${expectedFulfillmentPeriodString}`,
        projectId: spanner.projectId,
        instanceId: spanner.instanceId,
        requestedSize: requestedSize,
        payload: spanner,
      });

      // convert metadata.expectedFulfillmentPeriod as string to an enum.
      const expectedFulfillmentPeriod =
        expectedFulfillmentPeriodString === 'FULFILLMENT_PERIOD_NORMAL'
          ? spannerProtos.google.spanner.admin.instance.v1.FulfillmentPeriod
              .FULFILLMENT_PERIOD_NORMAL
          : expectedFulfillmentPeriodString === 'FULFILLMENT_PERIOD_EXTENDED'
            ? spannerProtos.google.spanner.admin.instance.v1.FulfillmentPeriod
                .FULFILLMENT_PERIOD_EXTENDED
            : spannerProtos.google.spanner.admin.instance.v1.FulfillmentPeriod
                .FULFILLMENT_PERIOD_UNSPECIFIED;
      return {
        savedState,
        expectedFulfillmentPeriod,
      };
    }
  } catch (err) {
    // Fallback - LRO.get() API failed or returned invalid status.
    // Assume complete.
    logger.error({
      message: `Failed to retrieve state of operation, assume completed. ID: ${savedState.scalingOperationId}: ${err}`,
      err: err,
    });
    savedState.scalingOperationId = null;
    savedState.lastScalingCompleteTimestamp = savedState.lastScalingTimestamp;
    // Record success counters.
    await Counters.recordScalingDuration(
      savedState.lastScalingCompleteTimestamp - savedState.lastScalingTimestamp,
      spanner,
      savedState.scalingMethod,
      savedState.scalingPreviousSize,
      savedState.scalingRequestedSize,
    );
    await Counters.incScalingSuccessCounter(
      spanner,
      savedState.scalingMethod,
      savedState.scalingPreviousSize,
      savedState.scalingRequestedSize,
    );

    savedState.scalingMethod = null;
    savedState.scalingPreviousSize = null;
    savedState.scalingRequestedSize = null;

    return {
      savedState,
      expectedFulfillmentPeriod: undefined,
    };
  } finally {
    // Update saved state in storage.
    await autoscalerState.updateState(savedState);
  }
}

module.exports = {
  scaleSpannerInstanceHTTP,
  scaleSpannerInstancePubSub,
  scaleSpannerInstanceJSON,
  scaleSpannerInstanceLocal,
};
