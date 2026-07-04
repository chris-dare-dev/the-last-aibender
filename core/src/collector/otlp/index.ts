/**
 * BE-5 source 3 — in-process OTLP receiver on 127.0.0.1:4318 (blueprint
 * §6.1 row 1): loopback-only, http/json, `account=<LABEL>` resource
 * attribution, identity attrs dropped at ingest [X2].
 */

export {
  accountFromResource,
  decodeOtlpAttributes,
  mapOtlpLogRecord,
  type MappedLogRecord,
} from './mapper.js';

export {
  DEFAULT_OTLP_PORT,
  OTLP_RECEIVER_HOST,
  startOtlpReceiver,
  type OtlpReceiver,
  type OtlpReceiverOptions,
  type OtlpReceiverStats,
} from './receiver.js';
