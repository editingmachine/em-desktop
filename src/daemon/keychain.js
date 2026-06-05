// Task #1742 — secure credential storage using Electron's built-in safeStorage.
//
// safeStorage encrypts the secret with the OS keychain / Credential Vault /
// libsecret under the hood, but ships INSIDE Electron — there is no native
// module to compile (unlike the old `keytar` dependency, which reliably broke
// CI builds: Linux needed libsecret-dev and the forced native rebuild failed on
// every runner). The encrypted blob is persisted via `conf`.
//
// If encryption is unavailable (e.g. a headless Linux box with no keyring) we
// fall back to an in-memory store so the app still runs, without ever writing
// the secret to disk in plaintext.
const Conf = require("conf");

const store = new Conf({ projectName: "em-desktop-secure" });
const KEY = "session";

let memoryValue = null;

function safeStorage() {
  try {
    // Lazily required so this module can be imported before the app is ready.
    return require("electron").safeStorage;
  } catch (_) {
    return null;
  }
}

function encryptionAvailable() {
  const ss = safeStorage();
  try {
    return !!ss && ss.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

async function setSecret(value) {
  if (encryptionAvailable()) {
    const encrypted = safeStorage().encryptString(value);
    store.set(KEY, encrypted.toString("base64"));
    return;
  }
  memoryValue = value;
}

async function getSecret() {
  if (encryptionAvailable()) {
    const b64 = store.get(KEY);
    if (!b64) return null;
    try {
      return safeStorage().decryptString(Buffer.from(b64, "base64"));
    } catch (_) {
      return null;
    }
  }
  return memoryValue;
}

async function clearSecret() {
  store.delete(KEY);
  memoryValue = null;
}

module.exports = {
  setSecret,
  getSecret,
  clearSecret,
  // Evaluated lazily: encryption availability is only known after app-ready.
  get usingKeychain() {
    return encryptionAvailable();
  },
};
