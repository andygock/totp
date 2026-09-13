(() => {
  "use strict";

  /*
   * A deliberately small QR Model 2 encoder for this application. It uses byte
   * mode and error-correction level M, which are sufficient for otpauth URIs.
   * Keeping the encoder here means the secret never becomes visible to code
   * fetched from a CDN or another third-party origin.
   */
  const ERROR_CORRECTION_CODEWORDS = [
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
    30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ];

  const ERROR_CORRECTION_BLOCKS = [
    1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
    5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
    31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ];

  function appendBits(target, value, length) {
    if (length < 0 || (length < 31 && value >>> length !== 0)) {
      throw new RangeError("QR bit value does not fit its field.");
    }

    for (let bit = length - 1; bit >= 0; bit -= 1) {
      target.push((value >>> bit) & 1);
    }
  }

  /* Calculate the number of data-bearing modules defined for a QR version. */
  function rawDataModules(version) {
    let result = (16 * version + 128) * version + 64;

    if (version >= 2) {
      const alignments = Math.floor(version / 7) + 2;
      result -= (25 * alignments - 10) * alignments - 55;

      if (version >= 7) {
        result -= 36;
      }
    }

    return result;
  }

  function dataCapacity(version) {
    const rawCodewords = Math.floor(rawDataModules(version) / 8);
    return (
      rawCodewords -
      ERROR_CORRECTION_CODEWORDS[version - 1] *
        ERROR_CORRECTION_BLOCKS[version - 1]
    );
  }

  function chooseVersion(byteLength) {
    for (let version = 1; version <= 40; version += 1) {
      const countBits = version <= 9 ? 8 : 16;

      if (byteLength >= 2 ** countBits) {
        continue;
      }

      if (4 + countBits + byteLength * 8 <= dataCapacity(version) * 8) {
        return version;
      }
    }

    throw new RangeError("The provisioning URI is too long for a QR code.");
  }

  function encodeData(bytes, version) {
    const capacityBits = dataCapacity(version) * 8;
    const bits = [];

    // Mode 0100 is byte mode. Versions 1-9 use an 8-bit byte count; later
    // versions use 16 bits, as required by the QR Model 2 specification.
    appendBits(bits, 0b0100, 4);
    appendBits(bits, bytes.length, version <= 9 ? 8 : 16);

    for (const byte of bytes) {
      appendBits(bits, byte, 8);
    }

    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));

    while (bits.length % 8 !== 0) {
      bits.push(0);
    }

    const data = [];

    for (let offset = 0; offset < bits.length; offset += 8) {
      let value = 0;

      for (let bit = 0; bit < 8; bit += 1) {
        value = (value << 1) | bits[offset + bit];
      }

      data.push(value);
    }

    for (let pad = 0; data.length < dataCapacity(version); pad += 1) {
      data.push(pad % 2 === 0 ? 0xec : 0x11);
    }

    return data;
  }

  /* Multiplication in GF(2^8), reduced by the QR field polynomial 0x11d. */
  function finiteFieldMultiply(left, right) {
    let product = 0;

    for (let bit = 7; bit >= 0; bit -= 1) {
      product = (product << 1) ^ ((product >>> 7) * 0x11d);

      if ((right >>> bit) & 1) {
        product ^= left;
      }
    }

    return product;
  }

  function reedSolomonDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;

    for (let index = 0; index < degree; index += 1) {
      for (let term = 0; term < result.length; term += 1) {
        result[term] = finiteFieldMultiply(result[term], root);

        if (term + 1 < result.length) {
          result[term] ^= result[term + 1];
        }
      }

      root = finiteFieldMultiply(root, 0x02);
    }

    return result;
  }

  function reedSolomonRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);

    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);

      for (let index = 0; index < result.length; index += 1) {
        result[index] ^= finiteFieldMultiply(divisor[index], factor);
      }
    }

    return result;
  }

  function addErrorCorrection(data, version) {
    const blockCount = ERROR_CORRECTION_BLOCKS[version - 1];
    const correctionLength = ERROR_CORRECTION_CODEWORDS[version - 1];
    const rawCodewords = Math.floor(rawDataModules(version) / 8);
    const shortBlockLength = Math.floor(rawCodewords / blockCount);
    const shortBlockCount = blockCount - (rawCodewords % blockCount);
    const divisor = reedSolomonDivisor(correctionLength);
    const blocks = [];
    let offset = 0;

    /*
     * Blocks may differ by one data byte. A placeholder makes their arrays the
     * same length for interleaving; the matching branch below skips it.
     */
    for (let block = 0; block < blockCount; block += 1) {
      const dataLength =
        shortBlockLength -
        correctionLength +
        (block < shortBlockCount ? 0 : 1);
      const contents = data.slice(offset, offset + dataLength);
      offset += dataLength;

      const correction = reedSolomonRemainder(contents, divisor);

      if (block < shortBlockCount) {
        contents.push(0);
      }

      blocks.push(contents.concat(correction));
    }

    const result = [];

    for (let index = 0; index < blocks[0].length; index += 1) {
      for (let block = 0; block < blocks.length; block += 1) {
        if (
          index === shortBlockLength - correctionLength &&
          block < shortBlockCount
        ) {
          continue;
        }

        result.push(blocks[block][index]);
      }
    }

    return result;
  }

  function alignmentPositions(version) {
    if (version === 1) {
      return [];
    }

    const count = Math.floor(version / 7) + 2;
    const step =
      version === 32
        ? 26
        : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
    const result = [6];

    for (let position = version * 4 + 10; result.length < count; position -= step) {
      result.splice(1, 0, position);
    }

    return result;
  }

  function makeMatrix(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    function setFunction(x, y, dark) {
      modules[y][x] = dark;
      reserved[y][x] = true;
    }

    function drawFinder(centreX, centreY) {
      for (let y = -4; y <= 4; y += 1) {
        for (let x = -4; x <= 4; x += 1) {
          const targetX = centreX + x;
          const targetY = centreY + y;

          if (targetX < 0 || targetX >= size || targetY < 0 || targetY >= size) {
            continue;
          }

          const distance = Math.max(Math.abs(x), Math.abs(y));
          setFunction(targetX, targetY, distance !== 2 && distance !== 4);
        }
      }
    }

    function drawAlignment(centreX, centreY) {
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          setFunction(
            centreX + x,
            centreY + y,
            Math.max(Math.abs(x), Math.abs(y)) !== 1,
          );
        }
      }
    }

    for (let index = 0; index < size; index += 1) {
      setFunction(6, index, index % 2 === 0);
      setFunction(index, 6, index % 2 === 0);
    }

    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    const positions = alignmentPositions(version);

    for (const y of positions) {
      for (const x of positions) {
        if (!reserved[y][x]) {
          drawAlignment(x, y);
        }
      }
    }

    // Reserve format modules by drawing a temporary value. These bits are
    // replaced after a mask is selected.
    drawFormatBits(modules, reserved, 0);

    if (version >= 7) {
      let remainder = version;

      for (let bit = 0; bit < 12; bit += 1) {
        remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
      }

      const versionBits = (version << 12) | remainder;

      for (let index = 0; index < 18; index += 1) {
        const dark = ((versionBits >>> index) & 1) !== 0;
        const x = size - 11 + (index % 3);
        const y = Math.floor(index / 3);
        setFunction(x, y, dark);
        setFunction(y, x, dark);
      }
    }

    return { modules, reserved };
  }

  function drawFormatBits(modules, reserved, mask) {
    const size = modules.length;
    let remainder = mask; // Level M has the two-bit format indicator 00.

    for (let bit = 0; bit < 10; bit += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }

    const format = ((mask << 10) | remainder) ^ 0x5412;
    const bit = (index) => ((format >>> index) & 1) !== 0;
    const set = (x, y, value) => {
      modules[y][x] = value;
      reserved[y][x] = true;
    };

    for (let index = 0; index <= 5; index += 1) {
      set(8, index, bit(index));
    }

    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));

    for (let index = 9; index < 15; index += 1) {
      set(14 - index, 8, bit(index));
    }

    for (let index = 0; index < 8; index += 1) {
      set(size - 1 - index, 8, bit(index));
    }

    for (let index = 8; index < 15; index += 1) {
      set(8, size - 15 + index, bit(index));
    }

    set(8, size - 8, true);
  }

  function drawCodewords(modules, reserved, codewords) {
    const size = modules.length;
    let bitIndex = 0;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }

      for (let vertical = 0; vertical < size; vertical += 1) {
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;

        for (let column = 0; column < 2; column += 1) {
          const x = right - column;

          if (reserved[y][x] || bitIndex >= codewords.length * 8) {
            continue;
          }

          modules[y][x] =
            ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex += 1;
        }
      }
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: throw new RangeError("Invalid QR mask.");
    }
  }

  function applyMask(modules, reserved, mask) {
    for (let y = 0; y < modules.length; y += 1) {
      for (let x = 0; x < modules.length; x += 1) {
        if (!reserved[y][x] && maskBit(mask, x, y)) {
          modules[y][x] = !modules[y][x];
        }
      }
    }
  }

  /* Score the four undesirable-pattern rules and choose the easiest mask to scan. */
  function penaltyScore(modules) {
    const size = modules.length;
    let score = 0;

    function scoreLine(getValue) {
      let lineScore = 0;
      let runLength = 1;
      let pattern = "";

      for (let index = 0; index < size; index += 1) {
        const value = getValue(index);
        pattern += value ? "1" : "0";

        if (index > 0 && value === getValue(index - 1)) {
          runLength += 1;
        } else {
          if (runLength >= 5) {
            lineScore += runLength - 2;
          }

          runLength = 1;
        }
      }

      if (runLength >= 5) {
        lineScore += runLength - 2;
      }

      for (let index = 0; index <= pattern.length - 11; index += 1) {
        const window = pattern.slice(index, index + 11);

        if (window === "00001011101" || window === "10111010000") {
          lineScore += 40;
        }
      }

      return lineScore;
    }

    for (let index = 0; index < size; index += 1) {
      score += scoreLine((offset) => modules[index][offset]);
      score += scoreLine((offset) => modules[offset][index]);
    }

    let darkModules = 0;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (modules[y][x]) {
          darkModules += 1;
        }

        if (
          x + 1 < size &&
          y + 1 < size &&
          modules[y][x] === modules[y][x + 1] &&
          modules[y][x] === modules[y + 1][x] &&
          modules[y][x] === modules[y + 1][x + 1]
        ) {
          score += 3;
        }
      }
    }

    const totalModules = size * size;
    score +=
      Math.floor(Math.abs((darkModules * 100) / totalModules - 50) / 5) * 10;

    return score;
  }

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    const version = chooseVersion(bytes.length);
    const data = encodeData(bytes, version);
    const codewords = addErrorCorrection(data, version);
    const base = makeMatrix(version);
    drawCodewords(base.modules, base.reserved, codewords);

    let bestModules = null;
    let bestScore = Infinity;

    for (let mask = 0; mask < 8; mask += 1) {
      const candidate = base.modules.map((row) => row.slice());
      applyMask(candidate, base.reserved, mask);
      drawFormatBits(candidate, base.reserved, mask);

      const score = penaltyScore(candidate);

      if (score < bestScore) {
        bestModules = candidate;
        bestScore = score;
      }
    }

    return bestModules;
  }

  function createCanvas(text, requestedSize = 200) {
    const modules = encode(text);
    const quietZone = 4;
    const completeSize = modules.length + quietZone * 2;
    const scale = Math.max(1, Math.floor(requestedSize / completeSize));
    const drawnSize = completeSize * scale;
    const canvasSize = Math.max(requestedSize, drawnSize);
    const offset = Math.floor((canvasSize - modules.length * scale) / 2);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    canvas.width = canvasSize;
    canvas.height = canvasSize;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Authenticator provisioning QR code");

    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvasSize, canvasSize);
    context.fillStyle = "#000";

    for (let y = 0; y < modules.length; y += 1) {
      for (let x = 0; x < modules.length; x += 1) {
        if (modules[y][x]) {
          context.fillRect(offset + x * scale, offset + y * scale, scale, scale);
        }
      }
    }

    return canvas;
  }

  // Expose only the rendering entry point used by the page. Encoder internals
  // stay private so application code cannot accidentally depend on them.
  Object.defineProperty(window, "QrCode", {
    value: Object.freeze({ createCanvas }),
    writable: false,
    configurable: false,
  });
})();
