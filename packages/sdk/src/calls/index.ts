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
  RIVE_OPEN_TIMEOUT_MS,
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
  RIVE_CHANNEL,
  RIVE_MESSAGE_MAX_BYTES,
  RelayRive,
  encodeRiveMessage,
  parseRiveMessage,
  type RiveEventMap,
  type RiveMessage,
  type RiveScene,
  type RiveTiming,
  type RiveValue,
} from "./rive.js";
export {
  VISEMES,
  alignmentFromWords,
  visemesFromAlignment,
  type CharacterAlignment,
  type Viseme,
  type VisemeCue,
  type VisemeName,
  type VisemeOptions,
  type WordTiming,
} from "./visemes.js";
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
