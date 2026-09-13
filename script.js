(() => {
  "use strict";

  const PERIOD = 30;
  const DIGITS = 6;

  const form = document.getElementById("form");
  const secretInput = document.getElementById("secret");
  const output = document.getElementById("output");
  const codeElement = document.getElementById("code");
  const timerElement = document.getElementById("timer");
  const qrElement = document.getElementById("qrcode");
  const errorElement = document.getElementById("error");

  let timerId = null;
  let lastCounter = null;

  function normaliseSecret(value) {
    return value
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/-/g, "")
      .replace(/=+$/g, "");
  }

  function decodeBase32(value) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const secret = normaliseSecret(value);

    if (!secret) {
      throw new Error("Secret is required.");
    }

    let bits = 0;
    let buffer = 0;
    const bytes = [];

    for (const character of secret) {
      const index = alphabet.indexOf(character);

      if (index === -1) {
        throw new Error("Secret is not valid Base32.");
      }

      buffer = (buffer << 5) | index;
      bits += 5;

      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >>> bits) & 0xff);
      }
    }

    if (bytes.length === 0) {
      throw new Error("Secret is too short.");
    }

    return new Uint8Array(bytes);
  }

  function counterBytes(counter) {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);

    const high = Math.floor(counter / 0x100000000);
    const low = counter >>> 0;

    view.setUint32(0, high, false);
    view.setUint32(4, low, false);

    return new Uint8Array(buffer);
  }

  async function generateTotp(secret, timestamp = Date.now()) {
    const secretBytes = decodeBase32(secret);
    const counter = Math.floor(timestamp / 1000 / PERIOD);
    const message = counterBytes(counter);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        {
          name: "HMAC",
          hash: "SHA-1",
        },
        false,
        ["sign"],
      );

      const signature = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, message),
      );

      const offset = signature[signature.length - 1] & 0x0f;

      const binary =
        ((signature[offset] & 0x7f) << 24) |
        ((signature[offset + 1] & 0xff) << 16) |
        ((signature[offset + 2] & 0xff) << 8) |
        (signature[offset + 3] & 0xff);

      const otp = (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");

      signature.fill(0);

      return {
        otp,
        counter,
      };
    } finally {
      secretBytes.fill(0);
      message.fill(0);
    }
  }

  function createQr(secret) {
    qrElement.replaceChildren();

    const uri =
      "otpauth://totp/TOTP?" +
      new URLSearchParams({
        secret: normaliseSecret(secret),
        algorithm: "SHA1",
        digits: String(DIGITS),
        period: String(PERIOD),
      }).toString();

    qrElement.append(QrCode.createCanvas(uri, 200));
  }

  async function update() {
    const secret = secretInput.value;

    if (!secret) {
      return;
    }

    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    const remaining = PERIOD - (seconds % PERIOD);
    const counter = Math.floor(seconds / PERIOD);

    timerElement.textContent = `Refreshes in ${remaining} second${remaining === 1 ? "" : "s"}`;

    if (counter === lastCounter) {
      return;
    }

    try {
      const result = await generateTotp(secret, now);

      lastCounter = result.counter;
      codeElement.textContent = result.otp;
      errorElement.textContent = "";
    } catch (error) {
      codeElement.textContent = "------";
      errorElement.textContent =
        error instanceof Error ? error.message : "Invalid secret.";
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    errorElement.textContent = "";
    lastCounter = null;

    try {
      const secret = secretInput.value;

      // Validate before exposing the output.
      const bytes = decodeBase32(secret);
      bytes.fill(0);

      createQr(secret);

      output.style.display = "block";

      await update();

      if (timerId !== null) {
        clearInterval(timerId);
      }

      timerId = window.setInterval(update, 250);
    } catch (error) {
      output.style.display = "none";
      qrElement.replaceChildren();

      errorElement.textContent =
        error instanceof Error ? error.message : "Invalid secret.";
    }
  });

  window.addEventListener("pagehide", () => {
    if (timerId !== null) {
      clearInterval(timerId);
    }

    secretInput.value = "";
    codeElement.textContent = "------";
    qrElement.replaceChildren();
  });
})();
