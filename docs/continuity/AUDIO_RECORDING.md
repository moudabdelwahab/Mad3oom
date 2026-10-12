# Mad3oom Continuity: audio recording («تسجيل صوتي»)

> **Status:** frontend only, built on attachments (080). **Not deployed.** It works only once 080 and the upload function are deployed **and** attachments are switched on. Each of those steps needs separate approval.

## Behaviour (proposal §15.4)
**The button.** «تسجيل صوتي» sits next to «إرفاق ملف» in the record's «المرفقات» section. It is shown only when attachments are on and the record is active.

**The microphone** is requested **only on click**. It is switched off on:
- stop;
- cancel;
- discard;
- error;
- reaching the size limit;
- opening another record;
- `pagehide`.

Nothing records in the background. Tests count the opened and stopped tracks.

**States:**
1. requesting permission;
2. recording, with elapsed time and live size against «8 ميجا»;
3. review: playback, «رفع التسجيل», «إعادة التسجيل», «حذف»;
4. uploading: the same progress, cancel and retry as file attachments;
5. done or error.

**8 MiB limit** (1 MiB = 1,048,576 bytes): the recorder adds up the chunk sizes.
- Past the limit, it stops and **rejects the whole take**, and says so: «التسجيل وصل لحد 8 ميجا فاتلغى كله (مش هيتقص)».
- It never truncates.
- It offers «رفع ملف صوتي بدل كده».
- A take whose final chunk crosses the limit is rejected the same way.
- There is also a 10-minute duration cap. A take that reaches it stops normally and can be reviewed.

**Format:** negotiated with `MediaRecorder.isTypeSupported`, in this order: WebM/Opus, WebM, Ogg/Opus, MP4. The upload is `audio/webm`, `audio/ogg` or `audio/mp4`. It goes through the same path as any attachment: the upload function checks the signature, and the database verifies the stored object.

**Unsupported browser or denied permission:** a clear message, plus the file-upload fallback.

## Shared code change
`assets/js/voice-recorder.js` (also used by the inbox chat composer) gains **opt-in** options: `maxBytes`, `onSize` and `tooLargeMessage`.
- The defaults are unlimited, so the inbox behaviour is unchanged. The existing `tests/chat-composer-model.test.mjs` recorder tests pass unchanged.
- A unit test covers a large take without `maxBytes`.

## Tests
**`tests/continuity-audio.test.mjs`:**
- the byte cap during recording and at stop, with nothing kept and the microphone released;
- the inbox default is unchanged;
- the page wiring.

**`tests/continuity-phase-c.render.test.mjs`** («audio (§15.4)»):
- **Fake microphone:**
  - record → review → upload: a WebM header reaches the server, and the microphone is released;
  - the size limit rejects the take, nothing is uploaded, and the fallback opens a file chooser;
  - denied permission, unsupported browser, cancel and `pagehide`;
  - no button on a closed record or with attachments off.
- **Real Chromium `MediaRecorder` with `--use-fake-device-for-media-stream`:** the recorded file passes the same signature check the server runs.
- **Mutation-checked:** removing the byte cap or the `pagehide` release makes a test fail.

**Manual (not automatable here):** a real-device check on Safari (MP4 recording) and Firefox (Ogg/WebM).
