// Copyright (c) 2024 PaddlePaddle Authors. All Rights Reserved.
// Apache License, Version 2.0

export const XYCUT_SETTINGS = Object.freeze({
  child_block_overlap_ratio_threshold: 0.1,
  edge_distance_compare_tolerance_len: 2,
  distance_weight_map: Object.freeze({
    edge_weight: 10 ** 4,
    up_edge_weight: 1,
    down_edge_weight: 0.0001,
  }),
  cross_layout_ref_text_block_words_num_threshold: 10,
});

export const REGION_SETTINGS = Object.freeze({
  match_block_overlap_ratio_threshold: 0.6,
  split_block_overlap_ratio_threshold: 0.4,
});

export const BLOCK_SETTINGS = Object.freeze({
  title_conversion_area_ratio_threshold: 0.3,
});

export const LINE_SETTINGS = Object.freeze({
  line_height_iou_threshold: 0.6,
  delimiter_map: Object.freeze({
    doc_title: " ",
    content: "\n",
  }),
});

export const BLOCK_LABEL_MAP = Object.freeze({
  doc_title_labels: ["doc_title"],
  paragraph_title_labels: [
    "paragraph_title",
    "abstract_title",
    "reference_title",
    "content_title",
  ],
  vision_labels: ["image", "table", "chart", "flowchart", "figure"],
  vision_title_labels: [
    "table_title",
    "chart_title",
    "figure_title",
    "figure_table_chart_title",
  ],
  unordered_labels: ["aside_text", "seal", "number", "formula_number"],
  text_labels: ["text"],
  header_labels: ["header", "header_image"],
  footer_labels: ["footer", "footer_image", "footnote"],
  visualize_index_labels: [
    "text",
    "formula",
    "algorithm",
    "reference",
    "content",
    "abstract",
    "paragraph_title",
    "doc_title",
    "abstract_title",
    "refer_title",
    "content_title",
  ],
  image_labels: ["image", "figure"],
});

export const blocktype_to_sort_label = Object.freeze({
  image: "image",
  table: "table",
  image_body: "figure_title",
  table_body: "content",
  image_caption: "figure_title",
  table_caption: "title",
  image_footnote: "footnote",
  table_footnote: "footnote",
  text: "text",
  title: "paragraph_title",
  interline_equation: "formula",
  list: "content",
  index: "number",
  discarded: "aside_text",
});
