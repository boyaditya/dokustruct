// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: magic_model_utils.py → magic_model_utils.js
 *
 * Direct translation — pure JavaScript utility functions
 * for MagicModel shared grouping logic.
 * No platform-specific dependencies.
 */

import { bboxDistance, isIn } from "./boxbase.js";

/**
 * Remove bboxes that are completely contained within another bbox.
 * @param {object[]} bboxes - array of {bbox: [x0,y0,x1,y1], ...}
 * @returns {object[]}
 */
export function reductOverlap(bboxes) {
  const N = bboxes.length;
  const keep = new Array(N).fill(true);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      if (isIn(bboxes[i].bbox, bboxes[j].bbox)) {
        keep[i] = false;
      }
    }
  }
  return bboxes.filter((_, i) => keep[i]);
}

/**
 * Generic closest-pair association between "subject" and "object" bboxes.
 * PORTING NOTE: Direct port of tie_up_category_by_distance_v3()
 *
 * @param {Function} getSubjectsFunc - () => subject array
 * @param {Function} getObjectsFunc  - () => object array
 * @param {Function|null} extractSubjectFunc
 * @param {Function|null} extractObjectFunc
 * @returns {object[]}  [{sub_bbox, obj_bboxes, sub_idx}]
 */
export function tieUpCategoryByDistanceV3(
  getSubjectsFunc,
  getObjectsFunc,
  extractSubjectFunc = null,
  extractObjectFunc = null,
) {
  const subjects = getSubjectsFunc();
  const objects  = getObjectsFunc();

  if (!extractSubjectFunc) extractSubjectFunc = x => x;
  if (!extractObjectFunc)  extractObjectFunc  = x => x;

  const ret = [];
  const N = subjects.length;
  const M = objects.length;

  subjects.sort((a, b) => (a.bbox[0] ** 2 + a.bbox[1] ** 2) - (b.bbox[0] ** 2 + b.bbox[1] ** 2));
  objects.sort( (a, b) => (a.bbox[0] ** 2 + a.bbox[1] ** 2) - (b.bbox[0] ** 2 + b.bbox[1] ** 2));

  const OBJ_IDX_OFFSET = 10000;
  const SUB_BIT_KIND = 0;
  const OBJ_BIT_KIND = 1;

  const allBoxesWithIdx = [
    ...subjects.map((sub, i) => ({ idx: i, kind: SUB_BIT_KIND, x0: sub.bbox[0], y0: sub.bbox[1] })),
    ...objects.map((obj, i)  => ({ idx: i + OBJ_IDX_OFFSET, kind: OBJ_BIT_KIND, x0: obj.bbox[0], y0: obj.bbox[1] })),
  ];

  const seenIdx    = new Set();
  const seenSubIdx = new Set();

  while (N > seenSubIdx.size) {
    const candidates = allBoxesWithIdx.filter(b => !seenIdx.has(b.idx));
    if (!candidates.length) break;

    const leftX = Math.min(...candidates.map(c => c.x0));
    const topY  = Math.min(...candidates.map(c => c.y0));

    candidates.sort((a, b) => ((a.x0 - leftX) ** 2 + (a.y0 - topY) ** 2) - ((b.x0 - leftX) ** 2 + (b.y0 - topY) ** 2));

    const { idx: fstIdx, kind: fstKind } = candidates[0];
    const fstBbox = fstKind === SUB_BIT_KIND
      ? subjects[fstIdx].bbox
      : objects[fstIdx - OBJ_IDX_OFFSET].bbox;

    candidates.sort((a, b) => {
      const bboxA = a.kind === SUB_BIT_KIND ? subjects[a.idx].bbox : objects[a.idx - OBJ_IDX_OFFSET].bbox;
      const bboxB = b.kind === SUB_BIT_KIND ? subjects[b.idx].bbox : objects[b.idx - OBJ_IDX_OFFSET].bbox;
      return bboxDistance(fstBbox, bboxA) - bboxDistance(fstBbox, bboxB);
    });

    let nxt = null;
    for (let i = 1; i < candidates.length; i++) {
      if ((candidates[i].kind ^ fstKind) === 1) { nxt = candidates[i]; break; }
    }
    if (!nxt) break;

    let subIdx, objIdx;
    if (fstKind === SUB_BIT_KIND) {
      subIdx = fstIdx;
      objIdx = nxt.idx - OBJ_IDX_OFFSET;
    } else {
      subIdx = nxt.idx;
      objIdx = fstIdx - OBJ_IDX_OFFSET;
    }

    const pairDis = bboxDistance(subjects[subIdx].bbox, objects[objIdx].bbox);
    let nearestDis = Infinity;
    for (let i = 0; i < N; i++) {
      nearestDis = Math.min(nearestDis, bboxDistance(subjects[i].bbox, objects[objIdx].bbox));
    }

    if (pairDis >= 3 * nearestDis) {
      seenIdx.add(subIdx);
      continue;
    }

    seenIdx.add(subIdx);
    seenIdx.add(objIdx + OBJ_IDX_OFFSET);
    seenSubIdx.add(subIdx);

    ret.push({
      sub_bbox:   extractSubjectFunc(subjects[subIdx]),
      obj_bboxes: [extractObjectFunc(objects[objIdx])],
      sub_idx:    subIdx,
    });
  }

  // Assign unmatched objects to nearest subject
  for (let i = 0; i < M; i++) {
    const j = i + OBJ_IDX_OFFSET;
    if (seenIdx.has(j)) continue;
    seenIdx.add(j);

    let nearestDis = Infinity;
    let nearestSubIdx = -1;
    for (let k = 0; k < subjects.length; k++) {
      const d = bboxDistance(objects[i].bbox, subjects[k].bbox);
      if (d < nearestDis) { nearestDis = d; nearestSubIdx = k; }
    }

    for (let k = 0; k < subjects.length; k++) {
      if (k !== nearestSubIdx) continue;
      if (seenSubIdx.has(k)) {
        const entry = ret.find(r => r.sub_idx === k);
        if (entry) entry.obj_bboxes.push(extractObjectFunc(objects[i]));
      } else {
        ret.push({
          sub_bbox:   extractSubjectFunc(subjects[k]),
          obj_bboxes: [extractObjectFunc(objects[i])],
          sub_idx:    k,
        });
      }
      seenSubIdx.add(k);
      seenIdx.add(k);
    }
  }

  // Subjects with no matched objects
  for (let i = 0; i < subjects.length; i++) {
    if (seenSubIdx.has(i)) continue;
    ret.push({
      sub_bbox:   extractSubjectFunc(subjects[i]),
      obj_bboxes: [],
      sub_idx:    i,
    });
  }

  return ret;
}
