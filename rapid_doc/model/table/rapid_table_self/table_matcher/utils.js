// Copyright (c) Opendatalab. All rights reserved.

/**
 * Compute Intersection-over-Union between two boxes.
 * @param {number[]} box1 [x0,y0,x1,y1]
 * @param {number[]} box2 [x0,y0,x1,y1]
 * @returns {number}
 */
export function computeIou(box1, box2) {
  const [x1, y1, x2, y2] = box1;
  const [x3, y3, x4, y4] = box2;
  const interX0 = Math.max(x1, x3), interY0 = Math.max(y1, y3);
  const interX1 = Math.min(x2, x4), interY1 = Math.min(y2, y4);
  const interArea = Math.max(0, interX1 - interX0) * Math.max(0, interY1 - interY0);
  const area1 = (x2 - x1) * (y2 - y1);
  const area2 = (x4 - x3) * (y4 - y3);
  const unionArea = area1 + area2 - interArea;
  if (unionArea <= 0) return 0;
  return interArea / unionArea;
}

/**
 * Compute L1 distance between center points of two boxes.
 * @param {number[]} box1
 * @param {number[]} box2
 * @returns {number}
 */
export function distance(box1, box2) {
  const cx1 = (box1[0] + box1[2]) / 2, cy1 = (box1[1] + box1[3]) / 2;
  const cx2 = (box2[0] + box2[2]) / 2, cy2 = (box2[1] + box2[3]) / 2;
  return Math.abs(cx1 - cx2) + Math.abs(cy1 - cy2);
}

/**
 * Fix isolated span tags in thead HTML by wrapping them in td elements.
 * @param {string} theadPart
 * @returns {string}
 */
export function dealIsolateSpan(theadPart) {
  return theadPart.replace(
    /(<tr[^>]*>)((?:(?!<\/tr>).)*?<span[^>]*>(?:(?!<\/span>).)*?<\/span>(?:(?!<\/tr>).)*?)<\/tr>/gs,
    (match, trOpen, content) => {
      if (/<(?:td|th)[^>]*>/.test(content)) return match;
      return `${trOpen}<td>${content}</td></tr>`;
    }
  );
}

/**
 * Remove duplicate bounding box attributes from thead td tags.
 * @param {string} theadPart
 * @returns {string}
 */
export function dealDuplicateBb(theadPart) {
  return theadPart.replace(
    /(<td[^>]*)((?:\s+bbox="[^"]*")+)/g,
    (match, prefix, bboxAttrs) => {
      const firstBbox = bboxAttrs.match(/bbox="[^"]*"/)?.[0] ?? "";
      return `${prefix} ${firstBbox}`;
    }
  );
}
