// Fixture only: no microphone, AudioContext, Safari media session, or permissions.
export const isSafariBrowser = () => false;
export const prepareSafariNumberAudio = () => undefined;
export const releaseSafariNumberAudio = () => undefined;
export const acquireSafariNumberAudio = () => Promise.reject(new Error('Microphone is disabled in the local audit.'));
