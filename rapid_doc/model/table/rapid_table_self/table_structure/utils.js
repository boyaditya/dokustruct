// Copyright (c) Opendatalab. All rights reserved.

/**
 * Wrap HTML table structure string list into a full HTML document.
 * @param {string[]} structureStrList
 * @returns {string}
 */
export function wrapWithHtmlStruct(structureStrList) {
  const inner = structureStrList.join("");
  return `<html><body><table>${inner}</table></body></html>`;
}

export default wrapWithHtmlStruct;
