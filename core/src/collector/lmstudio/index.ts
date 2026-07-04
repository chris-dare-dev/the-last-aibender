/**
 * BE-5 source 7 — LM Studio inline usage capture (blueprint §6.1 LM Studio
 * row), consuming BE-4's /v1 usage surface.
 */

export {
  createLmStudioUsageCapture,
  instrumentLmStudioClient,
  type LmStudioUsageCapture,
  type LmStudioUsageCaptureOptions,
  type LmStudioUsageCaptureStats,
} from './usageCapture.js';
