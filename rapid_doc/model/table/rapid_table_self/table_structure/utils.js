// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/utils.py → utils.js

/**
 * Wrap HTML table structure string list into a full HTML document.
 * PORTING NOTE: wrap_with_html_struct(structure_str_list)
 * @param {string[]} structureStrList
 * @returns {string}
 */
export function wrapWithHtmlStruct(structureStrList) {
  const inner = structureStrList.join("");
  return `<html><body><table>${inner}</table></body></html>`;
}

export default wrapWithHtmlStruct;
