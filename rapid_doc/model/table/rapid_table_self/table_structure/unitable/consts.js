// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unitable/consts.py → consts.js

export const IMG_SIZE = 448;
export const MAX_SEQ_LEN = 1024;
export const EOS_TOKEN = "<eos>";
export const BOS_TOKEN = "<bos>";
export const PAD_TOKEN = "<pad>";

/** 449 spatial position tokens */
export const BBOX_TOKENS = Array.from({ length: 449 }, (_, i) => `bbox-${i}`);

/** HTML table structure tokens used by UniTable */
export const HTML_BBOX_HTML_TOKENS = Object.freeze([
  "<td></td>", "<td>[", "]</td>",
  "<thead>", "</thead>", "<tbody>", "</tbody>",
  "<tr>", "</tr>", "<td", "</td>",
  " colspan=\"2\"", " colspan=\"3\"", " colspan=\"4\"", " colspan=\"5\"",
  " colspan=\"6\"", " colspan=\"7\"", " colspan=\"8\"", " colspan=\"9\"",
  " colspan=\"10\"", " rowspan=\"2\"", " rowspan=\"3\"", " rowspan=\"4\"",
  " rowspan=\"5\"", " rowspan=\"6\"", " rowspan=\"7\"", " rowspan=\"8\"",
  " rowspan=\"9\"", " rowspan=\"10\"",
  " colspan=\"2\" rowspan=\"2\"", " colspan=\"2\" rowspan=\"3\"",
  " colspan=\"2\" rowspan=\"4\"", " colspan=\"3\" rowspan=\"2\"",
  " colspan=\"3\" rowspan=\"3\"", " colspan=\"4\" rowspan=\"2\"",
  " colspan=\"5\" rowspan=\"2\"",
  " colspan=\"6\" rowspan=\"2\"",
  " colspan=\"7\" rowspan=\"2\"",
  " colspan=\"8\" rowspan=\"2\"",
  ">", "<th>", "</th>",
  "<th", " scope=\"col\"", " scope=\"row\"",
  " colspan=\"2\" scope=\"col\"",
  " colspan=\"3\" scope=\"col\"",
  " colspan=\"4\" scope=\"col\"",
  " colspan=\"5\" scope=\"col\"",
  " colspan=\"6\" scope=\"col\"",
  " colspan=\"7\" scope=\"col\"",
  " colspan=\"8\" scope=\"col\"",
]);
