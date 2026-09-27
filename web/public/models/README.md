The English number-recognition model is prepared by `npm run dev` or
`npm run build`, downloaded from the official Vosk model repository, and
verified against the pinned SHA-256 in `scripts/prepare-number-model.mjs`.
The generated archive is not committed to Git. It is served from this site.

Model: vosk-model-small-en-us-0.15 (Apache License 2.0)
Source: https://alphacephei.com/vosk/models
Browser engine: vosk-browser 0.0.8 (Apache License 2.0)
Source: https://github.com/ccoreilly/vosk-browser

Recognition runs locally after the user chooses to download the model.
Microphone audio is not uploaded by this engine. The browser caches the model
in its local storage; clearing site data removes the cache.
