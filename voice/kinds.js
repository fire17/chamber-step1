











export const KINDS = Object.freeze({ direct: 'webrtc', relay: 'relay-ws' });
export const DIRECT_DEFAULT = Object.freeze([KINDS.direct]);

export function directKinds(direct, fallback = DIRECT_DEFAULT) {
  if (Array.isArray(direct)) return direct;
  if (typeof direct === 'string') return [direct];
  return fallback;
}
export const paces = (direct, kind, fallback = DIRECT_DEFAULT) => directKinds(direct, fallback).includes(kind);
