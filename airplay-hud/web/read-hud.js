'use strict';

const canvas = document.createElement('canvas');
const pixels = canvas.getContext('2d', { willReadFrequently: true });
const field = id => document.getElementById(id);
let engine;
let processing = false;
let candidate = null;
let confirmedAt = 0;

function render(cue) {
  field('waiting').hidden = !!cue;
  field('maneuver').hidden = !cue;
  field('trip').hidden = !cue?.trip;
  if (!cue) return;
  field('arrow').classList.toggle('left', cue.direction === 'left');
  field('distance').textContent = formatDistance(cue.distance);
  field('street').textContent = cue.street;
  field('arrival').textContent = cue.trip?.arrival ?? '';
  field('remaining').textContent = cue.trip ? formatDistance(cue.trip.distance) + ' · ' + cue.trip.minutes + ' хв' : '';
}

function formatDistance(meters) {
  return meters >= 1000 ? (meters / 1000).toLocaleString('uk-UA') + ' км' : meters + ' м';
}

function distanceAtStart(text) {
  const match = text.match(/^\s*(\d{1,6}(?:[.,]\d{1,2})?)\s*(км|km|м|m)(?![а-яіїєґa-z])/iu);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.')) * (match[2].length === 2 ? 1000 : 1);
  return value > 0 && value <= 500000 ? Math.round(value) : null;
}

// The white right-angle icon is evaluated in sender coordinates, before HUD mirroring.
function detectDirection() {
  const points = [];
  const image = pixels.getImageData(25, 99, 63, 41).data;
  for (let y = 99; y <= 139; y++) {
    for (let x = 25; x <= 87; x++) {
      const i = ((y - 99) * 63 + x - 25) * 4;
      if (Math.min(image[i], image[i + 1], image[i + 2]) > 160) points.push([x, y]);
    }
  }
  if (points.length < 85 || points.length > 850) return null;
  const span = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
  if (span < 26 || span > 53) return null;
  for (const [direction, flip] of [['right', 1], ['left', -1]]) {
    const normalized = points.map(([x, y]) => [flip * x, y]);
    const left = Math.min(...normalized.map(p => p[0]));
    const top = Math.min(...normalized.map(p => p[1]));
    const has = (x0, x1, y0, y1, count) => normalized.filter(([x, y]) =>
      x >= left + x0 && x <= left + x1 && y >= top + y0 && y <= top + y1).length >= count;
    if (has(0, 9, 24, 36, 16) && has(8, 27, 9, 19, 38) &&
        has(24, 50, 0, 8, 12) && has(24, 50, 19, 26, 12) && !has(17, 50, 28, 39, 7)) return direction;
  }
  return null;
}

function crop(left, top, width, height) {
  const image = document.createElement('canvas');
  image.width = width * 3;
  image.height = height * 3;
  const ctx = image.getContext('2d');
  ctx.drawImage(canvas, left, top, width, height, 0, 0, image.width, image.height);
  const data = ctx.getImageData(0, 0, image.width, image.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const white = 0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2];
    data.data[i] = data.data[i + 1] = data.data[i + 2] = white > 121 ? 0 : 255;
  }
  ctx.putImageData(data, 0, 0);
  return image;
}

async function worker() {
  if (!engine) engine = Tesseract.createWorker('ukr+rus', 1, {
    workerPath: 'worker.min.js', workerBlobURL: false,
    corePath: 'tesseract-core-lstm.wasm.js', langPath: new URL('.', location.href).href, gzip: false,
  }).then(async value => {
    await value.setParameters({ tessedit_pageseg_mode: '7' });
    return value;
  }).catch(error => { engine = null; throw error; });
  return engine;
}

async function analyze(bitmap) {
  if (bitmap.width / bitmap.height < .43 || bitmap.width / bitmap.height > .50) return null;
  canvas.width = 512;
  canvas.height = 1112;
  pixels.drawImage(bitmap, 0, 0, 512, 1112);
  // A green guidance panel and a recognizable arrow must both be present.
  const [r, g, b] = pixels.getImageData(96, 102, 1, 1).data;
  if (g < 58 || g < r + 25 || g < b + 12) return null;
  const direction = detectDirection();
  if (!direction) return null;
  const ocr = await worker();
  const read = async (left, top, width, height, minConfidence) => {
    const { data } = await ocr.recognize(crop(left, top, width, height));
    return data.confidence >= minConfidence ? data.text.trim().replace(/\s+/g, ' ') : '';
  };
  const distance = distanceAtStart(await read(20, 143, 73, 36, 40));
  if (distance == null) return null;
  const street = (await read(99, 111, 392, 51, 60)).replace(/^(?:вулиця|улица)\s+/iu, '');
  const time = await read(21, 990, 239, 44, 45);
  const details = await read(21, 1035, 264, 31, 43);
  const minutes = time.match(/^([\dЗ]{1,3})\s*(?:мин|хв)/iu);
  const arrival = details.match(/(?<!\d)([01]\d|2[0-3]):[0-5]\d(?!\d)/u)?.[0];
  const tripDistance = distanceAtStart(details.replace(/([мm])[оo](?=\s+\d{1,2}:)/iu, '$1'));
  const trip = minutes && arrival && tripDistance != null && tripDistance >= distance
    ? { minutes: Number(minutes[1].replace(/З/gu, '3')), arrival, distance: tripDistance } : null;
  return { direction, distance, street, trip };
}

window.aceHudFrame = async encoded => {
  if (processing) return;
  processing = true;
  const started = performance.now();
  try {
    const image = new Image();
    image.src = 'data:image/png;base64,' + encoded;
    await image.decode();
    const next = await analyze(image);
    if (!next || performance.now() - started > 3500) {
      candidate = null;
      confirmedAt = 0;
      render(null);
      return;
    }
    const key = [next.direction, next.distance, next.street].join('|');
    if (key === candidate?.key && started - candidate.at < 5000) {
      confirmedAt = performance.now();
      const trip = JSON.stringify(next.trip) === JSON.stringify(candidate.trip) ? next.trip : null;
      render({ ...next, trip });
    } else {
      render(null);
    }
    candidate = { key, at: started, trip: next.trip };
  } catch {
    candidate = null;
    confirmedAt = 0;
    render(null);
  } finally {
    processing = false;
  }
};

setInterval(() => {
  if (confirmedAt && performance.now() - confirmedAt > 3200) {
    candidate = null;
    confirmedAt = 0;
    render(null);
  }
}, 400);
