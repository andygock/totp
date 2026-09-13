import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import jsQR from "jsqr";

/*
 * The production encoder deliberately has no test-only exports. This canvas
 * double records its public rendering output as RGBA pixels, allowing an
 * independent QR decoder to verify the same image an authenticator would see.
 */
class RecordingCanvas {
  #attributes = new Map();
  #height = 0;
  #pixels = new Uint8ClampedArray();
  #width = 0;

  constructor() {
    this.context = {
      fillStyle: "#000",
      fillRect: (x, y, width, height) => {
        const colour = this.context.fillStyle === "#fff" ? 255 : 0;

        for (let row = y; row < y + height; row += 1) {
          for (let column = x; column < x + width; column += 1) {
            const offset = (row * this.#width + column) * 4;
            this.#pixels[offset] = colour;
            this.#pixels[offset + 1] = colour;
            this.#pixels[offset + 2] = colour;
            this.#pixels[offset + 3] = 255;
          }
        }
      },
    };
  }

  get width() {
    return this.#width;
  }

  set width(value) {
    this.#width = value;
    this.#resizePixelBuffer();
  }

  get height() {
    return this.#height;
  }

  set height(value) {
    this.#height = value;
    this.#resizePixelBuffer();
  }

  #resizePixelBuffer() {
    this.#pixels = new Uint8ClampedArray(this.#width * this.#height * 4);
  }

  getContext(type) {
    assert.equal(type, "2d");
    return this.context;
  }

  setAttribute(name, value) {
    this.#attributes.set(name, value);
  }

  getAttribute(name) {
    return this.#attributes.get(name) ?? null;
  }

  get pixels() {
    return this.#pixels;
  }
}

function decodeCanvas(canvas) {
  const result = jsQR(canvas.pixels, canvas.width, canvas.height, {
    inversionAttempts: "dontInvert",
  });

  assert.ok(result, "Expected the rendered canvas to contain a decodable QR code");
  return result.data;
}

before(async () => {
  // qr-code.js is a classic browser script, so provide only the two browser
  // globals its public entry point requires before evaluating it in Node.js.
  globalThis.window = globalThis;
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      return new RecordingCanvas();
    },
  };

  await import("../qr-code.js");
});

describe("QrCode.createCanvas", () => {
  test("renders representative provisioning URIs that decode exactly", () => {
    const payloads = [
      "otpauth://totp/TOTP?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30",
      "otpauth://totp/Example%3Aalice%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example",
      "otpauth://totp/Melbourne%20Caf%C3%A9?secret=MZXW6YTBOI&issuer=%E6%B5%8B%E8%AF%95",
    ];

    for (const payload of payloads) {
      const canvas = QrCode.createCanvas(payload, 240);
      assert.equal(decodeCanvas(canvas), payload);
    }
  });

  test("encodes plain Unicode text as UTF-8", () => {
    const payload = "QR byte mode: café — 日本語 — 🔐";
    const canvas = QrCode.createCanvas(payload, 240);

    assert.equal(decodeCanvas(canvas), payload);
  });

  test("renders larger, multi-block QR versions that remain decodable", () => {
    // This length forces a multi-block QR version and exercises the
    // Reed–Solomon block interleaving used by realistic provisioning URIs.
    const payload = `otpauth://totp/LongAccount?secret=${"A".repeat(60)}`;
    const canvas = QrCode.createCanvas(payload, 400);

    assert.ok(canvas.width >= 400);
    assert.equal(canvas.width, canvas.height);
    assert.equal(decodeCanvas(canvas), payload);
  });

  test("honours the requested square size and exposes accessible metadata", () => {
    const canvas = QrCode.createCanvas("small payload", 201);

    assert.equal(canvas.width, 201);
    assert.equal(canvas.height, 201);
    assert.equal(canvas.getAttribute("role"), "img");
    assert.equal(
      canvas.getAttribute("aria-label"),
      "Authenticator provisioning QR code",
    );
  });

  test("expands very small requests enough to preserve whole QR modules", () => {
    const canvas = QrCode.createCanvas("small payload", 1);

    // Version 1 contains 21 modules plus the required four-module quiet zone
    // on every side, so the renderer must not squeeze it into a single pixel.
    assert.equal(canvas.width, 29);
    assert.equal(canvas.height, 29);
  });

  test("rejects content beyond the maximum QR Model 2 capacity", () => {
    assert.throws(
      () => QrCode.createCanvas("A".repeat(3_000)),
      /too long for a QR code/,
    );
  });

  test("publishes a frozen, non-replaceable browser API", () => {
    assert.ok(Object.isFrozen(QrCode));
    assert.deepEqual(Object.keys(QrCode), ["createCanvas"]);

    assert.throws(() => {
      globalThis.QrCode = {};
    }, TypeError);
  });
});
