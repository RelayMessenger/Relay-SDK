/**
 * `@relaymessenger/sdk/calls`: join a Relay Call as the agent and send and
 * receive audio and video over WebRTC. This entry point needs the WebRTC
 * packages the SDK lists as optional peer dependencies (`werift`, `@evan/opus`,
 * `rtp-packet`, and `node-webcodecs` for video); `@relaymessenger/sdk` itself
 * never loads them.
 */
export {
  RelayCallTransport,
  RelayCallTransportError,
  type RelayAudioFrame,
  type RelayCallVideoStats,
  type RelayCallEngine,
  type RelayCallIceDiagnostics,
  type RelayCallInboundDiagnostics,
  type RelayCallOutboundDiagnostics,
  type RelayCallRestartEvent,
  type RelayCallRestartReason,
  type RelayCallRoomDiagnostics,
  type RelayCallTransportCloseEvent,
  type RelayCallTransportOptions,
  type RelayIceServer,
  type RelayIceServersProvider,
  type RelayIceTransportPolicy,
  type RelayInboundAudioFormat,
  type RelayWebRTCFactory,
  type RelayAudioSinkLike,
  type RelayAudioSourceLike,
  type RelayMediaStreamTrackLike,
  type RelayPeerConnectionConfig,
  type RelayPeerConnectionLike,
} from "./transport.js";
export { createWeriftWebRTCFactory } from "./engine-werift.js";
export {
  LocalVideoTrack,
  RemoteVideoTrack,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoRotation,
  VideoSource,
  VideoStream,
  type RelayVideoReceiverStats,
  type RelayVideoSenderStats,
  type TrackPublishOptions,
  type VideoEncoding,
  type VideoFrameEvent,
  type VideoStreamOptions,
} from "./video.js";
