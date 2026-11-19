/*
 * Experience the World: Firebase Functions for parents' voices (ElevenLabs).
 *
 * Why this exists: the ElevenLabs key must never be in the web page. These functions run on
 * Google's servers, hold the key as a secret, and only act for the signed-in family.
 *
 *  createVoice        – turns a parent's one-minute recording into an ElevenLabs voice (needs consent)
 *  generateVoiceovers – reads hotspot words in that voice and saves the audio to the family's folder
 *  deleteVoice        – deletes the voice at ElevenLabs and all automatic voiceovers
 *
 * Data:
 *  voices/<account id>                      (database) voice id, consent time, which voiceovers exist.
 *                                           Families can read their own; only these functions can write.
 *  families/<account id>/sample/...         (storage) the parent's recording, uploaded by the app
 *  families/<account id>/auto/<adventure>/<hotspot>.mp3   (storage) automatic voiceovers
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "europe-west2", maxInstances: 5 });

const ELEVENLABS_API_KEY = defineSecret("ELEVENLABS_API_KEY");
const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_v4"; // newest model; if it refuses a request we fall back to the older one
const FALLBACK_MODEL = "eleven_multilingual_v2";
const SAMPLE_LINE = "Hello! Shall we go on an adventure together?";

// Limits, so a single call can't run up a large ElevenLabs bill
const MAX_ITEMS = 60;          // voiceovers per call
const MAX_TEXT = 800;          // characters per voiceover
const MAX_TOTAL = 20000;       // characters per call
const MAX_SAMPLE_BYTES = 15 * 1024 * 1024;

const db = admin.firestore();
const bucket = () => admin.storage().bucket();

function signedInUser(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  return req.auth.uid;
}

async function elevenLabsError(r) {
  let detail = "";
  try { detail = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ }
  logger.error("ElevenLabs error", { status: r.status, detail });
  return new HttpsError("internal", "ElevenLabs couldn't do that just now. Please try again.");
}

// How the voice is spoken. similarity_boost: how closely it sticks to the parent's voice (default 0.75).
// stability: steadier, less dramatic reading (default 0.5). Changing these makes every voiceover again (see SETTINGS_VERSION).
// v4 only has stability and similarity (no style or speaker boost). Very high similarity can sound less natural.
const VOICE_SETTINGS = { stability: 0.55, similarity_boost: 0.85 };
const FALLBACK_SETTINGS = { stability: 0.55, similarity_boost: 0.9, style: 0, use_speaker_boost: true };
const SETTINGS_VERSION = "3";

async function speak(key, voiceId, text, model, settings) {
  return fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
  });
}

async function textToSpeech(key, voiceId, text) {
  let r = await speak(key, voiceId, text, MODEL, VOICE_SETTINGS);
  if (!r.ok && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
    // the newer model turned the request down (for example not available on this plan): use the older one
    logger.warn("Falling back to the older voice model", { status: r.status, detail: (await r.text().catch(() => "")).slice(0, 200) });
    r = await speak(key, voiceId, text, FALLBACK_MODEL, FALLBACK_SETTINGS);
  }
  if (!r.ok) throw await elevenLabsError(r);
  return Buffer.from(await r.arrayBuffer());
}

// Saves audio with a download token so the family's app can play it (access is still checked by the storage rules)
async function saveAudio(path, buf) {
  await bucket().file(path).save(buf, {
    contentType: "audio/mpeg",
    metadata: { metadata: { firebaseStorageDownloadTokens: crypto.randomUUID() } },
  });
}

async function deleteElevenLabsVoice(key, voiceId) {
  const r = await fetch(`${API}/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", headers: { "xi-api-key": key } });
  if (!r.ok && r.status !== 404) logger.warn("Couldn't delete ElevenLabs voice", { status: r.status });
}

async function deleteAutoFiles(uid) {
  await bucket().deleteFiles({ prefix: `families/${uid}/auto/` }).catch(() => {});
}

exports.createVoice = onCall({ secrets: [ELEVENLABS_API_KEY], timeoutSeconds: 120, memory: "512MiB" }, async (req) => {
  const uid = signedInUser(req);
  const { samplePath, consent } = req.data || {};
  if (consent !== true) throw new HttpsError("failed-precondition", "Please agree before we create your voice.");
  if (typeof samplePath !== "string" || !samplePath.startsWith(`families/${uid}/sample/`)) {
    throw new HttpsError("invalid-argument", "The recording couldn't be found.");
  }

  const file = bucket().file(samplePath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError("not-found", "The recording couldn't be found.");
  const [meta] = await file.getMetadata();
  if (Number(meta.size) > MAX_SAMPLE_BYTES) throw new HttpsError("invalid-argument", "The recording is too large.");
  const [audio] = await file.download();

  const key = ELEVENLABS_API_KEY.value();
  const form = new FormData();
  form.append("name", `etw-${uid.slice(0, 10)}`);  // no personal details sent as the name
  form.append("description", "Experience the World family voice");
  const ext = (samplePath.split(".").pop() || "webm").toLowerCase();
  form.append("files", new Blob([audio], { type: meta.contentType || "audio/webm" }), `sample.${ext}`);

  const r = await fetch(`${API}/voices/add`, { method: "POST", headers: { "xi-api-key": key }, body: form });
  if (!r.ok) throw await elevenLabsError(r);
  const created = await r.json();

  // Replace any earlier voice for this family
  const ref = db.collection("voices").doc(uid);
  const before = (await ref.get()).data();
  if (before && before.voiceId) {
    await deleteElevenLabsVoice(key, before.voiceId);
    await deleteAutoFiles(uid);
  }

  await ref.set({
    voiceId: created.voice_id,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    consentAt: admin.firestore.FieldValue.serverTimestamp(),
    auto: {},
  });

  // A short sample so the parent can hear their voice straight away
  await saveAudio(`families/${uid}/auto/sample.mp3`, await textToSpeech(key, created.voice_id, SAMPLE_LINE));
  return { ok: true, requiresVerification: !!created.requires_verification };
});

exports.generateVoiceovers = onCall({ secrets: [ELEVENLABS_API_KEY], timeoutSeconds: 300, memory: "512MiB" }, async (req) => {
  const uid = signedInUser(req);
  const items = (req.data && req.data.items) || [];
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new HttpsError("invalid-argument", "Too many voiceovers at once.");
  let total = 0;
  for (const it of items) {
    const ok = it && typeof it.adventure === "string" && /^[a-z0-9-]{1,40}$/.test(it.adventure)
      && typeof it.id === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(it.id)
      && typeof it.text === "string" && it.text.trim().length > 0 && it.text.length <= MAX_TEXT;
    if (!ok) throw new HttpsError("invalid-argument", "A voiceover wasn't valid.");
    total += it.text.length;
  }
  if (total > MAX_TOTAL) throw new HttpsError("invalid-argument", "Too much text at once.");

  const ref = db.collection("voices").doc(uid);
  const voice = (await ref.get()).data();
  if (!voice || !voice.voiceId) throw new HttpsError("failed-precondition", "Set up your voice first.");

  const key = ELEVENLABS_API_KEY.value();
  const auto = Object.assign({}, voice.auto || {});
  const todo = items.filter((it) => auto[`${it.adventure}__${it.id}`] !== hash(it.text));

  // a few at a time
  let made = 0;
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (it) => {
      const buf = await textToSpeech(key, voice.voiceId, it.text.trim());
      await saveAudio(`families/${uid}/auto/${it.adventure}/${it.id}.mp3`, buf);
      auto[`${it.adventure}__${it.id}`] = hash(it.text);
      made++;
    }));
  }
  if (made) await ref.set({ auto }, { merge: true });
  return { made, skipped: items.length - todo.length };
});

exports.deleteVoice = onCall({ secrets: [ELEVENLABS_API_KEY], timeoutSeconds: 60 }, async (req) => {
  const uid = signedInUser(req);
  const ref = db.collection("voices").doc(uid);
  const voice = (await ref.get()).data();
  if (voice && voice.voiceId) await deleteElevenLabsVoice(ELEVENLABS_API_KEY.value(), voice.voiceId);
  await deleteAutoFiles(uid);
  await bucket().deleteFiles({ prefix: `families/${uid}/sample/` }).catch(() => {});
  await ref.delete();
  return { ok: true };
});

function hash(text) {
  return crypto.createHash("sha256").update(SETTINGS_VERSION + "|" + text.trim()).digest("hex").slice(0, 16);
}
